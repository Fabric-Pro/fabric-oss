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
	/** The item's own URL — REST GitLab only (`PMWorkItemSummary.url`, set from
	 *  the adapter's `externalUrl`); null for every MCP tool (Fizzy #2304 D2.3). */
	itemUrl: string | null;
	/** The ticket's status as the tool shows it, display-only (Fizzy #3088).
	 *  Separate from `statusString`, which feeds the terminal classifier. */
	displayStatus: string | null;
}

function stringLabels(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((l): l is string => typeof l === "string")
		: [];
}

/** GitLab has no status field: a closed issue reads "Closed", an open one its
 *  scoped `workflow::` label (the board column), else "Open" (Fizzy #3088). */
function gitlabDisplayStatus(
	isClosed: boolean | null,
	labels: string[],
): string | null {
	if (isClosed === true) {
		return "Closed";
	}
	const workflow = labels.find((l) =>
		l.toLowerCase().startsWith("workflow::"),
	);
	if (workflow) {
		return workflow;
	}
	return isClosed === false ? "Open" : null;
}

export function normalizePolledState(
	itemSummary: PMWorkItemSummary,
	ctx: { kind: "mcp" | "rest-gitlab"; pmTool?: string },
): NormalizedPmState {
	const raw = (itemSummary.raw ?? {}) as Record<string, unknown>;

	if (ctx.kind === "rest-gitlab") {
		const rawState = raw.state;
		const labels = stringLabels(raw.labels);
		const isClosed =
			typeof rawState === "string"
				? rawState.toLowerCase() === "closed"
				: null;
		return {
			statusString: null,
			isClosed,
			labels,
			changedDate: extractChangedDate(raw, undefined),
			title: itemSummary.title ?? null,
			description: itemSummary.description ?? null,
			itemUrl: itemSummary.url ?? null,
			displayStatus: gitlabDisplayStatus(isClosed, labels),
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
		const isClosed = typeof raw.closed === "boolean" ? raw.closed : null;
		return {
			statusString: columnName ?? extractItemState(raw, fields) ?? null,
			isClosed,
			labels: [],
			changedDate: extractChangedDate(raw, fields),
			title: itemSummary.title ?? null,
			description: itemSummary.description ?? null,
			itemUrl: null,
			// What the Fizzy board shows: Done, Not Now, the column, or the
			// "Maybe?" triage stream for a card with no column. Never the
			// `status` enum ("published").
			displayStatus:
				isClosed === true
					? "Done"
					: raw.postponed === true
						? "Not Now"
						: (columnName ?? "Maybe?"),
		};
	}

	// GitLab through MCP reports the raw `opened` / `closed` state.
	if (ctx.pmTool?.startsWith("gitlab")) {
		const state = extractItemState(raw, fields) ?? null;
		const isClosed =
			typeof raw.state === "string"
				? raw.state.toLowerCase() === "closed"
				: null;
		return {
			statusString: state,
			isClosed: null,
			labels: [],
			changedDate: extractChangedDate(raw, fields),
			title: itemSummary.title ?? null,
			description: itemSummary.description ?? null,
			itemUrl: null,
			displayStatus:
				gitlabDisplayStatus(isClosed, stringLabels(raw.labels)) ??
				state,
		};
	}

	const statusString = extractItemState(raw, fields) ?? null;
	return {
		statusString,
		isClosed: null,
		labels: [],
		changedDate: extractChangedDate(raw, fields),
		title: itemSummary.title ?? null,
		description: itemSummary.description ?? null,
		itemUrl: null,
		displayStatus: statusString,
	};
}
