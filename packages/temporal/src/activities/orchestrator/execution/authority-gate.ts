/**
 * Authority Gate for Orchestrator Execution
 *
 * Pre-execution authority enforcement for MCP tools and direct integrations
 * within orchestrator/workflow runs. This ensures that agents obtain
 * human-approved runtime authority before using connected external systems.
 *
 * This module is called by:
 * - McpToolHandler (before MCP tool execution)
 * - IntegrationHandler (before direct integration execution)
 *
 * It checks the AuthoritySession/AuthorityGrant tables for active grants
 * matching the provider and access level. If no grant is found, execution
 * is blocked with a structured error that the orchestrator can surface
 * as an approval request.
 */

import {
	checkAuthority,
	ensureSensitiveOperationAuthority,
	resolveCanonicalProviderKey,
} from "@repo/database";
import { getRegisteredOperationAccess } from "@repo/integrations/executor-registry";
import {
	hasReadToolPrefix,
	toolNameReadCandidates,
	toSnakeLower,
} from "@repo/utils";

// ─── Provider Key Resolution ────────────────────────────────────────────────

/**
 * Resolve an MCP server key to a canonical provider key.
 * Uses the shared CANONICAL_PROVIDER_KEYS map from @repo/database.
 */
export function resolveProviderKey(serverKey: string): string {
	return resolveCanonicalProviderKey(serverKey);
}

/**
 * Resolve an integration provider name to a canonical provider key.
 * Uses the shared CANONICAL_PROVIDER_KEYS map from @repo/database.
 */
export function resolveIntegrationProviderKey(provider: string): string {
	return resolveCanonicalProviderKey(provider);
}

// ─── Access Level Classification ────────────────────────────────────────────

// READ verbs live in @repo/utils (`READ_TOOL_PREFIXES` / `hasReadToolPrefix`)
// so this gate and the Read-only mode classifier share one source of truth and
// cannot drift on which prefixes count as reads. This gate layers its own
// content-creation whitelist on top (below); Read-only mode deliberately does
// not.

const WRITE_PREFIXES = [
	"create",
	"update",
	"delete",
	"remove",
	"send",
	"post",
	"put",
	"patch",
	"set",
	"add",
	"edit",
	"modify",
	"move",
	"assign",
	"close",
	"archive",
	"publish",
	"execute",
	"run",
	"trigger",
	"invite",
	"revoke",
	"upload",
	"import",
];

const CONTENT_CREATION_TOOL_NAMES = new Set([
	"create_view",
	"create_diagram",
	"open_drawio_xml",
	"open_drawio_csv",
	"open_drawio_mermaid",
]);

function isContentCreationTool(toolName: string): boolean {
	const lower = toolName.toLowerCase();

	if (CONTENT_CREATION_TOOL_NAMES.has(lower)) {
		return true;
	}

	for (const contentTool of CONTENT_CREATION_TOOL_NAMES) {
		if (
			lower.endsWith(`_${contentTool}`) ||
			lower.endsWith(`-${contentTool}`)
		) {
			return true;
		}
	}

	return false;
}

/**
 * Classify a tool name as READ or WRITE.
 *
 * The namespaced read test runs LAST, after every explicit WRITE prefix has had
 * its say, and that order is the safety argument. Only the conservative default
 * at the bottom can now resolve to READ: a name that already read as READ still
 * does, and a name that matched a WRITE prefix still does, so no tool becomes
 * more permissive than it was. `update_search_index` is the case that decides
 * it — `update` matches and returns before the read test ever sees
 * `search_index`.
 *
 * Without that test a vendor token in front of the verb defeated the whole
 * classifier. Slack's MCP server names its tools `slack_search_public`, and
 * Fabric prefixes the server again before handing them to a model, so a public
 * message search fell through to the default and demanded WRITE authority. So
 * did every other namespaced read across every connected server, which trains
 * people to grant write access to read things — the opposite of what a
 * capability prompt is for.
 *
 * `isContentCreationTool` already matched its whitelist as a suffix for exactly
 * this reason; this generalizes that to the read vocabulary instead of keeping
 * it a per-name exception.
 */
export function classifyToolAccessLevel(toolName: string): "READ" | "WRITE" {
	const lower = toolName.toLowerCase();
	if (isContentCreationTool(lower)) {
		return "READ";
	}
	const snake = toSnakeLower(toolName).replace(/-/g, "_");
	if (snake.split(/[^a-z0-9]+/).some((token) => MUTATING_TOKENS.has(token))) {
		return "WRITE";
	}
	if (startsWithReadVerb(lower)) {
		return "READ";
	}
	for (const prefix of WRITE_PREFIXES) {
		if (lower.startsWith(`${prefix}_`) || lower.startsWith(`${prefix}-`)) {
			return "WRITE";
		}
	}
	if (toolNameReadCandidates(snake).some(startsWithReadVerb)) {
		return "READ";
	}
	if (isBareOrVendorReadVerb(lower)) {
		return "READ";
	}
	return "WRITE"; // Conservative default
}

/**
 * Read verbs this gate accepts on top of the shared `READ_TOOL_PREFIXES`.
 * Kept here rather than in the shared list: Read-only mode answers a
 * different question and widening its read set is a separate decision.
 */
const AUTHORITY_EXTRA_READ_VERBS = ["retrieve"] as const;

function startsWithReadVerb(name: string): boolean {
	return (
		hasReadToolPrefix(name) ||
		AUTHORITY_EXTRA_READ_VERBS.some(
			(verb) =>
				name.startsWith(`${verb}_`) || name.startsWith(`${verb}-`),
		)
	);
}

/**
 * Verbs that make a name a write wherever they sit, as a whole token. This is
 * the "a read verb and a write verb both appear" rule: `get_or_create_page`
 * and `search_and_replace` start like reads but mutate. Whole tokens, never
 * substrings, so `list_created_issues` and `get_closed_cards` stay reads.
 *
 * `post`, `set`, `add`, `run`, `merge`, `import` and `patch` are left out on
 * purpose: each names a thing as often as an action (`get_post`,
 * `get_workflow_run`, `get_merge_request`, `get_patch`), so as tokens they
 * would turn real reads into writes. They still classify WRITE as a leading
 * verb through `WRITE_PREFIXES`.
 */
const MUTATING_TOKENS = new Set([
	"create",
	"update",
	"delete",
	"remove",
	"upload",
	"send",
	"write",
	"move",
	"insert",
	"replace",
	"duplicate",
	"publish",
	"push",
	"submit",
	"archive",
	"transfer",
	"assign",
	"edit",
	"close",
	"cancel",
]);

/**
 * Read verbs the prefix tests cannot see because nothing follows them: a bare
 * `search` or `fetch`, and a vendor-hyphen name such as `notion-search`,
 * where the verb is the last segment. Hyphen form only, and only two
 * segments: `mark_read` or `fizzy_mark_notification_read` end in a read verb
 * but are writes, and the first segment must not itself be a verb.
 */
const LEADING_NON_READ_VERBS = new Set([
	...WRITE_PREFIXES,
	...MUTATING_TOKENS,
	"mark",
	"toggle",
	"clear",
	"reset",
	"sync",
]);

/** A bare read verb (`search`), tested through the shared prefix list. */
function isReadVerb(word: string): boolean {
	return /^[a-z0-9]+$/.test(word) && startsWithReadVerb(`${word}_`);
}

function isBareOrVendorReadVerb(lower: string): boolean {
	if (isReadVerb(lower)) {
		return true;
	}
	if (lower.includes("_")) {
		const namespaceIdx = lower.lastIndexOf("__");
		if (namespaceIdx < 0) {
			return false;
		}
		return isBareOrVendorReadVerb(lower.slice(namespaceIdx + 2));
	}
	const segments = lower.split("-");
	return (
		segments.length === 2 &&
		segments[0].length > 0 &&
		!LEADING_NON_READ_VERBS.has(segments[0]) &&
		isReadVerb(segments[1])
	);
}

const ACCESS_LEVEL_RANK: Record<"READ" | "WRITE", number> = {
	READ: 0,
	WRITE: 1,
};

/**
 * Classify a whole step by the most privileged tool it may call.
 *
 * A step's tool list is a set, not a sequence: `[list_issues, delete_repo]`
 * needs WRITE authority even though the first entry is a read. Classifying
 * by the first tool alone under-states the grant the step actually requires,
 * so this folds every tool through `classifyToolAccessLevel` and keeps the
 * maximum. An empty list is treated as WRITE — the conservative default the
 * per-tool classifier already uses for anything it cannot name.
 */
export function maxToolAccessLevel(
	toolNames: readonly string[],
): "READ" | "WRITE" {
	if (toolNames.length === 0) {
		return "WRITE";
	}
	let max: "READ" | "WRITE" = "READ";
	for (const toolName of toolNames) {
		const level = classifyToolAccessLevel(toolName);
		if (ACCESS_LEVEL_RANK[level] > ACCESS_LEVEL_RANK[max]) {
			max = level;
		}
	}
	return max;
}

/**
 * Classify an integration operation as READ or WRITE.
 *
 * A registered provider declares the canonical effect of each operation, and
 * that always wins: the prefix heuristic below has no `decode` verb, so it
 * would classify NHTSA's `decode_vin` as WRITE and prompt the user for
 * authority mid-chat on a pure read (Read-only mode already treats `decode_*`
 * as READ — the two classifiers must not disagree). Unregistered providers keep
 * the conservative heuristic.
 */
export function classifyIntegrationAccessLevel(
	operation: string,
	provider: string,
): "READ" | "WRITE" {
	const declared = getRegisteredOperationAccess(provider, operation);
	return declared ?? classifyToolAccessLevel(operation);
}

// ─── Authority Check ────────────────────────────────────────────────────────

export interface AuthorityGateResult {
	authorized: boolean;
	grantId?: string;
	reason?: string;
	/** Provider that needs authority */
	providerKey?: string;
	/** Access level that was required */
	requiredAccessLevel?: "READ" | "WRITE";
	/**
	 * The PENDING authority session the user can approve. Only set when the
	 * caller asked for one (`requestIfMissing`) and the check was run-bound.
	 */
	pendingSessionId?: string;
}

type RunType = "ORCHESTRATOR" | "WORKFLOW";

/**
 * Find-or-create a PENDING session for a WRITE the run is not yet allowed to
 * make, so there is something for the user to approve. Reuses a pending
 * session this run already raised; READ and content-creation tools pass.
 */
async function requestAuthority(params: {
	userId: string;
	organizationId?: string;
	providerKey: string;
	providerType: "MCP" | "INTEGRATION";
	providerRefId?: string;
	providerDisplayName?: string;
	accessLevel: "READ" | "WRITE";
	toolName: string;
	runType?: RunType;
	runId?: string;
}): Promise<AuthorityGateResult> {
	const result = await ensureSensitiveOperationAuthority({
		userId: params.userId,
		organizationId: params.organizationId,
		providerKey: params.providerKey,
		accessLevel: params.accessLevel,
		providerType: params.providerType,
		providerRefId: params.providerRefId,
		providerDisplayName: params.providerDisplayName ?? params.providerKey,
		runType: params.runType,
		runId: params.runId,
		toolName: params.toolName,
	});
	if (result.authorized) {
		return { authorized: true, grantId: result.grant?.id };
	}
	return {
		authorized: false,
		reason: result.reason,
		providerKey: params.providerKey,
		requiredAccessLevel: params.accessLevel,
		pendingSessionId: result.pendingSessionId,
	};
}

/**
 * Runtime authority for a generic MCP tool about to run in a chat turn.
 *
 * Unlike `checkMcpToolAuthority` (which filters plan-step tool lists and must
 * not raise a request per listed tool), this is called once, for the tool the
 * model actually chose, and raises a PENDING session on a miss so the
 * workflow can put an inline approval in front of the user.
 */
export async function ensureMcpToolAuthority(params: {
	userId: string;
	organizationId?: string;
	serverKey: string;
	serverDisplayName?: string;
	configId?: string;
	toolName: string;
	runType?: RunType;
	runId?: string;
}): Promise<AuthorityGateResult> {
	const accessLevel = classifyToolAccessLevel(params.toolName);
	if (accessLevel === "READ") {
		return { authorized: true };
	}
	return requestAuthority({
		userId: params.userId,
		organizationId: params.organizationId,
		providerKey: resolveProviderKey(params.serverKey),
		providerType: "MCP",
		providerRefId: params.configId,
		providerDisplayName: params.serverDisplayName,
		accessLevel,
		toolName: params.toolName,
		runType: params.runType,
		runId: params.runId,
	});
}

/**
 * Check authority for an MCP tool execution within an orchestrator/workflow run.
 *
 * @param userId - User who owns the run
 * @param organizationId - Org context (undefined for personal)
 * @param serverKey - MCP server key (from MCPConfig.mcpServer.key)
 * @param toolName - Tool being executed
 * @param runType - Type of run (ORCHESTRATOR or WORKFLOW)
 * @param runId - Run/execution ID for session binding
 */
export async function checkMcpToolAuthority(params: {
	userId: string;
	organizationId?: string;
	serverKey: string;
	toolName: string;
	runType?: "ORCHESTRATOR" | "WORKFLOW";
	runId?: string;
}): Promise<AuthorityGateResult> {
	const { userId, organizationId, serverKey, toolName, runType, runId } =
		params;

	const providerKey = resolveProviderKey(serverKey);
	const accessLevel = classifyToolAccessLevel(toolName);

	if (accessLevel === "READ") {
		return {
			authorized: true,
		};
	}

	const result = await checkAuthority({
		userId,
		organizationId,
		providerKey,
		accessLevel,
		toolName,
		boundRunType: runType,
		boundRunId: runId,
	});

	if (result.authorized) {
		return {
			authorized: true,
			grantId: result.grant?.id,
		};
	}

	return {
		authorized: false,
		reason: result.reason,
		providerKey,
		requiredAccessLevel: accessLevel,
	};
}

/**
 * Check authority for a direct integration execution.
 *
 * @param userId - User who owns the run
 * @param organizationId - Org context (undefined for personal)
 * @param provider - Integration provider (e.g., "GITHUB", "SLACK")
 * @param operation - Operation being performed (e.g., "send_message", "list_repos")
 * @param runType - Type of run
 */
export async function checkIntegrationAuthority(params: {
	userId: string;
	organizationId?: string;
	provider: string;
	operation: string;
	runType?: "ORCHESTRATOR" | "WORKFLOW";
	runId?: string;
	/**
	 * On a miss, raise (or reuse) a PENDING session for this run and return
	 * its id, so the caller can ask the user instead of only failing. Opt-in:
	 * plan steps raise their session up front in `checkStepAuthorityActivity`.
	 */
	requestIfMissing?: boolean;
	providerDisplayName?: string;
}): Promise<AuthorityGateResult> {
	const { userId, organizationId, provider, operation, runType, runId } =
		params;

	const providerKey = resolveIntegrationProviderKey(provider);
	const accessLevel = classifyIntegrationAccessLevel(operation, provider);

	if (accessLevel === "READ") {
		return {
			authorized: true,
		};
	}

	if (params.requestIfMissing) {
		return requestAuthority({
			userId,
			organizationId,
			providerKey,
			providerType: "INTEGRATION",
			providerDisplayName: params.providerDisplayName ?? provider,
			accessLevel,
			toolName: operation,
			runType,
			runId,
		});
	}

	const result = await checkAuthority({
		userId,
		organizationId,
		providerKey,
		accessLevel,
		// Without a toolName the database skips `toolScope` entirely
		// (authority.ts), so a grant narrowed to specific operations silently
		// authorized every operation on the provider.
		toolName: operation,
		boundRunType: runType,
		boundRunId: runId,
	});

	if (result.authorized) {
		return {
			authorized: true,
			grantId: result.grant?.id,
		};
	}

	return {
		authorized: false,
		reason: result.reason,
		providerKey,
		requiredAccessLevel: accessLevel,
	};
}
