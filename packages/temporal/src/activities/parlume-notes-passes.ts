/**
 * The model passes of Parlume's meeting notes: one pass for a meeting that
 * fits, or checkpoint notes of each part and a merge, every pass's notes kept
 * only where the lines it was shown support them.
 *
 * Kept apart from the notes activity so the activities barrel does not
 * register these helpers as activities, and so the notes evaluation runs the
 * same passes the activity does.
 */
import { generateText, type LanguageModel, Output } from "@repo/ai";
import { requireStructuredOutput } from "@repo/ai/lib/structured-output";
import { fenceUntrusted } from "@repo/utils/untrusted-fence";
import type { LanguageModelUsage } from "ai";
import {
	addAnchorStats,
	type AnchoredNote,
	anchorParlumeNotes,
	type AnchorStats,
	checkpointWindows,
	emptyAnchorStats,
	formatCheckpointNotes,
	numberedLine,
	type ParlumeNotesOutput,
	parlumeNotesOutputSchema,
	splitParlumeTranscript,
	type TranscriptLine,
} from "./parlume-notes-anchors";

/**
 * The numbered lines one pass reads, about 45 minutes of speech. A meeting
 * that fits is written in one pass. A longer one is written as checkpoint
 * notes of consecutive parts, each citing only its own lines, and a last pass
 * merges them, so no part of the meeting is left out.
 */
const CHECKPOINT_CHARS = 40_000;
/** Fabric's records are context for the final pass only, and are capped. */
const MAX_RECORDS_CHARS = 20_000;
export const PARLUME_NOTES_MAX_OUTPUT_TOKENS = 4_000;
const NOTES_INPUT_TAG = "meeting_notes_input";

type NotesPass = (prompt: string) => Promise<ParlumeNotesOutput>;

function shownLines(lines: TranscriptLine[]): Map<number, string> {
	return new Map(lines.map((line) => [line.line, line.text]));
}

function fencedLines(source: string, lines: TranscriptLine[]): string {
	return fenceUntrusted(
		NOTES_INPUT_TAG,
		{ source },
		lines.map(numberedLine).join("\n"),
	);
}

function recordsContext(records: string, chatDeliveryFacts: string): string {
	if (!records) {
		return chatDeliveryFacts;
	}
	const capped =
		records.length > MAX_RECORDS_CHARS
			? `${records.slice(0, MAX_RECORDS_CHARS)}\n[Later records omitted]`
			: records;
	return [
		fenceUntrusted(NOTES_INPUT_TAG, { source: "fabric_records" }, capped),
		chatDeliveryFacts,
	].join("\n\n");
}

/**
 * Writes the notes of the transcript `content`: one pass for a meeting that
 * fits, or checkpoint notes of each part and a merge. Every pass's notes are
 * kept only where the lines it was shown support them.
 */
export async function writeAnchoredNotes(input: {
	content: string;
	chatDeliveryFacts: string;
	pass: NotesPass;
}): Promise<{ notes: AnchoredNote[]; stats: AnchorStats; parts: number }> {
	const { lines, records } = splitParlumeTranscript(input.content);
	const context = recordsContext(records, input.chatDeliveryFacts);
	const parts = checkpointWindows(lines, CHECKPOINT_CHARS);
	const [only] = parts;
	if (!only) {
		// Nothing was said or written in the meeting: no line to cite.
		return { notes: [], stats: emptyAnchorStats(), parts: 0 };
	}
	if (parts.length === 1) {
		const output = await input.pass(
			`${fencedLines("transcript", only)}\n\n${context}`,
		);
		return { ...anchorParlumeNotes(output, shownLines(only)), parts: 1 };
	}

	let stats = emptyAnchorStats();
	const checkpoints: AnchoredNote[] = [];
	for (const [index, part] of parts.entries()) {
		const output = await input.pass(
			fenceUntrusted(
				NOTES_INPUT_TAG,
				{
					source: "transcript",
					part: `${index + 1} of ${parts.length}`,
				},
				part.map(numberedLine).join("\n"),
			),
		);
		const checkpoint = anchorParlumeNotes(output, shownLines(part));
		stats = addAnchorStats(stats, checkpoint.stats);
		checkpoints.push(...checkpoint.notes);
	}
	if (checkpoints.length === 0) {
		return { notes: [], stats, parts: parts.length };
	}

	const cited = new Set(checkpoints.map((note) => note.anchorLine));
	const citedLines = lines.filter((line) => cited.has(line.line));
	const merged = await input.pass(
		[
			fenceUntrusted(
				NOTES_INPUT_TAG,
				{ source: "checkpoint_notes" },
				formatCheckpointNotes(checkpoints),
			),
			fencedLines("cited_lines", citedLines),
			context,
		].join("\n\n"),
	);
	const final = anchorParlumeNotes(merged, shownLines(citedLines));
	return {
		notes: final.notes,
		stats: addAnchorStats(stats, final.stats),
		parts: parts.length,
	};
}

/** One notes pass: the model's notes for `prompt`, and what it used. */
export async function parlumeNotesPass(
	model: LanguageModel,
	instructions: string,
	prompt: string,
): Promise<{ output: ParlumeNotesOutput; usage: LanguageModelUsage }> {
	const result = await requireStructuredOutput(
		generateText({
			model,
			instructions,
			output: Output.object({ schema: parlumeNotesOutputSchema }),
			prompt,
			maxOutputTokens: PARLUME_NOTES_MAX_OUTPUT_TOKENS,
		}),
	);
	return { output: result.output, usage: result.usage };
}
