/**
 * A diagram's caption (Fizzy #2946), kept in the fence body as one comment
 * line so that it survives every save and load the body does:
 *
 *   ```mermaid
 *   %% fabric-visual: k3v9q2m7x1a8c4d6
 *   %% caption: Delivery plan
 *   flowchart LR
 *     ...
 *   ```
 *
 * The line sits in the body's leading `%%` comment block: right after the
 * generated-visual marker when there is one (the marker stays the first
 * line), otherwise first. Mermaid reads it as a comment, so it is never part
 * of the drawing, and the source hash leaves it out, so a caption change
 * does not make a generated diagram an edited one.
 *
 * Pure string work, on its own so the editor and the export read it without
 * the Markdown parser `visual-identity.ts` brings in.
 */

import { VISUAL_MARKER_PATTERN } from "./stat-tiles";

/** The longest caption kept, in characters; the rest is cut. */
export const DIAGRAM_CAPTION_MAX_CHARS = 200;

const CAPTION_LINE = /^%%\s*caption:(.*)$/i;
// C0 and C1 controls and the Unicode line and paragraph separators.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/**
 * A caption as it is stored: one line, controls and line breaks become
 * spaces, runs of whitespace collapse, trimmed and cut to
 * `DIAGRAM_CAPTION_MAX_CHARS`; null when nothing is left.
 */
export function cleanDiagramCaption(
	caption: string | null | undefined,
): string | null {
	if (!caption) {
		return null;
	}
	const text = Array.from(
		caption.replace(CONTROL, " ").replace(/\s+/g, " ").trim(),
	)
		.slice(0, DIAGRAM_CAPTION_MAX_CHARS)
		.join("")
		.trim();
	return text === "" ? null : text;
}

/**
 * The indexes of the caption lines in the body's leading comment block: the
 * lines before the first one that is neither blank nor a `%%` comment.
 */
function captionLineIndexes(lines: readonly string[]): number[] {
	const indexes: number[] = [];
	for (const [index, line] of lines.entries()) {
		const trimmed = line.trim();
		if (trimmed !== "" && !trimmed.startsWith("%%")) {
			break;
		}
		if (CAPTION_LINE.test(trimmed)) {
			indexes.push(index);
		}
	}
	return indexes;
}

/** The caption a fence body carries, cleaned, or null. */
export function readDiagramCaption(source: string): string | null {
	const lines = source.split(/\r\n?|\n/);
	for (const index of captionLineIndexes(lines)) {
		const caption = cleanDiagramCaption(
			CAPTION_LINE.exec(lines[index].trim())?.[1],
		);
		if (caption) {
			return caption;
		}
	}
	return null;
}

/**
 * `source` with `caption` as its only caption line: every caption line of
 * the leading comment block is removed, and a non-empty caption is written
 * back after the marker line, or first when there is none. Null or an
 * empty caption only removes. Returns `source` itself when nothing changes.
 */
export function withDiagramCaption(
	source: string,
	caption: string | null | undefined,
): string {
	const lines = source.split(/\r\n?|\n/);
	const existing = captionLineIndexes(lines);
	const cleaned = cleanDiagramCaption(caption);
	if (existing.length === 0 && cleaned === null) {
		return source;
	}
	const drop = new Set(existing);
	const kept = lines.filter((_line, index) => !drop.has(index));
	if (cleaned !== null) {
		const first = kept.findIndex((line) => line.trim() !== "");
		const at =
			first !== -1 && VISUAL_MARKER_PATTERN.test(kept[first].trim())
				? first + 1
				: 0;
		kept.splice(at, 0, `%% caption: ${cleaned}`);
	}
	const next = kept.join("\n");
	return next === source ? source : next;
}
