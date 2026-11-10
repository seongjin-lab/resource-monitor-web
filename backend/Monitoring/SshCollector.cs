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

/// <summary>원본 데스크톱 앱의 SshMonitor를 옮긴 것. 리눅스 /proc, /sys, df 값을 읽어 지표를 계산한다.</summary>
public sealed class SshCollector(SshTarget target) : IDisposable
{
    private const string ReadCounters = """
        LC_ALL=C awk 'FILENAME=="/proc/stat" && $1=="cpu" {print "cpu", $2+$3+$4+$5+$6+$7+$8+$9, $5+$6}
        FILENAME=="/proc/meminfo" && ($1=="MemTotal:" || $1=="MemAvailable:") {print $1, $2}' OFMT=%.0f /proc/stat /proc/meminfo
        for disk in /sys/block/*; do
            [ -e "$disk/device" ] || continue
            if read -r r rm rs rt w wm ws rest < "$disk/stat"; then
                printf 'io %s %s %s\n' "${disk##*/}" "$rs" "$ws"
            fi
        done
        """;

    private SshClient? client;
    private PrivateKeyFile? privateKey;
    private Counters? previous;
    private long lastCapacityCheck;
    private double? diskCapacity;

    public string? PresentedFingerprint { get; private set; }

    public async Task<MetricValues> ReadAsync(CancellationToken cancellationToken, double maxSampleAgeSeconds = 15)
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

            return new MetricValues(cpu, counters.MemoryPercent, diskCapacity, diskIo);
        }
        catch
        {
            Dispose();
            throw;
        }
    }

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

    private async Task<string> RunAsync(string script, CancellationToken cancellationToken)
    {
        using SshCommand command = client!.CreateCommand(script);
        command.CommandTimeout = TimeSpan.FromSeconds(6);
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
            Math.Clamp(100.0 * (memory.Value - available.Value) / memory.Value, 0, 100), disks);
    }

    private static double? ParseCapacity(string output)
    {
        string[] fields = (output.Split('\n', StringSplitOptions.RemoveEmptyEntries).LastOrDefault() ?? "")
            .Split([' ', '\t', '\r'], StringSplitOptions.RemoveEmptyEntries);
        return fields.Length >= 6 && fields[^2].EndsWith('%') && TryNumber(fields[^2][..^1], out long used)
            ? used : null;
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
        diskCapacity = null;
    }

    private sealed record Counters(long Timestamp, long CpuTotal, long CpuIdle, double MemoryPercent,
        Dictionary<string, long> Disks);
}

public sealed class HostKeyMismatchException(string fingerprint) : Exception
{
    public string Fingerprint { get; } = fingerprint;
}
