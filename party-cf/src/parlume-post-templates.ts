import { isRecord } from "./parlume-stream-auth";

// Every post Fabric's answer to a request makes opens the same way, under its
// tag: a bold label that says what the post is, who asked, and the request in
// their words. The lines come from the turn, never from the model, so a
// participant can tell at a glance which request a post answers. A post the
// voice makes itself (post_to_chat), the suggestions and the recap get no
// header; the latter two stay one plain paragraph by an earlier deliberate
// change.

/** The most of the request a post quotes. */
const MAX_QUOTE_CHARS = 120;
const MAX_ASKER_CHARS = 80;

/** What a post for a turn is: its answer, what the voice left out, or why there is none. */
type ParlumeTurnPostKind = "answer" | "detail" | "error";

export interface ParlumeTurnPostHeader {
	kind: ParlumeTurnPostKind;
	asker: string | null;
	request: string;
}

/**
 * Text that stays as written in the chat: on one line, without the marks
 * the chat would read as emphasis, a code span or the quote's own end.
 */
function literal(text: string): string {
	return text
		.replace(/[*_`“”]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function cut(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/**
 * The two lines a turn's post opens with: "**Answer** for Alex", then the
 * request in italics, cut to 120 characters.
 */
export function parlumeTurnPostHeader(header: ParlumeTurnPostHeader): string {
	const asker = header.asker
		? cut(literal(header.asker), MAX_ASKER_CHARS)
		: "";
	const label = turnPostLabel(header.kind, asker);
	const request = cut(literal(header.request), MAX_QUOTE_CHARS);
	return request ? `${label}\n*“${request}”*` : label;
}

function turnPostLabel(kind: ParlumeTurnPostKind, asker: string): string {
	switch (kind) {
		case "answer":
			return asker ? `**Answer** for ${asker}` : "**Answer**";
		case "detail":
			return asker ? `**Detail** for ${asker}` : "**Detail**";
		case "error":
			return asker
				? `**Could not answer** ${asker}`
				: "**Could not answer**";
		default: {
			const unreachable: never = kind;
			return unreachable;
		}
	}
}

/** The label of what a shortened post left out, posted on "more P7". */
export function parlumeRestPostHeader(tag: string): string {
	return `**Rest of ${tag}**`;
}

/** The answer to a typed "Parlume, help": what a participant can type. */
export const PARLUME_HELP_TEXT = [
	"**What you can type**",
	"go P4 · I say post P4 aloud",
	"more P4 · the rest of P4, or more detail",
	"continue · the next part of a post I am reading",
	"stop · I stop speaking",
	"Parlume, pause · I stop listening",
	"Changes need a Confirm click in Fabric.",
].join("\n");

/** Parses the worker's `header` on a post for a turn. */
export function parseParlumeTurnPostHeader(
	value: unknown,
	max: number,
): ParlumeTurnPostHeader | null {
	if (!isRecord(value)) {
		return null;
	}
	const { kind, asker, request } = value;
	if (
		(kind !== "answer" && kind !== "detail" && kind !== "error") ||
		typeof request !== "string" ||
		request.length > max ||
		(asker !== null && (typeof asker !== "string" || asker.length > max))
	) {
		return null;
	}
	return { kind, asker, request };
}
