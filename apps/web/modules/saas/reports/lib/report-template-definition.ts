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
