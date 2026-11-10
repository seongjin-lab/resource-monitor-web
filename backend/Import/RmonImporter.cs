using System.Security.Cryptography;
using System.Text.Json;
using ResourceMonitor.Web.Data;

namespace ResourceMonitor.Web.Import;

/// <summary>데스크톱 앱의 "내보내기"로 만든 .rmon 파일(AES-GCM, PBKDF2)을 읽어 서버를 등록한다.</summary>
public static class RmonImporter
{
    private static ReadOnlySpan<byte> Header => "RMONB001"u8;
    private const int SaltSize = 16;
    private const int NonceSize = 12;
    private const int TagSize = 16;
    private const int PrefixSize = 8 + SaltSize + NonceSize + TagSize;
    public const int MaxSize = 32 * 1024 * 1024;

    public sealed record Result(int Added, int Skipped);

    public static Result Import(byte[] file, string password, ServerStore store)
    {
        if (file.Length <= PrefixSize || file.Length > MaxSize)
        {
            throw new InvalidDataException("지원하지 않는 서버 공유 파일 크기입니다.");
        }

        if (!file.AsSpan(0, Header.Length).SequenceEqual(Header))
        {
            throw new InvalidDataException("리소스 모니터 서버 공유 파일(.rmon)이 아닙니다.");
        }

        byte[] payload = new byte[file.Length - PrefixSize];
        byte[] key = Rfc2898DeriveBytes.Pbkdf2(password, file.AsSpan(Header.Length, SaltSize), 600_000,
            HashAlgorithmName.SHA256, 32);
        List<Entry>? entries = null;
        try
        {
            using var cipher = new AesGcm(key, TagSize);
            try
            {
                cipher.Decrypt(file.AsSpan(Header.Length + SaltSize, NonceSize), file.AsSpan(PrefixSize),
                    file.AsSpan(PrefixSize - TagSize, TagSize), payload, Header);
            }
            catch (AuthenticationTagMismatchException)
            {
                throw new InvalidDataException("공유 파일 암호가 다르거나 파일이 손상되었습니다.");
            }

            entries = JsonSerializer.Deserialize<List<Entry>>(payload);
            if (entries is null || entries.Count == 0 || entries.Any(entry => !IsValid(entry)))
            {
                throw new InvalidDataException("공유 파일에 올바르지 않은 서버 정보가 있습니다.");
            }

            var addresses = store.List()
                .Select(server => (server.Host.ToUpperInvariant(), server.Port, server.User)).ToHashSet();
            int added = 0;
            foreach (Entry entry in entries)
            {
                if (!addresses.Add((entry.Host.ToUpperInvariant(), entry.Port, entry.User)))
                {
                    continue;
                }

                store.Insert(new ServerRecord(Guid.NewGuid(), entry.Name.Trim(), entry.Host.Trim(), entry.Port,
                    entry.User.Trim(), entry.Fingerprint, entry.Key is null ? AuthTypes.Password : AuthTypes.Key,
                    store.Protect(entry.Secret), entry.Key is { } bytes ? store.Protect(bytes) : null,
                    entry.Enabled, 0));
                added++;
            }

            return new Result(added, entries.Count - added);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(key);
            CryptographicOperations.ZeroMemory(payload);
            foreach (Entry? entry in entries ?? [])
            {
                if (entry?.Secret is { } secret) CryptographicOperations.ZeroMemory(secret);
                if (entry?.Key is { } privateKey) CryptographicOperations.ZeroMemory(privateKey);
            }
        }
    }

    private static bool IsValid(Entry? entry) => entry is not null &&
        !string.IsNullOrWhiteSpace(entry.Name) && !string.IsNullOrWhiteSpace(entry.Host) &&
        Uri.CheckHostName(entry.Host) != UriHostNameType.Unknown && entry.Port is >= 1 and <= 65535 &&
        !string.IsNullOrWhiteSpace(entry.User) && Validation.IsFingerprint(entry.Fingerprint) &&
        entry.Secret is not null && (entry.Key is { Length: > 0 } || entry.Key is null && entry.Secret.Length > 0);

    private sealed record Entry(string Name, string Host, int Port, string User, string Fingerprint, byte[] Secret, byte[]? Key)
    {
        public bool Enabled { get; init; } = true;
    }
}

public static class Validation
{
    public static bool IsFingerprint(string? value) => value is { Length: 43 } fingerprint &&
        fingerprint.All(character => char.IsAsciiLetterOrDigit(character) || character is '+' or '/');
}
