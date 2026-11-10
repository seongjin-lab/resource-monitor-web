using System.Diagnostics;
using System.Text;
using ResourceMonitor.Web.Data;

namespace ResourceMonitor.Web.Monitoring;

/// <summary>
/// 켜져 있는 서버마다 수집 루프를 하나씩 돌린다. 서버 목록이 바뀌면 RequestReconcile()로 루프를 다시 맞춘다.
/// 브라우저가 열려 있지 않아도 항상 수집해 DB에 기록한다.
/// </summary>
public sealed class MonitorService(
    ServerStore servers,
    SettingsStore settings,
    SampleStore samples,
    SampleWriter writer,
    LiveState live,
    ILogger<MonitorService> logger) : BackgroundService
{
    private readonly Dictionary<Guid, Worker> workers = new();
    private readonly SemaphoreSlim signal = new(0);
    private DateTime lastPurge = DateTime.MinValue;

    public void RequestReconcile() => signal.Release();

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                Reconcile(stoppingToken);
                PurgeIfDue();
            }
            catch (Exception error)
            {
                logger.LogError(error, "수집 대상 서버를 정리하지 못했습니다.");
            }

            try
            {
                await signal.WaitAsync(TimeSpan.FromMinutes(1), stoppingToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }

        foreach (var worker in workers.Values)
        {
            worker.Cancellation.Cancel();
        }

        await Task.WhenAll(workers.Values.Select(worker => worker.Task));
    }

    private void Reconcile(CancellationToken stoppingToken)
    {
        var current = servers.List().ToDictionary(server => server.Id);
        foreach (var (id, worker) in workers.ToArray())
        {
            if (!current.TryGetValue(id, out var server) || !server.Enabled || !SameConnection(server, worker.Server))
            {
                worker.Cancellation.Cancel();
                workers.Remove(id);
                if (!current.ContainsKey(id))
                {
                    live.Remove(id);
                }
            }
        }

        foreach (var server in current.Values)
        {
            if (!server.Enabled)
            {
                live.SetState(server.Id, LiveStates.Disabled);
                continue;
            }

            if (!workers.ContainsKey(server.Id))
            {
                var cancellation = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
                workers[server.Id] = new Worker(server, cancellation, Task.Run(() => RunAsync(server, cancellation.Token)));
            }
        }
    }

    private async Task RunAsync(ServerRecord server, CancellationToken cancellationToken)
    {
        live.SetState(server.Id, LiveStates.Connecting);
        SshTarget target;
        try
        {
            target = ToTarget(server);
        }
        catch (Exception error)
        {
            logger.LogWarning(error, "{Server} 인증 정보를 복호화하지 못했습니다.", server.Name);
            live.SetState(server.Id, LiveStates.Error, "저장된 인증 정보를 열 수 없습니다. 서버 설정에서 비밀번호나 키를 다시 입력하세요.");
            return;
        }

        using var collector = new SshCollector(target);
        int failures = 0;
        while (!cancellationToken.IsCancellationRequested)
        {
            int interval = settings.Current.IntervalSeconds;
            long started = Stopwatch.GetTimestamp();
            TimeSpan delay;
            try
            {
                var values = await collector.ReadAsync(cancellationToken, Math.Max(15, interval * 3));
                failures = 0;
                if (values.Cpu is not null)
                {
                    var sample = new Sample(server.Id, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), interval * 1000,
                        values.Cpu, values.Memory, values.Disk, values.Io);
                    writer.Enqueue(sample);
                    live.OnSample(sample);
                    delay = TimeSpan.FromSeconds(interval) - Stopwatch.GetElapsedTime(started);
                }
                else
                {
                    // 접속 직후 첫 조회는 CPU 변화량을 계산할 수 없으므로 저장하지 않고 곧바로 한 번 더 읽는다.
                    delay = TimeSpan.FromSeconds(Math.Min(interval, 2));
                }
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception error)
            {
                failures++;
                live.SetState(server.Id, LiveStates.Error, SshCollector.DescribeError(error));
                delay = TimeSpan.FromSeconds(Math.Min(60, interval * Math.Pow(2, Math.Min(failures, 6))));
            }

            if (delay > TimeSpan.Zero)
            {
                try
                {
                    await Task.Delay(delay, cancellationToken);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
            }
        }
    }

    public SshTarget ToTarget(ServerRecord server)
    {
        string secret = Encoding.UTF8.GetString(servers.Unprotect(server.Secret));
        byte[]? key = server.PrivateKey is { } protectedKey ? servers.Unprotect(protectedKey) : null;
        return new SshTarget(server.Host, server.Port, server.User, server.Fingerprint, secret, key);
    }

    private void PurgeIfDue()
    {
        if (DateTime.UtcNow - lastPurge < TimeSpan.FromHours(1))
        {
            return;
        }

        lastPurge = DateTime.UtcNow;
        long before = DateTimeOffset.UtcNow.AddDays(-settings.Current.RetentionDays).ToUnixTimeMilliseconds();
        long deleted = samples.Purge(before);
        if (deleted > 0)
        {
            logger.LogInformation("보관 기간이 지난 지표 {Count}건을 지웠습니다.", deleted);
        }
    }

    private static bool SameConnection(ServerRecord a, ServerRecord b) =>
        a.Host == b.Host && a.Port == b.Port && a.User == b.User && a.Fingerprint == b.Fingerprint &&
        a.AuthType == b.AuthType && a.Secret.AsSpan().SequenceEqual(b.Secret) &&
        (a.PrivateKey ?? []).AsSpan().SequenceEqual(b.PrivateKey ?? []);

    private sealed record Worker(ServerRecord Server, CancellationTokenSource Cancellation, Task Task);
}
