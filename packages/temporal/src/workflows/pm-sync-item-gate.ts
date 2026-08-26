/**
 * Pure decision helper for whether an applied backlog item should be SKIPPED
 * from PM sync. Extracted from `backlogApplyChangesWorkflow` so the rule is
 * unit-testable without the Temporal test harness. Deterministic / no I/O —
 * safe to call from workflow code.
 */

export type PmSyncItemType = "epic" | "feature" | "story" | "bug";

/**
 * Hierarchical PM tools (Azure DevOps) sync every type (epic → feature →
 * story/bug), so nothing is skipped there.
 *
 * Flat PM tools (Fizzy, GitLab, Linear, ClickUp, Trello, etc.) have no
 * hierarchy — each work item maps to a single card. We sync the leaf work
 * types — `feature`, `story`, `bug` — and skip `epic`, a pure container with
 * no flat-card equivalent.
 *
 * `syncFeaturesToFlatPm` carries the `patched("flat-pm-sync-features")` marker:
 *   - `true`  — current behavior: only `epic` is skipped for flat tools, so
 *     `feature` items now sync as cards (alongside story/bug).
 *   - `false` — legacy behavior preserved verbatim for replay determinism:
 *     skip anything that isn't `story`/`bug` (which also dropped `feature`).
 *     Recorded histories ran this path and issued NO `syncWorkItemToPM` command
 *     for features, so replays must take the same branch.
 *
 * Why this matters: before the DSU 2026-05-23 "story" retirement, `story` was
 * the leaf type and the legacy rule synced it. After retirement, `feature`
 * became the primary leaf type — but the legacy rule still only allowed
 * story/bug, so features were silently never pushed to flat PM tools.
 */
export function shouldSkipFlatPmSync(
	itemType: PmSyncItemType,
	isHierarchicalPM: boolean,
	syncFeaturesToFlatPm: boolean,
): boolean {
	if (isHierarchicalPM) {
		return false;
	}
	if (syncFeaturesToFlatPm) {
		return itemType === "epic";
	}
	return itemType !== "story" && itemType !== "bug";
}
