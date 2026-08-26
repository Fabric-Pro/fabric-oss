/**
 * Poll-local normalize step.
 *
 * Maps a fetched `PMWorkItemSummary` + its resolved tool `kind` to a uniform
 * shape the terminal predicate (reconcileAdoStates) consumes. All ADO-specific
 * field-reading is delegated to `extractItemState` (shared, tool-agnostic);
 * GitLab's binary state + labels are read from `raw` (surfaced by the adapter
 * in Task 1). Does NOT touch the shared `fetchPMItemsByIds` hot path.
 */
import {
	extractChangedDate,
	extractItemState,
	type PMWorkItemSummary,
} from "./story-sync";

export interface NormalizedPmState {
	/** Status string for ADO/Fizzy/Jira/GitHub; null for GitLab (no string status). */
	statusString: string | null;
	/** GitLab native close; null for tools without a binary open/closed state. */
	isClosed: boolean | null;
	/** Labels (GitLab and any labelled tool); empty for string-status tools. */
	labels: string[];
	/** Normalized changed-date; null ⇒ poll skips the incremental filter. */
	changedDate: Date | null;
	title: string | null;
	description: string | null;
}

export function normalizePolledState(
	itemSummary: PMWorkItemSummary,
	ctx: { kind: "mcp" | "rest-gitlab"; pmTool?: string },
): NormalizedPmState {
	const raw = (itemSummary.raw ?? {}) as Record<string, unknown>;

	if (ctx.kind === "rest-gitlab") {
		const rawState = raw.state;
		const labels = Array.isArray(raw.labels)
			? (raw.labels as unknown[]).filter(
					(l): l is string => typeof l === "string",
				)
			: [];
		return {
			statusString: null,
			isClosed:
				typeof rawState === "string"
					? rawState.toLowerCase() === "closed"
					: null,
			labels,
			changedDate: extractChangedDate(raw, undefined),
			title: itemSummary.title ?? null,
			description: itemSummary.description ?? null,
		};
	}

	// MCP path (ADO / Fizzy / Jira / GitHub / generic).
	const fields = raw.fields as Record<string, unknown> | undefined;

	// Fizzy: closure is the top-level `closed` boolean (the `status` enum stays
	// "published" when a card is closed), and the kanban column is the meaningful
	// stage. Reading `status` would make a closed card indistinguishable from an
	// open one (#1360). column.name as statusString also lets a project mark a
	// terminal column via pmTerminalStatuses.
	if (ctx.pmTool === "fizzy") {
		const column = raw.column as { name?: string } | undefined;
		const columnName =
			typeof column?.name === "string" && column.name.length > 0
				? column.name
				: undefined;
		return {
			statusString: columnName ?? extractItemState(raw, fields) ?? null,
			isClosed: typeof raw.closed === "boolean" ? raw.closed : null,
			labels: [],
			changedDate: extractChangedDate(raw, fields),
			title: itemSummary.title ?? null,
			description: itemSummary.description ?? null,
		};
	}

	return {
		statusString: extractItemState(raw, fields) ?? null,
		isClosed: null,
		labels: [],
		changedDate: extractChangedDate(raw, fields),
		title: itemSummary.title ?? null,
		description: itemSummary.description ?? null,
	};
}
