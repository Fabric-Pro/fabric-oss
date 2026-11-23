/**
 * Reading a meeting transcript out of an uploaded file (Fizzy #1877).
 *
 * Pure text handling, separate from the activity that stores the result. A file
 * here was written by another tool, so nothing below assumes it is well formed:
 * what can be read is kept, and what cannot is counted, so the upload can say
 * it is incomplete instead of failing whole or quietly losing part of a meeting.
 */

export interface DecodedTranscript {
	text: string;
	unreadableCharacters: number;
}

export interface ParsedTranscript {
	text: string;
	speakerNames: string[];
	/** Lines that held content but could not be attached to a cue. */
	unreadableLines: number;
}

const REPLACEMENT_CHARACTER = /�/g;

/** Windows tools write UTF-16 as readily as UTF-8, and mark it with a BOM. */
function encodingOf(bytes: Buffer): "utf-8" | "utf-16le" | "utf-16be" {
	if (bytes[0] === 0xff && bytes[1] === 0xfe) {
		return "utf-16le";
	}
	if (bytes[0] === 0xfe && bytes[1] === 0xff) {
		return "utf-16be";
	}
	return "utf-8";
}

export function decodeTranscriptBytes(bytes: Buffer): DecodedTranscript {
	const decoded = new TextDecoder(encodingOf(bytes)).decode(bytes);
	const unreadableCharacters =
		decoded.match(REPLACEMENT_CHARACTER)?.length ?? 0;
	return {
		text: decoded.replace(REPLACEMENT_CHARACTER, ""),
		unreadableCharacters,
	};
}

// The hours are optional in WebVTT, and Zoom and others do leave them out.
const CUE_TIMING = /^(?:\d{1,3}:)?\d{2}:\d{2}\.\d{3}\s+-->\s+/;
const VOICE_TAG = /<v(?:\.[^\s>]*)?\s+([^>]+)>/;
const MARKUP = /<[^>]*>/g;
const NON_CUE_BLOCK = /^(?:WEBVTT|NOTE|STYLE|REGION)\b/;

const ENTITIES: Record<string, string> = {
	"&amp;": "&",
	"&lt;": "<",
	"&gt;": ">",
	"&nbsp;": " ",
	"&lrm;": "",
	"&rlm;": "",
};

function plainCueText(markup: string): string {
	return markup
		.replace(MARKUP, "")
		.replace(/&(?:amp|lt|gt|nbsp|lrm|rlm);/g, (entity) => ENTITIES[entity])
		.trim();
}

// A speaker name is a capitalized name of a few words, in any alphabet. The
// word limit is what keeps "The items we still have to close today:" out.
const NAME = String.raw`\p{Lu}[\p{L}\p{M}'’.-]*(?:\s+[\p{L}\p{M}'’.-]+){0,3}`;
const SPEAKER_PREFIX = new RegExp(`^(${NAME}):\\s+\\S`, "u");
const SPEAKER_WITH_TIME = new RegExp(
	`^(${NAME})\\s+\\(?\\d{1,2}:\\d{2}(?::\\d{2})?\\)?$`,
	"u",
);

export function parseVttTranscript(raw: string): ParsedTranscript {
	const lines: string[] = [];
	const speakers = new Set<string>();
	let unreadableLines = 0;

	for (const block of raw.replace(/\r\n?/g, "\n").split(/\n{2,}/)) {
		const blockLines = block
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
		const first = blockLines[0];
		if (!first || NON_CUE_BLOCK.test(first)) {
			continue;
		}

		const timing = blockLines.findIndex((line) => CUE_TIMING.test(line));
		if (timing === -1) {
			unreadableLines += blockLines.length;
			continue;
		}

		const markup = blockLines.slice(timing + 1).join(" ");
		const text = plainCueText(markup);
		if (!text) {
			continue;
		}

		const speaker =
			markup.match(VOICE_TAG)?.[1]?.trim() ??
			text.match(SPEAKER_PREFIX)?.[1];
		if (!speaker) {
			lines.push(text);
			continue;
		}
		speakers.add(speaker);
		lines.push(
			text.startsWith(`${speaker}:`) ? text : `${speaker}: ${text}`,
		);
	}

	return {
		text: lines.join("\n"),
		speakerNames: Array.from(speakers),
		unreadableLines,
	};
}

function normalizeTranscriptText(raw: string): string {
	return raw.replace(/\r\n?/g, "\n").trim();
}

function parseTranscriptLines(
	raw: string,
	normalizeLine: (line: string, index: number) => string,
): ParsedTranscript {
	const text = normalizeTranscriptText(raw);

	// A label that appears once ("Agenda:") looks exactly like a speaker. A
	// person in a meeting talks more than once, and a list of participants is
	// worth less than a wrong one is misleading, so a single mention is not one.
	const mentions = new Map<string, number>();
	for (const [index, line] of text.split("\n").entries()) {
		const normalized = normalizeLine(line, index).trim();
		const speaker =
			normalized.match(SPEAKER_PREFIX)?.[1] ??
			normalized.match(SPEAKER_WITH_TIME)?.[1];
		if (speaker) {
			mentions.set(speaker, (mentions.get(speaker) ?? 0) + 1);
		}
	}

	return {
		text,
		speakerNames: Array.from(mentions)
			.filter(([, count]) => count > 1)
			.map(([speaker]) => speaker),
		unreadableLines: 0,
	};
}

export function parsePlainTranscript(raw: string): ParsedTranscript {
	return parseTranscriptLines(raw, (line) => line);
}

const MARKDOWN_QUOTE = /^>\s?/;
const MARKDOWN_HEADING = /^#{1,6}\s+/;
// CommonMark list markers: a bullet, or one to nine digits and `.` or `)`.
const MARKDOWN_BULLET = /^(?:[-*+]|\d{1,9}[.)])[ \t]+/;
const EMPHASIS_MARKERS = ["***", "___", "**", "__", "*", "_"] as const;

function stripQuoteMarkers(line: string): string {
	let rest = line.trim();
	while (MARKDOWN_QUOTE.test(rest)) {
		rest = rest.replace(MARKDOWN_QUOTE, "").trimStart();
	}
	return rest;
}

/**
 * Removes the Markdown that decorates a line, for speaker detection only: the
 * stored text keeps it. A leading emphasis marker is removed together with the
 * first marker that closes it, so `**Alice:** hi` and `**Alice**: hi` both
 * read as `Alice: hi`.
 */
function stripMarkdownLineDecoration(line: string): string {
	let rest = stripQuoteMarkers(line);
	rest = rest.replace(MARKDOWN_HEADING, "").replace(MARKDOWN_BULLET, "");
	const marker = EMPHASIS_MARKERS.find((candidate) =>
		rest.startsWith(candidate),
	);
	if (marker) {
		const close = rest.indexOf(marker, marker.length);
		if (close > marker.length) {
			rest =
				rest.slice(marker.length, close) +
				rest.slice(close + marker.length);
		}
	}
	return rest;
}

/**
 * The run of backticks or tildes that starts a line (after whitespace), and
 * what follows it. Scanned by hand rather than with a regex: the regex this
 * replaced retried every split of a long run when the rest of the line held a
 * character `.` does not match (U+2028), which is quadratic in the run.
 */
function fenceRun(
	line: string,
): { char: string; length: number; after: string } | null {
	let start = 0;
	while (start < line.length && /\s/.test(line[start])) {
		start++;
	}
	const char = line[start];
	if (char !== "`" && char !== "~") {
		return null;
	}
	let end = start;
	while (line[end] === char) {
		end++;
	}
	return end - start >= 3
		? { char, length: end - start, after: line.slice(end) }
		: null;
}

/**
 * The quote depth of a line and what follows its quote markers. Each marker
 * may be preceded by up to three spaces and followed by one optional space.
 */
function splitQuoteMarkers(line: string): { depth: number; rest: string } {
	let depth = 0;
	let position = 0;
	for (;;) {
		let cursor = position;
		while (cursor - position < 3 && line[cursor] === " ") {
			cursor++;
		}
		if (line[cursor] !== ">") {
			break;
		}
		cursor++;
		if (line[cursor] === " ") {
			cursor++;
		}
		depth++;
		position = cursor;
	}
	return { depth, rest: line.slice(position) };
}

/**
 * A Markdown transcript: the text is kept exactly as uploaded (apart from the
 * newline and trim handling of a plain file), and only the speaker detection
 * looks past the Markdown on each line. Lines inside a fenced code block
 * (backtick or tilde, fence lines included) are not read as speakers.
 *
 * The fences are tracked line by line, with no parser and no syntax tree, so
 * the time is linear in the text and the memory is constant apart from the
 * line split (a Markdown parser's memory grows with the structure of the text
 * and killed the worker on a large file of short list items). A fence inside a
 * blockquote ends when the quote does. An unclosed fence runs to the end of
 * the text, even one opened inside a list item, whose end is not tracked.
 * Indented (four spaces or tab) code blocks are deliberately NOT excluded: a
 * label inside one counts as a speaker.
 */
export function parseMarkdownTranscript(raw: string): ParsedTranscript {
	let fence: { char: string; length: number; depth: number } | null = null;

	return parseTranscriptLines(raw, (line) => {
		const { depth, rest } = splitQuoteMarkers(line);

		if (fence && depth < fence.depth) {
			fence = null;
		}
		if (fence) {
			if (depth === fence.depth) {
				const run = fenceRun(rest);
				if (
					run &&
					run.char === fence.char &&
					run.length >= fence.length &&
					run.after.trim() === ""
				) {
					fence = null;
				}
			}
			return "";
		}

		// A list item can open a fence on its own line: `- ```js`.
		const opener = fenceRun(rest.trimStart().replace(MARKDOWN_BULLET, ""));
		if (opener && !(opener.char === "`" && opener.after.includes("`"))) {
			fence = { char: opener.char, length: opener.length, depth };
			return "";
		}
		return stripMarkdownLineDecoration(line);
	});
}
