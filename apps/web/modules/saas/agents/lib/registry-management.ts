export type AgentManagementTab =
	| "all"
	| "system"
	| "personal"
	| "organization"
	| "attention"
	| "search";

export interface AgentManagementItem {
	id: string;
	displayName: string;
	description?: string | null;
	framework?: string | null;
	scope: string;
	status: string;
	conversationCount?: number;
	lastHealthCheck?: string | Date | null;
}

interface AgentManagementCounts {
	all: number;
	system: number;
	personal: number;
	organization: number;
	attention: number;
	search: number;
}

function matchesQuery(item: AgentManagementItem, query: string): boolean {
	if (!query.trim()) {
		return true;
	}

	const haystack = [
		item.displayName,
		item.description ?? "",
		item.framework ?? "",
		item.scope,
		item.status,
	]
		.join(" ")
		.toLowerCase();

	return haystack.includes(query.trim().toLowerCase());
}

function compareRecentUsage(
	a: AgentManagementItem,
	b: AgentManagementItem,
): number {
	const usageDelta = (b.conversationCount ?? 0) - (a.conversationCount ?? 0);
	if (usageDelta !== 0) {
		return usageDelta;
	}

	return a.displayName.localeCompare(b.displayName);
}

export function computeAgentManagementView(
	items: AgentManagementItem[],
	searchQuery: string,
	activeTab: Exclude<AgentManagementTab, "search">,
) {
	const sorted = [...items].sort(compareRecentUsage);
	const searchResults = sorted.filter((item) =>
		matchesQuery(item, searchQuery),
	);

	const counts: AgentManagementCounts = {
		all: sorted.length,
		system: sorted.filter((item) => item.scope === "SYSTEM").length,
		personal: sorted.filter((item) => item.scope === "USER").length,
		organization: sorted.filter((item) => item.scope === "ORGANIZATION")
			.length,
		attention: sorted.filter(
			(item) =>
				item.status !== "ACTIVE" || (item.conversationCount ?? 0) === 0,
		).length,
		search: searchResults.length,
	};

	const byTab: Record<AgentManagementTab, AgentManagementItem[]> = {
		all: sorted,
		system: sorted.filter((item) => item.scope === "SYSTEM"),
		personal: sorted.filter((item) => item.scope === "USER"),
		organization: sorted.filter((item) => item.scope === "ORGANIZATION"),
		attention: sorted.filter(
			(item) =>
				item.status !== "ACTIVE" || (item.conversationCount ?? 0) === 0,
		),
		search: searchResults,
	};

	const resolvedTab: AgentManagementTab = searchQuery.trim()
		? "search"
		: activeTab;

	return {
		counts,
		resolvedTab,
		items: byTab[resolvedTab],
	};
}
