using Microsoft.AspNetCore.DataProtection;
using Microsoft.Data.Sqlite;

namespace ResourceMonitor.Web.Data;

public static class AuthTypes
{
    public const string Password = "password";
    public const string Key = "key";
}

/// <summary>DB에 저장된 서버. Secret과 PrivateKey는 Data Protection으로 암호화된 상태다.</summary>
public sealed record ServerRecord(Guid Id, string Name, string Host, int Port, string User, string Fingerprint,
    string AuthType, byte[] Secret, byte[]? PrivateKey, bool Enabled, int Sort)
{
    /// <summary>서버를 묶어 보기 위한 정보성 태그. 수집 동작에는 영향을 주지 않는다.</summary>
    public IReadOnlyList<string> Tags { get; init; } = [];

    public static IReadOnlyList<string> NormalizeTags(IEnumerable<string>? tags) => (tags ?? [])
        .Select(tag => tag.Trim())
        .Where(tag => tag.Length is > 0 and <= 30)
        .Distinct(StringComparer.OrdinalIgnoreCase)
        .Take(10)
        .ToArray();
}

public sealed class ServerStore(Database database, IDataProtectionProvider protectionProvider)
{
    private readonly IDataProtector protector = protectionProvider.CreateProtector("ResourceMonitor.ServerSecrets.v1");

    public byte[] Protect(byte[] plain) => protector.Protect(plain);
    public byte[] Unprotect(byte[] protectedBytes) => protector.Unprotect(protectedBytes);

    public IReadOnlyList<ServerRecord> List()
    {
        using var connection = database.Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT id, name, host, port, user, fingerprint, auth_type, secret, private_key, enabled, sort, tags
            FROM servers ORDER BY sort, name
            """;
        using var reader = command.ExecuteReader();
        var list = new List<ServerRecord>();
        while (reader.Read())
        {
            list.Add(Read(reader));
        }

        return list;
    }

    public ServerRecord? Get(Guid id) => List().FirstOrDefault(server => server.Id == id);

    public void Insert(ServerRecord server)
    {
        using var connection = database.Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT INTO servers(id, name, host, port, user, fingerprint, auth_type, secret, private_key, enabled, tags, sort)
            VALUES ($id, $name, $host, $port, $user, $fingerprint, $auth, $secret, $key, $enabled, $tags,
                COALESCE((SELECT max(sort) + 1 FROM servers), 0))
            """;
        Bind(command, server, server.Enabled);
        command.ExecuteNonQuery();
    }

    public void Update(ServerRecord server, bool? enabled)
    {
        using var connection = database.Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            UPDATE servers SET name=$name, host=$host, port=$port, user=$user, fingerprint=$fingerprint,
                auth_type=$auth, secret=$secret, private_key=$key, enabled=COALESCE($enabled, enabled), tags=$tags
            WHERE id=$id
            """;
        Bind(command, server, enabled);
        command.ExecuteNonQuery();
    }

    public bool SetTags(Guid id, IReadOnlyList<string> tags)
    {
        using var connection = database.Open();
        using var command = connection.CreateCommand();
        command.CommandText = "UPDATE servers SET tags = $tags WHERE id = $id";
        command.Parameters.AddWithValue("$id", id.ToString("N"));
        command.Parameters.AddWithValue("$tags", System.Text.Json.JsonSerializer.Serialize(tags));
        return command.ExecuteNonQuery() > 0;
    }

    public bool SetEnabled(Guid id, bool enabled)
    {
        using var connection = database.Open();
        using var command = connection.CreateCommand();
        command.CommandText = "UPDATE servers SET enabled = $enabled WHERE id = $id";
        command.Parameters.AddWithValue("$id", id.ToString("N"));
        command.Parameters.AddWithValue("$enabled", enabled ? 1 : 0);
        return command.ExecuteNonQuery() > 0;
    }

    public bool TryDisable(ServerRecord server)
    {
        using var connection = database.Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            UPDATE servers SET enabled = 0
            WHERE id = $id AND enabled = 1 AND host = $host AND port = $port AND user = $user
                AND fingerprint = $fingerprint AND auth_type = $auth AND secret = $secret AND private_key IS $key
            """;
        BindConnection(command, server);
        return command.ExecuteNonQuery() > 0;
    }

    public bool Delete(Guid id)
    {
        using var connection = database.Open();
        using var transaction = connection.BeginTransaction();
        using var samples = connection.CreateCommand();
        samples.Transaction = transaction;
        samples.CommandText = "DELETE FROM samples WHERE server = $id";
        samples.Parameters.AddWithValue("$id", id.ToString("N"));
        samples.ExecuteNonQuery();
        using var servers = connection.CreateCommand();
        servers.Transaction = transaction;
        servers.CommandText = "DELETE FROM servers WHERE id = $id";
        servers.Parameters.AddWithValue("$id", id.ToString("N"));
        bool deleted = servers.ExecuteNonQuery() > 0;
        transaction.Commit();
        return deleted;
    }

    public void SaveOrder(IReadOnlyList<Guid> ids)
    {
        using var connection = database.Open();
        using var transaction = connection.BeginTransaction();
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "UPDATE servers SET sort = $sort WHERE id = $id";
        var sort = command.Parameters.Add("$sort", SqliteType.Integer);
        var id = command.Parameters.Add("$id", SqliteType.Text);
        for (int index = 0; index < ids.Count; index++)
        {
            sort.Value = index;
            id.Value = ids[index].ToString("N");
            command.ExecuteNonQuery();
        }

        transaction.Commit();
    }

    private static void Bind(SqliteCommand command, ServerRecord server, bool? enabled)
    {
        BindConnection(command, server);
        command.Parameters.AddWithValue("$name", server.Name);
        command.Parameters.AddWithValue("$enabled", (object?)enabled ?? DBNull.Value);
        command.Parameters.AddWithValue("$tags", System.Text.Json.JsonSerializer.Serialize(server.Tags));
    }

    private static void BindConnection(SqliteCommand command, ServerRecord server)
    {
        command.Parameters.AddWithValue("$id", server.Id.ToString("N"));
        command.Parameters.AddWithValue("$host", server.Host);
        command.Parameters.AddWithValue("$port", server.Port);
        command.Parameters.AddWithValue("$user", server.User);
        command.Parameters.AddWithValue("$fingerprint", server.Fingerprint);
        command.Parameters.AddWithValue("$auth", server.AuthType);
        command.Parameters.AddWithValue("$secret", server.Secret);
        command.Parameters.AddWithValue("$key", (object?)server.PrivateKey ?? DBNull.Value);
    }

    private static ServerRecord Read(SqliteDataReader reader) => new(
        Guid.ParseExact(reader.GetString(0), "N"),
        reader.GetString(1), reader.GetString(2), reader.GetInt32(3), reader.GetString(4), reader.GetString(5),
        reader.GetString(6), (byte[])reader[7], reader.IsDBNull(8) ? null : (byte[])reader[8],
        reader.GetInt64(9) != 0, reader.GetInt32(10))
    {
        Tags = System.Text.Json.JsonSerializer.Deserialize<string[]>(reader.GetString(11)) ?? []
    };
}
