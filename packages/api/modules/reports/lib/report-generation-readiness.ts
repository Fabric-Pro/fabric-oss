import {
	genericSourceDataType,
	REPORT_DATA_TYPE_INFO,
} from "@repo/database/prisma/queries/lib/report-data-types";
import { getProjectReportSetupReason } from "@repo/database/prisma/queries/lib/report-evidence";

/**
 * Why a report cannot be generated right now, in words for the person who
 * would press Generate, or `null` when nothing stored stands in the way.
 *
 * It reads only what a report and its template store: the project setup
 * reason, whether the report is switched on, each required data source's
 * binding and each required parameter. The report page adds live checks
 * (the connection test and each provider's context fields) on top.
 */

type GenerationReadinessInput = {
	isActive: boolean;
	connections: unknown;
	parameterDefaults: unknown;
	fabricConfig: unknown;
	template: {
		definition: unknown;
		connections: unknown;
		parameters: unknown;
	};
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasText(value: unknown): boolean {
	if (typeof value === "string") {
		return value.trim().length > 0;
	}
	return value !== undefined && value !== null;
}

/**
 * The required data sources a template declares, by binding key: its connection
 * requirements, and each required generic source of its definition, which is
 * bound by its own id whatever tool the person chose.
 */
function requiredSources(
	templateConnections: unknown,
	definition: unknown,
): Array<{ key: string; name: string }> {
	const sources: Array<{ key: string; name: string }> = [];
	const groups = isRecord(templateConnections)
		? [templateConnections.mcpServers, templateConnections.integrations]
		: [];
	for (const group of groups) {
		if (!Array.isArray(group)) {
			continue;
		}
		for (const source of group) {
			if (
				isRecord(source) &&
				typeof source.key === "string" &&
				source.required === true
			) {
				sources.push({
					key: source.key,
					name:
						typeof source.name === "string"
							? source.name
							: source.key,
				});
			}
		}
	}
	const dataSources =
		isRecord(definition) && Array.isArray(definition.dataSources)
			? definition.dataSources.filter(isRecord)
			: [];
	for (const source of dataSources) {
		const dataType = genericSourceDataType(source);
		const { id } = source;
		if (
			dataType &&
			source.required !== false &&
			typeof id === "string" &&
			!sources.some((declared) => declared.key === id)
		) {
			sources.push({
				key: id,
				name: REPORT_DATA_TYPE_INFO[dataType].sourceName,
			});
		}
	}
	return sources;
}

/**
 * Binding keys a report has: each stored key, plus the provider of a data
 * source bound by its id (the create flow keys bindings both ways).
 */
function boundKeys(connections: unknown, definition: unknown): Set<string> {
	const keys = new Set<string>();
	if (!isRecord(connections)) {
		return keys;
	}
	const dataSources =
		isRecord(definition) && Array.isArray(definition.dataSources)
			? definition.dataSources.filter(isRecord)
			: [];
	for (const bindings of [
		connections.mcpBindings,
		connections.integrationBindings,
	]) {
		if (!isRecord(bindings)) {
			continue;
		}
		for (const [key, value] of Object.entries(bindings)) {
			if (!hasText(value)) {
				continue;
			}
			keys.add(key);
			const provider = dataSources.find((ds) => ds.id === key)?.provider;
			if (typeof provider === "string") {
				keys.add(provider);
			}
		}
	}
	return keys;
}

function missingRequiredParameters(
	templateParameters: unknown,
	parameterDefaults: unknown,
): string[] {
	if (!isRecord(templateParameters)) {
		return [];
	}
	const required = Array.isArray(templateParameters.required)
		? templateParameters.required.filter(
				(key): key is string => typeof key === "string",
			)
		: [];
	const properties = isRecord(templateParameters.properties)
		? templateParameters.properties
		: {};
	const values = isRecord(parameterDefaults) ? parameterDefaults : {};
	return required
		.filter((key) => {
			const property = properties[key];
			const schemaDefault = isRecord(property)
				? property.default
				: undefined;
			return !hasText(values[key]) && !hasText(schemaDefault);
		})
		.map((key) => {
			const property = properties[key];
			const title = isRecord(property) ? property.title : undefined;
			return typeof title === "string" && title.trim()
				? title.trim()
				: key;
		});
}

export function reportGenerationBlockedReason(
	instance: GenerationReadinessInput,
): string | null {
	const setupReason = getProjectReportSetupReason(
		instance.fabricConfig,
		instance.template.definition,
		instance.connections,
	);
	if (setupReason) {
		return setupReason;
	}
	if (!instance.isActive) {
		return "Switch this report on to generate it.";
	}
	const bound = boundKeys(instance.connections, instance.template.definition);
	const unbound = requiredSources(
		instance.template.connections,
		instance.template.definition,
	).filter((source) => !bound.has(source.key));
	if (unbound.length > 0) {
		return `Connect ${unbound.map((source) => source.name).join(", ")} to generate this report.`;
	}
	const missing = missingRequiredParameters(
		instance.template.parameters,
		instance.parameterDefaults,
	);
	if (missing.length > 0) {
		return `Fill the required parameter${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}.`;
	}
	return null;
}
