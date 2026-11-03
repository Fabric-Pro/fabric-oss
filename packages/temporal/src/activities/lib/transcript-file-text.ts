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

export function parsePlainTranscript(raw: string): ParsedTranscript {
	const text = raw.replace(/\r\n?/g, "\n").trim();

	// A label that appears once ("Agenda:") looks exactly like a speaker. A
	// person in a meeting talks more than once, and a list of participants is
	// worth less than a wrong one is misleading, so a single mention is not one.
	const mentions = new Map<string, number>();
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		const speaker =
			trimmed.match(SPEAKER_PREFIX)?.[1] ??
			trimmed.match(SPEAKER_WITH_TIME)?.[1];
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
