using System.Collections.Concurrent;
using ResourceMonitor.Web.Data;

namespace ResourceMonitor.Web.Monitoring;

public static class LiveStates
{
    public const string Connecting = "connecting";
    public const string Ok = "ok";
    public const string Error = "error";
    public const string Disabled = "disabled";
}

public sealed record LiveStatus(string State, string? Error, long? LastUtc, MetricValues? Latest);

/// <summary>서버별 현재 상태와 최신 값. 바뀔 때마다 SSE로 알린다.</summary>
public sealed class LiveState(EventBroker broker)
{
    private readonly ConcurrentDictionary<Guid, LiveStatus> statuses = new();

    public LiveStatus Get(Guid id) =>
        statuses.TryGetValue(id, out var status) ? status : new LiveStatus(LiveStates.Connecting, null, null, null);

    public void SetState(Guid id, string state, string? error = null)
    {
        if (statuses.TryGetValue(id, out var existing) && existing.State == state && existing.Error == error)
        {
            return;
        }

        var updated = statuses.AddOrUpdate(id,
            _ => new LiveStatus(state, error, null, null),
            (_, old) => old with { State = state, Error = error });
        Publish(id, updated);
    }

    public void OnSample(Sample sample)
    {
        var latest = new MetricValues(Round(sample.Cpu), Round(sample.Memory), Round(sample.Disk), Round(sample.Io));
        var updated = statuses.AddOrUpdate(sample.Server,
            _ => new LiveStatus(LiveStates.Ok, null, sample.Utc, latest),
            (_, _) => new LiveStatus(LiveStates.Ok, null, sample.Utc, latest));
        broker.Publish("sample", new
        {
            serverId = sample.Server,
            t = sample.Utc / 1000.0,
            cpu = latest.Cpu,
            memory = latest.Memory,
            disk = latest.Disk,
            io = latest.Io
        });
        Publish(sample.Server, updated);
    }

    public void Remove(Guid id) => statuses.TryRemove(id, out _);

    private void Publish(Guid id, LiveStatus status) => broker.Publish("status", new
    {
        serverId = id,
        state = status.State,
        error = status.Error,
        lastUtc = status.LastUtc
    });

    private static double? Round(double? value) => value is { } number ? Math.Round(number, 2) : null;
}
