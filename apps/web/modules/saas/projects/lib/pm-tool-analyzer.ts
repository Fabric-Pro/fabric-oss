/**
 * PM Tool Capability Analyzer (Client-side)
 *
 * Dynamically analyzes MCP tool schemas to detect project management capabilities.
 * Works with ANY MCP server - no hardcoded provider-specific logic.
 *
 * NOTE: Shared patterns are defined in @repo/utils/lib/pm-tool-patterns.ts
 * This file uses local copies for client-side compatibility but should stay in sync.
 */

import {
	COMMON_ID_FIELDS,
	COMMON_NAME_FIELDS,
	extractContainerType,
	isContainerListingTool,
	isTaskCreationTool,
	detectPMType as sharedDetectPMType,
} from "@repo/utils";

/**
 * Tool definition from MCP list-tools API
 */
export interface McpTool {
	name: string;
	description?: string | null;
	inputSchema?: {
		type?: string;
		properties?: Record<
			string,
			{
				type?: string;
				description?: string;
				enum?: string[];
				default?: unknown;
			}
		>;
		required?: string[];
	};
	parameters?: Array<{
		name: string;
		type: string;
		description?: string | null;
		required: boolean;
	}> | null;
}

/**
 * Container level in the hierarchy
 */
export interface ContainerLevel {
	level: number;
	listToolName: string;
	containerType: string;
	requiredParams: string[];
	allParams: string[];
}

/**
 * Task creation capability
 */
interface TaskCreationCapability {
	toolName: string;
	containerParam: string;
	titleParam: string;
	descriptionParam?: string;
}

/**
 * Complete PM tool capabilities
 */
export interface PMToolCapabilities {
	hasPMCapabilities: boolean;
	containerHierarchy: ContainerLevel[];
	taskCreation?: TaskCreationCapability;
	detectedType?: string;
	/**
	 * Name of a tool that resolves a `cloudId` prerequisite shared by every
	 * container tool (Atlassian Rovo's `getAccessibleAtlassianResources`).
	 * When set, the container fetch calls it first and seeds the resulting
	 * cloudId into the params for the listing tools.
	 */
	cloudIdResolverTool?: string;
}

// NOTE: Common patterns imported from @repo/utils/lib/pm-tool-patterns.ts
// Local patterns kept only for backwards compatibility with existing code

/**
 * Analyze MCP tools to detect PM capabilities
 */
export function analyzePMToolCapabilities(
	tools: McpTool[],
): PMToolCapabilities {
	const toolNames = tools.map((t) => t.name);

	// Detect PM type from tool names
	const detectedType = detectPMType(toolNames);

	// Find task creation capability first — it tells us which container type
	// actually holds tasks, used to prune unrelated containers below.
	const taskCreation = detectTaskCreation(tools);

	// Find container listing tools and build hierarchy, then drop containers
	// unrelated to where tasks live. The Atlassian Rovo server bundles Jira +
	// Confluence, so a naive scan yields both `project` (Jira) and `space`
	// (Confluence) as sibling roots — only the Jira project is a task
	// container, and chaining the unrelated Confluence space ahead of it breaks
	// the fetch.
	const containerHierarchy = pruneHierarchyToTaskContainer(
		detectContainerHierarchy(tools),
		taskCreation,
	);

	// Atlassian Rovo: every container tool requires a cloudId provided by
	// getAccessibleAtlassianResources. Surface it so the fetch can resolve it.
	const cloudIdResolverTool = tools.find((t) =>
		/getAccessibleAtlassianResources$/i.test(t.name),
	)?.name;

	return {
		hasPMCapabilities: containerHierarchy.length > 0 || !!taskCreation,
		containerHierarchy,
		taskCreation,
		detectedType,
		cloudIdResolverTool,
	};
}

/**
 * Map a task-creation container param to its container type
 * (e.g. `projectKey` → "project", `board_id` → "board").
 */
function containerTypeFromParam(param: string): string | undefined {
	const p = param.toLowerCase();
	for (const type of [
		"board",
		"project",
		"team",
		"repo",
		"space",
		"channel",
		"workspace",
		"organization",
		"account",
		"folder",
	]) {
		if (p.includes(type)) {
			return type;
		}
	}
	return undefined;
}

/**
 * Derive which field of a container item to use as its id, based on the
 * task-creation container param. Jira's `createJiraIssue` takes `projectKey`,
 * so a project must be identified by its `key` ("SAN"), not its numeric `id`
 * ("10001"); Fizzy's `board_id` keeps using `id`; `account_slug` uses `slug`.
 */
export function containerIdFieldHint(
	containerParam?: string,
): string | undefined {
	if (!containerParam) {
		return undefined;
	}
	const p = containerParam.toLowerCase();
	if (p.endsWith("key")) {
		return "key";
	}
	if (p.endsWith("slug")) {
		return "slug";
	}
	if (p.endsWith("id")) {
		return "id";
	}
	return undefined;
}

/**
 * Reduce the container hierarchy to the chain that actually leads to the task
 * container, dropping unrelated sibling containers.
 *
 * A level is kept only if it is the task container itself or a genuine parent
 * of it — i.e. the task container's list tool accepts a param referencing that
 * parent's type (Fizzy: `get_boards` takes `account_slug`, so the account level
 * stays). We check ALL of the target's params, not just required ones, because
 * a parent context param the fetch relies on may be schema-optional. Unrelated
 * roots that share no param link (Confluence `space` next to Jira `project`)
 * are removed. When every other level is a genuine ancestor, the hierarchy is
 * left untouched.
 */
function pruneHierarchyToTaskContainer(
	hierarchy: ContainerLevel[],
	taskCreation: TaskCreationCapability | undefined,
): ContainerLevel[] {
	if (hierarchy.length <= 1 || !taskCreation) {
		return hierarchy;
	}
	const targetType = containerTypeFromParam(taskCreation.containerParam);
	if (!targetType) {
		return hierarchy;
	}
	const target = hierarchy.find((l) => l.containerType === targetType);
	if (!target) {
		return hierarchy;
	}
	const targetParams = target.allParams.map((p) => p.toLowerCase());
	const ancestors = hierarchy.filter(
		(l) =>
			l !== target &&
			targetParams.some((param) => param.includes(l.containerType)),
	);
	// Nothing unrelated to drop — keep the original (preserves existing chains).
	if (ancestors.length === hierarchy.length - 1) {
		return hierarchy;
	}
	return [...ancestors, target];
}

function detectPMType(toolNames: string[]): string | undefined {
	// Use shared detectPMType from @repo/utils
	return sharedDetectPMType(toolNames);
}

function detectContainerHierarchy(tools: McpTool[]): ContainerLevel[] {
	const containerTools: ContainerLevel[] = [];

	for (const tool of tools) {
		// Check if this tool looks like a container listing tool (uses shared patterns)
		if (!isContainerListingTool(tool.name)) {
			continue;
		}

		// Extract container type from tool name
		const containerType = extractContainerType(tool.name);
		if (!containerType) {
			continue;
		}

		// Get params from schema - check both inputSchema.properties AND parameters array
		const schema = tool.inputSchema;
		let allParams: string[] = [];
		let requiredParams: string[] = [];

		if (schema?.properties) {
			allParams = Object.keys(schema.properties);
			requiredParams = schema.required || [];
		} else if (tool.parameters && Array.isArray(tool.parameters)) {
			allParams = tool.parameters.map((p) => p.name);
			requiredParams = tool.parameters
				.filter((p) => p.required)
				.map((p) => p.name);
		}

		containerTools.push({
			level: 0, // Will be calculated below
			listToolName: tool.name,
			containerType,
			requiredParams,
			allParams,
		});
	}

	// Calculate hierarchy levels dynamically based on:
	// 1. Tools with no params or only optional params = root (level 0)
	// 2. Tools whose names reference other container types = children
	// 3. Common parent types (account, workspace, org, team) are typically roots

	const rootTypes = new Set(["account", "workspace", "organization", "team"]);
	const childTypes = new Set([
		"board",
		"project",
		"repo",
		"issue",
		"task",
		"card",
		"space",
		"channel",
	]);

	for (const tool of containerTools) {
		// Check if tool name suggests it's scoped to a parent
		// e.g., "get_team_projects" or "list_workspace_boards"
		const toolNameLower = tool.listToolName.toLowerCase();
		const hasParentInName = Array.from(rootTypes).some(
			(parent) =>
				toolNameLower.includes(parent) && tool.containerType !== parent,
		);

		if (hasParentInName) {
			// Tool name references a parent type
			tool.level = 1;
		} else if (rootTypes.has(tool.containerType)) {
			// This is a root-level container type
			tool.level = 0;
		} else if (childTypes.has(tool.containerType)) {
			// This is typically a child type
			tool.level = 1;
		} else {
			// Unknown type - assume root
			tool.level = 0;
		}
	}

	// If we have no level 0 tools, promote the first tool to level 0
	if (
		containerTools.length > 0 &&
		!containerTools.some((t) => t.level === 0)
	) {
		containerTools[0].level = 0;
	}

	// Sort by level
	containerTools.sort((a, b) => a.level - b.level);

	// Dedupe by container type (keep first of each type)
	const seen = new Set<string>();
	return containerTools.filter((tool) => {
		if (seen.has(tool.containerType)) {
			return false;
		}
		seen.add(tool.containerType);
		return true;
	});
}

function _paramReferencesContainer(
	paramName: string,
	containerType: string,
): boolean {
	// Check if a param name references a container type
	// e.g., "account_slug" references "account", "board_id" references "board"
	const normalizedParam = paramName.toLowerCase();
	const normalizedType = containerType.toLowerCase();
	return normalizedParam.includes(normalizedType);
}

function detectTaskCreation(
	tools: McpTool[],
): TaskCreationCapability | undefined {
	// Use shared isTaskCreationTool from @repo/utils
	const createTool = tools.find((t) => isTaskCreationTool(t.name));
	if (!createTool) {
		return undefined;
	}

	const schema = createTool.inputSchema;
	if (!schema?.properties) {
		return undefined;
	}

	const params = Object.keys(schema.properties);

	// Find container param (board_id, project_id, etc.)
	const containerParam = params.find((p) =>
		/(?:board|project|team|repo|space|channel)[_-]?(?:id|key|slug)?$/i.test(
			p,
		),
	);

	// Find title param
	const titleParam = params.find((p) =>
		/^(title|summary|name|subject)$/i.test(p),
	);

	// Find description param
	const descriptionParam = params.find((p) =>
		/^(description|body|content|text)$/i.test(p),
	);

	if (!containerParam || !titleParam) {
		return undefined;
	}

	return {
		toolName: createTool.name,
		containerParam,
		titleParam,
		descriptionParam,
	};
}

/**
 * Options controlling the container fetch.
 */
export interface FetchContainersOptions {
	/**
	 * Tool that resolves the shared `cloudId` prerequisite (Atlassian Rovo's
	 * getAccessibleAtlassianResources). Called once before the hierarchy; its
	 * first result's id is seeded as `cloudId` context for the listing tools.
	 */
	cloudIdResolverTool?: string;
	/**
	 * Which field of a container item to use as its id (e.g. "key" for Jira
	 * projects). Falls back to COMMON_ID_FIELDS when unset. See
	 * {@link containerIdFieldHint}.
	 */
	idFieldHint?: string;
}

/**
 * Execute container fetch workflow based on detected hierarchy
 *
 * @param mcpConfigId - The MCP configuration ID
 * @param hierarchy - The detected container hierarchy levels
 * @param organizationId - Optional organization ID for tenant isolation
 * @param options - cloudId resolver + id-field hint (see FetchContainersOptions)
 */
export async function fetchContainersWithHierarchy(
	mcpConfigId: string,
	hierarchy: ContainerLevel[],
	organizationId?: string | null,
	options?: FetchContainersOptions,
): Promise<{
	containers: Array<{ id: string; name: string }>;
	additionalContext: Record<string, string>;
}> {
	const additionalContext: Record<string, string> = {};
	let containers: Array<{ id: string; name: string }> = [];

	const callTool = async (
		toolName: string,
		params: Record<string, string>,
	) => {
		const response = await fetch("/api/pipeline/mcp-tool", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				mcpConfigId,
				toolName,
				params,
				organizationId,
			}),
		});
		const data = await response.json();
		if (!response.ok || data.error) {
			throw new Error(data.error || `API error: ${response.status}`);
		}
		return data.result;
	};

	// Resolve the cloudId prerequisite (Atlassian Rovo) before listing
	// containers, so the listing tools — which require it — receive it.
	// Limitation: a user with multiple Atlassian sites gets the first site's
	// cloudId (no site chooser). Single-site is the common case; revisit if
	// multi-site selection is needed.
	if (options?.cloudIdResolverTool) {
		const resolved = extractResultArray(
			await callTool(options.cloudIdResolverTool, {}),
		);
		const cloudId = resolved[0]?.id ?? resolved[0]?.cloudId;
		if (cloudId != null) {
			additionalContext.cloudId = String(cloudId);
		}
	}

	// Execute each level in order
	for (let i = 0; i < hierarchy.length; i++) {
		const level = hierarchy[i];
		const isLastLevel = i === hierarchy.length - 1;

		// Build params for this tool call
		const params: Record<string, string> = {};

		// For non-root levels, pass ALL context values
		// The MCP server will use what it needs
		if (i > 0 && Object.keys(additionalContext).length > 0) {
			// Pass all context - the server will use what it needs
			Object.assign(params, additionalContext);
		}

		// Also try to match specific params if schema is available
		for (const paramName of level.allParams) {
			const contextValue = findContextValueForParam(
				paramName,
				additionalContext,
			);
			if (contextValue) {
				params[paramName] = contextValue;
			}
		}

		// Check required params
		for (const requiredParam of level.requiredParams) {
			if (!params[requiredParam]) {
				const contextValue = findContextValueForParam(
					requiredParam,
					additionalContext,
				);
				if (contextValue) {
					params[requiredParam] = contextValue;
				} else {
					throw new Error(
						`Missing required parameter: ${requiredParam}. Make sure the parent tool was executed first.`,
					);
				}
			}
		}

		// Execute tool via API (organizationId included for tenant isolation).
		// Unwrap wrapped list shapes — Jira's getVisibleJiraProjects returns
		// `{ values: [...] }`, not a bare array.
		const results = extractResultArray(
			await callTool(level.listToolName, params),
		);

		if (results.length === 0) {
			break;
		}

		if (isLastLevel) {
			// Map results to standard container format
			containers = results.map((item: Record<string, unknown>) => ({
				id: extractIdFromItem(item, options?.idFieldHint),
				name: extractNameFromItem(item),
			}));
		} else {
			// Store ALL fields from the first item as context for the next level
			// This allows the next tool to find whatever param it needs
			const firstItem = results[0] as Record<string, unknown>;

			// Store each field with multiple key variations
			for (const [key, value] of Object.entries(firstItem)) {
				if (value != null && typeof value !== "object") {
					const strValue = String(value);
					// Store with original key
					additionalContext[key] = strValue;
					// Store with container type prefix for matching
					additionalContext[`${level.containerType}_${key}`] =
						strValue;
					// Store common variations
					if (key === "id" || key === "slug" || key === "key") {
						additionalContext[`${level.containerType}_id`] =
							strValue;
						additionalContext[`${level.containerType}_slug`] =
							strValue;
						additionalContext[`${level.containerType}Id`] =
							strValue;
						additionalContext[`${level.containerType}Slug`] =
							strValue;
					}
				}
			}
		}
	}

	return { containers, additionalContext };
}

/**
 * Find a matching context value for a required param
 */
function findContextValueForParam(
	paramName: string,
	context: Record<string, string>,
): string | undefined {
	// Direct match
	if (context[paramName]) {
		return context[paramName];
	}

	// Fizzy: account_slug can come from slug (get_accounts returns "slug")
	if (paramName.toLowerCase() === "account_slug" && context.slug) {
		return context.slug;
	}

	// Try case-insensitive match
	const lowerParam = paramName.toLowerCase();
	for (const [key, value] of Object.entries(context)) {
		if (key.toLowerCase() === lowerParam) {
			return value;
		}
	}

	// Try variations (underscore to camelCase, etc.)
	const variations = [
		paramName,
		paramName.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), // snake_case to camelCase
		paramName
			.replace(/([A-Z])/g, "_$1")
			.toLowerCase(), // camelCase to snake_case
	];

	for (const variant of variations) {
		if (context[variant]) {
			return context[variant];
		}
	}

	return undefined;
}

/**
 * Unwrap a list tool's result into an array of items. Most tools return a bare
 * array, but some wrap the list under a key — Jira's getVisibleJiraProjects
 * returns `{ total, values: [...] }`. Returns [] when no array can be found.
 */
function extractResultArray(result: unknown): Array<Record<string, unknown>> {
	if (Array.isArray(result)) {
		return result as Array<Record<string, unknown>>;
	}
	if (result && typeof result === "object") {
		for (const key of [
			"values",
			"projects",
			"items",
			"results",
			"data",
			"boards",
			"spaces",
			"records",
			"workItems",
		]) {
			const value = (result as Record<string, unknown>)[key];
			if (Array.isArray(value)) {
				return value as Array<Record<string, unknown>>;
			}
		}
	}
	return [];
}

/**
 * Extract ID from a result item. Prefers `idFieldHint` (derived from the task
 * container param — e.g. "key" for Jira projects) before COMMON_ID_FIELDS.
 */
function extractIdFromItem(
	item: Record<string, unknown>,
	idFieldHint?: string,
): string {
	if (idFieldHint && item[idFieldHint] != null) {
		return String(item[idFieldHint]);
	}
	for (const field of COMMON_ID_FIELDS) {
		if (item[field] != null) {
			return String(item[field]);
		}
	}
	// Fallback to first string/number value
	for (const value of Object.values(item)) {
		if (typeof value === "string" || typeof value === "number") {
			return String(value);
		}
	}
	return "unknown";
}

/**
 * Extract name from a result item, trying common field names
 */
function extractNameFromItem(item: Record<string, unknown>): string {
	for (const field of COMMON_NAME_FIELDS) {
		if (item[field] != null) {
			return String(item[field]);
		}
	}
	// Fallback to ID
	return extractIdFromItem(item);
}
