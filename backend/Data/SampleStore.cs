using System.Globalization;
using System.Text;
using Microsoft.Data.Sqlite;

namespace ResourceMonitor.Web.Data;

public sealed record Sample(Guid Server, long Utc, int IntervalMs, double? Cpu, double? Memory, double? Disk, double? Io);

/// <summary>uPlot이 바로 쓸 수 있는 열 단위 시계열. T는 Unix 초.</summary>
public sealed record SeriesResult(long BucketMs, List<double> T, List<double?> Cpu, List<double?> Memory,
    List<double?> Disk, List<double?> Io)
{
    public static SeriesResult Empty(long bucketMs) => new(bucketMs, [], [], [], [], []);

    public void Add(long utc, double? cpu, double? memory, double? disk, double? io)
    {
        T.Add(utc / 1000.0);
        Cpu.Add(cpu);
        Memory.Add(memory);
        Disk.Add(disk);
        Io.Add(io);
    }
}

public sealed class SampleStore(Database database)
{
    public void Append(IReadOnlyList<Sample> samples)
    {
        using var connection = database.Open();
        using var transaction = connection.BeginTransaction();
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
            INSERT INTO samples(server, utc, interval_ms, cpu, memory, disk, io)
            VALUES ($server, $utc, $interval, $cpu, $memory, $disk, $io)
            """;
        var server = command.Parameters.Add("$server", SqliteType.Text);
        var utc = command.Parameters.Add("$utc", SqliteType.Integer);
        var interval = command.Parameters.Add("$interval", SqliteType.Integer);
        var cpu = command.Parameters.Add("$cpu", SqliteType.Real);
        var memory = command.Parameters.Add("$memory", SqliteType.Real);
        var disk = command.Parameters.Add("$disk", SqliteType.Real);
        var io = command.Parameters.Add("$io", SqliteType.Real);
        foreach (Sample sample in samples)
        {
            server.Value = sample.Server.ToString("N");
            utc.Value = sample.Utc;
            interval.Value = sample.IntervalMs;
            cpu.Value = (object?)sample.Cpu ?? DBNull.Value;
            memory.Value = (object?)sample.Memory ?? DBNull.Value;
            disk.Value = (object?)sample.Disk ?? DBNull.Value;
            io.Value = (object?)sample.Io ?? DBNull.Value;
            command.ExecuteNonQuery();
        }

        transaction.Commit();
    }

    /// <summary>
    /// 기간 안의 지표를 최대 maxPoints개 구간으로 묶어 평균을 낸다. 수집이 끊긴 구간에는 null을 넣어 선이 이어지지 않게 한다.
    /// </summary>
    public SeriesResult Query(Guid server, long fromMs, long toMs, int maxPoints)
    {
        maxPoints = Math.Clamp(maxPoints, 50, 5000);
        long span = Math.Max(1, toMs - fromMs);
        using var connection = database.Open();
        using var count = connection.CreateCommand();
        count.CommandText = "SELECT count(*) FROM samples WHERE server = $server AND utc >= $from AND utc < $to";
        AddRange(count, server, fromMs, toMs);
        long rows = Convert.ToInt64(count.ExecuteScalar(), CultureInfo.InvariantCulture);
        long bucket = rows <= maxPoints ? 0 : (span + maxPoints - 1) / maxPoints;

        using var command = connection.CreateCommand();
        command.CommandText = bucket == 0
            ? """
              SELECT utc, interval_ms, cpu, memory, disk, io FROM samples
              WHERE server = $server AND utc >= $from AND utc < $to ORDER BY utc, id
              """
            : """
              SELECT min(utc), max(interval_ms), avg(cpu), avg(memory), avg(disk), avg(io) FROM samples
              WHERE server = $server AND utc >= $from AND utc < $to
              GROUP BY (utc - $from) / $bucket ORDER BY 1
              """;
        AddRange(command, server, fromMs, toMs);
        command.Parameters.AddWithValue("$bucket", Math.Max(bucket, 1));

        var result = SeriesResult.Empty(bucket);
        using var reader = command.ExecuteReader();
        long previousTime = -1;
        long previousInterval = 0;
        while (reader.Read())
        {
            long time = reader.GetInt64(0);
            long interval = reader.GetInt64(1);
            long allowed = bucket + (long)(2.5 * Math.Max(interval, previousInterval)) + 500;
            if (previousTime >= 0 && time - previousTime > allowed)
            {
                result.Add(previousTime + 1, null, null, null, null);
            }

            result.Add(time, Nullable(reader, 2), Nullable(reader, 3), Nullable(reader, 4), Nullable(reader, 5));
            previousTime = time;
            previousInterval = interval;
        }

        return result;
    }

    public async Task WriteCsvAsync(Guid server, string serverName, long fromMs, long toMs, Stream output,
        CancellationToken cancellationToken)
    {
        await using var writer = new StreamWriter(output, new UTF8Encoding(encoderShouldEmitUTF8Identifier: true));
        await writer.WriteLineAsync("server,time_utc,cpu_percent,memory_percent,disk_percent,disk_io_mb_s");
        using var connection = database.Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT utc, cpu, memory, disk, io FROM samples
            WHERE server = $server AND utc >= $from AND utc < $to ORDER BY utc, id
            """;
        AddRange(command, server, fromMs, toMs);
        string name = Csv(serverName);
        using var reader = command.ExecuteReader();
        while (reader.Read())
        {
            string time = DateTimeOffset.FromUnixTimeMilliseconds(reader.GetInt64(0)).UtcDateTime
                .ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);
            await writer.WriteLineAsync(string.Join(',', name, time,
                Format(reader, 1), Format(reader, 2), Format(reader, 3), Format(reader, 4)).AsMemory(), cancellationToken);
        }
    }

    public long Purge(long beforeMs)
    {
        using var connection = database.Open();
        using var command = connection.CreateCommand();
        command.CommandText = "DELETE FROM samples WHERE utc < $before";
        command.Parameters.AddWithValue("$before", beforeMs);
        return command.ExecuteNonQuery();
    }

    private static void AddRange(SqliteCommand command, Guid server, long fromMs, long toMs)
    {
        command.Parameters.AddWithValue("$server", server.ToString("N"));
        command.Parameters.AddWithValue("$from", fromMs);
        command.Parameters.AddWithValue("$to", toMs);
    }

    private static double? Nullable(SqliteDataReader reader, int index) =>
        reader.IsDBNull(index) ? null : Math.Round(reader.GetDouble(index), 2);

    private static string Format(SqliteDataReader reader, int index) =>
        reader.IsDBNull(index) ? "" : reader.GetDouble(index).ToString("0.##", CultureInfo.InvariantCulture);

    private static string Csv(string value) =>
        value.IndexOfAny([',', '"', '\n', '\r']) >= 0 ? "\"" + value.Replace("\"", "\"\"") + "\"" : value;
}
