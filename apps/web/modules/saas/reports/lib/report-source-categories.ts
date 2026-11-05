import {
	isReportDataType,
	REPORT_DATA_TYPE_INFO,
	type ReportDataType,
} from "@repo/database/prisma/queries/lib/report-data-types";
import {
	findConfigsForSource,
	normalizeKey,
} from "@saas/reports/lib/mcp-utils";

/**
 * The categorical data-source picker: a report's data source needs one kind
 * of data (project management, code, ...), so the picker offers the tools of
 * that category first and keeps every other connected tool one click away.
 * The category comes from `MCPServer.category`; any connection binds, so the
 * all-tools view only widens the choice.
 */

/** The label for connections whose server declares no category. */
export const UNCATEGORIZED_LABEL = "Other tools";

/** One choice in a connection picker. `value` is what the picker reports. */
export type ReportConnectionOption = {
	value: string;
	label: string;
	disabled?: boolean;
	hint?: string;
};

export type ReportConnectionGroups = {
	/** The kind of data the source needs, e.g. "Project Management". */
	category: string | null;
	/** Connections to the data source's own provider. */
	recommended: ReportConnectionOption[];
	/** Other connected tools of the same category. */
	related: ReportConnectionOption[];
	/** Every other connected tool, by category: the all-tools view. */
	others: Array<{ label: string; options: ReportConnectionOption[] }>;
};

/**
 * A category as a person reads it. Categories are free text, and some arrive
 * as keywords ("PRODUCT", "developer_tools"): those are title-cased; a label
 * written in mixed case ("Project Management") is kept as it is.
 */
export function reportCategoryLabel(category: string): string {
	const trimmed = category.trim();
	if (
		trimmed !== trimmed.toUpperCase() &&
		trimmed !== trimmed.toLowerCase()
	) {
		return trimmed;
	}
	return trimmed
		.split(/[\s_-]+/)
		.filter(Boolean)
		.map(
			(word) =>
				word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
		)
		.join(" ");
}

function sameCategory(
	a: string | null | undefined,
	b: string | null | undefined,
) {
	const left = a?.trim().toLowerCase();
	return Boolean(left) && left === b?.trim().toLowerCase();
}

/**
 * The category a data source needs: its data type's for a generic source (pass
 * the data type as `provider`), the one its provider entry declares, else the
 * category of a connected server for that provider.
 */
export function reportSourceCategory(
	provider: string,
	providers: Readonly<Record<string, { category?: string }>>,
	recommendedCategories: ReadonlyArray<string | null | undefined> = [],
): string | null {
	if (isReportDataType(provider)) {
		return REPORT_DATA_TYPE_INFO[provider].category;
	}
	const normalized = normalizeKey(provider);
	const declared = Object.entries(providers).find(
		([key]) => normalizeKey(key) === normalized,
	)?.[1].category;
	return (
		declared?.trim() ||
		recommendedCategories.find((category) => category?.trim())?.trim() ||
		null
	);
}

/**
 * Split the connections that are not the provider's own into the source's
 * category and the all-tools rest, grouped by category (uncategorized last).
 */
export function groupReportConnections<T>(
	recommended: ReportConnectionOption[],
	rest: ReadonlyArray<T>,
	category: string | null,
	describe: (item: T) => {
		option: ReportConnectionOption;
		category: string | null | undefined;
	},
): ReportConnectionGroups {
	const taken = new Set(recommended.map((option) => option.value));
	const related: ReportConnectionOption[] = [];
	const byLabel = new Map<string, ReportConnectionOption[]>();
	for (const item of rest) {
		const { option, category: own } = describe(item);
		if (taken.has(option.value)) {
			continue;
		}
		taken.add(option.value);
		if (sameCategory(own, category)) {
			related.push(option);
			continue;
		}
		const label = own?.trim() || UNCATEGORIZED_LABEL;
		byLabel.set(label, [...(byLabel.get(label) ?? []), option]);
	}
	const others = [...byLabel.entries()]
		.map(([label, options]) => ({ label, options }))
		.sort((a, b) => {
			if (a.label === UNCATEGORIZED_LABEL) {
				return 1;
			}
			if (b.label === UNCATEGORIZED_LABEL) {
				return -1;
			}
			return a.label.localeCompare(b.label);
		});
	return { category, recommended, related, others };
}

/**
 * Whether the picker opens on every tool: when the source has no category to
 * narrow by, nothing in its category is connected, or the saved connection
 * is outside it.
 */
export function startsWithAllTools(
	groups: ReportConnectionGroups,
	value: string | undefined,
): boolean {
	if (groups.others.length === 0) {
		return false;
	}
	if (
		!groups.category ||
		groups.recommended.length + groups.related.length === 0
	) {
		return true;
	}
	return Boolean(
		value &&
			groups.others.some((group) =>
				group.options.some((option) => option.value === value),
			),
	);
}

/** The fields of a registry server that say what it is and how to connect it. */
export type ConnectableServer = {
	id: string;
	key?: string | null;
	name?: string | null;
	category?: string | null;
	tags?: string[] | null;
};

/**
 * The tools of the registry a data source could read through and the person has
 * not connected yet: the source's own provider, or for a generic source the
 * tools of its data type.
 */
export function connectableServersForSource<S extends ConnectableServer>(
	servers: S[],
	source: { provider?: string; dataType?: ReportDataType },
	connected: ReadonlyArray<{ mcpServer?: { key?: string | null } | null }>,
): S[] {
	const connectedKeys = new Set(
		connected.flatMap((config) => config.mcpServer?.key ?? []),
	);
	return findConfigsForSource(
		servers.map((server) => ({ id: server.id, mcpServer: server })),
		source,
	)
		.map((match) => match.mcpServer)
		.filter((server) => !server.key || !connectedKeys.has(server.key));
}
