/**
 * The rows the project's Prompt defaults card renders, derived from the
 * catalog read and the actions this organization is offered. Pure, so the
 * grouping, filtering and tier arithmetic can be read apart from the markup.
 */

import {
	PROMPT_FEATURE_TYPE_OPTIONS,
	type PromptAction,
	type PromptFeatureTypeKey,
} from "@repo/utils/prompt-action-catalog";

/** The Prompt defaults card's element id, for in-page links to it. */
export const PROMPT_DEFAULTS_ANCHOR_ID = "project-prompt-defaults";

/** Another control on the page asking the list to show a search. A fresh
 *  `seq` re-applies the same search after the reader has changed it. */
export type PromptDefaultsFocusRequest = { search: string; seq: number };

export type CatalogBinding = {
	promptId: string;
	promptName: string;
	promptVersionId: string;
	scope: "SYSTEM" | "ORG" | "USER";
	projectId: string | null;
	isDefault: boolean;
	isEffective: boolean;
};

export type CatalogEntry = {
	targetKey: string;
	documentType: string;
	storyKind: "FEATURE" | "BUG" | null;
	effectiveScope: "SYSTEM" | "ORG" | "PROJECT" | "USER" | null;
	prompts: CatalogBinding[];
};

/** Where the prompt a row shows comes from. NONE is the built-in text. */
export type PromptTier = "USER" | "PROJECT" | "ORG" | "SYSTEM" | "NONE";

/** Highest precedence first — the order the resolver ranks them in. */
export const TIER_ORDER: readonly PromptTier[] = [
	"USER",
	"PROJECT",
	"ORG",
	"SYSTEM",
	"NONE",
];

export const TIER_LABEL: Record<PromptTier, string> = {
	// The same words PromptDefaultBadge uses. Two names for one tier read as
	// two concepts once you have seen both screens.
	USER: "Personal",
	PROJECT: "Project",
	ORG: "Organization",
	SYSTEM: "System",
	NONE: "Built-in",
};

export type PromptRef = { id: string; name: string };

export type PromptDefaultRowModel = {
	action: PromptAction;
	/** The project's own binding for this action, if it has one. */
	own: CatalogBinding | undefined;
	/** The tier badge: the project's own choice when it has one, even if the
	 *  reader's personal override is what actually runs for them. */
	tier: PromptTier;
	/** The prompt the row names: the project's own, else what runs now. */
	prompt: PromptRef | null;
	/** What runs for the reader right now. */
	runsNow: PromptRef | null;
	/** The project has its own default but the reader's personal one wins. */
	shadowed: boolean;
	/** Whether setting a project default stands the reader's personal one down. */
	clearsOwnPersonal: boolean;
	/** Prompts this project can be pointed at — anything available for the
	 *  action that is not already this project's own binding. */
	candidates: CatalogBinding[];
};

const toRef = (binding: CatalogBinding | undefined): PromptRef | null =>
	binding ? { id: binding.promptId, name: binding.promptName } : null;

/**
 * What this project has chosen is a property of the project, not of whoever is
 * looking. `effectiveScope` answers "what runs for ME", and a personal override
 * outranks the project tier — so keying off it would file an admin's own
 * project default as "Personal" and hide the control to clear it.
 */
export function projectDefaultOf(
	entry: CatalogEntry | undefined,
	projectId: string,
): CatalogBinding | undefined {
	return entry?.prompts.find(
		(p) => p.scope === "ORG" && p.projectId === projectId && p.isDefault,
	);
}

export function buildRow(
	action: PromptAction,
	entry: CatalogEntry | undefined,
	projectId: string,
): PromptDefaultRowModel {
	const own = projectDefaultOf(entry, projectId);
	const inForce = entry?.prompts.find((p) => p.isEffective);
	return {
		action,
		own,
		tier: own ? "PROJECT" : (entry?.effectiveScope ?? "NONE"),
		prompt: toRef(own ?? inForce),
		runsNow: toRef(inForce),
		shadowed: !!own && entry?.effectiveScope === "USER",
		clearsOwnPersonal: entry?.effectiveScope === "USER",
		candidates: (entry?.prompts ?? []).filter(
			(p) => !(p.scope === "ORG" && p.projectId === projectId),
		),
	};
}

export type TierFilter = PromptTier | "ALL";

export function rowMatches(
	row: PromptDefaultRowModel,
	query: string,
	tierFilter: TierFilter,
): boolean {
	if (tierFilter !== "ALL" && row.tier !== tierFilter) {
		return false;
	}
	const q = query.trim().toLowerCase();
	if (!q) {
		return true;
	}
	return [row.action.label, row.prompt?.name ?? "built-in text"].some(
		(text) => text.toLowerCase().includes(q),
	);
}

export function countTiers(
	rows: readonly PromptDefaultRowModel[],
): Record<PromptTier, number> {
	const counts: Record<PromptTier, number> = {
		USER: 0,
		PROJECT: 0,
		ORG: 0,
		SYSTEM: 0,
		NONE: 0,
	};
	for (const row of rows) {
		counts[row.tier] += 1;
	}
	return counts;
}

/** The document half of an action's label, or null for a single-action agent. */
function documentLabelOf(action: PromptAction): string | null {
	const prefix = `${action.agentLabel} — `;
	return action.label.startsWith(prefix)
		? action.label.slice(prefix.length)
		: null;
}

type GroupItem = {
	row: PromptDefaultRowModel;
	title: string;
	subtitle: string | null;
	/** Set on the first visible row of an agent that has several actions in
	 *  this group, so the rows under it can name only the document. */
	agentHeader: string | null;
};

export type PromptDefaultGroup = {
	key: PromptFeatureTypeKey;
	label: string;
	description: string;
	total: number;
	tierCounts: Record<PromptTier, number>;
	items: GroupItem[];
};

/**
 * Rows grouped by product area, in catalog order. Every group keeps its full
 * total and tier counts; `items` holds only the rows that pass `matches`.
 */
export function groupRows(
	rows: readonly PromptDefaultRowModel[],
	matches: (row: PromptDefaultRowModel) => boolean,
): PromptDefaultGroup[] {
	return PROMPT_FEATURE_TYPE_OPTIONS.flatMap((feature) => {
		const all = rows.filter((r) => r.action.featureType === feature.key);
		if (all.length === 0) {
			return [];
		}
		const perAgent = new Map<string, number>();
		for (const r of all) {
			perAgent.set(
				r.action.targetKey,
				(perAgent.get(r.action.targetKey) ?? 0) + 1,
			);
		}
		const visible = all.filter(matches);
		const items = visible.map((row, i): GroupItem => {
			const doc = documentLabelOf(row.action);
			if (doc && (perAgent.get(row.action.targetKey) ?? 0) > 1) {
				const previous = visible[i - 1];
				return {
					row,
					title: doc,
					subtitle: null,
					agentHeader:
						previous?.action.targetKey === row.action.targetKey
							? null
							: row.action.agentLabel,
				};
			}
			return {
				row,
				title: row.action.agentLabel,
				subtitle: doc,
				agentHeader: null,
			};
		});
		return [
			{
				key: feature.key,
				label: feature.label,
				description: feature.description,
				total: all.length,
				tierCounts: countTiers(all),
				items,
			},
		];
	});
}
