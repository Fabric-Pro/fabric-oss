/**
 * PM Tool Patterns - Shared patterns for PM tool analysis
 *
 * This module contains shared patterns and utilities for analyzing
 * Project Management tool schemas via MCP. Used by both:
 * - Backend: packages/temporal/src/activities/pm-integration/tool-analyzer.ts
 * - Frontend: apps/web/modules/saas/projects/lib/pm-tool-analyzer.ts
 *
 * IMPORTANT: When adding new patterns, update BOTH this file and ensure
 * the consuming modules are updated accordingly.
 */

// =============================================================================
// Pattern Types
// =============================================================================

export interface PatternWithPriority {
	pattern: RegExp;
	priority: number;
}

export interface PatternWithContainerType {
	pattern: RegExp;
	containerType: string;
}

// =============================================================================
// Task ID Patterns (for extracting IDs from responses)
// =============================================================================

/**
 * Patterns for detecting task/card/issue ID parameters in tool schemas.
 * Used to discover what field name a PM tool uses for task identification.
 *
 * Higher priority = more specific match (prefer "card_number" over "id")
 */
export const TASK_ID_PARAM_PATTERNS: PatternWithPriority[] = [
	{ pattern: /^card_number$/i, priority: 11 }, // Fizzy uses card_number
	{ pattern: /^number$/i, priority: 10 }, // Fizzy shorthand
	{ pattern: /^card_id$/i, priority: 10 },
	{ pattern: /^issue_id$/i, priority: 10 },
	{ pattern: /^issue_key$/i, priority: 10 }, // Jira uses issue_key
	{ pattern: /^task_id$/i, priority: 10 },
	{ pattern: /^item_id$/i, priority: 9 }, // Monday.com
	{ pattern: /^ticket_id$/i, priority: 9 },
	{ pattern: /^issue_number$/i, priority: 8 }, // GitHub
	{ pattern: /^id$/i, priority: 5 }, // Generic fallback
];

/**
 * Common ID field names to check in API responses.
 * Ordered by specificity - more specific names first.
 *
 * Used when dynamically extracting IDs from create/get responses
 * when no idParamHint is available.
 */
export const COMMON_ID_FIELDS: string[] = [
	"number", // Fizzy, some GitHub APIs
	"card_number", // Fizzy explicit
	"issue_number", // GitHub Issues
	"id", // Most APIs
	"card_id", // Trello, etc.
	"issue_id", // Jira cloud
	"key", // Jira key (e.g., PROJ-123)
	"issue_key", // Jira explicit
	"task_id", // Asana, generic
	"item_id", // Monday.com
	"slug", // Some APIs use slug as ID
	"uuid", // UUID-based systems
	"identifier", // Generic
	"_id", // MongoDB-style
];

/**
 * Common name/title field names to check in API responses.
 */
export const COMMON_NAME_FIELDS: string[] = [
	"name",
	"title",
	"label",
	"display_name",
	"displayName",
	"summary",
	"subject",
];

// =============================================================================
// URL Extraction Patterns
// =============================================================================

/**
 * Common URL field names to check in API responses.
 *
 * NOTE: For HATEOAS-style responses (Azure DevOps, some Jira endpoints) the
 * top-level `url` is the *REST API* URL (e.g. `/_apis/wit/workItems/<id>`),
 * while the user-facing web URL lives at `_links.html.href` /
 * `_links.web.href`. `extractUrlFromResponse` consults `_links` before this
 * list so we don't end up storing JSON-endpoint URLs as the user-clickable
 * link.
 */
export const COMMON_URL_FIELDS: string[] = [
	"url",
	"link",
	"webUrl",
	"web_url",
	"html_url", // GitHub
	"permalink",
	"shortUrl", // Trello
	"self", // Some REST APIs
];

/**
 * Known PM tool domains for URL normalization.
 * When a URL contains one of these domains without protocol,
 * we can safely add https://
 */
export const KNOWN_PM_DOMAINS: string[] = [
	"trello.com",
	"github.com",
	"gitlab.com",
	"bitbucket.org",
	"jira.",
	"atlassian.net",
	"linear.app",
	"asana.com",
	"notion.so",
	"monday.com",
	"clickup.com",
	"shortcut.com",
	"clubhouse.io",
	"fizzy.do",
	"height.app",
	"pivotaltracker.com",
	"basecamp.com",
	"dev.azure.com",
	"visualstudio.com",
];

// =============================================================================
// Container Patterns (for hierarchy detection)
// =============================================================================

/**
 * Patterns for detecting container parameters (board_id, project_id, etc.)
 */
export const CONTAINER_PARAM_PATTERNS: PatternWithPriority[] = [
	{ pattern: /^board_id$/i, priority: 10 },
	{ pattern: /^project_id$/i, priority: 10 },
	{ pattern: /^project_key$/i, priority: 10 },
	{ pattern: /^team_id$/i, priority: 10 },
	{ pattern: /^repo$/i, priority: 10 },
	{ pattern: /^repository$/i, priority: 9 },
	{ pattern: /^list_id$/i, priority: 8 },
	{ pattern: /^container_id$/i, priority: 7 },
	{ pattern: /^parent_id$/i, priority: 6 },
	{ pattern: /^workspace_id$/i, priority: 8 },
	{ pattern: /^organization_id$/i, priority: 7 },
];

/**
 * Patterns for parent container parameters (account_slug, workspace_id, etc.)
 */
export const PARENT_PARAM_PATTERNS: PatternWithContainerType[] = [
	{ pattern: /^account_slug$/i, containerType: "account" },
	{ pattern: /^account_id$/i, containerType: "account" },
	{ pattern: /^workspace_id$/i, containerType: "workspace" },
	{ pattern: /^organization_id$/i, containerType: "organization" },
	{ pattern: /^org_id$/i, containerType: "organization" },
	{ pattern: /^team_id$/i, containerType: "team" },
	{ pattern: /^owner$/i, containerType: "owner" },
];

// =============================================================================
// Title/Description Patterns
// =============================================================================

/**
 * Patterns for detecting title parameters
 */
export const TITLE_PARAM_PATTERNS: PatternWithPriority[] = [
	{ pattern: /^title$/i, priority: 10 },
	{ pattern: /^summary$/i, priority: 9 },
	{ pattern: /^name$/i, priority: 8 },
	{ pattern: /^subject$/i, priority: 7 },
];

/**
 * Patterns for detecting description parameters
 */
export const DESCRIPTION_PARAM_PATTERNS: PatternWithPriority[] = [
	{ pattern: /^description$/i, priority: 10 },
	{ pattern: /^body$/i, priority: 9 },
	{ pattern: /^content$/i, priority: 8 },
	{ pattern: /^details$/i, priority: 7 },
	{ pattern: /^notes$/i, priority: 6 },
	{ pattern: /^text$/i, priority: 5 },
];

/**
 * Patterns for detecting status/state parameters
 */
export const STATUS_PARAM_PATTERNS: PatternWithPriority[] = [
	{ pattern: /^status$/i, priority: 10 },
	{ pattern: /^state$/i, priority: 9 },
	{ pattern: /^column_id$/i, priority: 8 },
	{ pattern: /^list_id$/i, priority: 7 },
	{ pattern: /^status_id$/i, priority: 10 },
];

// =============================================================================
// Tool Detection Patterns
// =============================================================================

/**
 * Patterns for detecting task creation tools
 */
export const TASK_CREATION_PATTERNS: RegExp[] = [
	/(?:create|add|new)[_-]?(card|issue|task|item|ticket|story|bug|epic|work_item)$/i,
	/^[a-z]+[_-](?:create|add|new)[_-]?(card|issue|task|item|ticket|story|bug|epic|work_item)$/i,
	/(?:create|add|new)(Card|Issue|Task|Item|Ticket|Story|Bug|Epic|WorkItem)$/i,
	// camelCase with a product infix between verb and noun, e.g. Atlassian
	// Rovo's `createJiraIssue`. The infix is 1–2 CamelCase words
	// (`(?:[A-Z][a-z0-9]+){1,2}`) so it stays bounded: `addCommentToJiraIssue`
	// (add + Comment/To/Jira + Issue = 3 infix words) does NOT match and is
	// correctly treated as a comment tool, not a create tool.
	/(?:create|add|new)(?:[A-Z][a-z0-9]+){1,2}(Card|Issue|Task|Item|Ticket|Story|Bug|Epic|WorkItem)$/,
];

/**
 * Patterns for detecting task update tools
 */
export const TASK_UPDATE_PATTERNS: RegExp[] = [
	/update_card$/i,
	/update_issue$/i,
	/update_task$/i,
	/update_item$/i,
	/update_ticket$/i,
	/update_work_item$/i,
	/edit_card$/i,
	/edit_issue$/i,
	/edit_task$/i,
	/modify_card$/i,
	/modify_issue$/i,
	// camelCase with a product infix, e.g. Atlassian Rovo's `editJiraIssue`.
	/(?:update|edit|modify)(?:[A-Z][a-z0-9]+){1,2}(Card|Issue|Task|Item|Ticket|WorkItem)$/,
];

/**
 * Patterns for detecting task get/read tools
 */
export const TASK_GET_PATTERNS: RegExp[] = [
	/get_card$/i,
	/get_issue$/i,
	/get_task$/i,
	/get_item$/i,
	/get_ticket$/i,
	/get_work_item$/i,
	/read_card$/i,
	/read_issue$/i,
	/view_card$/i,
	/view_issue$/i,
	// camelCase with a product infix, e.g. Atlassian Rovo's `getJiraIssue`.
	// `getJiraIssueRemoteIssueLinks` (ends "Links") + `getJiraIssueTypeMeta…`
	// (ends "Fields"/"Metadata") correctly do NOT match.
	/(?:get|read|view|fetch)(?:[A-Z][a-z0-9]+){1,2}(Card|Issue|Task|Item|Ticket|WorkItem)$/,
];

/**
 * Patterns for detecting task list tools
 */
export const TASK_LIST_PATTERNS: RegExp[] = [
	/list_cards$/i,
	/list_issues$/i,
	/list_tasks$/i,
	/list_items$/i,
	/list_tickets$/i,
	/list_work_items$/i, // Azure DevOps
	/wit_list.*work_items$/i, // Azure DevOps: wit_list_backlog_work_items, etc.
	/get_cards$/i,
	/get_issues$/i,
	/get_tasks$/i,
	/search_issues$/i,
	/search_cards$/i,
];

/**
 * Patterns for detecting ADO backlogs list tool (wit_list_backlogs).
 * Used to resolve backlogId when pulling from Azure DevOps.
 * Must NOT match wit_list_backlog_work_items (task list).
 */
export const BACKLOGS_LIST_PATTERNS: RegExp[] = [
	/list_backlogs$/i, // wit_list_backlogs, mcp_ado_wit_list_backlogs, etc.
];

/**
 * Patterns identifying a tool that operates on a NATIVE test-case entity (or a
 * recognized analogue), as opposed to a plain issue/card. Presence of such a
 * tool in a connection is what makes test-case sync meaningful — a connection
 * that only exposes generic issue tools cannot hold a real test case, so it is
 * gated off.
 *
 * Deliberately SPECIFIC (test-management vocabulary + vendor markers) to avoid
 * matching generic issue/task tools: a false positive would re-open the exact
 * gap this gate closes (syncing a case as a plain issue to a tool with no
 * test-case concept). Covers Azure DevOps native tooling, Jira Xray/Zephyr, and
 * GitLab test cases. The detection is positive-only; anything unmatched defaults
 * to unsupported.
 */
export const TEST_CASE_TOOL_PATTERNS: RegExp[] = [
	/test[_-]?case/i, // create_test_case, testCase, list_test_cases, gitlab test_case
	/test[_-]?execution/i, // Xray createTestExecution
	/test[_-]?plan/i, // Xray / ADO Test Plan
	/test[_-]?set/i, // Xray Test Set
	/test[_-]?cycle/i, // Zephyr test cycle
	/test[_-]?suite/i, // ADO / Xray test suite
	/xray/i, // Xray-branded tools (e.g. xray_create_test)
	/zephyr/i, // Zephyr-branded tools (e.g. zephyr_create_cycle)
];

/**
 * Patterns for detecting container listing tools
 */
export const CONTAINER_TOOL_PATTERNS: RegExp[] = [
	// Azure DevOps: list_project_teams (teams = boards)
	/list[_-]?project[_-]?teams?$/i,
	/^[a-z]+[_-]list[_-]?project[_-]?teams?$/i,
	// snake_case: prefix_get_accounts, get_accounts, list_boards
	/(?:get|list|fetch|query)[_-]?(accounts?|workspaces?|organizations?|orgs?|teams?|boards?|projects?|repos(?:itories)?|spaces?|channels?|folders?)$/i,
	// With tool prefix: linear_list_teams, jira_get_projects, fizzy_get_boards
	/^[a-z]+[_-](?:get|list|fetch|query)[_-]?(accounts?|workspaces?|organizations?|orgs?|teams?|boards?|projects?|repos(?:itories)?|spaces?|channels?|folders?)$/i,
	// camelCase: getAccounts, listProjects, fetchBoards
	/(?:get|list|fetch|query)(Accounts?|Workspaces?|Organizations?|Orgs?|Teams?|Boards?|Projects?|Repos(?:itories)?|Spaces?|Channels?|Folders?)$/i,
	// camelCase with a product/qualifier infix between verb and noun, e.g.
	// Atlassian Rovo's `getVisibleJiraProjects` (get + Visible/Jira + Projects)
	// and `getConfluenceSpaces`. Infix bounded to 1–3 CamelCase words, so
	// `getAccessibleAtlassianResources` (ends "Resources") and
	// `getJiraProjectIssueTypesMetadata` (ends "Metadata") do NOT match.
	// Case-sensitive on purpose: the CamelCase word boundaries are how we
	// bound the infix, so no /i here.
	/(?:get|list|fetch|query)(?:[A-Z][a-z0-9]+){1,3}(Accounts?|Workspaces?|Organizations?|Orgs?|Teams?|Boards?|Projects?|Repos(?:itories)?|Spaces?|Channels?|Folders?)$/,
	// Just the noun: accounts, projects, boards
	/^(accounts?|workspaces?|organizations?|orgs?|teams?|boards?|projects?|repos(?:itories)?|spaces?|channels?|folders?)$/i,
];

// =============================================================================
// PM Tool Type Detection
// =============================================================================

/**
 * Known PM tool types and their detection patterns
 */
export const PM_TOOL_TYPES: Array<{ pattern: RegExp; type: string }> = [
	{ pattern: /fizzy/i, type: "fizzy" },
	{ pattern: /linear/i, type: "linear" },
	{ pattern: /jira/i, type: "jira" },
	{ pattern: /github/i, type: "github" },
	{ pattern: /gitlab/i, type: "gitlab" },
	{ pattern: /asana/i, type: "asana" },
	{ pattern: /trello/i, type: "trello" },
	{ pattern: /notion/i, type: "notion" },
	{ pattern: /monday/i, type: "monday" },
	{ pattern: /clickup/i, type: "clickup" },
	{ pattern: /shortcut/i, type: "shortcut" },
	{ pattern: /height/i, type: "height" },
	{ pattern: /basecamp/i, type: "basecamp" },
	{ pattern: /azure[_-]?devops|ado|wit_/i, type: "azure-devops" },
];

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Find the best matching parameter from a list of available params
 * using a prioritized list of patterns.
 */
export function findBestMatchingParam(
	availableParams: string[],
	patterns: PatternWithPriority[],
): string | undefined {
	let bestMatch: { param: string; priority: number } | undefined;

	for (const param of availableParams) {
		for (const { pattern, priority } of patterns) {
			if (pattern.test(param)) {
				if (!bestMatch || priority > bestMatch.priority) {
					bestMatch = { param, priority };
				}
				break; // Found a match for this param, check next param
			}
		}
	}

	return bestMatch?.param;
}

/**
 * Extract ID from a response object using dynamic discovery.
 *
 * @param data - The response object to extract ID from
 * @param idParamHint - Optional hint from the tool schema about which field to use
 * @returns The extracted ID string or undefined
 */
export function extractIdFromResponse(
	data: Record<string, unknown>,
	idParamHint?: string,
): string | undefined {
	// First, try the hinted field if provided
	if (idParamHint && data[idParamHint] !== undefined) {
		return String(data[idParamHint]);
	}

	// Fall back to common ID fields
	for (const field of COMMON_ID_FIELDS) {
		if (data[field] !== undefined) {
			return String(data[field]);
		}
	}

	return undefined;
}

/**
 * Extract name from a response object.
 */
export function extractNameFromResponse(
	data: Record<string, unknown>,
): string | undefined {
	for (const field of COMMON_NAME_FIELDS) {
		if (data[field] !== undefined) {
			return String(data[field]);
		}
	}
	return undefined;
}

/**
 * Pull a user-facing web URL out of a HATEOAS `_links` block.
 *
 * Supports the `_links.html.href` / `_links.web.href` shape used by Azure
 * DevOps (`wit_get_work_item`, `wit_create_work_item`) and a few Jira
 * Cloud endpoints. Returns undefined when the block is absent or its
 * entries are malformed (non-object, non-string href).
 */
export function extractWebUrlFromLinks(
	data: Record<string, unknown>,
): string | undefined {
	const links = data._links;
	if (!links || typeof links !== "object") {
		return undefined;
	}
	const block = links as Record<string, unknown>;
	for (const key of ["html", "web"] as const) {
		const entry = block[key];
		if (entry && typeof entry === "object") {
			const href = (entry as Record<string, unknown>).href;
			if (typeof href === "string" && href.length > 0) {
				return href;
			}
		}
	}
	return undefined;
}

/**
 * Extract URL from a response object.
 *
 * Priority:
 *   1. `_links.html.href` — HATEOAS web URL (Azure DevOps / Jira Cloud).
 *   2. `_links.web.href`  — fallback when `html` is not present.
 *   3. `COMMON_URL_FIELDS` (`url`, `link`, …).
 *
 * Without (1)/(2), Azure DevOps responses leak their REST-API endpoint
 * (`/_apis/wit/workItems/<id>` returns JSON) into `externalUrl`, and the
 * "Open in PM" link on the roadmap then renders raw JSON in the browser.
 */
export function extractUrlFromResponse(
	data: Record<string, unknown>,
): string | undefined {
	const linkUrl = extractWebUrlFromLinks(data);
	if (linkUrl) {
		return linkUrl;
	}
	for (const field of COMMON_URL_FIELDS) {
		if (data[field] !== undefined) {
			return String(data[field]);
		}
	}
	return undefined;
}

/**
 * Detect PM tool type from a list of tool names.
 */
export function detectPMType(toolNames: string[]): string | undefined {
	const allNames = toolNames.join(" ").toLowerCase();

	for (const { pattern, type } of PM_TOOL_TYPES) {
		if (pattern.test(allNames)) {
			return type;
		}
	}

	return undefined;
}

// =============================================================================
// Per-Item PM Tool Identification (host-based)
// =============================================================================

/**
 * Host-suffix patterns per known PM-tool detectedType.
 *
 * Used to identify which PM tool a given `externalUrl` originated from
 * — needed when a project has switched its active PM integration but
 * historical rows still link to the previous tool. The roadmap "cloud"
 * icon tooltip uses this so its label always matches the link target.
 *
 * NOTE: A near-identical table also lives in
 * `packages/temporal/src/activities/pm-integration/pm-tool-mismatch.ts`.
 * If you add a tool here, mirror it there.
 */
export const PM_TOOL_HOST_PATTERNS: Record<string, string[]> = {
	fizzy: ["fizzy.do"],
	"azure-devops": ["dev.azure.com", "visualstudio.com"],
	linear: ["linear.app"],
	jira: ["atlassian.net"],
	github: ["github.com"],
	gitlab: ["gitlab.com"],
	trello: ["trello.com"],
	asana: ["asana.com"],
	notion: ["notion.so"],
	monday: ["monday.com"],
	clickup: ["clickup.com"],
};

function safeHost(url: string): string | null {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return null;
	}
}

/**
 * Resolve the PM-tool detectedType for a given external URL by matching
 * its hostname against `PM_TOOL_HOST_PATTERNS`. Returns undefined for
 * unknown hosts or malformed URLs.
 */
export function detectPMTypeFromUrl(
	url: string | null | undefined,
): string | undefined {
	if (!url) {
		return undefined;
	}
	const host = safeHost(url);
	if (!host) {
		return undefined;
	}
	for (const [type, patterns] of Object.entries(PM_TOOL_HOST_PATTERNS)) {
		if (patterns.some((p) => host === p || host.endsWith(`.${p}`))) {
			return type;
		}
	}
	return undefined;
}

/**
 * Canonical human-readable display name for a PM-tool detectedType.
 *
 * Single source of truth — both the project-level current-integration
 * label and the per-item URL-derived label share this map so the
 * roadmap tooltip stays consistent regardless of which side computed
 * the name.
 */
export function pmDetectedTypeDisplayName(
	type: string | null | undefined,
): string | undefined {
	switch (type) {
		case "azure-devops":
			return "Azure DevOps";
		case "fizzy":
			return "Fizzy";
		case "jira":
			return "Jira";
		case "linear":
			return "Linear";
		case "github":
			return "GitHub";
		case "gitlab":
		case "gitlab-rest":
			return "GitLab";
		case "trello":
			return "Trello";
		case "asana":
			return "Asana";
		case "notion":
			return "Notion";
		case "monday":
			return "Monday";
		case "clickup":
			return "ClickUp";
		default:
			return undefined;
	}
}

/**
 * Map a stored MCP **server key** (e.g. "github", "gitlab-official",
 * "azure-devops", "fizzy") to the canonical `detectedType` vocabulary consumed
 * by {@link pmDetectedTypeDisplayName}.
 *
 * Lets callers surface the connected PM tool's name straight from the project's
 * persisted config when a live capability probe isn't available — e.g. the
 * integration was set up by a teammate, so the current user has no resolvable
 * MCP connection and the live `detectedType` comes back null. Reuses the
 * {@link PM_TOOL_TYPES} pattern table so the two stay in sync. Returns undefined
 * for keys that don't correspond to a known PM tool.
 */
export function pmServerKeyToDetectedType(
	serverKey: string | null | undefined,
): string | undefined {
	if (!serverKey) {
		return undefined;
	}
	for (const { pattern, type } of PM_TOOL_TYPES) {
		if (pattern.test(serverKey)) {
			return type;
		}
	}
	return undefined;
}

// =============================================================================
// Legacy URL Normalization
// =============================================================================

// Anchored on the terminal of the URL so a subresource path like
// `/_apis/wit/workItems/149/updates` or `/_apis/wit/workItems/149/comments`
// does NOT silently rewrite to the parent item (which would lose data and
// pretend the parent is the linked resource). Allows an optional trailing
// slash and a query/hash; anything else after the id leaves the URL
// untouched. ADO matches against the full URL string (substring-style), so
// no `^` anchor here.
const ADO_API_WORK_ITEM_PATH = /\/_apis\/wit\/workItems\/(\d+)\/?(?:[?#].*)?$/i;

// GitHub REST API endpoints render JSON in a browser. The web equivalents
// live on the same path on `github.com` — but the issues route stays plural
// while the pulls route flips from `pulls` to the singular `pull`.
//
// Anchored on `^...\/?$` against `URL.pathname` (which strips query/hash) so
// subresources like `/repos/o/r/issues/42/comments/1` and
// `/repos/o/r/pulls/7/files` are NOT matched and silently parented to the
// container issue/PR. Query and hash are preserved on the rewrite by
// reattaching `parsed.search + parsed.hash`.
const GITHUB_API_ISSUE_PATH = /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/i;
const GITHUB_API_PULL_PATH = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/?$/i;

// Jira REST endpoints look like `/rest/api/{2|3}/issue/<key-or-id>`. The
// browser-readable form is `/browse/<key-or-id>`; Jira accepts either an
// issue key (`PROJ-123`) or a numeric internal id and redirects internally.
// Anchored on `^...\/?$` against pathname so subresources like
// `/rest/api/3/issue/PROJ-1/transitions` or `/.../comment/1` are left alone.
const JIRA_API_ISSUE_PATH = /^\/rest\/api\/[23]\/issue\/([^/]+)\/?$/i;

/**
 * Defensive normalizer: rewrite an Azure DevOps **REST API** work-item URL
 * to its **web UI** equivalent.
 *
 * Pre-fix, sync stored `_apis/wit/workItems/<id>` URLs (which return JSON
 * in the browser). The extractor fix prevents new bad rows, but legacy
 * data in the DB still points at REST endpoints — this function lets the
 * UI render those rows correctly without a data migration.
 *
 * Idempotent: already-correct `_workitems/edit/<id>` URLs pass through
 * unchanged, as do non-ADO URLs.
 */
export function normalizeAdoWebUrl<T extends string | null | undefined>(
	url: T,
): T {
	if (!url) {
		return url;
	}
	const trimmed = (url as string).trim();
	if (!trimmed) {
		return url;
	}
	const host = safeHost(trimmed);
	if (!host) {
		return url;
	}
	const isAdoHost =
		host === "dev.azure.com" ||
		host.endsWith(".dev.azure.com") ||
		host.endsWith(".visualstudio.com");
	if (!isAdoHost) {
		return url;
	}
	const match = trimmed.match(ADO_API_WORK_ITEM_PATH);
	if (!match) {
		return url;
	}
	return trimmed.replace(
		ADO_API_WORK_ITEM_PATH,
		`/_workitems/edit/${match[1]}`,
	) as T;
}

/**
 * Generalized PM-tool URL normalizer. Rewrites known REST-API endpoints
 * to their human-readable web-UI equivalent so the roadmap cloud icon
 * never lands the user on a raw JSON payload (bug #1303). Currently
 * covers Azure DevOps, GitHub Issues/PRs, and Jira Cloud — extend the
 * regexes above when a new tool exhibits the same symptom.
 *
 * Idempotent and lossless: anything already pointing at a web URL (or
 * any URL we don't recognize) passes through unchanged.
 */
export function normalizePmWebUrl<T extends string | null | undefined>(
	url: T,
): T {
	if (!url) {
		return url;
	}
	const trimmed = (url as string).trim();
	if (!trimmed) {
		return url;
	}

	// ADO first — keeps backward compatibility with the original helper.
	const adoNormalized = normalizeAdoWebUrl(trimmed);
	if (adoNormalized !== trimmed) {
		return adoNormalized as T;
	}

	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return url;
	}
	const host = parsed.hostname.toLowerCase();

	// GitHub REST API → web UI. `api.github.com` swaps to `github.com`
	// and the path is preserved (issues stay `issues`, pulls flip to
	// singular `pull`).
	if (host === "api.github.com") {
		const issueMatch = parsed.pathname.match(GITHUB_API_ISSUE_PATH);
		if (issueMatch) {
			return `https://github.com/${issueMatch[1]}/${issueMatch[2]}/issues/${issueMatch[3]}${parsed.search}${parsed.hash}` as T;
		}
		const pullMatch = parsed.pathname.match(GITHUB_API_PULL_PATH);
		if (pullMatch) {
			return `https://github.com/${pullMatch[1]}/${pullMatch[2]}/pull/${pullMatch[3]}${parsed.search}${parsed.hash}` as T;
		}
	}

	// Jira Cloud REST → browse. Same host; only the path changes.
	if (host.endsWith(".atlassian.net")) {
		const jiraMatch = parsed.pathname.match(JIRA_API_ISSUE_PATH);
		if (jiraMatch) {
			parsed.pathname = `/browse/${jiraMatch[1]}`;
			return parsed.toString() as T;
		}
	}

	return url;
}

/**
 * Check if a tool name matches task creation patterns.
 */
export function isTaskCreationTool(toolName: string): boolean {
	return TASK_CREATION_PATTERNS.some((p) => p.test(toolName));
}

/**
 * Check if a tool name matches task update patterns.
 */
export function isTaskUpdateTool(toolName: string): boolean {
	return TASK_UPDATE_PATTERNS.some((p) => p.test(toolName));
}

/**
 * Check if a tool name matches task get patterns.
 */
export function isTaskGetTool(toolName: string): boolean {
	return TASK_GET_PATTERNS.some((p) => p.test(toolName));
}

/**
 * Check if a tool name matches task list patterns.
 */
export function isTaskListTool(toolName: string): boolean {
	return TASK_LIST_PATTERNS.some((p) => p.test(toolName));
}

/**
 * Check if a tool name matches container listing patterns.
 */
export function isContainerListingTool(toolName: string): boolean {
	return CONTAINER_TOOL_PATTERNS.some((p) => p.test(toolName));
}

/**
 * Check if a tool name operates on a native test-case entity (or analogue).
 */
export function isTestCaseTool(toolName: string): boolean {
	return TEST_CASE_TOOL_PATTERNS.some((p) => p.test(toolName));
}

/**
 * Whether a connected PM tool can hold a NATIVE test case — the gate for
 * test-case push/pull. Azure DevOps is native by construction (the "Test Case"
 * work item + `Microsoft.VSTS.TCM.Steps`), so its `detectedType` is a fast path;
 * every other provider must positively expose a test-case tool (Jira Xray/Zephyr,
 * GitLab test cases) in its discovered tool set. A connection with only generic
 * issue/card tools returns false, so a case is never pushed as a plain issue to a
 * tool that has no concept of one.
 */
export function hasNativeTestCaseSupport(
	detectedType: string | null | undefined,
	toolNames: string[],
): boolean {
	if (detectedType === "azure-devops") {
		return true;
	}
	return toolNames.some(isTestCaseTool);
}

/**
 * Capture-group variants of CONTAINER_TOOL_PATTERNS used to pull the container
 * noun out of a tool name. Kept here, next to CONTAINER_TOOL_PATTERNS, so the
 * filter (isContainerListingTool) and the extractor can never drift: if a name
 * passes the filter but no type can be extracted, callers silently drop it
 * from the hierarchy (this exact drift caused Atlassian Rovo's Jira to be
 * rejected as "no PM capabilities" — getVisibleJiraProjects matched the filter
 * but the old camelCase-only extractor couldn't parse the product infix).
 *
 * Deliberate exception: the ADO `*project_teams` forms (matched by the first
 * two CONTAINER_TOOL_PATTERNS) are NOT handled here — they are resolved by
 * dedicated logic in fetch-pm-hierarchy.ts.
 */
const CONTAINER_TYPE_EXTRACTION_PATTERNS: RegExp[] = [
	// snake_case with optional prefix: fizzy_get_boards, get_accounts, core_list_projects
	/(?:get|list|fetch|query)[_-]?(accounts?|workspaces?|organizations?|orgs?|teams?|boards?|projects?|repos(?:itories)?|spaces?|channels?|folders?)$/i,
	// camelCase: getBoards, listProjects
	/(?:get|list|fetch|query)(Accounts?|Workspaces?|Organizations?|Orgs?|Teams?|Boards?|Projects?|Repos(?:itories)?|Spaces?|Channels?|Folders?)$/i,
	// camelCase with a product/qualifier infix between verb and noun, e.g.
	// Atlassian Rovo's `getVisibleJiraProjects` and `getConfluenceSpaces`.
	// Infix bounded to 1–3 CamelCase words. Case-sensitive on purpose: the
	// CamelCase word boundaries are how the infix stays bounded (mirrors the
	// matching CONTAINER_TOOL_PATTERNS entry).
	/(?:get|list|fetch|query)(?:[A-Z][a-z0-9]+){1,3}(Accounts?|Workspaces?|Organizations?|Orgs?|Teams?|Boards?|Projects?|Repos(?:itories)?|Spaces?|Channels?|Folders?)$/,
	// Just the noun: accounts, projects, boards
	/^(accounts?|workspaces?|organizations?|orgs?|teams?|boards?|projects?|repos(?:itories)?|spaces?|channels?|folders?)$/i,
];

/**
 * Extract the container type (singular, lowercase) from a container-listing
 * tool name.
 *
 * Examples: `get_boards` → "board", `getVisibleJiraProjects` → "project",
 * `getConfluenceSpaces` → "space", `linear_list_teams` → "team".
 *
 * Returns undefined when no container noun can be parsed.
 */
export function extractContainerType(toolName: string): string | undefined {
	for (const pattern of CONTAINER_TYPE_EXTRACTION_PATTERNS) {
		const match = toolName.match(pattern);
		if (match) {
			// Normalize to singular lowercase form
			let type = match[1].toLowerCase();
			if (type.endsWith("ies")) {
				type = `${type.slice(0, -3)}y`;
			} else if (type.endsWith("s") && !type.endsWith("ss")) {
				type = type.slice(0, -1);
			}
			if (type === "repositorie") {
				type = "repo";
			}
			if (type === "org") {
				type = "organization";
			}
			return type;
		}
	}
	return undefined;
}

/**
 * Find the ADO backlogs list tool from available tool names.
 * Used when resolving backlogId for wit_list_backlog_work_items.
 * Excludes task list tools (e.g. wit_list_backlog_work_items).
 */
export function findBacklogsListTool(
	availableTools: string[],
): string | undefined {
	return availableTools.find(
		(t) =>
			BACKLOGS_LIST_PATTERNS.some((p) => p.test(t)) &&
			!/work_items/i.test(t),
	);
}

/**
 * Normalize a URL to ensure it's absolute.
 * - If already absolute (starts with http:// or https://), return as-is
 * - If it's a relative path (starts with /) and baseUrl is provided, construct full URL
 * - If it looks like a known PM domain without protocol, add https://
 *
 * @param url - The URL to normalize
 * @param baseUrl - Optional base URL to resolve relative paths
 */
export function normalizeUrl(
	url: string | undefined | null,
	baseUrl?: string | null,
): string | undefined {
	if (!url || typeof url !== "string") {
		return undefined;
	}

	let trimmed = url.trim();
	if (!trimmed) {
		return undefined;
	}

	// Remove .json suffix if present (some APIs return JSON endpoints)
	if (trimmed.endsWith(".json")) {
		trimmed = trimmed.slice(0, -5);
	}

	// Already absolute - return as-is
	if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
		return trimmed;
	}

	// If it's a relative path and we have a base URL, construct full URL
	if (trimmed.startsWith("/") && baseUrl) {
		try {
			const base = new URL(baseUrl);
			return `${base.origin}${trimmed}`;
		} catch {
			// Invalid base URL
		}
	}

	// Check for known PM domains
	for (const domain of KNOWN_PM_DOMAINS) {
		if (trimmed.includes(domain)) {
			if (!trimmed.startsWith("http")) {
				return `https://${trimmed}`;
			}
			return trimmed;
		}
	}

	// If it looks like a domain (contains dot, no spaces), try adding https://
	if (
		trimmed.includes(".") &&
		!trimmed.includes(" ") &&
		!trimmed.includes("\n")
	) {
		return `https://${trimmed}`;
	}

	// Can't normalize - return undefined
	return undefined;
}
