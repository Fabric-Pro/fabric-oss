/**
 * Label ↔ status mapping helpers for project-management integrations.
 *
 * GitLab encodes status via scoped labels (e.g. `workflow::in-review`). The
 * per-project map in `Project.projectManagementAdditionalContext.labelStatusMap`
 * records which labels correspond to which `ProjectStoryStatus.id`.
 *
 * Lives in `@repo/integrations/pm` so it can be imported from both
 * `@repo/api` (the import procedure) and `@repo/temporal` (the push activity)
 * without a relative `..` reach across package boundaries.
 */

export type LabelStatusMap = Record<string, string>;

/**
 * Safely reads labelStatusMap from the generic additionalContext JSON field.
 * Returns an empty map if the shape is missing or invalid.
 */
export function readLabelStatusMap(additionalContext: unknown): LabelStatusMap {
	if (!additionalContext || typeof additionalContext !== "object") {
		return {};
	}
	const record = additionalContext as Record<string, unknown>;
	const map = record.labelStatusMap;
	if (!map || typeof map !== "object" || Array.isArray(map)) {
		return {};
	}
	const result: LabelStatusMap = {};
	for (const [k, v] of Object.entries(map as Record<string, unknown>)) {
		if (
			typeof k === "string" &&
			typeof v === "string" &&
			k.length > 0 &&
			v.length > 0
		) {
			result[k] = v;
		}
	}
	return result;
}

/**
 * Result of resolving a status from incoming labels on pull.
 *
 * - `none` — no mapped label matched a valid status; no derived status.
 * - `matched` — exactly one status was unambiguously derived; the matched
 *   label is stripped from `remainingLabels`.
 * - `conflict` — two or more labels mapped to *different* statuses. Caller
 *   should surface this so the user can disambiguate; we deliberately do
 *   NOT pick a winner because GitLab's label order isn't a stable contract.
 */
export type PullResult =
	| { kind: "none"; remainingLabels: string[] }
	| { kind: "matched"; statusId: string; remainingLabels: string[] }
	| {
			kind: "conflict";
			matchedStatusIds: string[];
			conflictingLabels: string[];
			remainingLabels: string[];
	  };

/**
 * Resolve a status from incoming labels.
 *
 * Walks `labels` once, collecting every label whose mapping points to a
 * status in `validStatusIds`. Returns the unambiguous match, or a conflict
 * record when multiple distinct statuses are referenced.
 */
export function applyLabelStatusMapOnPull(
	labels: readonly string[],
	map: LabelStatusMap,
	validStatusIds: ReadonlySet<string>,
): PullResult {
	const matches: Array<{ index: number; label: string; statusId: string }> =
		[];
	for (let i = 0; i < labels.length; i++) {
		const label = labels[i];
		const candidate = map[label];
		if (candidate && validStatusIds.has(candidate)) {
			matches.push({ index: i, label, statusId: candidate });
		}
	}

	if (matches.length === 0) {
		return { kind: "none", remainingLabels: [...labels] };
	}

	const distinct = new Set(matches.map((m) => m.statusId));
	if (distinct.size === 1) {
		const single = matches[0];
		const remaining = labels
			.slice(0, single.index)
			.concat(labels.slice(single.index + 1));
		return {
			kind: "matched",
			statusId: single.statusId,
			remainingLabels: [...remaining],
		};
	}

	return {
		kind: "conflict",
		matchedStatusIds: Array.from(distinct),
		conflictingLabels: matches.map((m) => m.label),
		remainingLabels: [...labels],
	};
}

export interface LabelDelta {
	addLabels: string[];
	removeLabels: string[];
}

/**
 * Compute the label delta to send on a push so a story's status transition
 * round-trips cleanly with the remote tracker.
 *
 * - `addLabels` — every label mapped to `newStatusId` that isn't already
 *   on the issue. (Idempotent re-pushes produce empty `addLabels`.)
 * - `removeLabels` — every label mapped to `prevStatusId` only when the
 *   status actually changed. We never remove labels that are also mapped
 *   to `newStatusId` (covers the "two synonyms for the same status" case).
 *
 * Use with the GitLab API's `add_labels` / `remove_labels` parameters
 * rather than `labels` (which would replace the full set and clobber
 * user-added labels on the remote side).
 */
export function computeLabelDeltaOnPush(
	prevStatusId: string | null,
	newStatusId: string,
	existingLabels: readonly string[],
	map: LabelStatusMap,
): LabelDelta {
	const newStatusLabels = new Set<string>();
	for (const [label, statusId] of Object.entries(map)) {
		if (statusId === newStatusId) {
			newStatusLabels.add(label);
		}
	}

	const existing = new Set(existingLabels);
	const addLabels = Array.from(newStatusLabels).filter(
		(label) => !existing.has(label),
	);

	let removeLabels: string[] = [];
	if (prevStatusId && prevStatusId !== newStatusId) {
		// A label maps to exactly one statusId in the LabelStatusMap shape,
		// so a "remove" candidate can never also be a "keep for new status"
		// candidate. Just filter by prevStatusId.
		removeLabels = Object.entries(map)
			.filter(([, statusId]) => statusId === prevStatusId)
			.map(([label]) => label);
	}

	return { addLabels, removeLabels };
}
