-- CreateEnum
CREATE TYPE "AgentConversationStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ProjectMemberRole" AS ENUM ('OWNER', 'EDITOR', 'VIEWER');

-- CreateEnum
CREATE TYPE "ProjectInvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "StoryPriority" AS ENUM ('P0_CRITICAL', 'P1_HIGH', 'P2_MEDIUM', 'P3_LOW');

-- CreateEnum
CREATE TYPE "StorySize" AS ENUM ('XS', 'S', 'M', 'L', 'XL');

-- CreateEnum
CREATE TYPE "PurchaseType" AS ENUM ('SUBSCRIPTION', 'ONE_TIME');

-- CreateEnum
CREATE TYPE "WorkflowStatus" AS ENUM ('NONE', 'RUNNING', 'COMPLETED', 'FAILED', 'RETRYING', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('PENDING', 'PROCESSING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "AgentFramework" AS ENUM ('LANGGRAPH', 'MICROSOFT', 'PYDANTIC_AI', 'CREWAI', 'AUTOGEN', 'OPENAI', 'CUSTOM', 'A2A', 'MCP', 'ORCHESTRATOR');

-- CreateEnum
CREATE TYPE "AgentStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'DEPLOYING', 'ERROR', 'MAINTENANCE');

-- CreateEnum
CREATE TYPE "AgentScope" AS ENUM ('SYSTEM', 'ORGANIZATION', 'USER');

-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "ProjectDocumentType" AS ENUM ('GENERAL', 'PRD', 'PROPOSAL', 'ARCHITECTURE', 'TECHNICAL_SPEC', 'USER_STORY', 'API_SPEC');

-- CreateEnum
CREATE TYPE "ProjectDocumentStatus" AS ENUM ('DRAFT', 'GENERATING', 'IN_PROGRESS', 'REVIEW', 'COMPLETE', 'FAILED');

-- CreateEnum
CREATE TYPE "ProjectContextType" AS ENUM ('FILE', 'LINK', 'TEXT', 'DOCUMENT', 'TECH_STACK', 'FEATURES', 'GOALS', 'DESCRIPTION', 'IMAGE', 'SPREADSHEET');

-- CreateEnum
CREATE TYPE "ChunkSplitMethod" AS ENUM ('PARAGRAPH', 'SENTENCE', 'FIXED', 'RECURSIVE', 'DOCUMENT', 'SEMANTIC');

-- CreateEnum
CREATE TYPE "EmbeddingModel" AS ENUM ('TEXT_EMBEDDING_3_SMALL', 'TEXT_EMBEDDING_3_LARGE');

-- CreateEnum
CREATE TYPE "ExtractionStatus" AS ENUM ('PENDING', 'EXTRACTING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "MCPAuthType" AS ENUM ('NONE', 'API_KEY', 'OAUTH2');

-- CreateEnum
CREATE TYPE "MCPApiKeyMethod" AS ENUM ('BEARER', 'HEADER');

-- CreateEnum
CREATE TYPE "MCPStatus" AS ENUM ('HEALTHY', 'DEGRADED', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "MCPTransport" AS ENUM ('SSE', 'HTTP', 'STDIO');

-- CreateEnum
CREATE TYPE "PromptScope" AS ENUM ('SYSTEM', 'ORG', 'USER');

-- CreateEnum
CREATE TYPE "PromptTargetType" AS ENUM ('AGENT', 'FEATURE', 'WORKFLOW', 'DOCUMENT');

-- CreateEnum
CREATE TYPE "PromptFormat" AS ENUM ('PLAIN_TEXT', 'MARKDOWN', 'HANDLEBARS', 'MUSTACHE', 'LIQUID', 'JINJA2');

-- CreateEnum
CREATE TYPE "PromptContentType" AS ENUM ('TEXT', 'IMAGE', 'VIDEO', 'AUDIO', 'STRUCTURED', 'SKILL');

-- CreateEnum
CREATE TYPE "StructuredFormat" AS ENUM ('JSON', 'YAML');

-- CreateEnum
CREATE TYPE "PromptChangeRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "AIProvider" AS ENUM ('VERCEL_GATEWAY', 'CLOUDFLARE_AI', 'OPENROUTER', 'AZURE_AI_FOUNDRY', 'AWS_BEDROCK', 'GOOGLE_VERTEX_AI', 'OPENAI_DIRECT', 'ANTHROPIC_DIRECT', 'GROQ', 'TOGETHER_AI', 'DEEPSEEK', 'COHERE', 'MISTRAL_AI', 'FIREWORKS', 'PERPLEXITY', 'XAI', 'CEREBRAS', 'REPLICATE', 'HUGGINGFACE', 'HYBRID', 'CUSTOM');

-- CreateEnum
CREATE TYPE "DeploymentStatus" AS ENUM ('PROVISIONING', 'ACTIVE', 'UPDATING', 'DELETING', 'FAILED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "HealthStatus" AS ENUM ('HEALTHY', 'DEGRADED', 'UNHEALTHY', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "WorkflowBuilderStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ACTIVE', 'PAUSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "WorkflowTriggerType" AS ENUM ('MANUAL', 'WEBHOOK', 'SCHEDULE', 'EVENT');

-- CreateEnum
CREATE TYPE "WorkflowExecutionStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT');

-- CreateEnum
CREATE TYPE "WorkflowNodeStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "WorkflowIntegrationProvider" AS ENUM ('AI_GATEWAY', 'CONFLUENCE', 'CUSTOM_WEBHOOK', 'DATABASE', 'FAL', 'FIRECRAWL', 'GITHUB', 'GOOGLE_DRIVE', 'LINEAR', 'MCP', 'NOTION', 'PERPLEXITY', 'RESEND', 'SLACK');

-- CreateEnum
CREATE TYPE "BrowserTaskStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OpenAPIAuthType" AS ENUM ('NONE', 'API_KEY', 'BEARER', 'BASIC', 'OAUTH2');

-- CreateEnum
CREATE TYPE "OpenAPIAuthLocation" AS ENUM ('HEADER', 'QUERY', 'COOKIE');

-- CreateEnum
CREATE TYPE "OpenAPIServiceStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'ERROR', 'SYNCING');

-- CreateEnum
CREATE TYPE "AgentFileType" AS ENUM ('DOCUMENT', 'CODE', 'DATA', 'CONFIG', 'OUTPUT', 'ARTIFACT');

-- CreateEnum
CREATE TYPE "AgentFileStatus" AS ENUM ('DRAFT', 'COMPLETE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "WorkspaceType" AS ENUM ('PERSONAL', 'CUSTOM');

-- CreateEnum
CREATE TYPE "WorkspaceStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "WorkspaceDocumentStatus" AS ENUM ('PENDING', 'UPLOADING', 'UPLOADED', 'EXTRACTING', 'CHUNKING', 'EMBEDDING', 'STORING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "WorkspaceAccessLevel" AS ENUM ('READ', 'WRITE');

-- CreateEnum
CREATE TYPE "AiModelCapability" AS ENUM ('TEXT', 'IMAGE', 'AUDIO', 'EMBEDDING', 'TOOL_CALLING', 'VISION', 'CODE', 'REASONING');

-- CreateEnum
CREATE TYPE "AiTaskType" AS ENUM ('SIMPLE', 'COMPLEX', 'REASONING', 'CHAT', 'TOOL_CALLING', 'EMBEDDING', 'IMAGE', 'AUDIO');

-- CreateEnum
CREATE TYPE "SpeedTier" AS ENUM ('FAST', 'BALANCED', 'QUALITY');

-- CreateEnum
CREATE TYPE "QualityTier" AS ENUM ('BASIC', 'STANDARD', 'PREMIUM');

-- CreateEnum
CREATE TYPE "TaskComplexity" AS ENUM ('SIMPLE', 'MEDIUM', 'COMPLEX');

-- CreateEnum
CREATE TYPE "ProviderCategory" AS ENUM ('GATEWAY', 'DIRECT');

-- CreateEnum
CREATE TYPE "TemplateExecutionStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReportTemplateType" AS ENUM ('GANTT_CHART', 'BURNDOWN', 'SPRINT_COMPLETION', 'FEATURE_SUMMARY', 'MONTHLY_REPORT', 'QUARTERLY_REPORT', 'INTEGRATION_ACTIVITY', 'CUSTOM');

-- CreateEnum
CREATE TYPE "ReportOutputFormat" AS ENUM ('MARKDOWN', 'HTML', 'PDF', 'EVIDENCE_EMBED', 'MULTI_FORMAT');

-- CreateEnum
CREATE TYPE "ReportTemplateScope" AS ENUM ('SYSTEM', 'ORGANIZATION', 'USER');

-- CreateEnum
CREATE TYPE "ReportExecutionStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReportArtifactType" AS ENUM ('MARKDOWN', 'PDF', 'HTML', 'EVIDENCE_EMBED', 'CHART_DATA', 'CSV', 'JSON');

-- CreateEnum
CREATE TYPE "AgentTemplateCategory" AS ENUM ('DATA', 'DESIGN', 'ENGINEERING', 'FINANCE', 'HIRING', 'KNOWLEDGE', 'LEGAL', 'MARKETING', 'OPERATIONS', 'PRODUCT', 'PRODUCT_MANAGEMENT', 'PRODUCTIVITY', 'SALES', 'SUPPORT', 'GENERAL');

-- CreateEnum
CREATE TYPE "AgentTemplateScope" AS ENUM ('SYSTEM', 'ORGANIZATION', 'USER');

-- CreateEnum
CREATE TYPE "AgentExecutionStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AgentDeploymentStatus" AS ENUM ('PENDING', 'DEPLOYING', 'ACTIVE', 'PAUSED', 'DEGRADED', 'FAILED', 'TERMINATED');

-- CreateEnum
CREATE TYPE "AgentDeploymentHealthStatus" AS ENUM ('UNKNOWN', 'HEALTHY', 'DEGRADED', 'UNHEALTHY');

-- CreateEnum
CREATE TYPE "DeploymentExecutionStatus" AS ENUM ('PENDING', 'RUNNING', 'WAITING_INPUT', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT');

-- CreateEnum
CREATE TYPE "DeploymentTriggerType" AS ENUM ('MANUAL', 'WEBHOOK', 'SLACK', 'SCHEDULE', 'EMAIL', 'API');

-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL,
    "image" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "username" TEXT,
    "role" TEXT,
    "banned" BOOLEAN,
    "banReason" TEXT,
    "banExpires" TIMESTAMP(3),
    "onboardingComplete" BOOLEAN NOT NULL DEFAULT false,
    "paymentsCustomerId" TEXT,
    "locale" TEXT,
    "twoFactorEnabled" BOOLEAN,
    "firecrawlApiKey" TEXT,
    "firecrawlEnabled" BOOLEAN NOT NULL DEFAULT false,
    "firecrawlConfiguredAt" TIMESTAMP(3),
    "firecrawlLastUsedAt" TIMESTAMP(3),
    "azureAiApiKey" TEXT,
    "azureAiConfiguredAt" TIMESTAMP(3),
    "azureAiEnabled" BOOLEAN NOT NULL DEFAULT false,
    "azureAiEndpoint" TEXT,
    "azureAiLastUsedAt" TIMESTAMP(3),
    "azureAiModelRouterName" TEXT,
    "azureAiProjectName" TEXT,
    "azureAiRegion" TEXT,
    "azureAiResourceGroup" TEXT,
    "azureAiSubscriptionId" TEXT,
    "azureAiTenantId" TEXT,
    "azureAiUseModelRouter" BOOLEAN NOT NULL DEFAULT false,
    "useDelegatedExecution" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT NOT NULL,
    "impersonatedBy" TEXT,
    "activeOrganizationId" TEXT,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "expiresAt" TIMESTAMP(3),
    "password" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3),

    CONSTRAINT "verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "passkey" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "publicKey" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "credentialID" TEXT NOT NULL,
    "counter" INTEGER NOT NULL,
    "deviceType" TEXT NOT NULL,
    "backedUp" BOOLEAN NOT NULL,
    "transports" TEXT,
    "createdAt" TIMESTAMP(3),

    CONSTRAINT "passkey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "twoFactor" (
    "id" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "backupCodes" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "twoFactor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT,
    "logo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "metadata" TEXT,
    "paymentsCustomerId" TEXT,
    "firecrawlApiKey" TEXT,
    "firecrawlEnabled" BOOLEAN NOT NULL DEFAULT false,
    "firecrawlConfiguredAt" TIMESTAMP(3),
    "firecrawlLastUsedAt" TIMESTAMP(3),
    "azureAiApiKey" TEXT,
    "azureAiConfiguredAt" TIMESTAMP(3),
    "azureAiEnabled" BOOLEAN NOT NULL DEFAULT false,
    "azureAiEndpoint" TEXT,
    "azureAiLastUsedAt" TIMESTAMP(3),
    "azureAiModelRouterName" TEXT,
    "azureAiProjectName" TEXT,
    "azureAiRegion" TEXT,
    "azureAiResourceGroup" TEXT,
    "azureAiSubscriptionId" TEXT,
    "azureAiTenantId" TEXT,
    "azureAiUseModelRouter" BOOLEAN NOT NULL DEFAULT false,
    "useDelegatedExecution" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_rag_settings" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "chunkSize" INTEGER,
    "chunkOverlap" INTEGER,
    "splitMethod" "ChunkSplitMethod",
    "embeddingModel" "EmbeddingModel",
    "topK" INTEGER,
    "similarityThreshold" DOUBLE PRECISION,
    "enableReranking" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_rag_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT,
    "status" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "inviterId" TEXT NOT NULL,

    CONSTRAINT "invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "userId" TEXT,
    "type" "PurchaseType" NOT NULL,
    "customerId" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "productId" TEXT NOT NULL,
    "status" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_chat" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "userId" TEXT,
    "title" TEXT,
    "messages" JSONB NOT NULL DEFAULT '[]',
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "workflowId" TEXT,
    "workflowRunId" TEXT,
    "workflowStatus" "WorkflowStatus" NOT NULL DEFAULT 'NONE',
    "lastError" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "lastRetryAt" TIMESTAMP(3),

    CONSTRAINT "ai_chat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_document" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "s3Path" TEXT NOT NULL,
    "status" "DocumentStatus" NOT NULL DEFAULT 'PENDING',
    "errorMessage" TEXT,
    "workflowId" TEXT,
    "workflowRunId" TEXT,
    "workflowStatus" "WorkflowStatus" NOT NULL DEFAULT 'NONE',
    "lastError" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "lastRetryAt" TIMESTAMP(3),
    "extractorUsed" TEXT,
    "extractionTime" INTEGER,
    "extractionCost" DOUBLE PRECISION,
    "pageCount" INTEGER,
    "hasTables" BOOLEAN NOT NULL DEFAULT false,
    "hasImages" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_chunk" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "content" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_chunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_rag_provider" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "providerName" TEXT NOT NULL,
    "encryptedApiKey" TEXT,
    "endpoint" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "documentsProcessed" INTEGER NOT NULL DEFAULT 0,
    "totalCost" DOUBLE PRECISION NOT NULL DEFAULT 0.0,

    CONSTRAINT "organization_rag_provider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_search_provider" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "providerName" TEXT NOT NULL,
    "encryptedApiKey" TEXT,
    "endpoint" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "searchesCount" INTEGER NOT NULL DEFAULT 0,
    "totalCost" DOUBLE PRECISION NOT NULL DEFAULT 0.0,

    CONSTRAINT "organization_search_provider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_rag_provider" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "providerName" TEXT NOT NULL,
    "encryptedApiKey" TEXT,
    "endpoint" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "documentsProcessed" INTEGER NOT NULL DEFAULT 0,
    "totalCost" DOUBLE PRECISION NOT NULL DEFAULT 0.0,

    CONSTRAINT "user_rag_provider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_search_provider" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "providerName" TEXT NOT NULL,
    "encryptedApiKey" TEXT,
    "endpoint" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "searchesCount" INTEGER NOT NULL DEFAULT 0,
    "totalCost" DOUBLE PRECISION NOT NULL DEFAULT 0.0,

    CONSTRAINT "user_search_provider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_api_key" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY['mcp:read', 'mcp:write']::TEXT[],
    "expiresAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_api_key_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_api_key" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY['mcp:read', 'mcp:write']::TEXT[],
    "expiresAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_api_key_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "description" TEXT,
    "heroEmojis" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "heroImageUrl" TEXT,
    "framework" "AgentFramework" NOT NULL,
    "runtimeVersion" TEXT NOT NULL DEFAULT 'v1',
    "deploymentUrl" TEXT,
    "status" "AgentStatus" NOT NULL DEFAULT 'ACTIVE',
    "scope" "AgentScope" NOT NULL DEFAULT 'USER',
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "config" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastHealthCheck" TIMESTAMP(3),
    "lastDeployedAt" TIMESTAMP(3),
    "aiModel" TEXT,
    "aiModelConfig" JSONB,
    "aiProvider" "AIProvider",
    "useGlobalAiProvider" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_task" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "status" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "state" JSONB,
    "result" JSONB,
    "error" TEXT,
    "workflowId" TEXT,
    "runId" TEXT,
    "framework" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "agent_task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_approval" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "changes" JSONB NOT NULL,
    "feedback" TEXT,
    "confidence" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "agent_approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "registered_agent" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "description" TEXT,
    "framework" TEXT NOT NULL,
    "deploymentUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "scope" TEXT NOT NULL DEFAULT 'USER',
    "userId" TEXT,
    "organizationId" TEXT,
    "config" JSONB,
    "metadata" JSONB,
    "lastHealthCheck" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "registered_agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_conversation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "agentId" TEXT NOT NULL,
    "title" TEXT,
    "messages" JSONB NOT NULL DEFAULT '[]',
    "trajectory" JSONB,
    "metadata" JSONB,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "status" "AgentConversationStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sdlc_artifact" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "artifactType" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'markdown',
    "metadata" JSONB NOT NULL,
    "version" TEXT NOT NULL DEFAULT '1.0',
    "qdrantId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sdlc_artifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sdlc_pipeline" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "status" TEXT NOT NULL,
    "currentStage" TEXT,
    "stages" JSONB NOT NULL,
    "progress" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "sdlc_pipeline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "heroEmojis" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "heroImageUrl" TEXT,
    "goals" TEXT,
    "techStack" TEXT[],
    "features" TEXT[],
    "projectTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "ProjectStatus" NOT NULL DEFAULT 'DRAFT',
    "tags" TEXT[],
    "color" TEXT,
    "icon" TEXT,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "projectManagementMcpConfigId" TEXT,
    "projectManagementContainerId" TEXT,
    "projectManagementContainerName" TEXT,
    "projectManagementAdditionalContext" JSONB,
    "prdSourceMcpConfigId" TEXT,
    "prdSourceToolName" TEXT,
    "prdSourceToolArgs" JSONB,
    "prdSourceTitle" TEXT,
    "prdSourceUrl" TEXT,
    "repositoryUrl" TEXT,
    "repositoryOwner" TEXT,
    "repositoryName" TEXT,
    "defaultBranch" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_document" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "type" "ProjectDocumentType" NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "status" "ProjectDocumentStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "generationPrompt" TEXT,
    "generationError" TEXT,
    "generationProgress" INTEGER NOT NULL DEFAULT 0,
    "generationStartedAt" TIMESTAMP(3),
    "generationCompletedAt" TIMESTAMP(3),
    "workflowId" TEXT,
    "runId" TEXT,
    "wordCount" INTEGER,
    "lastEditedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_context" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "type" "ProjectContextType" NOT NULL,
    "content" TEXT NOT NULL,
    "qdrantId" TEXT,
    "embeddedAt" TIMESTAMP(3),
    "metadata" JSONB,
    "s3Path" TEXT,
    "s3Bucket" TEXT,
    "originalFilename" TEXT,
    "mimeType" TEXT,
    "fileSize" INTEGER,
    "extractionStatus" "ExtractionStatus" NOT NULL DEFAULT 'PENDING',
    "extractionError" TEXT,
    "extractedAt" TIMESTAMP(3),
    "sourceUrl" TEXT,
    "sourceTitle" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_context_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wizard_temp_context" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "type" "ProjectContextType" NOT NULL,
    "content" TEXT NOT NULL,
    "qdrantId" TEXT,
    "embeddedAt" TIMESTAMP(3),
    "metadata" JSONB,
    "s3Path" TEXT NOT NULL,
    "s3Bucket" TEXT NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "extractionStatus" "ExtractionStatus" NOT NULL DEFAULT 'PENDING',
    "extractionError" TEXT,
    "extractedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wizard_temp_context_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_version" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "changeDescription" TEXT,
    "changedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_rag_settings" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "chunkSize" INTEGER NOT NULL DEFAULT 3000,
    "chunkOverlap" INTEGER NOT NULL DEFAULT 500,
    "splitMethod" "ChunkSplitMethod" NOT NULL DEFAULT 'DOCUMENT',
    "embeddingModel" "EmbeddingModel" NOT NULL DEFAULT 'TEXT_EMBEDDING_3_SMALL',
    "topK" INTEGER NOT NULL DEFAULT 5,
    "similarityThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "enableReranking" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_rag_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_presence" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userName" TEXT NOT NULL,
    "userImage" TEXT,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activeTab" TEXT,
    "editingDocId" TEXT,

    CONSTRAINT "project_presence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_activity" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userName" TEXT NOT NULL,
    "activityType" TEXT NOT NULL,
    "resourceType" TEXT,
    "resourceId" TEXT,
    "resourceName" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_member" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "ProjectMemberRole" NOT NULL DEFAULT 'VIEWER',
    "invitedBy" TEXT NOT NULL,
    "invitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "project_member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_invitation" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "ProjectMemberRole" NOT NULL DEFAULT 'VIEWER',
    "status" "ProjectInvitationStatus" NOT NULL DEFAULT 'PENDING',
    "invitedBy" TEXT NOT NULL,
    "message" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),

    CONSTRAINT "project_invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_lock" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userName" TEXT NOT NULL,
    "acquiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastHeartbeat" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_lock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_story_status" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isFinal" BOOLEAN NOT NULL DEFAULT false,
    "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_story_status_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_story" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "statusId" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "acceptanceCriteria" TEXT,
    "priority" "StoryPriority" NOT NULL DEFAULT 'P2_MEDIUM',
    "size" "StorySize",
    "storyPoints" INTEGER,
    "order" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "labels" TEXT[],
    "createdById" TEXT NOT NULL,
    "assigneeId" TEXT,
    "externalId" TEXT,
    "externalUrl" TEXT,
    "pipelineExecutionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_story_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "story_task" (
    "id" TEXT NOT NULL,
    "storyId" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "isCompleted" BOOLEAN NOT NULL DEFAULT false,
    "order" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "estimatedHours" DOUBLE PRECISION,
    "externalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "assignedAgentId" TEXT,
    "agentTaskId" TEXT,
    "agentStatus" TEXT,
    "agentStartedAt" TIMESTAMP(3),
    "agentCompletedAt" TIMESTAMP(3),
    "agentError" TEXT,
    "repositoryUrl" TEXT,
    "repositoryOwner" TEXT,
    "repositoryName" TEXT,
    "targetBranch" TEXT,
    "artifactUrl" TEXT,
    "artifactType" TEXT,

    CONSTRAINT "story_task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "story_subtask" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "isCompleted" BOOLEAN NOT NULL DEFAULT false,
    "order" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "story_subtask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_workflow_plan" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'planning',
    "temporalWorkflowId" TEXT,
    "summary" TEXT,
    "steps" JSONB,
    "currentStepIndex" INTEGER,
    "checkpointData" JSONB,
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "task_workflow_plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_workflow_log" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "stepId" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "level" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "metadata" JSONB,

    CONSTRAINT "task_workflow_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MCPServer" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "heroEmojis" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "heroImageUrl" TEXT,
    "defaultUrl" TEXT,
    "command" TEXT,
    "docsUrl" TEXT,
    "transport" "MCPTransport" NOT NULL DEFAULT 'HTTP',
    "authMethods" "MCPAuthType"[],
    "apiKeyMethod" "MCPApiKeyMethod",
    "oauthDiscoveryUrl" TEXT,
    "oauthAuthorizationEndpoint" TEXT,
    "oauthTokenEndpoint" TEXT,
    "dcrRegistrationEndpoint" TEXT,
    "isSystemProvided" BOOLEAN NOT NULL DEFAULT true,
    "iconUrl" TEXT,
    "author" TEXT,
    "repositoryUrl" TEXT,
    "category" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdById" TEXT,
    "userId" TEXT,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MCPServer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MCPConfig" (
    "id" TEXT NOT NULL,
    "mcpServerId" TEXT NOT NULL,
    "userId" TEXT,
    "organizationId" TEXT,
    "displayName" TEXT,
    "heroEmojis" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "heroImageUrl" TEXT,
    "baseUrl" TEXT,
    "transport" "MCPTransport",
    "authType" "MCPAuthType" NOT NULL,
    "apiKeyMethod" "MCPApiKeyMethod" NOT NULL DEFAULT 'BEARER',
    "oauthClientId" TEXT,
    "encryptedOauthClientSecret" TEXT,
    "encryptedApiKey" TEXT,
    "encryptedAccessToken" TEXT,
    "dcrRegistrationEndpoint" TEXT,
    "dcrClientMetadata" JSONB,
    "dcrRegisteredAt" TIMESTAMP(3),
    "encryptedRefreshToken" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "scopes" TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "status" "MCPStatus" NOT NULL DEFAULT 'HEALTHY',
    "lastHealthCheckAt" TIMESTAMP(3),
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "failoverUrl" TEXT,
    "oauthMetadataCache" JSONB,
    "oauthMetadataCachedAt" TIMESTAMP(3),
    "refreshFailureCount" INTEGER NOT NULL DEFAULT 0,
    "lastRefreshFailedAt" TIMESTAMP(3),
    "lastRefreshError" TEXT,
    "needsReauth" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MCPConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MCPOAuthState" (
    "id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "mcpServerId" TEXT NOT NULL,
    "configId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "codeVerifier" TEXT,
    "redirectUri" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MCPOAuthState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MCPClientSession" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "configId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MCPClientSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prompt" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT,
    "description" TEXT,
    "scope" "PromptScope" NOT NULL,
    "userId" TEXT,
    "organizationId" TEXT,
    "forkedFromId" TEXT,
    "format" "PromptFormat" NOT NULL DEFAULT 'PLAIN_TEXT',
    "promptType" "PromptContentType" NOT NULL DEFAULT 'TEXT',
    "structuredFormat" "StructuredFormat",
    "category" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "heroEmojis" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "heroImageUrl" TEXT,
    "mediaUrl" TEXT,
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "isUnlisted" BOOLEAN NOT NULL DEFAULT false,
    "isFeatured" BOOLEAN NOT NULL DEFAULT false,
    "featuredAt" TIMESTAMP(3),
    "forDevs" BOOLEAN NOT NULL DEFAULT false,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "voteCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prompt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prompt_version" (
    "id" TEXT NOT NULL,
    "promptId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "variables" JSONB,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prompt_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prompt_binding" (
    "id" TEXT NOT NULL,
    "targetType" "PromptTargetType" NOT NULL,
    "targetKey" TEXT NOT NULL,
    "documentType" TEXT NOT NULL,
    "scope" "PromptScope" NOT NULL,
    "userId" TEXT,
    "organizationId" TEXT,
    "promptVersionId" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prompt_binding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prompt_vote" (
    "id" TEXT NOT NULL,
    "promptId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prompt_vote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prompt_tag" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#6366f1',
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prompt_tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prompt_tag_relation" (
    "promptId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,

    CONSTRAINT "prompt_tag_relation_pkey" PRIMARY KEY ("promptId","tagId")
);

-- CreateTable
CREATE TABLE "prompt_comment" (
    "id" TEXT NOT NULL,
    "promptId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "parentId" TEXT,
    "content" TEXT NOT NULL,
    "score" INTEGER NOT NULL DEFAULT 0,
    "flagged" BOOLEAN NOT NULL DEFAULT false,
    "flaggedAt" TIMESTAMP(3),
    "flaggedBy" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prompt_comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prompt_comment_vote" (
    "userId" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "value" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prompt_comment_vote_pkey" PRIMARY KEY ("userId","commentId")
);

-- CreateTable
CREATE TABLE "prompt_change_request" (
    "id" TEXT NOT NULL,
    "promptId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "proposedTitle" TEXT,
    "proposedContent" TEXT NOT NULL,
    "originalTitle" TEXT NOT NULL,
    "originalContent" TEXT NOT NULL,
    "reason" TEXT,
    "reviewNote" TEXT,
    "status" "PromptChangeRequestStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prompt_change_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prompt_connection" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "label" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prompt_connection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_type" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "icon" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_type_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "azure_agent_deployment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "agentId" TEXT,
    "azureAgentId" TEXT NOT NULL,
    "azureProjectName" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "description" TEXT,
    "framework" "AgentFramework" NOT NULL,
    "agentType" TEXT NOT NULL,
    "instructions" TEXT,
    "model" TEXT,
    "tools" JSONB,
    "endpoint" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "status" "DeploymentStatus" NOT NULL DEFAULT 'PROVISIONING',
    "supportsAgUi" BOOLEAN NOT NULL DEFAULT true,
    "agUiVersion" TEXT,
    "config" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deployedAt" TIMESTAMP(3),

    CONSTRAINT "azure_agent_deployment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "azure_ai_model_deployment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "deploymentName" TEXT NOT NULL,
    "modelName" TEXT NOT NULL,
    "modelFamily" TEXT NOT NULL,
    "publisher" TEXT,
    "endpoint" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "sku" TEXT,
    "capacity" INTEGER,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isModelRouter" BOOLEAN NOT NULL DEFAULT false,
    "routingRules" JSONB,
    "status" "DeploymentStatus" NOT NULL DEFAULT 'PROVISIONING',
    "healthStatus" "HealthStatus" NOT NULL DEFAULT 'UNKNOWN',
    "lastHealthCheck" TIMESTAMP(3),
    "tags" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "azure_ai_model_deployment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cloud_provider_config" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "provider" "AIProvider" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isEmbeddingProvider" BOOLEAN NOT NULL DEFAULT false,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "config" JSONB NOT NULL,
    "displayName" TEXT,
    "description" TEXT,
    "tags" JSONB,
    "healthStatus" "HealthStatus" NOT NULL DEFAULT 'UNKNOWN',
    "lastHealthCheck" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cloud_provider_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_router_config" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "strategy" TEXT NOT NULL DEFAULT 'cost',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "rules" JSONB NOT NULL,
    "totalRequests" INTEGER NOT NULL DEFAULT 0,
    "totalCost" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "avgLatency" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "model_router_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_cloud_provider_config" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" "AIProvider" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isEmbeddingProvider" BOOLEAN NOT NULL DEFAULT false,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "config" JSONB NOT NULL,
    "displayName" TEXT,
    "description" TEXT,
    "tags" JSONB,
    "healthStatus" "HealthStatus" NOT NULL DEFAULT 'UNKNOWN',
    "lastHealthCheck" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_cloud_provider_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "heroEmojis" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "heroImageUrl" TEXT,
    "status" "WorkflowBuilderStatus" NOT NULL DEFAULT 'DRAFT',
    "triggerType" "WorkflowTriggerType" NOT NULL DEFAULT 'MANUAL',
    "triggerConfig" JSONB,
    "nodes" JSONB NOT NULL,
    "edges" JSONB NOT NULL,
    "variables" JSONB,
    "settings" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "isTemplate" BOOLEAN NOT NULL DEFAULT false,
    "templateId" TEXT,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "projectId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastRunAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "publishedBy" TEXT,
    "publishedVersion" INTEGER,
    "webhookSecret" TEXT,

    CONSTRAINT "workflow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_version" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "nodes" JSONB NOT NULL,
    "edges" JSONB NOT NULL,
    "variables" JSONB,
    "settings" JSONB,
    "triggerConfig" JSONB,
    "changelog" TEXT,
    "isPublished" BOOLEAN NOT NULL DEFAULT false,
    "publishedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_execution" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT,
    "version" INTEGER NOT NULL,
    "status" "WorkflowExecutionStatus" NOT NULL DEFAULT 'PENDING',
    "triggerType" "WorkflowTriggerType" NOT NULL,
    "triggerInput" JSONB,
    "output" JSONB,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "duration" INTEGER,
    "temporalRunId" TEXT,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "pipelineId" TEXT,

    CONSTRAINT "workflow_execution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_execution_log" (
    "id" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "nodeName" TEXT,
    "nodeType" TEXT NOT NULL,
    "status" "WorkflowNodeStatus" NOT NULL DEFAULT 'PENDING',
    "input" JSONB,
    "output" JSONB,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "duration" INTEGER,

    CONSTRAINT "workflow_execution_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_integration" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "provider" "WorkflowIntegrationProvider" NOT NULL,
    "name" TEXT NOT NULL,
    "credentials" TEXT NOT NULL,
    "settings" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "workflow_integration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_api_key" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "permissions" TEXT[],
    "expiresAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "workflow_api_key_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "browser_task" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "status" "BrowserTaskStatus" NOT NULL DEFAULT 'PENDING',
    "sessionId" TEXT,
    "url" TEXT NOT NULL,
    "actions" JSONB NOT NULL,
    "extractors" JSONB,
    "result" JSONB,
    "screenshots" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "error" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "workflowId" TEXT,
    "runId" TEXT,

    CONSTRAINT "browser_task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_template" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "workflowSteps" JSONB NOT NULL,
    "parameters" JSONB,
    "sourceTaskId" TEXT,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "category" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automation_template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "openapi_service" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "specUrl" TEXT NOT NULL,
    "baseUrl" TEXT,
    "specVersion" TEXT,
    "heroEmojis" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "heroImageUrl" TEXT,
    "specTitle" TEXT,
    "specDescription" TEXT,
    "specHash" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "authType" "OpenAPIAuthType" NOT NULL DEFAULT 'NONE',
    "authLocation" "OpenAPIAuthLocation",
    "authKey" TEXT,
    "encryptedAuthValue" TEXT,
    "oauth2TokenUrl" TEXT,
    "oauth2AuthorizationUrl" TEXT,
    "oauth2ClientId" TEXT,
    "encryptedOauth2Secret" TEXT,
    "oauth2Scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "encryptedAccessToken" TEXT,
    "encryptedRefreshToken" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "userId" TEXT,
    "organizationId" TEXT,
    "createdById" TEXT NOT NULL,
    "status" "OpenAPIServiceStatus" NOT NULL DEFAULT 'ACTIVE',
    "errorMessage" TEXT,
    "toolCount" INTEGER NOT NULL DEFAULT 0,
    "category" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "openapi_service_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "openapi_tool" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "parametersSchema" JSONB,
    "requestBodySchema" JSONB,
    "responseSchema" JSONB,
    "pathParams" JSONB,
    "queryParams" JSONB,
    "headerParams" JSONB,
    "deprecated" BOOLEAN NOT NULL DEFAULT false,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "avgResponseTime" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "errorRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "openapi_tool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "openapi_service_config" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "userId" TEXT,
    "organizationId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "customBaseUrl" TEXT,
    "customAuthType" "OpenAPIAuthType",
    "encryptedCustomAuthValue" TEXT,
    "enabledToolIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "disabledToolIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "maxRequestsPerMinute" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "openapi_service_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_workspace_file" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "path" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "extension" TEXT,
    "mimeType" TEXT,
    "content" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "fileType" "AgentFileType" NOT NULL DEFAULT 'DOCUMENT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "previousVersionId" TEXT,
    "status" "AgentFileStatus" NOT NULL DEFAULT 'DRAFT',
    "metadata" JSONB,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_workspace_file_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "type" "WorkspaceType" NOT NULL DEFAULT 'CUSTOM',
    "status" "WorkspaceStatus" NOT NULL DEFAULT 'ACTIVE',
    "documentLimit" INTEGER NOT NULL DEFAULT 20,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_document" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "s3Bucket" TEXT NOT NULL,
    "s3Path" TEXT NOT NULL,
    "status" "WorkspaceDocumentStatus" NOT NULL DEFAULT 'PENDING',
    "processingError" TEXT,
    "extractedText" TEXT,
    "extractorUsed" TEXT,
    "pageCount" INTEGER,
    "wordCount" INTEGER,
    "qdrantPointIds" TEXT[],
    "embeddedAt" TIMESTAMP(3),
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "workflowId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "uploadedBy" TEXT NOT NULL,

    CONSTRAINT "workspace_document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_document_chunk" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "qdrantId" TEXT,
    "startOffset" INTEGER,
    "endOffset" INTEGER,
    "pageNumber" INTEGER,
    "headings" TEXT[],

    CONSTRAINT "workspace_document_chunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_administrator" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "addedBy" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_administrator_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_contributor" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "addedBy" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_contributor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_stakeholder" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "addedBy" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_stakeholder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_agent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "addedBy" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_conversation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "allowedDocumentIds" TEXT[],
    "accessLevel" "WorkspaceAccessLevel" NOT NULL DEFAULT 'READ',
    "attachedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attachedBy" TEXT NOT NULL,

    CONSTRAINT "workspace_conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_rag_settings" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "chunkSize" INTEGER NOT NULL DEFAULT 3000,
    "chunkOverlap" INTEGER NOT NULL DEFAULT 500,
    "splitMethod" "ChunkSplitMethod" NOT NULL DEFAULT 'DOCUMENT',
    "embeddingModel" "EmbeddingModel" NOT NULL DEFAULT 'TEXT_EMBEDDING_3_SMALL',
    "topK" INTEGER NOT NULL DEFAULT 5,
    "similarityThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "enableReranking" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_rag_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_model" (
    "id" TEXT NOT NULL,
    "canonicalName" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "description" TEXT,
    "family" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "capabilities" "AiModelCapability"[] DEFAULT ARRAY['TEXT']::"AiModelCapability"[],
    "contextWindow" INTEGER NOT NULL,
    "maxOutputTokens" INTEGER,
    "speedTier" "SpeedTier" NOT NULL DEFAULT 'BALANCED',
    "qualityTier" "QualityTier" NOT NULL DEFAULT 'STANDARD',
    "inputCostPer1M" DOUBLE PRECISION,
    "outputCostPer1M" DOUBLE PRECISION,
    "suitableForTasks" "AiTaskType"[] DEFAULT ARRAY[]::"AiTaskType"[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "deprecatedAt" TIMESTAMP(3),
    "releaseDate" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_model_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_model_provider_mapping" (
    "id" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "provider" "AIProvider" NOT NULL,
    "providerModelId" TEXT NOT NULL,
    "maxContextWindow" INTEGER,
    "supportedFeatures" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isAvailable" BOOLEAN NOT NULL DEFAULT true,
    "availabilityNote" TEXT,
    "inputCostPer1M" DOUBLE PRECISION,
    "outputCostPer1M" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_model_provider_mapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_task_model_default" (
    "id" TEXT NOT NULL,
    "taskType" "AiTaskType" NOT NULL,
    "complexity" "TaskComplexity" NOT NULL DEFAULT 'MEDIUM',
    "modelId" TEXT NOT NULL,
    "provider" "AIProvider",
    "priority" INTEGER NOT NULL DEFAULT 0,
    "requiresToolCalling" BOOLEAN NOT NULL DEFAULT false,
    "minContextWindow" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_task_model_default_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_model_preference" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" "AIProvider" NOT NULL,
    "taskType" "AiTaskType" NOT NULL,
    "modelId" TEXT NOT NULL,
    "customParameters" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_model_preference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_orchestrator_preferences" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT '',
    "enabledMcpConfigIds" JSONB NOT NULL DEFAULT '[]',
    "enabledAgentIds" JSONB NOT NULL DEFAULT '[]',
    "enabledWorkspaceIds" JSONB NOT NULL DEFAULT '[]',
    "trustConfiguration" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_orchestrator_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_model_preference" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "provider" "AIProvider" NOT NULL,
    "taskType" "AiTaskType" NOT NULL,
    "modelId" TEXT NOT NULL,
    "customParameters" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_model_preference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_template" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "criteria" JSONB NOT NULL,
    "behavior" JSONB NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'USER',
    "userId" TEXT,
    "organizationId" TEXT,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsed" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "approval_template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_usage_log" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "organizationId" TEXT,
    "providerConfigId" TEXT,
    "provider" "AIProvider" NOT NULL,
    "modelCanonicalName" TEXT,
    "providerModelId" TEXT NOT NULL,
    "taskType" "AiTaskType",
    "agentId" TEXT,
    "conversationId" TEXT,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "totalTokens" INTEGER NOT NULL,
    "costCents" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usage_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_template" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "heroEmojis" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "heroImageUrl" TEXT,
    "templateType" "ReportTemplateType" NOT NULL,
    "category" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "definition" JSONB NOT NULL,
    "parameters" JSONB,
    "outputFormat" "ReportOutputFormat" NOT NULL DEFAULT 'MARKDOWN',
    "connections" JSONB,
    "fabricConfig" JSONB,
    "schedule" JSONB,
    "evidenceProjectId" TEXT,
    "evidenceReportSlug" TEXT,
    "evidenceConfig" JSONB,
    "userId" TEXT,
    "organizationId" TEXT,
    "scope" "ReportTemplateScope" NOT NULL DEFAULT 'USER',
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "report_template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "template_instance" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "heroEmojis" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "connections" JSONB NOT NULL,
    "parameterDefaults" JSONB,
    "fabricConfig" JSONB,
    "schedule" JSONB,
    "nextRunAt" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "runCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "template_instance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "template_instance_execution" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "status" "TemplateExecutionStatus" NOT NULL DEFAULT 'PENDING',
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "duration" INTEGER,
    "parameters" JSONB,
    "fabricEnrichment" JSONB,
    "dataSources" JSONB,
    "workflowId" TEXT,
    "runId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "template_instance_execution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "template_instance_artifact" (
    "id" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "artifactType" "ReportArtifactType" NOT NULL,
    "s3Path" TEXT,
    "s3Bucket" TEXT,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "content" TEXT,
    "metadata" JSONB,
    "qdrantId" TEXT,
    "embeddedAt" TIMESTAMP(3),
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "template_instance_artifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "template_instance_artifact_chunk" (
    "id" TEXT NOT NULL,
    "artifactId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "qdrantId" TEXT,
    "metadata" JSONB,

    CONSTRAINT "template_instance_artifact_chunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_execution" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "status" "ReportExecutionStatus" NOT NULL DEFAULT 'PENDING',
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "duration" INTEGER,
    "parameters" JSONB,
    "dateRange" JSONB,
    "dataSources" JSONB,
    "workflowId" TEXT,
    "runId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_execution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_artifact" (
    "id" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "artifactType" "ReportArtifactType" NOT NULL,
    "s3Path" TEXT,
    "s3Bucket" TEXT,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "content" TEXT,
    "metadata" JSONB,
    "qdrantId" TEXT,
    "embeddedAt" TIMESTAMP(3),
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "evidenceEmbedUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_artifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_artifact_chunk" (
    "id" TEXT NOT NULL,
    "artifactId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "qdrantId" TEXT,
    "metadata" JSONB,

    CONSTRAINT "report_artifact_chunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_template" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "heroEmojis" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "heroImageUrl" TEXT,
    "category" "AgentTemplateCategory" NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "instructionSections" JSONB NOT NULL,
    "useCases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "proTips" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "knowledgeSources" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tools" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "triggerTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "suggestedModel" TEXT,
    "modelConfig" JSONB,
    "promptBindingId" TEXT,
    "documentType" "ProjectDocumentType",
    "scope" "AgentTemplateScope" NOT NULL DEFAULT 'SYSTEM',
    "userId" TEXT,
    "organizationId" TEXT,
    "isPublished" BOOLEAN NOT NULL DEFAULT true,
    "isFeatured" BOOLEAN NOT NULL DEFAULT false,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_template_instance" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "heroEmojis" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "heroImageUrl" TEXT,
    "customInstructions" JSONB,
    "knowledgeConnections" JSONB NOT NULL DEFAULT '{}',
    "toolConnections" JSONB NOT NULL DEFAULT '{}',
    "triggers" JSONB NOT NULL DEFAULT '[]',
    "modelOverride" TEXT,
    "modelConfig" JSONB,
    "workspaceIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "executionMode" TEXT NOT NULL DEFAULT 'single_turn',
    "goal" TEXT,
    "successCriteria" JSONB,
    "maxIterations" INTEGER NOT NULL DEFAULT 10,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "runCount" INTEGER NOT NULL DEFAULT 0,
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_template_instance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_template_conversation" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "title" TEXT,
    "isPinned" BOOLEAN NOT NULL DEFAULT false,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "messages" JSONB NOT NULL DEFAULT '[]',
    "context" JSONB,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_template_conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_template_execution" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "triggerType" TEXT,
    "triggerData" JSONB,
    "status" "AgentExecutionStatus" NOT NULL DEFAULT 'PENDING',
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "duration" INTEGER,
    "input" JSONB,
    "output" JSONB,
    "error" TEXT,
    "workflowId" TEXT,
    "runId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_template_execution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_deployment" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" "AgentDeploymentStatus" NOT NULL DEFAULT 'PENDING',
    "deployedAt" TIMESTAMP(3),
    "pausedAt" TIMESTAMP(3),
    "terminatedAt" TIMESTAMP(3),
    "lastActiveAt" TIMESTAMP(3),
    "supervisorWorkflowId" TEXT,
    "supervisorRunId" TEXT,
    "taskQueue" TEXT,
    "healthStatus" "AgentDeploymentHealthStatus" NOT NULL DEFAULT 'UNKNOWN',
    "lastHealthCheck" TIMESTAMP(3),
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "maxConcurrentExecutions" INTEGER NOT NULL DEFAULT 5,
    "currentExecutions" INTEGER NOT NULL DEFAULT 0,
    "rateLimitPerMinute" INTEGER NOT NULL DEFAULT 60,
    "rateLimitPerHour" INTEGER NOT NULL DEFAULT 500,
    "activeTriggers" JSONB NOT NULL DEFAULT '[]',
    "dailyExecutionLimit" INTEGER,
    "monthlyExecutionLimit" INTEGER,
    "dailyExecutionCount" INTEGER NOT NULL DEFAULT 0,
    "monthlyExecutionCount" INTEGER NOT NULL DEFAULT 0,
    "quotaResetAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_deployment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_deployment_execution" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "executionId" TEXT NOT NULL,
    "triggerType" TEXT NOT NULL,
    "triggerId" TEXT,
    "triggerData" JSONB,
    "status" "DeploymentExecutionStatus" NOT NULL DEFAULT 'PENDING',
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "duration" INTEGER,
    "priority" INTEGER NOT NULL DEFAULT 5,
    "input" JSONB,
    "output" JSONB,
    "error" TEXT,
    "workflowId" TEXT,
    "runId" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "totalCost" DECIMAL(10,6),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_deployment_execution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_execution_step" (
    "id" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "stepNumber" INTEGER NOT NULL,
    "stepType" TEXT NOT NULL,
    "name" TEXT,
    "description" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "duration" INTEGER,
    "input" JSONB,
    "output" JSONB,
    "error" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_execution_step_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_deployment_trigger" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "type" "DeploymentTriggerType" NOT NULL,
    "config" JSONB NOT NULL,
    "webhookSecret" TEXT,
    "webhookUrl" TEXT,
    "cronExpression" TEXT,
    "timezone" TEXT,
    "nextRunAt" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "slackChannelId" TEXT,
    "slackTeamId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "totalExecutions" INTEGER NOT NULL DEFAULT 0,
    "lastExecutionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_deployment_trigger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_deployment_metrics" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "windowType" TEXT NOT NULL,
    "totalExecutions" INTEGER NOT NULL DEFAULT 0,
    "successfulExecutions" INTEGER NOT NULL DEFAULT 0,
    "failedExecutions" INTEGER NOT NULL DEFAULT 0,
    "cancelledExecutions" INTEGER NOT NULL DEFAULT 0,
    "timedOutExecutions" INTEGER NOT NULL DEFAULT 0,
    "avgDurationMs" INTEGER,
    "p50DurationMs" INTEGER,
    "p95DurationMs" INTEGER,
    "p99DurationMs" INTEGER,
    "totalInputTokens" INTEGER NOT NULL DEFAULT 0,
    "totalOutputTokens" INTEGER NOT NULL DEFAULT 0,
    "totalCost" DECIMAL(10,6),
    "executionsByTrigger" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_deployment_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_queue_shard" (
    "id" TEXT NOT NULL,
    "queueName" TEXT NOT NULL,
    "shardType" TEXT NOT NULL,
    "organizationId" TEXT,
    "currentDepth" INTEGER NOT NULL DEFAULT 0,
    "maxDepth" INTEGER NOT NULL DEFAULT 1000,
    "activeWorkers" INTEGER NOT NULL DEFAULT 0,
    "targetWorkers" INTEGER NOT NULL DEFAULT 2,
    "isHealthy" BOOLEAN NOT NULL DEFAULT true,
    "lastHealthCheck" TIMESTAMP(3),
    "totalProcessed" INTEGER NOT NULL DEFAULT 0,
    "avgLatencyMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "task_queue_shard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_deployment_quota" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "maxDeployments" INTEGER NOT NULL DEFAULT 10,
    "maxConcurrentExecutions" INTEGER NOT NULL DEFAULT 50,
    "dailyExecutionLimit" INTEGER NOT NULL DEFAULT 1000,
    "monthlyExecutionLimit" INTEGER NOT NULL DEFAULT 20000,
    "currentDeployments" INTEGER NOT NULL DEFAULT 0,
    "dailyExecutionCount" INTEGER NOT NULL DEFAULT 0,
    "monthlyExecutionCount" INTEGER NOT NULL DEFAULT 0,
    "dailyResetAt" TIMESTAMP(3),
    "monthlyResetAt" TIMESTAMP(3),
    "customLimits" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_deployment_quota_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_deployment_quota" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "maxDeployments" INTEGER NOT NULL DEFAULT 3,
    "maxConcurrentExecutions" INTEGER NOT NULL DEFAULT 10,
    "dailyExecutionLimit" INTEGER NOT NULL DEFAULT 100,
    "monthlyExecutionLimit" INTEGER NOT NULL DEFAULT 2000,
    "currentDeployments" INTEGER NOT NULL DEFAULT 0,
    "dailyExecutionCount" INTEGER NOT NULL DEFAULT 0,
    "monthlyExecutionCount" INTEGER NOT NULL DEFAULT 0,
    "dailyResetAt" TIMESTAMP(3),
    "monthlyResetAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_deployment_quota_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "user_username_key" ON "user"("username");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_key" ON "session"("token");

-- CreateIndex
CREATE UNIQUE INDEX "organization_slug_key" ON "organization"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "organization_rag_settings_organizationId_key" ON "organization_rag_settings"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "member_organizationId_userId_key" ON "member"("organizationId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_subscriptionId_key" ON "purchase"("subscriptionId");

-- CreateIndex
CREATE INDEX "purchase_subscriptionId_idx" ON "purchase"("subscriptionId");

-- CreateIndex
CREATE INDEX "chat_document_chatId_userId_idx" ON "chat_document"("chatId", "userId");

-- CreateIndex
CREATE INDEX "chat_document_organizationId_idx" ON "chat_document"("organizationId");

-- CreateIndex
CREATE INDEX "chat_document_status_idx" ON "chat_document"("status");

-- CreateIndex
CREATE INDEX "chat_document_workflowStatus_idx" ON "chat_document"("workflowStatus");

-- CreateIndex
CREATE INDEX "document_chunk_documentId_idx" ON "document_chunk"("documentId");

-- CreateIndex
CREATE INDEX "document_chunk_chatId_idx" ON "document_chunk"("chatId");

-- CreateIndex
CREATE INDEX "document_chunk_userId_idx" ON "document_chunk"("userId");

-- CreateIndex
CREATE INDEX "document_chunk_organizationId_idx" ON "document_chunk"("organizationId");

-- CreateIndex
CREATE INDEX "organization_rag_provider_organizationId_idx" ON "organization_rag_provider"("organizationId");

-- CreateIndex
CREATE INDEX "organization_rag_provider_organizationId_enabled_idx" ON "organization_rag_provider"("organizationId", "enabled");

-- CreateIndex
CREATE INDEX "organization_rag_provider_organizationId_isDefault_idx" ON "organization_rag_provider"("organizationId", "isDefault");

-- CreateIndex
CREATE UNIQUE INDEX "organization_rag_provider_organizationId_providerName_key" ON "organization_rag_provider"("organizationId", "providerName");

-- CreateIndex
CREATE INDEX "organization_search_provider_organizationId_idx" ON "organization_search_provider"("organizationId");

-- CreateIndex
CREATE INDEX "organization_search_provider_organizationId_enabled_idx" ON "organization_search_provider"("organizationId", "enabled");

-- CreateIndex
CREATE INDEX "organization_search_provider_organizationId_isDefault_idx" ON "organization_search_provider"("organizationId", "isDefault");

-- CreateIndex
CREATE UNIQUE INDEX "organization_search_provider_organizationId_providerName_key" ON "organization_search_provider"("organizationId", "providerName");

-- CreateIndex
CREATE INDEX "user_rag_provider_userId_idx" ON "user_rag_provider"("userId");

-- CreateIndex
CREATE INDEX "user_rag_provider_userId_enabled_idx" ON "user_rag_provider"("userId", "enabled");

-- CreateIndex
CREATE INDEX "user_rag_provider_userId_isDefault_idx" ON "user_rag_provider"("userId", "isDefault");

-- CreateIndex
CREATE UNIQUE INDEX "user_rag_provider_userId_providerName_key" ON "user_rag_provider"("userId", "providerName");

-- CreateIndex
CREATE INDEX "user_search_provider_userId_idx" ON "user_search_provider"("userId");

-- CreateIndex
CREATE INDEX "user_search_provider_userId_enabled_idx" ON "user_search_provider"("userId", "enabled");

-- CreateIndex
CREATE INDEX "user_search_provider_userId_isDefault_idx" ON "user_search_provider"("userId", "isDefault");

-- CreateIndex
CREATE UNIQUE INDEX "user_search_provider_userId_providerName_key" ON "user_search_provider"("userId", "providerName");

-- CreateIndex
CREATE INDEX "user_api_key_userId_idx" ON "user_api_key"("userId");

-- CreateIndex
CREATE INDEX "user_api_key_keyPrefix_idx" ON "user_api_key"("keyPrefix");

-- CreateIndex
CREATE INDEX "user_api_key_isActive_idx" ON "user_api_key"("isActive");

-- CreateIndex
CREATE INDEX "organization_api_key_organizationId_idx" ON "organization_api_key"("organizationId");

-- CreateIndex
CREATE INDEX "organization_api_key_keyPrefix_idx" ON "organization_api_key"("keyPrefix");

-- CreateIndex
CREATE INDEX "organization_api_key_isActive_idx" ON "organization_api_key"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "agent_agentId_key" ON "agent"("agentId");

-- CreateIndex
CREATE INDEX "agent_userId_idx" ON "agent"("userId");

-- CreateIndex
CREATE INDEX "agent_organizationId_idx" ON "agent"("organizationId");

-- CreateIndex
CREATE INDEX "agent_framework_idx" ON "agent"("framework");

-- CreateIndex
CREATE INDEX "agent_status_idx" ON "agent"("status");

-- CreateIndex
CREATE INDEX "agent_scope_idx" ON "agent"("scope");

-- CreateIndex
CREATE INDEX "agent_name_idx" ON "agent"("name");

-- CreateIndex
CREATE INDEX "agent_runtimeVersion_idx" ON "agent"("runtimeVersion");

-- CreateIndex
CREATE INDEX "agent_task_userId_idx" ON "agent_task"("userId");

-- CreateIndex
CREATE INDEX "agent_task_organizationId_idx" ON "agent_task"("organizationId");

-- CreateIndex
CREATE INDEX "agent_task_status_idx" ON "agent_task"("status");

-- CreateIndex
CREATE INDEX "agent_task_stage_idx" ON "agent_task"("stage");

-- CreateIndex
CREATE INDEX "agent_task_workflowId_idx" ON "agent_task"("workflowId");

-- CreateIndex
CREATE INDEX "agent_task_agentId_idx" ON "agent_task"("agentId");

-- CreateIndex
CREATE INDEX "agent_approval_taskId_idx" ON "agent_approval"("taskId");

-- CreateIndex
CREATE INDEX "agent_approval_userId_idx" ON "agent_approval"("userId");

-- CreateIndex
CREATE INDEX "agent_approval_status_idx" ON "agent_approval"("status");

-- CreateIndex
CREATE UNIQUE INDEX "registered_agent_agentId_key" ON "registered_agent"("agentId");

-- CreateIndex
CREATE INDEX "registered_agent_userId_idx" ON "registered_agent"("userId");

-- CreateIndex
CREATE INDEX "registered_agent_organizationId_idx" ON "registered_agent"("organizationId");

-- CreateIndex
CREATE INDEX "registered_agent_status_idx" ON "registered_agent"("status");

-- CreateIndex
CREATE INDEX "registered_agent_scope_idx" ON "registered_agent"("scope");

-- CreateIndex
CREATE INDEX "registered_agent_framework_idx" ON "registered_agent"("framework");

-- CreateIndex
CREATE INDEX "agent_conversation_userId_agentId_idx" ON "agent_conversation"("userId", "agentId");

-- CreateIndex
CREATE INDEX "agent_conversation_organizationId_agentId_idx" ON "agent_conversation"("organizationId", "agentId");

-- CreateIndex
CREATE INDEX "agent_conversation_status_idx" ON "agent_conversation"("status");

-- CreateIndex
CREATE INDEX "agent_conversation_pinned_idx" ON "agent_conversation"("pinned");

-- CreateIndex
CREATE INDEX "agent_conversation_createdAt_idx" ON "agent_conversation"("createdAt");

-- CreateIndex
CREATE INDEX "sdlc_artifact_taskId_idx" ON "sdlc_artifact"("taskId");

-- CreateIndex
CREATE INDEX "sdlc_artifact_organizationId_idx" ON "sdlc_artifact"("organizationId");

-- CreateIndex
CREATE INDEX "sdlc_artifact_stage_idx" ON "sdlc_artifact"("stage");

-- CreateIndex
CREATE INDEX "sdlc_artifact_artifactType_idx" ON "sdlc_artifact"("artifactType");

-- CreateIndex
CREATE INDEX "sdlc_pipeline_userId_idx" ON "sdlc_pipeline"("userId");

-- CreateIndex
CREATE INDEX "sdlc_pipeline_organizationId_idx" ON "sdlc_pipeline"("organizationId");

-- CreateIndex
CREATE INDEX "sdlc_pipeline_status_idx" ON "sdlc_pipeline"("status");

-- CreateIndex
CREATE INDEX "project_userId_idx" ON "project"("userId");

-- CreateIndex
CREATE INDEX "project_organizationId_idx" ON "project"("organizationId");

-- CreateIndex
CREATE INDEX "project_status_idx" ON "project"("status");

-- CreateIndex
CREATE INDEX "project_document_projectId_idx" ON "project_document"("projectId");

-- CreateIndex
CREATE INDEX "project_document_type_idx" ON "project_document"("type");

-- CreateIndex
CREATE INDEX "project_document_status_idx" ON "project_document"("status");

-- CreateIndex
CREATE INDEX "project_context_projectId_idx" ON "project_context"("projectId");

-- CreateIndex
CREATE INDEX "project_context_type_idx" ON "project_context"("type");

-- CreateIndex
CREATE INDEX "project_context_qdrantId_idx" ON "project_context"("qdrantId");

-- CreateIndex
CREATE INDEX "project_context_extractionStatus_idx" ON "project_context"("extractionStatus");

-- CreateIndex
CREATE INDEX "wizard_temp_context_sessionId_idx" ON "wizard_temp_context"("sessionId");

-- CreateIndex
CREATE INDEX "wizard_temp_context_userId_idx" ON "wizard_temp_context"("userId");

-- CreateIndex
CREATE INDEX "wizard_temp_context_organizationId_idx" ON "wizard_temp_context"("organizationId");

-- CreateIndex
CREATE INDEX "wizard_temp_context_expiresAt_idx" ON "wizard_temp_context"("expiresAt");

-- CreateIndex
CREATE INDEX "document_version_documentId_idx" ON "document_version"("documentId");

-- CreateIndex
CREATE INDEX "document_version_version_idx" ON "document_version"("version");

-- CreateIndex
CREATE UNIQUE INDEX "project_rag_settings_projectId_key" ON "project_rag_settings"("projectId");

-- CreateIndex
CREATE INDEX "project_presence_projectId_idx" ON "project_presence"("projectId");

-- CreateIndex
CREATE INDEX "project_presence_lastSeenAt_idx" ON "project_presence"("lastSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "project_presence_projectId_userId_key" ON "project_presence"("projectId", "userId");

-- CreateIndex
CREATE INDEX "project_activity_projectId_idx" ON "project_activity"("projectId");

-- CreateIndex
CREATE INDEX "project_activity_createdAt_idx" ON "project_activity"("createdAt");

-- CreateIndex
CREATE INDEX "project_member_projectId_idx" ON "project_member"("projectId");

-- CreateIndex
CREATE INDEX "project_member_userId_idx" ON "project_member"("userId");

-- CreateIndex
CREATE INDEX "project_member_invitedBy_idx" ON "project_member"("invitedBy");

-- CreateIndex
CREATE UNIQUE INDEX "project_member_projectId_userId_key" ON "project_member"("projectId", "userId");

-- CreateIndex
CREATE INDEX "project_invitation_projectId_idx" ON "project_invitation"("projectId");

-- CreateIndex
CREATE INDEX "project_invitation_email_idx" ON "project_invitation"("email");

-- CreateIndex
CREATE INDEX "project_invitation_status_idx" ON "project_invitation"("status");

-- CreateIndex
CREATE UNIQUE INDEX "project_invitation_projectId_email_key" ON "project_invitation"("projectId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "document_lock_documentId_key" ON "document_lock"("documentId");

-- CreateIndex
CREATE INDEX "document_lock_documentId_idx" ON "document_lock"("documentId");

-- CreateIndex
CREATE INDEX "document_lock_userId_idx" ON "document_lock"("userId");

-- CreateIndex
CREATE INDEX "document_lock_expiresAt_idx" ON "document_lock"("expiresAt");

-- CreateIndex
CREATE INDEX "project_story_status_projectId_idx" ON "project_story_status"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "project_story_status_projectId_name_key" ON "project_story_status"("projectId", "name");

-- CreateIndex
CREATE INDEX "user_story_projectId_idx" ON "user_story"("projectId");

-- CreateIndex
CREATE INDEX "user_story_statusId_idx" ON "user_story"("statusId");

-- CreateIndex
CREATE INDEX "user_story_createdById_idx" ON "user_story"("createdById");

-- CreateIndex
CREATE INDEX "user_story_assigneeId_idx" ON "user_story"("assigneeId");

-- CreateIndex
CREATE INDEX "user_story_pipelineExecutionId_idx" ON "user_story"("pipelineExecutionId");

-- CreateIndex
CREATE INDEX "story_task_storyId_idx" ON "story_task"("storyId");

-- CreateIndex
CREATE INDEX "story_task_assignedAgentId_idx" ON "story_task"("assignedAgentId");

-- CreateIndex
CREATE INDEX "story_task_agentStatus_idx" ON "story_task"("agentStatus");

-- CreateIndex
CREATE INDEX "story_subtask_taskId_idx" ON "story_subtask"("taskId");

-- CreateIndex
CREATE INDEX "task_workflow_plan_taskId_idx" ON "task_workflow_plan"("taskId");

-- CreateIndex
CREATE INDEX "task_workflow_plan_projectId_idx" ON "task_workflow_plan"("projectId");

-- CreateIndex
CREATE INDEX "task_workflow_plan_userId_idx" ON "task_workflow_plan"("userId");

-- CreateIndex
CREATE INDEX "task_workflow_plan_organizationId_idx" ON "task_workflow_plan"("organizationId");

-- CreateIndex
CREATE INDEX "task_workflow_plan_status_idx" ON "task_workflow_plan"("status");

-- CreateIndex
CREATE INDEX "task_workflow_log_planId_idx" ON "task_workflow_log"("planId");

-- CreateIndex
CREATE INDEX "task_workflow_log_stepId_idx" ON "task_workflow_log"("stepId");

-- CreateIndex
CREATE INDEX "MCPServer_userId_idx" ON "MCPServer"("userId");

-- CreateIndex
CREATE INDEX "MCPServer_organizationId_idx" ON "MCPServer"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "MCPServer_key_isSystemProvided_userId_organizationId_key" ON "MCPServer"("key", "isSystemProvided", "userId", "organizationId");

-- CreateIndex
CREATE INDEX "MCPConfig_userId_idx" ON "MCPConfig"("userId");

-- CreateIndex
CREATE INDEX "MCPConfig_organizationId_idx" ON "MCPConfig"("organizationId");

-- CreateIndex
CREATE INDEX "idx_mcp_config_user_org_status" ON "MCPConfig"("userId", "organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MCPConfig_mcpServerId_userId_organizationId_key" ON "MCPConfig"("mcpServerId", "userId", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "MCPOAuthState_state_key" ON "MCPOAuthState"("state");

-- CreateIndex
CREATE INDEX "MCPOAuthState_userId_idx" ON "MCPOAuthState"("userId");

-- CreateIndex
CREATE INDEX "MCPOAuthState_organizationId_idx" ON "MCPOAuthState"("organizationId");

-- CreateIndex
CREATE INDEX "MCPOAuthState_expiresAt_idx" ON "MCPOAuthState"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "MCPClientSession_token_key" ON "MCPClientSession"("token");

-- CreateIndex
CREATE INDEX "MCPClientSession_configId_idx" ON "MCPClientSession"("configId");

-- CreateIndex
CREATE INDEX "MCPClientSession_userId_idx" ON "MCPClientSession"("userId");

-- CreateIndex
CREATE INDEX "MCPClientSession_organizationId_idx" ON "MCPClientSession"("organizationId");

-- CreateIndex
CREATE INDEX "prompt_scope_userId_organizationId_idx" ON "prompt"("scope", "userId", "organizationId");

-- CreateIndex
CREATE INDEX "prompt_category_idx" ON "prompt"("category");

-- CreateIndex
CREATE INDEX "prompt_createdBy_idx" ON "prompt"("createdBy");

-- CreateIndex
CREATE INDEX "prompt_usageCount_idx" ON "prompt"("usageCount");

-- CreateIndex
CREATE INDEX "prompt_voteCount_idx" ON "prompt"("voteCount");

-- CreateIndex
CREATE INDEX "prompt_forkedFromId_idx" ON "prompt"("forkedFromId");

-- CreateIndex
CREATE INDEX "prompt_promptType_idx" ON "prompt"("promptType");

-- CreateIndex
CREATE INDEX "prompt_isFeatured_idx" ON "prompt"("isFeatured");

-- CreateIndex
CREATE INDEX "prompt_isUnlisted_idx" ON "prompt"("isUnlisted");

-- CreateIndex
CREATE INDEX "prompt_deletedAt_idx" ON "prompt"("deletedAt");

-- CreateIndex
CREATE INDEX "prompt_slug_idx" ON "prompt"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "prompt_key_scope_userId_organizationId_key" ON "prompt"("key", "scope", "userId", "organizationId");

-- CreateIndex
CREATE INDEX "prompt_version_promptId_idx" ON "prompt_version"("promptId");

-- CreateIndex
CREATE UNIQUE INDEX "prompt_version_promptId_version_key" ON "prompt_version"("promptId", "version");

-- CreateIndex
CREATE INDEX "prompt_binding_targetType_targetKey_documentType_idx" ON "prompt_binding"("targetType", "targetKey", "documentType");

-- CreateIndex
CREATE INDEX "prompt_binding_scope_userId_organizationId_idx" ON "prompt_binding"("scope", "userId", "organizationId");

-- CreateIndex
CREATE INDEX "prompt_binding_isDefault_idx" ON "prompt_binding"("isDefault");

-- CreateIndex
CREATE UNIQUE INDEX "prompt_binding_targetType_targetKey_documentType_scope_user_key" ON "prompt_binding"("targetType", "targetKey", "documentType", "scope", "userId", "organizationId");

-- CreateIndex
CREATE INDEX "prompt_vote_promptId_idx" ON "prompt_vote"("promptId");

-- CreateIndex
CREATE INDEX "prompt_vote_userId_idx" ON "prompt_vote"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "prompt_vote_userId_promptId_key" ON "prompt_vote"("userId", "promptId");

-- CreateIndex
CREATE UNIQUE INDEX "prompt_tag_name_key" ON "prompt_tag"("name");

-- CreateIndex
CREATE UNIQUE INDEX "prompt_tag_slug_key" ON "prompt_tag"("slug");

-- CreateIndex
CREATE INDEX "prompt_comment_promptId_idx" ON "prompt_comment"("promptId");

-- CreateIndex
CREATE INDEX "prompt_comment_authorId_idx" ON "prompt_comment"("authorId");

-- CreateIndex
CREATE INDEX "prompt_comment_parentId_idx" ON "prompt_comment"("parentId");

-- CreateIndex
CREATE INDEX "prompt_comment_vote_userId_idx" ON "prompt_comment_vote"("userId");

-- CreateIndex
CREATE INDEX "prompt_comment_vote_commentId_idx" ON "prompt_comment_vote"("commentId");

-- CreateIndex
CREATE INDEX "prompt_change_request_promptId_idx" ON "prompt_change_request"("promptId");

-- CreateIndex
CREATE INDEX "prompt_change_request_authorId_idx" ON "prompt_change_request"("authorId");

-- CreateIndex
CREATE INDEX "prompt_change_request_status_idx" ON "prompt_change_request"("status");

-- CreateIndex
CREATE INDEX "prompt_connection_sourceId_idx" ON "prompt_connection"("sourceId");

-- CreateIndex
CREATE INDEX "prompt_connection_targetId_idx" ON "prompt_connection"("targetId");

-- CreateIndex
CREATE UNIQUE INDEX "prompt_connection_sourceId_targetId_key" ON "prompt_connection"("sourceId", "targetId");

-- CreateIndex
CREATE UNIQUE INDEX "document_type_key_key" ON "document_type"("key");

-- CreateIndex
CREATE INDEX "azure_agent_deployment_organizationId_framework_idx" ON "azure_agent_deployment"("organizationId", "framework");

-- CreateIndex
CREATE INDEX "azure_agent_deployment_status_idx" ON "azure_agent_deployment"("status");

-- CreateIndex
CREATE UNIQUE INDEX "azure_agent_deployment_organizationId_azureAgentId_key" ON "azure_agent_deployment"("organizationId", "azureAgentId");

-- CreateIndex
CREATE INDEX "azure_ai_model_deployment_organizationId_isDefault_idx" ON "azure_ai_model_deployment"("organizationId", "isDefault");

-- CreateIndex
CREATE INDEX "azure_ai_model_deployment_status_idx" ON "azure_ai_model_deployment"("status");

-- CreateIndex
CREATE UNIQUE INDEX "azure_ai_model_deployment_organizationId_deploymentName_key" ON "azure_ai_model_deployment"("organizationId", "deploymentName");

-- CreateIndex
CREATE INDEX "cloud_provider_config_organizationId_enabled_idx" ON "cloud_provider_config"("organizationId", "enabled");

-- CreateIndex
CREATE INDEX "cloud_provider_config_organizationId_isDefault_idx" ON "cloud_provider_config"("organizationId", "isDefault");

-- CreateIndex
CREATE INDEX "cloud_provider_config_organizationId_isEmbeddingProvider_idx" ON "cloud_provider_config"("organizationId", "isEmbeddingProvider");

-- CreateIndex
CREATE INDEX "cloud_provider_config_provider_idx" ON "cloud_provider_config"("provider");

-- CreateIndex
CREATE UNIQUE INDEX "cloud_provider_config_organizationId_provider_key" ON "cloud_provider_config"("organizationId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "model_router_config_organizationId_key" ON "model_router_config"("organizationId");

-- CreateIndex
CREATE INDEX "user_cloud_provider_config_provider_idx" ON "user_cloud_provider_config"("provider");

-- CreateIndex
CREATE INDEX "user_cloud_provider_config_userId_enabled_idx" ON "user_cloud_provider_config"("userId", "enabled");

-- CreateIndex
CREATE INDEX "user_cloud_provider_config_userId_isDefault_idx" ON "user_cloud_provider_config"("userId", "isDefault");

-- CreateIndex
CREATE INDEX "user_cloud_provider_config_userId_isEmbeddingProvider_idx" ON "user_cloud_provider_config"("userId", "isEmbeddingProvider");

-- CreateIndex
CREATE UNIQUE INDEX "user_cloud_provider_config_userId_provider_key" ON "user_cloud_provider_config"("userId", "provider");

-- CreateIndex
CREATE INDEX "workflow_userId_idx" ON "workflow"("userId");

-- CreateIndex
CREATE INDEX "workflow_organizationId_idx" ON "workflow"("organizationId");

-- CreateIndex
CREATE INDEX "workflow_status_idx" ON "workflow"("status");

-- CreateIndex
CREATE INDEX "workflow_triggerType_idx" ON "workflow"("triggerType");

-- CreateIndex
CREATE INDEX "workflow_isTemplate_idx" ON "workflow"("isTemplate");

-- CreateIndex
CREATE INDEX "workflow_version_workflowId_idx" ON "workflow_version"("workflowId");

-- CreateIndex
CREATE INDEX "workflow_version_version_idx" ON "workflow_version"("version");

-- CreateIndex
CREATE INDEX "workflow_version_isPublished_idx" ON "workflow_version"("isPublished");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_version_workflowId_version_key" ON "workflow_version"("workflowId", "version");

-- CreateIndex
CREATE INDEX "workflow_execution_workflowId_idx" ON "workflow_execution"("workflowId");

-- CreateIndex
CREATE INDEX "workflow_execution_status_idx" ON "workflow_execution"("status");

-- CreateIndex
CREATE INDEX "workflow_execution_startedAt_idx" ON "workflow_execution"("startedAt");

-- CreateIndex
CREATE INDEX "workflow_execution_userId_idx" ON "workflow_execution"("userId");

-- CreateIndex
CREATE INDEX "workflow_execution_organizationId_idx" ON "workflow_execution"("organizationId");

-- CreateIndex
CREATE INDEX "workflow_execution_pipelineId_idx" ON "workflow_execution"("pipelineId");

-- CreateIndex
CREATE INDEX "workflow_execution_log_executionId_idx" ON "workflow_execution_log"("executionId");

-- CreateIndex
CREATE INDEX "workflow_execution_log_nodeId_idx" ON "workflow_execution_log"("nodeId");

-- CreateIndex
CREATE INDEX "workflow_execution_log_status_idx" ON "workflow_execution_log"("status");

-- CreateIndex
CREATE INDEX "workflow_integration_workflowId_idx" ON "workflow_integration"("workflowId");

-- CreateIndex
CREATE INDEX "workflow_integration_userId_idx" ON "workflow_integration"("userId");

-- CreateIndex
CREATE INDEX "workflow_integration_organizationId_idx" ON "workflow_integration"("organizationId");

-- CreateIndex
CREATE INDEX "workflow_integration_provider_idx" ON "workflow_integration"("provider");

-- CreateIndex
CREATE INDEX "workflow_api_key_workflowId_idx" ON "workflow_api_key"("workflowId");

-- CreateIndex
CREATE INDEX "workflow_api_key_keyPrefix_idx" ON "workflow_api_key"("keyPrefix");

-- CreateIndex
CREATE INDEX "workflow_api_key_isActive_idx" ON "workflow_api_key"("isActive");

-- CreateIndex
CREATE INDEX "browser_task_userId_idx" ON "browser_task"("userId");

-- CreateIndex
CREATE INDEX "browser_task_organizationId_idx" ON "browser_task"("organizationId");

-- CreateIndex
CREATE INDEX "browser_task_status_idx" ON "browser_task"("status");

-- CreateIndex
CREATE INDEX "browser_task_workflowId_idx" ON "browser_task"("workflowId");

-- CreateIndex
CREATE INDEX "automation_template_userId_idx" ON "automation_template"("userId");

-- CreateIndex
CREATE INDEX "automation_template_organizationId_idx" ON "automation_template"("organizationId");

-- CreateIndex
CREATE INDEX "automation_template_category_idx" ON "automation_template"("category");

-- CreateIndex
CREATE INDEX "automation_template_isPublic_idx" ON "automation_template"("isPublic");

-- CreateIndex
CREATE INDEX "openapi_service_userId_idx" ON "openapi_service"("userId");

-- CreateIndex
CREATE INDEX "openapi_service_organizationId_idx" ON "openapi_service"("organizationId");

-- CreateIndex
CREATE INDEX "openapi_service_status_idx" ON "openapi_service"("status");

-- CreateIndex
CREATE INDEX "openapi_service_category_idx" ON "openapi_service"("category");

-- CreateIndex
CREATE UNIQUE INDEX "openapi_service_specUrl_userId_organizationId_key" ON "openapi_service"("specUrl", "userId", "organizationId");

-- CreateIndex
CREATE INDEX "openapi_tool_serviceId_idx" ON "openapi_tool"("serviceId");

-- CreateIndex
CREATE INDEX "openapi_tool_method_idx" ON "openapi_tool"("method");

-- CreateIndex
CREATE INDEX "openapi_tool_useCount_idx" ON "openapi_tool"("useCount");

-- CreateIndex
CREATE INDEX "openapi_tool_enabled_idx" ON "openapi_tool"("enabled");

-- CreateIndex
CREATE UNIQUE INDEX "openapi_tool_serviceId_operationId_key" ON "openapi_tool"("serviceId", "operationId");

-- CreateIndex
CREATE INDEX "openapi_service_config_userId_idx" ON "openapi_service_config"("userId");

-- CreateIndex
CREATE INDEX "openapi_service_config_organizationId_idx" ON "openapi_service_config"("organizationId");

-- CreateIndex
CREATE INDEX "openapi_service_config_enabled_idx" ON "openapi_service_config"("enabled");

-- CreateIndex
CREATE UNIQUE INDEX "openapi_service_config_serviceId_userId_organizationId_key" ON "openapi_service_config"("serviceId", "userId", "organizationId");

-- CreateIndex
CREATE INDEX "agent_workspace_file_conversationId_idx" ON "agent_workspace_file"("conversationId");

-- CreateIndex
CREATE INDEX "agent_workspace_file_userId_idx" ON "agent_workspace_file"("userId");

-- CreateIndex
CREATE INDEX "agent_workspace_file_organizationId_idx" ON "agent_workspace_file"("organizationId");

-- CreateIndex
CREATE INDEX "agent_workspace_file_path_idx" ON "agent_workspace_file"("path");

-- CreateIndex
CREATE INDEX "agent_workspace_file_fileType_idx" ON "agent_workspace_file"("fileType");

-- CreateIndex
CREATE INDEX "agent_workspace_file_status_idx" ON "agent_workspace_file"("status");

-- CreateIndex
CREATE INDEX "agent_workspace_file_createdAt_idx" ON "agent_workspace_file"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "agent_workspace_file_userId_organizationId_path_key" ON "agent_workspace_file"("userId", "organizationId", "path");

-- CreateIndex
CREATE INDEX "workspace_userId_idx" ON "workspace"("userId");

-- CreateIndex
CREATE INDEX "workspace_organizationId_idx" ON "workspace"("organizationId");

-- CreateIndex
CREATE INDEX "workspace_status_idx" ON "workspace"("status");

-- CreateIndex
CREATE INDEX "workspace_type_idx" ON "workspace"("type");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_userId_organizationId_type_key" ON "workspace"("userId", "organizationId", "type");

-- CreateIndex
CREATE INDEX "workspace_document_workspaceId_idx" ON "workspace_document"("workspaceId");

-- CreateIndex
CREATE INDEX "workspace_document_status_idx" ON "workspace_document"("status");

-- CreateIndex
CREATE INDEX "workspace_document_workflowId_idx" ON "workspace_document"("workflowId");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_document_chunk_qdrantId_key" ON "workspace_document_chunk"("qdrantId");

-- CreateIndex
CREATE INDEX "workspace_document_chunk_documentId_idx" ON "workspace_document_chunk"("documentId");

-- CreateIndex
CREATE INDEX "workspace_document_chunk_qdrantId_idx" ON "workspace_document_chunk"("qdrantId");

-- CreateIndex
CREATE INDEX "workspace_administrator_workspaceId_idx" ON "workspace_administrator"("workspaceId");

-- CreateIndex
CREATE INDEX "workspace_administrator_userId_idx" ON "workspace_administrator"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_administrator_workspaceId_userId_key" ON "workspace_administrator"("workspaceId", "userId");

-- CreateIndex
CREATE INDEX "workspace_contributor_workspaceId_idx" ON "workspace_contributor"("workspaceId");

-- CreateIndex
CREATE INDEX "workspace_contributor_userId_idx" ON "workspace_contributor"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_contributor_workspaceId_userId_key" ON "workspace_contributor"("workspaceId", "userId");

-- CreateIndex
CREATE INDEX "workspace_stakeholder_workspaceId_idx" ON "workspace_stakeholder"("workspaceId");

-- CreateIndex
CREATE INDEX "workspace_stakeholder_userId_idx" ON "workspace_stakeholder"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_stakeholder_workspaceId_userId_key" ON "workspace_stakeholder"("workspaceId", "userId");

-- CreateIndex
CREATE INDEX "workspace_agent_workspaceId_idx" ON "workspace_agent"("workspaceId");

-- CreateIndex
CREATE INDEX "workspace_agent_agentId_idx" ON "workspace_agent"("agentId");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_agent_workspaceId_agentId_key" ON "workspace_agent"("workspaceId", "agentId");

-- CreateIndex
CREATE INDEX "workspace_conversation_conversationId_idx" ON "workspace_conversation"("conversationId");

-- CreateIndex
CREATE INDEX "workspace_conversation_workspaceId_idx" ON "workspace_conversation"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_conversation_workspaceId_conversationId_key" ON "workspace_conversation"("workspaceId", "conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_rag_settings_workspaceId_key" ON "workspace_rag_settings"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ai_model_canonicalName_key" ON "ai_model"("canonicalName");

-- CreateIndex
CREATE INDEX "ai_model_canonicalName_idx" ON "ai_model"("canonicalName");

-- CreateIndex
CREATE INDEX "ai_model_family_idx" ON "ai_model"("family");

-- CreateIndex
CREATE INDEX "ai_model_isActive_idx" ON "ai_model"("isActive");

-- CreateIndex
CREATE INDEX "ai_model_speedTier_idx" ON "ai_model"("speedTier");

-- CreateIndex
CREATE INDEX "ai_model_qualityTier_idx" ON "ai_model"("qualityTier");

-- CreateIndex
CREATE INDEX "ai_model_provider_mapping_provider_idx" ON "ai_model_provider_mapping"("provider");

-- CreateIndex
CREATE INDEX "ai_model_provider_mapping_providerModelId_idx" ON "ai_model_provider_mapping"("providerModelId");

-- CreateIndex
CREATE INDEX "ai_model_provider_mapping_isAvailable_idx" ON "ai_model_provider_mapping"("isAvailable");

-- CreateIndex
CREATE UNIQUE INDEX "ai_model_provider_mapping_modelId_provider_key" ON "ai_model_provider_mapping"("modelId", "provider");

-- CreateIndex
CREATE INDEX "ai_task_model_default_taskType_idx" ON "ai_task_model_default"("taskType");

-- CreateIndex
CREATE INDEX "ai_task_model_default_taskType_complexity_idx" ON "ai_task_model_default"("taskType", "complexity");

-- CreateIndex
CREATE INDEX "ai_task_model_default_provider_idx" ON "ai_task_model_default"("provider");

-- CreateIndex
CREATE UNIQUE INDEX "ai_task_model_default_taskType_complexity_provider_key" ON "ai_task_model_default"("taskType", "complexity", "provider");

-- CreateIndex
CREATE INDEX "user_model_preference_userId_idx" ON "user_model_preference"("userId");

-- CreateIndex
CREATE INDEX "user_model_preference_userId_provider_idx" ON "user_model_preference"("userId", "provider");

-- CreateIndex
CREATE INDEX "user_model_preference_taskType_idx" ON "user_model_preference"("taskType");

-- CreateIndex
CREATE UNIQUE INDEX "user_model_preference_userId_taskType_provider_key" ON "user_model_preference"("userId", "taskType", "provider");

-- CreateIndex
CREATE INDEX "user_orchestrator_preferences_userId_idx" ON "user_orchestrator_preferences"("userId");

-- CreateIndex
CREATE INDEX "user_orchestrator_preferences_organizationId_idx" ON "user_orchestrator_preferences"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "user_orchestrator_preferences_userId_organizationId_key" ON "user_orchestrator_preferences"("userId", "organizationId");

-- CreateIndex
CREATE INDEX "organization_model_preference_organizationId_idx" ON "organization_model_preference"("organizationId");

-- CreateIndex
CREATE INDEX "organization_model_preference_organizationId_provider_idx" ON "organization_model_preference"("organizationId", "provider");

-- CreateIndex
CREATE INDEX "organization_model_preference_taskType_idx" ON "organization_model_preference"("taskType");

-- CreateIndex
CREATE UNIQUE INDEX "organization_model_preference_organizationId_taskType_provi_key" ON "organization_model_preference"("organizationId", "taskType", "provider");

-- CreateIndex
CREATE INDEX "approval_template_userId_idx" ON "approval_template"("userId");

-- CreateIndex
CREATE INDEX "approval_template_organizationId_idx" ON "approval_template"("organizationId");

-- CreateIndex
CREATE INDEX "approval_template_scope_idx" ON "approval_template"("scope");

-- CreateIndex
CREATE INDEX "approval_template_isActive_idx" ON "approval_template"("isActive");

-- CreateIndex
CREATE INDEX "ai_usage_log_userId_createdAt_idx" ON "ai_usage_log"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ai_usage_log_organizationId_createdAt_idx" ON "ai_usage_log"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "ai_usage_log_provider_createdAt_idx" ON "ai_usage_log"("provider", "createdAt");

-- CreateIndex
CREATE INDEX "ai_usage_log_modelCanonicalName_idx" ON "ai_usage_log"("modelCanonicalName");

-- CreateIndex
CREATE INDEX "ai_usage_log_taskType_idx" ON "ai_usage_log"("taskType");

-- CreateIndex
CREATE INDEX "ai_usage_log_agentId_idx" ON "ai_usage_log"("agentId");

-- CreateIndex
CREATE INDEX "report_template_userId_idx" ON "report_template"("userId");

-- CreateIndex
CREATE INDEX "report_template_organizationId_idx" ON "report_template"("organizationId");

-- CreateIndex
CREATE INDEX "report_template_templateType_idx" ON "report_template"("templateType");

-- CreateIndex
CREATE INDEX "report_template_category_idx" ON "report_template"("category");

-- CreateIndex
CREATE INDEX "report_template_scope_idx" ON "report_template"("scope");

-- CreateIndex
CREATE INDEX "report_template_isPublic_idx" ON "report_template"("isPublic");

-- CreateIndex
CREATE INDEX "template_instance_templateId_idx" ON "template_instance"("templateId");

-- CreateIndex
CREATE INDEX "template_instance_userId_idx" ON "template_instance"("userId");

-- CreateIndex
CREATE INDEX "template_instance_organizationId_idx" ON "template_instance"("organizationId");

-- CreateIndex
CREATE INDEX "template_instance_isActive_idx" ON "template_instance"("isActive");

-- CreateIndex
CREATE INDEX "template_instance_nextRunAt_idx" ON "template_instance"("nextRunAt");

-- CreateIndex
CREATE INDEX "template_instance_execution_instanceId_idx" ON "template_instance_execution"("instanceId");

-- CreateIndex
CREATE INDEX "template_instance_execution_userId_idx" ON "template_instance_execution"("userId");

-- CreateIndex
CREATE INDEX "template_instance_execution_organizationId_idx" ON "template_instance_execution"("organizationId");

-- CreateIndex
CREATE INDEX "template_instance_execution_status_idx" ON "template_instance_execution"("status");

-- CreateIndex
CREATE INDEX "template_instance_execution_workflowId_idx" ON "template_instance_execution"("workflowId");

-- CreateIndex
CREATE INDEX "template_instance_execution_createdAt_idx" ON "template_instance_execution"("createdAt");

-- CreateIndex
CREATE INDEX "template_instance_artifact_executionId_idx" ON "template_instance_artifact"("executionId");

-- CreateIndex
CREATE INDEX "template_instance_artifact_userId_idx" ON "template_instance_artifact"("userId");

-- CreateIndex
CREATE INDEX "template_instance_artifact_organizationId_idx" ON "template_instance_artifact"("organizationId");

-- CreateIndex
CREATE INDEX "template_instance_artifact_artifactType_idx" ON "template_instance_artifact"("artifactType");

-- CreateIndex
CREATE INDEX "template_instance_artifact_qdrantId_idx" ON "template_instance_artifact"("qdrantId");

-- CreateIndex
CREATE UNIQUE INDEX "template_instance_artifact_chunk_qdrantId_key" ON "template_instance_artifact_chunk"("qdrantId");

-- CreateIndex
CREATE INDEX "template_instance_artifact_chunk_artifactId_idx" ON "template_instance_artifact_chunk"("artifactId");

-- CreateIndex
CREATE INDEX "template_instance_artifact_chunk_qdrantId_idx" ON "template_instance_artifact_chunk"("qdrantId");

-- CreateIndex
CREATE INDEX "report_execution_templateId_idx" ON "report_execution"("templateId");

-- CreateIndex
CREATE INDEX "report_execution_userId_idx" ON "report_execution"("userId");

-- CreateIndex
CREATE INDEX "report_execution_organizationId_idx" ON "report_execution"("organizationId");

-- CreateIndex
CREATE INDEX "report_execution_status_idx" ON "report_execution"("status");

-- CreateIndex
CREATE INDEX "report_execution_workflowId_idx" ON "report_execution"("workflowId");

-- CreateIndex
CREATE INDEX "report_execution_createdAt_idx" ON "report_execution"("createdAt");

-- CreateIndex
CREATE INDEX "report_artifact_executionId_idx" ON "report_artifact"("executionId");

-- CreateIndex
CREATE INDEX "report_artifact_templateId_idx" ON "report_artifact"("templateId");

-- CreateIndex
CREATE INDEX "report_artifact_userId_idx" ON "report_artifact"("userId");

-- CreateIndex
CREATE INDEX "report_artifact_organizationId_idx" ON "report_artifact"("organizationId");

-- CreateIndex
CREATE INDEX "report_artifact_artifactType_idx" ON "report_artifact"("artifactType");

-- CreateIndex
CREATE INDEX "report_artifact_qdrantId_idx" ON "report_artifact"("qdrantId");

-- CreateIndex
CREATE UNIQUE INDEX "report_artifact_chunk_qdrantId_key" ON "report_artifact_chunk"("qdrantId");

-- CreateIndex
CREATE INDEX "report_artifact_chunk_artifactId_idx" ON "report_artifact_chunk"("artifactId");

-- CreateIndex
CREATE INDEX "report_artifact_chunk_qdrantId_idx" ON "report_artifact_chunk"("qdrantId");

-- CreateIndex
CREATE UNIQUE INDEX "agent_template_slug_key" ON "agent_template"("slug");

-- CreateIndex
CREATE INDEX "agent_template_category_idx" ON "agent_template"("category");

-- CreateIndex
CREATE INDEX "agent_template_scope_idx" ON "agent_template"("scope");

-- CreateIndex
CREATE INDEX "agent_template_userId_idx" ON "agent_template"("userId");

-- CreateIndex
CREATE INDEX "agent_template_organizationId_idx" ON "agent_template"("organizationId");

-- CreateIndex
CREATE INDEX "agent_template_isPublished_idx" ON "agent_template"("isPublished");

-- CreateIndex
CREATE INDEX "agent_template_isFeatured_idx" ON "agent_template"("isFeatured");

-- CreateIndex
CREATE INDEX "agent_template_instance_templateId_idx" ON "agent_template_instance"("templateId");

-- CreateIndex
CREATE INDEX "agent_template_instance_userId_idx" ON "agent_template_instance"("userId");

-- CreateIndex
CREATE INDEX "agent_template_instance_organizationId_idx" ON "agent_template_instance"("organizationId");

-- CreateIndex
CREATE INDEX "agent_template_instance_isActive_idx" ON "agent_template_instance"("isActive");

-- CreateIndex
CREATE INDEX "agent_template_conversation_instanceId_idx" ON "agent_template_conversation"("instanceId");

-- CreateIndex
CREATE INDEX "agent_template_conversation_userId_idx" ON "agent_template_conversation"("userId");

-- CreateIndex
CREATE INDEX "agent_template_conversation_organizationId_idx" ON "agent_template_conversation"("organizationId");

-- CreateIndex
CREATE INDEX "agent_template_conversation_isPinned_idx" ON "agent_template_conversation"("isPinned");

-- CreateIndex
CREATE INDEX "agent_template_conversation_createdAt_idx" ON "agent_template_conversation"("createdAt");

-- CreateIndex
CREATE INDEX "agent_template_execution_instanceId_idx" ON "agent_template_execution"("instanceId");

-- CreateIndex
CREATE INDEX "agent_template_execution_userId_idx" ON "agent_template_execution"("userId");

-- CreateIndex
CREATE INDEX "agent_template_execution_organizationId_idx" ON "agent_template_execution"("organizationId");

-- CreateIndex
CREATE INDEX "agent_template_execution_status_idx" ON "agent_template_execution"("status");

-- CreateIndex
CREATE INDEX "agent_template_execution_triggerType_idx" ON "agent_template_execution"("triggerType");

-- CreateIndex
CREATE INDEX "agent_template_execution_workflowId_idx" ON "agent_template_execution"("workflowId");

-- CreateIndex
CREATE INDEX "agent_template_execution_createdAt_idx" ON "agent_template_execution"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "agent_deployment_instanceId_key" ON "agent_deployment"("instanceId");

-- CreateIndex
CREATE INDEX "agent_deployment_status_idx" ON "agent_deployment"("status");

-- CreateIndex
CREATE INDEX "agent_deployment_taskQueue_idx" ON "agent_deployment"("taskQueue");

-- CreateIndex
CREATE INDEX "agent_deployment_healthStatus_idx" ON "agent_deployment"("healthStatus");

-- CreateIndex
CREATE INDEX "agent_deployment_userId_idx" ON "agent_deployment"("userId");

-- CreateIndex
CREATE INDEX "agent_deployment_organizationId_idx" ON "agent_deployment"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "agent_deployment_userId_slug_key" ON "agent_deployment"("userId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "agent_deployment_organizationId_slug_key" ON "agent_deployment"("organizationId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "agent_deployment_execution_executionId_key" ON "agent_deployment_execution"("executionId");

-- CreateIndex
CREATE INDEX "agent_deployment_execution_deploymentId_idx" ON "agent_deployment_execution"("deploymentId");

-- CreateIndex
CREATE INDEX "agent_deployment_execution_status_idx" ON "agent_deployment_execution"("status");

-- CreateIndex
CREATE INDEX "agent_deployment_execution_triggerType_idx" ON "agent_deployment_execution"("triggerType");

-- CreateIndex
CREATE INDEX "agent_deployment_execution_priority_idx" ON "agent_deployment_execution"("priority");

-- CreateIndex
CREATE INDEX "agent_deployment_execution_queuedAt_idx" ON "agent_deployment_execution"("queuedAt");

-- CreateIndex
CREATE INDEX "agent_deployment_execution_userId_idx" ON "agent_deployment_execution"("userId");

-- CreateIndex
CREATE INDEX "agent_deployment_execution_organizationId_idx" ON "agent_deployment_execution"("organizationId");

-- CreateIndex
CREATE INDEX "agent_execution_step_executionId_idx" ON "agent_execution_step"("executionId");

-- CreateIndex
CREATE INDEX "agent_execution_step_stepType_idx" ON "agent_execution_step"("stepType");

-- CreateIndex
CREATE INDEX "agent_deployment_trigger_type_idx" ON "agent_deployment_trigger"("type");

-- CreateIndex
CREATE INDEX "agent_deployment_trigger_isActive_idx" ON "agent_deployment_trigger"("isActive");

-- CreateIndex
CREATE INDEX "agent_deployment_trigger_nextRunAt_idx" ON "agent_deployment_trigger"("nextRunAt");

-- CreateIndex
CREATE UNIQUE INDEX "agent_deployment_trigger_deploymentId_type_slackChannelId_key" ON "agent_deployment_trigger"("deploymentId", "type", "slackChannelId");

-- CreateIndex
CREATE INDEX "agent_deployment_metrics_deploymentId_idx" ON "agent_deployment_metrics"("deploymentId");

-- CreateIndex
CREATE INDEX "agent_deployment_metrics_windowStart_idx" ON "agent_deployment_metrics"("windowStart");

-- CreateIndex
CREATE UNIQUE INDEX "agent_deployment_metrics_deploymentId_windowStart_windowTyp_key" ON "agent_deployment_metrics"("deploymentId", "windowStart", "windowType");

-- CreateIndex
CREATE UNIQUE INDEX "task_queue_shard_queueName_key" ON "task_queue_shard"("queueName");

-- CreateIndex
CREATE INDEX "task_queue_shard_shardType_idx" ON "task_queue_shard"("shardType");

-- CreateIndex
CREATE INDEX "task_queue_shard_organizationId_idx" ON "task_queue_shard"("organizationId");

-- CreateIndex
CREATE INDEX "task_queue_shard_isHealthy_idx" ON "task_queue_shard"("isHealthy");

-- CreateIndex
CREATE UNIQUE INDEX "organization_deployment_quota_organizationId_key" ON "organization_deployment_quota"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "user_deployment_quota_userId_key" ON "user_deployment_quota"("userId");

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "passkey" ADD CONSTRAINT "passkey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "twoFactor" ADD CONSTRAINT "twoFactor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_rag_settings" ADD CONSTRAINT "organization_rag_settings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member" ADD CONSTRAINT "member_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member" ADD CONSTRAINT "member_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_inviterId_fkey" FOREIGN KEY ("inviterId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase" ADD CONSTRAINT "purchase_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase" ADD CONSTRAINT "purchase_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_chat" ADD CONSTRAINT "ai_chat_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_chat" ADD CONSTRAINT "ai_chat_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_document" ADD CONSTRAINT "chat_document_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "ai_chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_document" ADD CONSTRAINT "chat_document_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_document" ADD CONSTRAINT "chat_document_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_chunk" ADD CONSTRAINT "document_chunk_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "ai_chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_chunk" ADD CONSTRAINT "document_chunk_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "chat_document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_rag_provider" ADD CONSTRAINT "organization_rag_provider_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_search_provider" ADD CONSTRAINT "organization_search_provider_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_rag_provider" ADD CONSTRAINT "user_rag_provider_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_search_provider" ADD CONSTRAINT "user_search_provider_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_api_key" ADD CONSTRAINT "user_api_key_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_api_key" ADD CONSTRAINT "organization_api_key_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_api_key" ADD CONSTRAINT "organization_api_key_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent" ADD CONSTRAINT "agent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent" ADD CONSTRAINT "agent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_task" ADD CONSTRAINT "agent_task_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_task" ADD CONSTRAINT "agent_task_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_approval" ADD CONSTRAINT "agent_approval_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "agent_task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_approval" ADD CONSTRAINT "agent_approval_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registered_agent" ADD CONSTRAINT "registered_agent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registered_agent" ADD CONSTRAINT "registered_agent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_conversation" ADD CONSTRAINT "agent_conversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_conversation" ADD CONSTRAINT "agent_conversation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sdlc_artifact" ADD CONSTRAINT "sdlc_artifact_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sdlc_artifact" ADD CONSTRAINT "sdlc_artifact_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "agent_task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sdlc_pipeline" ADD CONSTRAINT "sdlc_pipeline_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sdlc_pipeline" ADD CONSTRAINT "sdlc_pipeline_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project" ADD CONSTRAINT "project_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project" ADD CONSTRAINT "project_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_document" ADD CONSTRAINT "project_document_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_context" ADD CONSTRAINT "project_context_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wizard_temp_context" ADD CONSTRAINT "wizard_temp_context_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wizard_temp_context" ADD CONSTRAINT "wizard_temp_context_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_version" ADD CONSTRAINT "document_version_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "project_document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_rag_settings" ADD CONSTRAINT "project_rag_settings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_presence" ADD CONSTRAINT "project_presence_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_activity" ADD CONSTRAINT "project_activity_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_member" ADD CONSTRAINT "project_member_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_invitation" ADD CONSTRAINT "project_invitation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_lock" ADD CONSTRAINT "document_lock_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "project_document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_story_status" ADD CONSTRAINT "project_story_status_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_story" ADD CONSTRAINT "user_story_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_story" ADD CONSTRAINT "user_story_statusId_fkey" FOREIGN KEY ("statusId") REFERENCES "project_story_status"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_task" ADD CONSTRAINT "story_task_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "user_story"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_subtask" ADD CONSTRAINT "story_subtask_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "story_task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_workflow_plan" ADD CONSTRAINT "task_workflow_plan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_workflow_plan" ADD CONSTRAINT "task_workflow_plan_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_workflow_log" ADD CONSTRAINT "task_workflow_log_planId_fkey" FOREIGN KEY ("planId") REFERENCES "task_workflow_plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MCPServer" ADD CONSTRAINT "MCPServer_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MCPServer" ADD CONSTRAINT "MCPServer_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MCPServer" ADD CONSTRAINT "MCPServer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MCPConfig" ADD CONSTRAINT "MCPConfig_mcpServerId_fkey" FOREIGN KEY ("mcpServerId") REFERENCES "MCPServer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MCPConfig" ADD CONSTRAINT "MCPConfig_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MCPConfig" ADD CONSTRAINT "MCPConfig_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MCPOAuthState" ADD CONSTRAINT "MCPOAuthState_configId_fkey" FOREIGN KEY ("configId") REFERENCES "MCPConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MCPOAuthState" ADD CONSTRAINT "MCPOAuthState_mcpServerId_fkey" FOREIGN KEY ("mcpServerId") REFERENCES "MCPServer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MCPClientSession" ADD CONSTRAINT "MCPClientSession_configId_fkey" FOREIGN KEY ("configId") REFERENCES "MCPConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt" ADD CONSTRAINT "prompt_forkedFromId_fkey" FOREIGN KEY ("forkedFromId") REFERENCES "prompt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt" ADD CONSTRAINT "prompt_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt" ADD CONSTRAINT "prompt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_version" ADD CONSTRAINT "prompt_version_promptId_fkey" FOREIGN KEY ("promptId") REFERENCES "prompt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_binding" ADD CONSTRAINT "prompt_binding_promptVersionId_fkey" FOREIGN KEY ("promptVersionId") REFERENCES "prompt_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_vote" ADD CONSTRAINT "prompt_vote_promptId_fkey" FOREIGN KEY ("promptId") REFERENCES "prompt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_tag_relation" ADD CONSTRAINT "prompt_tag_relation_promptId_fkey" FOREIGN KEY ("promptId") REFERENCES "prompt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_tag_relation" ADD CONSTRAINT "prompt_tag_relation_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "prompt_tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_comment" ADD CONSTRAINT "prompt_comment_promptId_fkey" FOREIGN KEY ("promptId") REFERENCES "prompt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_comment" ADD CONSTRAINT "prompt_comment_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "prompt_comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_comment_vote" ADD CONSTRAINT "prompt_comment_vote_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "prompt_comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_change_request" ADD CONSTRAINT "prompt_change_request_promptId_fkey" FOREIGN KEY ("promptId") REFERENCES "prompt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_connection" ADD CONSTRAINT "prompt_connection_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "prompt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_connection" ADD CONSTRAINT "prompt_connection_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "prompt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "azure_agent_deployment" ADD CONSTRAINT "azure_agent_deployment_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "azure_agent_deployment" ADD CONSTRAINT "azure_agent_deployment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "azure_ai_model_deployment" ADD CONSTRAINT "azure_ai_model_deployment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cloud_provider_config" ADD CONSTRAINT "cloud_provider_config_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_cloud_provider_config" ADD CONSTRAINT "user_cloud_provider_config_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow" ADD CONSTRAINT "workflow_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow" ADD CONSTRAINT "workflow_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow" ADD CONSTRAINT "workflow_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "workflow"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_version" ADD CONSTRAINT "workflow_version_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_execution" ADD CONSTRAINT "workflow_execution_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_execution_log" ADD CONSTRAINT "workflow_execution_log_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "workflow_execution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_integration" ADD CONSTRAINT "workflow_integration_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_api_key" ADD CONSTRAINT "workflow_api_key_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "browser_task" ADD CONSTRAINT "browser_task_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "browser_task" ADD CONSTRAINT "browser_task_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_template" ADD CONSTRAINT "automation_template_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_template" ADD CONSTRAINT "automation_template_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "openapi_service" ADD CONSTRAINT "openapi_service_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "openapi_service" ADD CONSTRAINT "openapi_service_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "openapi_service" ADD CONSTRAINT "openapi_service_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "openapi_tool" ADD CONSTRAINT "openapi_tool_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "openapi_service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "openapi_service_config" ADD CONSTRAINT "openapi_service_config_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "openapi_service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "openapi_service_config" ADD CONSTRAINT "openapi_service_config_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "openapi_service_config" ADD CONSTRAINT "openapi_service_config_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_workspace_file" ADD CONSTRAINT "agent_workspace_file_previousVersionId_fkey" FOREIGN KEY ("previousVersionId") REFERENCES "agent_workspace_file"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_document" ADD CONSTRAINT "workspace_document_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_document" ADD CONSTRAINT "workspace_document_uploadedBy_fkey" FOREIGN KEY ("uploadedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_document_chunk" ADD CONSTRAINT "workspace_document_chunk_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "workspace_document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_administrator" ADD CONSTRAINT "workspace_administrator_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_administrator" ADD CONSTRAINT "workspace_administrator_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_administrator" ADD CONSTRAINT "workspace_administrator_addedBy_fkey" FOREIGN KEY ("addedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_contributor" ADD CONSTRAINT "workspace_contributor_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_contributor" ADD CONSTRAINT "workspace_contributor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_contributor" ADD CONSTRAINT "workspace_contributor_addedBy_fkey" FOREIGN KEY ("addedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_stakeholder" ADD CONSTRAINT "workspace_stakeholder_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_stakeholder" ADD CONSTRAINT "workspace_stakeholder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_stakeholder" ADD CONSTRAINT "workspace_stakeholder_addedBy_fkey" FOREIGN KEY ("addedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_agent" ADD CONSTRAINT "workspace_agent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_agent" ADD CONSTRAINT "workspace_agent_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_agent" ADD CONSTRAINT "workspace_agent_addedBy_fkey" FOREIGN KEY ("addedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_conversation" ADD CONSTRAINT "workspace_conversation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_conversation" ADD CONSTRAINT "workspace_conversation_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "agent_conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_conversation" ADD CONSTRAINT "workspace_conversation_attachedBy_fkey" FOREIGN KEY ("attachedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_rag_settings" ADD CONSTRAINT "workspace_rag_settings_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_model_provider_mapping" ADD CONSTRAINT "ai_model_provider_mapping_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "ai_model"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_task_model_default" ADD CONSTRAINT "ai_task_model_default_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "ai_model"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_model_preference" ADD CONSTRAINT "user_model_preference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_model_preference" ADD CONSTRAINT "user_model_preference_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "ai_model"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_orchestrator_preferences" ADD CONSTRAINT "user_orchestrator_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_model_preference" ADD CONSTRAINT "organization_model_preference_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_model_preference" ADD CONSTRAINT "organization_model_preference_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "ai_model"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_template" ADD CONSTRAINT "approval_template_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_template" ADD CONSTRAINT "report_template_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_template" ADD CONSTRAINT "report_template_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_instance" ADD CONSTRAINT "template_instance_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "report_template"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_instance" ADD CONSTRAINT "template_instance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_instance" ADD CONSTRAINT "template_instance_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_instance_execution" ADD CONSTRAINT "template_instance_execution_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "template_instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_instance_artifact" ADD CONSTRAINT "template_instance_artifact_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "template_instance_execution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_instance_artifact_chunk" ADD CONSTRAINT "template_instance_artifact_chunk_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "template_instance_artifact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_execution" ADD CONSTRAINT "report_execution_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "report_template"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_artifact" ADD CONSTRAINT "report_artifact_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "report_execution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_artifact" ADD CONSTRAINT "report_artifact_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "report_template"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_artifact_chunk" ADD CONSTRAINT "report_artifact_chunk_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "report_artifact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_template" ADD CONSTRAINT "agent_template_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_template" ADD CONSTRAINT "agent_template_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_template_instance" ADD CONSTRAINT "agent_template_instance_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "agent_template"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_template_instance" ADD CONSTRAINT "agent_template_instance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_template_instance" ADD CONSTRAINT "agent_template_instance_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_template_conversation" ADD CONSTRAINT "agent_template_conversation_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "agent_template_instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_template_execution" ADD CONSTRAINT "agent_template_execution_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "agent_template_instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_deployment" ADD CONSTRAINT "agent_deployment_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "agent_template_instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_deployment" ADD CONSTRAINT "agent_deployment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_deployment" ADD CONSTRAINT "agent_deployment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_deployment_execution" ADD CONSTRAINT "agent_deployment_execution_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "agent_deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_execution_step" ADD CONSTRAINT "agent_execution_step_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "agent_deployment_execution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_deployment_trigger" ADD CONSTRAINT "agent_deployment_trigger_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "agent_deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_deployment_metrics" ADD CONSTRAINT "agent_deployment_metrics_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "agent_deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_deployment_quota" ADD CONSTRAINT "organization_deployment_quota_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_deployment_quota" ADD CONSTRAINT "user_deployment_quota_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

