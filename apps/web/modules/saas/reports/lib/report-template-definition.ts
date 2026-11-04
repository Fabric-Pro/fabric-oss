import { findMatchingMcpConfigs } from "@saas/reports/lib/mcp-utils";
import type {
	DataSourceDefinition,
	ProviderContextField,
} from "@saas/shared/components/DataSourceDefinitionBuilder";

/**
 * Typed reads of the JSON a report template and instance store, for the
 * screens that set a report up. The columns are untyped JSON in the API
 * output, so every field is checked rather than cast.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> {
	if (!isRecord(value)) {
		return {};
	}
	const result: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry === "string") {
			result[key] = entry;
		}
	}
	return result;
}

const DATA_SOURCE_TYPES: ReadonlyArray<DataSourceDefinition["type"]> = [
	"fabric",
	"integration",
	"mcp",
	"workspace",
	"user-input",
];

function isDataSourceType(
	value: unknown,
): value is DataSourceDefinition["type"] {
	return DATA_SOURCE_TYPES.some((type) => type === value);
}

export type ParsedTemplateDefinition = {
	/** Data sources that name a provider; the others need no connection. */
	dataSources: DataSourceDefinition[];
	userPrompt?: string;
};

export function parseTemplateDefinition(
	definition: unknown,
): ParsedTemplateDefinition {
	if (!isRecord(definition)) {
		return { dataSources: [] };
	}
	const rawSources = Array.isArray(definition.dataSources)
		? definition.dataSources
		: [];
	const dataSources: DataSourceDefinition[] = [];
	for (const source of rawSources) {
		if (
			isRecord(source) &&
			typeof source.id === "string" &&
			typeof source.provider === "string" &&
			source.provider.length > 0
		) {
			dataSources.push({
				id: source.id,
				// Setup reads only the provider; an older template may omit the type.
				type: isDataSourceType(source.type) ? source.type : "mcp",
				provider: source.provider,
				operation:
					typeof source.operation === "string"
						? source.operation
						: undefined,
				...(source.required === false ? { required: false } : {}),
			});
		}
	}
	return {
		dataSources,
		userPrompt:
			typeof definition.userPrompt === "string"
				? definition.userPrompt
				: undefined,
	};
}

/** The system prompt a template's `fabricConfig` gives its reports, if any. */
export function templateSystemPrompt(
	fabricConfig: unknown,
): string | undefined {
	const prompt = isRecord(fabricConfig)
		? fabricConfig.defaultSystemPrompt
		: undefined;
	return typeof prompt === "string" && prompt.trim() ? prompt : undefined;
}

/** A data source is required unless its template marks it optional. */
export function isRequiredDataSource(source: { required?: boolean }): boolean {
	return source.required !== false;
}

/**
 * The prompt override a report saves: nothing while its instructions are
 * the template's own, so a later change to the template's prompt still
 * reaches the report.
 */
export function promptOverrideFor(
	prompt: string,
	templatePrompt: string | undefined,
): string | undefined {
	const trimmed = prompt.trim();
	if (!trimmed || trimmed === templatePrompt?.trim()) {
		return undefined;
	}
	return trimmed;
}

/**
 * The prompt fields a report saves: the override from
 * {@link promptOverrideFor}, and `promptOverrideSource: "user"` when a person
 * wrote it. Only a marked override is added to the template's AI tasks, so
 * an override copied from an older template prompt never is. `stored` is the
 * report's saved connections (none on create): an override left as it was
 * saved keeps the provenance it was saved with.
 */
export function promptOverrideFields(
	prompt: string,
	templatePrompt: string | undefined,
	stored?: unknown,
): { promptOverride?: string; promptOverrideSource?: "user" } {
	const promptOverride = promptOverrideFor(prompt, templatePrompt);
	if (!promptOverride) {
		return {};
	}
	const storedOverride =
		isRecord(stored) && typeof stored.promptOverride === "string"
			? stored.promptOverride.trim()
			: undefined;
	const unchanged = promptOverride === storedOverride;
	const writtenByUser =
		!unchanged ||
		(isRecord(stored) && stored.promptOverrideSource === "user");
	return writtenByUser
		? { promptOverride, promptOverrideSource: "user" }
		: { promptOverride };
}

export type ParsedTemplateWorkspaces = {
	enabled: boolean;
	description?: string;
};

/** The template's optional document-library requirement. */
export function parseTemplateWorkspaces(
	connections: unknown,
): ParsedTemplateWorkspaces {
	const workspaces = isRecord(connections) ? connections.workspaces : null;
	if (!isRecord(workspaces)) {
		return { enabled: false };
	}
	return {
		enabled: workspaces.enabled === true,
		description:
			typeof workspaces.description === "string"
				? workspaces.description
				: undefined,
	};
}

export type ContextField = ProviderContextField & { provider: string };

/**
 * The context fields a set of providers asks for, in provider order, each key
 * once (the first provider that declares a key owns it).
 */
export function contextFieldsForProviders(
	providers: string[],
	fieldsByProvider: Record<string, ProviderContextField[]>,
): ContextField[] {
	const seen = new Set<string>();
	const fields: ContextField[] = [];
	for (const provider of providers) {
		for (const field of fieldsByProvider[provider] ?? []) {
			if (!seen.has(field.key)) {
				seen.add(field.key);
				fields.push({ ...field, provider });
			}
		}
	}
	return fields;
}

export type ReportResourceBinding = {
	resourceId: string;
	resourceName: string;
	resourceType: string;
};

/**
 * The board a new report reads, as the `resourceBindings` the report page
 * expects. The page reports "Project not selected" for a data source whose
 * connection offers resources but has none bound, so a board picked while
 * creating the report must be saved here as well as in the context. Keyed
 * like `mcpBindings`: by data source id and by provider.
 */
export function boardResourceBindings(
	boundDataSources: Array<{ id: string; provider: string }>,
	context: Record<string, string>,
	isBoardProvider: (provider: string) => boolean,
): Record<string, ReportResourceBinding> {
	const boardId = context.boardId?.trim();
	if (!boardId) {
		return {};
	}
	const binding: ReportResourceBinding = {
		resourceId: boardId,
		resourceName: context.boardName?.trim() || boardId,
		resourceType: "board",
	};
	const bindings: Record<string, ReportResourceBinding> = {};
	for (const ds of boundDataSources) {
		if (isBoardProvider(ds.provider)) {
			bindings[ds.id] = binding;
			bindings[ds.provider] = binding;
		}
	}
	return bindings;
}

/**
 * The context without a board the loaded board list no longer offers, so the
 * picker shows its placeholder instead of a blank value and readiness asks for
 * a board. An empty list (not loaded, or none returned) keeps the context.
 */
export function contextWithListedBoard(
	context: Record<string, string>,
	boards: ReadonlyArray<{ id: string }>,
): Record<string, string> {
	const boardId = context.boardId?.trim();
	if (!boardId || boards.length === 0) {
		return context;
	}
	if (boards.some((board) => board.id === boardId)) {
		return context;
	}
	const { boardId: _boardId, boardName: _boardName, ...rest } = context;
	return rest;
}

/**
 * The inverse of {@link boardResourceBindings}: the report's context with the
 * board its resource picker bound, for checks that read `context.boardId`. A
 * board typed into the context wins over a bound one.
 */
export function contextWithBoundBoard(
	context: Record<string, string>,
	bindings: Record<
		string,
		| {
				resourceId?: string;
				resourceName?: string;
				resourceType?: string;
		  }
		| undefined
	>,
): Record<string, string> {
	if (context.boardId?.trim()) {
		return context;
	}
	const board = Object.values(bindings).find(
		(binding) =>
			binding?.resourceType === "board" && binding.resourceId?.trim(),
	);
	if (!board?.resourceId) {
		return context;
	}
	return {
		...context,
		boardId: board.resourceId,
		boardName: context.boardName?.trim()
			? context.boardName
			: board.resourceName || board.resourceId,
	};
}

/**
 * Context values to start a new report with, copied from a report the
 * project already has. Only fields of a provider that report is bound to are
 * copied, so a value never crosses providers (a Jira "project" is not an
 * Azure DevOps one).
 */
export function pickPrefillContext(
	existingConnections: unknown,
	fields: ContextField[],
): Record<string, string> {
	if (!isRecord(existingConnections)) {
		return {};
	}
	const boundProviders = new Set(
		Object.keys(stringRecord(existingConnections.mcpBindings)),
	);
	const savedContext = stringRecord(existingConnections.context);
	const prefill: Record<string, string> = {};
	for (const field of fields) {
		const saved = savedContext[field.key]?.trim();
		if (saved && boundProviders.has(field.provider)) {
			prefill[field.key] = saved;
		}
	}
	return prefill;
}

/** The account slug a PM container lookup recorded, without a leading slash. */
export function accountSlugFromContext(
	context: Record<string, string>,
): string | null {
	const raw =
		context.account_slug || context.accountSlug || context.slug || "";
	return raw.replace(/^\/+/, "") || null;
}

/** The project-management connection a project saved in its settings. */
export type ProjectPmConnection = {
	projectManagementMcpConfigId?: string | null;
	projectManagementContainerId?: string | null;
	projectManagementContainerName?: string | null;
	projectManagementAdditionalContext?: unknown;
};

/**
 * What a new report of a project starts from: the project's own PM
 * connection bound to every data source of that tool, and the project's
 * board as the report's board. Nothing when the creator cannot use the
 * project's connection (an MCP config belongs to whoever added it), so the
 * person picks one as before.
 */
export function projectConnectionDefaults<
	C extends {
		id: string;
		mcpServer?: { key?: string | null; name?: string | null } | null;
	},
>(
	dataSources: DataSourceDefinition[],
	project: ProjectPmConnection,
	availableConfigs: C[],
	isBoardProvider: (provider: string) => boolean,
): { bindings: Record<string, C>; context: Record<string, string> } {
	const config = availableConfigs.find(
		(candidate) => candidate.id === project.projectManagementMcpConfigId,
	);
	if (!config) {
		return { bindings: {}, context: {} };
	}
	const bindings: Record<string, C> = {};
	for (const ds of dataSources) {
		if (
			ds.type !== "fabric" &&
			findMatchingMcpConfigs([config], ds.provider).length > 0
		) {
			bindings[ds.id] = config;
		}
	}
	const boundBoardSource = dataSources.some(
		(ds) => bindings[ds.id] && isBoardProvider(ds.provider),
	);
	const boardId = project.projectManagementContainerId?.trim();
	if (!boundBoardSource || !boardId) {
		return { bindings, context: {} };
	}
	const context: Record<string, string> = {
		boardId,
		boardName: project.projectManagementContainerName?.trim() || boardId,
	};
	const accountSlug = accountSlugFromContext(
		stringRecord(project.projectManagementAdditionalContext),
	);
	if (accountSlug) {
		context.accountSlug = accountSlug;
	}
	return { bindings, context };
}
