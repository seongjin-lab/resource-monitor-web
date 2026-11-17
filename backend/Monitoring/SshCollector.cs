using System.Diagnostics;
using System.Globalization;
using System.Net.Sockets;
using System.Security.Cryptography;
using Renci.SshNet;
using Renci.SshNet.Common;

namespace ResourceMonitor.Web.Monitoring;

/// <summary>SSH 접속 정보. Fingerprint가 비어 있으면 접속 테스트용으로 어떤 호스트 키든 받아들이고 지문만 기록한다.</summary>
public sealed record SshTarget(string Host, int Port, string User, string Fingerprint, string Secret, byte[]? PrivateKey);

public sealed record MetricValues(double? Cpu, double? Memory, double? Disk, double? Io);
public sealed record ServerSpecs(long? LogicalCores, long MemoryKiB, long? RootDiskKiB);
public sealed record ProcessUsage(int Pid, string Name, double Usage);
public sealed record TopProcesses(ProcessUsage[]? Cpu, ProcessUsage[]? Memory);
public sealed record DirectoryUsage(string Path, long SizeKiB);
public sealed record RootDirectoryUsage(DirectoryUsage[] Entries, bool IsPartial);

/// <summary>원본 데스크톱 앱의 SshMonitor를 옮긴 것. 리눅스 /proc, /sys, df 값을 읽어 지표를 계산한다.</summary>
public sealed class SshCollector(SshTarget target) : IDisposable
{
    private const string ReadCounters = """
        LC_ALL=C awk 'FILENAME=="/proc/stat" && $1=="cpu" {print "cpu", $2+$3+$4+$5+$6+$7+$8+$9, $5+$6}
        FILENAME=="/proc/stat" && $1 ~ /^cpu[0-9]+$/ {cores++}
        FILENAME=="/proc/meminfo" && ($1=="MemTotal:" || $1=="MemAvailable:") {print $1, $2}
        END {printf "cores %d\n", cores}' OFMT=%.0f /proc/stat /proc/meminfo
        for disk in /sys/block/*; do
            [ -e "$disk/device" ] || continue
            if read -r r rm rs rt w wm ws rest < "$disk/stat"; then
                printf 'io %s %s %s\n' "${disk##*/}" "$rs" "$ws"
            fi
        done
        """;

    private const string ReadProcessCounters = """
        snapshot() {
            printf '%s\n' /proc/[0-9]*/stat | LC_ALL=C awk '
            BEGIN {
                if ((getline line < "/proc/stat") > 0) {
                    split(line, cpu, " ")
                    for (i = 2; i <= 9; i++) total += cpu[i]
                    printf "ticks\t%.0f\n", total
                }
            }
            {
                file = $0
                found = (getline line < file)
                close(file)
                if (found <= 0 || !match(line, /\) [^)]*$/)) next
                start = index(line, "(")
                pid = substr(line, 1, start - 2)
                name = substr(line, start + 1, RSTART - start - 1)
                if (split(substr(line, RSTART + 2), stat, " ") >= 22)
                    printf "%s\t%s\t%.0f\t%s\t%s\n", pid, stat[20], stat[12]+stat[13], stat[22], name
            }'
        }
        if [ "$measure_cpu" = 1 ]; then
            snapshot
            sleep 0.5
        fi
        printf '\ncurrent\n'
        if [ "$measure_memory" = 1 ]; then
            printf 'pages\t%s\n' "$(getconf PAGESIZE 2>/dev/null)"
        fi
        snapshot
        """;

    private const string ReadDirectoryUsage = """
        LC_ALL=C timeout -k 1 30 du -x -k -0 -d 1 / 2>/dev/null
        result=$?
        case "$result" in
            0|1) printf '%s\0' "$result" ;;
            *) exit "$result" ;;
        esac
        """;

    private SshClient? client;
    private PrivateKeyFile? privateKey;
    private Counters? previous;
    private long lastCapacityCheck;
    private (double? UsedPercent, long? TotalKiB) diskCapacity;

    public string? PresentedFingerprint { get; private set; }

    public async Task<(MetricValues Values, ServerSpecs Specs)> ReadAsync(
        CancellationToken cancellationToken, double maxSampleAgeSeconds = 15)
    {
        try
        {
            await ConnectAsync(cancellationToken).ConfigureAwait(false);
            string output = await RunAsync(ReadCounters, cancellationToken).ConfigureAwait(false);
            var counters = ParseCounters(output);
            double? cpu = null;
            double? diskIo = null;

            if (previous is { } last)
            {
                double seconds = Stopwatch.GetElapsedTime(last.Timestamp, counters.Timestamp).TotalSeconds;
                if (seconds > 0 && seconds <= maxSampleAgeSeconds)
                {
                    long total = counters.CpuTotal - last.CpuTotal;
                    long idle = counters.CpuIdle - last.CpuIdle;
                    if (total > 0 && idle >= 0 && idle <= total)
                    {
                        cpu = 100.0 * (total - idle) / total;
                    }

                    if (counters.Disks.Count > 0 && counters.Disks.Count == last.Disks.Count &&
                        counters.Disks.All(pair => last.Disks.TryGetValue(pair.Key, out long sectors) && pair.Value >= sectors))
                    {
                        diskIo = counters.Disks.Sum(pair => pair.Value - last.Disks[pair.Key]) * 512.0 / seconds / 1_000_000;
                    }
                }
            }

            previous = counters;
            if (lastCapacityCheck == 0 || Stopwatch.GetElapsedTime(lastCapacityCheck) >= TimeSpan.FromMinutes(1))
            {
                lastCapacityCheck = Stopwatch.GetTimestamp();
                diskCapacity = ParseCapacity(await RunAsync(
                    "LC_ALL=C timeout -k 1 3 df -Pk / 2>/dev/null || true", cancellationToken).ConfigureAwait(false));
            }

            return (new MetricValues(cpu, counters.MemoryPercent, diskCapacity.UsedPercent, diskIo),
                new ServerSpecs(counters.LogicalCores, counters.MemoryKiB, diskCapacity.TotalKiB));
        }
        catch
        {
            Dispose();
            throw;
        }
    }

    public async Task<TopProcesses?> ReadTopProcessesAsync(bool cpu, bool memory, CancellationToken cancellationToken)
    {
        try
        {
            string script = $"measure_cpu={(cpu ? 1 : 0)}\nmeasure_memory={(memory ? 1 : 0)}\n{ReadProcessCounters.ReplaceLineEndings("\n")}";
            string output = await RunAsync(script, cancellationToken).ConfigureAwait(false);
            var snapshots = output.Split("\ncurrent\n", 2, StringSplitOptions.None);
            if (snapshots.Length != 2)
            {
                return null;
            }

            var current = ParseProcessSnapshot(snapshots[1]);
            ProcessUsage[]? topCpu = null;
            if (cpu)
            {
                var previous = ParseProcessSnapshot(snapshots[0]);
                long totalDelta = current.Ticks - previous.Ticks;
                if (previous.Ticks > 0 && totalDelta > 0)
                {
                    // 시작 시각도 비교해 조회 도중 같은 PID를 재사용한 프로세스를 제외한다.
                    topCpu = current.Processes
                        .Join(previous.Processes, process => (process.Pid, process.Start), process => (process.Pid, process.Start),
                            (process, before) => (Process: process, Delta: process.Ticks - before.Ticks))
                        .Where(item => item.Delta > 0)
                        .OrderByDescending(item => item.Delta).ThenBy(item => item.Process.Pid).Take(5)
                        .Select(item => new ProcessUsage(item.Process.Pid, item.Process.Name,
                            Math.Min(100, 100.0 * item.Delta / totalDelta))).ToArray();
                }
            }

            var topMemory = memory && current.PageSize > 0
                ? current.Processes.Where(process => process.RssPages > 0)
                    .OrderByDescending(process => process.RssPages).ThenBy(process => process.Pid).Take(5)
                    .Select(process => new ProcessUsage(process.Pid, process.Name,
                        process.RssPages * (current.PageSize / 1_048_576.0))).ToArray()
                : null;

            return new TopProcesses(topCpu, topMemory);
        }
        catch (Exception error) when (!cancellationToken.IsCancellationRequested && IsDiagnosticFailure(error))
        {
            // 부가 조회가 실패해도 기본 지표 측정값은 전달한다.
            return null;
        }
    }

    public static async Task<RootDirectoryUsage> ReadRootDirectoriesAsync(SshTarget target, CancellationToken cancellationToken)
    {
        // 디렉터리 탐색이 끝날 때까지 기본 지표 수집이 기다리지 않도록 별도 연결을 사용한다.
        using var collector = new SshCollector(target);
        try
        {
            await collector.ConnectAsync(cancellationToken).ConfigureAwait(false);
            string output = await collector.RunAsync(ReadDirectoryUsage.ReplaceLineEndings("\n"),
                cancellationToken, TimeSpan.FromSeconds(35)).ConfigureAwait(false);
            string[] records = output.Split('\0', StringSplitOptions.RemoveEmptyEntries);
            if (records.Length == 0 || records[^1] is not ("0" or "1"))
            {
                return new RootDirectoryUsage([], false);
            }

            var directories = new List<DirectoryUsage>();
            for (int index = 0; index < records.Length - 1; index++)
            {
                string record = records[index];
                int separator = record.IndexOf('\t');
                if (separator < 0 || !TryNumber(record[..separator], out long size))
                {
                    continue;
                }

                string path = record[(separator + 1)..];
                if (path.Length > 1 && path[0] == '/' && path.IndexOf('/', 1) < 0)
                {
                    directories.Add(new DirectoryUsage(path, size));
                }
            }

            return new RootDirectoryUsage(directories.OrderByDescending(item => item.SizeKiB)
                .ThenBy(item => item.Path, StringComparer.Ordinal).Take(5).ToArray(), records[^1] == "1");
        }
        catch (Exception error) when (IsDiagnosticFailure(error))
        {
            return new RootDirectoryUsage([], false);
        }
    }

    private static bool IsDiagnosticFailure(Exception error) =>
        error is SshException or IOException or InvalidDataException or SocketException or TimeoutException or OperationCanceledException;

    private async Task ConnectAsync(CancellationToken cancellationToken)
    {
        if (client?.IsConnected == true)
        {
            return;
        }

        Dispose();
        if (target.PrivateKey is { } key)
        {
            using var stream = new MemoryStream(key, writable: false);
            privateKey = target.Secret.Length == 0 ? new PrivateKeyFile(stream) : new PrivateKeyFile(stream, target.Secret);
        }

        client = privateKey is null
            ? new SshClient(target.Host, target.Port, target.User, target.Secret)
            : new SshClient(target.Host, target.Port, target.User, privateKey);
        client.ConnectionInfo.Timeout = TimeSpan.FromSeconds(8);
        string? rejectedFingerprint = null;
        client.HostKeyReceived += (_, e) =>
        {
            PresentedFingerprint = e.FingerPrintSHA256;
            e.CanTrust = target.Fingerprint.Length == 0 ||
                StringComparer.Ordinal.Equals(target.Fingerprint, e.FingerPrintSHA256);
            if (!e.CanTrust)
            {
                rejectedFingerprint = e.FingerPrintSHA256;
            }
        };

        try
        {
            await client.ConnectAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (SshConnectionException) when (rejectedFingerprint is not null)
        {
            throw new HostKeyMismatchException(rejectedFingerprint);
        }
    }

    private async Task<string> RunAsync(string script, CancellationToken cancellationToken, TimeSpan? timeout = null)
    {
        using SshCommand command = client!.CreateCommand(script);
        command.CommandTimeout = timeout ?? TimeSpan.FromSeconds(6);
        await command.ExecuteAsync(cancellationToken).ConfigureAwait(false);
        if (command.ExitStatus != 0)
        {
            throw new InvalidDataException("리눅스 지표 조회 명령이 실패했습니다.");
        }

        return command.Result;
    }

    private static Counters ParseCounters(string output)
    {
        long? total = null;
        long? idle = null;
        long? logicalCores = null;
        long? memory = null;
        long? available = null;
        var disks = new Dictionary<string, long>(StringComparer.Ordinal);

        foreach (string line in output.Split('\n'))
        {
            string[] fields = line.Split([' ', '\t', '\r'], StringSplitOptions.RemoveEmptyEntries);
            switch (fields)
            {
                case ["cpu", var cpuTotal, var cpuIdle] when TryNumber(cpuTotal, out long ticks) && TryNumber(cpuIdle, out long idleTicks):
                    total = ticks;
                    idle = idleTicks;
                    break;
                case ["cores", var count] when TryNumber(count, out long cores) && cores > 0:
                    logicalCores = cores;
                    break;
                case ["MemTotal:", var ram] when TryNumber(ram, out long size):
                    memory = size;
                    break;
                case ["MemAvailable:", var free] when TryNumber(free, out long freeSize):
                    available = freeSize;
                    break;
                case ["io", var device, var read, var write] when TryNumber(read, out long reads) && TryNumber(write, out long writes):
                    disks[device] = reads + writes;
                    break;
            }
        }

        if (total is null || idle is null || memory is not > 0 || available is null)
        {
            throw new InvalidDataException("서버에서 리눅스 CPU·메모리 지표를 읽을 수 없습니다.");
        }

        return new Counters(Stopwatch.GetTimestamp(), total.Value, idle.Value,
            Math.Clamp(100.0 * (memory.Value - available.Value) / memory.Value, 0, 100),
            logicalCores, memory.Value, disks);
    }

    private static (long Ticks, long PageSize, List<ProcessCounters> Processes) ParseProcessSnapshot(string output)
    {
        long totalTicks = 0;
        long pageSize = 0;
        var processes = new List<ProcessCounters>();
        foreach (string line in output.Split('\n'))
        {
            string[] fields = line.Split('\t', 5);
            switch (fields)
            {
                case ["ticks", var total] when TryNumber(total, out long tickCount):
                    totalTicks = tickCount;
                    break;
                case ["pages", var size] when TryNumber(size, out long bytes):
                    pageSize = bytes;
                    break;
                case [var pid, var start, var ticks, var pages, var name]
                    when int.TryParse(pid, NumberStyles.None, CultureInfo.InvariantCulture, out int id) &&
                         TryNumber(start, out long started) && TryNumber(ticks, out long used):
                    TryNumber(pages, out long rss);
                    processes.Add(new ProcessCounters(id, started, used, rss, name));
                    break;
            }
        }

        return (totalTicks, pageSize, processes);
    }

    private static (double? UsedPercent, long? TotalKiB) ParseCapacity(string output)
    {
        string[] fields = (output.Split('\n', StringSplitOptions.RemoveEmptyEntries).LastOrDefault() ?? "")
            .Split([' ', '\t', '\r'], StringSplitOptions.RemoveEmptyEntries);
        if (fields.Length < 6 || !fields[^2].EndsWith('%') || !TryNumber(fields[^2][..^1], out long used))
        {
            return (null, null);
        }

        return (used, TryNumber(fields[^5], out long total) && total > 0 ? total : null);
    }

    private static bool TryNumber(string value, out long number) =>
        long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out number);

    public static string DescribeError(Exception error) => error switch
    {
        HostKeyMismatchException mismatch =>
            $"SSH 호스트 키가 저장된 지문과 다릅니다. 서버가 제시한 지문 SHA256:{mismatch.Fingerprint}",
        InvalidDataException => error.Message,
        SshAuthenticationException => "SSH 인증에 실패했습니다. 계정, 비밀번호 또는 개인 키를 확인하세요.",
        SshPassPhraseNullOrEmptyException => "개인 키를 열려면 개인 키 암호가 필요합니다.",
        SshOperationTimeoutException or TimeoutException or OperationCanceledException => "SSH 연결 또는 지표 조회 시간이 초과되었습니다.",
        SocketException or SshConnectionException => "SSH 연결에 실패했습니다. 서버 주소, 포트와 네트워크를 확인하세요.",
        IOException or UnauthorizedAccessException or CryptographicException or SshException =>
            "SSH 키 또는 저장된 인증 정보를 사용할 수 없습니다.",
        _ => "서버에 접속하거나 지표를 읽는 중 오류가 발생했습니다."
    };

    public void Dispose()
    {
        client?.Dispose();
        client = null;
        privateKey?.Dispose();
        privateKey = null;
        previous = null;
        lastCapacityCheck = 0;
        diskCapacity = default;
    }

    private sealed record Counters(long Timestamp, long CpuTotal, long CpuIdle, double MemoryPercent,
        long? LogicalCores, long MemoryKiB, Dictionary<string, long> Disks);
    private sealed record ProcessCounters(int Pid, long Start, long Ticks, long RssPages, string Name);
}

public sealed class HostKeyMismatchException(string fingerprint) : Exception
{
    public string Fingerprint { get; } = fingerprint;
}
