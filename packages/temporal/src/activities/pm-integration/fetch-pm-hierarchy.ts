/**
 * Fetch PM Hierarchy Activities
 *
 * Fetches work items from a PM tool organized by type (epics, features, stories).
 * Used by the backlog updater to compare existing PM items against Fabric's backlog.
 */
import { logger } from "@repo/logs";
import { findBacklogsListTool } from "@repo/utils";
import { executeMcpTool } from "../orchestrator/execution/execute-mcp-tool";
import {
	discoverPMToolCapabilities,
	listAllFizzyCards,
	type PMWorkItemSummary,
} from "./story-sync";
import type { PMToolCapabilities } from "./tool-analyzer";

/**
 * Per-item description cap applied at the source.
 *
 * The downstream backlog-context LLM prompt inlines at most 150 characters
 * of PM-item description. Capping here keeps the activity result well under
 * Temporal's 2 MiB input limit when PM tools return many items with long
 * descriptions. 500 chars leaves a ~3.3x buffer over current prompt usage.
 *
 * Note: the `raw` field on PMWorkItemSummary is intentionally NOT truncated
 * here — downstream consumers may rely on its structure. Only `description`,
 * which is the dominant size contributor, is capped.
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
): PMHierarchyResult {
	return {
		...result,
		epics: result.epics.map(truncatePmItemDescription),
		features: result.features.map(truncatePmItemDescription),
		stories: result.stories.map(truncatePmItemDescription),
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
		const parsed = parseMcpJsonFromOutput(result.output);
		const first = (Array.isArray(parsed) ? parsed[0] : undefined) as
			| Record<string, unknown>
			| undefined;
		const cloudId = first?.id ?? first?.cloudId;
		return typeof cloudId === "string" && cloudId.length > 0
			? cloudId
			: undefined;
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
		/getJiraProjectIssueTypesMetadata$/i.test(t),
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
		const parsed = parseMcpJsonFromOutput(result.output) as
			| Record<string, unknown>
			| undefined;
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

// ============================================================================
// Types
// ============================================================================

export interface FetchPMHierarchyInput {
	projectId: string;
	mcpConfigId: string;
	containerId: string;
	additionalContext?: Record<string, string>;
	userId: string;
	organizationId?: string;
	capabilities?: PMToolCapabilities;
}

export interface PMHierarchyResult {
	epics: PMWorkItemSummary[];
	features: PMWorkItemSummary[];
	stories: PMWorkItemSummary[];
	/** Detected PM tool type (e.g. "fizzy", "azure-devops", "linear") */
	detectedType?: string;
}

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
}): Promise<AdoBacklogEntry[]> {
	const result = await executeMcpTool({
		toolName: params.backlogsListToolName,
		args: { project: params.project, team: params.team },
		userId: params.userId,
		organizationId: params.organizationId,
		mcpConfigId: params.mcpConfigId,
	});

	if (!result.success) {
		return [];
	}

	try {
		const output = result.output as Record<string, unknown>;
		const content = output?.content as
			| Array<{ type?: string; text?: string }>
			| undefined;
		const textItem = content?.find((c) => c.type === "text");
		if (textItem?.text) {
			const parsed = JSON.parse(textItem.text);
			return Array.isArray(parsed) ? parsed : [];
		}
	} catch {
		/* ignore parse errors */
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
export function parseListResponse(output: unknown): PMWorkItemSummary[] {
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
					return items;
				}
			}
		}
	}

	let arr: unknown[] = [];
	if (Array.isArray(data)) {
		arr = data;
	} else if (data && typeof data === "object") {
		const d = data as Record<string, unknown>;
		// `cards` is the fizzy-mcp 1.1.0 page-envelope key ({cards, page, ...}).
		arr =
			(Array.isArray(d.workItems) ? d.workItems : null) ??
			(Array.isArray(d.value) ? d.value : null) ??
			(Array.isArray(d.workItemRefs) ? d.workItemRefs : null) ??
			(Array.isArray(d.items) ? d.items : null) ??
			(Array.isArray(d.cards) ? d.cards : null) ??
			(Array.isArray(d.data) ? d.data : null) ??
			(Array.isArray(d.results) ? d.results : null) ??
			[];
	}

	for (const item of arr) {
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
			rec.title ??
			rec.name ??
			rec.summary ??
			rec.subject) as string | undefined;
		const description = (fields?.["System.Description"] ??
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

	return items;
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
 * Fetch all cards from a Fizzy board using the per-column strategy.
 *
 * Delegates to the shared `listAllFizzyCards` function and maps the result
 * to the `PMHierarchyResult` format expected by the hierarchy fetcher.
 *
 * Returns null if required tools aren't available (caller falls through to generic path).
 */
async function fetchFizzyBoardCards(params: {
	containerId: string;
	additionalContext?: Record<string, string>;
	mcpConfigId: string;
	userId: string;
	organizationId?: string;
	capabilities: PMToolCapabilities;
}): Promise<PMHierarchyResult | null> {
	const result = await listAllFizzyCards({
		mcpConfigId: params.mcpConfigId,
		containerId: params.containerId,
		additionalContext: params.additionalContext,
		userId: params.userId,
		organizationId: params.organizationId,
		capabilities: params.capabilities,
	});

	if (!result) {
		return null;
	}

	return {
		epics: [],
		features: [],
		stories: result.items,
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
	const {
		mcpConfigId,
		containerId,
		additionalContext,
		userId,
		organizationId,
		capabilities: preCapabilities,
	} = input;

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
		return truncatePmHierarchyDescriptions({
			epics: [],
			features: [],
			stories: [],
			detectedType: capabilities?.detectedType,
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
			epics: [],
			features: [],
			stories: [],
		};

		// Fetch backlogs list once, reuse for all type lookups
		const backlogs = await fetchAdoBacklogs({
			project: containerId,
			team,
			mcpConfigId,
			userId,
			organizationId,
			backlogsListToolName,
		});

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
					toolName: listTool.toolName,
					args: listArgs,
					userId,
					organizationId,
					mcpConfigId,
				});

				if (listResult.success) {
					result[key] = parseListResponse(listResult.output);
					logger.info("[Fetch PM Hierarchy] Fetched items", {
						workItemType,
						count: result[key].length,
					});
				}
			} catch (error) {
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

		return truncatePmHierarchyDescriptions({
			...result,
			detectedType: capabilities.detectedType,
		});
	}

	// Fizzy: fetch cards per column for complete board coverage.
	// `fizzy_get_cards` answers with one page per call, so a single call —
	// board-wide or column-scoped — only ever returns part of the board.
	// Fetching columns first, then walking every page of each column, gets ALL
	// cards on the board (see `listAllFizzyCards`).
	if (capabilities.detectedType === "fizzy") {
		const fizzyResult = await fetchFizzyBoardCards({
			containerId,
			additionalContext,
			mcpConfigId,
			userId,
			organizationId,
			capabilities,
		});
		if (fizzyResult) {
			return truncatePmHierarchyDescriptions(fizzyResult);
		}
		// Fall through to generic non-ADO path if Fizzy-specific fetch failed
	}

	// Non-ADO: fetch all items (can't filter by type)
	try {
		const listArgs: Record<string, unknown> = {
			[listTool.containerParam]: containerId,
		};

		for (const param of listTool.filterParams) {
			if (additionalContext?.[param]) {
				listArgs[param] = additionalContext[param];
			}
		}

		const listResult = await executeMcpTool({
			toolName: listTool.toolName,
			args: listArgs,
			userId,
			organizationId,
			mcpConfigId,
		});

		if (listResult.success) {
			const allItems = parseListResponse(listResult.output);
			// Can't differentiate types for non-ADO, put all in stories
			return truncatePmHierarchyDescriptions({
				epics: [],
				features: [],
				stories: allItems,
				detectedType: capabilities.detectedType,
			});
		}
	} catch (error) {
		logger.warn("[Fetch PM Hierarchy] Failed to fetch items", {
			error: error instanceof Error ? error.message : String(error),
		});
	}

	return truncatePmHierarchyDescriptions({
		epics: [],
		features: [],
		stories: [],
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
