/**
 * The model-free half of Parlume's meeting notes: numbering the transcript
 * lines a note may cite, splitting a long meeting into checkpoint parts, and
 * keeping a note only when the line it cites supports it.
 *
 * A note cites one line by its number (`segment`) and quotes it. It is kept
 * only when the quote is in that line, checked by the Meeting Digest's own
 * `resolveQuoteAnchor`, and only when the line was one the model was shown.
 * An owner or a due date the cited line does not name is dropped from the
 * note. The kept note's `anchorLine` is the line of the transcript context's
 * content, which the transcript reader opens at with `#t-<line>`.
 */
import {
	PARLUME_BOT_NAME,
	PARLUME_NOTE_KINDS,
	PARLUME_TRANSCRIPT_CHAT_PREFIX,
	PARLUME_TRANSCRIPT_RECORDS_HEADER,
	PARLUME_TRANSCRIPT_SPEECH_HEADER,
	type ParlumeNoteItem,
	type ParlumeNoteKind,
	parlumeTranscriptLineContinues,
} from "@repo/utils/parlume-notes";
import { z } from "zod";
import { resolveQuoteAnchor } from "./daily-brief/anchor-resolver";

/** A line of the transcript a note may cite, by its 1-based line number. */
export type TranscriptLine = { line: number; text: string };

const MAX_LINE_CHARS = 2_000;
const MAX_TEXT_CHARS = 600;
const MAX_FIELD_CHARS = 200;
const MAX_NOTES_PER_KIND = 20;

/**
 * Words a due date is phrased with that say nothing about when: "by Friday"
 * is supported by a line that says Friday.
 */
const DUE_CONNECTORS = new Set([
	"by",
	"on",
	"at",
	"in",
	"the",
	"of",
	"before",
	"until",
	"no",
	"later",
	"than",
]);

/**
 * Lenient on purpose: an entry with a missing or odd field is dropped by the
 * check below rather than failing the whole reply, and a segment may come
 * back as "12" or "[12]".
 */
const noteEntrySchema = z.object({
	text: z.string().optional(),
	segment: z.union([z.number(), z.string()]).optional(),
	quote: z.string().optional(),
});

const actionEntrySchema = noteEntrySchema.extend({
	owner: z.string().optional(),
	due: z.string().optional(),
});

export const parlumeNotesOutputSchema = z.object({
	discussion: z.array(noteEntrySchema).optional(),
	decisions: z.array(noteEntrySchema).optional(),
	actionItems: z.array(actionEntrySchema).optional(),
	openQuestions: z.array(noteEntrySchema).optional(),
});

export type ParlumeNotesOutput = z.infer<typeof parlumeNotesOutputSchema>;

type NoteEntry = z.infer<typeof noteEntrySchema>;
type ActionEntry = z.infer<typeof actionEntrySchema>;

/** A kept note, with the quote that anchored it for a later merge pass. */
export type AnchoredNote = ParlumeNoteItem & { quote: string };

export type AnchorDropReason =
	| "empty"
	| "segment_unknown"
	| "quote_not_in_segment";

export type AnchorStats = {
	proposed: number;
	kept: number;
	dropped: Record<AnchorDropReason, number>;
	ownersDropped: number;
	duesDropped: number;
};

export function emptyAnchorStats(): AnchorStats {
	return {
		proposed: 0,
		kept: 0,
		dropped: { empty: 0, segment_unknown: 0, quote_not_in_segment: 0 },
		ownersDropped: 0,
		duesDropped: 0,
	};
}

export function addAnchorStats(a: AnchorStats, b: AnchorStats): AnchorStats {
	return {
		proposed: a.proposed + b.proposed,
		kept: a.kept + b.kept,
		dropped: {
			empty: a.dropped.empty + b.dropped.empty,
			segment_unknown:
				a.dropped.segment_unknown + b.dropped.segment_unknown,
			quote_not_in_segment:
				a.dropped.quote_not_in_segment + b.dropped.quote_not_in_segment,
		},
		ownersDropped: a.ownersDropped + b.ownersDropped,
		duesDropped: a.duesDropped + b.duesDropped,
	};
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The first line of a chat message Parlume's bot posted: a chat line whose
 * sender name starts with the bot's, with any mark after it, such as
 * "(unverified speaker)". The bridge tells its own messages by the same name
 * rule.
 */
const PARLUME_POST = new RegExp(
	`^${escapeRegExp(`${PARLUME_TRANSCRIPT_CHAT_PREFIX}${PARLUME_BOT_NAME}`)}\\b[^:]*:`,
	"i",
);

/**
 * The transcript's citable lines, the meeting's own speech, chat and
 * Parlume markers, and the section of Fabric's records, which a note may not
 * cite. Parlume's own chat posts, every line of each, are left out too: like
 * the records, a post is a generated answer, not something the meeting said.
 * A segment of several lines is told by its line breaks (see
 * `parlumeTranscriptLineContinues`). Line numbers count every line of the
 * content, blank ones included, as the transcript reader does.
 */
export function splitParlumeTranscript(content: string): {
	lines: TranscriptLine[];
	records: string;
} {
	const all = content.split("\n");
	const recordsAt = all.findIndex(
		(text) => text.trim() === PARLUME_TRANSCRIPT_RECORDS_HEADER,
	);
	const speechEnd = recordsAt === -1 ? all.length : recordsAt;
	const lines: TranscriptLine[] = [];
	let inParlumePost = false;
	for (let index = 0; index < speechEnd; index++) {
		const text = all[index]?.trim() ?? "";
		const continues =
			index > 0 && parlumeTranscriptLineContinues(all[index - 1] ?? "");
		if (!continues) {
			inParlumePost = PARLUME_POST.test(text);
		}
		if (
			text &&
			text !== PARLUME_TRANSCRIPT_SPEECH_HEADER &&
			!inParlumePost
		) {
			lines.push({ line: index + 1, text });
		}
	}
	return {
		lines,
		records: recordsAt === -1 ? "" : all.slice(recordsAt).join("\n").trim(),
	};
}

/** A line as the model sees it: its number in brackets, then the line. */
export function numberedLine(line: TranscriptLine): string {
	return `[${line.line}] ${line.text.slice(0, MAX_LINE_CHARS)}`;
}

/**
 * The meeting in consecutive parts of at most `maxChars` numbered characters
 * each, cut between lines. A meeting that fits is one part.
 */
export function checkpointWindows(
	lines: TranscriptLine[],
	maxChars: number,
): TranscriptLine[][] {
	const windows: TranscriptLine[][] = [];
	let current: TranscriptLine[] = [];
	let size = 0;
	for (const line of lines) {
		const length = numberedLine(line).length + 1;
		if (current.length > 0 && size + length > maxChars) {
			windows.push(current);
			current = [];
			size = 0;
		}
		current.push(line);
		size += length;
	}
	if (current.length > 0) {
		windows.push(current);
	}
	return windows;
}

function words(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter(Boolean);
}

/** Every word of `value` that matters is a word of the line. */
function supportedBy(
	value: string,
	lineText: string,
	ignored: ReadonlySet<string>,
): boolean {
	const lineWords = new Set(words(lineText));
	const needed = words(value).filter((word) => !ignored.has(word));
	return needed.length > 0 && needed.every((word) => lineWords.has(word));
}

function clean(text: string | undefined, max: number): string {
	return (text ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function segmentNumber(segment: NoteEntry["segment"]): number | null {
	const value =
		typeof segment === "number"
			? segment
			: Number.parseInt((segment ?? "").replace(/[^\d]/g, ""), 10);
	return Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * The notes of one pass that the lines it was shown support. `shown` maps
 * each line number the pass saw to that line's full text; a note citing any
 * other line, a line outside the part it read or one that does not exist, is
 * dropped.
 */
export function anchorParlumeNotes(
	output: ParlumeNotesOutput,
	shown: ReadonlyMap<number, string>,
): { notes: AnchoredNote[]; stats: AnchorStats } {
	const stats = emptyAnchorStats();
	const notes: AnchoredNote[] = [];
	const perKind: Record<ParlumeNoteKind, number> = {
		discussion: 0,
		decision: 0,
		action: 0,
		question: 0,
	};

	const anchor = (
		kind: ParlumeNoteKind,
		entry: NoteEntry,
	): { note: AnchoredNote; lineText: string } | null => {
		stats.proposed += 1;
		const text = clean(entry.text, MAX_TEXT_CHARS);
		const quote = clean(entry.quote, MAX_TEXT_CHARS);
		if (!text || !quote) {
			stats.dropped.empty += 1;
			return null;
		}
		const line = segmentNumber(entry.segment);
		const lineText = line === null ? undefined : shown.get(line);
		if (line === null || lineText === undefined) {
			stats.dropped.segment_unknown += 1;
			return null;
		}
		if (resolveQuoteAnchor(lineText, quote) === null) {
			stats.dropped.quote_not_in_segment += 1;
			return null;
		}
		return { note: { kind, text, anchorLine: line, quote }, lineText };
	};

	const keep = (note: AnchoredNote) => {
		if (perKind[note.kind] < MAX_NOTES_PER_KIND) {
			perKind[note.kind] += 1;
			notes.push(note);
			stats.kept += 1;
		}
	};

	const anchorAction = (entry: ActionEntry) => {
		const anchored = anchor("action", entry);
		if (!anchored) {
			return;
		}
		const owner = clean(entry.owner, MAX_FIELD_CHARS);
		const due = clean(entry.due, MAX_FIELD_CHARS);
		const ownerKept =
			owner !== "" && supportedBy(owner, anchored.lineText, new Set());
		const dueKept =
			due !== "" && supportedBy(due, anchored.lineText, DUE_CONNECTORS);
		if (owner && !ownerKept) {
			stats.ownersDropped += 1;
		}
		if (due && !dueKept) {
			stats.duesDropped += 1;
		}
		keep({
			...anchored.note,
			...(ownerKept ? { tentativeOwnerName: owner } : {}),
			...(dueKept ? { dueHint: due } : {}),
		});
	};

	const anchorPlain = (kind: ParlumeNoteKind, entries: NoteEntry[]) => {
		for (const entry of entries) {
			const anchored = anchor(kind, entry);
			if (anchored) {
				keep(anchored.note);
			}
		}
	};

	anchorPlain("discussion", output.discussion ?? []);
	anchorPlain("decision", output.decisions ?? []);
	for (const entry of output.actionItems ?? []) {
		anchorAction(entry);
	}
	anchorPlain("question", output.openQuestions ?? []);
	return { notes, stats };
}

/** The stored note, without the quote only a merge pass needs. */
export function toParlumeNoteItem({
	quote: _,
	...item
}: AnchoredNote): ParlumeNoteItem {
	return item;
}

const KIND_HEADINGS: Record<ParlumeNoteKind, string> = {
	discussion: "Discussion",
	decision: "Decisions",
	action: "Action items",
	question: "Open questions",
};

function withActionDetails(item: ParlumeNoteItem): string {
	const details = [
		item.tentativeOwnerName ? `Owner: ${item.tentativeOwnerName}` : null,
		item.dueHint ? `Due: ${item.dueHint}` : null,
	].filter((detail): detail is string => detail !== null);
	return details.length > 0
		? `${item.text} (${details.join(", ")})`
		: item.text;
}

/**
 * The notes as Markdown, a section per kind, for readers of the plain notes:
 * the next meeting's recap, and a client that does not show anchors.
 */
export function renderParlumeNotes(items: ParlumeNoteItem[]): string {
	const sections: string[] = [];
	for (const kind of PARLUME_NOTE_KINDS) {
		const ofKind = items.filter((item) => item.kind === kind);
		if (ofKind.length > 0) {
			const heading = `### ${KIND_HEADINGS[kind]}`;
			sections.push([heading, ...ofKind.map(bullet)].join("\n"));
		}
	}
	return sections.join("\n\n");
}

function bullet(item: ParlumeNoteItem): string {
	return `- ${withActionDetails(item)}`;
}

function checkpointLine(note: AnchoredNote): string {
	const kind = KIND_HEADINGS[note.kind];
	const { anchorLine } = note;
	return `- ${kind} · segment ${anchorLine}: ${withActionDetails(note)}`;
}

/** A long meeting's checkpoint notes, for the merge pass. */
export function formatCheckpointNotes(notes: AnchoredNote[]): string {
	return notes.map(checkpointLine).join("\n");
}
