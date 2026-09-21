/**
 * Resolve a Fabric `ProjectStoryStatus.id` from a polled PM-tool state.
 *
 * Single source of truth for PM-status → Fabric-status resolution, shared by
 * the hourly poll (`reconcile-story-mapped-status`), the per-item Pull paths,
 * and the initial import. Before this module those three each did their own
 * subset of the same three tiers; keeping the union here stops them drifting.
 *
 * Pure — no I/O, no db. Lives in `@repo/integrations/pm` so both `@repo/api`
 * and `@repo/temporal` can import it without reaching across package roots.
 */
import {
	applyLabelStatusMapOnPull,
	type LabelStatusMap,
} from "./label-status-map";

export type StatusResolution =
	| { kind: "none" }
	| {
			kind: "matched";
			statusId: string;
			/** Which tier produced the match — carried into the sync log. */
			via: "label" | "column-map" | "name";
	  }
	| { kind: "conflict"; statusIds: string[]; labels: string[] };

export interface ResolveMappedStatusInput {
	/** Labels from the PM item (GitLab scoped labels; empty for other tools). */
	labels: readonly string[];
	/** Status string (ADO/Jira state, Fizzy column); null for GitLab. */
	statusString: string | null;
	labelStatusMap: LabelStatusMap;
	/** Fabric statusId → PM column id. Read backwards here. */
	statusColumnMap: Record<string, string>;
	projectStatuses: ReadonlyArray<{ id: string; name: string }>;
}

/**
 * Precedence, first match wins: labels → inverted statusColumnMap → name.
 *
 * A `conflict` from the label tier short-circuits: we do NOT fall through to
 * the lower tiers, because an ambiguous label set is a signal to ask the user,
 * not a reason to guess from a different field.
 */
export function resolveMappedStatus(
	input: ResolveMappedStatusInput,
): StatusResolution {
	const validStatusIds = new Set(input.projectStatuses.map((s) => s.id));

	// Tier 1 — labels.
	const pull = applyLabelStatusMapOnPull(
		input.labels,
		input.labelStatusMap,
		validStatusIds,
	);
	if (pull.kind === "matched") {
		return { kind: "matched", statusId: pull.statusId, via: "label" };
	}
	if (pull.kind === "conflict") {
		return {
			kind: "conflict",
			statusIds: pull.matchedStatusIds,
			labels: pull.conflictingLabels,
		};
	}

	const status = input.statusString?.trim() ?? "";
	if (status.length === 0) {
		return { kind: "none" };
	}

	// Tier 2 — statusColumnMap, read backwards (Fabric statusId → PM column id).
	for (const [statusId, columnId] of Object.entries(input.statusColumnMap)) {
		if (columnId === status && validStatusIds.has(statusId)) {
			return { kind: "matched", statusId, via: "column-map" };
		}
	}

	// Tier 3 — case-insensitive name match.
	const wanted = status.toLowerCase();
	const named = input.projectStatuses.find(
		(s) => s.name.toLowerCase().trim() === wanted,
	);
	if (named) {
		return { kind: "matched", statusId: named.id, via: "name" };
	}

	return { kind: "none" };
}
