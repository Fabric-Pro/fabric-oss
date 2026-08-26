import type { McpConnectionOutcome, McpServerDiagnostic } from "./types";

export type { McpConnectionOutcome, McpServerDiagnostic } from "./types";
// Re-export so consumers (UI, API) get the recoverable-outcome rule from one
// place instead of re-implementing it.
export { isRecoverableOutcome } from "./types";

// =============================================================================
// Provider + outcome helpers (shared by the agentic run and the pre-flight)
// =============================================================================

/**
 * Derive the distinct provider keys from a template's data sources. Used to
 * pick read-only tool patterns. Kept in ONE place so the `testConnections`
 * pre-flight and the actual generation run classify tools identically.
 */
export function deriveProviders(
	dataSources:
		| Array<{ provider?: string; config?: { mcpServerKey?: string } }>
		| undefined,
): string[] {
	return [
		...new Set(
			(dataSources || [])
				.map(
					(ds) => ds.provider || ds.config?.mcpServerKey || "unknown",
				)
				.filter((p) => p !== "unknown"),
		),
	];
}

/**
 * Map a (total tools, read-only tools) count to a success outcome. Single
 * source of truth so the pre-flight and the run never disagree.
 */
export function classifyToolOutcome(
	totalToolCount: number,
	readOnlyToolCount: number,
): McpConnectionOutcome {
	if (readOnlyToolCount > 0) {
		return "connected";
	}
	return totalToolCount === 0 ? "zero_tools" : "no_read_only_tools";
}

// =============================================================================
// Read-Only Tool Patterns per Provider
// =============================================================================

/**
 * Define which tool name patterns are considered read-only for each provider.
 * Tools matching these patterns will be exposed to the AI.
 */
const READ_ONLY_TOOL_PATTERNS: Record<string, RegExp[]> = {
	azure_devops: [
		/^wit_get/i, // wit_get_work_item, wit_get_work_items_batch_by_ids, etc.
		/^wit_list/i, // wit_list_backlog_work_items
		/^wit_my/i, // wit_my_work_items
		/^work_list/i, // work_list_iterations, work_list_team_iterations
		/^work_get/i, // work_get_team_capacity, work_get_iteration_capacities
		/^git_list/i, // git_list_repositories, git_list_pull_requests
		/^git_get/i, // git_get_pull_request
		/^build_list/i, // build_list_definitions, build_list_builds
		/^build_get/i, // build_get_build
		/^project_list/i, // project_list_projects
		/^project_get/i, // project_get_project
	],
	fizzy: [/^fizzy_get/i, /^fizzy_list/i, /^fizzy_search/i],
	github: [/^list/i, /^get/i, /^search/i],
	slack: [/^get/i, /^list/i, /^search/i],
	linear: [/^list/i, /^get/i, /^search/i],
	microsoft_graph: [/^get/i, /^list/i],
};

// Conservative read-only patterns used when a provider has no explicit list.
// Hoisted to module scope so it isn't re-allocated on every isReadOnlyTool call
// (called once per tool per server on the data-gathering hot path).
const GENERIC_READ_PATTERNS: RegExp[] = [
	/^get[_\s-]/i,
	/^list[_\s-]/i,
	/^search[_\s-]/i,
	/^fetch[_\s-]/i,
	/^read[_\s-]/i,
	/^query[_\s-]/i,
	// Handle prefixed tools like fizzy_get_boards, trello_list_cards, etc.
	/^[a-z]+[_-](?:get|list|search|fetch|read|query)[_\s-]/i,
];

/**
 * Check if a tool is read-only based on provider patterns.
 */
export function isReadOnlyTool(toolName: string, providers: string[]): boolean {
	for (const provider of providers) {
		const patterns = READ_ONLY_TOOL_PATTERNS[provider.toLowerCase()];
		if (patterns) {
			for (const pattern of patterns) {
				if (pattern.test(toolName)) {
					return true;
				}
			}
		}
	}
	// If no patterns defined for provider, be conservative and allow common read patterns
	return GENERIC_READ_PATTERNS.some((p) => p.test(toolName));
}

/** Classify a connection/list error into a coarse outcome bucket. */
export function classifyConnectionError(error: unknown): McpConnectionOutcome {
	// Prefer the typed signals McpClientError already carries (duck-typed so this
	// module stays dependency-free / bundle-safe for the UI). The string matching
	// below is a fallback for plain Errors that lack these fields.
	const e = error as {
		isAuthError?: boolean;
		code?: string;
	} | null;
	if (e?.isAuthError === true) {
		return "auth_failed";
	}
	const code = typeof e?.code === "string" ? e.code.toUpperCase() : "";
	if (
		code === "CONNECTION_TIMEOUT" ||
		code === "CONNECTION_ERROR" ||
		code === "OAUTH_CONNECTION_ERROR"
	) {
		return "unreachable";
	}

	const msg = (
		error instanceof Error ? error.message : String(error ?? "")
	).toLowerCase();

	const authPatterns = [
		/\b401\b/,
		/\b403\b/,
		/unauthorized/,
		/forbidden/,
		/invalid[_\s-]?token/,
		/token[\s_-]+(expired|invalid|revoked|missing)/,
		/authentication (failed|required|error)/,
		/credentials? (invalid|expired|rejected|missing)/,
		/authorization required/,
		/please\s+(re-?)?authenticate/,
		/re-?authenticate/,
		/oauth.*(required|expired|invalid)/,
	];
	if (authPatterns.some((p) => p.test(msg))) {
		return "auth_failed";
	}

	const unreachablePatterns = [
		/econnrefused/,
		/enotfound/,
		/etimedout/,
		/econnreset/,
		/timed out/,
		/timeout/,
		/network/,
		/socket/,
		/fetch failed/,
		/unable to connect/,
	];
	if (unreachablePatterns.some((p) => p.test(msg))) {
		return "unreachable";
	}

	return "error";
}

/** Redact secret-like values from a free-text error string and cap its length. */
export function redactMessage(msg: string): string {
	// Negative lookbehind instead of \b: a secret keyword is "real" when it is
	// NOT glued to a preceding alphanumeric. That lets `signing_key=…` /
	// `private_key=…` redact (preceded by `_`) while `monkey=…` does not
	// (preceded by a letter) — `\bkey` missed the underscore-prefixed forms.
	return msg
		.slice(0, 300)
		.replace(
			/(?<![A-Za-z0-9])(token|secret|api[_-]?key|key|authorization|bearer|password|credential)([=:]\s*)\S+/gi,
			"$1$2[REDACTED]",
		);
}

const OUTCOME_REASON: Record<McpConnectionOutcome, string> = {
	connected: "connected",
	auth_failed: "authentication expired (reconnect required)",
	unreachable: "unreachable",
	zero_tools: "no tools available",
	no_read_only_tools: "no read-only tools available",
	error: "connection error",
};

/** Human reason for a single outcome (used in UI + messages). */
export function outcomeReason(outcome: McpConnectionOutcome): string {
	return OUTCOME_REASON[outcome];
}

/**
 * Build the specific failure message when zero usable read-only tools were
 * gathered. Replaces the old generic "No read-only tools available." line.
 */
export function buildNoToolsErrorMessage(
	diagnostics: McpServerDiagnostic[],
): string {
	if (diagnostics.length === 0) {
		return "Report generation could not run: no data sources are connected to this report. Add and connect an MCP server, then try again.";
	}
	const parts = diagnostics.map((d) => {
		// When a config can't be resolved (deleted / wrong context), it has no
		// real server name and `serverName` falls back to the raw config id.
		// Render a neutral label instead of leaking that opaque id into a
		// user-facing message.
		const isOpaqueId =
			!d.serverName ||
			d.serverName === d.configId ||
			/^c[a-z0-9]{20,}$/i.test(d.serverName);
		const name = isOpaqueId ? "a data source" : d.serverName;
		return `${name} — ${outcomeReason(d.outcome)}`;
	});
	return `Report generation found no usable read-only tools across ${diagnostics.length} data source${
		diagnostics.length === 1 ? "" : "s"
	}: ${parts.join("; ")}.`;
}
