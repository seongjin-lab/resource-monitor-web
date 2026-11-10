using System.Collections.Concurrent;
using System.Text.Json;
using System.Threading.Channels;

namespace ResourceMonitor.Web.Monitoring;

/// <summary>SSE 구독자마다 채널을 두고 이벤트 문자열을 나눠 준다. 느린 구독자는 오래된 이벤트부터 버린다.</summary>
public sealed class EventBroker
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private readonly ConcurrentDictionary<Guid, Channel<string>> subscribers = new();

    public (Guid Id, ChannelReader<string> Reader) Subscribe()
    {
        var channel = Channel.CreateBounded<string>(new BoundedChannelOptions(2000)
        {
            FullMode = BoundedChannelFullMode.DropOldest,
            SingleReader = true
        });
        var id = Guid.NewGuid();
        subscribers[id] = channel;
        return (id, channel.Reader);
    }

    public void Unsubscribe(Guid id)
    {
        if (subscribers.TryRemove(id, out var channel))
        {
            channel.Writer.TryComplete();
        }
    }

    public void Publish(string eventName, object payload)
    {
        string message = $"event: {eventName}\ndata: {JsonSerializer.Serialize(payload, Json)}\n\n";
        foreach (var channel in subscribers.Values)
        {
            channel.Writer.TryWrite(message);
        }
    }
}
