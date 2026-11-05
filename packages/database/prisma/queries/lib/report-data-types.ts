/**
 * The kinds of data a generic report template asks for. A template declares
 * `dataType` on a data source and names no provider, and the person says which
 * connected tool supplies it. Pure, so the report pages, the API, the worker
 * and the seed share one answer.
 */

export const REPORT_DATA_TYPES = ["project-management", "repository"] as const;

export type ReportDataType = (typeof REPORT_DATA_TYPES)[number];

export function isReportDataType(value: unknown): value is ReportDataType {
	return REPORT_DATA_TYPES.some((type) => type === value);
}

export const REPORT_DATA_TYPE_INFO: Record<
	ReportDataType,
	{
		label: string;
		/** What the template's connection requirement calls the source. */
		sourceName: string;
		/** What the picker asks. */
		question: string;
		/** The heading the picker groups the matching tools under. */
		category: string;
	}
> = {
	"project-management": {
		label: "Project management",
		sourceName: "Project management tool",
		question: "Which project management system are you using?",
		category: "Project Management",
	},
	repository: {
		label: "Repository",
		sourceName: "Repository",
		question: "Which repository host are you using?",
		category: "Repository",
	},
};

/** The fields of an `MCPServer` that say what kind of data it holds. */
type McpServerKind = {
	category?: string | null;
	tags?: readonly string[] | null;
};

const REPOSITORY_TAGS: ReadonlySet<string> = new Set([
	"git",
	"repositories",
	"repos",
]);

/** Whether a server is a tool of this data type, the rule `listAvailablePmTools` uses for PM. */
export function serverSuppliesDataType(
	server: McpServerKind,
	dataType: ReportDataType,
): boolean {
	const tags = server.tags ?? [];
	switch (dataType) {
		case "project-management":
			return (
				server.category?.trim().toLowerCase() ===
					"project management" || tags.includes("project-management")
			);
		case "repository":
			return tags.some((tag) => REPOSITORY_TAGS.has(tag));
		default: {
			const unreachable: never = dataType;
			return unreachable;
		}
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasText(value: unknown): boolean {
	return typeof value === "string" && value.trim().length > 0;
}

/**
 * The data type of a generic data source: one that declares a type and names
 * no tool. A source naming a provider or a server key reads that tool, whatever
 * else it declares.
 */
export function genericSourceDataType(source: unknown): ReportDataType | null {
	if (!isRecord(source) || !isReportDataType(source.dataType)) {
		return null;
	}
	const serverKey = isRecord(source.config)
		? source.config.mcpServerKey
		: undefined;
	return hasText(source.provider) || hasText(serverKey)
		? null
		: source.dataType;
}
