/**
 * Row rendering and line accounting for the unified diffs the Coding
 * Instructions tab draws.
 *
 * `prefixDiffPart` (`apps/web/modules/shared/lib/line-diff.ts`) marks the
 * lines WITHIN one part and is deliberately left alone here — the Playwright
 * script history and the prompt version dialog render through it too. What it
 * cannot do is separate one part from the next, because a part only ends in a
 * newline when the file it came from did.
 *
 * `diffLines` (diff@8.0.3) keeps each line's terminating newline on the part
 * that owns it, so a file whose LAST line has no newline yields a final part
 * without one — and for a one-line file, that is the only part:
 *
 *   diffLines("old", "new")        -> [{value: "old", removed}, {value: "new", added}]
 *   diffLines("line", "line\n")    -> [{value: "line", removed}, {value: "line\n", added}]
 *   diffLines("a\nb", "a\nc")      -> [{value: "a\n"}, {value: "b", removed}, {value: "c", added}]
 *
 * Concatenating `prefixDiffPart` over those gave `- old+ new` on ONE row: the
 * removed and added lines ran together, and the reader saw a line that exists
 * in neither version. `toDiffRows` closes each part that does not close
 * itself, so a part boundary is always a row boundary.
 */
import { prefixDiffPart } from "@shared/lib/line-diff";

/**
 * The shape `diffLines` returns; declared locally so this stays pure, and
 * deliberately not exported — a caller names it as
 * `Parameters<typeof countDiffLines>[0]` rather than importing a second
 * `DiffPart` alongside the one in `projects/lib/diff-utils.ts`.
 */
type DiffPart = {
	value: string;
	added?: boolean;
	removed?: boolean;
};

/**
 * One rendered span of a unified diff: its text and how to colour it.
 * Not exported, for the same reason as `DiffPart` above — the two renderers
 * take it by inference from `toDiffRows`.
 */
type DiffRow = {
	text: string;
	added: boolean;
	removed: boolean;
};

/**
 * The gutter-marked spans to render, in order, with every part boundary
 * guaranteed to also be a row boundary.
 *
 * The trailing newline is added only BETWEEN parts: appending one after the
 * last part would draw an empty row at the bottom of every diff whose file
 * ends without a newline. A part that renders to nothing (an empty value)
 * gets no boundary either, since there is no row to close.
 */
export function toDiffRows(parts: DiffPart[]): DiffRow[] {
	return parts.map((part, index) => {
		const rendered = prefixDiffPart(part);
		const needsBoundary =
			index < parts.length - 1 &&
			rendered !== "" &&
			!rendered.endsWith("\n");
		return {
			text: needsBoundary ? `${rendered}\n` : rendered,
			added: Boolean(part.added),
			removed: Boolean(part.removed),
		};
	});
}

/** Lines a part renders, matching `prefixDiffPart` exactly. */
function renderedLineCount(value: string): number {
	if (value === "") {
		return 0;
	}
	const lines = value.split("\n");
	if (lines[lines.length - 1] === "") {
		lines.pop();
	}
	return lines.length;
}

/**
 * How many lines a diff adds and removes. Context parts count as neither.
 *
 * Counted per part rather than off the rendered text: the row boundary
 * `toDiffRows` inserts is a separator, not a line of its own, so counting
 * newlines in the concatenated output would over-report by one per boundary.
 */
export function countDiffLines(parts: DiffPart[]): {
	added: number;
	removed: number;
} {
	let added = 0;
	let removed = 0;
	for (const part of parts) {
		if (part.added) {
			added += renderedLineCount(part.value);
		} else if (part.removed) {
			removed += renderedLineCount(part.value);
		}
	}
	return { added, removed };
}
