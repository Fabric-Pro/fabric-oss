import {
	genericSourceDataType,
	REPORT_DATA_TYPE_INFO,
} from "@repo/database/prisma/queries/lib/report-data-types";
import {
	type ProjectPmContainer,
	type ProjectRepository,
	projectPmContext,
	projectRepositoryContext,
	providerForServerKey,
	serverReadsRepository,
} from "@repo/database/prisma/queries/lib/report-provider-context";
import { findConfigsForSource } from "@saas/reports/lib/mcp-utils";
import {
	DATA_SOURCE_PROVIDERS,
	type DataSourceDefinition,
} from "@saas/shared/components/DataSourceDefinitionBuilder";
import type { ProviderContextField } from "@saas/shared/components/provider-context-fields";

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

/** The tool a stored data source names, by its provider or its server key. */
function sourceProviderName(source: Record<string, unknown>): string {
	if (typeof source.provider === "string" && source.provider) {
		return source.provider;
	}
	const serverKey = isRecord(source.config)
		? source.config.mcpServerKey
		: undefined;
	return typeof serverKey === "string" ? serverKey : "";
}

export type ParsedTemplateDefinition = {
	/**
	 * Data sources that name a provider or a server key (read as the provider),
	 * and generic ones that declare a data type. The others need no connection.
	 */
	dataSources: DataSourceDefinition[];
	userPrompt?: string;
};

/**
 * Reads a stored template definition. Without the report suite (`reportSuite:
 * false`) only a source naming a `provider` asks for a connection, as it always
 * has: a server key or a data type alone must not add a required picker that
 * blocks Create for someone who has no such connection.
 */
export function parseTemplateDefinition(
	definition: unknown,
	{ reportSuite = true }: { reportSuite?: boolean } = {},
): ParsedTemplateDefinition {
	if (!isRecord(definition)) {
		return { dataSources: [] };
	}
	const rawSources = Array.isArray(definition.dataSources)
		? definition.dataSources
		: [];
	const dataSources: DataSourceDefinition[] = [];
	for (const source of rawSources) {
		if (!isRecord(source) || typeof source.id !== "string") {
			continue;
		}
		const provider = sourceProviderName(source);
		const dataType = genericSourceDataType(source);
		const asksForConnection = reportSuite
			? provider || dataType
			: typeof source.provider === "string" && source.provider;
		if (!asksForConnection) {
			continue;
		}
		dataSources.push({
			id: source.id,
			// Setup reads only the provider; an older template may omit the type.
			type: isDataSourceType(source.type) ? source.type : "mcp",
			...(provider ? { provider } : {}),
			...(dataType ? { dataType } : {}),
			operation:
				typeof source.operation === "string"
					? source.operation
					: undefined,
			...(source.required === false ? { required: false } : {}),
		});
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

/** Providers that seeded templates use but the source picker does not offer. */
const INTEGRATION_PROVIDER_LABELS: Record<string, string> = {
	microsoft_graph: "Microsoft Teams / Graph",
	slack: "Slack",
	github: "GitHub",
	linear: "Linear",
	jira: "Jira",
};

/**
 * A data source provider's display name: the registry label for a known
 * provider key ("azure_devops" → "Azure DevOps"), otherwise the name as
 * given, so a template's own wording is kept.
 */
export function reportProviderLabel(nameOrKey: string): string {
	return (
		DATA_SOURCE_PROVIDERS[nameOrKey]?.label ||
		INTEGRATION_PROVIDER_LABELS[nameOrKey] ||
		nameOrKey
	);
}

/**
 * The name a report shows for one of its template's data sources: the
 * provider's label ("Fizzy"), plus the tool for a source pinned to one.
 * The source id is generated and never shown.
 */
export function reportDataSourceLabel(source: {
	id: string;
	type?: string;
	provider?: string;
	dataType?: unknown;
	config?: Record<string, unknown>;
}): string {
	const dataType = genericSourceDataType(source);
	if (dataType) {
		return REPORT_DATA_TYPE_INFO[dataType].label;
	}
	const toolName = source.config?.toolName;
	const serverKey = source.config?.mcpServerKey;
	const providerKey =
		source.provider || (typeof serverKey === "string" ? serverKey : "");
	const label = reportProviderLabel(providerKey);
	if (typeof toolName === "string" && toolName) {
		return `${label || "MCP"} → ${toolName}`;
	}
	if (!label) {
		return source.type === "mcp" ? "MCP server" : "Data source";
	}
	return source.type === "integration" ? `${label} API` : label;
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

export { providerForServerKey };

/**
 * The provider a data source's context fields and board picker follow: its own,
 * or for a generic source the server bound to it (none until one is bound).
 */
export function sourceProviderKey(
	source: { provider?: string },
	boundConfig?: { mcpServer?: { key?: string | null } | null } | null,
): string | null {
	return source.provider || providerForServerKey(boundConfig?.mcpServer?.key);
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
 * a board. The account goes with it: the board came from someone else's account
 * or an earlier report, and the slug that names it would read the wrong account.
 * `detectedSlug` is the account the list came from, when it told us. An empty
 * list (not loaded, or none returned) keeps the context.
 */
export function contextWithListedBoard(
	context: Record<string, string>,
	boards: ReadonlyArray<{ id: string }>,
	detectedSlug?: string | null,
): Record<string, string> {
	const boardId = context.boardId?.trim();
	if (!boardId || boards.length === 0) {
		return context;
	}
	if (boards.some((board) => board.id === boardId)) {
		return context;
	}
	const {
		boardId: _boardId,
		boardName: _boardName,
		accountSlug: _accountSlug,
		...rest
	} = context;
	return detectedSlug ? { ...rest, accountSlug: detectedSlug } : rest;
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
 * Azure DevOps one). A generic source's binding names the data source rather
 * than the tool, so the configs say which tool it is.
 */
export function pickPrefillContext(
	existingConnections: unknown,
	fields: ContextField[],
	configs: ReadonlyArray<{
		id: string;
		mcpServer?: { key?: string | null } | null;
	}> = [],
): Record<string, string> {
	if (!isRecord(existingConnections)) {
		return {};
	}
	const mcpBindings = stringRecord(existingConnections.mcpBindings);
	const boundProviders = new Set(Object.keys(mcpBindings));
	for (const configId of Object.values(mcpBindings)) {
		const provider = providerForServerKey(
			configs.find((config) => config.id === configId)?.mcpServer?.key,
		);
		if (provider) {
			boundProviders.add(provider);
		}
	}
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

/** The connections a project saved: its project-management tool and repositories. */
export type ProjectPmConnection = ProjectPmContainer & {
	projectManagementMcpConfigId?: string | null;
	projectManagementMcpServerId?: string | null;
	repositoryIntegrations?: ReadonlyArray<
		ProjectRepository & { status: string }
	>;
};

/**
 * The creator's connection to the project's project-management tool: the one
 * the project pinned when it is theirs, else their own for the same server. The
 * list holds only the creator's configs, and a config holds its owner's
 * credentials, so another person's is never bound.
 */
export function ownProjectPmConfig<
	C extends {
		id: string;
		mcpServerId?: string | null;
		enabled?: boolean;
	},
>(project: ProjectPmConnection, availableConfigs: C[]): C | undefined {
	const usable = availableConfigs.filter(
		(config) => config.enabled !== false,
	);
	return (
		usable.find(
			(config) => config.id === project.projectManagementMcpConfigId,
		) ??
		(project.projectManagementMcpServerId
			? usable.find(
					(config) =>
						config.mcpServerId ===
						project.projectManagementMcpServerId,
				)
			: undefined)
	);
}

/**
 * What a new report of a project starts from: the creator's connection to the
 * project's tool bound to every data source of that tool, with the project's
 * board or project as the report's; and their connection to the host of the
 * project's first active repository bound to its repository sources, with that
 * repository as the context. Nothing when the creator has no such connection,
 * so the person picks one as before.
 */
export function projectConnectionDefaults<
	C extends {
		id: string;
		mcpServerId?: string | null;
		enabled?: boolean;
		mcpServer?: {
			key?: string | null;
			name?: string | null;
			category?: string | null;
			tags?: string[] | null;
		} | null;
	},
>(
	dataSources: DataSourceDefinition[],
	project: ProjectPmConnection,
	availableConfigs: C[],
	isBoardProvider: (provider: string) => boolean,
): { bindings: Record<string, C>; context: Record<string, string> } {
	const bindings: Record<string, C> = {};
	const context: Record<string, string> = {};
	const config = ownProjectPmConfig(project, availableConfigs);
	if (config) {
		for (const ds of dataSources) {
			if (
				ds.type === "fabric" ||
				findConfigsForSource([config], ds).length === 0
			) {
				continue;
			}
			bindings[ds.id] = config;
			const provider = sourceProviderKey(ds, config) ?? "";
			const answers = projectPmContext(provider, project);
			if (!answers.boardId || isBoardProvider(provider)) {
				Object.assign(context, answers);
			}
		}
	}

	const repository = project.repositoryIntegrations?.find(
		(integration) => integration.status === "ACTIVE",
	);
	if (repository) {
		const repositoryConfig = availableConfigs.find(
			(candidate) =>
				candidate.enabled !== false &&
				serverReadsRepository(
					candidate.mcpServer?.key,
					repository.provider,
				),
		);
		const open = dataSources.filter(
			(ds) =>
				ds.type !== "fabric" &&
				!bindings[ds.id] &&
				(ds.dataType === "repository" ||
					(!ds.dataType &&
						serverReadsRepository(
							ds.provider,
							repository.provider,
						))),
		);
		if (repositoryConfig && open.length > 0) {
			for (const ds of open) {
				bindings[ds.id] = repositoryConfig;
			}
			Object.assign(context, projectRepositoryContext(repository));
		}
	}
	return { bindings, context };
}

/**
 * The required data sources still without a connection: what generating waits
 * for, in the words the footer asks with.
 */
export function unboundRequiredSources(
	dataSources: DataSourceDefinition[],
	bindings: Record<string, { mcpConfigId: string } | undefined>,
): string[] {
	return dataSources
		.filter(
			(ds) =>
				ds.type !== "fabric" &&
				isRequiredDataSource(ds) &&
				!bindings[ds.id]?.mcpConfigId,
		)
		.map((ds) =>
			ds.dataType
				? REPORT_DATA_TYPE_INFO[ds.dataType].sourceName
				: reportDataSourceLabel(ds),
		);
}
