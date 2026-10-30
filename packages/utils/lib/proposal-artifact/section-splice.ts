/**
 * One section's own lines of a Proposal's Main, and the splice of a new body
 * over them (Fizzy #2946).
 *
 * A section's own lines run from its heading to the next heading of any
 * level, the range `buildSectionMap` gives it, so findings and prose hashes
 * (both per disjoint section) name exactly what a finding-driven revision
 * rewrites. The heading line is fixed. The preamble has no heading of its
 * own and holds the document's title, so it is no target.
 *
 * Pure and browser-safe: the revision library in the worker, the
 * `reviseSection` procedure and the editor, which splices a candidate into
 * its own copy of the body, all use these.
 */

import { parseMarkdownAst } from "./markdown-ast";
import {
	buildSectionMapFromRoot,
	findSection,
	normalizeSource,
	PREAMBLE_SECTION_KEY,
} from "./section-hash";

/** One section's own lines, split at its fixed heading. */
export interface SectionTarget {
	/** The document's lines, normalised as `normalizeSource` does. */
	lines: string[];
	/** 0-based index of the first line after the heading. */
	bodyStart: number;
	/** 0-based index one past the section's last own line. */
	bodyEnd: number;
	/** The heading text, for unwrapping an echoed heading. */
	headingText: string;
	/** Whether another section follows this one. */
	hasNext: boolean;
}

/**
 * Where `sectionKey`'s own lines are in `documentContent`, or null when it
 * names no section with a heading. The heading may be setext (two lines);
 * every line of it stays fixed.
 */
export function locateSectionTarget(
	documentContent: string,
	sectionKey: string,
): SectionTarget | null {
	if (sectionKey === PREAMBLE_SECTION_KEY) {
		return null;
	}
	const source = normalizeSource(documentContent);
	const root = parseMarkdownAst(source);
	const section = findSection(
		buildSectionMapFromRoot(root, source),
		sectionKey,
	);
	if (!section || section.headingText === null) {
		return null;
	}
	const heading = root.children.find(
		(node) =>
			node.type === "heading" &&
			node.position?.start.line === section.startLine,
	);
	const headingEndLine = heading?.position?.end.line ?? section.startLine;
	const lines = source.split("\n");
	return {
		lines,
		bodyStart: headingEndLine,
		bodyEnd: section.endLine,
		headingText: section.headingText,
		hasNext: section.endLine < lines.length,
	};
}

/** The section's body as it stands, blank edges trimmed. */
export function sectionBody(target: SectionTarget): string {
	return target.lines
		.slice(target.bodyStart, target.bodyEnd)
		.join("\n")
		.replace(/^(?:[ \t]*\n)+/, "")
		.trimEnd();
}

/**
 * `documentContent` with `sectionKey`'s own lines below its heading replaced
 * by `body`, or null when the key names no revisable section. Every line
 * outside that range is kept as it is (normalised by `normalizeSource`); the
 * blank lines at the range's edges are kept too, with at least one between
 * the heading and a non-empty body and before the next heading.
 */
export function spliceSectionBody(
	documentContent: string,
	sectionKey: string,
	body: string,
): string | null {
	const target = locateSectionTarget(documentContent, sectionKey);
	if (!target) {
		return null;
	}
	const { lines, bodyStart, bodyEnd, hasNext } = target;
	const region = lines.slice(bodyStart, bodyEnd);
	const isBlank = (line: string) => line.trim() === "";
	let lead = 0;
	while (lead < region.length && isBlank(region[lead])) {
		lead++;
	}
	let trail = 0;
	while (
		trail < region.length - lead &&
		isBlank(region[region.length - 1 - trail])
	) {
		trail++;
	}
	const allBlank = lead === region.length;
	const endsBlank = region.length > 0 && isBlank(region[region.length - 1]);

	const content = body.replace(/\r\n?/g, "\n").trim();
	let replacement: string[];
	if (!content) {
		replacement = hasNext || endsBlank ? [""] : [];
	} else {
		const leading = Array.from(
			{ length: allBlank ? 1 : Math.max(lead, 1) },
			() => "",
		);
		const trailing = allBlank
			? hasNext || endsBlank
				? [""]
				: []
			: hasNext && trail === 0
				? [""]
				: region.slice(region.length - trail);
		replacement = [...leading, ...content.split("\n"), ...trailing];
	}
	return [
		...lines.slice(0, bodyStart),
		...replacement,
		...lines.slice(bodyEnd),
	].join("\n");
}
