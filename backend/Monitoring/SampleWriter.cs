using System.Threading.Channels;
using ResourceMonitor.Web.Data;

namespace ResourceMonitor.Web.Monitoring;

/// <summary>여러 서버 수집 루프가 넣은 지표를 한 곳에서 묶어 저장해 SQLite 쓰기 경합을 줄인다.</summary>
public sealed class SampleWriter(SampleStore store, ILogger<SampleWriter> logger) : BackgroundService
{
    private readonly Channel<Sample> queue = Channel.CreateBounded<Sample>(new BoundedChannelOptions(50_000)
    {
        FullMode = BoundedChannelFullMode.DropOldest,
        SingleReader = true
    });

    public void Enqueue(Sample sample) => queue.Writer.TryWrite(sample);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var batch = new List<Sample>(500);
        try
        {
            while (await queue.Reader.WaitToReadAsync(stoppingToken))
            {
                while (batch.Count < 500 && queue.Reader.TryRead(out var sample))
                {
                    batch.Add(sample);
                }

                Flush(batch);
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
        }

        while (queue.Reader.TryRead(out var sample))
        {
            batch.Add(sample);
        }

        Flush(batch);
    }

    private void Flush(List<Sample> batch)
    {
        if (batch.Count == 0)
        {
            return;
        }

        try
        {
            store.Append(batch);
        }
        catch (Exception error)
        {
            logger.LogError(error, "지표 {Count}건을 저장하지 못했습니다.", batch.Count);
        }

        batch.Clear();
    }
}
