using Aspire.Hosting;
using DotNetEnv;

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
#pragma warning disable ASPIREBROWSERLOGS001 // WithBrowserLogs is experimental in 13.3
    var web = builder.AddExecutable("web", "pnpm", "../../apps/web", "run", "dev")
        .WithBrowserLogs()
        .WithHttpEndpoint(port: 3001, env: "PORT", isProxied: false)
        .WithEnvironment("NODE_ENV", "development")
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
        if (key == "NEXT_PUBLIC_SITE_URL")
            web = web.WithEnvironment(key, "http://localhost:3001");
        else
            web = web.WithEnvironment(key, value);
    }
}

// ============================================================================
// BUILD AND RUN
// ============================================================================

builder.Build().Run();
