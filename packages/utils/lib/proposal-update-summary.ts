/**
 * What a proposed update to an existing ticket changes, read from its own
 * before/after values rather than from anything the model wrote about it.
 *
 * The Proposal Inbox shows this list at the top of every update item, and the
 * apply step writes the same list into the target ticket's Decision Log, so a
 * reviewer and a later reader see one account of the change. The review
 * dialog's line-by-line mode splits description and acceptance-criteria bodies
 * into the same hunks and rebuilds the text from the hunks it kept. The
 * summary compares list lines by nesting depth rather than by their
 * indentation, which the ticket editor rewrites in its own way, and the
 * editor's review diff reads list depth the same way (`listDepthLines`).
 *
 * Lives in `@repo/utils` behind its own subpath: the web client and the
 * Temporal apply activity both import it, and it must not pull the barrel's
 * Node built-ins into the browser bundle.
 */
import { diffArrays } from "diff";
import { cutAtCodeUnits } from "./cut-at-code-units";
import type { FenceRole } from "./glossy/outline";

type ProposalDiffValue = { from?: string | null; to?: string | null };

/** The diffable fields of one proposed change. */
export type ProposalUpdateFields = {
	title?: ProposalDiffValue | null;
	description?: ProposalDiffValue | null;
	acceptanceCriteria?: ProposalDiffValue | null;
	priority?: ProposalDiffValue | null;
	size?: ProposalDiffValue | null;
};

type ProposalUpdateField = keyof ProposalUpdateFields;

type ProposalUpdateSummaryLine = {
	field: ProposalUpdateField;
	label: string;
	/** One short sentence: the rename, the value move, or a changed line. */
	explanation: string;
	/**
	 * What a body field adds: non-blank description lines, or acceptance
	 * criteria (see `countCriteria`). 0 for the other fields.
	 */
	added: number;
	/** What a body field removes, counted the same way. */
	removed: number;
};

/** Longest changed line quoted in an explanation. */
const EXPLANATION_MAX_CHARS = 120;

/** Longest proposal summary or reasoning carried into a note. */
const NOTE_TEXT_MAX_CHARS = 500;

const FIELD_LABELS: Record<ProposalUpdateField, string> = {
	title: "Title",
	description: "Description",
	acceptanceCriteria: "Acceptance criteria",
	priority: "Priority",
	size: "Size",
};

/**
 * A run of lines both sides share, or one changed region: the lines it
 * removes and the lines it adds (either may be empty). `id` numbers the
 * changed regions from 0.
 */
export type LineHunk =
	| { kind: "same"; lines: string[] }
	| { kind: "change"; id: number; removed: string[]; added: string[] };

type ChangeHunk = Extract<LineHunk, { kind: "change" }>;

/**
 * Split two texts into shared runs and changed regions, line by line.
 *
 * Lines are compared as whole strings after a plain `split("\n")`, not with
 * `diffLines`, which keeps each line's newline on the part that owns it and so
 * splits a final line without one into a separate change. Joining every
 * hunk's kept side with "\n" therefore rebuilds either text exactly.
 */
export function buildLineHunks(from: string, to: string): LineHunk[] {
	if (from === to) {
		return from.length > 0
			? [{ kind: "same", lines: from.split("\n") }]
			: [];
	}
	const hunks: LineHunk[] = [];
	let open: ChangeHunk | null = null;
	let nextId = 0;
	for (const part of diffArrays(from.split("\n"), to.split("\n"))) {
		if (!part.added && !part.removed) {
			open = null;
			hunks.push({ kind: "same", lines: part.value });
			continue;
		}
		if (!open) {
			open = { kind: "change", id: nextId++, removed: [], added: [] };
			hunks.push(open);
		}
		if (part.added) {
			open.added.push(...part.value);
		} else {
			open.removed.push(...part.value);
		}
	}
	return hunks;
}

/** The changed regions of two texts, in order. */
export function changedLineHunks(from: string, to: string): ChangeHunk[] {
	return buildLineHunks(from, to).filter(
		(hunk): hunk is ChangeHunk => hunk.kind === "change",
	);
}

/** Whitespace collapsed to single spaces, cut to `max` with an ellipsis. */
function shorten(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max
		? flat
		: `${cutAtCodeUnits(flat, max - 1).trimEnd()}…`;
}

const LIST_MARKER = /^(?:[-*+]|\d{1,3}[.)])\s+(?:\[[ xX]\]\s+)?/;
const HEADING_MARKER = /^#{1,6}\s+/;
/** Bold and code marks, which read as noise in a plain-text quote. */
const INLINE_MARKS = /\*\*|`/g;

/**
 * A changed body line as a short plain-text quote: no list or heading mark,
 * no bold or code marks.
 */
function quoteBodyLine(line: string): string {
	const unheaded = line.trim().replace(HEADING_MARKER, "");
	const plain = unheaded.replace(LIST_MARKER, "").replace(INLINE_MARKS, "");
	return shorten(plain, EXPLANATION_MAX_CHARS);
}

function plural(count: number, one: string, many: string): string {
	return `${count} ${count === 1 ? one : many}`;
}

/** "2 criteria added, 1 removed", "1 line removed", or "" for none. */
export function describeLineCounts(
	field: ProposalUpdateField,
	added: number,
	removed: number,
): string {
	const [one, many] =
		field === "acceptanceCriteria"
			? ["criterion", "criteria"]
			: ["line", "lines"];
	if (added > 0 && removed > 0) {
		return `${plural(added, one, many)} added, ${removed} removed`;
	}
	if (added > 0) {
		return `${plural(added, one, many)} added`;
	}
	if (removed > 0) {
		return `${plural(removed, one, many)} removed`;
	}
	return "";
}

/** A line that starts a criterion: `1.`, `1)`, `-`, `*`, or a Given clause. */
const CRITERION_START = /^(?:(?:\d{1,3}[.)]|[-*])\s|given\b)/i;

/**
 * How many acceptance criteria some lines hold. A criterion starts at a
 * numbered item, a bullet or a Given clause, and the lines after it (its
 * When / Then / And steps) belong to it. Lines with no criterion start at
 * all count one each.
 */
function countCriteria(lines: readonly string[]): number {
	const nonBlank = lines.filter((line) => line.trim().length > 0);
	const starts = nonBlank.filter((line) =>
		CRITERION_START.test(line.trim()),
	).length;
	return starts > 0 ? starts : nonBlank.length;
}

function countNonBlankLines(lines: readonly string[]): number {
	return lines.filter((line) => line.trim().length > 0).length;
}

/** A list item: its indentation, then its marker and the spaces after it. */
const LIST_ITEM = /^[ \t]*((?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$))/;
/** The line that opens a fenced code block, and its fence. */
const FENCE_OPEN = /^[ \t]*(`{3,}|~{3,})/;
/** Indentation past an item's text that makes its line a code block. */
const CODE_INDENT = 4;

/** Leading whitespace as columns, a tab to the next multiple of 4. */
function indentColumns(whitespace: string): number {
	let columns = 0;
	for (const char of whitespace) {
		columns = char === "\t" ? columns + 4 - (columns % 4) : columns + 1;
	}
	return columns;
}

/** A fence of the same character, at least as long as the opening one. */
function closesFence(line: string, fence: string): boolean {
	const trimmed = line.trim();
	return trimmed.startsWith(fence) && /^(?:`+|~+)$/.test(trimmed);
}

/**
 * Each line's place in a fenced code block, by the rule `listDepthLines`
 * reads list nesting with: a fence opens on 3+ backticks or tildes at any
 * indentation, as it may inside a list item, and closes on a line of the
 * same character at least as long. An unclosed fence runs to the last line.
 */
export function listFenceRoles(lines: readonly string[]): FenceRole[] {
	const roles: FenceRole[] = [];
	let fence: string | null = null;
	for (const line of lines) {
		if (fence !== null) {
			const closes = closesFence(line, fence);
			roles.push(closes ? "close" : "inside");
			fence = closes ? null : fence;
			continue;
		}
		const opened = FENCE_OPEN.exec(line)?.[1];
		roles.push(opened ? "open" : null);
		fence = opened ?? null;
	}
	return roles;
}

/** One body line, read for its list nesting (see `listDepthLines`). */
type ListDepthLine = { depth: number; text: string };

/**
 * Each body line with its list nesting depth: how many list items enclose
 * it (an item's own line is not inside itself, its continuation lines are).
 * A line in a list has its indentation replaced by that depth. The ticket
 * editor writes a nested list with its own indentation, so a line it only
 * re-indented reads the same, while a line moved to another level does not.
 * A fenced block is kept exactly, at the depth of the items it sits in, so
 * its code moves with its item. Indented code outside a list and trailing
 * spaces (a hard break) are kept exactly, at depth 0.
 */
export function listDepthLines(text: string): ListDepthLine[] {
	// The text column of each open list item, outermost first.
	const open: number[] = [];
	let fenceDepth = 0;
	const lines: ListDepthLine[] = [];
	const kept = (line: string) => {
		lines.push({ depth: 0, text: line });
	};
	const textLines = text.split("\n");
	const fences = listFenceRoles(textLines);
	for (const [index, line] of textLines.entries()) {
		if (fences[index] === "open") {
			const indent = indentColumns(line.slice(0, line.search(/\S/)));
			fenceDepth = open.filter((column) => column <= indent).length;
		}
		if (fences[index] !== null) {
			lines.push({ depth: fenceDepth, text: line });
			continue;
		}
		const content = line.trimStart();
		if (content.length === 0) {
			kept("");
			continue;
		}
		const whitespace = line.slice(0, line.length - content.length);
		const indent = indentColumns(whitespace);
		// Close the items this line is not inside.
		while (open.length > 0 && indent < (open[open.length - 1] ?? 0)) {
			open.pop();
		}
		const parent = open[open.length - 1];
		// Past the code indent, the line is a code block whose indentation
		// is its content, even when it starts like a list item.
		const past = indent - (parent ?? 0);
		const item = past < CODE_INDENT ? LIST_ITEM.exec(line) : null;
		const depth = open.length;
		if (item?.[1]) {
			lines.push({ depth, text: "\t".repeat(depth) + content });
			open.push(indent + item[1].length);
			continue;
		}
		if (parent === undefined) {
			kept(line);
			continue;
		}
		const code = past >= CODE_INDENT ? " ".repeat(past) : "";
		lines.push({ depth, text: "\t".repeat(depth) + code + content });
	}
	return lines;
}

function withListDepth(text: string): string {
	const lines = listDepthLines(text).map((line) => line.text);
	return lines.join("\n");
}

function summarizeBody(
	field: "description" | "acceptanceCriteria",
	from: string,
	to: string,
): ProposalUpdateSummaryLine {
	const count =
		field === "acceptanceCriteria" ? countCriteria : countNonBlankLines;
	const addedLines: string[] = [];
	const removedLines: string[] = [];
	let added = 0;
	let removed = 0;
	// Counted per changed region, so a criterion's continuation edited in
	// one region is not lost among another region's criteria.
	const hunks = changedLineHunks(withListDepth(from), withListDepth(to));
	for (const hunk of hunks) {
		addedLines.push(...hunk.added.filter((l) => l.trim().length > 0));
		removedLines.push(...hunk.removed.filter((l) => l.trim().length > 0));
		added += count(hunk.added);
		removed += count(hunk.removed);
	}
	const firstAdded = addedLines[0];
	const firstRemoved = removedLines[0];
	const explanation =
		firstAdded !== undefined
			? `Adds “${quoteBodyLine(firstAdded)}”`
			: firstRemoved !== undefined
				? `Removes “${quoteBodyLine(firstRemoved)}”`
				: "Formatting changes only";
	return {
		field,
		label: FIELD_LABELS[field],
		explanation,
		added,
		removed,
	};
}

function summarizeScalar(
	field: "title" | "priority" | "size",
	from: string,
	to: string,
): ProposalUpdateSummaryLine {
	const before = shorten(from, EXPLANATION_MAX_CHARS);
	const after = shorten(to, EXPLANATION_MAX_CHARS);
	let explanation: string;
	if (field === "title") {
		explanation = `Renamed “${before}” → “${after}”`;
	} else {
		explanation = before ? `${before} → ${after}` : `Set to ${after}`;
	}
	return {
		field,
		label: FIELD_LABELS[field],
		explanation,
		added: 0,
		removed: 0,
	};
}

/**
 * One line per field the change actually moves (its `to` differs from its
 * `from`), in a fixed order: title, description, acceptance criteria,
 * priority, size. Deterministic; no model call. A title, priority or size
 * with an empty `to` is not a change (apply never clears them), and neither
 * is a title without a `from`: an update carries its target's title as is
 * when it does not rename it.
 */
export function summarizeProposalUpdate(
	change: ProposalUpdateFields,
): ProposalUpdateSummaryLine[] {
	const lines: ProposalUpdateSummaryLine[] = [];
	const title = change.title;
	if (title?.to && title.from && title.to !== title.from) {
		lines.push(summarizeScalar("title", title.from, title.to));
	}
	for (const field of ["description", "acceptanceCriteria"] as const) {
		const value = change[field];
		const from = value?.from ?? "";
		const to = value?.to ?? "";
		if (value && from !== to) {
			lines.push(summarizeBody(field, from, to));
		}
	}
	for (const field of ["priority", "size"] as const) {
		const value = change[field];
		if (value?.to && value.to !== value.from) {
			lines.push(summarizeScalar(field, value.from ?? "", value.to));
		}
	}
	return lines;
}

/** One summary line as plain text, for a log entry. */
function formatProposalUpdateSummaryLine(
	line: ProposalUpdateSummaryLine,
): string {
	const counts = describeLineCounts(line.field, line.added, line.removed);
	return counts
		? `${line.label}: ${counts}. ${line.explanation}`
		: `${line.label}: ${line.explanation}`;
}

const PROPOSAL_SOURCE_LABELS: Record<string, string> = {
	TEAMS_CHANNEL: "a Teams channel",
	TEAMS_CHAT: "a Teams chat",
	SLACK_CHANNEL: "a Slack channel",
	AI_UPDATE_SIDEBAR: "an AI Update",
	MONITORED_MEETING: "a meeting",
	SCOPE_DOCUMENT: "a scope document",
	ROADMAP_RECOMMENDATION: "a Roadmap recommendation",
	LOG_MONITOR: "application logs",
	INCIDENT_CLUSTER: "a group of bug reports",
};

type ProposalNoteContext = {
	/** The item's own reasoning. */
	reasoning?: string | null;
	/** `PendingBacklogProposal.source`, when known. */
	source?: string | null;
	/** `PendingBacklogProposal.summary`, when known. */
	proposalSummary?: string | null;
};

/**
 * Why the update was proposed, one line each. The Decision Log renders a note
 * as one bullet per line, so every line is flattened to a single line.
 */
function promptLines(context: ProposalNoteContext): string[] {
	const lines: string[] = [];
	const reasoning = shorten(context.reasoning ?? "", NOTE_TEXT_MAX_CHARS);
	if (reasoning) {
		lines.push(`Why: ${reasoning}`);
	}
	const sourceLabel = context.source
		? (PROPOSAL_SOURCE_LABELS[context.source] ?? null)
		: null;
	const summary = shorten(context.proposalSummary ?? "", NOTE_TEXT_MAX_CHARS);
	if (sourceLabel && summary) {
		lines.push(`Prompted by ${sourceLabel}: ${summary}`);
	} else if (sourceLabel) {
		lines.push(`Prompted by ${sourceLabel}.`);
	} else if (summary) {
		lines.push(`Prompted by: ${summary}`);
	}
	return lines;
}

/**
 * The Decision Log note for an applied update: a heading line, one line per
 * applied change, then what prompted it. Empty when nothing moved.
 */
export function proposalUpdateAppliedNoteLines(
	applied: ProposalUpdateFields,
	context: ProposalNoteContext,
): string[] {
	const changes = summarizeProposalUpdate(applied);
	if (changes.length === 0) {
		return [];
	}
	return [
		"Proposed update reviewed and applied.",
		...changes.map(formatProposalUpdateSummaryLine),
		...promptLines(context),
	];
}

/** The Decision Log note for an update reviewed and rejected in full. */
export function proposalUpdateRejectedNoteLines(
	context: ProposalNoteContext,
): string[] {
	return [
		"Proposed update reviewed in the Proposal Inbox and fully rejected; no changes applied.",
		...promptLines(context),
	];
}
