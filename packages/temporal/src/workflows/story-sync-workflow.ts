/**
 * Story Sync Workflow
 *
 * A Temporal workflow for syncing features to external PM tools.
 * Follows the orchestrator pattern with:
 * - Signal-based cancellation
 * - Query-based progress tracking
 * - Caching to avoid redundant MCP calls
 * - Dynamic tool discovery via analyzePMToolCapabilities
 */

import {
	parseWorkItemTypeMapping,
	resolveWorkItemType,
	type StoryKindValue,
} from "@repo/utils/work-item-type-mapping";
import {
	ActivityFailure,
	ApplicationFailure,
	defineQuery,
	defineSignal,
	log,
	patched,
	proxyActivities,
	setHandler,
} from "@temporalio/workflow";
import type { executeMcpTool as ExecuteMcpToolFn } from "../activities/orchestrator/execution/execute-mcp-tool";
import type { detectAndStampPmPushConflict as DetectAndStampPmPushConflictFn } from "../activities/pm-integration/detect-pm-push-conflict";
import type {
	createOrUpdateStoryFromPMItem as CreateOrUpdateStoryFromPMItemFn,
	deleteStoriesNotInPMList as DeleteStoriesNotInPMListFn,
	discoverPMToolCapabilities as DiscoverPMToolCapabilitiesFn,
	fetchPMItemsByIds as FetchPMItemsByIdsFn,
	getStoriesToSync as GetStoriesToSyncFn,
	listAllFizzyCards as ListAllFizzyCardsFn,
	listWorkItemsFromPM as ListWorkItemsFromPMFn,
	updateStoryExternalRefs as UpdateStoryExternalRefsFn,
} from "../activities/pm-integration/story-sync";
import type { PMToolCapabilities } from "../activities/pm-integration/tool-analyzer";

// =============================================================================
// Types
// =============================================================================

export interface StorySyncWorkflowInput {
	projectId: string;
	/** Required: identifies the PM provider (MCPServer.id). Always present.
	 *  Workflow + activities use this to resolve PMSource per-call. */
	mcpServerId: string;
	/** Null when the project uses GitLab REST fallback (mcpServer.key=gitlab-official
	 *  AND active WorkflowIntegration but no MCPConfig because the tier probe
	 *  found the instance is not MCP-capable). Activities dispatch through
	 *  callPmToolWithFallback which selects MCP or REST based on PMSource. */
	mcpConfigId: string | null;
	containerId: string;
	containerName?: string;
	additionalContext?: Record<string, string>;
	userId: string;
	organizationId?: string;
	storyIds?: string[];
	statusIds?: string[]; // Filter by kanban column status IDs
	unsyncedOnly?: boolean;
	direction: "push" | "pull";
	enableTypeMapping?: boolean;
	/** Pull only: when set, import only these specific PM external IDs (selective pull).
	 *  Orphaned-story deletion is skipped when this filter is active. */
	pmExternalIds?: string[];
}

export interface StorySyncProgress {
	status: "initializing" | "syncing" | "completed" | "cancelled" | "failed";
	totalStories: number;
	syncedCount: number;
	failedCount: number;
	/** Items skipped because the PM side drifted; stamped CONFLICT for Review Center. */
	conflictedCount: number;
	currentStoryId?: string;
	currentStoryIdentifier?: string;
	message: string;
	results: Array<{
		storyId: string;
		identifier: string;
		success: boolean;
		/** Per-item outcome. Absent on legacy events → infer from `success`. */
		outcome?: "synced" | "conflict" | "failed";
		externalId?: string;
		externalUrl?: string;
		error?: string;
	}>;
}

export interface StorySyncWorkflowOutput {
	success: boolean;
	totalStories: number;
	syncedCount: number;
	failedCount: number;
	conflictedCount?: number;
	results: StorySyncProgress["results"];
	error?: string;
}

// =============================================================================
// Stale-link detection helpers
// =============================================================================

const PM_TOOL_HOST_PATTERNS: Record<string, string[]> = {
	fizzy: ["fizzy.do"],
	"azure-devops": ["dev.azure.com", "visualstudio.com"],
	linear: ["linear.app"],
	jira: ["atlassian.net"],
	github: ["github.com"],
	gitlab: ["gitlab.com"],
};

function safeHost(url: string): string | null {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return null;
	}
}

function existingLinkBelongsToDifferentTool(
	externalUrl: string | null | undefined,
	currentType: string | undefined,
): boolean {
	if (!externalUrl || !currentType) {
		return false;
	}
	const host = safeHost(externalUrl);
	if (!host) {
		return false;
	}
	for (const [type, patterns] of Object.entries(PM_TOOL_HOST_PATTERNS)) {
		if (type === currentType) {
			continue;
		}
		if (patterns.some((p) => host === p || host.endsWith(`.${p}`))) {
			return true;
		}
	}
	return false;
}

// =============================================================================
// Description-cleanup helpers (module scope)
// =============================================================================

/**
 * Remove editor highlight (`<mark>`) tags, keeping the text they wrapped.
 *
 * Mirror of `stripHighlightMarks` in
 * `activities/pm-integration/story-sync.ts` — the workflow bundle carries its
 * own copy of the description-building family, and the two must stay
 * byte-identical (asserted by the parity test in `__tests__/story-sync.test.ts`).
 *
 * The patterns are deliberately WORD-DELIMITED: the naive
 * `/<\/?mark[^>]*>/gi` would also eat `<marker>`, `<markdown>` and
 * `Map<markerId, string>`. Applied repeatedly so a nested/malformed
 * `<ma<mark>rk …>` cannot reassemble into a valid tag. Pure regex — no I/O,
 * no clock, no randomness — so hoisting it to module scope is replay-safe.
 *
 * The loop is BOUNDED: each pass rescans the whole string, so an unbounded
 * fixed point is quadratic in nesting depth on input that reaches a workflow
 * unvalidated. Real editor output nests one level.
 *
 * The final sweep ESCAPES rather than deletes. Deleting splices the neighbours
 * together — the very reassembly the loop exists to defeat — turning an inert
 * `<ma</markrk>` into a live `<mark>` and eating literal `<marker` text.
 */
const MAX_HIGHLIGHT_STRIP_PASSES = 10;

function stripHighlightMarks(text: string): string {
	let current = text;
	for (let pass = 0; pass < MAX_HIGHLIGHT_STRIP_PASSES; pass++) {
		const next = current
			.replace(/<mark(?=[\s/>])[^>]*>/gi, "")
			.replace(/<\/mark\s*>/gi, "");
		if (next === current) {
			return current;
		}
		current = next;
	}
	return current.replace(/<(?=\/?mark)/gi, "&lt;");
}

/**
 * Clean stored content for PM tool display.
 *
 * Hoisted out of `storySyncWorkflow`'s body (where it was closure-local and
 * therefore untestable) so the activity/workflow parity assertion can import
 * it. Deterministic by construction: pure string + regex work only.
 */
export function cleanContentForPM(content: string): string {
	return content
		.split("\n")
		.map((rawLine) => {
			// Drop highlight tags FIRST so a decorated heading such as
			// `### <mark>**Feature Story**</mark>` still matches the
			// heading-decoration rules below.
			const line = stripHighlightMarks(rawLine);
			// Preserve heading markers for markdownToSimpleHtml to convert to <h2>/<h3>.
			// Only strip redundant **bold** inside headings: ### **Feature Story** → ### Feature Story
			if (/^#{1,6}\s+\*{2}.+\*{2}\s*$/.test(line)) {
				return line.replace(/\*{2}([^*]+)\*{2}/g, "$1");
			}
			// Strip **bold** from GIVEN/WHEN/THEN/AND keywords but keep the text
			return line.replace(/\*{2}(GIVEN|WHEN|THEN|AND)\*{2}/g, "$1");
		})
		.join("\n");
}

// =============================================================================
// Signals & Queries
// =============================================================================

export const cancelSyncSignal = defineSignal("cancelSync");
export const progressQuery = defineQuery<StorySyncProgress>("progress");

// =============================================================================
// Activity Proxies
// =============================================================================

const { executeMcpTool } = proxyActivities<{
	executeMcpTool: typeof ExecuteMcpToolFn;
}>({
	startToCloseTimeout: "30 seconds",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "1s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

const {
	getStoriesToSync,
	updateStoryExternalRefs,
	listAllFizzyCards,
	listWorkItemsFromPM,
	fetchPMItemsByIds,
	createOrUpdateStoryFromPMItem,
	deleteStoriesNotInPMList,
} = proxyActivities<{
	getStoriesToSync: typeof GetStoriesToSyncFn;
	updateStoryExternalRefs: typeof UpdateStoryExternalRefsFn;
	listAllFizzyCards: typeof ListAllFizzyCardsFn;
	listWorkItemsFromPM: typeof ListWorkItemsFromPMFn;
	fetchPMItemsByIds: typeof FetchPMItemsByIdsFn;
	createOrUpdateStoryFromPMItem: typeof CreateOrUpdateStoryFromPMItemFn;
	deleteStoriesNotInPMList: typeof DeleteStoriesNotInPMListFn;
}>({
	startToCloseTimeout: "60 seconds",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "2s",
		maximumInterval: "30s",
		backoffCoefficient: 2,
		maximumAttempts: 5,
	},
});

// Fail-fast proxy for PM-connectivity-bound activities that should NOT grind
// through the heavy 60s × 5 budget when the PM tool is degraded:
//   - discoverPMToolCapabilities is the preflight gate. If the PM tool can't
//     be reached, we want to abort the whole batch fast — before any item is
//     touched — and tell the user to retry, instead of spinning for minutes.
//   - detectAndStampPmPushConflict is a best-effort drift guard; if it can't
//     read the PM tool quickly there is no point retrying it five times.
// Reducing only the activity options is replay-safe: the recorded command
// sequence (and activity types) is unchanged, and in-flight activities keep
// the options they were scheduled with.
const { discoverPMToolCapabilities, detectAndStampPmPushConflict } =
	proxyActivities<{
		discoverPMToolCapabilities: typeof DiscoverPMToolCapabilitiesFn;
		detectAndStampPmPushConflict: typeof DetectAndStampPmPushConflictFn;
	}>({
		startToCloseTimeout: "25 seconds",
		heartbeatTimeout: "20 seconds",
		retry: {
			initialInterval: "1s",
			maximumInterval: "5s",
			backoffCoefficient: 2,
			maximumAttempts: 2,
		},
	});

// =============================================================================
// Workflow Implementation
// =============================================================================

export async function storySyncWorkflow(
	input: StorySyncWorkflowInput,
): Promise<StorySyncWorkflowOutput> {
	const {
		projectId,
		mcpServerId,
		mcpConfigId,
		containerId,
		containerName,
		additionalContext,
		userId,
		organizationId,
		direction,
	} = input;

	// Workflow state
	let cancelled = false;
	const progress: StorySyncProgress = {
		status: "initializing",
		totalStories: 0,
		syncedCount: 0,
		failedCount: 0,
		conflictedCount: 0,
		message: "Initializing sync...",
		results: [],
	};

	// Cache for MCP tool results
	const cache: Record<string, unknown> = {};

	// ==========================================================================
	// Signal & Query Handlers
	// ==========================================================================

	setHandler(cancelSyncSignal, () => {
		log.info("Received cancel signal");
		cancelled = true;
		progress.status = "cancelled";
		progress.message = "Sync cancelled by user";
	});

	setHandler(progressQuery, () => progress);

	// ==========================================================================
	// Helper: Parse MCP response
	// ==========================================================================

	function parseMcpResponse(output: unknown): unknown {
		if (typeof output === "object" && output !== null) {
			const obj = output as Record<string, unknown>;
			if (Array.isArray(obj.content)) {
				const textContent = obj.content.find(
					(c: unknown) =>
						typeof c === "object" &&
						c !== null &&
						(c as Record<string, unknown>).type === "text",
				) as { text?: string } | undefined;
				if (textContent?.text) {
					try {
						return JSON.parse(textContent.text);
					} catch {
						return textContent.text;
					}
				}
			}
		}
		return output;
	}

	// ==========================================================================
	// Helper: Get cached or fetch MCP tool result
	// ==========================================================================

	async function getCachedOrFetch<T>(
		toolName: string,
		args: Record<string, unknown>,
		cacheKey: string,
	): Promise<T> {
		if (cache[cacheKey]) {
			log.info("Cache hit", { cacheKey });
			return cache[cacheKey] as T;
		}

		const result = await executeMcpTool({
			toolName,
			args,
			userId,
			organizationId,
			mcpConfigId: mcpConfigId ?? undefined,
		});

		if (result.success) {
			const data = parseMcpResponse(result.output);
			cache[cacheKey] = data;
			return data as T;
		}

		throw new Error(`MCP tool ${toolName} failed`);
	}

	// ==========================================================================
	// Helper: Build story description
	// ==========================================================================

	/**
	 * Strip markdown heading markers and bold wrappers from a line.
	 */
	function stripMarkdownHeader(line: string): string {
		return line
			.replace(/^#{1,6}\s*/, "")
			.replace(/\*{2}([^*]+)\*{2}/g, "$1")
			.trim();
	}

	// `cleanContentForPM` now lives at module scope (see above) so it can be
	// imported by the activity/workflow parity test.

	function stripTrailingJunk(text: string): string {
		return text
			.replace(/\n?#{1,3}\s*(EPIC|FEAT)-\d+:[\s\S]*$/i, "")
			.replace(/\n?(EPIC|FEAT)-\d+:[\s\S]*$/i, "")
			.replace(/\n?Acceptance Criteria\s*$/i, "")
			.replace(/\n?\*\s*\*\s*\*\s*$/i, "")
			.replace(/\n?---\s*$/i, "")
			.trim();
	}

	/**
	 * PM tools that use HTML rich text editors and need markdown converted to
	 * HTML (Fizzy ActionText/Lexxy, Asana `html_notes`, Monday update body).
	 * Markdown-native tools are in `MARKDOWN_DESCRIPTION_TOOLS`; Jira (ADF) and
	 * Azure DevOps are handled separately.
	 */
	const HTML_DESCRIPTION_TOOLS = new Set(["fizzy", "asana", "monday"]);

	/**
	 * PM tools that render Markdown natively (GitHub/GitLab Flavored Markdown,
	 * Linear, ClickUp `markdown_description`, Trello markdown subset) — they
	 * keep the raw markdown body. Kept in sync with the activity-side
	 * `MARKDOWN_DESCRIPTION_TOOLS` in `story-sync.ts`.
	 */
	const MARKDOWN_DESCRIPTION_TOOLS = new Set([
		"github",
		"gitlab",
		"linear",
		"clickup",
		"trello",
	]);

	/**
	 * Strip markdown formatting for PM tools that don't render it.
	 * Removes bold (**text**), heading markers (### ), and italic (*text*).
	 */
	function stripMarkdownForPlainText(text: string): string {
		return text
			.replace(/\*{2}([^*]+)\*{2}/g, "$1") // **bold** → bold
			.replace(/^#{1,6}\s+/gm, "") // ### Heading → Heading
			.replace(/(?<!\*)\*(?!\*)([^*]+)\*(?!\*)/g, "$1"); // *italic* → italic
	}

	function escapeHtml(text: string): string {
		return text
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;");
	}

	function convertInlineMarkdown(text: string): string {
		return escapeHtml(text)
			.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
			.replace(/\*([^*]+)\*/g, "<em>$1</em>");
	}

	// Workflow-local mirrors of `HTML_BACK_LINK_RE` /
	// `formatBackLinkForProvider` from packages/database/.../fabric-url.ts.
	// Workflows can't import non-deterministic code from @repo/database
	// (Prisma client), so we keep a pure-regex copy here — same pattern used
	// for markdownToSimpleHtml. Keep these in sync with fabric-url.ts.
	const WORKFLOW_HTML_BACK_LINK_RE =
		/<p>\s*<a\s+[^>]*href=["']([^"']+)["'][^>]*>\s*View in Fabric\s*<\/a>\s*<\/p>/i;

	function formatBackLinkForFizzy(
		description: string,
		providerDetectedType: string | null | undefined,
	): string {
		if ((providerDetectedType ?? "").toLowerCase() !== "fizzy") {
			return description;
		}
		const m = description.match(WORKFLOW_HTML_BACK_LINK_RE);
		if (!m) {
			return description;
		}
		return description.replace(
			WORKFLOW_HTML_BACK_LINK_RE,
			`[View in Fabric](${m[1]})`,
		);
	}

	function markdownToSimpleHtml(markdown: string): string {
		const blocks = markdown.split(/\n\n+/);

		function headingToHtml(line: string): string {
			const match = line.match(/^(#{1,6})\s+(.*)/);
			if (!match) {
				return `<p>${convertInlineMarkdown(line)}</p>`;
			}
			const level = Math.min(match[1].length, 3);
			const text = convertInlineMarkdown(match[2]);
			return `<h${level}>${text}</h${level}>`;
		}

		const htmlBlocks = blocks.flatMap((block) => {
			const trimmed = block.trim();
			if (!trimmed) {
				return "";
			}
			const lines = trimmed.split("\n");

			// Heading block: single line starting with # markers
			if (lines.length === 1 && /^#{1,6}\s+/.test(lines[0])) {
				return headingToHtml(lines[0]);
			}

			const isListBlock = lines.every(
				(l) => /^[-*]\s+/.test(l) || l.trim() === "",
			);
			if (isListBlock) {
				const items = lines
					.filter((l) => /^[-*]\s+/.test(l))
					.map(
						(l) =>
							`<li>${convertInlineMarkdown(l.replace(/^[-*]\s+/, ""))}</li>`,
					)
					.join("");
				return `<ul>${items}</ul>`;
			}

			// Mixed block: split into runs of headings, list items, and text
			const hasListItems = lines.some((l) => /^[-*]\s+/.test(l));
			const hasHeadings = lines.some((l) => /^#{1,6}\s+/.test(l));
			if (hasListItems || hasHeadings) {
				const parts: string[] = [];
				let nonListBuf: string[] = [];

				const flushNonList = () => {
					if (nonListBuf.length > 0) {
						const html = nonListBuf
							.map((l) => convertInlineMarkdown(l))
							.join("<br>");
						parts.push(`<p>${html}</p>`);
						nonListBuf = [];
					}
				};

				let listBuf: string[] = [];
				const flushList = () => {
					if (listBuf.length > 0) {
						const items = listBuf
							.map(
								(l) =>
									`<li>${convertInlineMarkdown(l.replace(/^[-*]\s+/, ""))}</li>`,
							)
							.join("");
						parts.push(`<ul>${items}</ul>`);
						listBuf = [];
					}
				};

				for (const l of lines) {
					if (/^#{1,6}\s+/.test(l)) {
						flushNonList();
						flushList();
						parts.push(headingToHtml(l));
					} else if (/^[-*]\s+/.test(l)) {
						flushNonList();
						listBuf.push(l);
					} else if (l.trim() === "") {
						// skip blank lines
					} else {
						flushList();
						nonListBuf.push(l);
					}
				}
				flushNonList();
				flushList();
				return parts;
			}

			const html = lines
				.map((l) => {
					if (/^#{1,6}\s+/.test(l)) {
						return `<strong>${convertInlineMarkdown(l.replace(/^#{1,6}\s+/, ""))}</strong>`;
					}
					return convertInlineMarkdown(l);
				})
				.join("<br>");
			return `<p>${html}</p>`;
		});
		return htmlBlocks.filter(Boolean).join("");
	}

	function buildDescription(story: {
		description?: string | null;
		acceptanceCriteria?: string | null;
		releaseNotes?: string | null;
		priority?: string;
		size?: string | null;
		storyPoints?: number | null;
		labels?: string[];
	}): string {
		const parts: string[] = [];

		// Extract the "View in Fabric" back-link wherever it currently lives
		// (acceptanceCriteria first, then description) so it can be re-
		// appended as the LAST part below — after AC, Notes/Links, and
		// Release Notes. Byte-for-byte invariant: when the anchor is already
		// at the end of description AND no other section follows, leave it
		// in place so the description string round-trips through the ADO
		// verbatim push path unchanged.
		let descriptionRaw = story.description ?? "";
		let acceptanceCriteriaRaw = story.acceptanceCriteria ?? "";
		const acBackLinkMatch = acceptanceCriteriaRaw.match(
			WORKFLOW_HTML_BACK_LINK_RE,
		);
		const descBackLinkMatch = acBackLinkMatch
			? null
			: descriptionRaw.match(WORKFLOW_HTML_BACK_LINK_RE);
		const hasContentAfterDescription =
			acceptanceCriteriaRaw.trim().length > 0 ||
			(story.releaseNotes ?? "").trim().length > 0;
		let backLinkMatch: RegExpMatchArray | null = null;
		if (acBackLinkMatch) {
			backLinkMatch = acBackLinkMatch;
			acceptanceCriteriaRaw = acceptanceCriteriaRaw
				.replace(WORKFLOW_HTML_BACK_LINK_RE, "")
				.replace(/\n{3,}/g, "\n\n")
				.trim();
		} else if (descBackLinkMatch && hasContentAfterDescription) {
			backLinkMatch = descBackLinkMatch;
			descriptionRaw = descriptionRaw
				.replace(WORKFLOW_HTML_BACK_LINK_RE, "")
				.replace(/\n{3,}/g, "\n\n")
				.trim();
		}

		// Clean description: strip all "User Story" headers (plain, bold, markdown heading)
		let description = descriptionRaw;
		description = description
			.replace(/^#{1,6}\s*\*{0,2}User Story\*{0,2}\s*\n*/i, "")
			.replace(/^\*{0,2}User Story\*{0,2}\s*\n*/i, "")
			.replace(/^User Story\s*\n*/i, "")
			.trim();
		if (description) {
			description = cleanContentForPM(description);
			parts.push(description);
		}

		// Clean acceptance criteria: extract Notes/Links and Release Notes if embedded
		// Use the back-link-stripped version computed above so the trailing
		// anchor doesn't trip the Notes/Links / Release Notes regexes below.
		let ac = acceptanceCriteriaRaw;
		let extractedNotesLinks = "";
		let extractedReleaseNotes = "";

		// Extract and remove "Notes / Links" section from AC
		const notesMatch = ac.match(
			/\n?#{0,6}\s*\*{0,2}Notes\s*[/&]\s*Links\*{0,2}\s*\n([\s\S]*?)(?=\n#{0,6}\s*\*{0,2}Release Notes|$)/i,
		);
		if (notesMatch) {
			extractedNotesLinks = notesMatch[1].trim();
			ac = ac.replace(notesMatch[0], "");
		}
		// Also try plain text "Notes / Links" header
		if (!extractedNotesLinks) {
			const plainNotesMatch = ac.match(
				/\n?Notes\s*[/&]\s*Links\s*\n([\s\S]*?)(?=\nRelease Notes|$)/i,
			);
			if (plainNotesMatch) {
				extractedNotesLinks = plainNotesMatch[1].trim();
				ac = ac.replace(plainNotesMatch[0], "");
			}
		}

		// Extract and remove "Release Notes" section from AC (if not stored separately)
		if (!story.releaseNotes) {
			const rnMatch = ac.match(
				/\n?#{0,6}\s*\*{0,2}Release Notes\*{0,2}\s*\n([\s\S]*?)$/i,
			);
			if (rnMatch) {
				extractedReleaseNotes = rnMatch[1].trim();
				ac = ac.replace(rnMatch[0], "");
			}
			// Also try plain text "Release Notes" header
			if (!extractedReleaseNotes) {
				const plainRnMatch = ac.match(
					/\n?Release Notes\s*\n([\s\S]*?)$/i,
				);
				if (plainRnMatch) {
					extractedReleaseNotes = plainRnMatch[1].trim();
					ac = ac.replace(plainRnMatch[0], "");
				}
			}
		}

		// Strip any leaked EPIC/FEAT headers and trailing junk from AC
		ac = stripTrailingJunk(ac);

		if (ac) {
			ac = cleanContentForPM(ac);
			parts.push(`**Acceptance Criteria:**\n\n${ac}`);
		}

		// Notes / Links: prefer extracted from AC
		if (extractedNotesLinks) {
			parts.push(
				`**Notes / Links:**\n\n${cleanContentForPM(extractedNotesLinks)}`,
			);
		}

		// Release notes: prefer stored field, fall back to extracted from AC
		const releaseNotes = stripTrailingJunk(
			(story.releaseNotes ?? extractedReleaseNotes).trim(),
		);
		if (releaseNotes) {
			parts.push(
				`**Release Notes:**\n\n${cleanContentForPM(releaseNotes)}`,
			);
		}

		// Re-append the "View in Fabric" back-link as the LAST part so it
		// renders at the bottom of the PM-tool card, not sandwiched between
		// description and AC.
		if (backLinkMatch) {
			parts.push(backLinkMatch[0]);
		}

		return parts.join("\n\n");
	}

	// ==========================================================================
	// Helper: Try to get account identifier from identity tool
	// ==========================================================================

	async function tryGetAccountIdentifier(
		capabilities: PMToolCapabilities,
	): Promise<string | undefined> {
		// Azure DevOps doesn't need account identifier — auth is via PAT.
		// Its `core_get_identity_ids` requires `searchFilter` and isn't a "who am I" tool.
		if (capabilities.detectedType === "azure-devops") {
			return undefined;
		}

		const identityTools = capabilities.availableTools.filter((name) =>
			/get_account|get_me|whoami/i.test(name),
		);

		if (identityTools.length === 0) {
			return undefined;
		}

		try {
			const identity = await getCachedOrFetch<Record<string, unknown>>(
				identityTools[0],
				{},
				"identity",
			);

			// Try common patterns for account identifiers
			if (
				identity.accounts &&
				Array.isArray(identity.accounts) &&
				identity.accounts[0]
			) {
				const account = identity.accounts[0] as Record<string, unknown>;
				return String(account.slug || account.id || account.key || "");
			}
			if (identity.workspace) {
				const ws = identity.workspace as Record<string, unknown>;
				return String(ws.slug || ws.id || ws.key || "");
			}
			if (identity.organization) {
				const org = identity.organization as Record<string, unknown>;
				return String(org.slug || org.id || org.key || "");
			}
			if (identity.slug || identity.id) {
				return String(identity.slug || identity.id);
			}
		} catch (e) {
			log.warn("Failed to get identity", { error: String(e) });
		}

		return undefined;
	}

	// ==========================================================================
	// Main Sync Logic
	// ==========================================================================

	try {
		log.info("Starting story sync workflow", {
			projectId,
			mcpConfigId,
			containerId,
			containerName,
			direction,
		});

		// 1. Discover PM tool capabilities dynamically.
		// This doubles as a fast preflight: capability discovery is the first
		// thing that actually talks to the PM tool, so if it can't be reached we
		// abort the whole batch HERE — before any item is touched — and tell the
		// user to retry. Previously a degraded PM tool made every item grind
		// through its own timeout-and-retry budget (minutes per item) before the
		// run gave up. The fail-fast proxy bounds the preflight to ~30s.
		progress.message = "Discovering PM tool capabilities...";
		let capabilities: Awaited<
			ReturnType<typeof discoverPMToolCapabilities>
		>;
		try {
			capabilities = await discoverPMToolCapabilities({
				mcpConfigId,
				mcpServerId,
				userId,
				organizationId,
				containerId,
			});
		} catch (preflightError) {
			const detail = extractActivityError(preflightError);
			log.warn(
				"PM preflight failed — aborting sync before any item was touched",
				{ projectId, detail },
			);
			progress.status = "failed";
			progress.message =
				"Couldn't reach the PM tool to start the sync — nothing was changed. Please try again shortly.";
			return {
				success: false,
				totalStories: 0,
				syncedCount: 0,
				failedCount: 0,
				conflictedCount: 0,
				results: [],
				error: progress.message,
			};
		}

		if (!capabilities || !capabilities.hasPMCapabilities) {
			progress.status = "failed";
			progress.message = "PM tool does not have required capabilities";
			throw ApplicationFailure.nonRetryable(
				"PM tool does not support task creation/update",
				"STORY_SYNC_VALIDATION_ERROR",
			);
		}

		// Azure DevOps MCP expects a project name, not a GUID.
		// Other tools (Fizzy, etc.) need the actual container/board ID.
		const isADO = capabilities.detectedType === "azure-devops";
		const containerValue = isADO
			? (containerName ?? containerId)
			: containerId;

		log.info("Resolved container value", {
			isADO,
			containerValue,
			detectedType: capabilities.detectedType,
		});

		// For pull: require taskList to list work items from ADO
		if (direction === "pull" && !capabilities.taskList) {
			progress.status = "failed";
			progress.message =
				"PM tool does not support listing work items (required for pull)";
			throw ApplicationFailure.nonRetryable(
				"Pull requires a list work items tool (e.g. wit_list_backlog_work_items for Azure DevOps)",
				"STORY_SYNC_VALIDATION_ERROR",
			);
		}

		log.info("Discovered PM capabilities", {
			detectedType: capabilities.detectedType,
			canCreate: !!capabilities.taskCreation,
			canUpdate: !!capabilities.taskUpdate,
			canGet: !!capabilities.taskGet,
			canList: !!capabilities.taskList,
			createTool: capabilities.taskCreation?.toolName,
			updateTool: capabilities.taskUpdate?.toolName,
			listTool: capabilities.taskList?.toolName,
		});

		// 2. Get stories/items to sync
		let stories: Array<{
			id: string;
			identifier: string;
			title?: string;
			description?: string | null;
			acceptanceCriteria?: string | null;
			releaseNotes?: string | null;
			priority?: string;
			size?: string | null;
			storyPoints?: number | null;
			labels?: string[];
			externalId?: string | null;
			externalUrl?: string | null;
			statusId?: string | null;
			kind?: string | null;
			workItemType?: string | null;
		}>;

		// Selective pull: only import user-chosen PM external IDs (skip orphan deletion)
		const isSelectivePull =
			!!input.pmExternalIds && input.pmExternalIds.length > 0;

		if (direction === "pull") {
			// Pull: list work items from PM, then create/update Fabric stories.
			const FETCH_PAGE_SIZE = 50;
			const MAX_PAGES = 200;
			type PmItem = Awaited<
				ReturnType<typeof ListWorkItemsFromPMFn>
			>["items"][number];
			let allPmItems: PmItem[] = [];
			// Once we've taken the selective-pull fast path, don't fall back to
			// backlog pagination — the whole point is to bypass that failure
			// mode. An empty result here must surface as "nothing imported",
			// not silently re-hit wit_list_backlogs.
			let selectiveFastPathAttempted = false;

			// Selective pull fast path: when the user picked specific external
			// IDs and the PM tool supports taskGet, fetch each item directly
			// instead of paginating the full backlog. This avoids the
			// wit_list_backlogs resolver failure for ADO teams whose backlog
			// categories the MCP server cannot enumerate.
			let selectivePullFailedIds: string[] = [];
			let selectivePullFailedErrors: Record<string, string> = {};
			if (
				isSelectivePull &&
				capabilities.taskGet &&
				input.pmExternalIds
			) {
				progress.message = `Fetching ${input.pmExternalIds.length} selected work item(s)...`;
				const fetched = await fetchPMItemsByIds({
					mcpConfigId,
					mcpServerId,
					containerId: containerValue,
					externalIds: input.pmExternalIds,
					additionalContext,
					userId,
					organizationId,
				});
				allPmItems = fetched.items;
				selectivePullFailedIds = fetched.failedIds ?? [];
				selectivePullFailedErrors = fetched.failedIdErrors ?? {};
				selectiveFastPathAttempted = true;
			}

			// Fizzy's bulk get_cards API returns max ~15 cards. Use per-column
			// strategy to fetch all cards from every column on the board.
			if (
				!selectiveFastPathAttempted &&
				allPmItems.length === 0 &&
				capabilities.detectedType === "fizzy"
			) {
				progress.message = "Fetching all Fizzy cards per column...";
				const fizzyResult = await listAllFizzyCards({
					mcpConfigId,
					mcpServerId,
					containerId: containerValue,
					additionalContext,
					userId,
					organizationId,
					capabilities,
				});
				if (fizzyResult) {
					allPmItems = fizzyResult.items;
				}
			}

			// Generic fetch loop (non-Fizzy, or Fizzy fallback when per-column failed)
			if (!selectiveFastPathAttempted && allPmItems.length === 0) {
				let currentPage = 1;
				let fetchMore = true;

				// Some PM tools (e.g. Fizzy) silently cap `per_page` to a value lower
				// than what we request, causing hasNextPage to incorrectly return false.
				// Use the same three-strategy approach as list-pm-tickets:
				//   1. Trust `total` from response when available.
				//   2. Detect effective page-size cap and keep going while full pages.
				//   3. Fall back to hasNextPage for well-behaved tools.
				let effectivePageSize: number | undefined;

				while (fetchMore && currentPage <= MAX_PAGES) {
					progress.message = `Fetching PM work items (page ${currentPage})...`;
					const pageResult = await listWorkItemsFromPM({
						mcpConfigId,
						mcpServerId,
						containerId: containerValue,
						additionalContext,
						userId,
						organizationId,
						page: currentPage,
						pageSize: FETCH_PAGE_SIZE,
					});
					allPmItems.push(...pageResult.items);

					if (pageResult.items.length === 0) {
						fetchMore = false;
					} else if (pageResult.total != null) {
						// PM tool returned a total count — trust it.
						fetchMore = allPmItems.length < pageResult.total;
					} else {
						// No total: detect effective page-size cap.
						if (
							effectivePageSize == null &&
							pageResult.items.length < FETCH_PAGE_SIZE
						) {
							effectivePageSize = pageResult.items.length;
						}
						fetchMore =
							pageResult.items.length >=
							(effectivePageSize ?? FETCH_PAGE_SIZE);
					}
					currentPage++;
				}
			}
			let pmItems = allPmItems;

			// Selective pull: filter to only the user-chosen PM external IDs
			if (input.pmExternalIds && input.pmExternalIds.length > 0) {
				const filterSet = new Set(input.pmExternalIds);
				pmItems = pmItems.filter((item) => filterSet.has(item.id));
				log.info("Selective pull: filtered PM items", {
					requested: input.pmExternalIds.length,
					matched: pmItems.length,
				});
			}

			progress.totalStories = pmItems.length;
			log.info("Work items from PM", {
				count: pmItems.length,
				failedIds:
					selectivePullFailedIds.length > 0
						? selectivePullFailedIds
						: undefined,
			});

			if (pmItems.length === 0) {
				if (isSelectivePull) {
					if (selectivePullFailedIds.length > 0) {
						progress.status = "failed";
						const firstError = Object.values(
							selectivePullFailedErrors,
						)[0];
						const errorSuffix = firstError
							? ` Error: ${firstError}`
							: " The PM tool may be misconfigured or the items may not exist.";
						progress.message = `Failed to fetch ${selectivePullFailedIds.length} work item(s) from PM tool: IDs ${selectivePullFailedIds.join(", ")}.${errorSuffix}`;
						return {
							success: false,
							totalStories: 0,
							syncedCount: 0,
							failedCount: selectivePullFailedIds.length,
							results: [],
						};
					}
					progress.status = "completed";
					progress.message =
						"No matching tickets found for the selected IDs";
					return {
						success: true,
						totalStories: 0,
						syncedCount: 0,
						failedCount: 0,
						results: [],
					};
				}
				// Full pull: PM board is empty — remove all Fabric stories synced from this board
				progress.message = "Removing stories (PM board is empty)...";
				const { deletedCount } = await deleteStoriesNotInPMList({
					projectId,
					organizationId,
					pmExternalIds: [],
				});
				progress.status = "completed";
				progress.message =
					deletedCount > 0
						? `PM board is empty. Removed ${deletedCount} story/stories from Kanban.`
						: "No work items found in PM";
				return {
					success: true,
					totalStories: 0,
					syncedCount: 0,
					failedCount: 0,
					results: [],
				};
			}

			// Count fetch failures toward the overall failedCount so they
			// surface in the final completion message.
			if (selectivePullFailedIds.length > 0) {
				progress.failedCount += selectivePullFailedIds.length;
				progress.totalStories += selectivePullFailedIds.length;
			}

			// Convert to story-like format for the loop below
			stories = pmItems.map((item) => ({
				id: item.id,
				identifier: item.id,
				title: item.title,
				description: item.description ?? null,
				externalId: item.id,
				externalUrl: item.url ?? null,
				workItemType: item.workItemType ?? null,
			}));
		} else {
			// Push: get Fabric stories to sync
			progress.message = "Fetching stories...";
			stories = await getStoriesToSync({
				projectId,
				organizationId,
				storyIds: input.storyIds,
				unsyncedOnly: input.unsyncedOnly ?? true,
				statusIds: input.statusIds,
				direction: "push",
			});

			progress.totalStories = stories.length;
			log.info("Stories to sync", { count: stories.length });

			if (stories.length === 0) {
				progress.status = "completed";
				progress.message = "No stories to sync";
				return {
					success: true,
					totalStories: 0,
					syncedCount: 0,
					failedCount: 0,
					results: [],
				};
			}
		}

		// 3. Get account identifier if needed (for push, not pull)
		let accountIdentifier =
			additionalContext?.account_slug || additionalContext?.workspace_id;
		if (direction === "push" && !accountIdentifier) {
			progress.message = "Fetching account info...";
			accountIdentifier = await tryGetAccountIdentifier(capabilities);
			if (accountIdentifier) {
				log.info("Got account identifier", { accountIdentifier });
			}
		}

		// 4. Sync each story
		progress.status = "syncing";

		for (const story of stories) {
			if (cancelled) {
				break;
			}

			progress.currentStoryId = story.id;
			progress.currentStoryIdentifier = story.identifier;
			progress.message = `Syncing ${story.identifier}...`;

			try {
				if (direction === "pull") {
					// Pull: create or update Fabric story from PM item
					const result = await createOrUpdateStoryFromPMItem({
						projectId,
						externalId: story.externalId ?? story.id,
						title: story.title ?? `Work Item ${story.id}`,
						description: story.description ?? null,
						externalUrl: story.externalUrl ?? undefined,
						userId,
						mcpConfigId,
						mcpServerId,
						containerId: containerValue,
						additionalContext,
						organizationId,
						capabilities,
						workItemType: story.workItemType ?? null,
						enableTypeMapping: input.enableTypeMapping,
					});

					progress.results.push({
						storyId: result.storyId,
						identifier: result.identifier,
						success: true,
						externalId: result.externalId,
						externalUrl: result.externalUrl,
					});
					progress.syncedCount++;
				} else if (direction === "push") {
					const title = story.title ?? story.identifier;
					const rawDescription = buildDescription(story);
					// For Fizzy, rewrite the trailing HTML back-link anchor as
					// a markdown link so markdownToSimpleHtml's inline-link
					// regex turns it back into a clean `<a>` instead of
					// escaping `<` / `>` into literal text. Identity for every
					// other provider.
					const withProviderBackLink = formatBackLinkForFizzy(
						rawDescription,
						capabilities.detectedType,
					);
					// ADO gets raw markdown (it has its own format handling).
					// HTML PM tools (Fizzy, Asana, Monday) get markdown→HTML.
					// Markdown-native tools (GitHub, GitLab, Linear, ClickUp,
					// Trello) keep the raw markdown. All others (e.g. Jira on
					// this text-only path) get plain text with markdown stripped.
					const description = isADO
						? rawDescription
						: HTML_DESCRIPTION_TOOLS.has(
									capabilities.detectedType ?? "",
								)
							? markdownToSimpleHtml(withProviderBackLink)
							: MARKDOWN_DESCRIPTION_TOOLS.has(
										capabilities.detectedType ?? "",
									)
								? withProviderBackLink
								: stripMarkdownForPlainText(
										withProviderBackLink,
									);

					// If story was previously synced to a different PM tool (e.g.
					// Fizzy) and the project has since switched (e.g. to ADO), the
					// stale externalId would route us into the update path against
					// the wrong tool, which silently fails. Clear the stale link so
					// we take the create path and assign a fresh external id.
					const staleLink = existingLinkBelongsToDifferentTool(
						story.externalUrl,
						capabilities.detectedType,
					);
					if (staleLink) {
						log.warn(
							"Existing external link belongs to a different PM tool; clearing stale reference to force create",
							{
								storyId: story.id,
								identifier: story.identifier,
								externalUrl: story.externalUrl,
								detectedType: capabilities.detectedType,
							},
						);
					}
					const effectiveExternalId = staleLink
						? undefined
						: story.externalId;

					if (effectiveExternalId && capabilities.taskUpdate) {
						// Before overwriting the PM item, check whether it drifted
						// since our last sync. On drift, stamp the story CONFLICT
						// (so it surfaces in Review Center) and skip the overwrite
						// instead of silently clobbering the PM-side edit or failing
						// with a generic error. patched() keeps workflows already
						// in-flight on the prior version replay-deterministic.
						let conflictDetected = false;
						if (patched("bulk-sync-conflict-detection-v2")) {
							// Reuse the capabilities discovered once above (+ the
							// external id) so the check skips a per-item capability
							// discovery — that redundant discovery made large batch
							// syncs take tens of seconds per item.
							const conflictCheck =
								await detectAndStampPmPushConflict({
									itemId: story.id,
									itemType: "story",
									projectId,
									mcpConfigId,
									mcpServerId,
									containerId: containerValue,
									containerName,
									additionalContext,
									userId,
									organizationId,
									externalId: effectiveExternalId,
									capabilities,
								});
							conflictDetected = conflictCheck.hasConflict;
						} else if (patched("bulk-sync-conflict-detection-v1")) {
							// Original call shape — preserved so histories recorded
							// on the prior version replay deterministically.
							const conflictCheck =
								await detectAndStampPmPushConflict({
									itemId: story.id,
									itemType: "story",
									projectId,
									mcpConfigId,
									mcpServerId,
									containerId: containerValue,
									containerName,
									additionalContext,
									userId,
									organizationId,
								});
							conflictDetected = conflictCheck.hasConflict;
						}
						if (conflictDetected) {
							log.info(
								"Bulk sync conflict — routed to Review Center",
								{
									storyId: story.id,
									identifier: story.identifier,
								},
							);
							progress.results.push({
								storyId: story.id,
								identifier: story.identifier,
								success: false,
								outcome: "conflict",
								externalId: effectiveExternalId,
								externalUrl: story.externalUrl ?? undefined,
								error: "Changed in the PM tool since the last sync — resolve it in Review Center.",
							});
							progress.conflictedCount++;
							continue;
						}
						// Update existing task using discovered tool
						const updateTool = capabilities.taskUpdate;
						let updateArgs: Record<string, unknown>;

						// Debug: Log available params for update tool
						log.info("Update tool params", {
							toolName: updateTool.toolName,
							idParam: updateTool.idParam,
							externalId: story.externalId,
							allParamNames: updateTool.allParams.map(
								(p) => p.name,
							),
							accountIdentifier,
							containerId,
							updatesBased: !!updateTool.updatesBased,
						});

						if (updateTool.updatesBased) {
							// Azure DevOps: id + updates array (JSON Patch style)
							const updates: Array<{
								op: string;
								path: string;
								value: string;
							}> = [];
							updates.push({
								op: "add",
								path: "/fields/System.Title",
								value: title,
							});
							updates.push({
								op: "add",
								path: "/fields/System.Description",
								value: description,
							});
							updateArgs = {
								[updateTool.idParam]: effectiveExternalId,
								[updateTool.updatesBased.updatesParam]: updates,
							};
						} else {
							updateArgs = {
								[updateTool.idParam]: effectiveExternalId,
							};
							if (updateTool.titleParam) {
								updateArgs[updateTool.titleParam] = title;
							}
							if (updateTool.descriptionParam) {
								updateArgs[updateTool.descriptionParam] =
									description;
							}
						}

						// Add account identifier if needed
						if (accountIdentifier) {
							const accountParams = [
								"account_slug",
								"workspace_id",
								"organization_id",
								"team_id",
							];
							for (const param of accountParams) {
								if (
									updateTool.allParams.some(
										(p) => p.name === param,
									)
								) {
									updateArgs[param] = accountIdentifier;
									break;
								}
							}
						}

						// Add container value (board_id, project_id, etc.) if needed
						// Some PM tools require container context even for updates
						if (containerValue) {
							const containerParams = [
								"board_id",
								"project_id",
								"project_key",
								"team_id",
								"repo",
								"list_id",
							];
							for (const param of containerParams) {
								if (
									updateTool.allParams.some(
										(p) => p.name === param,
									)
								) {
									updateArgs[param] = containerValue;
									break;
								}
							}
						}

						// Debug: Log final args being sent
						log.info("Executing update with args", {
							toolName: updateTool.toolName,
							args: updateArgs,
						});

						const updateResult = await executeMcpTool({
							toolName: updateTool.toolName,
							args: updateArgs,
							userId,
							organizationId,
							// Read-only mode write-gate: this bulk
							// board push writes in-flight over minutes, so routing
							// projectId to the chokepoint is what blocks stories
							// still queued when the mode is toggled mid-run (AC3).
							projectId,
							mcpConfigId: mcpConfigId ?? undefined,
						});

						if (!updateResult.success) {
							const mcpError = parseMcpResponse(
								updateResult.output,
							);
							const errorDetail =
								typeof mcpError === "string"
									? mcpError
									: typeof mcpError === "object" &&
											mcpError !== null &&
											"error" in mcpError
										? String(
												(
													mcpError as Record<
														string,
														unknown
													>
												).error,
											)
										: "Unknown error";
							throw new Error(
								`Failed to update work item ${effectiveExternalId}: ${errorDetail}`,
							);
						}

						progress.results.push({
							storyId: story.id,
							identifier: story.identifier,
							success: true,
							externalId: effectiveExternalId,
							externalUrl: story.externalUrl ?? undefined,
						});
						progress.syncedCount++;
					} else if (
						effectiveExternalId &&
						!capabilities.taskUpdate
					) {
						throw new Error(
							`Story ${story.identifier} is linked to external ID ${effectiveExternalId} but the PM tool does not support updates. ` +
								"Disconnect the story first or use a PM tool that supports updating work items.",
						);
					} else if (capabilities.taskCreation) {
						// Create new task using discovered tool
						const createTool = capabilities.taskCreation;
						let createArgs: Record<string, unknown>;

						if (createTool.fieldsBased) {
							// Azure DevOps MCP expects fields as array: [{ name, value, format? }]
							// See: https://github.com/microsoft/azure-devops-mcp/blob/main/src/tools/work-items.ts
							const fieldsArray: Array<{
								name: string;
								value: string;
								format?: "Html" | "Markdown";
							}> = [
								{
									name: createTool.fieldsBased.titleKey,
									value: title,
								},
								{
									name: createTool.fieldsBased.descriptionKey,
									value: description,
									format: "Markdown",
								},
							];
							// Azure DevOps requires backslashes for AreaPath/IterationPath (TF401347)
							// Skip if value is a URL (common misconfiguration)
							if (
								additionalContext?.areaPath &&
								!additionalContext.areaPath
									.trim()
									.startsWith("http")
							) {
								fieldsArray.push({
									name: "System.AreaPath",
									value: additionalContext.areaPath
										.trim()
										.replace(/\//g, "\\"),
								});
							}
							if (
								additionalContext?.iterationPath &&
								!additionalContext.iterationPath
									.trim()
									.startsWith("http")
							) {
								fieldsArray.push({
									name: "System.IterationPath",
									value: additionalContext.iterationPath
										.trim()
										.replace(/\//g, "\\"),
								});
							}
							const legacyWorkItemType =
								additionalContext?.workItemType ?? "User Story";
							const workItemType =
								input.enableTypeMapping && story.kind
									? resolveWorkItemType(
											story.kind as StoryKindValue,
											{
												mapping:
													parseWorkItemTypeMapping(
														additionalContext as
															| Record<
																	string,
																	unknown
															  >
															| undefined,
													),
												legacyFallback:
													legacyWorkItemType,
											},
										)
									: legacyWorkItemType;
							createArgs = {
								[createTool.containerParam]: containerValue,
								[createTool.fieldsBased.workItemTypeParam]:
									workItemType,
								[createTool.fieldsBased.fieldsParam]:
									fieldsArray,
							};
						} else {
							createArgs = {
								[createTool.containerParam]: containerValue,
								[createTool.titleParam]: title,
							};
							if (createTool.descriptionParam) {
								createArgs[createTool.descriptionParam] =
									description;
							}
						}

						// Add account identifier if needed (Fizzy/etc - not ADO)
						if (accountIdentifier && !createTool.fieldsBased) {
							const accountParams = [
								"account_slug",
								"workspace_id",
								"organization_id",
								"team_id",
							];
							for (const param of accountParams) {
								if (
									createTool.allParams.some(
										(p) => p.name === param,
									)
								) {
									createArgs[param] = accountIdentifier;
									break;
								}
							}
						}

						// Log the args being sent for debugging
						log.info("Creating work item", {
							toolName: createTool.toolName,
							project: createArgs[createTool.containerParam],
							workItemType: createTool.fieldsBased
								? createArgs[
										createTool.fieldsBased.workItemTypeParam
									]
								: undefined,
							fieldCount: createTool.fieldsBased
								? (
										createArgs[
											createTool.fieldsBased.fieldsParam
										] as unknown[]
									)?.length
								: undefined,
						});

						const createResult = await executeMcpTool({
							toolName: createTool.toolName,
							args: createArgs,
							userId,
							organizationId,
							// Read-only mode write-gate — see the
							// update path above; blocks in-flight bulk creates.
							projectId,
							mcpConfigId: mcpConfigId ?? undefined,
						});

						if (createResult.success) {
							const parsed = parseMcpResponse(
								createResult.output,
							) as Record<string, unknown>;
							const externalId = String(
								parsed.id ||
									parsed.card_id ||
									parsed.issue_id ||
									parsed.task_id ||
									"",
							);
							// Azure DevOps: URL in _links.web.href
							const links = parsed._links as
								| { web?: { href?: string } }
								| undefined;
							const externalUrl = String(
								links?.web?.href ||
									parsed.url ||
									parsed.link ||
									parsed.webUrl ||
									parsed.web_url ||
									"",
							);

							if (externalId) {
								await updateStoryExternalRefs({
									storyId: story.id,
									projectId,
									externalId,
									externalUrl: externalUrl || undefined,
								});
							}

							progress.results.push({
								storyId: story.id,
								identifier: story.identifier,
								success: true,
								externalId: externalId || undefined,
								externalUrl: externalUrl || undefined,
							});
							progress.syncedCount++;
						} else {
							// Extract actual error message from MCP response
							const mcpError = parseMcpResponse(
								createResult.output,
							);
							const errorDetail =
								typeof mcpError === "string"
									? mcpError
									: typeof mcpError === "object" &&
											mcpError !== null &&
											"error" in mcpError
										? String(
												(
													mcpError as Record<
														string,
														unknown
													>
												).error,
											)
										: "Unknown error";
							throw new Error(
								`Failed to create work item: ${errorDetail}. ` +
									"Try changing Work Item Type in Project Settings " +
									"(Scrum = Product Backlog Item, Agile = User Story, Basic = Issue).",
							);
						}
					} else {
						throw new Error(
							"PM tool does not support task creation",
						);
					}
				}
			} catch (error) {
				const errorMessage = extractActivityError(error);
				log.error("Failed to sync story", {
					storyId: story.id,
					identifier: story.identifier,
					error: errorMessage,
				});

				progress.results.push({
					storyId: story.id,
					identifier: story.identifier,
					success: false,
					error: errorMessage,
				});
				progress.failedCount++;
			}
		}

		// 4b. Pull only: remove Fabric stories that no longer exist in PM.
		//     Skip this step when the user made a selective pull (pmExternalIds filter),
		//     because the fetched list is intentionally partial — deleting orphans would
		//     remove stories that were simply not selected by the user.
		let deletedOrphanedCount = 0;
		if (direction === "pull" && !cancelled && !isSelectivePull) {
			progress.message = "Removing stories deleted in PM...";
			const pmExternalIds = stories.map((s) => s.id);
			const { deletedCount } = await deleteStoriesNotInPMList({
				projectId,
				organizationId,
				pmExternalIds,
			});
			deletedOrphanedCount = deletedCount;
			if (deletedCount > 0) {
				log.info("Removed orphaned stories", {
					deletedCount,
					projectId,
				});
			}
		}

		// 5. Finalize
		if (cancelled) {
			progress.status = "cancelled";
			progress.message = `Sync cancelled. ${progress.syncedCount} of ${progress.totalStories} stories synced.`;
		} else if (
			progress.failedCount > 0 &&
			progress.syncedCount === 0 &&
			progress.conflictedCount === 0
		) {
			progress.status = "failed";
			progress.message = `Sync failed. All ${progress.failedCount} stories failed.`;
		} else {
			progress.status = "completed";
			const parts: string[] = [];
			if (progress.syncedCount > 0) {
				parts.push(`${progress.syncedCount} synced`);
			}
			if (progress.conflictedCount > 0) {
				parts.push(`${progress.conflictedCount} need review`);
			}
			if (progress.failedCount > 0) {
				parts.push(`${progress.failedCount} failed`);
			}
			if (deletedOrphanedCount > 0) {
				parts.push(`${deletedOrphanedCount} removed (deleted in PM)`);
			}
			progress.message = parts.length
				? `Sync complete. ${parts.join(", ")}.`
				: "Sync complete.";
		}

		log.info("Story sync workflow completed", {
			status: progress.status,
			syncedCount: progress.syncedCount,
			failedCount: progress.failedCount,
		});

		return {
			success: progress.failedCount === 0 && !cancelled,
			totalStories: progress.totalStories,
			syncedCount: progress.syncedCount,
			failedCount: progress.failedCount,
			conflictedCount: progress.conflictedCount,
			results: progress.results,
			error: cancelled ? "Cancelled by user" : undefined,
		};
	} catch (error) {
		if (error instanceof ApplicationFailure) {
			throw error;
		}

		const errorMessage = extractActivityError(error);
		log.error("Story sync workflow failed", { error: errorMessage });

		progress.status = "failed";
		progress.message = errorMessage;

		throw ApplicationFailure.nonRetryable(
			errorMessage,
			"STORY_SYNC_FAILED",
		);
	}
}

/**
 * Extract the actual error message from Temporal's wrapped errors.
 * Temporal wraps activity failures in ActivityFailure -> ApplicationFailure -> actual error.
 */
function extractActivityError(error: unknown): string {
	if (!error) {
		return "Unknown error";
	}
	if (error instanceof ActivityFailure && error.cause) {
		return extractActivityError(error.cause);
	}
	if (error instanceof ApplicationFailure) {
		if (error.cause) {
			const causeMsg = extractActivityError(error.cause);
			if (causeMsg && causeMsg !== "Unknown error") {
				return causeMsg;
			}
		}
		return error.message;
	}
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}
