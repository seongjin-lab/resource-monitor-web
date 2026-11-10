using System.Text.Json;

namespace ResourceMonitor.Web.Data;

public sealed record AppSettings
{
    public static readonly int[] IntervalChoices = [1, 3, 5, 10, 15, 30, 60];

    public int IntervalSeconds { get; init; } = 5;
    public int RetentionDays { get; init; } = 30;
    public double CpuWarn { get; init; } = 80;
    public double MemoryWarn { get; init; } = 85;
    public double DiskWarn { get; init; } = 85;

    public string? Validate()
    {
        if (!IntervalChoices.Contains(IntervalSeconds))
        {
            return $"갱신 주기는 {string.Join(", ", IntervalChoices)}초 중 하나여야 합니다.";
        }

        if (RetentionDays is < 1 or > 3650)
        {
            return "보관 기간은 1~3650일이어야 합니다.";
        }

        return new[] { CpuWarn, MemoryWarn, DiskWarn }.Any(value => value is < 1 or > 100)
            ? "경고 기준은 1~100% 사이여야 합니다."
            : null;
    }
}

public sealed class SettingsStore
{
    private readonly Database database;
    private volatile AppSettings current;

    public SettingsStore(Database database)
    {
        this.database = database;
        using var connection = database.Open();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT value FROM settings WHERE key = 'app'";
        current = command.ExecuteScalar() is string json
            ? JsonSerializer.Deserialize<AppSettings>(json) ?? new AppSettings()
            : new AppSettings();
    }

    public AppSettings Current => current;

    public void Save(AppSettings settings)
    {
        using var connection = database.Open();
        using var command = connection.CreateCommand();
        command.CommandText = "INSERT INTO settings(key, value) VALUES ('app', $value) ON CONFLICT(key) DO UPDATE SET value = $value";
        command.Parameters.AddWithValue("$value", JsonSerializer.Serialize(settings));
        command.ExecuteNonQuery();
        current = settings;
    }
}
