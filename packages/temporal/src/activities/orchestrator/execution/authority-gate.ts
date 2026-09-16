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

import { checkAuthority, resolveCanonicalProviderKey } from "@repo/database";
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
	if (hasReadToolPrefix(lower)) {
		return "READ";
	}
	for (const prefix of WRITE_PREFIXES) {
		if (lower.startsWith(`${prefix}_`) || lower.startsWith(`${prefix}-`)) {
			return "WRITE";
		}
	}
	if (
		toolNameReadCandidates(toSnakeLower(toolName)).some(hasReadToolPrefix)
	) {
		return "READ";
	}
	return "WRITE"; // Conservative default
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
