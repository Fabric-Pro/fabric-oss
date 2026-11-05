/**
 * Which report templates the shared catalog lists. A SYSTEM or public template
 * is listed when it is one of the named standard templates, when a person
 * authored it (a platform admin made or edited it, or it was published), or
 * once a report made from it has completed with records. `isGeneric` records
 * the first two, so every list path reads one column. Seeded templates that
 * are none of these, connector-free content ones included, stay hidden until
 * they have run. Organization and personal templates are always listed to
 * those who may see them. Pure, so the seed and its tests share one answer.
 */

/** The standard template a report written from a prompt alone starts on. */
export const CUSTOM_REPORT_TEMPLATE_NAME = "Custom report";

/** The report templates Fabric ships as its standard set. */
export const STANDARD_REPORT_TEMPLATE_NAMES = [
	"Sprint / Status Report",
	"Burndown / Burnup Chart",
	"Release Notes / Release Summary",
	"Velocity Report",
	"Engineering Metrics Report (DORA-style)",
	"Monthly Business Review",
	"Quarterly Business Review",
	CUSTOM_REPORT_TEMPLATE_NAME,
] as const;

/**
 * Standard templates that organizations without the report suite never had, so
 * their catalog leaves these out. The Quarterly Business Review predates the
 * suite and stays in it.
 */
export const REPORT_SUITE_ONLY_TEMPLATE_NAMES: readonly string[] =
	STANDARD_REPORT_TEMPLATE_NAMES.filter(
		(name) => name !== "Quarterly Business Review",
	);

/**
 * The `isGeneric` the seed writes: whether the catalog lists a seeded template
 * before any report made from it has worked.
 */
export function seededTemplateListedWithoutRuns(
	name: string,
	keptEdited: boolean,
): boolean {
	return (
		keptEdited ||
		STANDARD_REPORT_TEMPLATE_NAMES.some((standard) => standard === name)
	);
}

/** Data sources that read Fabric itself or what a person enters, never an external connector. */
const CONNECTOR_FREE_SOURCE_TYPES = new Set(["fabric", "user-input"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether a completed run gathered anything: one of the data sources it
 * recorded in `dataSources` returned at least one record. A run that found
 * nothing completes with an empty report, which proves nothing about the
 * template's connectors. `reports.ts` applies the same rule in SQL to list
 * the templates whose reports have worked.
 */
export function runGatheredRecords(dataSources: unknown): boolean {
	return (
		Array.isArray(dataSources) &&
		dataSources.some(
			(source) =>
				isRecord(source) &&
				typeof source.recordCount === "number" &&
				source.recordCount > 0,
		)
	);
}

/**
 * Whether a template definition runs without an MCP server or integration:
 * every data source it declares (possibly none) reads Fabric or user input.
 */
export function isConnectorFreeReportDefinition(definition: unknown): boolean {
	const sources =
		isRecord(definition) && Array.isArray(definition.dataSources)
			? definition.dataSources
			: [];
	return sources.every(
		(source) =>
			isRecord(source) &&
			typeof source.type === "string" &&
			CONNECTOR_FREE_SOURCE_TYPES.has(source.type),
	);
}
