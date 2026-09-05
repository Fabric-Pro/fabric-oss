using System.Diagnostics;
using System.Text.Json;
using System.Text.RegularExpressions;
using Aspire.Hosting;
using DotNetEnv;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

var builder = DistributedApplication.CreateBuilder(args);

// ============================================================================
// DOCKER DESKTOP GROUPING
// ============================================================================
// Add Docker Compose project labels to group all containers under "fabric" in Docker Desktop
const string dockerProjectName = "fabric";

// ============================================================================
// DEPLOYMENT MODE DETECTION
// ============================================================================
// IsPublishMode = true when running `azd up` or `azd deploy`
// IsPublishMode = false when running `dotnet run` locally
var isPublishMode = builder.ExecutionContext.IsPublishMode;

// Load .env.local file from repository root (for local development)
var repoRoot = Path.GetFullPath(Path.Combine(builder.AppHostDirectory, "../.."));

// Host-side pnpm binary used by the database resource commands further down.
// Windows resolves pnpm through a .cmd shim, which ProcessStartInfo cannot launch
// without the extension when UseShellExecute is false.
var pnpmExecutable = OperatingSystem.IsWindows() ? "pnpm.cmd" : "pnpm";

// Container runtime CLI used by the agent "Rebuild & restart" command to exec into
// a running container. `DcpPublisher:ContainerRuntime` is the key Aspire itself
// binds to choose podman over the docker default; the env var is the form the
// Aspire docs use for the same switch. Unlike pnpm, both CLIs resolve without a
// .cmd suffix on Windows.
var containerRuntimeExecutable = (
    builder.Configuration["DcpPublisher:ContainerRuntime"]
    ?? Environment.GetEnvironmentVariable("DOTNET_ASPIRE_CONTAINER_RUNTIME")
    ?? "docker").ToLowerInvariant();

var envFilePath = Path.Combine(repoRoot, ".env.local");
Console.WriteLine($"[DEBUG] Looking for .env.local at: {envFilePath}");
Console.WriteLine($"[DEBUG] File exists: {File.Exists(envFilePath)}");
Console.WriteLine($"[DEBUG] IsPublishMode: {isPublishMode}");

// Dictionary to store all environment variables from .env.local
var envVars = new Dictionary<string, string>();

if (File.Exists(envFilePath))
{
    Env.Load(envFilePath);
    Console.WriteLine($"[DEBUG] Loaded .env.local file");

    // Read all environment variables from .env.local
    foreach (var line in File.ReadAllLines(envFilePath))
    {
        var trimmedLine = line.Trim();
        if (string.IsNullOrWhiteSpace(trimmedLine) || trimmedLine.StartsWith("#"))
            continue;

        var parts = trimmedLine.Split('=', 2);
        if (parts.Length == 2)
        {
            var key = parts[0].Trim();
            var value = parts[1].Trim().Trim('"');
            envVars[key] = value;
        }
    }

    Console.WriteLine($"[DEBUG] Loaded {envVars.Count} environment variables");
}

// Opt-in (default OFF): set FABRIC_LOCAL_EXTERNAL_DB=true in .env.local to route
// app services at the DATABASE_URL/DIRECT_URL from .env.local (e.g. Databricks
// Lakebase or another remote Postgres) instead of the local Aspire Postgres
// container. When on, the container DATABASE_URL/DIRECT_URL override below is
// skipped and those two vars pass through from .env.local. OFF by default so no
// one's `pnpm dev` changes unless they explicitly ask for it. Local-dev only —
// in publish mode there is no container and DATABASE_URL already comes from env.
var externalDbOptIn =
    envVars.TryGetValue("FABRIC_LOCAL_EXTERNAL_DB", out var externalDbFlag)
    && externalDbFlag.Trim().ToLowerInvariant() is "true" or "1" or "yes";
var hasExternalDbUrl =
    envVars.TryGetValue("DATABASE_URL", out var externalDbUrl)
    && !string.IsNullOrWhiteSpace(externalDbUrl);
var useExternalDb = externalDbOptIn && hasExternalDbUrl;
if (externalDbOptIn && !hasExternalDbUrl)
{
    Console.WriteLine("[WARN] FABRIC_LOCAL_EXTERNAL_DB is set but .env.local has no DATABASE_URL — using the local Postgres container.");
}
else if (useExternalDb)
{
    Console.WriteLine("[DEBUG] FABRIC_LOCAL_EXTERNAL_DB=true — app services will use DATABASE_URL/DIRECT_URL from .env.local, not the local Postgres container.");
}

// Opt-in (default OFF) public tunnel for OAuth callbacks and inbound webhooks.
// Set Parameters:ngrok-domain (a reserved ngrok domain, e.g. example-org.ngrok-free.app)
// and Parameters:ngrok-auth-token in appsettings.Development.json or user-secrets.
// When both are present the AppHost runs the ngrok agent as a container, serves
// the web app through it, points NEXT_PUBLIC_SITE_URL at the tunnel so redirect
// URIs and links derived from the site URL use the public origin, and shows the
// URL on the resource in the dashboard. A reserved domain is required because
// the URL must be known before the web app starts (and OAuth providers need a
// stable callback anyway). Local-dev only — publish mode never runs a tunnel.
var ngrokDomain = builder.Configuration["Parameters:ngrok-domain"]?.Trim();
var hasNgrokAuthToken = !string.IsNullOrWhiteSpace(builder.Configuration["Parameters:ngrok-auth-token"]);
string? devTunnelUrl = null;
if (!isPublishMode && !string.IsNullOrWhiteSpace(ngrokDomain))
{
    if (!hasNgrokAuthToken)
    {
        Console.WriteLine("[WARN] Parameters:ngrok-domain is set but Parameters:ngrok-auth-token is empty — starting without a public tunnel.");
    }
    else
    {
        var tunnelHost = Regex.Replace(ngrokDomain, "^https?://", "").TrimEnd('/');
        devTunnelUrl = $"https://{tunnelHost}";
        Console.WriteLine($"[DEBUG] Public tunnel enabled — the web app will be served at {devTunnelUrl}");
    }
}

// ============================================================================
// AZURE DEPLOYMENT CONFIGURATION
// ============================================================================
// When deploying to Azure (isPublishMode = true):
// - Agents use pre-built Docker images from ACR
// - Infrastructure (DB, Redis, Qdrant) uses existing cloud services
// - Environment variables are configured in Azure Container Apps

var imageTag = Environment.GetEnvironmentVariable("IMAGE_TAG") ?? "latest";
var acrName = Environment.GetEnvironmentVariable("AZURE_CONTAINER_REGISTRY_NAME") ?? "yourregistry";

// Helper to get ACR image path for agents
string GetAgentImage(string agentName) => $"{acrName}.azurecr.io/fabric/{agentName}:{imageTag}";

// Secrets for agents (configured via azd env set or Azure Key Vault)
var agentApiKey = builder.AddParameter("agent-api-key", secret: true);
var aiTokenSecret = builder.AddParameter("ai-token-secret", secret: true);

// ============================================================================
// LOCAL DEVELOPMENT INFRASTRUCTURE
// ============================================================================
// These resources are only created for local development (isPublishMode = false)
// In production, we use:
// - Neon PostgreSQL (DATABASE_URL from env)
// - Upstash Redis (REDIS_URL from env)
// - Qdrant Cloud (QDRANT_URL from env)
// - Temporal Cloud (TEMPORAL_ADDRESS from env)

var postgresPassword = builder.AddParameter("postgres-password", secret: true);
IResourceBuilder<PostgresServerResource>? postgres = null;
IResourceBuilder<PostgresDatabaseResource>? fabricDb = null;
IResourceBuilder<RedisResource>? redis = null;
IResourceBuilder<ContainerResource>? qdrant = null;
IResourceBuilder<ContainerResource>? temporal = null;

if (!isPublishMode)
{
    // PostgreSQL Database (local only)
    // Pin to Postgres 17. Aspire 13.4.x bumped the default image to postgres:18, whose
    // Docker image refuses to open an existing v17 data cluster (major-version mismatch)
    // and also moved the data volume mount from /var/lib/postgresql/data to
    // /var/lib/postgresql. Staying on 17 matches production (Azure Flexible Server) and
    // preserves the local dev database. The image tag and the explicit legacy mount path
    // must stay together: the v17 image's default PGDATA is /var/lib/postgresql/data, so
    // the volume is mounted there (via WithVolume, not WithDataVolume) so it finds the
    // existing cluster at the volume root instead of re-initialising an empty one.
    postgres = builder.AddPostgres("postgres", password: postgresPassword, port: 5432)
        .WithImageTag("17")
        .WithEnvironment("POSTGRES_DB", "fabric")
        .WithVolume("fabric-postgres-data", "/var/lib/postgresql/data")
        .WithContainerRuntimeArgs("--label", $"com.docker.compose.project={dockerProjectName}")
        .WithContainerRuntimeArgs("--label", "com.docker.compose.service=postgres")
        .WithLifetime(ContainerLifetime.Persistent);
    fabricDb = postgres.AddDatabase("fabric-db");

    // Redis Cache (local only)
    // WithoutHttpsCertificate() disables TLS - agents use redis:// (non-TLS) connections
#pragma warning disable ASPIRECERTIFICATES001 // WithoutHttpsCertificate is experimental
    redis = builder.AddRedis("cache")
        .WithoutHttpsCertificate()
        .WithDataVolume("fabric-redis-data")
        .WithContainerRuntimeArgs("--label", $"com.docker.compose.project={dockerProjectName}")
        .WithContainerRuntimeArgs("--label", "com.docker.compose.service=cache")
        .WithLifetime(ContainerLifetime.Persistent);
#pragma warning restore ASPIRECERTIFICATES001

    // Qdrant Vector Database (local only)
    qdrant = builder.AddContainer("qdrant", "qdrant/qdrant", "v1.16.2")
        .WithHttpEndpoint(port: 6333, targetPort: 6333, name: "http")
        .WithHttpEndpoint(port: 6334, targetPort: 6334, name: "grpc")
        .WithVolume("fabric-qdrant-data", "/qdrant/storage")
        .WithContainerRuntimeArgs("--ulimit", "nofile=65535:65535")
        .WithContainerRuntimeArgs("--label", $"com.docker.compose.project={dockerProjectName}")
        .WithContainerRuntimeArgs("--label", "com.docker.compose.service=qdrant")
        .WithLifetime(ContainerLifetime.Persistent);

    // Temporal Server (local only - use Temporal Cloud in production)
    temporal = builder.AddContainer("temporal", "temporalio/auto-setup", "1.28.0")
        .WithEnvironment("DB", "postgres12")
        .WithEnvironment("DB_PORT", "5432")
        .WithEnvironment("POSTGRES_USER", "postgres")
        .WithEnvironment("POSTGRES_PWD", postgresPassword)
        .WithEnvironment("POSTGRES_SEEDS", "postgres")
        .WithEnvironment("DYNAMIC_CONFIG_FILE_PATH", "/etc/temporal-dynamic-config/dynamic-config.yaml")
        .WithBindMount(Path.GetFullPath(Path.Combine(builder.AppHostDirectory, "../../deployment/temporal")), "/etc/temporal-dynamic-config", isReadOnly: true)
        .WithEndpoint(scheme: "tcp", port: 7233, targetPort: 7233, name: "grpc", isProxied: false)
        .WaitFor(postgres)
        .WithContainerRuntimeArgs("--label", $"com.docker.compose.project={dockerProjectName}")
        .WithContainerRuntimeArgs("--label", "com.docker.compose.service=temporal")
        .WithLifetime(ContainerLifetime.Persistent);

    // Temporal UI (local only)
    var temporalUi = builder.AddContainer("temporal-ui", "temporalio/ui", "2.44.1")
        .WithEnvironment("TEMPORAL_ADDRESS", "temporal:7233")
        .WithEnvironment("TEMPORAL_CORS_ORIGINS", "http://localhost:3001")
        .WithHttpEndpoint(port: 8083, targetPort: 8080, name: "http")
        .WaitFor(temporal)
        .WithContainerRuntimeArgs("--label", $"com.docker.compose.project={dockerProjectName}")
        .WithContainerRuntimeArgs("--label", "com.docker.compose.service=temporal-ui")
        .WithLifetime(ContainerLifetime.Persistent);

    // MinIO (local only - use Vercel Blob/Azure Blob in production)
    var minioRootUser = builder.AddParameter("minio-root-user");
    var minioRootPassword = builder.AddParameter("minio-root-password", secret: true);
    var minio = builder.AddContainer("minio", "minio/minio", "latest")
        .WithEnvironment("MINIO_ROOT_USER", minioRootUser)
        .WithEnvironment("MINIO_ROOT_PASSWORD", minioRootPassword)
        // Allow browser PUT uploads from the local web app origins (workspace document
        // upload pipeline). Production buckets use per-bucket CORS rules in R2 — see
        // specs/2026-05-14-workspace-document-upload-failed-fetch/spec.md §6b and
        // infrastructure/storage/cors/workspace-documents.json.
        .WithEnvironment("MINIO_API_CORS_ALLOW_ORIGIN", "http://localhost:3001,http://localhost:3000")
        .WithHttpEndpoint(port: 9000, targetPort: 9000, name: "api")
        .WithHttpEndpoint(port: 9001, targetPort: 9001, name: "console")
        .WithVolume("fabric-minio-data", "/data")
        .WithArgs("server", "/data", "--console-address", ":9001")
        .WithContainerRuntimeArgs("--label", $"com.docker.compose.project={dockerProjectName}")
        .WithContainerRuntimeArgs("--label", "com.docker.compose.service=minio")
        .WithLifetime(ContainerLifetime.Persistent);

    // MinIO bucket initialization (creates required buckets on startup)
    var minioInit = builder.AddContainer("minio-init", "minio/mc", "latest")
        .WithEnvironment("MINIO_ROOT_USER", minioRootUser)
        .WithEnvironment("MINIO_ROOT_PASSWORD", minioRootPassword)
        .WithEntrypoint("/bin/sh")
        .WithArgs("-c", """
            echo 'Waiting for MinIO to be ready...'
            until mc alias set local http://minio:9000 $MINIO_ROOT_USER $MINIO_ROOT_PASSWORD; do
              echo 'MinIO not ready, retrying in 2s...'
              sleep 2
            done
            echo 'Creating buckets...'
            mc mb local/avatars --ignore-existing
            mc mb local/project-contexts --ignore-existing
            mc mb local/uploads --ignore-existing
            mc mb local/workspace-documents --ignore-existing
            mc mb local/chat-documents --ignore-existing
            echo 'Buckets created successfully!'
            """)
        .WaitFor(minio)
        .WithContainerRuntimeArgs("--label", $"com.docker.compose.project={dockerProjectName}")
        .WithContainerRuntimeArgs("--label", "com.docker.compose.service=minio-init");

    // ============================================================================
    // OBSERVABILITY SERVICES (Optional)
    // Local: Aspire Dashboard (via .WithOtlpExporter()) is always available
    // Optional: Jaeger, Prometheus, Grafana for production-like setup
    // Set ENABLE_FULL_OBSERVABILITY=true in .env.local to enable
    // ============================================================================

    var enableFullObservability = Environment.GetEnvironmentVariable("ENABLE_FULL_OBSERVABILITY") == "true";

    if (enableFullObservability)
    {
    // Prometheus (Metrics Collection)
    var prometheus = builder.AddContainer("prometheus", "prom/prometheus", "latest")
        .WithHttpEndpoint(port: 9090, targetPort: 9090, name: "http")
        .WithBindMount("../../monitoring/prometheus/prometheus.yml", "/etc/prometheus/prometheus.yml")
        .WithBindMount("../../monitoring/prometheus/alerts", "/etc/prometheus/alerts")
        .WithVolume("fabric-prometheus-data", "/prometheus")
        .WithArgs(
            "--config.file=/etc/prometheus/prometheus.yml",
            "--storage.tsdb.path=/prometheus",
            "--web.console.libraries=/usr/share/prometheus/console_libraries",
            "--web.console.templates=/usr/share/prometheus/consoles",
            "--web.enable-lifecycle")
        .WithContainerRuntimeArgs("--label", $"com.docker.compose.project={dockerProjectName}")
        .WithContainerRuntimeArgs("--label", "com.docker.compose.service=prometheus")
        .WithLifetime(ContainerLifetime.Persistent);

    // Jaeger (Distributed Tracing)
    var jaeger = builder.AddContainer("jaeger", "jaegertracing/all-in-one", "latest")
        .WithEnvironment("COLLECTOR_ZIPKIN_HOST_PORT", ":9411")
        .WithEnvironment("COLLECTOR_OTLP_ENABLED", "true")
        .WithHttpEndpoint(port: 16686, targetPort: 16686, name: "ui")
        .WithHttpEndpoint(port: 4318, targetPort: 4318, name: "otlp-http")
        .WithHttpEndpoint(port: 4317, targetPort: 4317, name: "otlp-grpc")
        .WithHttpEndpoint(port: 5778, targetPort: 5778, name: "configs")
        .WithHttpEndpoint(port: 14268, targetPort: 14268, name: "jaeger-thrift")
        .WithHttpEndpoint(port: 14250, targetPort: 14250, name: "model-proto")
        .WithHttpEndpoint(port: 9411, targetPort: 9411, name: "zipkin")
        .WithContainerRuntimeArgs("--label", $"com.docker.compose.project={dockerProjectName}")
        .WithContainerRuntimeArgs("--label", "com.docker.compose.service=jaeger")
        .WithLifetime(ContainerLifetime.Persistent);

    // Grafana (Metrics Visualization)
    var grafanaAdminPassword = builder.AddParameter("grafana-admin-password", secret: true);
    var grafana = builder.AddContainer("grafana", "grafana/grafana", "latest")
        .WithHttpEndpoint(port: 3200, targetPort: 3000, name: "http")
        .WithEnvironment("GF_SECURITY_ADMIN_USER", "admin")
        .WithEnvironment("GF_SECURITY_ADMIN_PASSWORD", grafanaAdminPassword)
        .WithEnvironment("GF_USERS_ALLOW_SIGN_UP", "false")
        .WithEnvironment("GF_SERVER_ROOT_URL", "http://localhost:3200")
        .WithEnvironment("GF_INSTALL_PLUGINS", "grafana-piechart-panel")
        .WithBindMount("../../monitoring/grafana/dashboards", "/etc/grafana/dashboards")
        .WithBindMount("../../monitoring/grafana/provisioning", "/etc/grafana/provisioning")
        .WithVolume("fabric-grafana-data", "/var/lib/grafana")
        .WaitFor(prometheus)
        .WaitFor(jaeger)
        .WithContainerRuntimeArgs("--label", $"com.docker.compose.project={dockerProjectName}")
        .WithContainerRuntimeArgs("--label", "com.docker.compose.service=grafana")
        .WithLifetime(ContainerLifetime.Persistent);

    // Node Exporter (System Metrics - Linux only)
    // Note: node-exporter requires Linux /proc and /sys filesystems which don't exist on macOS/Windows
    // It's only created on Linux systems where these filesystems are available
    if (System.Runtime.InteropServices.RuntimeInformation.IsOSPlatform(System.Runtime.InteropServices.OSPlatform.Linux))
    {
        var nodeExporter = builder.AddContainer("node-exporter", "prom/node-exporter", "latest")
            .WithHttpEndpoint(port: 9100, targetPort: 9100, name: "http")
            .WithBindMount("/proc", "/host/proc", isReadOnly: true)
            .WithBindMount("/sys", "/host/sys", isReadOnly: true)
            .WithBindMount("/", "/rootfs", isReadOnly: true)
            .WithArgs(
                "--path.procfs=/host/proc",
                "--path.sysfs=/host/sys",
                "--path.rootfs=/rootfs",
                "--collector.filesystem.mount-points-exclude=^/(sys|proc|dev|host|etc)($$|/)")
            .WithContainerRuntimeArgs("--label", $"com.docker.compose.project={dockerProjectName}")
            .WithContainerRuntimeArgs("--label", "com.docker.compose.service=node-exporter")
            .WithLifetime(ContainerLifetime.Persistent);
    }
    } // end if (enableFullObservability)
}

// ============================================================================
// DATABASE RESOURCE COMMANDS (local development only)
// ============================================================================
// Fizzy #2373. Two dashboard buttons on the `postgres` resource for the chores
// that otherwise need a second terminal: running a seed script and re-applying
// the RLS policies.
//
// Both run on the host via pnpm, so they hit whatever DATABASE_URL/DIRECT_URL
// .env.local points at — the local Aspire Postgres container unless
// FABRIC_LOCAL_EXTERNAL_DB is on, in which case it is the external database
// configured there. Identical to running the same script from a terminal; the
// commands are attached to `postgres` because that is where a developer looks
// for them, not because they are scoped to that container.
if (!isPublishMode && postgres is not null)
{
    // The seed choices are read from packages/database/package.json at app-host
    // startup so a newly added seed script shows up without editing this file.
    // The `:staging` / `:prod` variants load .env.staging / .env.production and
    // are deliberately never offered from the dashboard.
    List<string> ReadLocalSeedScripts()
    {
        var discovered = new List<string>();
        var packageJsonPath = Path.Combine(repoRoot, "packages", "database", "package.json");

        try
        {
            using var packageJson = JsonDocument.Parse(File.ReadAllText(packageJsonPath));
            if (packageJson.RootElement.TryGetProperty("scripts", out var scripts)
                && scripts.ValueKind == JsonValueKind.Object)
            {
                foreach (var script in scripts.EnumerateObject())
                {
                    var scriptName = script.Name;
                    if (scriptName != "seed" && !scriptName.StartsWith("seed:", StringComparison.Ordinal))
                    {
                        continue;
                    }
                    if (scriptName.EndsWith(":staging", StringComparison.Ordinal)
                        || scriptName.EndsWith(":prod", StringComparison.Ordinal))
                    {
                        continue;
                    }
                    discovered.Add(scriptName);
                }
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[WARN] Could not read seed scripts from {packageJsonPath}: {ex.Message}");
        }

        discovered.Sort(StringComparer.Ordinal);
        return discovered;
    }

    var seedScripts = ReadLocalSeedScripts();
    var seedScriptOptions = seedScripts
        .Select(scriptName => new KeyValuePair<string, string>(scriptName, scriptName))
        .ToArray();

    postgres.WithCommand(
        "seed",
        "Run seed",
        async context =>
        {
            var script = context.Arguments.GetString("script");
            if (string.IsNullOrWhiteSpace(script) || !seedScripts.Contains(script))
            {
                return CommandResults.Failure(
                    $"'{script}' is not one of the local seed scripts in packages/database/package.json.");
            }

            var (exitCode, tail, _) = await RunHostCommandAsync(
                context,
                pnpmExecutable,
                ["--filter", "@repo/database", script],
                repoRoot);

            return exitCode == 0
                ? CommandResults.Success($"`pnpm --filter @repo/database {script}` completed.")
                : CommandResults.Failure(
                    $"`pnpm --filter @repo/database {script}` exited with code {exitCode}.{Environment.NewLine}{tail}");
        },
        new CommandOptions
        {
            Description = "Runs one of the local seed scripts from packages/database on the host.",
            IconName = "DatabaseArrowUp",
            ConfirmationMessage = "Run the selected seed script against the database that .env.local points at?",
            Arguments =
            [
                new InteractionInput
                {
                    Name = "script",
                    Label = "Seed script",
                    InputType = InputType.Choice,
                    Options = seedScriptOptions,
                    Required = true,
                },
            ],
            // Belt and braces: the dashboard restricts the choice, but the CLI and
            // MCP paths can submit an arbitrary string for a Choice argument.
            ValidateArguments = validationContext =>
            {
                var script = validationContext.Inputs.GetString("script");
                if (string.IsNullOrWhiteSpace(script) || !seedScripts.Contains(script))
                {
                    validationContext.AddValidationError(
                        "script",
                        "Choose one of the local seed scripts declared in packages/database/package.json.");
                }
                return Task.CompletedTask;
            },
            Progress = new CommandProgressOptions
            {
                Title = "Run seed",
                Message = "Running the selected seed script on the host...",
            },
        });

    postgres.WithCommand(
        "apply-rls",
        "Apply RLS policies",
        async context =>
        {
            var (exitCode, tail, _) = await RunHostCommandAsync(
                context,
                pnpmExecutable,
                ["--filter", "@repo/database", "apply:rls"],
                repoRoot);

            return exitCode == 0
                ? CommandResults.Success("`pnpm --filter @repo/database apply:rls` completed.")
                : CommandResults.Failure(
                    $"`pnpm --filter @repo/database apply:rls` exited with code {exitCode}.{Environment.NewLine}{tail}");
        },
        new CommandOptions
        {
            Description = "Runs `pnpm --filter @repo/database apply:rls` on the host to re-apply the row-level security policies.",
            IconName = "ShieldCheckmark",
            ConfirmationMessage = "Re-apply the RLS policies to the database that .env.local points at?",
            Progress = new CommandProgressOptions
            {
                Title = "Apply RLS policies",
                Message = "Applying row-level security policies...",
            },
        });
}

// ============================================================================
// LANGGRAPH AGENTS
// ============================================================================
// Port Assignments:
// - document_generator: 8124
// - project_document_generator: 8125
// - task_planner: 8126
// - story_breakdown: 8127
// - data_analyst: 8130
// - api_agent: 8131
// - prompt_enhancer: 8134
// - backlog_updater: 8135
// - custom-agent-runtime: 8240

// Platform detection for cross-platform development support
var isLinux = System.Runtime.InteropServices.RuntimeInformation.IsOSPlatform(System.Runtime.InteropServices.OSPlatform.Linux);
var isMacOS = System.Runtime.InteropServices.RuntimeInformation.IsOSPlatform(System.Runtime.InteropServices.OSPlatform.OSX);

Console.WriteLine($"[DEBUG] Platform: {(isLinux ? "Linux" : isMacOS ? "macOS" : "Other")}");

// On Linux in local development, the web app runs as an NpmApp on the host (not in a container),
// so Docker containers can't resolve the hostname "web". Use host.docker.internal instead.
// In production (publish mode), agents use Azure Container Apps networking, so this isn't needed.
var runtimeApiUrl = (!isPublishMode && isLinux) ? "http://host.docker.internal:3001" : "http://web:3001";

// Retry script for installing dependencies (macOS only - needs Linux binaries in container)
// NOTE: On macOS, the host node_modules contains darwin binaries but containers need linux binaries.
// We use a Docker volume to shadow the entire node_modules and pnpm store, then do a fresh install.
// The volume persists across container restarts so subsequent startups are fast.
// Uses a lock file to prevent multiple containers from installing simultaneously.
const string agentRetryScriptMacOS = """
    retry_count=0
    max_retries=3
    cd /app
    
    # Check if already installed
    if [ -f /app/node_modules/.linux-installed ]; then
      echo 'Linux dependencies already installed, skipping install...'
    else
      # Try to acquire lock (only one container should install)
      lockfile=/app/node_modules/.install-lock
      mkdir -p /app/node_modules
      
      if mkdir "$lockfile" 2>/dev/null; then
        echo 'Acquired install lock, installing dependencies for Linux platform...'
        rm -rf /app/node_modules/.pnpm /app/node_modules/.modules.yaml
        until corepack enable && pnpm install --frozen-lockfile; do
          retry_count=$((retry_count + 1))
          if [ $retry_count -ge $max_retries ]; then
            echo "Failed to install dependencies after $max_retries attempts"
            rmdir "$lockfile" 2>/dev/null || true
            exit 1
          fi
          echo "Retry $retry_count/$max_retries: waiting 10s before retry..."
          sleep 10
        done
        touch /app/node_modules/.linux-installed
        rmdir "$lockfile" 2>/dev/null || true
        echo 'Install complete!'
      else
        echo 'Another container is installing, waiting...'
        while [ ! -f /app/node_modules/.linux-installed ]; do
          sleep 5
          echo 'Still waiting for install to complete...'
        done
        echo 'Install complete, continuing...'
      fi
    fi
    """;

// Simple startup script for Linux (host node_modules already has Linux binaries)
// No reinstallation needed - just enable corepack and run
// NOTE: We force rebuild on first run after switching from macOS builds because
// the existing dist/ may have been built with macOS volume mounting (different bundling)
const string agentRetryScriptLinux = """
    cd /app
    echo 'Linux host detected - using host node_modules directly...'
    corepack enable
    """;

// Select the appropriate script based on platform
var agentRetryScript = isLinux ? agentRetryScriptLinux : agentRetryScriptMacOS;

// Helper extension to conditionally add node_modules volume (macOS only)
// On Linux, the host node_modules already has Linux binaries, so no volume shadowing needed
IResourceBuilder<ContainerResource> AddNodeModulesVolume(IResourceBuilder<ContainerResource> container)
{
    if (!isLinux)
    {
        // macOS/Windows: Shadow host node_modules with a Docker volume containing Linux binaries
        return container.WithVolume("fabric-linux-node-modules", "/app/node_modules");
    }
    // Linux: Use host node_modules directly (already has correct binaries)
    return container;
}

// Helper to add host.docker.internal mapping on Linux in local development
// On Linux (without Docker Desktop), host.docker.internal requires --add-host flag.
// Only needed locally — in production (publish mode), Azure Container Apps handles networking.
IResourceBuilder<ContainerResource> AddHostGateway(IResourceBuilder<ContainerResource> container)
{
    if (!isPublishMode && isLinux)
    {
        return container.WithContainerRuntimeArgs("--add-host", "host.docker.internal:host-gateway");
    }
    return container;
}

// ============================================================================
// DASHBOARD RESOURCE COMMAND HELPERS (local development only)
// ============================================================================
// Fizzy #2373. These back the custom commands the dashboard shows on a resource.
// Every one starts a process on the *host*: either the pnpm script directly (the
// database commands) or the container runtime CLI exec'ing into a running agent
// container (the rebuild command).

// Runs a host process, streaming each output line into the resource's console log
// and keeping a bounded tail so a failure result can carry the last few lines.
// Cancelling the command (dashboard progress dialog, or app-host shutdown) kills
// the process tree rather than leaving an orphaned build behind.
//
// captureStdout additionally retains every stdout line for callers that need to
// read the output back (resolving a container id). It stays off for builds, whose
// output can run to thousands of lines that nothing reads.
async Task<(int ExitCode, string Tail, IReadOnlyList<string> StdoutLines)> RunHostCommandAsync(
    ExecuteCommandContext ctx,
    string fileName,
    string[] arguments,
    string workingDirectory,
    bool captureStdout = false)
{
    const int tailCapacity = 40;

    var startInfo = new ProcessStartInfo
    {
        FileName = fileName,
        WorkingDirectory = workingDirectory,
        UseShellExecute = false,
        RedirectStandardOutput = true,
        RedirectStandardError = true,
        CreateNoWindow = true,
    };
    foreach (var argument in arguments)
    {
        startInfo.ArgumentList.Add(argument);
    }

    var tail = new Queue<string>(tailCapacity);
    var stdoutLines = new List<string>();
    void Capture(string? line, bool isStdout)
    {
        if (line is null)
        {
            return;
        }

        ctx.Logger.LogInformation("{Line}", line);
        lock (tail)
        {
            if (tail.Count == tailCapacity)
            {
                tail.Dequeue();
            }
            tail.Enqueue(line);

            if (captureStdout && isStdout)
            {
                stdoutLines.Add(line);
            }
        }
    }

    using var process = new Process { StartInfo = startInfo };
    process.OutputDataReceived += (_, e) => Capture(e.Data, isStdout: true);
    process.ErrorDataReceived += (_, e) => Capture(e.Data, isStdout: false);

    ctx.Logger.LogInformation(
        "$ {FileName} {Arguments}   (cwd: {WorkingDirectory})",
        fileName,
        string.Join(' ', arguments),
        workingDirectory);

    process.Start();
    process.BeginOutputReadLine();
    process.BeginErrorReadLine();

    try
    {
        await process.WaitForExitAsync(ctx.CancellationToken);
    }
    catch (OperationCanceledException)
    {
        try
        {
            process.Kill(entireProcessTree: true);
        }
        catch (Exception ex)
        {
            ctx.Logger.LogWarning("Could not kill {FileName} after cancellation: {Message}", fileName, ex.Message);
        }
        throw;
    }

    string tailText;
    string[] capturedStdout;
    lock (tail)
    {
        tailText = string.Join(Environment.NewLine, tail);
        capturedStdout = stdoutLines.ToArray();
    }

    return (process.ExitCode, tailText, capturedStdout);
}

// Adds the "Rebuild & restart" command to a dev-mode agent container. The dev
// entrypoint only runs `pnpm build` when dist/ is missing, so picking up a source
// change otherwise means a build followed by a manual restart; this collapses
// that into one dashboard button.
//
// The build runs *inside* the container rather than on the host. The container's
// own first-run build executes as root against the bind-mounted checkout, so on
// Linux every agent's dist/ ends up root-owned and a host-side tsup build cannot
// unlink the previous chunks (EACCES). Building where the entrypoint builds keeps
// the ownership consistent.
IResourceBuilder<ContainerResource> WithAgentRebuildCommand(IResourceBuilder<ContainerResource> agent)
{
    // The model name ("task-planner") is what the label and the agents/langchain
    // directory carry. context.ResourceName is the runtime instance id
    // ("task-planner-<suffix>"), which is only right for addressing the instance
    // itself — the restart call below.
    var resourceName = agent.Resource.Name;

    return agent.WithCommand(
        "rebuild",
        "Rebuild & restart",
        async context =>
        {
            // Resolve the container id by two filters that must both hold: the
            // compose-service label the AppHost stamps on every dev-mode agent
            // container (the model resource name), and the container name, which
            // for an Aspire container is the instance id in context.ResourceName
            // ("task-planner-<suffix>", where the suffix is stable per AppHost
            // checkout). The label alone is not enough — a persistent container
            // left behind by another checkout of this repo carries the same label —
            // so the lookup fails closed unless exactly one container matches.
            // (ResourceNotificationService.WaitForResourceAsync keyed by
            // context.ResourceName never completes, because that is the instance
            // id, not a model resource name.)
            context.Logger.LogInformation(
                "Resolving the running container for {ResourceName}...", context.ResourceName);

            var label = $"com.docker.compose.service={resourceName}";
            var namePattern = $"^/?{Regex.Escape(context.ResourceName)}$";
            var (lookupExitCode, lookupTail, lookupStdout) = await RunHostCommandAsync(
                context,
                containerRuntimeExecutable,
                [
                    "ps", "-q",
                    "--filter", $"label={label}",
                    "--filter", $"name={namePattern}",
                    "--filter", "status=running",
                ],
                repoRoot,
                captureStdout: true);

            if (lookupExitCode != 0)
            {
                return CommandResults.Failure(
                    $"Could not list containers for {context.ResourceName} (exit code {lookupExitCode}).{Environment.NewLine}{lookupTail}");
            }

            var containerIds = lookupStdout
                .Select(line => line.Trim())
                .Where(line => line.Length > 0)
                .ToArray();

            if (containerIds.Length != 1)
            {
                return CommandResults.Failure(containerIds.Length == 0
                    ? $"No running container named {context.ResourceName} with label {label}; is the resource running?"
                    : $"Expected exactly one running container named {context.ResourceName} with label {label}, found {containerIds.Length}: {string.Join(", ", containerIds)}. Remove the stale ones and retry.");
            }

            var containerId = containerIds[0];

            // The agent directory under agents/langchain matches the resource name
            // for every agent that has this command.
            context.Logger.LogInformation(
                "Building {ResourceName} in container {ContainerId}...", resourceName, containerId);

            var (exitCode, tail, _) = await RunHostCommandAsync(
                context,
                containerRuntimeExecutable,
                [
                    "exec",
                    containerId,
                    "sh",
                    "-c",
                    $"corepack enable && cd /app/agents/langchain/{resourceName} && pnpm build",
                ],
                repoRoot);

            if (exitCode != 0)
            {
                return CommandResults.Failure(
                    $"`pnpm build` inside {resourceName} exited with code {exitCode}.{Environment.NewLine}{tail}");
            }

            context.Logger.LogInformation("Restarting {ResourceName}...", resourceName);

            var commandService = context.Services.GetRequiredService<ResourceCommandService>();
            var restart = await commandService.ExecuteCommandAsync(
                context.ResourceName, // instance id: the restart targets this instance
                KnownResourceCommands.RestartCommand,
                context.CancellationToken);

            if (restart.Canceled)
            {
                return CommandResults.Canceled();
            }

            if (!restart.Success)
            {
                return CommandResults.Failure(
                    $"Rebuilt {resourceName}, but restarting it failed: {restart.Message ?? "no error message"}");
            }

            return CommandResults.Success($"Rebuilt and restarted {resourceName}.");
        },
        new CommandOptions
        {
            Description = "Runs `pnpm build` inside the container, then restarts it so the new bundle is picked up.",
            IconName = "ArrowSync",
            UpdateState = stateContext =>
                stateContext.ResourceSnapshot.State?.Text == KnownResourceStates.Running
                    ? ResourceCommandState.Enabled
                    : ResourceCommandState.Disabled,
            Progress = new CommandProgressOptions
            {
                Title = "Rebuild & restart",
                Message = "Running `pnpm build` inside the container, then restarting it...",
            },
        });
}

// ============================================================================
// WEAVE READERS AGENT
// ============================================================================

IResourceBuilder<ContainerResource> weaveReaders;

if (isPublishMode)
{
    weaveReaders = builder.AddContainer("weave-readers", GetAgentImage("weave-readers"))
        .WithHttpEndpoint(port: 8140, targetPort: 8140, name: "http")
        .WithEnvironment("NODE_ENV", "production")
        .WithEnvironment("PORT", "8140")
        .WithEnvironment("HOST", "0.0.0.0")
        .WithEnvironment("AGENT_API_KEY", agentApiKey)
        .WithEnvironment("AI_TOKEN_SECRET", aiTokenSecret)
        .WithHttpHealthCheck("/health");
}
else
{
    var weaveReadersBase = builder.AddContainer("weave-readers", "node", "22-alpine")
        .WithHttpEndpoint(port: 8140, targetPort: 8140, name: "http")
        .WithBindMount("../../", "/app");
    weaveReaders = AddHostGateway(AddNodeModulesVolume(weaveReadersBase))
        .WithEntrypoint("/bin/sh")
        .WithArgs("-c", $"{agentRetryScript} && corepack enable && cd /app/agents/langchain/weave-readers && if [ ! -f dist/index.js ]; then echo 'Building weave-readers...' && pnpm build; fi && echo 'Starting weave-readers...' && node dist/index.js")
        .WithEnvironment("NODE_ENV", "development")
        .WithEnvironment("PORT", "8140")
        .WithEnvironment("HOST", "0.0.0.0")
        .WithEnvironment("RUNTIME_API_URL", runtimeApiUrl)
        .WithOtlpExporter()
        .WithEnvironment("NODE_TLS_REJECT_UNAUTHORIZED", "0")
        .WithEnvironment(context =>
        {
            context.EnvironmentVariables["REDIS_URI"] = ReferenceExpression.Create(
                $"redis://{redis!.Resource.PrimaryEndpoint.Property(EndpointProperty.Host)}:{redis!.Resource.PrimaryEndpoint.Property(EndpointProperty.Port)}");

            if (postgres != null && !useExternalDb)
            {
                context.EnvironmentVariables["DATABASE_URL"] = ReferenceExpression.Create(
                    $"postgresql://postgres:postgres@{postgres.Resource.PrimaryEndpoint.Property(EndpointProperty.Host)}:{postgres.Resource.PrimaryEndpoint.Property(EndpointProperty.Port)}/fabric");
                context.EnvironmentVariables["DIRECT_URL"] = ReferenceExpression.Create(
                    $"postgresql://postgres:postgres@{postgres.Resource.PrimaryEndpoint.Property(EndpointProperty.Host)}:{postgres.Resource.PrimaryEndpoint.Property(EndpointProperty.Port)}/fabric");
            }
        })
        .WithReference(fabricDb!)
        .WithReference(redis!)
        .WaitFor(fabricDb!)
        .WaitFor(redis!)
        .WaitFor(qdrant!)
        .WithHttpHealthCheck("/health")
        .WithContainerRuntimeArgs("--label", $"com.docker.compose.project={dockerProjectName}")
        .WithContainerRuntimeArgs("--label", "com.docker.compose.service=weave-readers")
        .WithLifetime(ContainerLifetime.Persistent);

    foreach (var (key, value) in envVars)
    {
        if (!useExternalDb && (key == "DATABASE_URL" || key == "DIRECT_URL")) continue;
        if (key.StartsWith("OTEL_")) continue;
        weaveReaders = weaveReaders.WithEnvironment(key, value);
    }
}

// ============================================================================
// WEAVE SHUTTLE AGENT
// ============================================================================

IResourceBuilder<ContainerResource> weaveShuttle;

if (isPublishMode)
{
    weaveShuttle = builder.AddContainer("weave-shuttle", GetAgentImage("weave-shuttle"))
        .WithHttpEndpoint(port: 8141, targetPort: 8141, name: "http")
        .WithEnvironment("NODE_ENV", "production")
        .WithEnvironment("PORT", "8141")
        .WithEnvironment("HOST", "0.0.0.0")
        .WithEnvironment("AGENT_API_KEY", agentApiKey)
        .WithEnvironment("AI_TOKEN_SECRET", aiTokenSecret)
        .WithHttpHealthCheck("/health");
}
else
{
    var weaveShuttleBase = builder.AddContainer("weave-shuttle", "node", "22-alpine")
        .WithHttpEndpoint(port: 8141, targetPort: 8141, name: "http")
        .WithBindMount("../../", "/app");
    weaveShuttle = AddHostGateway(AddNodeModulesVolume(weaveShuttleBase))
        .WithEntrypoint("/bin/sh")
        .WithArgs("-c", $"{agentRetryScript} && corepack enable && cd /app/agents/langchain/weave-shuttle && if [ ! -f dist/index.js ]; then echo 'Building weave-shuttle...' && pnpm build; fi && echo 'Starting weave-shuttle...' && node dist/index.js")
        .WithEnvironment("NODE_ENV", "development")
        .WithEnvironment("PORT", "8141")
        .WithEnvironment("HOST", "0.0.0.0")
        .WithEnvironment("RUNTIME_API_URL", runtimeApiUrl)
        .WithOtlpExporter()
        .WithEnvironment("NODE_TLS_REJECT_UNAUTHORIZED", "0")
        .WithEnvironment(context =>
        {
            context.EnvironmentVariables["REDIS_URI"] = ReferenceExpression.Create(
                $"redis://{redis!.Resource.PrimaryEndpoint.Property(EndpointProperty.Host)}:{redis!.Resource.PrimaryEndpoint.Property(EndpointProperty.Port)}");
        })
        .WithReference(redis!)
        .WaitFor(redis!)
        .WaitFor(qdrant!)
        .WithHttpHealthCheck("/health")
        .WithContainerRuntimeArgs("--label", $"com.docker.compose.project={dockerProjectName}")
        .WithContainerRuntimeArgs("--label", "com.docker.compose.service=weave-shuttle")
        .WithLifetime(ContainerLifetime.Persistent);

    foreach (var (key, value) in envVars)
    {
        if (!useExternalDb && (key == "DATABASE_URL" || key == "DIRECT_URL")) continue;
        if (key.StartsWith("OTEL_")) continue;
        weaveShuttle = weaveShuttle.WithEnvironment(key, value);
    }
}

// ============================================================================
// WEAVE PLANNERS AGENT
// ============================================================================

IResourceBuilder<ContainerResource> weavePlanners;

if (isPublishMode)
{
    weavePlanners = builder.AddContainer("weave-planners", GetAgentImage("weave-planners"))
        .WithHttpEndpoint(port: 8142, targetPort: 8142, name: "http")
        .WithEnvironment("NODE_ENV", "production")
        .WithEnvironment("PORT", "8142")
        .WithEnvironment("HOST", "0.0.0.0")
        .WithEnvironment("AGENT_API_KEY", agentApiKey)
        .WithEnvironment("AI_TOKEN_SECRET", aiTokenSecret)
        .WithEnvironment("WEAVE_READERS_URL", "http://weave-readers:8140")
        .WithHttpHealthCheck("/health");
}
else
{
    var weavePlannersBase = builder.AddContainer("weave-planners", "node", "22-alpine")
        .WithHttpEndpoint(port: 8142, targetPort: 8142, name: "http")
        .WithBindMount("../../", "/app");
    weavePlanners = AddHostGateway(AddNodeModulesVolume(weavePlannersBase))
        .WithEntrypoint("/bin/sh")
        .WithArgs("-c", $"{agentRetryScript} && corepack enable && cd /app/agents/langchain/weave-planners && if [ ! -f dist/index.js ]; then echo 'Building weave-planners...' && pnpm build; fi && echo 'Starting weave-planners...' && node dist/index.js")
        .WithEnvironment("NODE_ENV", "development")
        .WithEnvironment("PORT", "8142")
        .WithEnvironment("HOST", "0.0.0.0")
        .WithEnvironment("RUNTIME_API_URL", runtimeApiUrl)
        .WithEnvironment("WEAVE_READERS_URL", "http://weave-readers:8140")
        .WithOtlpExporter()
        .WithEnvironment("NODE_TLS_REJECT_UNAUTHORIZED", "0")
        .WithEnvironment(context =>
        {
            context.EnvironmentVariables["REDIS_URI"] = ReferenceExpression.Create(
                $"redis://{redis!.Resource.PrimaryEndpoint.Property(EndpointProperty.Host)}:{redis!.Resource.PrimaryEndpoint.Property(EndpointProperty.Port)}");

            if (postgres != null && !useExternalDb)
            {
                context.EnvironmentVariables["DATABASE_URL"] = ReferenceExpression.Create(
                    $"postgresql://postgres:postgres@{postgres.Resource.PrimaryEndpoint.Property(EndpointProperty.Host)}:{postgres.Resource.PrimaryEndpoint.Property(EndpointProperty.Port)}/fabric");
                context.EnvironmentVariables["DIRECT_URL"] = ReferenceExpression.Create(
                    $"postgresql://postgres:postgres@{postgres.Resource.PrimaryEndpoint.Property(EndpointProperty.Host)}:{postgres.Resource.PrimaryEndpoint.Property(EndpointProperty.Port)}/fabric");
            }
        })
        .WithReference(fabricDb!)
        .WithReference(redis!)
        .WaitFor(fabricDb!)
        .WaitFor(redis!)
        .WaitFor(qdrant!)
        .WaitFor(weaveReaders)
        .WithHttpHealthCheck("/health")
        .WithContainerRuntimeArgs("--label", $"com.docker.compose.project={dockerProjectName}")
        .WithContainerRuntimeArgs("--label", "com.docker.compose.service=weave-planners")
        .WithLifetime(ContainerLifetime.Persistent);

    foreach (var (key, value) in envVars)
    {
        if (!useExternalDb && (key == "DATABASE_URL" || key == "DIRECT_URL")) continue;
        if (key.StartsWith("OTEL_")) continue;
        weavePlanners = weavePlanners.WithEnvironment(key, value);
    }
}

// ============================================================================
// DOCUMENT GENERATOR AGENT
// ============================================================================

IResourceBuilder<ContainerResource> documentGenerator;

if (isPublishMode)
{
    // Production: Pre-built image, env vars from Azure Container Apps
    documentGenerator = builder.AddContainer("document-generator", GetAgentImage("document-generator"))
        .WithHttpEndpoint(port: 8124, targetPort: 8124, name: "http")
        .WithEnvironment("NODE_ENV", "production")
        .WithEnvironment("PORT", "8124")
        .WithEnvironment("HOST", "0.0.0.0")
        .WithEnvironment("AGENT_API_KEY", agentApiKey)
        .WithEnvironment("AI_TOKEN_SECRET", aiTokenSecret)
        .WithHttpHealthCheck("/health");
}
else
{
    // Development: Bind mount with hot reload
    // NOTE: On macOS, we use a Docker volume to shadow node_modules for cross-platform compatibility.
    // This allows the container to have Linux-native binaries while the host keeps macOS binaries.
    // On Linux, the host node_modules already has correct binaries, so we skip the volume.
    var docGenBase = builder.AddContainer("document-generator", "node", "22-alpine")
        .WithHttpEndpoint(port: 8124, targetPort: 8124, name: "http")
        .WithBindMount("../../", "/app");
    documentGenerator = AddHostGateway(AddNodeModulesVolume(docGenBase))
        .WithEntrypoint("/bin/sh")
        .WithArgs("-c", $"{agentRetryScript} && corepack enable && cd /app/agents/langchain/document-generator && if [ ! -f dist/unified-server.js ]; then echo 'Building document-generator...' && pnpm build; fi && echo 'Starting Unified Server (AG-UI + A2A)...' && node dist/unified-server.js")
        .WithEnvironment("NODE_ENV", "development")
        .WithEnvironment("PORT", "8124")
        .WithEnvironment("HOST", "0.0.0.0")
        .WithEnvironment("RUNTIME_API_URL", runtimeApiUrl)
        .WithOtlpExporter()
        .WithEnvironment("NODE_TLS_REJECT_UNAUTHORIZED", "0") // Accept Aspire Dashboard's self-signed cert
        .WithEnvironment(context =>
        {
            context.EnvironmentVariables["REDIS_URI"] = ReferenceExpression.Create(
                $"redis://{redis!.Resource.PrimaryEndpoint.Property(EndpointProperty.Host)}:{redis!.Resource.PrimaryEndpoint.Property(EndpointProperty.Port)}");
        })
        .WithReference(redis!)
        .WaitFor(redis!)
        .WaitFor(qdrant!)
        .WithHttpHealthCheck("/health")
        .WithContainerRuntimeArgs("--label", $"com.docker.compose.project={dockerProjectName}")
        .WithContainerRuntimeArgs("--label", "com.docker.compose.service=document-generator")
        .WithLifetime(ContainerLifetime.Persistent);

    foreach (var (key, value) in envVars)
    {
        // Skip keys that are set explicitly above or need container-specific values
        // Skip OTEL_ keys - WithOtlpExporter() injects the correct Aspire Dashboard endpoint
        if (!useExternalDb && (key == "DATABASE_URL" || key == "DIRECT_URL")) continue;
        if (key.StartsWith("OTEL_")) continue;
        documentGenerator = documentGenerator.WithEnvironment(key, value);
    }
}

// ============================================================================
// PROJECT DOCUMENT GENERATOR AGENT
// ============================================================================

IResourceBuilder<ContainerResource> projectDocumentGenerator;

if (isPublishMode)
{
    projectDocumentGenerator = builder.AddContainer("project-document-generator", GetAgentImage("project-document-generator"))
        .WithHttpEndpoint(port: 8125, targetPort: 8125, name: "http")
        .WithEnvironment("NODE_ENV", "production")
        .WithEnvironment("PORT", "8125")
        .WithEnvironment("HOST", "0.0.0.0")
        .WithEnvironment("AGENT_API_KEY", agentApiKey)
        .WithEnvironment("AI_TOKEN_SECRET", aiTokenSecret)
        .WithHttpHealthCheck("/health");
}
else
{
    var projDocGenBase = builder.AddContainer("project-document-generator", "node", "22-alpine")
        .WithHttpEndpoint(port: 8125, targetPort: 8125, name: "http")
        .WithBindMount("../../", "/app");
    projectDocumentGenerator = AddHostGateway(AddNodeModulesVolume(projDocGenBase))
        .WithEntrypoint("/bin/sh")
        .WithArgs("-c", $"{agentRetryScript} && corepack enable && cd /app/agents/langchain/project-document-generator && if [ ! -f dist/unified-server.js ]; then echo 'Building project-document-generator...' && pnpm build; fi && echo 'Starting Unified Server (AG-UI + A2A)...' && node dist/unified-server.js")
        .WithEnvironment("NODE_ENV", "development")
        .WithEnvironment("PORT", "8125")
        .WithEnvironment("HOST", "0.0.0.0")
        .WithEnvironment("RUNTIME_API_URL", runtimeApiUrl)

        .WithOtlpExporter()
        .WithEnvironment("NODE_TLS_REJECT_UNAUTHORIZED", "0") // Accept Aspire Dashboard's self-signed cert
        .WithEnvironment(context =>
        {
            context.EnvironmentVariables["REDIS_URI"] = ReferenceExpression.Create(
                $"redis://{redis!.Resource.PrimaryEndpoint.Property(EndpointProperty.Host)}:{redis!.Resource.PrimaryEndpoint.Property(EndpointProperty.Port)}");
        })
        .WithReference(redis!)
        .WaitFor(redis!)
        .WaitFor(qdrant!)
        .WithHttpHealthCheck("/health")
        .WithContainerRuntimeArgs("--label", $"com.docker.compose.project={dockerProjectName}")
        .WithContainerRuntimeArgs("--label", "com.docker.compose.service=project-document-generator")
        .WithLifetime(ContainerLifetime.Persistent);

    foreach (var (key, value) in envVars)
    {
        if (!useExternalDb && (key == "DATABASE_URL" || key == "DIRECT_URL")) continue;
        if (key.StartsWith("OTEL_")) continue;
        projectDocumentGenerator = projectDocumentGenerator.WithEnvironment(key, value);
    }
}

// ============================================================================
// TASK PLANNER AGENT
// ============================================================================

IResourceBuilder<ContainerResource> taskPlanner;

if (isPublishMode)
{
    taskPlanner = builder.AddContainer("task-planner", GetAgentImage("task-planner"))
        .WithHttpEndpoint(port: 8126, targetPort: 8126, name: "http")
        .WithEnvironment("NODE_ENV", "production")
        .WithEnvironment("PORT", "8126")
        .WithEnvironment("HOST", "0.0.0.0")
        .WithEnvironment("AGENT_API_KEY", agentApiKey)
        .WithEnvironment("AI_TOKEN_SECRET", aiTokenSecret)
        .WithHttpHealthCheck("/health");
}
else
{
    var taskPlannerBase = builder.AddContainer("task-planner", "node", "22-alpine")
        .WithHttpEndpoint(port: 8126, targetPort: 8126, name: "http")
        .WithBindMount("../../", "/app");
    taskPlanner = AddHostGateway(AddNodeModulesVolume(taskPlannerBase))
        .WithEntrypoint("/bin/sh")
        .WithArgs("-c", $"{agentRetryScript} && corepack enable && cd /app/agents/langchain/task-planner && if [ ! -f dist/unified-server.js ]; then echo 'Building task-planner...' && pnpm build; fi && echo 'Starting Unified server (AG-UI + A2A)...' && node dist/unified-server.js")
        .WithEnvironment("NODE_ENV", "development")
        .WithEnvironment("PORT", "8126")
        .WithEnvironment("HOST", "0.0.0.0")
        .WithEnvironment("RUNTIME_API_URL", runtimeApiUrl)

        .WithOtlpExporter()
        .WithEnvironment("NODE_TLS_REJECT_UNAUTHORIZED", "0") // Accept Aspire Dashboard's self-signed cert
        .WithEnvironment(context =>
        {
            context.EnvironmentVariables["REDIS_URI"] = ReferenceExpression.Create(
                $"redis://{redis!.Resource.PrimaryEndpoint.Property(EndpointProperty.Host)}:{redis!.Resource.PrimaryEndpoint.Property(EndpointProperty.Port)}");
        })
        .WithReference(redis!)
        .WaitFor(redis!)
        .WaitFor(qdrant!)
        .WithHttpHealthCheck("/health")
        .WithContainerRuntimeArgs("--label", $"com.docker.compose.project={dockerProjectName}")
        .WithContainerRuntimeArgs("--label", "com.docker.compose.service=task-planner")
        .WithLifetime(ContainerLifetime.Persistent);

    foreach (var (key, value) in envVars)
    {
        if (!useExternalDb && (key == "DATABASE_URL" || key == "DIRECT_URL")) continue;
        if (key.StartsWith("OTEL_")) continue;
        taskPlanner = taskPlanner.WithEnvironment(key, value);
    }
}

// ============================================================================
// STORY BREAKDOWN AGENT
// ============================================================================

IResourceBuilder<ContainerResource> storyBreakdown;

if (isPublishMode)
{
    storyBreakdown = builder.AddContainer("story-breakdown", GetAgentImage("story-breakdown"))
        .WithHttpEndpoint(port: 8127, targetPort: 8127, name: "http")
        .WithEnvironment("NODE_ENV", "production")
        .WithEnvironment("PORT", "8127")
        .WithEnvironment("HOST", "0.0.0.0")
        .WithEnvironment("AGENT_API_KEY", agentApiKey)
        .WithEnvironment("AI_TOKEN_SECRET", aiTokenSecret)
        .WithHttpHealthCheck("/health");
}
else
{
    var storyBreakdownBase = builder.AddContainer("story-breakdown", "node", "22-alpine")
        .WithHttpEndpoint(port: 8127, targetPort: 8127, name: "http")
        .WithBindMount("../../", "/app");
    storyBreakdown = AddHostGateway(AddNodeModulesVolume(storyBreakdownBase))
        .WithEntrypoint("/bin/sh")
        .WithArgs("-c", $"{agentRetryScript} && corepack enable && cd /app/agents/langchain/story-breakdown && if [ ! -f dist/unified-server.js ]; then echo 'Building story-breakdown...' && pnpm build; fi && echo 'Starting Unified server (AG-UI + A2A)...' && node dist/unified-server.js")
        .WithEnvironment("NODE_ENV", "development")
        .WithEnvironment("PORT", "8127")
        .WithEnvironment("HOST", "0.0.0.0")
        .WithEnvironment("RUNTIME_API_URL", runtimeApiUrl)

        .WithOtlpExporter()
        .WithEnvironment("NODE_TLS_REJECT_UNAUTHORIZED", "0") // Accept Aspire Dashboard's self-signed cert
        .WithEnvironment(context =>
        {
            context.EnvironmentVariables["REDIS_URI"] = ReferenceExpression.Create(
                $"redis://{redis!.Resource.PrimaryEndpoint.Property(EndpointProperty.Host)}:{redis!.Resource.PrimaryEndpoint.Property(EndpointProperty.Port)}");
        })
        .WithReference(redis!)
        .WaitFor(redis!)
        .WaitFor(qdrant!)
        .WithHttpHealthCheck("/health")
        .WithContainerRuntimeArgs("--label", $"com.docker.compose.project={dockerProjectName}")
        .WithContainerRuntimeArgs("--label", "com.docker.compose.service=story-breakdown")
        .WithLifetime(ContainerLifetime.Persistent);

    foreach (var (key, value) in envVars)
    {
        if (!useExternalDb && (key == "DATABASE_URL" || key == "DIRECT_URL")) continue;
        if (key.StartsWith("OTEL_")) continue;
        storyBreakdown = storyBreakdown.WithEnvironment(key, value);
    }
}

// ============================================================================
// DATA ANALYST AGENT
// ============================================================================

IResourceBuilder<ContainerResource> dataAnalyst;

if (isPublishMode)
{
    dataAnalyst = builder.AddContainer("data-analyst", GetAgentImage("data-analyst"))
        .WithHttpEndpoint(port: 8130, targetPort: 8130, name: "http")
        .WithEnvironment("NODE_ENV", "production")
        .WithEnvironment("PORT", "8130")
        .WithEnvironment("HOST", "0.0.0.0")
        .WithEnvironment("AGENT_API_KEY", agentApiKey)
        .WithEnvironment("AI_TOKEN_SECRET", aiTokenSecret)
        .WithHttpHealthCheck("/health");
}
else
{
    var dataAnalystBase = builder.AddContainer("data-analyst", "node", "22-alpine")
        .WithHttpEndpoint(port: 8130, targetPort: 8130, name: "http")
        .WithBindMount("../../", "/app");
    dataAnalyst = AddHostGateway(AddNodeModulesVolume(dataAnalystBase))
        .WithEntrypoint("/bin/sh")
        .WithArgs("-c", $"{agentRetryScript} && corepack enable && cd /app/agents/langchain/data-analyst && echo 'Starting Data Analyst with tsx...' && pnpm exec tsx unified-server.ts")
        .WithEnvironment("NODE_ENV", "development")
        .WithEnvironment("PORT", "8130")
        .WithEnvironment("HOST", "0.0.0.0")
        .WithEnvironment("RUNTIME_API_URL", runtimeApiUrl)

        .WithOtlpExporter()
        .WithEnvironment("NODE_TLS_REJECT_UNAUTHORIZED", "0") // Accept Aspire Dashboard's self-signed cert
        .WithEnvironment(context =>
        {
            context.EnvironmentVariables["REDIS_URI"] = ReferenceExpression.Create(
                $"redis://{redis!.Resource.PrimaryEndpoint.Property(EndpointProperty.Host)}:{redis!.Resource.PrimaryEndpoint.Property(EndpointProperty.Port)}");
        })
        .WithReference(redis!)
        .WaitFor(redis!)
        .WaitFor(qdrant!)
        .WithHttpHealthCheck("/health")
        .WithContainerRuntimeArgs("--label", $"com.docker.compose.project={dockerProjectName}")
        .WithContainerRuntimeArgs("--label", "com.docker.compose.service=data-analyst")
        .WithLifetime(ContainerLifetime.Persistent);

    foreach (var (key, value) in envVars)
    {
        if (!useExternalDb && (key == "DATABASE_URL" || key == "DIRECT_URL")) continue;
        if (key.StartsWith("OTEL_")) continue;
        dataAnalyst = dataAnalyst.WithEnvironment(key, value);
    }
}

// ============================================================================
// API AGENT
// ============================================================================

IResourceBuilder<ContainerResource> apiAgent;

if (isPublishMode)
{
    apiAgent = builder.AddContainer("api-agent", GetAgentImage("api-agent"))
        .WithHttpEndpoint(port: 8131, targetPort: 8131, name: "http")
        .WithEnvironment("NODE_ENV", "production")
        .WithEnvironment("PORT", "8131")
        .WithEnvironment("HOST", "0.0.0.0")
        .WithEnvironment("AGENT_API_KEY", agentApiKey)
        .WithEnvironment("AI_TOKEN_SECRET", aiTokenSecret)
        .WithHttpHealthCheck("/health");
}
else
{
    var apiAgentBase = builder.AddContainer("api-agent", "node", "22-alpine")
        .WithHttpEndpoint(port: 8131, targetPort: 8131, name: "http")
        .WithBindMount("../../", "/app");
    apiAgent = AddHostGateway(AddNodeModulesVolume(apiAgentBase))
        .WithEntrypoint("/bin/sh")
        .WithArgs("-c", $"{agentRetryScript} && corepack enable && cd /app/agents/langchain/api-agent && if [ ! -f dist/unified-server.js ]; then echo 'Building api-agent...' && pnpm build; fi && echo 'Starting Unified server (AG-UI + A2A)...' && node dist/unified-server.js")
        .WithEnvironment("NODE_ENV", "development")
        .WithEnvironment("PORT", "8131")
        .WithEnvironment("HOST", "0.0.0.0")
        .WithEnvironment("RUNTIME_API_URL", runtimeApiUrl)

        .WithOtlpExporter()
        .WithEnvironment("NODE_TLS_REJECT_UNAUTHORIZED", "0") // Accept Aspire Dashboard's self-signed cert
        .WithEnvironment(context =>
        {
            context.EnvironmentVariables["REDIS_URI"] = ReferenceExpression.Create(
                $"redis://{redis!.Resource.PrimaryEndpoint.Property(EndpointProperty.Host)}:{redis!.Resource.PrimaryEndpoint.Property(EndpointProperty.Port)}");
        })
        .WithReference(redis!)
        .WaitFor(redis!)
        .WaitFor(qdrant!)
        .WithHttpHealthCheck("/health")
        .WithContainerRuntimeArgs("--label", $"com.docker.compose.project={dockerProjectName}")
        .WithContainerRuntimeArgs("--label", "com.docker.compose.service=api-agent")
        .WithLifetime(ContainerLifetime.Persistent);

    foreach (var (key, value) in envVars)
    {
        if (!useExternalDb && (key == "DATABASE_URL" || key == "DIRECT_URL")) continue;
        if (key.StartsWith("OTEL_")) continue;
        apiAgent = apiAgent.WithEnvironment(key, value);
    }
}

// ============================================================================
// PROMPT ENHANCER AGENT
// ============================================================================

IResourceBuilder<ContainerResource> promptEnhancer;

if (isPublishMode)
{
    promptEnhancer = builder.AddContainer("prompt-enhancer", GetAgentImage("prompt-enhancer"))
        .WithHttpEndpoint(port: 8134, targetPort: 8134, name: "http")
        .WithEnvironment("NODE_ENV", "production")
        .WithEnvironment("PORT", "8134")
        .WithEnvironment("HOST", "0.0.0.0")
        .WithEnvironment("AGENT_API_KEY", agentApiKey)
        .WithEnvironment("AI_TOKEN_SECRET", aiTokenSecret)
        .WithHttpHealthCheck("/health");
}
else
{
    var promptEnhancerBase = builder.AddContainer("prompt-enhancer", "node", "22-alpine")
        .WithHttpEndpoint(port: 8134, targetPort: 8134, name: "http")
        .WithBindMount("../../", "/app");
    promptEnhancer = AddHostGateway(AddNodeModulesVolume(promptEnhancerBase))
        .WithEntrypoint("/bin/sh")
        .WithArgs("-c", $"{agentRetryScript} && corepack enable && cd /app/agents/langchain/prompt-enhancer && if [ ! -f dist/unified-server.js ]; then echo 'Building prompt-enhancer...' && pnpm build; fi && echo 'Starting Unified Server (AG-UI + A2A)...' && node dist/unified-server.js")
        .WithEnvironment("NODE_ENV", "development")
        .WithEnvironment("PORT", "8134")
        .WithEnvironment("HOST", "0.0.0.0")
        .WithEnvironment("RUNTIME_API_URL", runtimeApiUrl)

        .WithOtlpExporter()
        .WithEnvironment("NODE_TLS_REJECT_UNAUTHORIZED", "0") // Accept Aspire Dashboard's self-signed cert
        .WithEnvironment(context =>
        {
            context.EnvironmentVariables["REDIS_URI"] = ReferenceExpression.Create(
                $"redis://{redis!.Resource.PrimaryEndpoint.Property(EndpointProperty.Host)}:{redis!.Resource.PrimaryEndpoint.Property(EndpointProperty.Port)}");
        })
        .WithReference(redis!)
        .WaitFor(redis!)
        .WaitFor(qdrant!)
        .WithHttpHealthCheck("/health")
        .WithContainerRuntimeArgs("--label", $"com.docker.compose.project={dockerProjectName}")
        .WithContainerRuntimeArgs("--label", "com.docker.compose.service=prompt-enhancer")
        .WithLifetime(ContainerLifetime.Persistent);

    foreach (var (key, value) in envVars)
    {
        if (!useExternalDb && (key == "DATABASE_URL" || key == "DIRECT_URL")) continue;
        if (key.StartsWith("OTEL_")) continue;
        promptEnhancer = promptEnhancer.WithEnvironment(key, value);
    }
}

// ============================================================================
// BACKLOG UPDATER AGENT
// ============================================================================

IResourceBuilder<ContainerResource> backlogUpdater;

if (isPublishMode)
{
    backlogUpdater = builder.AddContainer("backlog-updater", GetAgentImage("backlog-updater"))
        .WithHttpEndpoint(port: 8135, targetPort: 8135, name: "http")
        .WithEnvironment("NODE_ENV", "production")
        .WithEnvironment("PORT", "8135")
        .WithEnvironment("HOST", "0.0.0.0")
        .WithEnvironment("AGENT_API_KEY", agentApiKey)
        .WithEnvironment("AI_TOKEN_SECRET", aiTokenSecret)
        .WithHttpHealthCheck("/health");
}
else
{
    var backlogUpdaterBase = builder.AddContainer("backlog-updater", "node", "22-alpine")
        .WithHttpEndpoint(port: 8135, targetPort: 8135, name: "http")
        .WithBindMount("../../", "/app");
    backlogUpdater = AddHostGateway(AddNodeModulesVolume(backlogUpdaterBase))
        .WithEntrypoint("/bin/sh")
        .WithArgs("-c", $"{agentRetryScript} && corepack enable && cd /app/agents/langchain/backlog-updater && if [ ! -f dist/unified-server.js ]; then echo 'Building backlog-updater...' && pnpm build; fi && echo 'Starting Unified Server (AG-UI + A2A)...' && node dist/unified-server.js")
        .WithEnvironment("NODE_ENV", "development")
        .WithEnvironment("PORT", "8135")
        .WithEnvironment("HOST", "0.0.0.0")
        .WithEnvironment("RUNTIME_API_URL", runtimeApiUrl)

        .WithOtlpExporter()
        .WithEnvironment("NODE_TLS_REJECT_UNAUTHORIZED", "0") // Accept Aspire Dashboard's self-signed cert
        .WithEnvironment(context =>
        {
            context.EnvironmentVariables["REDIS_URI"] = ReferenceExpression.Create(
                $"redis://{redis!.Resource.PrimaryEndpoint.Property(EndpointProperty.Host)}:{redis!.Resource.PrimaryEndpoint.Property(EndpointProperty.Port)}");
        })
        .WithReference(redis!)
        .WaitFor(redis!)
        .WaitFor(qdrant!)
        .WithHttpHealthCheck("/health")
        .WithContainerRuntimeArgs("--label", $"com.docker.compose.project={dockerProjectName}")
        .WithContainerRuntimeArgs("--label", "com.docker.compose.service=backlog-updater")
        .WithLifetime(ContainerLifetime.Persistent);

    foreach (var (key, value) in envVars)
    {
        if (!useExternalDb && (key == "DATABASE_URL" || key == "DIRECT_URL")) continue;
        if (key.StartsWith("OTEL_")) continue;
        backlogUpdater = backlogUpdater.WithEnvironment(key, value);
    }
}

// ============================================================================
// CUSTOM AGENT RUNTIME
// ============================================================================

IResourceBuilder<ContainerResource> customAgentRuntime;

if (isPublishMode)
{
    customAgentRuntime = builder.AddContainer("custom-agent-runtime", GetAgentImage("custom-agent-runtime"))
        .WithHttpEndpoint(port: 8240, targetPort: 8240, name: "http")
        .WithEnvironment("NODE_ENV", "production")
        .WithEnvironment("PORT", "8240")
        .WithEnvironment("HOST", "0.0.0.0")
        .WithEnvironment("AGENT_API_KEY", agentApiKey)
        .WithEnvironment("AI_TOKEN_SECRET", aiTokenSecret)
        .WithHttpHealthCheck("/health");
}
else
{
    var customAgentBase = builder.AddContainer("custom-agent-runtime", "node", "22-alpine")
        .WithHttpEndpoint(port: 8240, targetPort: 8240, name: "http")
        .WithBindMount("../../", "/app");
    customAgentRuntime = AddHostGateway(AddNodeModulesVolume(customAgentBase))
        .WithEntrypoint("/bin/sh")
        .WithArgs("-c", $"{agentRetryScript} && corepack enable && cd /app/agents/langchain/custom-agent-runtime && if [ ! -f dist/server.js ]; then echo 'Building custom-agent-runtime...' && pnpm build; fi && echo 'Starting Custom Agent Runtime...' && node dist/server.js")
        .WithEnvironment("NODE_ENV", "development")
        .WithEnvironment("PORT", "8240")
        .WithEnvironment("HOST", "0.0.0.0")
        .WithEnvironment("RUNTIME_API_URL", runtimeApiUrl)

        .WithOtlpExporter()
        .WithEnvironment("NODE_TLS_REJECT_UNAUTHORIZED", "0") // Accept Aspire Dashboard's self-signed cert
        .WithEnvironment(context =>
        {
            context.EnvironmentVariables["REDIS_URI"] = ReferenceExpression.Create(
                $"redis://{redis!.Resource.PrimaryEndpoint.Property(EndpointProperty.Host)}:{redis!.Resource.PrimaryEndpoint.Property(EndpointProperty.Port)}");
        })
        .WithReference(redis!)
        .WaitFor(redis!)
        .WaitFor(qdrant!)
        .WithHttpHealthCheck("/health")
        .WithContainerRuntimeArgs("--label", $"com.docker.compose.project={dockerProjectName}")
        .WithContainerRuntimeArgs("--label", "com.docker.compose.service=custom-agent-runtime")
        .WithLifetime(ContainerLifetime.Persistent);

    foreach (var (key, value) in envVars)
    {
        if (!useExternalDb && (key == "DATABASE_URL" || key == "DIRECT_URL")) continue;
        if (key.StartsWith("OTEL_")) continue;
        customAgentRuntime = customAgentRuntime.WithEnvironment(key, value);
    }
}

// ============================================================================
// AGENT REBUILD COMMANDS (local development only)
// ============================================================================
// Fizzy #2373. Adds a "Rebuild & restart" button to every dev-mode agent, since
// the dev entrypoint only builds when dist/ is missing.
//
// The build runs inside the container, not on the host: the container owns dist/
// on a Linux bind mount (its first-run build runs as root), so a host-side build
// cannot replace those files.
//
// data-analyst is deliberately absent: it runs `pnpm exec tsx unified-server.ts`
// straight from source, so there is no bundle to rebuild and the stock Restart
// command already picks up a source change.
if (!isPublishMode)
{
    IResourceBuilder<ContainerResource>[] rebuildableAgents =
    [
        weaveReaders,
        weaveShuttle,
        weavePlanners,
        documentGenerator,
        projectDocumentGenerator,
        taskPlanner,
        storyBreakdown,
        apiAgent,
        promptEnhancer,
        backlogUpdater,
        customAgentRuntime,
    ];

    foreach (var agent in rebuildableAgents)
    {
        WithAgentRebuildCommand(agent);
    }
}

// ============================================================================
// MCP STDIO WRAPPER SERVICE
// ============================================================================
// This service enables STDIO-based MCP servers (like Azure DevOps) to be used
// in a multi-user environment by wrapping them in an HTTP service.

if (isPublishMode)
{
    // Production: Pre-built image from ACR
    var mcpStdioWrapper = builder.AddContainer("mcp-stdio-wrapper", GetAgentImage("mcp-stdio-wrapper"))
        .WithHttpEndpoint(port: 3100, targetPort: 3100, name: "http")
        .WithEnvironment("NODE_ENV", "production")
        .WithEnvironment("MAX_PROCESSES", "50")
        .WithEnvironment("IDLE_TTL_MS", "60000")
        .WithHttpHealthCheck("/health");
}
else
{
    // Development: Run MCP STDIO wrapper via pnpm
    var mcpStdioWrapper = builder.AddExecutable("mcp-stdio-wrapper", "pnpm", "../../packages/mcp-stdio-wrapper", "run", "dev")
        .WithHttpEndpoint(port: 3100, env: "PORT", isProxied: false)
        .WithEnvironment("NODE_ENV", "development")
        .WithEnvironment("ALLOW_EXTERNAL_ACCESS", "true")  // Allow localhost access for development
        .WithEnvironment("MAX_PROCESSES", "10")  // Limit processes for local dev
        .WithEnvironment("IDLE_TTL_MS", "120000");  // 2 minutes TTL for dev

    foreach (var (key, value) in envVars)
    {
        if (key.StartsWith("OTEL_")) continue;
        mcpStdioWrapper = mcpStdioWrapper.WithEnvironment(key, value);
    }
}

// ============================================================================
// TEMPORAL WORKER
// ============================================================================

if (isPublishMode)
{
    // Production: Use Temporal Cloud
    var temporalAddress = builder.AddParameter("temporal-address", secret: false);
    var temporalNamespace = builder.AddParameter("temporal-namespace", secret: false);
    var temporalApiKey = builder.AddParameter("temporal-api-key", secret: true);

    var temporalWorkerContainer = builder.AddContainer("temporal-worker", GetAgentImage("temporal-worker"))
        .WithEnvironment("NODE_ENV", "production")
        .WithEnvironment("TEMPORAL_ADDRESS", temporalAddress)
        .WithEnvironment("TEMPORAL_NAMESPACE", temporalNamespace)
        .WithEnvironment("TEMPORAL_CLOUD_API_KEY", temporalApiKey)
        .WithEnvironment("AGENT_API_KEY", agentApiKey)
        .WithEnvironment("AI_TOKEN_SECRET", aiTokenSecret);
}
else
{
    // Development: Local Temporal server
    var temporalWorker = builder.AddExecutable("temporal-worker", "pnpm", "../../packages/temporal", "run", "worker:dev")
        .WithEnvironment("NODE_ENV", "development")
        .WithEnvironment("TEMPORAL_ADDRESS", "localhost:7233")
        .WithEnvironment("MCP_STDIO_WRAPPER_URL", "http://localhost:3100")  // MCP STDIO wrapper for Azure DevOps, etc.
        .WithEnvironment("WEAVE_READERS_URL", "http://localhost:8140")
        .WithEnvironment("WEAVE_SHUTTLE_URL", "http://localhost:8141")
        .WithEnvironment("WEAVE_PLANNERS_URL", "http://localhost:8142")
        .WithEnvironment(context =>
        {
            context.EnvironmentVariables["REDIS_URL"] = ReferenceExpression.Create(
                $"redis://{redis!.Resource.PrimaryEndpoint.Property(EndpointProperty.Host)}:{redis!.Resource.PrimaryEndpoint.Property(EndpointProperty.Port)}");
            // Explicitly inject DATABASE_URL/DIRECT_URL from the live postgres endpoint
            // to override any stale inherited value from the AppHost parent process.
            if (postgres != null && !useExternalDb)
            {
                context.EnvironmentVariables["DATABASE_URL"] = ReferenceExpression.Create(
                    $"postgresql://postgres:{postgresPassword.Resource}@{postgres.Resource.PrimaryEndpoint.Property(EndpointProperty.Host)}:{postgres.Resource.PrimaryEndpoint.Property(EndpointProperty.Port)}/fabric");
                context.EnvironmentVariables["DIRECT_URL"] = ReferenceExpression.Create(
                    $"postgresql://postgres:{postgresPassword.Resource}@{postgres.Resource.PrimaryEndpoint.Property(EndpointProperty.Host)}:{postgres.Resource.PrimaryEndpoint.Property(EndpointProperty.Port)}/fabric");
            }
        })
        .WithOtlpExporter()
        .WithEnvironment("NODE_TLS_REJECT_UNAUTHORIZED", "0") // Accept Aspire Dashboard's self-signed cert
        .WithReference(fabricDb!)
        .WithReference(redis!)
        .WaitFor(fabricDb!)
        .WaitFor(redis!)
        .WaitFor(temporal!)
        .WaitFor(qdrant!);

    foreach (var (key, value) in envVars)
    {
        if (!useExternalDb && (key == "DATABASE_URL" || key == "DIRECT_URL")) continue;
        if (key.StartsWith("OTEL_")) continue;
        temporalWorker = temporalWorker.WithEnvironment(key, value);
    }
}

// ============================================================================
// LOCAL-ONLY SERVICES (PartyKit, Web App, Sandbox Worker)
// ============================================================================
// These are deployed separately (Cloudflare for PartyKit/Sandbox, Vercel for Web)

if (!isPublishMode)
{
    // PartyKit (deployed to Cloudflare in production)
    // Use HTTP protocol for OTLP to avoid gRPC credentials issues with self-signed certs
    var partykit = builder.AddExecutable("partykit", "sh", "../../party", "./start-dev.sh")
        .WithHttpEndpoint(port: 1999, env: "PARTYKIT_PORT")
        .WithEnvironment("NODE_ENV", "development")
        .WithEnvironment("HOST", "0.0.0.0")
        .WithOtlpExporter()
        .WithEnvironment("NODE_TLS_REJECT_UNAUTHORIZED", "0") // Accept Aspire Dashboard's self-signed cert
        .WithHttpHealthCheck("/parties/health/test");

    foreach (var (key, value) in envVars)
    {
        if (key.StartsWith("OTEL_")) continue;
        partykit = partykit.WithEnvironment(key, value);
    }

    // Web App (deployed to Vercel in production)
    // Use HTTP protocol for OTLP to avoid gRPC credentials issues with self-signed certs
#pragma warning disable ASPIREBROWSERLOGS001 // WithBrowserLogs is experimental in 13.5
    // The canonical origin the web app derives absolute URLs from (Better Auth
    // baseURL, OAuth redirect URIs, magic links, webhook targets). Localhost
    // unless the opt-in public tunnel is on.
    var webSiteUrl = devTunnelUrl ?? "http://localhost:3001";
    var web = builder.AddExecutable("web", "pnpm", "../../apps/web", "run", "dev")
        .WithBrowserLogs()
        .WithHttpEndpoint(port: 3001, env: "PORT", isProxied: false)
        .WithEnvironment("NODE_ENV", "development")
        .WithEnvironment("NEXT_PUBLIC_SITE_URL", webSiteUrl)
        .WithEnvironment("MCP_STDIO_WRAPPER_URL", "http://localhost:3100")  // MCP STDIO wrapper for Azure DevOps, etc.
        .WithEnvironment("WEAVE_READERS_URL", "http://localhost:8140")
        .WithEnvironment("WEAVE_SHUTTLE_URL", "http://localhost:8141")
        .WithEnvironment("WEAVE_PLANNERS_URL", "http://localhost:8142")
        .WithOtlpExporter()
        .WithEnvironment("NODE_TLS_REJECT_UNAUTHORIZED", "0") // Accept Aspire Dashboard's self-signed cert
        .WithEnvironment(context =>
        {
            context.EnvironmentVariables["REDIS_URL"] = ReferenceExpression.Create(
                $"redis://{redis!.Resource.PrimaryEndpoint.Property(EndpointProperty.Host)}:{redis!.Resource.PrimaryEndpoint.Property(EndpointProperty.Port)}");
            // Explicitly inject DATABASE_URL/DIRECT_URL from the live postgres endpoint.
            // This overrides any stale value inherited from the AppHost parent process
            // (which loads .env.local at startup via Env.Load() and passes it to children).
            // Docker reassigns random host ports on container restarts, but Aspire's dcpctrl
            // always proxies the configured port — using the endpoint reference here ensures
            // the web process always receives the correct, current connection string.
            if (postgres != null && !useExternalDb)
            {
                context.EnvironmentVariables["DATABASE_URL"] = ReferenceExpression.Create(
                    $"postgresql://postgres:{postgresPassword.Resource}@{postgres.Resource.PrimaryEndpoint.Property(EndpointProperty.Host)}:{postgres.Resource.PrimaryEndpoint.Property(EndpointProperty.Port)}/fabric");
                context.EnvironmentVariables["DIRECT_URL"] = ReferenceExpression.Create(
                    $"postgresql://postgres:{postgresPassword.Resource}@{postgres.Resource.PrimaryEndpoint.Property(EndpointProperty.Host)}:{postgres.Resource.PrimaryEndpoint.Property(EndpointProperty.Port)}/fabric");
            }
        })
        .WithReference(fabricDb!)
        .WithReference(redis!)
        .WaitFor(fabricDb!)
        .WaitFor(redis!)
        .WithExternalHttpEndpoints();
#pragma warning restore ASPIREBROWSERLOGS001

    foreach (var (key, value) in envVars)
    {
        if (!useExternalDb && (key == "DATABASE_URL" || key == "DIRECT_URL")) continue;
        if (key.StartsWith("OTEL_")) continue;
        if (key == "NEXT_PUBLIC_SITE_URL") continue; // pinned to webSiteUrl above
        web = web.WithEnvironment(key, value);
    }

    if (devTunnelUrl is not null)
    {
        // DEV_TUNNEL_URL adds the tunnel to Better Auth's trusted origins
        // (packages/auth/lib/trusted-origins.ts) and to Next's allowedDevOrigins
        // (apps/web/next.config.ts). Set after the .env.local loop so it wins.
        web = web.WithEnvironment("DEV_TUNNEL_URL", devTunnelUrl);

        var ngrokAuthToken = builder.AddParameter("ngrok-auth-token", secret: true);
        var tunnel = builder.AddContainer("tunnel", "ngrok/ngrok", "3")
            .WithContainerRuntimeArgs("--label", $"com.docker.compose.project={dockerProjectName}")
            .WithContainerRuntimeArgs("--label", "com.docker.compose.service=tunnel")
            .WithEnvironment("NGROK_AUTHTOKEN", ngrokAuthToken)
            // The web app is a host process, so the agent reaches it through
            // host.docker.internal (mapped by AddHostGateway on Linux).
            .WithArgs("http", "--url", devTunnelUrl, "--log", "stdout", "http://host.docker.internal:3001")
            // ngrok's local inspector and status API; the image binds it to 0.0.0.0:4040.
            .WithHttpEndpoint(targetPort: 4040, name: "inspect")
            .WithUrl(devTunnelUrl, "Public URL")
            .WaitFor(web);
        AddHostGateway(tunnel);
    }
}

// ============================================================================
// BUILD AND RUN
// ============================================================================

builder.Build().Run();
