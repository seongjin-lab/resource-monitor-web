using Microsoft.Data.Sqlite;

namespace ResourceMonitor.Web.Data;

/// <summary>SQLite 파일 하나에 서버 목록, 수집 지표, 설정을 모두 저장한다.</summary>
public sealed class Database
{
    private readonly string connectionString;

    public Database(string path)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
        connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = path,
            DefaultTimeout = 10,
            Pooling = true
        }.ToString();

        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS servers (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL, user TEXT NOT NULL,
                fingerprint TEXT NOT NULL, auth_type TEXT NOT NULL,
                secret BLOB NOT NULL, private_key BLOB,
                enabled INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS samples (
                id INTEGER PRIMARY KEY,
                server TEXT NOT NULL, utc INTEGER NOT NULL, interval_ms INTEGER NOT NULL,
                cpu REAL, memory REAL, disk REAL, io REAL
            );
            CREATE INDEX IF NOT EXISTS sample_server_time ON samples(server, utc);
            CREATE INDEX IF NOT EXISTS sample_time ON samples(utc);
            CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            """;
        command.ExecuteNonQuery();

        // 태그 열은 나중에 추가했으므로 예전 DB에는 열을 덧붙인다.
        using var columns = connection.CreateCommand();
        columns.CommandText = "SELECT count(*) FROM pragma_table_info('servers') WHERE name = 'tags'";
        if (Convert.ToInt64(columns.ExecuteScalar()) == 0)
        {
            using var alter = connection.CreateCommand();
            alter.CommandText = "ALTER TABLE servers ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'";
            alter.ExecuteNonQuery();
        }
    }

    public SqliteConnection Open()
    {
        var connection = new SqliteConnection(connectionString);
        try
        {
            connection.Open();
            using var pragma = connection.CreateCommand();
            pragma.CommandText = "PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 10000;";
            pragma.ExecuteNonQuery();
            return connection;
        }
        catch
        {
            connection.Dispose();
            throw;
        }
    }
}
