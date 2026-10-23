/**
 * Fetch PM Hierarchy Activities
 *
 * Fetches work items from a PM tool organized by type (epics, features, stories).
 * Used by the backlog updater to compare existing PM items against Fabric's backlog.
 */
import { logger } from "@repo/logs";
import {
	extractAtlassianSiteId,
	extractPMListArray,
	findBacklogsListTool,
	readPMListPagingEvidence,
	unwrapDataEnvelope,
} from "@repo/utils";
import { descriptionToText } from "@repo/utils/adf-text";
import {
	type PMBoardReadErrorKind,
	pmBoardReadError,
} from "../../lib/pm-board-read-error";
import { executeMcpTool } from "../orchestrator/execution/execute-mcp-tool";
import { assertPmMcpTargetOrigin } from "../pm-source";
import {
	discoverPMToolCapabilities,
	type PMWorkItemSummary,
	readFizzyBoardCards,
} from "./story-sync";
import type { PMToolCapabilities } from "./tool-analyzer";

/**
 * Per-item description cap applied at the source.
 *
 * The downstream backlog-context LLM prompt inlines at most 150 characters
 * of PM-item description. Capping here reduces description data in activity
 * results when PM tools return many items with long descriptions. 500 chars
 * leaves a ~3.3x buffer over current prompt usage.
 *
 * The `raw` field is preserved by default because consumers may rely on its
 * structure. Prompt-only reads omit it through the hierarchy finalizer below.
 */
export const PM_HIERARCHY_DESCRIPTION_MAX_CHARS = 500;

function truncatePmItemDescription(item: PMWorkItemSummary): PMWorkItemSummary {
	if (
		!item.description ||
		item.description.length <= PM_HIERARCHY_DESCRIPTION_MAX_CHARS
	) {
		return item;
	}
	return {
		...item,
		description: item.description.slice(
			0,
			PM_HIERARCHY_DESCRIPTION_MAX_CHARS,
		),
	};
}

function truncatePmHierarchyDescriptions(
	result: PMHierarchyResult,
	forPrompt = false,
): PMHierarchyResult {
	const prepareItem = (item: PMWorkItemSummary): PMWorkItemSummary => {
		const truncated = truncatePmItemDescription(item);
		if (!forPrompt) {
			return truncated;
		}
		const { raw: _raw, ...summary } = truncated;
		return summary;
	};
	return {
		...result,
		epics: result.epics.map(prepareItem),
		features: result.features.map(prepareItem),
		stories: result.stories.map(prepareItem),
	};
}

// ============================================================================
// ADO Team Resolution
// ============================================================================

/**
 * Auto-resolve the default ADO team for a project.
 *
 * The wizard hierarchy detection only finds `core_list_projects` (not
 * `core_list_project_teams`) because the container-type extractor can't
 * parse "project_teams" as a single type. This means `additionalContext`
 * never contains `team`. Instead of failing, we resolve it on the fly by
 * calling `core_list_project_teams` and picking the first team.
 */
export async function resolveAdoDefaultTeam(params: {
	project: string;
	mcpConfigId: string;
	userId: string;
	organizationId?: string;
	availableTools: string[];
}): Promise<string | undefined> {
	// Find the teams list tool (core_list_project_teams or prefixed variant)
	const teamsToolName = params.availableTools.find((t) =>
		/list[_-]?project[_-]?teams?$/i.test(t),
	);
	if (!teamsToolName) {
		logger.warn("[ADO Team Resolution] No project teams tool found", {
			availableTools: params.availableTools.filter((t) =>
				/team/i.test(t),
			),
		});
		return undefined;
	}

	try {
		const result = await executeMcpTool({
			toolName: teamsToolName,
			args: { project: params.project },
			userId: params.userId,
			organizationId: params.organizationId,
			mcpConfigId: params.mcpConfigId,
		});

		if (!result.success) {
			logger.warn("[ADO Team Resolution] Tool call failed", {
				toolName: teamsToolName,
			});
			return undefined;
		}

		// Parse response — ADO returns array of team objects
		let teams: Array<Record<string, unknown>> = [];
		const output = result.output as Record<string, unknown>;
		if (Array.isArray(output?.content)) {
			const textItem = (
				output.content as Array<{ type?: string; text?: string }>
			).find((c) => c.type === "text");
			if (textItem?.text) {
				try {
					const parsed = JSON.parse(textItem.text);
					teams = Array.isArray(parsed) ? parsed : [];
				} catch {
					/* ignore parse errors */
				}
			}
		}

		if (teams.length === 0) {
			logger.warn("[ADO Team Resolution] No teams found for project", {
				project: params.project,
			});
			return undefined;
		}

		// Use the first team's name
		const teamName = (teams[0].name ?? teams[0].displayName) as
			| string
			| undefined;
		logger.info("[ADO Team Resolution] Resolved default team", {
			project: params.project,
			team: teamName,
			totalTeams: teams.length,
		});
		return teamName;
	} catch (error) {
		logger.warn("[ADO Team Resolution] Failed to resolve team", {
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

/**
 * Parse the JSON payload out of an MCP tool result's `{ content: [{ text }] }`
 * wrapper. Returns undefined when the output isn't the expected shape or the
 * text isn't valid JSON.
 */
function parseMcpJsonFromOutput(output: unknown): unknown {
	const rec = output as Record<string, unknown> | null;
	if (rec && Array.isArray(rec.content)) {
		const textItem = (
			rec.content as Array<{ type?: string; text?: string }>
		).find((c) => c.type === "text");
		if (textItem?.text) {
			try {
				return JSON.parse(textItem.text);
			} catch {
				return undefined;
			}
		}
	}
	return undefined;
}

/**
 * Resolve the Atlassian `cloudId` for a Rovo MCP connection by calling
 * `getAccessibleAtlassianResources` (returns `[{ id: cloudId, name, url }]`).
 * Every Rovo Jira/Confluence tool requires this id; on create it isn't carried
 * in the project container context, so we resolve it just-in-time. Picks the
 * first site (matches the picker's behaviour; multi-site is not yet selectable).
 */
export async function resolveAtlassianCloudId(params: {
	mcpConfigId: string;
	userId: string;
	organizationId?: string;
	availableTools: string[];
}): Promise<string | undefined> {
	const toolName = params.availableTools.find((t) =>
		/getAccessibleAtlassianResources$/i.test(t),
	);
	if (!toolName) {
		return undefined;
	}
	try {
		const result = await executeMcpTool({
			toolName,
			args: {},
			userId: params.userId,
			organizationId: params.organizationId,
			mcpConfigId: params.mcpConfigId,
		});
		if (!result.success) {
			return undefined;
		}
		const cloudId = extractAtlassianSiteId(
			parseMcpJsonFromOutput(result.output),
		);
		return cloudId ?? undefined;
	} catch (error) {
		logger.warn("[Jira CloudId] Failed to resolve cloudId", {
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

/**
 * Choose a default Jira issue type from a project's issue-type metadata.
 *
 * Considers only board-level standard types: excludes sub-tasks
 * (`subtask: true` / `hierarchyLevel < 0`) and Epics (`hierarchyLevel > 0`).
 * `hierarchyLevel` may be absent on older Jira — treated as standard. Fabric
 * features map to UserStory, so prefer "Story", then "Task", else the first
 * standard type; falls back to the literal "Task".
 */
export function pickDefaultJiraIssueType(
	issueTypes: Array<Record<string, unknown>>,
): string {
	const FALLBACK = "Task";
	const standard = issueTypes.filter((t) => {
		if (t.subtask === true) {
			return false;
		}
		const lvl = t.hierarchyLevel;
		return typeof lvl === "number" ? lvl === 0 : true;
	});
	const byName = (name: string) =>
		standard.find((t) => String(t.name ?? "").toLowerCase() === name);
	const chosen = byName("story") ?? byName("task") ?? standard[0];
	const name = chosen?.name;
	return typeof name === "string" && name.length > 0 ? name : FALLBACK;
}

/**
 * Resolve a default Jira issue type name for `createJiraIssue` by reading the
 * project's issue-type metadata. Returns "Task" when the metadata can't be
 * fetched (no cloudId, tool missing, call fails).
 */
export async function resolveJiraDefaultIssueType(params: {
	projectKey: string;
	cloudId?: string;
	mcpConfigId: string;
	userId: string;
	organizationId?: string;
	availableTools: string[];
}): Promise<string> {
	const FALLBACK = "Task";
	if (!params.cloudId) {
		return FALLBACK;
	}
	const toolName = params.availableTools.find((t) =>
		/(?:get|list)JiraProjectIssueTypesMetadata$/i.test(t),
	);
	if (!toolName) {
		return FALLBACK;
	}
	try {
		const result = await executeMcpTool({
			toolName,
			args: {
				cloudId: params.cloudId,
				projectIdOrKey: params.projectKey,
			},
			userId: params.userId,
			organizationId: params.organizationId,
			mcpConfigId: params.mcpConfigId,
		});
		if (!result.success) {
			return FALLBACK;
		}
		const output = parseMcpJsonFromOutput(result.output) as
			| Record<string, unknown>
			| undefined;
		const parsed = output && unwrapDataEnvelope(output, ["issueTypes"]);
		const types = Array.isArray(parsed?.issueTypes)
			? (parsed.issueTypes as Array<Record<string, unknown>>)
			: [];
		return pickDefaultJiraIssueType(types);
	} catch (error) {
		logger.warn(
			"[Jira IssueType] Failed to resolve issue type, using fallback",
			{
				error: error instanceof Error ? error.message : String(error),
			},
		);
		return FALLBACK;
	}
}

/**
 * Fill the `cloudId` and issue type that Rovo's `createJiraIssue` requires.
 * Rovo v1 names the issue-type param `issueTypeName`; v2 names it `issueType`.
 */
export async function fillJiraCreateArgs(params: {
	createArgs: Record<string, unknown>;
	createParams: Array<{ name: string }>;
	projectKey: string;
	savedCloudId?: string;
	mcpConfigId: string;
	userId: string;
	organizationId?: string;
	availableTools: string[];
}): Promise<void> {
	const { createArgs } = params;
	const declares = (name: string) =>
		params.createParams.some((p) => p.name === name);
	const issueTypeParam = ["issueTypeName", "issueType"].find(declares);
	const needsCloudId = !createArgs.cloudId && declares("cloudId");
	const needsIssueType =
		issueTypeParam !== undefined && !createArgs[issueTypeParam];
	if (!needsCloudId && !needsIssueType) {
		return;
	}
	const existing =
		typeof createArgs.cloudId === "string" ? createArgs.cloudId : "";
	const cloudId =
		existing ||
		params.savedCloudId ||
		(await resolveAtlassianCloudId(params));
	if (needsCloudId && cloudId) {
		createArgs.cloudId = cloudId;
	}
	if (needsIssueType && issueTypeParam) {
		createArgs[issueTypeParam] = await resolveJiraDefaultIssueType({
			...params,
			cloudId,
		});
	}
}

// ============================================================================
// Types
// ============================================================================

export interface FetchPMHierarchyInput {
	/**
	 * The caller only reads identity, title, state, URL, type and a short
	 * description for a prompt. Allows provider summary projections and omits raw.
	 */
	forPrompt?: boolean;
	projectId: string;
	mcpConfigId: string;
	containerId: string;
	additionalContext?: Record<string, string>;
	userId: string;
	organizationId?: string;
	capabilities?: PMToolCapabilities;
}

export interface PMHierarchyResult {
	readStatus?: "ok" | "no-columns" | "failed";
	readErrorKind?: PMBoardReadErrorKind;
	listingTruncated?: boolean;
	epics: PMWorkItemSummary[];
	features: PMWorkItemSummary[];
	stories: PMWorkItemSummary[];
	/** Detected PM tool type (e.g. "fizzy", "azure-devops", "linear") */
	detectedType?: string;
}

// Keep the activity result within Temporal payload limits; analysis prompts are token-budgeted.
const PM_LIST_PAGE_SIZE = 50;
const PM_LIST_MAX_ITEMS = 500;
const PM_LIST_MAX_PAGES = 20;

/** ADO backlog category reference names (these are categoryReferenceName values, NOT WIT names) */
const ADO_WORK_ITEM_TYPE_TO_BACKLOG: Record<string, string> = {
	Epic: "Microsoft.EpicCategory",
	Feature: "Microsoft.FeatureCategory",
	"User Story": "Microsoft.RequirementCategory",
	// Basic process template uses "Issue" instead of "User Story"
	Issue: "Microsoft.RequirementCategory",
};

export type AdoBacklogEntry = {
	id?: string;
	name?: string;
	categoryReferenceName?: string;
	workItemTypes?: Array<{ name?: string }>;
};

/**
 * Fetch the list of backlogs from ADO (called once, result reused for all types).
 */
export async function fetchAdoBacklogs(params: {
	project: string;
	team: string;
	mcpConfigId: string;
	userId: string;
	organizationId?: string;
	backlogsListToolName: string;
	strict?: boolean;
}): Promise<AdoBacklogEntry[]> {
	const result = await executeMcpTool({
		toolName: params.backlogsListToolName,
		args: { project: params.project, team: params.team },
		userId: params.userId,
		organizationId: params.organizationId,
		mcpConfigId: params.mcpConfigId,
	});

	if (!result.success) {
		if (params.strict) {
			throw new Error("PM board read failed.", { cause: result });
		}
		return [];
	}

	try {
		const output = result.output as Record<string, unknown>;
		const content = output?.content as
			| Array<{ type?: string; text?: string }>
			| undefined;
		const textItem = Array.isArray(content)
			? content.find((c) => c?.type === "text")
			: undefined;
		if (textItem?.text) {
			const parsed = JSON.parse(textItem.text);
			if (Array.isArray(parsed)) {
				return parsed;
			}
			if (params.strict) {
				logger.warn(
					"[Fetch PM Hierarchy] Unrecognized backlog categories response",
					{
						keys:
							parsed && typeof parsed === "object"
								? Object.keys(parsed)
								: [],
					},
				);
				throw new Error("Unreadable Azure DevOps backlog categories.");
			}
			return [];
		}
	} catch {
		if (params.strict) {
			throw new Error("Unreadable Azure DevOps backlog categories.");
		}
	}
	// Unlike the shared list parsers, this is one ADO tool whose answer is a
	// bare array. Without categories no list call runs, so in strict mode any
	// other answer must fail the read rather than pass as an empty board.
	if (params.strict) {
		logger.warn(
			"[Fetch PM Hierarchy] Unrecognized backlog categories response",
			{
				keys:
					result.output && typeof result.output === "object"
						? Object.keys(result.output)
						: [],
			},
		);
		throw new Error("Unreadable Azure DevOps backlog categories.");
	}
	return [];
}

/**
 * Get the category identifier from a backlog entry.
 * ADO returns the category in the `id` field (e.g. "Microsoft.EpicCategory"),
 * not in a separate `categoryReferenceName` field.
 */
function getBacklogCategory(entry: AdoBacklogEntry): string | undefined {
	return entry.categoryReferenceName ?? entry.id;
}

/**
 * Resolve ADO backlog ID for a work item type using pre-fetched backlogs list.
 */
function resolveAdoBacklogId(
	workItemType: string,
	backlogs: AdoBacklogEntry[],
): string | undefined {
	const targetRef = ADO_WORK_ITEM_TYPE_TO_BACKLOG[workItemType];
	if (targetRef) {
		const match = backlogs.find((b) => getBacklogCategory(b) === targetRef);
		if (match) {
			return getBacklogCategory(match);
		}
	}

	// Don't fall back to backlogs[0] — that causes all types to use the same backlog
	return undefined;
}

/**
 * Build a work item type mapping from ADO backlogs.
 * Returns the actual work item type names available in the project
 * (e.g., Basic template has Issue instead of User Story, no Feature at all).
 */
export function buildAdoTypeMapping(backlogs: AdoBacklogEntry[]): {
	epicType?: string;
	featureType?: string;
	storyType?: string;
	hasFeatureCategory: boolean;
} {
	let epicType: string | undefined;
	let featureType: string | undefined;
	let storyType: string | undefined;
	let hasFeatureCategory = false;

	for (const backlog of backlogs) {
		const category = getBacklogCategory(backlog);
		const typeName = backlog.workItemTypes?.[0]?.name;

		if (category === "Microsoft.EpicCategory" && typeName) {
			epicType = typeName;
		} else if (category === "Microsoft.FeatureCategory") {
			hasFeatureCategory = true;
			if (typeName) {
				featureType = typeName;
			}
		} else if (category === "Microsoft.RequirementCategory" && typeName) {
			storyType = typeName;
		}
	}

	return { epicType, featureType, storyType, hasFeatureCategory };
}

/**
 * Parse a list tool response into PMWorkItemSummary array.
 */
export function parseListResponse(
	output: unknown,
	strict = false,
): PMWorkItemSummary[] {
	return parseListPage(output, strict).items;
}

function parseListPage(
	output: unknown,
	strict = false,
): {
	items: PMWorkItemSummary[];
	total?: number;
	rawCount: number;
	hasNextPage: boolean;
	recognized: boolean;
} {
	const items: PMWorkItemSummary[] = [];
	let data: unknown = output;

	if (data && typeof data === "object") {
		const obj = data as Record<string, unknown>;
		if (Array.isArray(obj.content)) {
			const textItem = (
				obj.content as Array<{ type?: string; text?: string }>
			).find((c) => c.type === "text");
			if (textItem?.text) {
				try {
					data = JSON.parse(textItem.text);
				} catch {
					if (strict) {
						throw new Error("Unreadable PM listing response.");
					}
					return {
						items,
						rawCount: 0,
						hasNextPage: false,
						recognized: false,
					};
				}
			}
		}
	}

	const extracted = extractPMListArray(data);
	const arr = extracted?.items;

	if (!arr && strict) {
		logger.warn("[Fetch PM Hierarchy] Unrecognized PM listing response", {
			keys: data && typeof data === "object" ? Object.keys(data) : [],
		});
	}
	for (const item of arr ?? []) {
		if (!item || typeof item !== "object") {
			continue;
		}
		let rec = item as Record<string, unknown>;

		// ADO wit_list_backlog_work_items wraps items under "target"
		if (rec.target && typeof rec.target === "object") {
			rec = rec.target as Record<string, unknown>;
		}

		const fields = rec.fields as Record<string, unknown> | undefined;

		// Prefer the human-facing item *number* over an internal `id`. Some PM
		// tools (notably Fizzy) return BOTH a base36 internal `id`
		// (e.g. "03g8xd7wkev0wsbo39oa0om88") and the addressable card `number`
		// (e.g. 1101) — and the update/get tools resolve by number, not by the
		// internal id. Capturing the internal id here poisons `externalId`, so
		// every later push 404s ("Resource not found"). This follows the same
		// number-first principle as `COMMON_ID_FIELDS` (used by the push path).
		// ADO has no `number`, so it still falls through to `id` (e.g. 156).
		const id = String(
			rec.number ??
				rec.card_number ??
				rec.issue_number ??
				rec.id ??
				rec.card_id ??
				rec.issue_id ??
				"",
		);
		const title = (fields?.["System.Title"] ??
			fields?.["System.Name"] ??
			fields?.summary ??
			rec.title ??
			rec.name ??
			rec.summary ??
			rec.subject) as string | undefined;
		const description = (fields?.["System.Description"] ??
			descriptionToText(fields?.description) ??
			rec.description ??
			rec.body ??
			rec.content) as string | null | undefined;
		const links = rec._links as { web?: { href?: string } } | undefined;
		const url = (links?.web?.href ??
			rec.url ??
			rec.webUrl ??
			rec.link ??
			rec.html_url) as string | null | undefined;

		if (id) {
			items.push({
				id,
				title: title ?? `Work Item ${id}`,
				description: description ?? null,
				url: url ?? null,
				raw: rec,
			});
		}
	}

	const envelope =
		extracted?.envelope ??
		(data && typeof data === "object" && !Array.isArray(data)
			? (data as Record<string, unknown>)
			: undefined);
	const rawTotal = envelope
		? (envelope.total ??
			envelope.totalCount ??
			envelope.total_count ??
			(envelope.meta && typeof envelope.meta === "object"
				? (envelope.meta as Record<string, unknown>).total
				: undefined) ??
			(envelope.pagination && typeof envelope.pagination === "object"
				? (envelope.pagination as Record<string, unknown>).total
				: undefined))
		: undefined;
	// `count` often describes only this page, so it cannot establish completeness.
	const total =
		typeof rawTotal === "number" && rawTotal >= 0 ? rawTotal : undefined;

	return {
		items,
		total,
		rawCount: arr?.length ?? 0,
		hasNextPage: readPMListPagingEvidence(envelope).hasMore,
		recognized: !!extracted,
	};
}

/**
 * Enrich sparse work items (ID-only refs from ADO backlog list) with full details.
 * Calls wit_get_work_item for each item to fetch title, description, and URL.
 */
async function enrichAdoWorkItems(
	items: PMWorkItemSummary[],
	params: {
		mcpConfigId: string;
		userId: string;
		organizationId?: string;
		getToolName: string;
		idParam: string;
		/** Additional required args beyond the ID (e.g. { project: "MyProject" }) */
		additionalArgs?: Record<string, unknown>;
	},
): Promise<PMWorkItemSummary[]> {
	if (items.length === 0) {
		return items;
	}

	// Check if items already have titles (not just "Work Item {id}" fallback)
	const needsEnrichment = items.some(
		(item) => !item.title || item.title.startsWith("Work Item "),
	);
	if (!needsEnrichment) {
		return items;
	}

	logger.info("[Fetch PM Hierarchy] Enriching work items with full details", {
		count: items.length,
		tool: params.getToolName,
		additionalArgs: params.additionalArgs
			? Object.keys(params.additionalArgs)
			: [],
	});

	const enriched: PMWorkItemSummary[] = [];

	for (const item of items) {
		try {
			const result = await executeMcpTool({
				toolName: params.getToolName,
				args: {
					[params.idParam]: Number(item.id),
					...(params.additionalArgs ?? {}),
				},
				userId: params.userId,
				organizationId: params.organizationId,
				mcpConfigId: params.mcpConfigId,
			});

			if (result.success) {
				let data: Record<string, unknown> = result.output as Record<
					string,
					unknown
				>;

				// Unwrap MCP content format: { content: [{ type: "text", text: "<json>" }] }
				if (Array.isArray(data.content)) {
					const textItem = (
						data.content as Array<{ type?: string; text?: string }>
					).find((c) => c.type === "text");
					if (textItem?.text) {
						try {
							data = JSON.parse(textItem.text);
						} catch {
							// Text content is not JSON — log for debugging
							logger.warn(
								"[Fetch PM Hierarchy] Enrichment text is not JSON",
								{
									itemId: item.id,
									textPreview: textItem.text.slice(0, 200),
								},
							);
						}
					}
				}

				const fields = data.fields as
					| Record<string, unknown>
					| undefined;
				const links = data._links as
					| { html?: { href?: string }; web?: { href?: string } }
					| undefined;

				const title =
					(fields?.["System.Title"] as string) ??
					(data.title as string) ??
					item.title;
				const description =
					(fields?.["System.Description"] as string) ?? null;
				const url =
					links?.html?.href ??
					links?.web?.href ??
					(data.url as string) ??
					null;

				// Log first item for debugging
				if (enriched.length === 0) {
					logger.info(
						"[Fetch PM Hierarchy] Enrichment sample result",
						{
							itemId: item.id,
							hasFields: !!fields,
							hasLinks: !!links,
							hasTitle: !!title,
							hasDescription: !!description,
							dataKeys: Object.keys(data).slice(0, 15),
						},
					);
				}

				enriched.push({
					id: item.id,
					title,
					description,
					url,
					raw: data,
				});
			} else {
				logger.warn("[Fetch PM Hierarchy] Enrichment call failed", {
					itemId: item.id,
					hasOutput: !!result.output,
				});
				enriched.push(item);
			}
		} catch (error) {
			logger.warn("[Fetch PM Hierarchy] Enrichment exception", {
				itemId: item.id,
				error: error instanceof Error ? error.message : String(error),
			});
			enriched.push(item);
		}
	}

	logger.info("[Fetch PM Hierarchy] Enrichment complete", {
		totalItems: items.length,
		enrichedCount: enriched.filter(
			(e) => e.title && !e.title.startsWith("Work Item "),
		).length,
	});

	return enriched;
}

// ============================================================================
// Fizzy Per-Column Card Fetching
// ============================================================================

/**
 * Fetch workflow-column cards from a Fizzy board using the per-column strategy.
 *
 * Delegates to the shared `readFizzyBoardCards` function and maps the result
 * to the `PMHierarchyResult` format expected by the hierarchy fetcher.
 *
 * Keeps unavailable boards distinct from boards with no workflow columns.
 */
async function fetchFizzyBoardCards(params: {
	containerId: string;
	additionalContext?: Record<string, string>;
	mcpConfigId: string;
	userId: string;
	organizationId?: string;
	capabilities: PMToolCapabilities;
	forPrompt?: boolean;
}): Promise<PMHierarchyResult> {
	const read = await readFizzyBoardCards({
		mcpConfigId: params.mcpConfigId,
		containerId: params.containerId,
		additionalContext: params.additionalContext,
		userId: params.userId,
		organizationId: params.organizationId,
		capabilities: params.capabilities,
		...(params.forPrompt
			? { fields: "summary" as const, descriptionFromPreview: true }
			: {}),
	});

	return {
		readStatus:
			read.kind === "ok"
				? "ok"
				: read.kind === "no-columns"
					? "no-columns"
					: "failed",
		...(read.kind === "failed"
			? { readErrorKind: read.errorKind }
			: read.kind === "unavailable"
				? { readErrorKind: "other" as const }
				: {}),
		epics: [],
		features: [],
		stories: read.kind === "ok" ? read.result.items : [],
		detectedType: "fizzy",
	};
}

/**
 * Fetch work items from a PM tool organized by type.
 * For Azure DevOps, fetches from different backlog categories.
 * For other tools, fetches all items (no type filtering available).
 */
export async function fetchPMWorkItemsByType(
	input: FetchPMHierarchyInput,
): Promise<PMHierarchyResult> {
	const finalize = (result: PMHierarchyResult) =>
		truncatePmHierarchyDescriptions(result, input.forPrompt);
	const {
		mcpConfigId,
		containerId,
		additionalContext,
		userId,
		organizationId,
		capabilities: preCapabilities,
	} = input;

	// The container id names a project on one GitLab instance; a personal
	// GitLab config on another is refused before anything is read.
	await assertPmMcpTargetOrigin({
		mcpConfigId,
		userId,
		organizationId,
		additionalContext,
	});

	const capabilities =
		preCapabilities ??
		(await discoverPMToolCapabilities({
			mcpConfigId,
			userId,
			organizationId,
		}));

	if (!capabilities?.taskList) {
		logger.warn(
			"[Fetch PM Hierarchy] PM tool does not support listing work items",
		);
		return finalize({
			epics: [],
			features: [],
			stories: [],
			detectedType: capabilities?.detectedType,
			readStatus: "failed",
			readErrorKind: "other",
		});
	}

	const listTool = capabilities.taskList;
	const isAdo = /wit_list/i.test(listTool.toolName);

	if (isAdo) {
		// Azure DevOps: fetch by backlog category
		let team = additionalContext?.team;
		if (!team) {
			// Auto-resolve: the wizard hierarchy doesn't capture the team
			// because extractContainerType can't parse "project_teams".
			// Resolve it now by calling core_list_project_teams.
			logger.info(
				"[Fetch PM Hierarchy] ADO team missing from additionalContext, auto-resolving",
				{ containerId },
			);
			team = await resolveAdoDefaultTeam({
				project: containerId,
				mcpConfigId,
				userId,
				organizationId,
				availableTools: capabilities.availableTools,
			});
			if (!team) {
				throw new Error(
					"Azure DevOps requires a team but none could be resolved. " +
						"Ensure the project has at least one team configured in Azure DevOps.",
				);
			}
		}

		const backlogsListToolName =
			findBacklogsListTool(capabilities.availableTools) ??
			"wit_list_backlogs";
		const result: PMHierarchyResult = {
			readStatus: "ok",
			epics: [],
			features: [],
			stories: [],
		};

		// Fetch backlogs list once, reuse for all type lookups.
		let backlogs: AdoBacklogEntry[] = [];
		try {
			backlogs = await fetchAdoBacklogs({
				project: containerId,
				team,
				mcpConfigId,
				userId,
				organizationId,
				backlogsListToolName,
				strict: true,
			});
		} catch (error) {
			result.readStatus = "failed";
			result.readErrorKind = pmBoardReadError(error);
		}

		logger.info("[Fetch PM Hierarchy] ADO backlogs", {
			count: backlogs.length,
			categories: backlogs.map((b) => getBacklogCategory(b)),
			names: backlogs.map((b) => b.name),
		});

		// Track which category refs we've already fetched to avoid duplicates
		// (e.g. "Issue" and "User Story" both map to RequirementCategory)
		const fetchedCategories = new Set<string>();

		for (const [workItemType, key] of [
			["Epic", "epics"],
			["Feature", "features"],
			["User Story", "stories"],
			// Basic process template uses Issue instead of User Story
			["Issue", "stories"],
		] as const) {
			try {
				// Skip if we already have items for this slot (e.g. "User Story" already filled "stories")
				if (result[key].length > 0) {
					continue;
				}

				const backlogId = resolveAdoBacklogId(workItemType, backlogs);

				if (!backlogId || fetchedCategories.has(backlogId)) {
					continue;
				}
				fetchedCategories.add(backlogId);

				const listArgs: Record<string, unknown> = {
					[listTool.containerParam]: containerId,
					team,
					backlogId,
				};

				const listResult = await executeMcpTool({
					pmTarget: { additionalContext },
					toolName: listTool.toolName,
					args: listArgs,
					userId,
					organizationId,
					mcpConfigId,
				});

				if (listResult.success) {
					result[key] = parseListResponse(listResult.output, true);
					logger.info("[Fetch PM Hierarchy] Fetched items", {
						workItemType,
						count: result[key].length,
					});
				} else {
					result.readStatus = "failed";
					result.readErrorKind = pmBoardReadError(listResult);
				}
			} catch (error) {
				result.readStatus = "failed";
				result.readErrorKind = pmBoardReadError(error);
				logger.warn("[Fetch PM Hierarchy] Failed to fetch items", {
					workItemType,
					error:
						error instanceof Error ? error.message : String(error),
				});
			}
		}

		// Enrich sparse items (ID-only refs) with full details from ADO
		if (capabilities.taskGet) {
			const projectParamNames = new Set([
				"project",
				"projectId",
				"project_id",
			]);
			const additionalArgs: Record<string, unknown> = {};
			for (const param of capabilities.taskGet.additionalRequiredParams) {
				if (projectParamNames.has(param)) {
					additionalArgs[param] = containerId;
				} else if (param === "team") {
					additionalArgs[param] = additionalContext?.team;
				} else if (additionalContext?.[param]) {
					additionalArgs[param] = additionalContext[param];
				}
			}

			for (const p of capabilities.taskGet.allParams) {
				if (
					!p.required &&
					projectParamNames.has(p.name) &&
					!(p.name in additionalArgs)
				) {
					additionalArgs[p.name] = containerId;
				}
			}

			const enrichParams = {
				mcpConfigId,
				userId,
				organizationId,
				getToolName: capabilities.taskGet.toolName,
				idParam: capabilities.taskGet.idParam,
				additionalArgs:
					Object.keys(additionalArgs).length > 0
						? additionalArgs
						: undefined,
			};

			result.epics = await enrichAdoWorkItems(result.epics, enrichParams);
			result.features = await enrichAdoWorkItems(
				result.features,
				enrichParams,
			);
			result.stories = await enrichAdoWorkItems(
				result.stories,
				enrichParams,
			);
		}

		return finalize({
			...result,
			detectedType: capabilities.detectedType,
		});
	}

	// Fizzy: fetch cards per column for complete board coverage.
	// `fizzy_get_cards` answers with one page per call, so a single call —
	// board-wide or column-scoped — only ever returns part of the board.
	// Fetch columns first, then walk their pages (see `readFizzyBoardCards`).
	// Cards in triage are not included.
	if (capabilities.detectedType === "fizzy") {
		const fizzyResult = await fetchFizzyBoardCards({
			containerId,
			additionalContext,
			mcpConfigId,
			userId,
			organizationId,
			capabilities,
			forPrompt: input.forPrompt,
		});
		return finalize(fizzyResult);
	}

	// Non-ADO: page items without type filtering.
	let readErrorKind: PMBoardReadErrorKind | undefined;
	try {
		const baseArgs: Record<string, unknown> = {
			[listTool.containerParam]: containerId,
		};
		for (const param of listTool.filterParams) {
			if (additionalContext?.[param]) {
				baseArgs[param] = additionalContext[param];
			}
		}

		const { paginationInfo } = listTool;
		const canPage =
			paginationInfo.style === "offset-page" ||
			paginationInfo.style === "offset-skip";
		const allItems: PMWorkItemSummary[] = [];
		const seen = new Set<string>();
		let effectivePageSize: number | undefined;
		let listingTruncated = false;
		let offset = 0;
		let knownTotal: number | undefined;
		let previousPageFull = false;
		let previousHasMore = false;
		let isProbe = false;
		for (let page = 1; page <= PM_LIST_MAX_PAGES; page++) {
			const listArgs = { ...baseArgs };
			if (paginationInfo.style === "offset-page") {
				if (paginationInfo.pageParam) {
					listArgs[paginationInfo.pageParam] = page;
				}
				if (paginationInfo.pageSizeParam) {
					listArgs[paginationInfo.pageSizeParam] = PM_LIST_PAGE_SIZE;
				}
			} else if (paginationInfo.style === "offset-skip") {
				if (paginationInfo.skipParam) {
					listArgs[paginationInfo.skipParam] = offset;
				}
				if (paginationInfo.pageSizeParam) {
					listArgs[paginationInfo.pageSizeParam] = PM_LIST_PAGE_SIZE;
				}
			}
			let result: ReturnType<typeof parseListPage>;
			try {
				const listResult = await executeMcpTool({
					pmTarget: { additionalContext },
					toolName: listTool.toolName,
					args: listArgs,
					userId,
					organizationId,
					mcpConfigId,
				});
				if (!listResult.success) {
					if (isProbe) {
						listingTruncated = true;
					} else {
						readErrorKind = pmBoardReadError(listResult);
					}
					break;
				}
				result = parseListPage(listResult.output, true);
				if (page > 1 && !result.recognized) {
					throw new Error("Unreadable PM listing page.");
				}
			} catch (error) {
				if (!isProbe) {
					throw error;
				}
				// A speculative short-page probe must not invalidate items already read.
				listingTruncated = true;
				break;
			}
			offset += result.rawCount;
			knownTotal = result.total ?? knownTotal;
			const newItems = result.items.filter((item) => {
				if (seen.has(item.id)) {
					return false;
				}
				seen.add(item.id);
				return true;
			});
			allItems.push(
				...newItems.slice(0, PM_LIST_MAX_ITEMS - allItems.length),
			);
			if (!canPage) {
				listingTruncated =
					newItems.length > allItems.length ||
					(knownTotal != null && knownTotal > allItems.length) ||
					result.hasNextPage;
				break;
			}
			// Stop tools that repeat or empty a page, retaining evidence of unread items.
			if (newItems.length === 0) {
				listingTruncated =
					(knownTotal != null && knownTotal > seen.size) ||
					result.hasNextPage ||
					previousHasMore ||
					// An empty page ends a list; only a repeated full page suggests more.
					(knownTotal == null &&
						previousPageFull &&
						result.rawCount > 0);
				break;
			}
			// Only the page after the first short page is a speculative probe.
			const capDetectedNow =
				effectivePageSize == null &&
				result.rawCount < PM_LIST_PAGE_SIZE;
			if (capDetectedNow) {
				effectivePageSize = result.rawCount;
			}
			const hasMore =
				result.hasNextPage ||
				(knownTotal != null
					? seen.size < knownTotal
					: result.rawCount >=
						(effectivePageSize ?? PM_LIST_PAGE_SIZE));
			if (
				seen.size > allItems.length ||
				((allItems.length >= PM_LIST_MAX_ITEMS ||
					page === PM_LIST_MAX_PAGES) &&
					hasMore)
			) {
				listingTruncated = true;
				break;
			}
			if (!hasMore) {
				break;
			}
			previousPageFull = result.rawCount >= PM_LIST_PAGE_SIZE;
			previousHasMore = result.hasNextPage;
			isProbe =
				knownTotal == null && !result.hasNextPage && capDetectedNow;
		}
		if (!readErrorKind) {
			// Can't differentiate types for non-ADO, put all in stories.
			return finalize({
				epics: [],
				features: [],
				stories: allItems,
				readStatus: "ok",
				...(listingTruncated ? { listingTruncated: true } : {}),
				detectedType: capabilities.detectedType,
			});
		}
	} catch (error) {
		readErrorKind = pmBoardReadError(error);
		logger.warn("[Fetch PM Hierarchy] Failed to fetch items", {
			error: error instanceof Error ? error.message : String(error),
		});
	}

	return finalize({
		epics: [],
		features: [],
		stories: [],
		readStatus: "failed",
		readErrorKind,
		detectedType: capabilities.detectedType,
	});
}

/**
 * Detect available ADO work item types from backlogs.
 * Returns type overrides that should be merged into additionalContext
 * to ensure hierarchy-sync creates the correct work item types.
 *
 * For Agile template: Feature exists, Story = "User Story"
 * For Basic template: Feature doesn't exist, Story = "Issue"
 * For Scrum template: Feature exists, Story = "Product Backlog Item"
 */
export async function detectAdoWorkItemTypes(input: {
	mcpConfigId: string;
	containerId: string;
	team: string;
	userId: string;
	organizationId?: string;
	availableTools?: string[];
}): Promise<{
	featureWorkItemType?: string;
	workItemType?: string;
	hasFeatureCategory: boolean;
}> {
	const backlogsListToolName =
		findBacklogsListTool(input.availableTools ?? []) ?? "wit_list_backlogs";

	const backlogs = await fetchAdoBacklogs({
		project: input.containerId,
		team: input.team,
		mcpConfigId: input.mcpConfigId,
		userId: input.userId,
		organizationId: input.organizationId,
		backlogsListToolName,
	});

	const mapping = buildAdoTypeMapping(backlogs);

	logger.info("[Detect ADO Types] Resolved type mapping", {
		epicType: mapping.epicType,
		featureType: mapping.featureType,
		storyType: mapping.storyType,
		hasFeatureCategory: mapping.hasFeatureCategory,
	});

	return {
		featureWorkItemType: mapping.featureType,
		workItemType: mapping.storyType,
		hasFeatureCategory: mapping.hasFeatureCategory,
	};
}
