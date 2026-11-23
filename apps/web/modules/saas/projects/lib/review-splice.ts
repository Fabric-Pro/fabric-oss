/**
 * The text a line-by-line review writes: the original Markdown with only the
 * changes the reviewer decided spliced in, so every line nobody decided is
 * saved byte for byte as it was.
 *
 * The review shows the change from `original` to `proposed` in the editor,
 * and the editor's own reading of the reviewed document (`reviewed`, every
 * undecided change rejected) says what was decided, but in the editor's
 * Markdown: lists loose, a blank line after each heading, an HTML table as a
 * Markdown table. Saving that reading rewrote text nobody decided. Instead,
 * each changed region of `original` → `proposed` (`buildLineHunks`) is read
 * against `reviewed` on keys that reading cannot change: a line's list depth
 * and its words (`canonicalLines`). A region whose change `reviewed` holds
 * takes `proposed`'s lines as written; one it does not hold keeps
 * `original`'s. A region decided only in part (one word of a line accepted)
 * takes `reviewed`'s lines for that region alone.
 */

import {
	buildLineHunks,
	listDepthLines,
} from "@repo/utils/proposal-update-summary";
import { diffArrays } from "diff";

/** A line's list depth and words, and the line it comes from. */
type CanonicalLine = { key: string; line: number };

const LIST_MARKER = /^(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?/;
const HTML_TAG =
	/<\/?(?:table|thead|tbody|tfoot|tr|td|th|caption|colgroup|col|br|p|div|span|strong|em|b|i|u|s|code|pre|a|img|sup|sub|ul|ol|li|details|summary|hr)\b[^>]*>/gi;
const HTML_ROW_END = /<\/tr\s*>/i;
const HTML_ENTITY = /&[a-z0-9#]+;/gi;
const WORD = /[\p{L}\p{N}]+/gu;

/**
 * The lines of `text` as keys the editor's reading keeps: the list depth
 * and the words, with no list marker, Markdown syntax, HTML tag or blank
 * line. An HTML table row is a line of its own, as it is once the editor
 * writes the table in Markdown.
 */
function canonicalLines(text: string): CanonicalLine[] {
	const lines: CanonicalLine[] = [];
	for (const [line, { depth, text: content }] of listDepthLines(
		text,
	).entries()) {
		const rows = content
			.trim()
			.replace(LIST_MARKER, "")
			.split(HTML_ROW_END);
		for (const row of rows) {
			const words = row
				.replace(HTML_TAG, " ")
				.replace(HTML_ENTITY, " ")
				.match(WORD);
			if (words) {
				lines.push({ key: `${depth}:${words.join(" ")}`, line });
			}
		}
	}
	return lines;
}

/** A line `reviewed` adds to `original`, after `anchor` of its keys. */
type AddedLine = CanonicalLine & { anchor: number; used: boolean };

/**
 * How `reviewed` reads against `original`, key by key: which of
 * `original`'s keys it drops, the keys it adds and where, and the line of
 * `reviewed` each kept key sits on.
 */
function readAgainst(original: CanonicalLine[], reviewed: CanonicalLine[]) {
	const removed = original.map(() => false);
	const keptOn = new Map<number, number>();
	const added: AddedLine[] = [];
	let at = 0;
	let next = 0;
	for (const part of diffArrays(
		original.map((entry) => entry.key),
		reviewed.map((entry) => entry.key),
	)) {
		for (let count = 0; count < part.value.length; count++) {
			if (part.removed) {
				removed[at++] = true;
				continue;
			}
			const entry = reviewed[next++];
			if (entry === undefined) {
				continue;
			}
			if (part.added) {
				added.push({ ...entry, anchor: at, used: false });
			} else {
				keptOn.set(at++, entry.line);
			}
		}
	}
	return { removed, keptOn, added };
}

/** How many of `lines` come from a line before `line`. */
function countBefore(lines: CanonicalLine[], line: number): number {
	let count = 0;
	while (count < lines.length && (lines[count]?.line ?? line) < line) {
		count++;
	}
	return count;
}

/**
 * The entries of `window` that hold `keys`, in order, one entry per key; null
 * when one is missing.
 */
function matching(keys: string[], window: AddedLine[]): AddedLine[] | null {
	const free = [...window];
	const found: AddedLine[] = [];
	for (const key of keys) {
		const index = free.findIndex((entry) => entry.key === key);
		const entry = free[index];
		if (entry === undefined) {
			return null;
		}
		found.push(entry);
		free.splice(index, 1);
	}
	return found;
}

/** One changed region of `original` → `proposed`, read against `reviewed`. */
type Region = {
	removed: string[];
	added: string[];
	/** Its keys in `original`, as indexes `from` up to `to`. */
	from: number;
	to: number;
	/** The keys of its lines in `proposed`. */
	wanted: string[];
	/** The added lines of `reviewed` it may hold. */
	window: AddedLine[];
	decided: "accepted" | "rejected" | "partial";
};

/**
 * `original` with the changes to `proposed` that `reviewed` holds, and
 * nothing else changed: see the module comment.
 */
export function spliceReviewedText(
	original: string,
	proposed: string,
	reviewed: string,
): string {
	const hunks = buildLineHunks(original, proposed);
	if (!hunks.some((hunk) => hunk.kind === "change")) {
		return original;
	}
	const originalKeys = canonicalLines(original);
	const proposedKeys = canonicalLines(proposed);
	const { removed, keptOn, added } = readAgainst(
		originalKeys,
		canonicalLines(reviewed),
	);
	// Lines `reviewed` adds between two of `original`'s kept keys: the diff
	// lists all of a run's removals before its additions, so a region may
	// hold any of them.
	const gapStart = (index: number) => {
		let start = index;
		while (start > 0 && removed[start - 1]) {
			start--;
		}
		return start;
	};
	const gapEnd = (index: number) => {
		let end = index;
		while (end < removed.length && removed[end]) {
			end++;
		}
		return end;
	};

	const parts: Array<string[] | Region> = [];
	let originalLine = 0;
	let proposedLine = 0;
	for (const hunk of hunks) {
		if (hunk.kind === "same") {
			parts.push(hunk.lines);
			originalLine += hunk.lines.length;
			proposedLine += hunk.lines.length;
			continue;
		}
		const from = countBefore(originalKeys, originalLine);
		const to = countBefore(
			originalKeys,
			originalLine + hunk.removed.length,
		);
		const proposedEnd = proposedLine + hunk.added.length;
		const wanted = proposedKeys
			.filter(
				(entry) =>
					entry.line >= proposedLine && entry.line < proposedEnd,
			)
			.map((entry) => entry.key);
		originalLine += hunk.removed.length;
		proposedLine = proposedEnd;
		const start = gapStart(from);
		const end = gapEnd(to);
		parts.push({
			removed: hunk.removed,
			added: hunk.added,
			from,
			to,
			wanted,
			window: added.filter(
				(entry) => entry.anchor >= start && entry.anchor <= end,
			),
			decided: "rejected",
		});
	}

	// Whole regions first, in order, each taking the lines it holds; then a
	// region decided only in part takes what is left near it.
	const regions = parts.filter(
		(part): part is Region => !Array.isArray(part),
	);
	for (const region of regions) {
		const free = region.window.filter((entry) => !entry.used);
		const found = matching(region.wanted, free);
		const dropped = removed
			.slice(region.from, region.to)
			.filter(Boolean).length;
		if (region.to === region.from && region.wanted.length === 0) {
			// Blank lines or markup alone: nothing the review could show.
			region.decided = "rejected";
		} else if (dropped === region.to - region.from && found !== null) {
			for (const entry of found) {
				entry.used = true;
			}
			region.decided = "accepted";
		} else if (
			dropped === 0 &&
			!free.some((entry) => region.wanted.includes(entry.key))
		) {
			region.decided = "rejected";
		} else {
			region.decided = "partial";
		}
	}

	const reviewedLines = reviewed.split("\n");
	const out: string[] = [];
	for (const part of parts) {
		if (Array.isArray(part)) {
			out.push(...part);
			continue;
		}
		switch (part.decided) {
			case "accepted":
				out.push(...part.added);
				break;
			case "rejected":
				out.push(...part.removed);
				break;
			case "partial": {
				// The reviewed reading of this region alone.
				const lines: number[] = [];
				for (const entry of part.window) {
					if (!entry.used) {
						entry.used = true;
						lines.push(entry.line);
					}
				}
				for (let index = part.from; index < part.to; index++) {
					const line = keptOn.get(index);
					if (line !== undefined) {
						lines.push(line);
					}
				}
				if (lines.length > 0) {
					out.push(
						...reviewedLines.slice(
							Math.min(...lines),
							Math.max(...lines) + 1,
						),
					);
				}
				break;
			}
			default: {
				const unknown: never = part.decided;
				throw new Error(`Unknown review decision: ${unknown}`);
			}
		}
	}
	return out.join("\n");
}
