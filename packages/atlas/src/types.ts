/**
 * Shared types for the Atlas feature.
 *
 * This module is intentionally runtime-free (pure types) so it can be imported
 * by the web layer via `@repo/atlas/types` without pulling in the
 * server-only `AtlasService` (which touches the DB, AI and Qdrant).
 */

export type GraphMode = "TECHNICAL" | "BUSINESS";

/** Technical node kinds describe code structure; business kinds describe value. */
export type AtlasNodeKind =
	| "DIRECTORY"
	| "MODULE"
	| "FILE"
	| "CAPABILITY"
	| "DOMAIN";

export type AtlasEdgeKind =
	| "CONTAINS"
	| "IMPORTS"
	| "DEPENDS_ON"
	| "COVERS"
	| "RELATES_TO";

export type AnalysisStatus =
	| "NOT_ANALYZED"
	| "PENDING"
	| "ANALYZING"
	| "READY"
	| "FAILED";

/** A repository the user can choose to analyse (R11). */
export interface RepoOption {
	repositoryIntegrationId: string | null;
	provider: string; // RepositoryProvider as string
	/**
	 * How the integration authenticates: "OAUTH" | "PAT". Lets the client show
	 * provider/auth-aware credential copy; no token material is ever serialized.
	 */
	authMethod: string;
	repositoryName: string;
	repositoryUrl: string;
	defaultBranch: string;
	/** User-pinned branches kept handy in the branch switcher (per project+repo). */
	pinnedBranches: string[];
	/**
	 * Live integration status: "ACTIVE" | "TOKEN_EXPIRED" | "ERROR" |
	 * "DISCONNECTED". Non-ACTIVE repos still surface (so a previously-built map
	 * stays viewable) but cannot be (re-)analysed until re-authenticated.
	 */
	status: string;
	/** True for the project's primary/legacy repository. */
	isDefault: boolean;
}

/** One remote branch surfaced by the branch switcher (R-branch). */
export interface RepoBranch {
	name: string;
	/** True for the repository's configured default/monitored branch. */
	isDefault: boolean;
	/** True when the user has pinned this branch for quick access. */
	isPinned: boolean;
	/**
	 * Live HEAD commit SHA from the remote listing, or null when the branch came
	 * only from the stored default/pinned set (or the provider omitted it).
	 * Optional so existing consumers are unaffected; used by scan-staleness
	 * detection to compare against a stored checkpoint SHA.
	 */
	commitSha?: string | null;
}

/** Status surfaced by the tab's status bar (R7, R8). */
export interface AtlasStatus {
	analysisId: string | null;
	status: AnalysisStatus;
	repository: RepoOption | null;
	hasRepository: boolean;
	/**
	 * Live status of the resolved repository integration ("ACTIVE" |
	 * "TOKEN_EXPIRED" | "ERROR" | "DISCONNECTED"), or null when the project has
	 * no repository at all. A previously-analysed map stays viewable when this
	 * is non-ACTIVE; only re-analysis is blocked.
	 */
	repositoryStatus: string | null;
	/** True only when the repository is ACTIVE — gates the Re-analyse action. */
	canReanalyze: boolean;
	/**
	 * True when the integration could refresh its credentials automatically
	 * (GitHub OAuth with a stored refresh token). Computed server-side after any
	 * refresh attempt; `false` when there is no integration. The client derives
	 * the Reconnect affordance from this — it never guesses from provider alone.
	 */
	canAutoRefreshCredentials: boolean;
	analyzedCommitSha: string | null;
	analyzedShortSha: string | null;
	analyzedAt: string | null; // ISO
	analyzedCommitAt: string | null; // ISO
	branch: string | null;
	/** Number of commits on the branch newer than the analysed commit; null when unknown/incomparable. */
	newCommitCount: number | null;
	/**
	 * Commits in the analysed snapshot no longer reachable from the branch tip
	 * (history rewritten). null = unknown (Azure DevOps, failed lookup) — the
	 * UI renders the "−M" half of the commit-diff indicator only for numbers > 0.
	 */
	behindCommitCount: number | null;
	commitsComparable: boolean;
	headSha: string | null;
	nodeCount: number;
	edgeCount: number;
	filesAnalyzed: number;
	/** Frameworks/libraries detected from dependency manifests (Technical view). */
	techStack: TechStackEntry[] | null;
	/** AI-narrated newcomer onboarding tour over the business capabilities. */
	businessTour: BusinessTour | null;
	error: string | null;
	/**
	 * ISO timestamp of when the current run started, set only while the analysis
	 * is in flight (PENDING/ANALYZING) — `null` otherwise. The UI uses it to show
	 * elapsed time and a "may have stalled" affordance for runs that overrun.
	 */
	inFlightSince: string | null;
	/**
	 * Non-blocking re-analysis (R2). When a run is in flight, this is the
	 * background-run indicator. CRUCIALLY: if a previously-completed (READY)
	 * snapshot exists, `status` STAYS "READY" (the last-good graph keeps serving)
	 * while `activeRun` reports the in-flight run — so the FE renders "analysing
	 * in background…" over the live graph and offers a refresh once it clears.
	 * `null` when no run is in flight. For a first-ever analysis there is no
	 * served snapshot, so `status` itself is PENDING/ANALYZING AND `activeRun` is
	 * set (initial build spinner).
	 */
	activeRun: { status: "PENDING" | "ANALYZING"; startedAt: string } | null;
	// Latest analysis AI telemetry (cheap denormalised snapshot for the header).
	analysisModel: string | null;
	analysisTotalTokens: number | null;
	analysisCostMicroUsd: number | null;
	analysisDurationMs: number | null;
}

// ── Tech stack (dependency manifests) ────────────────────────────────────────

/** One framework/library/runtime parsed from a dependency manifest. */
export interface TechStackEntry {
	ecosystem: string; // npm | nuget | pip | go | cargo | maven | gradle | composer | rubygems
	name: string;
	version: string | null;
	kind: "framework" | "library" | "runtime" | "tool";
	dev: boolean;
}

// ── Business onboarding tour ──────────────────────────────────────────────────

export interface TourCapabilityInput {
	key: string;
	label: string;
	description: string;
}

export interface TourStep {
	capabilityKey: string;
	title: string;
	narrative: string;
}

export interface BusinessTour {
	intro: string;
	steps: TourStep[];
}

export interface GraphNodeMetrics {
	loc?: number;
	symbolCount?: number;
	importCount?: number;
	dependentCount?: number;
	fileCount?: number;
	// Index signature so the object is storable as a Prisma Json column.
	[key: string]: number | undefined;
}

/** The 7 well-known smart-analysis categories; AI may also return a custom keyword. */
export type NodeCategory =
	| "ai"
	| "integration"
	| "security"
	| "infra"
	| "data"
	| "experience"
	| "ops";

export const NODE_CATEGORY_KEYS: NodeCategory[] = [
	"ai",
	"integration",
	"security",
	"infra",
	"data",
	"experience",
	"ops",
];

export interface GraphNode {
	key: string;
	kind: AtlasNodeKind;
	label: string;
	filePath: string | null;
	language: string | null;
	parentKey: string | null;
	/**
	 * Effective description for the requested mode — the user override when one
	 * applies (analysis.appliedUserOverrides), otherwise the AI/structural value.
	 */
	description: string | null;
	/**
	 * Effective category — one of {@link NODE_CATEGORY_KEYS} or a custom keyword.
	 * The user override (when applied) takes precedence over the AI-assigned one.
	 */
	category: string | null;
	/** True when `category` came from a user override rather than the AI. */
	isUserCategory: boolean;
	metrics: GraphNodeMetrics | null;
	layout: { x: number; y: number } | null;
}

export interface GraphEdge {
	source: string;
	target: string;
	kind: AtlasEdgeKind;
	weight: number | null;
	/**
	 * Effective edge description — the user override (when one exists and is not
	 * soft-deleted), otherwise null for a structural edge. Surfaced so the FE can
	 * render a note on the edge.
	 */
	description?: string | null;
	/** True for a user-created edge with no underlying AI/structural edge. */
	isManual?: boolean;
	/** True when `description` came from a user override rather than the AI. */
	isUserDescription?: boolean;
	/** True when the edge has been soft-deleted (only present with includeDeleted). */
	deleted?: boolean;
	/** The edge-override row id (when one exists), for history/restore wiring. */
	overrideId?: string | null;
}

export interface AtlasGraph {
	mode: GraphMode;
	analysisId: string | null;
	nodes: GraphNode[];
	edges: GraphEdge[];
}

export interface AtlasNodeNeighbor {
	key: string;
	label: string;
	kind: AtlasNodeKind;
	edgeKind: AtlasEdgeKind;
	direction: "in" | "out";
}

export interface AtlasNodeDetail extends GraphNode {
	technicalDescription: string | null;
	businessDescription: string | null;
	/**
	 * Raw user-override values (independent of the viewed mode / of whether
	 * overrides are currently applied). Let the panel show "your note" affordances
	 * and pre-fill the edit form. Null when the user has not overridden the node.
	 */
	userDescription: string | null;
	userCategory: string | null;
	/** True when the effective `description` came from the user override. */
	isUserDescription: boolean;
	/** Whether this node supports user description/category editing. */
	editable: boolean;
	/** Attached markdown documentation (README etc.), rendered in the node panel. */
	documentation: string | null;
	neighbors: AtlasNodeNeighbor[];
}

/** One node-override edit (description or category) for the history view. */
export interface NodeOverrideHistoryEntry {
	id: string;
	field: "description" | "category";
	oldValue: string | null;
	newValue: string | null;
	editedByUserId: string | null;
	editedByName: string | null;
	createdAt: string; // ISO
}

/** Tenant identity threaded through every facade call. */
export interface AtlasContext {
	userId: string;
	organizationId: string | null;
}

export interface RequestAnalysisResult {
	analysisId: string;
	workflowId: string;
	status: AtlasStatus;
}

// ── Analysis history (who / when / commit) ───────────────────────────────────

export type AnalysisRunStatus = "RUNNING" | "READY" | "FAILED";
export type AnalysisRunMode =
	| "full"
	| "incremental"
	// Solo "re-map relationships" runs (AI intra-repo reference regeneration).
	// `remap` preserves the user's edge edits; `remap_fresh` reset them first.
	| "remap"
	| "remap_fresh";

/** One analysis run as surfaced by the History view (triggering user resolved). */
export interface AnalysisRunSummary {
	id: string;
	mode: AnalysisRunMode;
	status: AnalysisRunStatus;
	/** Branch this run analysed (per-branch analyses). */
	branch: string | null;
	commitSha: string | null;
	commitShortSha: string | null;
	commitAt: string | null; // ISO
	nodeCount: number;
	edgeCount: number;
	filesAnalyzed: number;
	modulesDescribed: number;
	// AI telemetry for the run (null on structure-only / no-AI-provider runs).
	model: string | null;
	promptTokens: number | null;
	completionTokens: number | null;
	totalTokens: number | null;
	costMicroUsd: number | null;
	error: string | null;
	startedAt: string; // ISO
	completedAt: string | null; // ISO
	durationMs: number | null;
	triggeredByUserId: string | null;
	triggeredByName: string | null;
	triggeredByEmail: string | null;
}

// ── Persistent chat conversations ────────────────────────────────────────────

export type ChatVisibility = "PRIVATE" | "SHARED";

/** A persisted chat turn (the `messages` Json column is an array of these). */
export interface StoredChatMessage {
	role: "user" | "assistant" | "system";
	content: string;
	createdAt?: string; // ISO
	/**
	 * Server-set when an assistant reply was cut off mid-stream (abort,
	 * disconnect, error) and the accumulated partial text was salvaged. The UI
	 * renders a calm "Response interrupted" marker. Absent on complete turns
	 * and on every pre-existing row (additive JSON — old readers ignore it).
	 */
	interrupted?: true;
}

/** Conversation header for the History list (no `messages` payload). */
export interface ConversationSummary {
	id: string;
	/**
	 * Stored graph-mode value. Legacy only — conversations are no longer
	 * scoped by mode (one shared history); new rows write TECHNICAL.
	 */
	mode: GraphMode;
	title: string;
	visibility: ChatVisibility;
	userId: string;
	ownerName: string | null;
	isOwner: boolean;
	updatedAt: string; // ISO
}

/** Full conversation including its message history. */
export interface ConversationDetail {
	id: string;
	mode: GraphMode;
	projectId: string;
	repositoryIntegrationId: string | null;
	title: string;
	visibility: ChatVisibility;
	userId: string;
	isOwner: boolean;
	messages: StoredChatMessage[];
	createdAt: string; // ISO
	updatedAt: string; // ISO
}

// ── Shared node positions (draggable layout) ─────────────────────────────────

export interface NodeLayoutPosition {
	key: string;
	x: number;
	y: number;
}

// ── Multi-repo "System map" (cross-repository view) ──────────────────────────

/** Cross-repository relationship kinds (mirror the DB enum). */
export type SystemCrossEdgeKind =
	| "SHARES_LIBRARY"
	| "DEPENDS_ON"
	| "CALLS_API"
	| "RELATES_TO";

/** How a cross-repo edge was found (mirror the DB enum). */
export type CrossEdgeDetection = "STRUCTURAL" | "AI";

export type CrossLinkStatus = "PENDING" | "RUNNING" | "READY" | "FAILED";

/**
 * A node in the merged System map. Either a real (namespaced) analysis node or a
 * synthetic per-repository container ("REPO_GROUP"). Standalone from `GraphNode`
 * so the single-repo graph contract stays untouched.
 */
export interface SystemGraphNode {
	/** `${analysisId}::${key}` for real nodes; `repo::${analysisId}` for containers. */
	id: string;
	/** "REPO_GROUP" = synthetic repository container; otherwise the node's real kind. */
	kind: AtlasNodeKind | "REPO_GROUP";
	label: string;
	/** Owning repository integration id; null = the project's legacy/default repo. */
	repoId: string | null;
	repoName: string;
	/** The analysis this node (or container) belongs to. */
	analysisId: string;
	/** The repo container this real node sits inside; null for container nodes. */
	parentId: string | null;
	/** The underlying per-analysis node key (null for containers). */
	originalKey: string | null;
	filePath: string | null;
	language: string | null;
	description: string | null;
	category: string | null;
	isUserCategory: boolean;
	metrics: GraphNodeMetrics | null;
}

/** An edge in the merged System map — an intra-repo edge or a cross-repo one. */
export interface SystemGraphEdge {
	id: string;
	/** Namespaced source/target node (or container) ids. */
	source: string;
	target: string;
	/** Intra-repo edges keep their `AtlasEdgeKind`; cross-repo edges use `SystemCrossEdgeKind`. */
	kind: AtlasEdgeKind | SystemCrossEdgeKind;
	crossRepo: boolean;
	/** Set on cross-repo edges only. */
	detection: CrossEdgeDetection | null;
	/**
	 * Rationale/evidence (cross-repo edges, esp. AI-derived). When a user
	 * description override applies it WINS over the AI rationale.
	 */
	description: string | null;
	weight: number | null;
	/** True for a user-created (manual) edge with no underlying detected edge. */
	isManual?: boolean;
	/** True when `description` came from a user override rather than the AI. */
	isUserDescription?: boolean;
	/** True when the edge has been soft-deleted (only present with includeDeleted). */
	deleted?: boolean;
	/** The edge-override row id (when one exists), for history/restore wiring. */
	overrideId?: string | null;
}

/**
 * A persisted cross-repo edge with the user's edge override overlaid: the
 * user-edited description wins over the AI rationale, soft-deletion is surfaced
 * via `deleted`, and user-created (manual) edges are included with
 * `detection: null`. Endpoint keys are canonical per-analysis node keys (or null
 * for a repo-level endpoint) — NOT namespaced System-map node ids; each caller
 * namespaces/filters as it needs. Shared by the System map, the System-map chat,
 * and the solo chat's cross-repo grounding so they reflect the same edits.
 */
export interface OverlaidCrossEdge {
	kind: string;
	/** How the edge was detected; null for a user-created manual edge. */
	detection: CrossEdgeDetection | null;
	sourceAnalysisId: string;
	sourceKey: string | null;
	targetAnalysisId: string;
	targetKey: string | null;
	/** Effective description: the user override (when set) else the AI rationale. */
	description: string | null;
	weight: number | null;
	isManual: boolean;
	isUserDescription: boolean;
	/** True when soft-deleted; callers drop these unless they explicitly include deleted. */
	deleted: boolean;
	overrideId: string | null;
}

/** One repository represented in the System map. */
export interface RepoGroupInfo {
	repoId: string | null;
	repoName: string;
	analysisId: string;
	nodeCount: number;
}

/** A selected repo that can't be shown (no READY analysis yet). */
export interface UnavailableRepo {
	repoId: string | null;
	repoName: string;
	reason: string;
}

/** Project-level cross-link state surfaced to the UI. */
export interface CrossLinkState {
	status: CrossLinkStatus;
	/** True when the persisted cross-edges are stale vs the current analyses. */
	stale: boolean;
	edgeCount: number;
}

/** The merged multi-repo graph returned by `getSystemGraph`. */
export interface SystemGraph {
	mode: GraphMode;
	repos: RepoGroupInfo[];
	nodes: SystemGraphNode[];
	edges: SystemGraphEdge[];
	crossLink: CrossLinkState;
	unavailableRepos: UnavailableRepo[];
	/**
	 * Saved System-map node positions, keyed by the System-map node id
	 * (`repo::${analysisId}` for repo groups, `${analysisId}::${key}` for cards).
	 * Shared per (project, mode); the FE seeds React-Flow from these.
	 */
	layouts: Record<string, { x: number; y: number }>;
}

// ── System-map shared node positions (draggable layout) ──────────────────────

/** One saved System-map node position (the RF node id + its coordinates). */
export interface SystemLayoutPosition {
	id: string;
	x: number;
	y: number;
}

// ── Edge overrides (editable / manual / soft-deletable connections) ──────────

/**
 * One endpoint of an edge override — the owning repository integration (null =
 * project legacy/default repo) plus the node key within that repo's analysis.
 */
export interface EdgeEndpoint {
	repositoryIntegrationId: string | null;
	key: string;
}

/**
 * The effective edge override returned by the edge mutations — the current
 * persisted state of the override row after the write.
 */
export interface EffectiveEdgeOverride {
	id: string;
	userDescription: string | null;
	isManual: boolean;
	deletedAt: string | null; // ISO; null = active
	kind: string;
}

/** One edge-override edit for the history view (newest-first). */
export interface EdgeOverrideHistoryEntry {
	id: string;
	action: "created" | "description" | "deleted" | "restored";
	oldValue: string | null;
	newValue: string | null;
	editedByUserId: string | null;
	editedByName: string | null;
	createdAt: string; // ISO
}
