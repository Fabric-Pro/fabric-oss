/**
 * Tenant-Isolated Database Client
 *
 * This module provides a Prisma client extension that automatically:
 * 1. Applies tenant isolation filters to all queries (application-level)
 * 2. Sets RLS session variables before queries (database-level)
 *
 * This provides defense-in-depth: even if the application filter is bypassed,
 * the database RLS policies will still enforce isolation.
 *
 * Connection Pooling Safety (Neon/PgBouncer Compatible):
 * - Uses transaction-local settings (set_config with is_local=true)
 * - All tenant-aware queries are wrapped in $transaction()
 * - Variables automatically reset when transaction ends
 * - No risk of tenant context leaking between pooled connections
 *
 * Usage:
 *   import { getTenantDb } from './tenant-db';
 *
 *   // In a request handler with tenant context already set:
 *   const tenantDb = getTenantDb();
 *   const configs = await tenantDb.mCPConfig.findMany(); // Automatically filtered!
 */

import type { Prisma, PrismaClient } from "../prisma/generated/client";
import { getTenantContext, hasTenantContext } from "./tenant-context";

// ============================================================================
// Configuration
// ============================================================================

/**
 * Tables that require strict tenant isolation (both userId and organizationId optional).
 * These tables can belong to either a user OR an organization, never both.
 * Records have EITHER userId OR organizationId set, not both.
 */
const STRICT_ISOLATION_TABLES = new Set([
	"Purchase", // Purchases belong to either user OR org, not both
	"AiCreditAccount", // Credit usage belongs to either user OR org, not both
	"AuthoritySession", // Runtime authority sessions belong to either user OR org
	"CodeSymbol", // Code symbols belong to either user OR org, not both
]);

/**
 * Tables with per-user-within-org pattern.
 * Records can have:
 * 1. userId only (personal context)
 * 2. userId + organizationId (per-user config within org context)
 *
 * In org context: filter by userId AND organizationId
 * In personal context: filter by userId AND organizationId IS NULL
 *
 * These are tables where each user has their own installation/config,
 * even within an organization (e.g., MCP servers require user-specific
 * credentials; AI chats are per-user conversations even in org context).
 */
const PER_USER_ORG_TABLES = new Set([
	"MCPServer", // Each user installs servers with their own credentials
	"MCPConfig", // Each org member has their own MCP credentials
	"OpenAPIService", // Each user has their own OpenAPI service installations
	"OpenAPIServiceConfig", // Each org member has their own service configs
	"AiChat", // Per-user conversations, even within an org
	"AiChatMcpConfig", // Per-chat MCP tool selection belongs to the chat's owner
	"ChatDocument", // Uploaded to a per-user AiChat — inherits per-user scope
	"DocumentChunk", // Extracted chunks of a ChatDocument — same
	"BrowserTask", // A user's browser-automation jobs
	"AgentConversation", // A user's conversation with an agent
	"DocumentEval", // An eval run initiated by a specific user
	"AgentWorkspaceFile", // A user's virtual workspace artifacts
	"ProjectUserPreference", // Per-user-per-project settings
]);

/**
 * Tables with scope-based access (SYSTEM/USER/ORGANIZATION or ORG).
 * SYSTEM scope items are always visible.
 */
const SCOPE_BASED_TABLES = new Set([
	"RegisteredAgent",
	"Prompt",
	"ReportTemplate",
	"DynamicAgentConfig", // User-created agents with SYSTEM/USER/ORGANIZATION scope
]);

/**
 * Mapping for tables that use non-standard scope enum values.
 * Default is "ORGANIZATION", but Prompt uses "ORG".
 */
const SCOPE_ORG_VALUE: Record<string, string> = {
	Prompt: "ORG", // PromptScope enum uses 'ORG' not 'ORGANIZATION'
};

/**
 * Tables where userId is required and organizationId is optional.
 * In org context, filter by organizationId (sees all users' data within org).
 * In personal context, filter by userId AND organizationId IS NULL.
 *
 * Note: AiUsageLog is here because records can have BOTH userId (who made request)
 * AND organizationId (which org it belongs to). Org admins need to see all usage.
 */
const USER_OWNED_TABLES = new Set([
	"Agent",
	"AgentTask",
	"RegisteredAgentSuggestion", // Agent curation suggestions for USER/ORG agents
	"Workflow",
	"WorkflowExecution",
	"WorkflowIntegration",
	"WorkflowVersion", // Workflow version history
	"WorkflowApiKey", // API keys for workflows
	"WorkflowExecutionLog", // Execution logs for workflow nodes
	"Project",
	"Diagram", // Excalidraw diagrams - per-user within org, optionally scoped to project
	"ProjectDocument", // Project documents
	"ProjectContext", // Project context files / RAG contexts
	"ProjectContextUrlPage", // Per-page child rows for URL context sources (PATH_PREFIX scope)
	"ProjectContextConversationBundle", // Captured Teams/Slack channel bundles under a monitored channel context
	// The per-message claim companion. Registered in its own right, not left to
	// inherit through its parent: it gates whether a message can EVER be
	// captured, so an unfiltered write here could suppress another tenant's
	// capture through a uniqueness conflict without touching any content.
	"ProjectContextConversationClaim",
	// The stranded-vector cleanup queue an unlink writes in the same
	// transaction as its row delete. It holds no content, but it names context
	// and bundle ids belonging to one tenant, and the drain reads the
	// collection to aim at off the record — so it gets the same floor as the
	// tables it cleans up after.
	"ProjectContextPendingVectorCleanup",
	"ProjectReadinessItemState", // Manual readiness item states — snooze / not applicable / help requested
	"ProjectReadinessVerdict", // Last computed readiness verdict per item, for "recently completed"
	"BackgroundJob", // Job Hub — background job progress rows (tenant XOR + projectId)
	"TestCase", // Test cases (authored) - tenant XOR + projectId, mirrors ProjectContext
	"TestPlan", // Test plans (Fabric-local) - tenant XOR + projectId
	"TestCaseDraftJob", // AI test-case drafting runs - tenant XOR + projectId
	"TestPipelineRun", // Ingested CI/pipeline runs - tenant XOR + projectId
	"TestFinding", // Distinct CI failures tracked across runs - tenant XOR + projectId
	"TestAgenticRun", // Fabric-orchestrated browser test runs - tenant XOR + projectId
	"TestRunConfiguration", // Saved run configs - tenant XOR + projectId
	"TestAgenticCaseResult", // Per-batch staging for a Fabric run - tenant XOR + projectId
	"DecisionType", // Per-project decision-type taxonomy - tenant XOR + projectId
	"TestRunEvidence", // Ledger of stored run screenshots - tenant XOR + projectId (no FKs by design)
	"TestPipelineSyncState", // Per-source pipeline-fetch cursor - tenant XOR + projectId
	"ProjectQaSettings", // Per-project QA policy (Settings > Testing) - tenant XOR + projectId
	"ProjectEnvironment", // Deployment targets for QA runs - tenant XOR + projectId
	"ProjectQaWebhook", // Inbound QA webhook secret and delivery telemetry
	"QaOpenQuestion", // QA open-questions log - tenant XOR + projectId
	"QaSignOff", // QA feature sign-offs - tenant XOR + projectId
	"PullRequestReview", // AI PR review reads - tenant XOR + projectId
	"PullRequestReviewFinding", // AI PR review findings - tenant XOR + projectId
	// The review-accuracy ledger. Carries its own tenant columns precisely so a
	// verdict outlives the finding row a lens re-run deletes, which means it needs
	// registering here in its own right rather than inheriting by relation.
	"PrReviewJudgement",
	"PublishingSuggestionCycle", // Publishing Suite run ledger - tenant XOR + projectId
	"PublishingTopic", // Publishing Suite topics - tenant XOR + projectId
	"PublishingSuiteSettings", // Publishing Suite per-project config - tenant XOR + projectId
	"PublishingNotificationDelivery", // Publishing Suite delivery ledger - tenant XOR + projectId
	"PublishingChatDelivery", // Publishing Suite chat broadcast ledger - tenant XOR + projectId
	"PublishingTopicPlanningAnalysis", // Publishing Suite planning worksheet - tenant XOR + projectId
	// Note: TestResultEvent (run-result history) is a columnless child of TestCase and
	// is intentionally NOT registered in any category here — injecting an
	// organizationId/userId filter would make Prisma throw "Unknown argument". Tenant
	// isolation flows through TestCase→project (procedure-layer parent access checks)
	// plus a parent-scoped RLS policy (see apply-rls-direct.ts "test_result_event"),
	// exactly as DocumentEvalMetric / AiUsageLimitCounter are handled.
	"ProjectRagSettings", // RAG settings per project
	"ProjectLinkedMeeting", // Linked meetings for transcript sync
	"ProjectMeetingTranscript", // Synced meeting transcript tracking
	"ProjectMeetingAgenda", // Pre-meeting agendas (#1901); RLS-registered user_owned like its siblings
	"MeetingActionItemLink", // Action item -> work item links (#1902); tenant XOR copied from the parent transcript
	"ProjectPresence", // Real-time presence tracking
	"ProjectActivity", // Activity feed
	"DailyBriefReleaseNoteExclusion", // Per-project release-notes exclusions for the Daily Brief
	"AuditLog", // Comprehensive audit log; userId + optional organizationId
	"DocumentVersion", // Document version history
	"DocumentAutoRefreshSettings", // Per-document auto-refresh enrollment; tenant XOR copied from the parent document
	"FeatureVersion", // Feature (user story) version history
	"DocumentLock", // Document locks for collaboration
	"AutomationTemplate",
	"TemplateInstance",
	"TemplateInstanceArtifact",
	"TemplateInstanceArtifactChunk", // Artifact chunks for RAG
	"TemplateInstanceExecution",
	"ReportExecution",
	"ReportArtifact",
	"ReportArtifactChunk", // Report artifact chunks for RAG
	"SDLCPipeline",
	"Workspace",
	"WizardTempContext", // Temporary file storage during project wizard
	"AiUsageLog", // Can have both userId and orgId - org admins see all org usage
	"AiOutcomeEvent", // Human verdicts on AI output; same shape as AiUsageLog
	"AgentExecutionStep", // Agent deployment execution steps
	"AgentDeploymentTrigger", // Agent deployment triggers
	"AgentDeploymentMetrics", // Agent deployment metrics
	// Prompt-related tables (with scope for filtering)
	"PromptVersion", // Prompt version history
	"PromptComment", // Prompt comments
	"PromptCommentVote", // Comment votes
	"PromptChangeRequest", // Change requests
	"PromptConnection", // Prompt connections/chains
	// Dynamic agents
	"OffloadedToolOutput", // Large tool outputs offloaded to reduce context
	"DynamicAgentExecution", // Execution history for dynamic agents
	// Data connections - External data sync
	"DataConnection", // External service connections for data sync
	"ExternalApiUsageLog", // API key usage logs per agent instance
	"CodingRun", // Background agent coding execution sessions
	// Weave (multi-agent orchestration)
	"WeavePlan", // Weave execution plans
	"WeaveExecution", // Weave plan execution records
	"ProjectWeaveConfig", // Per-project weave configuration
	// Slack conversational threads
	"SlackThreadMapping", // Slack thread to Fabric conversation mapping
	"SlackEventReceipt", // Slack event idempotency tracking
	"TeamsEventReceipt", // Teams event idempotency and rate-limit tracking
]);

/**
 * Tables that are organization-only (no personal equivalent).
 */
const ORG_ONLY_TABLES = new Set([
	"CloudProviderConfig",
	"OrganizationRagProvider",
	"OrganizationSearchProvider",
	"OrganizationApiKey",
	"OrganizationModelPreference",
	"OrganizationEvalBudget",
	"SDLCArtifact",
]);

/**
 * Project-scoped tables and the field (relative to the row) that holds the
 * project id. When the current tenant context has a non-empty
 * `allowedProjectIds` list, queries on these tables will OR-in a filter
 * matching that list, so a guest with explicit project access can read rows
 * belonging to the invited project without being a member of its org.
 *
 * The SPECIAL value `__id__` means "the table's own `id` column" (used for
 * the Project table itself).
 *
 * Nested tables that do not store `projectId` directly (e.g. StoryTask,
 * DocumentVersion) are not listed here — they need relation filters and
 * are handled as a follow-up.
 */
const PROJECT_SCOPED_TABLES: Record<string, string> = {
	Project: "__id__",
	ProjectDocument: "projectId",
	ProjectContext: "projectId",
	ProjectContextUrlPage: "projectId",
	ProjectContextConversationBundle: "projectId",
	ProjectContextConversationClaim: "projectId",
	ProjectContextPendingVectorCleanup: "projectId",
	ProjectReadinessItemState: "projectId",
	ProjectReadinessVerdict: "projectId",
	BackgroundJob: "projectId",
	ProjectRagSettings: "projectId",
	ProjectDatabricksKnowledgeBinding: "projectId",
	ProjectLinkedMeeting: "projectId",
	ProjectMeetingTranscript: "projectId",
	ProjectMeetingAgenda: "projectId",
	DecisionType: "projectId",
	MeetingActionItemLink: "projectId",
	ProjectActivity: "projectId",
	ProjectPresence: "projectId",
	ProjectUserPreference: "projectId",
	ProjectMember: "projectId",
	ProjectInvitation: "projectId",
	ProjectWeaveConfig: "projectId",
	ProjectCodeIndex: "projectId",
	ProjectConversation: "projectId",
	ProjectStoryStatus: "projectId",
	Diagram: "projectId",
	UserStory: "projectId",
	TestCase: "projectId",
	TestPlan: "projectId",
	TestCaseDraftJob: "projectId",
	TestPipelineRun: "projectId",
	TestFinding: "projectId",
	TestAgenticRun: "projectId",
	TestRunConfiguration: "projectId",
	TestAgenticCaseResult: "projectId",
	TestRunEvidence: "projectId",
	TestPipelineSyncState: "projectId",
	ProjectQaSettings: "projectId",
	ProjectEnvironment: "projectId",
	ProjectQaWebhook: "projectId",
	QaOpenQuestion: "projectId",
	QaSignOff: "projectId",
	PullRequestReview: "projectId",
	PullRequestReviewFinding: "projectId",
	PrReviewJudgement: "projectId",
	PublishingSuggestionCycle: "projectId",
	PublishingTopic: "projectId",
	PublishingSuiteSettings: "projectId",
	PublishingNotificationDelivery: "projectId",
	PublishingChatDelivery: "projectId",
	PublishingTopicPlanningAnalysis: "projectId",
	Epic: "projectId",
	Feature: "projectId",
	TaskWorkflowPlan: "projectId",
	KanbanQueue: "projectId",
	CodingRun: "projectId",
	AiOutcomeEvent: "projectId",
};

/**
 * Tables with special handling (public flag, composite keys, etc.).
 */
/** Tables with special handling — reserved for future use. */
export const SPECIAL_TABLES = new Set([
	"AutomationTemplate", // Has isPublic flag
	"MCPServer", // Has isSystemProvided flag
]);

// ============================================================================
// Tenant Filter Generation
// ============================================================================

type TenantFilter = {
	organizationId?: string | null;
	userId?: string | null;
	scope?: string | { in: string[] };
};

/**
 * Generate tenant filter for a specific model.
 * Returns null if no filtering is needed (e.g., for non-tenant tables).
 */
function getTenantFilter(modelName: string): TenantFilter | null {
	const ctx = getTenantContext();

	// No filtering if no tenant context
	if (!hasTenantContext()) {
		return null;
	}

	const isOrgContext = ctx.type === "organization";

	// Strict isolation tables (both optional)
	if (STRICT_ISOLATION_TABLES.has(modelName)) {
		if (isOrgContext) {
			return { organizationId: ctx.organizationId, userId: null };
		}
		return { userId: ctx.userId, organizationId: null };
	}

	// Per-user-within-org tables (userId + optional organizationId)
	// In org context: user's records within the org
	// In personal context: user's personal records (no org)
	if (PER_USER_ORG_TABLES.has(modelName)) {
		if (isOrgContext) {
			return { userId: ctx.userId, organizationId: ctx.organizationId };
		}
		return { userId: ctx.userId, organizationId: null };
	}

	// Scope-based tables
	if (SCOPE_BASED_TABLES.has(modelName)) {
		if (isOrgContext) {
			// Can see SYSTEM scope + ORGANIZATION scope for this org
			return {
				scope: { in: ["SYSTEM", "ORGANIZATION"] },
				organizationId: ctx.organizationId,
			} as any; // Complex filter handled differently
		}
		// Can see SYSTEM scope + USER scope for this user
		return {
			scope: { in: ["SYSTEM", "USER"] },
			userId: ctx.userId,
		} as any;
	}

	// User-owned tables (userId required, orgId optional)
	if (USER_OWNED_TABLES.has(modelName)) {
		if (isOrgContext) {
			return { organizationId: ctx.organizationId };
		}
		return { userId: ctx.userId, organizationId: null };
	}

	// Org-only tables
	if (ORG_ONLY_TABLES.has(modelName)) {
		if (isOrgContext) {
			return { organizationId: ctx.organizationId };
		}
		// Not accessible in personal context
		return { organizationId: "___BLOCKED___" }; // Will match nothing
	}

	return null;
}

/**
 * Build a project carve-out filter for project-scoped tables. Returns `null`
 * if the current context has no allowed project ids or the table is not
 * project-scoped. Otherwise returns a filter object that matches rows whose
 * project field is in the allowed list.
 *
 * The caller merges this into the final WHERE clause via OR with the normal
 * tenant filter, so guests can read project data in addition to (not instead
 * of) whatever their tenant context normally allows.
 */
function getProjectCarveOut(modelName: string): Record<string, any> | null {
	const ctx = getTenantContext();
	if (!ctx.allowedProjectIds || ctx.allowedProjectIds.length === 0) {
		return null;
	}
	const field = PROJECT_SCOPED_TABLES[modelName];
	if (!field) {
		return null;
	}
	const column = field === "__id__" ? "id" : field;
	return { [column]: { in: ctx.allowedProjectIds } };
}

/**
 * Merge tenant filter with existing where clause.
 */
/**
 * Exported for unit testing. Do not call from application code — this is
 * what the Prisma client extension uses internally to fold tenant filters
 * and project carve-outs into every query's WHERE clause.
 */
export function mergeWithTenantFilter(
	modelName: string,
	existingWhere: any,
): any {
	const tenantFilter = getTenantFilter(modelName);
	const projectCarveOut = getProjectCarveOut(modelName);

	if (!tenantFilter && !projectCarveOut) {
		return existingWhere;
	}

	// Handle scope-based tables specially
	if (SCOPE_BASED_TABLES.has(modelName)) {
		const ctx = getTenantContext();
		const isOrgContext = ctx.type === "organization";
		const orgScopeValue = SCOPE_ORG_VALUE[modelName] || "ORGANIZATION";

		return {
			...existingWhere,
			OR: [
				{ scope: "SYSTEM" },
				isOrgContext
					? {
							scope: orgScopeValue,
							organizationId: ctx.organizationId,
						}
					: { scope: "USER", userId: ctx.userId },
			],
		};
	}

	// Project-scoped tables with an active carve-out.
	//
	// Two cases:
	//  (a) The table has a standard tenant filter (e.g. Project,
	//      ProjectDocument — in USER_OWNED_TABLES). Union the standard
	//      filter with the project-id list so a guest sees their own
	//      personal/org rows AND the invited project's rows.
	//  (b) The table has NO standard tenant filter (e.g. UserStory,
	//      ProjectMember, ProjectInvitation — not in any category). The
	//      carve-out is the sole filter. Do NOT union with an empty
	//      object — `OR: [{}, ...]` in Prisma matches every row and would
	//      leak the table to any guest request.
	if (projectCarveOut) {
		if (!tenantFilter) {
			// Case (b)
			if (!existingWhere) {
				return projectCarveOut;
			}
			return { AND: [existingWhere, projectCarveOut] };
		}
		// Case (a)
		const unionFilter = { OR: [tenantFilter, projectCarveOut] };
		if (!existingWhere) {
			return unionFilter;
		}
		return { AND: [existingWhere, unionFilter] };
	}

	// Standard merge
	if (!existingWhere) {
		return tenantFilter;
	}

	return {
		AND: [existingWhere, tenantFilter],
	};
}

// ============================================================================
// RLS Context Setting
// ============================================================================

/**
 * Execute SQL to set RLS session variables.
 * Should be called at the start of each transaction/connection.
 */
export async function setRLSContext(client: PrismaClient): Promise<void> {
	const ctx = getTenantContext();

	if (!hasTenantContext()) {
		// Set safe defaults that will block all access
		await client.$executeRawUnsafe(
			"SELECT set_config('app.tenant_type', 'none', true)",
		);
		await client.$executeRawUnsafe(
			"SELECT set_config('app.tenant_id', '', true)",
		);
		await client.$executeRawUnsafe(
			"SELECT set_config('app.user_id', '', true)",
		);
		return;
	}

	await client.$executeRawUnsafe(
		`SELECT set_config('app.tenant_type', $1, true)`,
		ctx.type,
	);
	await client.$executeRawUnsafe(
		`SELECT set_config('app.tenant_id', $1, true)`,
		ctx.tenantId ?? "",
	);
	await client.$executeRawUnsafe(
		`SELECT set_config('app.user_id', $1, true)`,
		ctx.userId ?? "",
	);
}

// ============================================================================
// Prisma Client Extension
// ============================================================================

// Cache the extended client
let _tenantDbInstance: ReturnType<typeof createTenantDb> | null = null;

/**
 * Create the tenant-isolated Prisma client extension.
 *
 * This extension provides TWO layers of protection:
 * 1. Application-level: Automatically injects tenant filters into WHERE clauses
 * 2. Database-level: Sets PostgreSQL session variables for RLS policies
 *
 * Both layers work together for defense-in-depth security.
 *
 * Connection Pooling Safety:
 * - Uses $transaction() to wrap all tenant-aware operations
 * - Sets RLS variables with is_local=true (transaction-scoped)
 * - Variables automatically reset when transaction commits/rolls back
 * - Safe for use with Neon, PgBouncer, and other connection poolers
 */
function createTenantDb(baseClient: PrismaClient) {
	return baseClient.$extends({
		name: "tenant-isolation",

		query: {
			$allModels: {
				async $allOperations({
					model,
					operation,
					args,
					query,
				}: {
					model: string;
					operation: string;
					args: any;
					query: (args: any) => Promise<any>;
				}) {
					const ctx = getTenantContext();

					// Execute query with transaction-local RLS context
					// This is safe for connection pooling (Neon/PgBouncer)
					const executeWithRLSContext = async (
						queryFn: () => Promise<any>,
					) => {
						if (!hasTenantContext()) {
							return queryFn();
						}

						// Use interactive transaction to ensure RLS context is set
						// and automatically cleaned up when transaction ends.
						// is_local=true means variables are transaction-scoped and
						// automatically reset on commit/rollback - no manual cleanup needed.
						return baseClient.$transaction(
							async (tx: Prisma.TransactionClient) => {
								// Set RLS session variables with is_local=true (transaction-scoped)
								// These automatically reset when the transaction ends,
								// preventing any possibility of tenant context leakage
								await tx.$executeRawUnsafe(
									"SELECT set_config('app.tenant_type', $1, true)",
									ctx.type,
								);
								await tx.$executeRawUnsafe(
									"SELECT set_config('app.tenant_id', $1, true)",
									ctx.tenantId ?? "",
								);
								await tx.$executeRawUnsafe(
									"SELECT set_config('app.user_id', $1, true)",
									ctx.userId ?? "",
								);

								// Execute the actual query within the transaction
								return queryFn();
							},
						);
					};

					// Apply tenant filter for read operations
					const readOps = [
						"findUnique",
						"findUniqueOrThrow",
						"findFirst",
						"findFirstOrThrow",
						"findMany",
						"count",
						"aggregate",
						"groupBy",
					];

					if (readOps.includes(operation) && model) {
						const modifiedArgs = { ...args } as any;
						modifiedArgs.where = mergeWithTenantFilter(
							model,
							modifiedArgs.where,
						);
						return executeWithRLSContext(() => query(modifiedArgs));
					}

					// Apply tenant filter for update/delete operations
					const writeOps = [
						"update",
						"updateMany",
						"delete",
						"deleteMany",
					];

					if (writeOps.includes(operation) && model) {
						const modifiedArgs = { ...args } as any;
						modifiedArgs.where = mergeWithTenantFilter(
							model,
							modifiedArgs.where,
						);
						return executeWithRLSContext(() => query(modifiedArgs));
					}

					// For create operations, we don't auto-inject tenant filter
					// The caller should explicitly set userId/organizationId
					// But we still set RLS context for database-level enforcement
					return executeWithRLSContext(() => query(args));
				},
			},
		},
	});
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Get the tenant-isolated database client.
 * Uses the current tenant context from AsyncLocalStorage.
 *
 * @example
 * // In a request handler (tenant context already set via middleware):
 * const configs = await getTenantDb().mCPConfig.findMany();
 * // Only returns configs for the current tenant!
 */
export function getTenantDb() {
	// Import the base client lazily to avoid circular dependencies
	const { db } = require("../prisma/client");

	if (!_tenantDbInstance) {
		_tenantDbInstance = createTenantDb(db);
	}

	return _tenantDbInstance;
}

/**
 * Create a new tenant-isolated client instance.
 * Use this if you need a fresh client (e.g., for testing).
 */
export function createTenantDbClient(baseClient: PrismaClient) {
	return createTenantDb(baseClient);
}

/**
 * Execute a callback with RLS context set on the connection.
 * Use this for raw SQL queries that need RLS protection.
 *
 * Connection Pooling Safety:
 * - Wraps the callback in a transaction with transaction-local RLS variables
 * - Variables automatically reset when transaction ends
 * - Safe for use with Neon, PgBouncer, and other connection poolers
 */
export async function withRLSContext<T>(
	client: PrismaClient,
	callback: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
	const ctx = getTenantContext();

	return client.$transaction(async (tx: Prisma.TransactionClient) => {
		// Set transaction-local RLS context
		if (hasTenantContext()) {
			await tx.$executeRawUnsafe(
				"SELECT set_config('app.tenant_type', $1, true)",
				ctx.type,
			);
			await tx.$executeRawUnsafe(
				"SELECT set_config('app.tenant_id', $1, true)",
				ctx.tenantId ?? "",
			);
			await tx.$executeRawUnsafe(
				"SELECT set_config('app.user_id', $1, true)",
				ctx.userId ?? "",
			);
		} else {
			// Set safe defaults that will block all access
			await tx.$executeRawUnsafe(
				"SELECT set_config('app.tenant_type', 'none', true)",
			);
			await tx.$executeRawUnsafe(
				"SELECT set_config('app.tenant_id', '', true)",
			);
			await tx.$executeRawUnsafe(
				"SELECT set_config('app.user_id', '', true)",
			);
		}

		return callback(tx);
	});
}

// ============================================================================
// Type Exports
// ============================================================================

export type TenantDb = ReturnType<typeof createTenantDb>;
