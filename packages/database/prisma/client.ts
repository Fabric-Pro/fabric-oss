import { PrismaPg } from "@prisma/adapter-pg";
import { getDatabricksTokenProvider } from "@repo/databricks";
import { buildPgPoolConfig } from "./adapter-config";
import { Prisma, PrismaClient } from "./generated/client";

/**
 * Lazy-init the real PrismaClient. Importing `db` from this module
 * does NOT open any database handles — only first method access does.
 * Why: tests across the monorepo transitively import `@repo/database`.
 * If the singleton eagerly created a PrismaPg + pg.Pool at module
 * load, the pool's connection-retry handles would keep Node.js alive
 * past test completion and prevent vitest's main process from exiting
 * (vitest #3909 / #4373). With the proxy, tests that mock @repo/database
 * pay nothing, and tests that don't mock but never query also pay
 * nothing.
 */
const createRealPrismaClient = (): PrismaClient => {
	const connectionString = process.env.DATABASE_URL;
	if (!connectionString) {
		throw new Error("DATABASE_URL is not set");
	}

	// SOC 2 CC6.7 (encryption in transit): FAIL-CLOSED — in production, refuse to
	// connect over a channel that does not explicitly require TLS. Both staging and
	// production run on Neon, which mandates SSL (connection strings carry
	// `sslmode=require`), so this never fires in normal operation; it guards against
	// a future misconfiguration silently downgrading the DB channel to plaintext.
	// Emergency escape hatch: FABRIC_ALLOW_INSECURE_DB=true downgrades to a warning
	// without a code change, so a mistaken enforcement can never brick a deploy.
	if (
		process.env.NODE_ENV === "production" &&
		!/sslmode=(require|verify-ca|verify-full)/i.test(connectionString)
	) {
		if (process.env.FABRIC_ALLOW_INSECURE_DB === "true") {
			console.warn(
				"[security] DATABASE_URL does not require TLS " +
					"(no sslmode=require|verify-ca|verify-full) but " +
					"FABRIC_ALLOW_INSECURE_DB=true — proceeding INSECURELY (SOC 2 CC6.7).",
			);
		} else {
			throw new Error(
				"[security] Refusing to start: production DATABASE_URL must require TLS " +
					"(sslmode=require|verify-ca|verify-full) for encryption in transit " +
					"(SOC 2 CC6.7). Set FABRIC_ALLOW_INSECURE_DB=true to override in an " +
					"emergency.",
			);
		}
	}

	// In "databricks-oauth" mode (DATABASE_AUTH_PROVIDER) pg invokes the
	// password callback per new connection, fetching a fresh Lakebase OAuth
	// token; the token provider is itself a lazy singleton so nothing is
	// constructed here unless that mode is active and a connection opens.
	const adapter = new PrismaPg({
		...buildPgPoolConfig(process.env, () =>
			getDatabricksTokenProvider().getToken(),
		),
		// Bound how long a single connection attempt may block. The pg default
		// (0) is "wait forever", so a momentary Postgres connection/auth
		// saturation made every query hang ~45-55s before failing with
		// "DriverAdapterError: Authentication timed out" (observed live on
		// staging; same root shape #1750 retries around) — long enough to blow
		// past Temporal activity/heartbeat timeouts and tie up worker slots.
		// 20s is far above a healthy connect (sub-second) but converts the
		// pathological hang into a fast, retryable failure.
		connectionTimeoutMillis: 20_000,
	});

	return withQueryObserver(new PrismaClient({ adapter }));
};

/**
 * Per-query observer hook, injected by whoever wants to instrument queries.
 *
 * Registered rather than imported because this package deliberately does NOT
 * depend on `@repo/api` or `@repo/observability` — the same reasoning, and the
 * same shape, as `setAuditCounters`.
 *
 * ## Why this exists at all
 *
 * The API package tried to instrument queries with `db.$use(...)`, guarded by
 * `typeof db.$use === "function"`. **Prisma 6 removed `$use`**: the generated
 * client exposes only `$connect $disconnect $executeRaw $executeRawUnsafe
 * $extends $on $queryRaw $queryRawUnsafe $transaction`. So the guard was always
 * false, the middleware was never installed, and the request-span feature has
 * captured zero `db` spans since the Prisma 6 upgrade — while the traced-request
 * API kept advertising "low-level spans (db / temporal / http)". A `typeof`
 * guard around an optional API is exactly how that failed silently for months.
 *
 * The replacement is a client extension, which has to be applied where the
 * client is CONSTRUCTED — `$extends` returns a new client rather than mutating
 * the existing one, so it cannot be retrofitted from outside onto an exported
 * `db`. That is the other half of why the old approach could not have worked.
 */
export type PrismaQueryObserver = (args: {
	model: string | undefined;
	operation: string;
	args: unknown;
	query: (args: unknown) => Promise<unknown>;
}) => Promise<unknown>;

let queryObserver: PrismaQueryObserver | undefined;

/**
 * Install the per-query observer. Call once at process start, before any query.
 * Idempotent in effect — a second call replaces the first.
 */
export function setPrismaQueryObserver(observer: PrismaQueryObserver): void {
	queryObserver = observer;
}

/**
 * Attach the extension that routes every operation through the observer.
 *
 * The extension is installed unconditionally, but costs one undefined-check per
 * query when no observer is registered — which is the case in Temporal workers,
 * scripts and tests. Installing it conditionally would mean the observer could
 * only ever be registered before the first query, and getting that ordering
 * wrong is precisely the silent failure this replaces.
 *
 * Typed as `PrismaClient` on the way out. `$extends` genuinely returns a
 * different type, but the exported `db` is already a `Proxy` declared as
 * `PrismaClient`, and the model API every consumer actually uses is identical —
 * only the extension internals differ.
 */
function withQueryObserver(client: PrismaClient): PrismaClient {
	return client.$extends({
		query: {
			$allOperations({ model, operation, args, query }) {
				if (!queryObserver) {
					return query(args);
				}
				return queryObserver({ model, operation, args, query });
			},
		},
	}) as unknown as PrismaClient;
}

declare global {
	var prisma: undefined | PrismaClient;
}

const getPrismaClient = (): PrismaClient => {
	if (!globalThis.prisma) {
		globalThis.prisma = createRealPrismaClient();
	}
	return globalThis.prisma;
};

// Lazy proxy: the real PrismaClient is constructed only on first
// property access (e.g. `db.user.findMany`), never at import time.
const db = new Proxy({} as PrismaClient, {
	get(_target, prop, receiver) {
		const client = getPrismaClient();
		const value = Reflect.get(client, prop, receiver);
		// Bind methods so `db.$transaction(..)` and similar work.
		return typeof value === "function" ? value.bind(client) : value;
	},
});

export { db, Prisma };
// Re-export commonly used types and enums from generated client
export type {
	AgentApproval,
	// Fabric-orchestrated test runs.
	AgenticRunStatus,
	AgenticStepStatus,
	AgentTask,
	AgentWorkspaceFile,
	AiChat,
	// AI usage-limits row types (schema additions for the AI
	// usage limits + notifications spec).
	AiUsageLimit,
	AiUsageLimitCounter,
	// Architecture Decision Log (ADL)
	ArchitectureDecision,
	ArchitectureDecisionComment,
	ArchitectureDecisionVersion,
	ChatDocument,
	// Feature Maturation V2 (three-tab editor, spec 2026-06-09 §5)
	DecisionLogEntry,
	DocumentChunk,
	DocumentLock,
	DocumentVersion,
	MaturationApprovalPreference,
	MCPConfig,
	MCPOAuthState,
	MCPServer,
	Notification,
	Organization,
	Project,
	ProjectContext,
	ProjectContextSummary,
	ProjectDocument,
	ProjectInvitation,
	// Collaboration types
	ProjectMember,
	ProjectPresence,
	// User Stories & Tasks types
	ProjectStoryStatus,
	QaRunMode,
	Session,
	StorySubtask,
	StoryTask,
	// Test Cases (authored test artefacts + plans)
	TestCase,
	TestCaseScriptRevision,
	TestCaseScriptRevisionOrigin,
	TestCaseStep,
	TestCaseWorkItemLink,
	TestPlan,
	TestPlanCase,
	// Test-case run results (append-only history + denormalized current)
	TestResultEvent,
	User,
	UserStory,
	Workflow,
	WorkflowExecution,
	WorkflowExecutionLog,
	WorkflowIntegration,
	WorkflowVersion,
	// Workspace types
	Workspace,
	WorkspaceAdministrator,
	WorkspaceAgent,
	WorkspaceContributor,
	WorkspaceConversation,
	WorkspaceDocument,
	WorkspaceDocumentChunk,
	WorkspaceRagSettings,
	WorkspaceStakeholder,
} from "./generated/client";

// Re-export enums
export {
	AgentDeploymentHealthStatus,
	// Agent Deployment enums
	AgentDeploymentStatus,
	// AI usage-limits enums (schema additions for the AI usage
	// limits + notifications spec — re-exported here so callers in
	// @repo/payments and @repo/api can branch on them without a
	// deep-import).
	AiUsageLimitDimension,
	AiUsageLimitEnforcement,
	AiUsageLimitWindow,
	// Architecture Decision Log (ADL) status lifecycle
	ArchitectureDecisionStatus,
	// Test Cases (authored test artefacts) — re-exported so @repo/api, @repo/ai,
	// and @repo/temporal can branch on / default these without a deep-import.
	AutomationStatus,
	ChunkSplitMethod,
	// AI Assistant clarifying-question frequency (pushback-agent knob)
	ClarifyingQuestionFrequency,
	// Code Analysis enums
	CodeAnalysisStatus,
	ContextSummaryStatus,
	ContextSummaryTrigger,
	// Feature Maturation V2 (three-tab editor, spec 2026-06-09 §5) — re-exported
	// so @repo/api maturation procedures can branch on / validate these without a
	// deep-import into the generated client.
	DecisionAuthorType,
	DecisionSource,
	DecisionStatus,
	DeploymentExecutionStatus,
	DeploymentTriggerType,
	DocumentStatus,
	EmbeddingModel,
	// RAG-related enums
	ExtractionStatus,
	FeatureDraftingStage,
	// Project-member function tags
	FunctionTag,
	// Document Eval enums
	GoldenReferenceScope,
	// What a LINK context source actually is (Fizzy #2165) — re-exported so
	// @repo/api and the context queries can type the classification without a
	// deep-import into the generated client.
	KnowledgeBaseSourceCategory,
	// Last-edit provenance for UserStory (conflict-dialog metadata)
	LastEditSource,
	MaturationApprovalMode,
	// Maturation V2 "dummy" status label (To Do / Discovery / Done) — see schema
	MaturationStatus,
	// Notification center enums
	NotificationCategory,
	NotificationType,
	// PM state-change entity-type enum (card #1360) — re-exported so callers
	// in @repo/api can type the PendingPmStateChange / PmTicketMissingStreak
	// `entityType` field without a deep-import into the generated client.
	PmStateChangeEntityType,
	PmSyncStatus,
	// Roadmap Priority band-change provenance (AI run vs. a person)
	PriorityChangeSource,
	ProjectContextType,
	ProjectDocumentStatus,
	ProjectDocumentType,
	// Per-project QA policy (Settings ▸ Testing) + its deployment targets —
	// re-exported so @repo/api can validate these without deep-importing the
	// generated client.
	ProjectEnvironmentType,
	ProjectInvitationStatus,
	// Collaboration enums
	ProjectMemberRole,
	ProjectStatus,
	// Publishing Suite 1B — post-type enum (topic.suggestedPostTypes); re-exported
	// so @repo/temporal activities/tests can branch on / assert it without a
	// deep-import into the generated client.
	PublishingTopicPostType,
	PurchaseType,
	// Test-pyramid level of a single case (UNIT/INTEGRATION/E2E/MANUAL) —
	// re-exported so the drafting path can type a case's level without a
	// deep-import into the generated client.
	QaCoverageType,
	QaEvidencePolicy,
	QaOpenQuestionStatus,
	QaStrategyDepth,
	// Project QA depth (LIGHT/STANDARD/STRICT) — re-exported so the @repo/api
	// QA-analysis generation (maturation QA tab) can branch on it
	// without a deep-import into the generated client.
	QaStrategyLevel,
	// F-171 reporter tracking
	ReporterSource,
	// Test-case run-result enums (manual mark + PM-sync ingest source)
	ResultSource,
	// User Stories & Tasks enums
	StoryKind,
	StoryPriority,
	StorySize,
	StorySource,
	// Subscription (watch document/feature) discriminator — re-exported so
	// @repo/api subscription procedures can validate `subjectType` without a
	// deep-import into the generated client.
	SubscriptionSubjectType,
	TestCasePriority,
	TestCaseState,
	TestFailureKind,
	TestPlanState,
	TestResult,
	WorkflowBuilderStatus,
	WorkflowExecutionStatus,
	WorkflowIntegrationProvider,
	WorkflowNodeStatus,
	WorkflowStatus,
	WorkflowTriggerType,
	WorkspaceAccessLevel,
	WorkspaceDocumentStatus,
	WorkspaceStatus,
	// Workspace enums
	WorkspaceType,
} from "./generated/client";
