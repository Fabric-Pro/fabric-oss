import { z } from "zod";

/**
 * Parlume's meeting notes and the transcript lines they cite.
 *
 * Finalization in `@repo/api` writes the transcript with the two section
 * headers and the line format below, the notes activity in `@repo/temporal`
 * reads them to tell which lines a note may cite and writes the notes into
 * the transcript context's metadata, and the sessions list reads them back.
 * One definition, so the three cannot drift apart.
 */

/** The name Parlume's bot joins under, and its chat messages are sent as. */
export const PARLUME_BOT_NAME = "Fabric Parlume";

/** Opens the part of a Parlume transcript that the meeting said or wrote. */
export const PARLUME_TRANSCRIPT_SPEECH_HEADER = "Captured incoming speech:";

/** Opens a transcript line of a message in the meeting chat. */
export const PARLUME_TRANSCRIPT_CHAT_PREFIX = "[chat] ";

/**
 * One segment as transcript text: every line break in it is written as
 * "\r\n", so a chat message of several lines keeps them, and the content's
 * lines (split on "\n") tell where each segment ends.
 */
export function parlumeTranscriptText(text: string): string {
	return text.replace(/\r\n|\r|\n/g, "\r\n");
}

/**
 * Whether the segment on a line of the transcript content goes on in the next
 * line: written by {@link parlumeTranscriptText}, only a line that ends in
 * "\r" does. Any other line ends its segment, and the next one starts a new
 * segment.
 */
export function parlumeTranscriptLineContinues(line: string): boolean {
	return line.endsWith("\r");
}

/**
 * Opens the part that records Fabric's own answers and mutation receipts.
 * Notes may not cite it: a generated answer is not evidence of what the
 * meeting said, and a receipt is not something anyone decided.
 */
export const PARLUME_TRANSCRIPT_RECORDS_HEADER =
	"Recorded Fabric responses and mutation receipts:";

export const PARLUME_NOTE_KINDS = [
	"discussion",
	"decision",
	"action",
	"question",
] as const;

export type ParlumeNoteKind = (typeof PARLUME_NOTE_KINDS)[number];

const MAX_NOTE_ITEMS = 80;

/**
 * One note, tied to the transcript line that supports it. `anchorLine` is the
 * 1-based line of the transcript context's content, the line the transcript
 * reader opens at with `#t-<line>`. The owner and due date use the field
 * names of a Meeting Digest action item.
 */
const noteItemSchema = z.object({
	kind: z.enum(PARLUME_NOTE_KINDS),
	text: z.string().min(1).max(600),
	anchorLine: z.number().int().min(1),
	tentativeOwnerName: z.string().min(1).max(200).optional(),
	dueHint: z.string().min(1).max(200).optional(),
});

export type ParlumeNoteItem = z.infer<typeof noteItemSchema>;

const noteItemsSchema = z.object({
	version: z.literal(1),
	items: z.array(noteItemSchema).max(MAX_NOTE_ITEMS),
});

/** The value stored as the transcript context's `parlumeNotesItems`. */
export function parlumeNoteItemsRecord(
	items: ParlumeNoteItem[],
): z.infer<typeof noteItemsSchema> {
	return noteItemsSchema.parse({
		version: 1,
		items: items.slice(0, MAX_NOTE_ITEMS),
	});
}

/**
 * The anchored notes stored on a transcript context's metadata, or none for
 * notes written before they were anchored, or a record that does not parse.
 */
export function readParlumeNoteItems(metadata: unknown): ParlumeNoteItem[] {
	if (
		!metadata ||
		typeof metadata !== "object" ||
		!("parlumeNotesItems" in metadata)
	) {
		return [];
	}
	const parsed = noteItemsSchema.safeParse(metadata.parlumeNotesItems);
	return parsed.success ? parsed.data.items : [];
}
