/**
 * PM Tool Capability Analyzer
 *
 * Analyzes MCP tool schemas to dynamically detect project management capabilities.
 * Uses heuristics on tool names and inputSchema to understand:
 * - Container hierarchy (e.g., accounts → boards, teams → projects)
 * - Task creation tools and their required parameters
 *
 * This enables the PM integration to work with any MCP server without hardcoding
 * provider-specific logic.
 *
 * @see packages/temporal/src/activities/orchestrator/routing/capability-registry.ts
 */

import { logger } from "@repo/logs";
import { hasNativeTestCaseSupport } from "@repo/utils";

/**
 * JSON Schema type for tool input schemas
 * Using Record<string, unknown> for properties to accept any schema format
 */
export interface ToolInputSchema {
	type?: string;
	properties?: Record<string, unknown>;
	required?: string[];
}

/**
 * MCP Tool definition with schema
 */
export interface McpToolDefinition {
	name: string;
	description?: string;
	inputSchema?: ToolInputSchema;
}

/**
 * Container level in the hierarchy
 * e.g., Fizzy: accounts (level 0) → boards (level 1)
 * e.g., Linear: teams (level 0) → issues (tasks)
 */
export interface ContainerLevel {
	/** Level in hierarchy (0 = root, 1 = child, etc.) */
	level: number;
	/** Tool name for listing containers at this level */
	listToolName: string;
	/** Type of container (account, board, project, team, workspace) */
	containerType: string;
	/** Parameter name for the container ID in child operations */
	idParam: string;
	/** Parameter name from parent level needed to list this level */
	parentParam?: string;
	/** Field name in result that contains the ID */
	resultIdField: string;
	/** Field name in result that contains the display name */
	resultNameField: string;
}

/**
 * Task creation capability
 */
export interface TaskCreationCapability {
	/** Tool name for creating tasks */
	toolName: string;
	/** Parameter name for the container (board_id, project_key, etc.) */
	containerParam: string;
	/** Parameter name for task title */
	titleParam: string;
	/** Parameter name for task description (optional) */
	descriptionParam?: string;
	/**
	 * Azure DevOps style: fields object with System.Title, System.Description.
	 * When set, use fields-based args instead of titleParam/descriptionParam.
	 */
	fieldsBased?: {
		titleKey: string;
		descriptionKey: string;
		workItemTypeParam: string;
		fieldsParam: string;
	};
	/** Additional required parameters (excluding container, title, description) */
	additionalRequiredParams: string[];
	/** All parameters with their types */
	allParams: Array<{
		name: string;
		type: string;
		required: boolean;
		description?: string;
	}>;
}

/**
 * Task update capability (for syncing existing tasks)
 */
export interface TaskUpdateCapability {
	/** Tool name for updating tasks */
	toolName: string;
	/** Parameter name for the task/card/issue ID */
	idParam: string;
	/** Parameter name for task title (optional - may not be updatable) */
	titleParam?: string;
	/** Parameter name for task description (optional) */
	descriptionParam?: string;
	/** Parameter name for status/state (optional) */
	statusParam?: string;
	/**
	 * Azure DevOps style: updates array with JSON Patch ops.
	 * When set, build updates: [{ op: "add", path: "/fields/System.Title", value }].
	 */
	updatesBased?: { updatesParam: string };
	/**
	 * Atlassian Rovo Jira style: title/description live inside a `fields`
	 * object param rather than being top-level. When set, build:
	 * `{ [idParam]: id, [fieldsParam]: { [titleField]: title, [descriptionField]: desc } }`.
	 */
	fieldsObjectBased?: {
		fieldsParam: string;
		titleField: string;
		descriptionField: string;
	};
	/** All parameters with their types */
	allParams: Array<{
		name: string;
		type: string;
		required: boolean;
		description?: string;
	}>;
}

/**
 * Task get/read capability (for pulling data from PM tool)
 */
export interface TaskGetCapability {
	/** Tool name for getting a single task */
	toolName: string;
	/** Parameter name for the task/card/issue ID */
	idParam: string;
	/** Additional required parameters (e.g., board_id for some tools) */
	additionalRequiredParams: string[];
	/** All parameters with their types */
	allParams: Array<{
		name: string;
		type: string;
		required: boolean;
	}>;
}

/**
 * Task comments read capability (for pulling a ticket's comment thread).
 */
export interface TaskCommentsCapability {
	/** Tool name for fetching comments on a task. */
	toolName: string;
	/** Parameter name for the task/card/issue ID. */
	idParam: string;
	/** Additional required params (e.g. project, account_slug). */
	additionalRequiredParams: string[];
	/** All params with their types. */
	allParams: Array<{ name: string; type: string; required: boolean }>;
}

/**
 * Pagination style and param names detected from the list tool's input schema.
 * Used to map our internal page/pageSize to the PM tool's actual parameters.
 */
export interface PaginationInfo {
	/**
	 * - offset-page: tool accepts a 1-based page number (e.g. Fizzy, GitHub)
	 * - offset-skip: tool accepts skip/offset + limit (e.g. Jira startAt/maxResults, ADO $skip/$top)
	 * - cursor: tool uses a cursor / after token (e.g. Linear) — numbered pages not feasible
	 * - none: no pagination params detected; in-memory pagination used as fallback
	 */
	style: "offset-page" | "offset-skip" | "cursor" | "none";
	/** 1-based page number param (offset-page style) */
	pageParam?: string;
	/** Page size / limit param (offset-page and offset-skip styles) */
	pageSizeParam?: string;
	/** Skip / offset param (offset-skip style) */
	skipParam?: string;
	/** Cursor / after param (cursor style) */
	cursorParam?: string;
}

/**
 * Task list capability (for fetching multiple tasks)
 */
export interface TaskListCapability {
	/** Tool name for listing tasks */
	toolName: string;
	/** Parameter name for the container (board_id, project_key, etc.) */
	containerParam: string;
	/** Additional filter parameters (status, assignee, etc.) */
	filterParams: string[];
	/** Pagination style and param names for this list tool */
	paginationInfo: PaginationInfo;
	/** All parameters accepted by this list tool */
	allParams: Array<{
		name: string;
		type: string;
		required: boolean;
		description?: string;
	}>;
}

/**
 * Complete PM tool capabilities for an MCP server
 */
export interface PMToolCapabilities {
	/** Whether this MCP server has PM capabilities */
	hasPMCapabilities: boolean;
	/** Container hierarchy (ordered by level) */
	containerHierarchy: ContainerLevel[];
	/** Task creation capability */
	taskCreation?: TaskCreationCapability;
	/** Task update capability */
	taskUpdate?: TaskUpdateCapability;
	/** Task get/read capability */
	taskGet?: TaskGetCapability;
	/** Task list capability */
	taskList?: TaskListCapability;
	/** Task comments read capability */
	taskComments?: TaskCommentsCapability;
	/** Detected PM tool type (fizzy, linear, jira, github, asana, etc.) */
	detectedType?: string;
	/** Raw tool names available */
	availableTools: string[];
	/**
	 * True when the connection holds a native test-case entity (Azure DevOps) or
	 * a recognized analogue (Jira Xray/Zephyr, GitLab test cases) — the gate for
	 * test-case push/pull, distinct from generic work-item CRUD. Optional so
	 * partial mocks/fallbacks need not set it; absent is read as `false` (the safe
	 * "no test-case sync" default). `analyzePMToolCapabilities` always sets it.
	 */
	supportsTestCases?: boolean;
}

// =============================================================================
// Tool Name Pattern Matching (following orchestrator patterns)
// =============================================================================

/**
 * Patterns for detecting container listing tools
 */
const CONTAINER_LIST_PATTERNS: Array<{
	pattern: RegExp;
	containerType: string;
	idField: string;
	nameField: string;
	level: number;
}> = [
	// Root-level containers (level 0)
	{
		pattern: /get_accounts?$/i,
		containerType: "account",
		idField: "slug",
		nameField: "name",
		level: 0,
	},
	{
		pattern: /list_accounts?$/i,
		containerType: "account",
		idField: "slug",
		nameField: "name",
		level: 0,
	},
	{
		pattern: /get_workspaces?$/i,
		containerType: "workspace",
		idField: "id",
		nameField: "name",
		level: 0,
	},
	{
		pattern: /list_workspaces?$/i,
		containerType: "workspace",
		idField: "id",
		nameField: "name",
		level: 0,
	},
	{
		pattern: /get_organizations?$/i,
		containerType: "organization",
		idField: "id",
		nameField: "name",
		level: 0,
	},
	{
		pattern: /list_organizations?$/i,
		containerType: "organization",
		idField: "id",
		nameField: "name",
		level: 0,
	},

	// Child containers (level 1)
	{
		pattern: /get_boards?$/i,
		containerType: "board",
		idField: "id",
		nameField: "name",
		level: 1,
	},
	{
		pattern: /list_boards?$/i,
		containerType: "board",
		idField: "id",
		nameField: "name",
		level: 1,
	},
	{
		pattern: /get_projects?$/i,
		containerType: "project",
		idField: "id",
		nameField: "name",
		level: 1,
	},
	{
		pattern: /list_projects?$/i,
		containerType: "project",
		idField: "id",
		nameField: "name",
		level: 1,
	},
	{
		pattern: /get_teams?$/i,
		containerType: "team",
		idField: "id",
		nameField: "name",
		level: 1,
	},
	{
		pattern: /list_teams?$/i,
		containerType: "team",
		idField: "id",
		nameField: "name",
		level: 1,
	},
	{
		pattern: /get_repos?$/i,
		containerType: "repo",
		idField: "full_name",
		nameField: "name",
		level: 1,
	},
	{
		pattern: /list_repos?$/i,
		containerType: "repo",
		idField: "full_name",
		nameField: "name",
		level: 1,
	},
	{
		pattern: /list_repositories$/i,
		containerType: "repo",
		idField: "full_name",
		nameField: "name",
		level: 1,
	},
];

/**
 * Patterns for detecting task creation tools
 *
 * Atlassian's Rovo MCP server uses camelCase names (`createJiraIssue`,
 * `editJiraIssue`, `getJiraIssue`, …) that do not match the snake_case
 * patterns. We include the canonical camelCase Rovo names alongside the
 * snake_case ones so capability detection picks them up.
 */
const TASK_CREATE_PATTERNS: RegExp[] = [
	/create_card$/i,
	/create_issue$/i,
	/create_task$/i,
	/create_item$/i,
	/create_ticket$/i,
	/create_story$/i,
	/create_work_item$/i,
	/add_card$/i,
	/add_issue$/i,
	/add_task$/i,
	/createJiraIssue$/i, // Atlassian Rovo MCP
	/createIssue$/i, // Linear / generic camelCase
];

/**
 * Patterns for detecting task update tools
 */
const TASK_UPDATE_PATTERNS: RegExp[] = [
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
	/editJiraIssue$/i, // Atlassian Rovo MCP
	/updateIssue$/i, // Linear / generic camelCase
];

/**
 * Patterns for detecting task get/read tools
 */
const TASK_GET_PATTERNS: RegExp[] = [
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
	/getJiraIssue$/i, // Atlassian Rovo MCP
	/getIssue$/i, // Linear / generic camelCase
];

/**
 * Patterns for detecting task list tools
 */
const TASK_LIST_PATTERNS: RegExp[] = [
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
	/searchJiraIssuesUsingJql$/i, // Atlassian Rovo MCP
	/listIssues$/i, // Linear / generic camelCase
];

/**
 * Patterns for detecting a comments-read tool. All `$`-anchored on a `comments`
 * suffix so they never collide with the `$`-anchored task get/list patterns
 * (`get_card$`, `get_work_item$`, `list_cards$`, …). Examples matched:
 * ADO `wit_get_work_item_comments`, Fizzy `get_card_comments`,
 * GitHub `get_issue_comments`, Linear/Rovo `getComments`.
 */
const TASK_COMMENTS_GET_PATTERNS: RegExp[] = [
	/get_card_comments$/i,
	/_work_item_comments$/i,
	/get_issue_comments$/i,
	/list_issue_comments$/i,
	/get_comments$/i,
	/list_comments$/i,
	/getComments$/i,
	/listComments$/i,
];

/**
 * Patterns for task ID parameters
 */
const TASK_ID_PARAM_PATTERNS: Array<{ pattern: RegExp; priority: number }> = [
	{ pattern: /^card_number$/i, priority: 11 }, // Fizzy uses card_number
	{ pattern: /^number$/i, priority: 10 }, // Fizzy shorthand
	{ pattern: /^card_id$/i, priority: 10 },
	{ pattern: /^issue_id$/i, priority: 10 },
	{ pattern: /^issue_key$/i, priority: 10 },
	{ pattern: /^issueIdOrKey$/i, priority: 11 }, // Atlassian Rovo MCP
	{ pattern: /^task_id$/i, priority: 10 },
	// Azure DevOps' Microsoft MCP uses camelCase `workItemId` on
	// wit_add_work_item_comment / wit_get_work_item_comments / etc.
	// Match snake_case and kebab-case variants too for safety.
	{ pattern: /^work[_-]?item[_-]?id$/i, priority: 10 },
	{ pattern: /^item_id$/i, priority: 9 },
	{ pattern: /^ticket_id$/i, priority: 9 },
	{ pattern: /^id$/i, priority: 5 },
	{ pattern: /^issue_number$/i, priority: 8 },
];

/**
 * Patterns for status/state parameters
 */
const STATUS_PARAM_PATTERNS: Array<{ pattern: RegExp; priority: number }> = [
	{ pattern: /^status$/i, priority: 10 },
	{ pattern: /^state$/i, priority: 9 },
	{ pattern: /^column_id$/i, priority: 8 },
	{ pattern: /^list_id$/i, priority: 7 },
	{ pattern: /^status_id$/i, priority: 10 },
];

/**
 * Common parameter name mappings for task creation
 */
const CONTAINER_PARAM_PATTERNS: Array<{ pattern: RegExp; priority: number }> = [
	{ pattern: /^board_id$/i, priority: 10 },
	{ pattern: /^project_id$/i, priority: 10 },
	{ pattern: /^project_key$/i, priority: 10 },
	{ pattern: /^projectKey$/i, priority: 10 }, // Atlassian Rovo MCP
	{ pattern: /^project$/i, priority: 10 }, // Azure DevOps uses "project"
	{ pattern: /^team_id$/i, priority: 10 },
	{ pattern: /^account_slug$/i, priority: 8 }, // Fizzy get_cards: account-level list (lower than board_id for create)
	{ pattern: /^workspace_id$/i, priority: 7 },
	{ pattern: /^repo$/i, priority: 10 },
	{ pattern: /^repository$/i, priority: 9 },
	{ pattern: /^list_id$/i, priority: 8 },
	{ pattern: /^container_id$/i, priority: 7 },
	{ pattern: /^parent_id$/i, priority: 6 },
];

const TITLE_PARAM_PATTERNS: Array<{ pattern: RegExp; priority: number }> = [
	{ pattern: /^title$/i, priority: 10 },
	{ pattern: /^summary$/i, priority: 9 },
	{ pattern: /^name$/i, priority: 8 },
	{ pattern: /^subject$/i, priority: 7 },
];

const DESCRIPTION_PARAM_PATTERNS: Array<{ pattern: RegExp; priority: number }> =
	[
		{ pattern: /^description$/i, priority: 10 },
		{ pattern: /^body$/i, priority: 9 },
		{ pattern: /^content$/i, priority: 8 },
		{ pattern: /^details$/i, priority: 7 },
		{ pattern: /^notes$/i, priority: 6 },
	];

const PARENT_PARAM_PATTERNS: Array<{ pattern: RegExp; containerType: string }> =
	[
		{ pattern: /^account_slug$/i, containerType: "account" },
		{ pattern: /^account_id$/i, containerType: "account" },
		{ pattern: /^workspace_id$/i, containerType: "workspace" },
		{ pattern: /^organization_id$/i, containerType: "organization" },
		{ pattern: /^org_id$/i, containerType: "organization" },
	];

/**
 * PM tool type detection patterns
 */
const PM_TYPE_PATTERNS: Array<{ pattern: RegExp; type: string }> = [
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
	{ pattern: /azure[_-]?devops|ado|wit_/i, type: "azure-devops" },
];

// =============================================================================
// Main Analysis Functions
// =============================================================================

/**
 * Analyze MCP tools to detect PM capabilities
 *
 * @param tools - Map of tool names to their definitions
 * @returns PM capabilities detected from the tools
 */
export function analyzePMToolCapabilities(
	tools: Record<string, McpToolDefinition>,
	opts?: { serverHint?: string },
): PMToolCapabilities {
	const toolNames = Object.keys(tools);

	logger.info("[PM Analyzer] Analyzing tools for PM capabilities", {
		toolCount: toolNames.length,
		tools: toolNames.slice(0, 20),
		serverHint: opts?.serverHint,
	});

	// Detect PM tool type from tool names, falling back to server name hint
	// when individual tool names don't carry the vendor (e.g. GitLab's MCP shim
	// exposes generic tools like "list_issues", "get_issue", "create_issue").
	const detectedType = detectPMType(toolNames, opts?.serverHint);

	// Find container hierarchy
	const containerHierarchy = detectContainerHierarchy(tools);

	// Find task capabilities
	const taskCreation = detectTaskCreationCapability(tools);
	const taskUpdate = detectTaskUpdateCapability(tools);
	const taskGet = detectTaskGetCapability(tools);
	const taskList = detectTaskListCapability(tools);
	const taskComments = detectTaskCommentsCapability(tools);

	const hasPMCapabilities =
		containerHierarchy.length > 0 || taskCreation !== undefined;

	const result: PMToolCapabilities = {
		hasPMCapabilities,
		containerHierarchy,
		taskCreation,
		taskUpdate,
		taskGet,
		taskList,
		taskComments,
		detectedType,
		availableTools: toolNames,
		supportsTestCases: hasNativeTestCaseSupport(detectedType, toolNames),
	};

	logger.info("[PM Analyzer] Analysis complete", {
		hasPMCapabilities,
		detectedType,
		hierarchyLevels: containerHierarchy.length,
		hasTaskCreation: !!taskCreation,
		hasTaskUpdate: !!taskUpdate,
		hasTaskGet: !!taskGet,
		hasTaskList: !!taskList,
	});

	return result;
}

/**
 * Detect PM tool type from tool names. When tool names don't reveal the
 * vendor (GitLab's shim exposes generic `list_issues` / `get_issue`), the
 * `serverHint` (e.g. the MCP server's display name "GitLab") is appended
 * so the same regex set still matches.
 */
function detectPMType(
	toolNames: string[],
	serverHint?: string,
): string | undefined {
	const haystack = serverHint
		? `${toolNames.join(" ")} ${serverHint}`
		: toolNames.join(" ");

	for (const { pattern, type } of PM_TYPE_PATTERNS) {
		if (pattern.test(haystack)) {
			return type;
		}
	}

	return undefined;
}

/**
 * Detect container hierarchy from tools
 */
function detectContainerHierarchy(
	tools: Record<string, McpToolDefinition>,
): ContainerLevel[] {
	const hierarchy: ContainerLevel[] = [];
	const toolNames = Object.keys(tools);

	// Find all container listing tools
	for (const toolName of toolNames) {
		for (const patternDef of CONTAINER_LIST_PATTERNS) {
			if (patternDef.pattern.test(toolName)) {
				const tool = tools[toolName];
				const schema = tool.inputSchema;

				// Determine parent parameter if any
				let parentParam: string | undefined;
				if (schema?.properties) {
					for (const paramName of Object.keys(schema.properties)) {
						for (const {
							pattern,
							containerType: _containerType,
						} of PARENT_PARAM_PATTERNS) {
							if (pattern.test(paramName)) {
								parentParam = paramName;
								break;
							}
						}
						if (parentParam) {
							break;
						}
					}
				}

				// Determine ID parameter for this container type
				const idParam = getIdParamForContainerType(
					patternDef.containerType,
				);

				hierarchy.push({
					level: patternDef.level,
					listToolName: toolName,
					containerType: patternDef.containerType,
					idParam,
					parentParam,
					resultIdField: patternDef.idField,
					resultNameField: patternDef.nameField,
				});

				break;
			}
		}
	}

	// Sort by level
	hierarchy.sort((a, b) => a.level - b.level);

	// Deduplicate by container type (keep first match)
	const seen = new Set<string>();
	const deduped: ContainerLevel[] = [];
	for (const level of hierarchy) {
		if (!seen.has(level.containerType)) {
			seen.add(level.containerType);
			deduped.push(level);
		}
	}

	return deduped;
}

/**
 * Get the ID parameter name for a container type
 */
function getIdParamForContainerType(containerType: string): string {
	switch (containerType) {
		case "account":
			return "account_slug";
		case "workspace":
			return "workspace_id";
		case "organization":
			return "organization_id";
		case "board":
			return "board_id";
		case "project":
			return "project_id";
		case "team":
			return "team_id";
		case "repo":
			return "repo";
		default:
			return `${containerType}_id`;
	}
}

/**
 * Detect task creation capability from tools
 */
function detectTaskCreationCapability(
	tools: Record<string, McpToolDefinition>,
): TaskCreationCapability | undefined {
	const toolNames = Object.keys(tools);

	// Find task creation tool
	let createToolName: string | undefined;
	for (const toolName of toolNames) {
		for (const pattern of TASK_CREATE_PATTERNS) {
			if (pattern.test(toolName)) {
				createToolName = toolName;
				break;
			}
		}
		if (createToolName) {
			break;
		}
	}

	if (!createToolName) {
		logger.debug("[PM Analyzer] No task creation tool found");
		return undefined;
	}

	const tool = tools[createToolName];
	const schema = tool.inputSchema;

	if (!schema?.properties) {
		logger.warn("[PM Analyzer] Task creation tool has no input schema", {
			toolName: createToolName,
		});
		return undefined;
	}

	const properties = schema.properties;
	const requiredParams = schema.required || [];
	const paramNames = Object.keys(properties);

	// Find container parameter
	const containerParam = findBestMatchingParam(
		paramNames,
		CONTAINER_PARAM_PATTERNS,
	);

	// Find title parameter
	const titleParam = findBestMatchingParam(paramNames, TITLE_PARAM_PATTERNS);

	// Find description parameter (optional)
	const descriptionParam = findBestMatchingParam(
		paramNames,
		DESCRIPTION_PARAM_PATTERNS,
	);

	// Azure DevOps style: project + workItemType + fields (object)
	const hasFields = paramNames.some((p) => /^fields$/i.test(p));
	const hasWorkItemType = paramNames.some((p) => /^workItemType$/i.test(p));
	const fieldsBased =
		containerParam && hasFields && hasWorkItemType
			? {
					titleKey: "System.Title",
					descriptionKey: "System.Description",
					workItemTypeParam: "workItemType",
					fieldsParam: "fields",
				}
			: undefined;

	if (!containerParam) {
		logger.warn(
			"[PM Analyzer] Could not detect container param for task creation",
			{
				toolName: createToolName,
				availableParams: paramNames,
			},
		);
		return undefined;
	}

	// Require either titleParam or fieldsBased
	if (!titleParam && !fieldsBased) {
		logger.warn(
			"[PM Analyzer] Could not detect title/fields param for task creation",
			{
				toolName: createToolName,
				containerParam,
				availableParams: paramNames,
			},
		);
		return undefined;
	}

	// Build all params list
	const allParams: TaskCreationCapability["allParams"] = [];
	for (const [paramName, paramDefUnknown] of Object.entries(properties)) {
		// Cast to access common JSON Schema properties
		const paramDef = paramDefUnknown as
			| { type?: string; description?: string }
			| undefined;
		allParams.push({
			name: paramName,
			type: paramDef?.type || "string",
			required: requiredParams.includes(paramName),
			description: paramDef?.description,
		});
	}

	// Find additional required params (excluding the ones we identified)
	const knownParams = new Set(
		[
			containerParam,
			titleParam,
			descriptionParam,
			fieldsBased?.workItemTypeParam,
			fieldsBased?.fieldsParam,
		].filter(Boolean),
	);
	const additionalRequiredParams = requiredParams.filter(
		(p) => !knownParams.has(p),
	);

	logger.info("[PM Analyzer] Detected task creation capability", {
		toolName: createToolName,
		containerParam,
		titleParam,
		descriptionParam,
		fieldsBased: !!fieldsBased,
		additionalRequiredParams,
	});

	return {
		toolName: createToolName,
		containerParam,
		titleParam: titleParam ?? "__unused__",
		descriptionParam,
		fieldsBased,
		additionalRequiredParams,
		allParams,
	};
}

/**
 * Find the best matching parameter from a list based on patterns
 */
function findBestMatchingParam(
	paramNames: string[],
	patterns: Array<{ pattern: RegExp; priority: number }>,
): string | undefined {
	let bestMatch: { name: string; priority: number } | undefined;

	for (const paramName of paramNames) {
		for (const { pattern, priority } of patterns) {
			if (pattern.test(paramName)) {
				if (!bestMatch || priority > bestMatch.priority) {
					bestMatch = { name: paramName, priority };
				}
				break;
			}
		}
	}

	return bestMatch?.name;
}

/**
 * Detect task update capability from tools
 */
function detectTaskUpdateCapability(
	tools: Record<string, McpToolDefinition>,
): TaskUpdateCapability | undefined {
	const toolNames = Object.keys(tools);

	// Find task update tool
	let updateToolName: string | undefined;
	for (const toolName of toolNames) {
		for (const pattern of TASK_UPDATE_PATTERNS) {
			if (pattern.test(toolName)) {
				updateToolName = toolName;
				break;
			}
		}
		if (updateToolName) {
			break;
		}
	}

	if (!updateToolName) {
		logger.debug("[PM Analyzer] No task update tool found");
		return undefined;
	}

	const tool = tools[updateToolName];
	const schema = tool.inputSchema;

	if (!schema?.properties) {
		logger.warn("[PM Analyzer] Task update tool has no input schema", {
			toolName: updateToolName,
		});
		return undefined;
	}

	const properties = schema.properties;
	const requiredParams = schema.required || [];

	// Find task ID parameter
	const idParam = findBestMatchingParam(
		Object.keys(properties),
		TASK_ID_PARAM_PATTERNS,
	);

	if (!idParam) {
		logger.warn("[PM Analyzer] Could not detect ID param for task update", {
			toolName: updateToolName,
			availableParams: Object.keys(properties),
		});
		return undefined;
	}

	// Find optional params
	const titleParam = findBestMatchingParam(
		Object.keys(properties),
		TITLE_PARAM_PATTERNS,
	);
	const descriptionParam = findBestMatchingParam(
		Object.keys(properties),
		DESCRIPTION_PARAM_PATTERNS,
	);
	const statusParam = findBestMatchingParam(
		Object.keys(properties),
		STATUS_PARAM_PATTERNS,
	);

	// Azure DevOps style: id + updates (array of patch ops)
	const hasUpdatesParam = Object.keys(properties).some((p) =>
		/^updates$/i.test(p),
	);
	const updatesBased = hasUpdatesParam
		? { updatesParam: "updates" }
		: undefined;

	// Atlassian Rovo Jira style: title/description live inside a `fields`
	// object param. Detect by: there is a top-level `fields` param of type
	// object that the server marks REQUIRED. We then route updates through
	// that object using the canonical Jira field names (`summary`,
	// `description`).
	//
	// Required-driven (not absence-driven): the previous absence check
	// (`!titleParam && !descriptionParam`) bailed out whenever ANY top-level
	// param happened to match the title/description name patterns, leaving
	// us in the fall-through branch that sent `{ idParam, title, desc }`
	// without `fields`. Atlassian's editJiraIssue then rejected with
	// `path: ["fields"], message: "Required"` (observed live 2026-05-28 on
	// staging Jira F-002). Whenever `fields` is required we MUST populate
	// it; any incidental top-level title/description matches are redundant
	// rather than load-bearing, so prefer the canonical `fields` placement.
	const fieldsParamName = Object.keys(properties).find((p) =>
		/^fields$/i.test(p),
	);
	const fieldsParamIsObject = fieldsParamName
		? (properties[fieldsParamName] as { type?: string } | undefined)
				?.type === "object"
		: false;
	const fieldsParamIsRequired = fieldsParamName
		? requiredParams.includes(fieldsParamName)
		: false;
	const fieldsObjectBased =
		fieldsParamName &&
		fieldsParamIsObject &&
		fieldsParamIsRequired &&
		!updatesBased
			? {
					fieldsParam: fieldsParamName,
					titleField: "summary",
					descriptionField: "description",
				}
			: undefined;

	// Build all params list
	const allParams: TaskUpdateCapability["allParams"] = [];
	for (const [paramName, paramDefUnknown] of Object.entries(properties)) {
		const paramDef = paramDefUnknown as
			| { type?: string; description?: string }
			| undefined;
		allParams.push({
			name: paramName,
			type: paramDef?.type || "string",
			required: requiredParams.includes(paramName),
			description: paramDef?.description,
		});
	}

	logger.info("[PM Analyzer] Detected task update capability", {
		toolName: updateToolName,
		idParam,
		titleParam,
		descriptionParam,
		statusParam,
		updatesBased: !!updatesBased,
		fieldsObjectBased: !!fieldsObjectBased,
	});

	return {
		toolName: updateToolName,
		idParam,
		titleParam,
		descriptionParam,
		statusParam,
		updatesBased,
		fieldsObjectBased,
		allParams,
	};
}

/**
 * Detect task get/read capability from tools
 */
function detectTaskGetCapability(
	tools: Record<string, McpToolDefinition>,
): TaskGetCapability | undefined {
	const toolNames = Object.keys(tools);

	// Find task get tool
	let getToolName: string | undefined;
	for (const toolName of toolNames) {
		for (const pattern of TASK_GET_PATTERNS) {
			if (pattern.test(toolName)) {
				getToolName = toolName;
				break;
			}
		}
		if (getToolName) {
			break;
		}
	}

	if (!getToolName) {
		logger.debug("[PM Analyzer] No task get tool found");
		return undefined;
	}

	const tool = tools[getToolName];
	const schema = tool.inputSchema;

	if (!schema?.properties) {
		logger.warn("[PM Analyzer] Task get tool has no input schema", {
			toolName: getToolName,
		});
		return undefined;
	}

	const properties = schema.properties;
	const requiredParams = schema.required || [];

	// Find task ID parameter
	const idParam = findBestMatchingParam(
		Object.keys(properties),
		TASK_ID_PARAM_PATTERNS,
	);

	if (!idParam) {
		logger.warn("[PM Analyzer] Could not detect ID param for task get", {
			toolName: getToolName,
			availableParams: Object.keys(properties),
		});
		return undefined;
	}

	// Find additional required params (excluding the ID)
	const additionalRequiredParams = requiredParams.filter(
		(p) => p !== idParam,
	);

	// Collect all params for optional-param lookups (e.g. project on ADO get)
	const allParams = Object.entries(properties).map(([name, def]) => ({
		name,
		type: (def as { type?: string }).type ?? "string",
		required: requiredParams.includes(name),
	}));

	logger.info("[PM Analyzer] Detected task get capability", {
		toolName: getToolName,
		idParam,
		additionalRequiredParams,
	});

	return {
		toolName: getToolName,
		idParam,
		additionalRequiredParams,
		allParams,
	};
}

/**
 * Detect task comments read capability from tools.
 */
function detectTaskCommentsCapability(
	tools: Record<string, McpToolDefinition>,
): TaskCommentsCapability | undefined {
	const toolNames = Object.keys(tools);

	let commentsToolName: string | undefined;
	for (const toolName of toolNames) {
		for (const pattern of TASK_COMMENTS_GET_PATTERNS) {
			if (pattern.test(toolName)) {
				commentsToolName = toolName;
				break;
			}
		}
		if (commentsToolName) {
			break;
		}
	}

	if (!commentsToolName) {
		logger.debug("[PM Analyzer] No task comments tool found");
		return undefined;
	}

	const tool = tools[commentsToolName];
	const schema = tool.inputSchema;
	if (!schema?.properties) {
		logger.warn("[PM Analyzer] Task comments tool has no input schema", {
			toolName: commentsToolName,
		});
		return undefined;
	}

	const properties = schema.properties;
	const requiredParams = schema.required || [];

	const idParam = findBestMatchingParam(
		Object.keys(properties),
		TASK_ID_PARAM_PATTERNS,
	);
	if (!idParam) {
		logger.warn(
			"[PM Analyzer] Could not detect ID param for task comments",
			{
				toolName: commentsToolName,
				availableParams: Object.keys(properties),
			},
		);
		return undefined;
	}

	const additionalRequiredParams = requiredParams.filter(
		(p) => p !== idParam,
	);
	const allParams = Object.entries(properties).map(([name, def]) => ({
		name,
		type: (def as { type?: string }).type ?? "string",
		required: requiredParams.includes(name),
	}));

	logger.info("[PM Analyzer] Detected task comments capability", {
		toolName: commentsToolName,
		idParam,
		additionalRequiredParams,
	});

	return {
		toolName: commentsToolName,
		idParam,
		additionalRequiredParams,
		allParams,
	};
}

/**
 * Detect task list capability from tools
 */
function detectTaskListCapability(
	tools: Record<string, McpToolDefinition>,
): TaskListCapability | undefined {
	const toolNames = Object.keys(tools);

	// Find task list tool
	let listToolName: string | undefined;
	for (const toolName of toolNames) {
		for (const pattern of TASK_LIST_PATTERNS) {
			if (pattern.test(toolName)) {
				listToolName = toolName;
				break;
			}
		}
		if (listToolName) {
			break;
		}
	}

	if (!listToolName) {
		logger.debug("[PM Analyzer] No task list tool found");
		return undefined;
	}

	const tool = tools[listToolName];
	const schema = tool.inputSchema;

	if (!schema?.properties) {
		logger.warn("[PM Analyzer] Task list tool has no input schema", {
			toolName: listToolName,
		});
		return undefined;
	}

	const properties = schema.properties;

	// Find container parameter
	const containerParam = findBestMatchingParam(
		Object.keys(properties),
		CONTAINER_PARAM_PATTERNS,
	);

	if (!containerParam) {
		logger.warn(
			"[PM Analyzer] Could not detect container param for task list",
			{
				toolName: listToolName,
				availableParams: Object.keys(properties),
			},
		);
		return undefined;
	}

	// Find filter parameters (status, assignee, team, backlogId, etc.)
	// Include ADO-specific params: team, backlogId (required for wit_list_backlog_work_items)
	const filterParams: string[] = [];
	for (const paramName of Object.keys(properties)) {
		if (paramName === containerParam) {
			continue;
		}
		// Common filter params + ADO backlog params (team, backlogId)
		if (
			/status|state|assignee|label|tag|query|search|filter|team|backlogId|backlog|iterationId|iteration/i.test(
				paramName,
			)
		) {
			filterParams.push(paramName);
		}
	}

	// Build allParams list
	const requiredParams = schema.required || [];
	const allParams: TaskListCapability["allParams"] = [];
	for (const [paramName, paramDefUnknown] of Object.entries(properties)) {
		const paramDef = paramDefUnknown as
			| { type?: string; description?: string }
			| undefined;
		allParams.push({
			name: paramName,
			type: paramDef?.type || "string",
			required: requiredParams.includes(paramName),
			description: paramDef?.description,
		});
	}

	// Detect pagination style from parameter names
	const paramNames = Object.keys(properties);

	// Page-number param: `page`
	const pageParam = paramNames.find((p) => /^page$/i.test(p));

	// Skip/offset param: offset | skip | $skip | startAt
	const skipParam = paramNames.find((p) =>
		/^(offset|skip|\$skip|startAt)$/i.test(p),
	);

	// Cursor param: cursor | after | before | next_cursor
	const cursorParam = paramNames.find((p) =>
		/^(cursor|after|before|next_cursor|nextCursor)$/i.test(p),
	);

	// Page-size param: per_page | limit | pageSize | page_size | maxResults | $top | first
	const pageSizeParam = paramNames.find((p) =>
		/^(per_page|limit|pageSize|page_size|maxResults|max_results|\$top|first)$/i.test(
			p,
		),
	);

	let paginationInfo: PaginationInfo;
	if (pageParam) {
		paginationInfo = {
			style: "offset-page",
			pageParam,
			pageSizeParam,
		};
	} else if (skipParam) {
		paginationInfo = {
			style: "offset-skip",
			skipParam,
			pageSizeParam,
		};
	} else if (cursorParam) {
		paginationInfo = { style: "cursor", cursorParam, pageSizeParam };
	} else {
		paginationInfo = { style: "none" };
	}

	logger.info("[PM Analyzer] Detected task list capability", {
		toolName: listToolName,
		containerParam,
		filterParams,
		paginationStyle: paginationInfo.style,
	});

	return {
		toolName: listToolName,
		containerParam,
		filterParams,
		paginationInfo,
		allParams,
	};
}

// =============================================================================
// Utility Functions for Task Pushing
// =============================================================================

/**
 * Build task creation arguments dynamically from capabilities
 *
 * @param capabilities - PM capabilities detected from tools
 * @param task - Task to create (title and description)
 * @param containerId - Container ID to create task in
 * @param additionalContext - Additional context (e.g., account_slug)
 * @returns Arguments object for the create tool
 */
export function buildTaskCreationArgs(
	capabilities: PMToolCapabilities,
	task: { title: string; description?: string },
	containerId: string,
	additionalContext?: Record<string, string>,
): Record<string, unknown> {
	if (!capabilities.taskCreation) {
		throw new Error("No task creation capability detected");
	}

	const {
		containerParam,
		titleParam,
		descriptionParam,
		additionalRequiredParams,
	} = capabilities.taskCreation;

	const args: Record<string, unknown> = {
		[containerParam]: containerId,
		[titleParam]: task.title,
	};

	if (descriptionParam && task.description) {
		args[descriptionParam] = task.description;
	}

	// Add additional context for required params
	if (additionalContext) {
		for (const param of additionalRequiredParams) {
			if (additionalContext[param]) {
				args[param] = additionalContext[param];
			}
		}

		// Also check for parent params needed by task creation
		for (const [key, value] of Object.entries(additionalContext)) {
			// Include any context that matches known patterns
			for (const { pattern } of PARENT_PARAM_PATTERNS) {
				if (pattern.test(key) && !args[key]) {
					args[key] = value;
				}
			}
		}
	}

	return args;
}

// =============================================================================
// Provider-agnostic field enumeration
//
// Pure projection + plumbing heuristic for the "enumerate available fields"
// seam. The MCP orchestration that actually calls `wit_get_work_item_type`
// lives in `enumerate-pm-fields.ts`; the field-shaping logic below is kept here
// (no MCP / DB deps) so it stays trivially unit-testable (tasks 7.3 / 7.4).
// =============================================================================

/**
 * One enumerated field in the transient catalog. Not persisted —
 * cached in the settings-page component state only.
 */
export interface PmFieldCatalogEntry {
	/** Provider field identifier, e.g. `Custom.BusinessRules`. */
	referenceName: string;
	/** Display name, e.g. "Business Rules". */
	name: string;
	/** Derived hint for default-hide (internal automation/state plumbing). */
	isPlumbing: boolean;
}

/**
 * Curated denylist of known ADO plumbing referenceNames.
 * Belt-and-braces alongside {@link PLUMBING_LOCAL_PATTERNS} — an exact match is
 * always plumbing even if the pattern set drifts.
 */
const PLUMBING_DENYLIST = new Set<string>([
	"Custom.LSReset",
	"Custom.StateDevFE",
	"Custom.StateDevBE",
	"Custom.IdDevBE",
	"Custom.IdDevFE",
	"Custom.zLSUpdated",
]);

const CUSTOM_FIELD_PREFIX = "Custom.";

/**
 * Conservative deny-regex over the local part of a `Custom.*` referenceName
 * (the segment after `Custom.`). Matches the known state/automation plumbing
 * families from the spike (`LSReset`, `StateDev*`, `IdDev*`, `z*` hidden fields,
 * `Group*`, `Risk*`, identity-style `Id*`). Deliberately narrow — err toward
 * SHOWING (isPlumbing=false) when unsure, since the "Show all fields" toggle and
 * the manual-identifier escape hatch both recover anything hidden here.
 */
const PLUMBING_LOCAL_PATTERNS: RegExp[] = [
	/^LSReset/i, // Custom.LSReset*
	/^StateDev/i, // Custom.StateDevFE / StateDevBE
	/^IdDev/i, // Custom.IdDevBE / IdDevFE
	/^z[A-Z]/, // z-prefixed hidden fields, e.g. Custom.zLSUpdated
	/^Group/i, // Custom.Group*
	/^Risk/i, // Custom.Risk*
	/^Id[A-Z]/, // identity-style Custom.Id* (IdDev* already covered)
];

/**
 * Single-source plumbing classifier. Only `Custom.*` fields are
 * ever considered plumbing; standard `System.*` / `Microsoft.VSTS.*` fields are
 * always shown (isPlumbing=false). Content custom fields (Business Rules,
 * Acceptance, Design Criteria, Release Notes, User Story Acceptance) are NOT
 * matched by any pattern above, so they surface by default.
 */
export function isPlumbingReferenceName(referenceName: string): boolean {
	if (!referenceName) {
		return false;
	}
	if (PLUMBING_DENYLIST.has(referenceName)) {
		return true;
	}
	if (!referenceName.startsWith(CUSTOM_FIELD_PREFIX)) {
		return false;
	}
	const local = referenceName.slice(CUSTOM_FIELD_PREFIX.length);
	return PLUMBING_LOCAL_PATTERNS.some((re) => re.test(local));
}

/**
 * Build the deduped field catalog from the per-type `.fields[]` arrays returned
 * by `wit_get_work_item_type` (one array per work item type). Projects each raw
 * field to `{ referenceName, name }`, computes `isPlumbing`, and dedupes by
 * `referenceName` (first occurrence wins — the union across all types). Malformed
 * entries (no `referenceName`) are skipped; `name` falls back to `referenceName`.
 */
export function buildFieldCatalogFromTypeFields(
	typeFieldArrays: Array<unknown>,
): PmFieldCatalogEntry[] {
	const byRef = new Map<string, PmFieldCatalogEntry>();
	for (const arr of typeFieldArrays) {
		if (!Array.isArray(arr)) {
			continue;
		}
		for (const raw of arr) {
			if (!raw || typeof raw !== "object") {
				continue;
			}
			const rec = raw as Record<string, unknown>;
			const referenceName =
				typeof rec.referenceName === "string"
					? rec.referenceName
					: undefined;
			if (!referenceName || byRef.has(referenceName)) {
				continue;
			}
			const name =
				typeof rec.name === "string" && rec.name
					? rec.name
					: referenceName;
			byRef.set(referenceName, {
				referenceName,
				name,
				isPlumbing: isPlumbingReferenceName(referenceName),
			});
		}
	}
	return Array.from(byRef.values());
}

/**
 * Get the container fetch workflow based on hierarchy
 *
 * @param capabilities - PM capabilities
 * @returns Steps to fetch containers (may be multi-step for hierarchical systems)
 */
export function getContainerFetchWorkflow(
	capabilities: PMToolCapabilities,
): Array<{
	toolName: string;
	paramsNeeded: string[];
	producesContext: string;
}> {
	const workflow: Array<{
		toolName: string;
		paramsNeeded: string[];
		producesContext: string;
	}> = [];

	for (const level of capabilities.containerHierarchy) {
		workflow.push({
			toolName: level.listToolName,
			paramsNeeded: level.parentParam ? [level.parentParam] : [],
			producesContext: level.idParam,
		});
	}

	return workflow;
}
