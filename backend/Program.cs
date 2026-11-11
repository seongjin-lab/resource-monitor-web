using System.Text;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Net.Http.Headers;
using ResourceMonitor.Web.Data;
using ResourceMonitor.Web.Import;
using ResourceMonitor.Web.Monitoring;

var builder = WebApplication.CreateBuilder(args);

// 기본값을 "data"로 두면 대소문자를 가리지 않는 윈도우에서 소스 폴더 Data와 겹치므로 "storage"를 쓴다.
string dataDirectory = Path.GetFullPath(builder.Configuration["DataDirectory"] ?? "storage", builder.Environment.ContentRootPath);
Directory.CreateDirectory(dataDirectory);

builder.Services.AddDataProtection()
    .SetApplicationName("ResourceMonitor.Web")
    .PersistKeysToFileSystem(new DirectoryInfo(Path.Combine(dataDirectory, "keys")));
builder.Services.AddSingleton(new Database(Path.Combine(dataDirectory, "monitor.db")));
builder.Services.AddSingleton<ServerStore>();
builder.Services.AddSingleton<SampleStore>();
builder.Services.AddSingleton<SettingsStore>();
builder.Services.AddSingleton<EventBroker>();
builder.Services.AddSingleton<LiveState>();
builder.Services.AddSingleton<SampleWriter>();
builder.Services.AddHostedService(provider => provider.GetRequiredService<SampleWriter>());
builder.Services.AddSingleton<MonitorService>();
builder.Services.AddHostedService(provider => provider.GetRequiredService<MonitorService>());

var app = builder.Build();
app.UseDefaultFiles();
app.UseStaticFiles(new StaticFileOptions
{
    // index.html은 매번 새로 받게 해 업데이트 뒤 예전 화면이 남지 않게 한다. 해시가 붙은 assets는 브라우저 캐시를 쓴다.
    OnPrepareResponse = context =>
    {
        if (context.File.Name.EndsWith(".html", StringComparison.OrdinalIgnoreCase))
        {
            context.Context.Response.Headers.CacheControl = "no-cache";
        }
    }
});

var api = app.MapGroup("/api");

// ---- 서버 ----
api.MapGet("/servers", (ServerStore store, LiveState live) => store.List().Select(server => ToView(server, live)));

api.MapPost("/servers", (ServerInput input, ServerStore store, MonitorService monitor, EventBroker broker, LiveState live) =>
{
    if (Validate(input, null, store, out var credentials) is { } error)
    {
        return Fail(error);
    }

    var server = Build(Guid.NewGuid(), input, credentials!, store, enabled: input.Enabled ?? true) with
    {
        Tags = ServerRecord.NormalizeTags(input.Tags)
    };
    store.Insert(server);
    Changed(monitor, broker);
    return Results.Ok(ToView(store.Get(server.Id)!, live));
});

api.MapPut("/servers/order", (Guid[] ids, ServerStore store, EventBroker broker) =>
{
    store.SaveOrder(ids);
    broker.Publish("servers", new { });
    return Results.NoContent();
});

api.MapPut("/servers/{id:guid}", (Guid id, ServerInput input, ServerStore store, MonitorService monitor, EventBroker broker,
    LiveState live) =>
{
    if (store.Get(id) is not { } existing)
    {
        return Results.NotFound();
    }

    if (Validate(input, existing, store, out var credentials) is { } error)
    {
        return Fail(error);
    }

    store.Update(Build(id, input, credentials!, store, enabled: input.Enabled ?? existing.Enabled) with
    {
        Tags = input.Tags is null ? existing.Tags : ServerRecord.NormalizeTags(input.Tags)
    });
    Changed(monitor, broker);
    return Results.Ok(ToView(store.Get(id)!, live));
});

api.MapPut("/servers/{id:guid}/tags", (Guid id, string[] tags, ServerStore store, EventBroker broker) =>
{
    if (store.Get(id) is not { } existing)
    {
        return Results.NotFound();
    }

    store.Update(existing with { Tags = ServerRecord.NormalizeTags(tags) });
    broker.Publish("servers", new { });
    return Results.NoContent();
});

api.MapPost("/servers/{id:guid}/enabled", (Guid id, EnabledInput input, ServerStore store, MonitorService monitor,
    EventBroker broker) =>
{
    if (store.Get(id) is not { } existing)
    {
        return Results.NotFound();
    }

    store.Update(existing with { Enabled = input.Enabled });
    Changed(monitor, broker);
    return Results.NoContent();
});

api.MapDelete("/servers/{id:guid}", (Guid id, ServerStore store, MonitorService monitor, EventBroker broker) =>
{
    if (!store.Delete(id))
    {
        return Results.NotFound();
    }

    Changed(monitor, broker);
    return Results.NoContent();
});

api.MapPost("/servers/test", async (ServerInput input, ServerStore store, CancellationToken cancellationToken) =>
{
    ServerRecord? existing = input.Id is { } id ? store.Get(id) : null;
    if (ValidateConnection(input, existing, store, out var credentials) is { } error)
    {
        return Fail(error);
    }

    // 접속 테스트는 저장된 지문과 상관없이 서버가 제시한 호스트 키 지문을 받아 화면에서 확인하게 한다.
    var target = new SshTarget(input.Host!.Trim(), input.Port ?? 22, input.User!.Trim(), "",
        Encoding.UTF8.GetString(credentials!.Secret), credentials.PrivateKey);
    using var collector = new SshCollector(target);
    using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
    timeout.CancelAfter(TimeSpan.FromSeconds(20));
    try
    {
        var values = await collector.ReadAsync(timeout.Token);
        return Results.Ok(new { fingerprint = collector.PresentedFingerprint, memory = values.Memory, disk = values.Disk });
    }
    catch (Exception exception) when (!cancellationToken.IsCancellationRequested)
    {
        return Results.BadRequest(new
        {
            error = SshCollector.DescribeError(exception),
            fingerprint = collector.PresentedFingerprint
        });
    }
});

api.MapPost("/servers/import", async (HttpRequest request, ServerStore store, MonitorService monitor, EventBroker broker) =>
{
    if (!request.HasFormContentType)
    {
        return Fail(".rmon 파일과 공유 암호를 함께 보내야 합니다.");
    }

    var form = await request.ReadFormAsync();
    if (form.Files.GetFile("file") is not { } file || file.Length == 0)
    {
        return Fail(".rmon 파일을 선택하세요.");
    }

    if (file.Length > RmonImporter.MaxSize)
    {
        return Fail("파일이 32MB를 넘습니다.");
    }

    string password = form["password"].ToString();
    if (password.Length == 0)
    {
        return Fail("공유 암호를 입력하세요.");
    }

    using var buffer = new MemoryStream();
    await file.CopyToAsync(buffer);
    try
    {
        var result = await Task.Run(() => RmonImporter.Import(buffer.ToArray(), password, store));
        Changed(monitor, broker);
        return Results.Ok(result);
    }
    catch (InvalidDataException error)
    {
        return Fail(error.Message);
    }
});

// ---- 지표 ----
api.MapGet("/servers/{id:guid}/samples", (Guid id, long? from, long? to, int? points, SampleStore samples) =>
{
    var (start, end) = Range(from, to, TimeSpan.FromMinutes(15));
    return Results.Ok(samples.Query(id, start, end, points ?? 800));
});

api.MapGet("/servers/{id:guid}/samples.csv", async (Guid id, long? from, long? to, ServerStore store, SampleStore samples,
    HttpContext context) =>
{
    if (store.Get(id) is not { } server)
    {
        context.Response.StatusCode = StatusCodes.Status404NotFound;
        return;
    }

    var (start, end) = Range(from, to, TimeSpan.FromHours(1));
    string fileName = $"{server.Name}_{DateTimeOffset.FromUnixTimeMilliseconds(start).ToLocalTime():yyyyMMdd-HHmm}.csv";
    context.Response.ContentType = "text/csv; charset=utf-8";
    context.Response.Headers.ContentDisposition = new ContentDispositionHeaderValue("attachment")
    {
        FileNameStar = fileName
    }.ToString();
    await samples.WriteCsvAsync(id, server.Name, start, end, context.Response.Body, context.RequestAborted);
});

api.MapGet("/samples/recent", (int? minutes, int? points, ServerStore store, SampleStore samples) =>
{
    var (start, end) = Range(null, null, TimeSpan.FromMinutes(Math.Clamp(minutes ?? 15, 1, 180)));
    return store.List().ToDictionary(server => server.Id.ToString(), server => samples.Query(server.Id, start, end, points ?? 120));
});

// ---- 설정 ----
var settingsWriteLock = new object();
api.MapGet("/settings", (SettingsStore settings) => new { settings.Current, AppSettings.IntervalChoices });

api.MapPut("/settings/interval", (IntervalInput input, SettingsStore settings, EventBroker broker) =>
{
    lock (settingsWriteLock)
    {
        var saved = settings.Current with { IntervalSeconds = input.IntervalSeconds };
        if (saved.Validate() is { } error)
        {
            return Fail(error);
        }

        settings.Save(saved);
        broker.Publish("settings", saved);
        return Results.Ok(saved);
    }
});

api.MapPut("/settings", (AppSettings input, SettingsStore settings, EventBroker broker) =>
{
    if (input.Validate() is { } error)
    {
        return Fail(error);
    }

    lock (settingsWriteLock)
    {
        // 요청에 들어온 태그만 변경하고, 값이 null이면 자동 색상으로 되돌린다.
        var colors = new Dictionary<string, string?>(settings.Current.TagColors);
        foreach (var (tag, color) in input.TagColors)
        {
            if (color is null)
            {
                colors.Remove(tag);
            }
            else
            {
                colors[tag] = color.ToLowerInvariant();
            }
        }

        var saved = input with { TagColors = colors };
        settings.Save(saved);
        broker.Publish("settings", saved);
        return Results.Ok(saved);
    }
});

// ---- 실시간 이벤트(SSE) ----
api.MapGet("/events", async (HttpContext context, EventBroker broker) =>
{
    var cancellationToken = context.RequestAborted;
    context.Response.ContentType = "text/event-stream";
    context.Response.Headers.CacheControl = "no-cache";
    context.Response.Headers["X-Accel-Buffering"] = "no";
    var (id, reader) = broker.Subscribe();
    try
    {
        await context.Response.WriteAsync("retry: 3000\n: connected\n\n", cancellationToken);
        await context.Response.Body.FlushAsync(cancellationToken);
        while (!cancellationToken.IsCancellationRequested)
        {
            using var wait = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            wait.CancelAfter(TimeSpan.FromSeconds(15));
            try
            {
                if (!await reader.WaitToReadAsync(wait.Token))
                {
                    break;
                }

                while (reader.TryRead(out var message))
                {
                    await context.Response.WriteAsync(message, cancellationToken);
                }
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                await context.Response.WriteAsync(": ping\n\n", cancellationToken);
            }

            await context.Response.Body.FlushAsync(cancellationToken);
        }
    }
    catch (OperationCanceledException)
    {
    }
    finally
    {
        broker.Unsubscribe(id);
    }
});

app.MapFallbackToFile("index.html", new StaticFileOptions
{
    OnPrepareResponse = context => context.Context.Response.Headers.CacheControl = "no-cache"
});
app.Run();

// ---- 도우미 ----
static object ToView(ServerRecord server, LiveState live)
{
    var status = live.Get(server.Id);
    return new
    {
        server.Id,
        server.Name,
        server.Host,
        server.Port,
        server.User,
        server.Fingerprint,
        server.AuthType,
        server.Enabled,
        server.Tags,
        Status =server.Enabled ? status.State : LiveStates.Disabled,
        status.Error,
        status.LastUtc,
        status.Latest
    };
}

static IResult Fail(string message) => Results.BadRequest(new { error = message });

static void Changed(MonitorService monitor, EventBroker broker)
{
    monitor.RequestReconcile();
    broker.Publish("servers", new { });
}

static (long Start, long End) Range(long? from, long? to, TimeSpan defaultSpan)
{
    long end = to ?? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    long start = from ?? end - (long)defaultSpan.TotalMilliseconds;
    return start < end ? (start, end) : (end - (long)defaultSpan.TotalMilliseconds, end);
}

static string? ValidateConnection(ServerInput input, ServerRecord? existing, ServerStore store, out Credentials? credentials)
{
    credentials = null;
    if (string.IsNullOrWhiteSpace(input.Host) || Uri.CheckHostName(input.Host.Trim()) == UriHostNameType.Unknown)
    {
        return "서버 주소를 올바르게 입력하세요.";
    }

    if (input.Port is { } port && port is < 1 or > 65535)
    {
        return "포트는 1~65535 사이여야 합니다.";
    }

    if (string.IsNullOrWhiteSpace(input.User))
    {
        return "계정을 입력하세요.";
    }

    string auth = input.AuthType ?? existing?.AuthType ?? AuthTypes.Password;
    if (auth == AuthTypes.Password)
    {
        if (!string.IsNullOrEmpty(input.Password))
        {
            credentials = new Credentials(auth, Encoding.UTF8.GetBytes(input.Password), null);
        }
        else if (existing?.AuthType == AuthTypes.Password)
        {
            credentials = new Credentials(auth, store.Unprotect(existing.Secret), null);
        }
        else
        {
            return "비밀번호를 입력하세요.";
        }
    }
    else if (auth == AuthTypes.Key)
    {
        if (!string.IsNullOrWhiteSpace(input.PrivateKey))
        {
            credentials = new Credentials(auth, Encoding.UTF8.GetBytes(input.Passphrase ?? ""),
                Encoding.UTF8.GetBytes(input.PrivateKey.Replace("\r\n", "\n").Trim() + "\n"));
        }
        else if (existing is { AuthType: AuthTypes.Key, PrivateKey: { } protectedKey })
        {
            byte[] secret = string.IsNullOrEmpty(input.Passphrase)
                ? store.Unprotect(existing.Secret)
                : Encoding.UTF8.GetBytes(input.Passphrase);
            credentials = new Credentials(auth, secret, store.Unprotect(protectedKey));
        }
        else
        {
            return "개인 키를 붙여 넣거나 파일로 선택하세요.";
        }
    }
    else
    {
        return "인증 방식이 올바르지 않습니다.";
    }

    return null;
}

static string? Validate(ServerInput input, ServerRecord? existing, ServerStore store, out Credentials? credentials)
{
    credentials = null;
    if (string.IsNullOrWhiteSpace(input.Name) || input.Name.Trim().Length > 100)
    {
        return "서버 이름을 1~100자로 입력하세요.";
    }

    if (!Validation.IsFingerprint(input.Fingerprint))
    {
        return "접속 테스트로 SSH 호스트 키 지문을 확인한 뒤 저장하세요.";
    }

    return ValidateConnection(input, existing, store, out credentials);
}

static ServerRecord Build(Guid id, ServerInput input, Credentials credentials, ServerStore store, bool enabled) => new(
    id, input.Name!.Trim(), input.Host!.Trim(), input.Port ?? 22, input.User!.Trim(), input.Fingerprint!,
    credentials.AuthType, store.Protect(credentials.Secret),
    credentials.PrivateKey is { } key ? store.Protect(key) : null, enabled, 0);

public sealed record ServerInput(Guid? Id, string? Name, string? Host, int? Port, string? User, string? AuthType,
    string? Password, string? PrivateKey, string? Passphrase, string? Fingerprint, bool? Enabled, string[]? Tags);

public sealed record EnabledInput(bool Enabled);

public sealed record IntervalInput(int IntervalSeconds);

public sealed record Credentials(string AuthType, byte[] Secret, byte[]? PrivateKey);
