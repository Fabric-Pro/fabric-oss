/**
 * Project-level Read-only mode — shared constants and the strict tool-access
 * classifier used by every outbound write-gate.
 *
 * While a project has `readOnlyMode` enabled, Fabric must not perform ANY
 * write against a connected external source (PM tools, doc tools, chat
 * integrations, diagram sync). Enforcement happens at the final dispatch
 * points closest to the external API call (so queued/in-flight writes are
 * blocked too); this module gives those gates one shared vocabulary:
 * classifier, error code, and canonical user-facing message.
 *
 * The classifier here is deliberately STRICTER than the authority gate's
 * `classifyToolAccessLevel` (orchestrator/execution/authority-gate.ts): that
 * one whitelists content-creation tools (create_diagram, create_view, …) as
 * READ so agents can draw without approval. Read-only mode has no such
 * exemption — diagram sync is an external write and must be blocked, per the
 * card's acceptance criteria. Default for unknown names is WRITE.
 */

/** Machine-readable code carried by every read-only-mode block. */
export const READ_ONLY_MODE_ERROR_CODE = "PROJECT_READ_ONLY" as const;

/** Canonical user-facing message for a blocked write. */
export const READ_ONLY_MODE_MESSAGE =
	"This project is in Read-only mode — the action was not sent to the connected source. A project admin can disable Read-only mode in project settings.";

/**
 * Tool-name prefixes that denote a read-only operation. Anything else —
 * including unknown names — is treated as a WRITE. Shared with the orchestrator
 * authority gate (`classifyToolAccessLevel`) so the two classifiers can never
 * drift on which verbs count as reads; each layers its own extra rules on top
 * (the authority gate additionally whitelists content-creation tools as READ,
 * which Read-only mode deliberately does NOT — see this module's header).
 */
export const READ_TOOL_PREFIXES = [
	"list",
	"get",
	"search",
	"read",
	"find",
	"fetch",
	"query",
	"describe",
	"show",
	"count",
	"check",
	"view",
] as const;

/** True when `toolName` starts with a read-only prefix + separator. */
export function hasReadToolPrefix(toolName: string): boolean {
	const lower = toolName.toLowerCase();
	for (const prefix of READ_TOOL_PREFIXES) {
		if (lower.startsWith(`${prefix}_`) || lower.startsWith(`${prefix}-`)) {
			return true;
		}
	}
	return false;
}

/**
 * Unambiguously-mutating substrings that override a read prefix. A third-party
 * MCP server can expose a compound tool like `get_or_create_page` or
 * `find_or_create_issue` — the read prefix would otherwise wave it through.
 * Deliberately conservative: only verbs that never appear inside a genuine read
 * tool name (unlike e.g. "merge", which reads like `get_merge_request` carry),
 * so this can't misclassify a real read as a write and refuse it.
 */
const WRITE_SUBSTRINGS = ["create", "update", "delete", "upload"] as const;

/**
 * Read verbs recognized ONLY by this classifier, on top of the shared
 * READ_TOOL_PREFIXES: pure-lookup/compute verbs used by research integrations
 * (Perplexity `ask`, NHTSA `decode_vin`, Firecrawl `scrape_url`/`crawl_site`).
 * Deliberately NOT added to the shared list — the authority gate answers a
 * different question ("which tools run without user approval") and widening
 * its read set is a separate decision.
 */
const EXTRA_READ_VERBS = [
	"ask",
	"decode",
	"scrape",
	"crawl",
	"download",
	"preview",
] as const;

/**
 * Mutating verbs matched as WHOLE TOKENS (post-snake split on `_`), overriding
 * a read prefix — closes the compound-name gap the substring list can't touch:
 * `search_and_replace`, `get_and_send_report`, `list_and_archive_stale` must
 * classify WRITE even though they start with a read verb. Token matching (not
 * substring) is what keeps real reads safe: `get_merge_request` ("merge" is
 * deliberately absent), `get_closed_cards` ("closed" ≠ "close"),
 * `list_posts` ("posts" ≠ "post"). "merge", "post", and "set" are deliberately
 * excluded — each collides with a genuine read family.
 */
const TOKEN_WRITE_VERBS = new Set([
	"replace",
	"move",
	"send",
	"publish",
	"push",
	"submit",
	"archive",
	"transfer",
	"assign",
	"remove",
	"insert",
	"write",
	"edit",
	"close",
	"cancel",
]);

/** camelCase/PascalCase → snake_case, lowercased (`getJiraIssue` → `get_jira_issue`). */
function toSnakeLower(name: string): string {
	return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function startsWithReadVerb(name: string): boolean {
	if (hasReadToolPrefix(name)) {
		return true;
	}
	return EXTRA_READ_VERBS.some(
		(verb) => name.startsWith(`${verb}_`) || name.startsWith(`${verb}-`),
	);
}

function isBareReadVerb(name: string): boolean {
	return (
		(READ_TOOL_PREFIXES as readonly string[]).includes(name) ||
		(EXTRA_READ_VERBS as readonly string[]).includes(name)
	);
}

/**
 * Classify a tool name for Read-only mode enforcement.
 * READ passes; WRITE is blocked while the project is read-only. This is the
 * stricter fork (see this module's header): a read prefix is not enough if the
 * name also carries a mutating verb.
 *
 * Real tool inventories don't put the verb at position 0, so after the
 * write-substring override the read test also considers (post-ship review
 * finding — position-0-only refused `fizzy_get_card` pulls, a genuine read):
 * - the camelCase-normalized name (`getJiraIssue` → `get_jira_issue`);
 * - the segment after a `Vendor__` namespace (`Microsoft_Teams__list_teams`);
 * - the name with ONE leading vendor token stripped (`fizzy_get_card`,
 *   `wit_list_work_items`). One strip only, and a bare read verb is accepted
 *   only as the WHOLE original name ("search") — never as a strip remainder,
 *   so `fizzy_mark_notification_read` stays WRITE.
 * Unknown shapes still default to WRITE.
 */
export function classifyReadOnlyToolAccess(toolName: string): "READ" | "WRITE" {
	const snake = toSnakeLower(toolName);
	if (WRITE_SUBSTRINGS.some((verb) => snake.includes(verb))) {
		return "WRITE";
	}
	// Whole-token write verbs override read prefixes (search_and_replace,
	// get_and_send_report) — see TOKEN_WRITE_VERBS for why tokens, not
	// substrings.
	if (
		snake.split(/[^a-z0-9]+/).some((token) => TOKEN_WRITE_VERBS.has(token))
	) {
		return "WRITE";
	}
	if (isBareReadVerb(snake)) {
		return "READ";
	}
	const candidates = [snake];
	const namespaceIdx = snake.lastIndexOf("__");
	if (namespaceIdx >= 0) {
		candidates.push(snake.slice(namespaceIdx + 2));
	}
	for (const candidate of [...candidates]) {
		const sep = candidate.indexOf("_");
		if (sep > 0 && sep < candidate.length - 1) {
			candidates.push(candidate.slice(sep + 1));
		}
	}
	return candidates.some(startsWithReadVerb) ? "READ" : "WRITE";
}

export interface ReadOnlyBlockedOutput {
	error: string;
	code: typeof READ_ONLY_MODE_ERROR_CODE;
	toolName?: string;
}

/** Structured output for a tool call blocked by Read-only mode. */
export function buildReadOnlyBlockedOutput(
	toolName?: string,
): ReadOnlyBlockedOutput {
	return {
		error: READ_ONLY_MODE_MESSAGE,
		code: READ_ONLY_MODE_ERROR_CODE,
		...(toolName ? { toolName } : {}),
	};
}

/** Type guard: was this tool output produced by a read-only-mode block? */
export function isReadOnlyBlockedOutput(
	output: unknown,
): output is ReadOnlyBlockedOutput {
	return (
		typeof output === "object" &&
		output !== null &&
		(output as { code?: unknown }).code === READ_ONLY_MODE_ERROR_CODE
	);
}
