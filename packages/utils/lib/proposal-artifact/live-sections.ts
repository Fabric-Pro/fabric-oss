/**
 * The finished part of a document that is still streaming (Fizzy #2801).
 *
 * While a Proposal generates, the agent sends cumulative partial documents.
 * The page shows only whole sections, and a section is whole once the next
 * section's heading has started: everything above that heading will not
 * change in this attempt. So the live preview is the text before the last
 * section heading, and the whole text once the stream has ended.
 *
 * A section heading is an `##` or `###` heading. A document using neither
 * is cut at its shallowest heading level instead, not counting a leading `#`
 * title — the same title rule Glossy's segmentation applies — so a document
 * of `####` sections under a `#` title still previews section by section.
 *
 * Headings inside fenced code blocks are code, never boundaries: the outline
 * comes from `parseOutline`, whose fence rule is `scanFences`. A cut prefix
 * therefore never ends inside a fence; only an ended stream can, and the
 * returned copy closes that fence so it cannot swallow what a renderer
 * appends after it. The input is never modified.
 *
 * Pure and deterministic, and no Node built-ins: the worker writes the
 * preview and the editor bundle may render it.
 */

import { FENCE_MARKER, parseOutline, scanFences } from "../glossy/outline";

export interface CompletedSectionsOptions {
	/** The stream has ended: every section is complete. */
	ended?: boolean;
}

/** The levels that delimit a Proposal section. */
const SECTION_LEVELS: ReadonlySet<number> = new Set([2, 3]);

/**
 * The completed sections of `partial`: the text before its last section
 * heading, or all of it when `ended`. Trailing whitespace is trimmed so an
 * unchanged preview compares equal, and `""` means nothing is complete yet —
 * an empty preview, or one with no section heading.
 */
export function completedSections(
	partial: string,
	options: CompletedSectionsOptions = {},
): string {
	const text = partial.replace(/\r\n?/g, "\n");
	if (options.ended) {
		return closeOpenFence(text.trimEnd());
	}

	const boundary = lastSectionBoundary(text);
	if (boundary === null) {
		return "";
	}
	const prefix = text
		.split("\n")
		.slice(0, boundary - 1)
		.join("\n")
		.trimEnd();
	return closeOpenFence(prefix);
}

/** 1-based line of the last heading that starts a section, or `null`. */
function lastSectionBoundary(markdown: string): number | null {
	const headings = parseOutline(markdown);
	let boundaries = headings.filter((heading) =>
		SECTION_LEVELS.has(heading.level),
	);
	if (boundaries.length === 0) {
		const candidates =
			headings[0]?.level === 1 ? headings.slice(1) : headings;
		if (candidates.length === 0) {
			return null;
		}
		const level = Math.min(...candidates.map((heading) => heading.level));
		boundaries = candidates.filter((heading) => heading.level === level);
	}
	return boundaries[boundaries.length - 1].startLine;
}

/**
 * `markdown` with a closing marker appended when it ends inside a fenced
 * block: the opener's own character, repeated as many times, so
 * `scanFences` reads it as the close.
 */
function closeOpenFence(markdown: string): string {
	if (!markdown) {
		return markdown;
	}
	const lines = markdown.split("\n");
	const roles = scanFences(lines);
	let openLine = -1;
	for (let i = 0; i < roles.length; i++) {
		if (roles[i] === "open") {
			openLine = i;
		} else if (roles[i] === "close") {
			openLine = -1;
		}
	}
	if (openLine === -1) {
		return markdown;
	}
	const marker = lines[openLine].match(FENCE_MARKER)?.[1];
	return marker ? `${markdown}\n${marker}` : markdown;
}
