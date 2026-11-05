/**
 * The connections a report starts with when it is made without the dialog
 * (Fabric Agent, one-click Generate): the project's project-management tool and
 * board, and its repository, the rule the "Use template" dialog applies in
 * `projectConnectionDefaults`. An MCP config holds its owner's credentials, so
 * another person's is never bound: the project's own config when it is the
 * caller's, else the caller's own config for the same server. A generic data
 * source takes a connection only when its server is a tool of the data type the
 * source asks for.
 */

import { db, getAvailableMcpConfigsForKeys } from "@repo/database";
import {
	genericSourceDataType,
	REPORT_DATA_TYPE_INFO,
	type ReportDataType,
	serverSuppliesDataType,
} from "@repo/database/prisma/queries/lib/report-data-types";
import {
	PROVIDER_CONTEXT_FIELDS,
	type ProjectRepository,
	projectPmContext,
	projectRepositoryContext,
	providerForServerKey,
	serverReadsRepository,
} from "@repo/database/prisma/queries/lib/report-provider-context";
import { isConnectorFreeReportDefinition } from "@repo/database/prisma/queries/lib/report-template-catalog";
import {
	GitLabPmOriginMismatchError,
	resolveProjectPMConfigForUser,
} from "@repo/integrations/gitlab";
import { boardIsListedForConfig } from "./report-board-access";

/** Providers whose reports read one board, chosen in the project's settings. */
const BOARD_PROVIDERS: ReadonlySet<string> = new Set(["fizzy"]);

type BindableDataSource = {
	id: string;
	/** The tool it names; absent on a generic source. */
	provider?: string;
	/** What a generic source asks for. */
	dataType?: ReportDataType;
	required: boolean;
	keys: string[];
};

type ResourceBinding = {
	resourceId: string;
	resourceName: string;
	resourceType: string;
};

type ProjectReportConnections = {
	mcpConfigs: string[];
	mcpBindings: Record<string, string>;
	resourceBindings: Record<string, ResourceBinding>;
	context: Record<string, string>;
};

type ProjectReportBindings = {
	connections: ProjectReportConnections;
	/** The tool each bound data source reads through, by data source id. */
	toolBySource: Record<string, string>;
};

type BindingRequest = {
	projectId: string;
	definition: unknown;
	userId: string;
	organizationId: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

/** The data sources that take a connection, each with the keys that name its server. */
function bindableDataSources(definition: unknown): BindableDataSource[] {
	const sources =
		isRecord(definition) && Array.isArray(definition.dataSources)
			? definition.dataSources.filter(isRecord)
			: [];
	const bindable: BindableDataSource[] = [];
	for (const source of sources) {
		const id = text(source.id);
		if (source.type === "fabric" || !id) {
			continue;
		}
		const required = source.required !== false;
		const dataType = genericSourceDataType(source);
		if (dataType) {
			bindable.push({ id, dataType, required, keys: [] });
			continue;
		}
		const serverKey = isRecord(source.config)
			? text(source.config.mcpServerKey)
			: "";
		const provider = text(source.provider) || serverKey;
		if (!provider) {
			continue;
		}
		bindable.push({
			id,
			provider,
			required,
			keys: [
				...new Set(
					[provider, text(source.key), id, serverKey].filter(Boolean),
				),
			],
		});
	}
	return bindable;
}

function bindSource(
	bindings: ProjectReportBindings,
	source: BindableDataSource,
	configId: string,
	tool: string,
): void {
	const { connections } = bindings;
	if (!connections.mcpConfigs.includes(configId)) {
		connections.mcpConfigs.push(configId);
	}
	connections.mcpBindings[source.id] = configId;
	if (source.provider) {
		connections.mcpBindings[source.provider] = configId;
	}
	bindings.toolBySource[source.id] = tool;
}

/**
 * Binds the sources the project's project-management tool serves, through the
 * caller's own connection to it. A connection other than the one the project
 * pinned may see other boards, so its board and account are kept only once that
 * connection lists the board. A GitLab connection on another instance than the
 * project's container binds nothing: the person connects on the form instead.
 */
async function bindProjectManagement(
	bindings: ProjectReportBindings,
	sources: BindableDataSource[],
	project: {
		projectManagementMcpConfigId: string | null;
		projectManagementMcpServerId: string | null;
		projectManagementContainerId: string | null;
		projectManagementContainerName: string | null;
		projectManagementAdditionalContext: unknown;
	},
	{ userId, organizationId }: BindingRequest,
): Promise<void> {
	if (
		!project.projectManagementMcpConfigId &&
		!project.projectManagementMcpServerId
	) {
		return;
	}
	const config = await resolveProjectPMConfigForUser({
		configId: project.projectManagementMcpConfigId,
		mcpServerId: project.projectManagementMcpServerId,
		userId,
		organizationId,
		pmAdditionalContext: project.projectManagementAdditionalContext,
	}).catch((error: unknown) => {
		if (error instanceof GitLabPmOriginMismatchError) {
			return null;
		}
		throw error;
	});
	if (!config?.enabled) {
		return;
	}
	const groups = await getAvailableMcpConfigsForKeys({
		keys: [...new Set(sources.flatMap((source) => source.keys))],
		userId,
		organizationId,
	});
	const keysWithConfig = new Set(
		groups
			.filter((group) =>
				group.configs.some(({ configId }) => configId === config.id),
			)
			.map((group) => group.key),
	);
	const server = config.mcpServer;
	const bound = sources.filter((source) =>
		source.dataType
			? serverSuppliesDataType(server, source.dataType)
			: source.keys.some((key) => keysWithConfig.has(key)),
	);
	const toolOf = (source: BindableDataSource) =>
		source.provider ?? server.key;
	for (const source of bound) {
		bindSource(bindings, source, config.id, toolOf(source));
	}

	const { connections } = bindings;
	const boardSources = bound.filter((source) =>
		BOARD_PROVIDERS.has(toolOf(source)),
	);
	const boardContext = projectPmContext("fizzy", project);
	const boardId = boardContext.boardId;
	if (
		boardSources.length > 0 &&
		boardId &&
		(config.id === project.projectManagementMcpConfigId ||
			(await boardIsListedForConfig({
				configId: config.id,
				userId,
				organizationId,
				boardId,
				accountSlug: boardContext.accountSlug ?? "",
			})))
	) {
		const binding = {
			resourceId: boardId,
			resourceName: boardContext.boardName,
			resourceType: "board",
		};
		for (const source of boardSources) {
			connections.resourceBindings[source.id] = binding;
			connections.resourceBindings[toolOf(source)] = binding;
		}
		Object.assign(connections.context, boardContext);
	}
	for (const source of bound) {
		const tool = providerForServerKey(toolOf(source)) ?? "";
		if (!BOARD_PROVIDERS.has(tool)) {
			Object.assign(connections.context, projectPmContext(tool, project));
		}
	}
}

/**
 * Binds the repository sources still open to the caller's own connection to the
 * host of the project's repository, and fills that repository's context. A
 * caller without such a connection binds nothing: a project's integration holds
 * the credentials of whoever connected it, and a report never reads through it.
 */
async function bindRepository(
	bindings: ProjectReportBindings,
	sources: BindableDataSource[],
	repository: ProjectRepository | undefined,
	{ userId, organizationId }: BindingRequest,
): Promise<void> {
	if (!repository) {
		return;
	}
	const open = sources.filter(
		(source) =>
			!bindings.connections.mcpBindings[source.id] &&
			(source.dataType === "repository" ||
				(!source.dataType &&
					serverReadsRepository(
						source.provider,
						repository.provider,
					))),
	);
	if (open.length === 0) {
		return;
	}
	const configs = await db.mCPConfig.findMany({
		where: { userId, organizationId, enabled: true },
		orderBy: { updatedAt: "desc" },
		select: { id: true, mcpServer: { select: { key: true } } },
	});
	const config = configs.find(({ mcpServer }) =>
		serverReadsRepository(mcpServer.key, repository.provider),
	);
	if (!config) {
		return;
	}
	for (const source of open) {
		bindSource(
			bindings,
			source,
			config.id,
			source.provider ?? config.mcpServer.key,
		);
	}
	Object.assign(
		bindings.connections.context,
		projectRepositoryContext(repository),
	);
}

/**
 * What a new project report of this template binds, stored as the dialog stores
 * it (by data source id and by provider), with the tool behind each binding.
 * `null` when the template needs no connection or the project gives none the
 * caller can use.
 */
export async function resolveProjectReportBindings(
	request: BindingRequest,
): Promise<ProjectReportBindings | null> {
	if (isConnectorFreeReportDefinition(request.definition)) {
		return null;
	}
	const sources = bindableDataSources(request.definition);
	if (sources.length === 0) {
		return null;
	}
	const project = await db.project.findUnique({
		where: { id: request.projectId },
		select: {
			projectManagementMcpConfigId: true,
			projectManagementMcpServerId: true,
			projectManagementContainerId: true,
			projectManagementContainerName: true,
			projectManagementAdditionalContext: true,
			repositoryIntegrations: {
				where: { status: "ACTIVE" },
				orderBy: { createdAt: "asc" },
				take: 1,
				select: {
					provider: true,
					repositoryOwner: true,
					repositoryName: true,
				},
			},
		},
	});
	if (!project) {
		return null;
	}
	const bindings: ProjectReportBindings = {
		connections: {
			mcpConfigs: [],
			mcpBindings: {},
			resourceBindings: {},
			context: {},
		},
		toolBySource: {},
	};
	await bindProjectManagement(bindings, sources, project, request);
	await bindRepository(
		bindings,
		sources,
		project.repositoryIntegrations?.[0],
		request,
	);
	return bindings.connections.mcpConfigs.length > 0 ? bindings : null;
}

/**
 * The connections alone, for a report the person will finish on its page.
 * `null` when nothing could be bound: the report then starts unconnected.
 */
export async function projectReportConnections(
	request: BindingRequest,
): Promise<ProjectReportConnections | null> {
	return (await resolveProjectReportBindings(request))?.connections ?? null;
}

/** What a data source is called in a sentence asking for it. */
function sourceLabel(source: BindableDataSource): string {
	if (source.dataType) {
		return REPORT_DATA_TYPE_INFO[source.dataType].sourceName;
	}
	return source.provider ?? source.id;
}

/**
 * What stops the planned connections from running this template: each required
 * data source left unbound, and each required context field of a bound tool left
 * empty. Empty when nothing is missing.
 */
export function missingReportSetup(
	definition: unknown,
	bindings: ProjectReportBindings | null,
	context: Record<string, string>,
): string[] {
	const missing: string[] = [];
	const sources = isConnectorFreeReportDefinition(definition)
		? []
		: bindableDataSources(definition);
	for (const source of sources) {
		if (source.required && !bindings?.connections.mcpBindings[source.id]) {
			missing.push(`Connect ${sourceLabel(source)}`);
		}
	}
	const tools = new Set(
		Object.values(bindings?.toolBySource ?? {}).flatMap(
			(tool) => providerForServerKey(tool) ?? [],
		),
	);
	for (const tool of tools) {
		for (const field of PROVIDER_CONTEXT_FIELDS[tool] ?? []) {
			if (field.required && !context[field.key]?.trim()) {
				missing.push(`Fill ${field.label}`);
			}
		}
	}
	return missing;
}
