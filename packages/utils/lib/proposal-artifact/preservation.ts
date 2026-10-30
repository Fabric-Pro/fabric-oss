/**
 * Whether a scoped AI change of a Proposal's Main kept everything it had to
 * keep (Fizzy #2946).
 *
 * Chat and finding-driven revisions are scoped writers: each may change what
 * it targets and nothing else, and neither may change an existing diagram
 * (diagrams change only through Edit with instructions). This check is the
 * server's backstop for both, run on the content as saved. It answers with
 * codes, section keys and visual ids only, never text, so a refusal is safe
 * to log and to show.
 *
 * ## What "unchanged" means
 *
 * The editor's save re-serialises every section, so Markdown bytes are not
 * the invariant; a section is compared by its fingerprint:
 *
 * - its heading level, heading path and decoded heading text (so a
 *   renumbered heading counts as changed, though its key does not);
 * - its prose hash (`section-hash.ts`);
 * - the link and image destinations on its own lines, in order, which the
 *   prose hash leaves out;
 * - each diagram on its own lines: its source hash (`visual-identity.ts`)
 *   plus its caption, which the source hash leaves out.
 *
 * Fingerprints are matched as a multiset, never by key: inserting a section
 * with the same heading as an existing one shifts that section's occurrence
 * index, and with it its key, without changing a word of it.
 *
 * Every line of the body belongs to exactly one entry. The text before the
 * first section heading is the preamble, which here always exists (empty or
 * not) and also carries the document title's text, so a changed title or a
 * diagram above the first heading is caught like any other change.
 *
 * ## Scopes
 *
 * - `chat` with `patchedSectionKeys` (the keys inside every subtree the
 *   chat patched, on the previous body): every other previous section must
 *   survive unchanged; new sections may appear. Every previous diagram must
 *   survive unchanged unless its patched section went away with it (a
 *   `delete_section`). A patched section went away when the next body holds
 *   fewer sections with its heading path than the previous one did, and at
 *   least as many fewer as there were patched sections on that path; when
 *   only some of them went, which ones cannot be told, so every diagram on
 *   that path must still be there. A patched section rewritten under a new
 *   heading reads as gone too, so its diagrams may go with it: the check
 *   cannot tell that from a delete, and for chat the person's review of the
 *   diff is the control.
 * - `chat` without `patchedSectionKeys` (an agent from before the keys
 *   existed): sections are not checked, every section counts as patched, so
 *   only diagrams are.
 * - `whole-body` (a writer that replaces the whole body with no person
 *   reviewing a diff: the MCP tool and the v1 API): sections are not
 *   checked, and every previous diagram must still be there unchanged, so
 *   none goes with its section. A section rewritten under a new heading
 *   reads as gone, which `chat` lets take its diagrams with it; without a
 *   person's review that would let a diagram change through a renamed
 *   heading. Diagrams are matched across the whole body, so one moved to
 *   another section still counts, and a new one is allowed.
 * - `section` (a finding-driven revision): only the target section's own
 *   lines may change, its heading text stays, no section is added, removed
 *   or reordered, and every previous diagram, the target's included, must
 *   still be there unchanged. A new diagram is allowed.
 *
 * Both inputs are normalised as `section-hash.ts` normalises them (line
 * endings to `\n`, text to NFC), so a CRLF body and its LF copy are equal.
 *
 * Pure and deterministic, and no Node built-ins: the API and the editor
 * bundle both import it.
 */

import type { Nodes, PhrasingContent, RootContent } from "mdast";
import { parseMarkdownAst } from "./markdown-ast";
import {
	buildSectionMapFromRoot,
	normalizeSource,
	PREAMBLE_SECTION_KEY,
	type ProseSection,
} from "./section-hash";
import {
	classifyVisualFences,
	diagramFences,
	readDiagramCaption,
	readVisualMarker,
	type VisualFenceState,
	type VisualOrigin,
	type VisualSpecSummary,
	visualSourceHash,
} from "./visual-identity";

/**
 * The refusal codes, named as the save path answers them: a section outside
 * the target changed, or an existing diagram changed.
 */
export const PRESERVATION_VIOLATION = {
	OUTSIDE_TARGET: "REVISION_OUTSIDE_TARGET",
	CHANGED_DIAGRAM: "REVISION_CHANGED_DIAGRAM",
} as const;

export type PreservationViolationCode =
	(typeof PRESERVATION_VIOLATION)[keyof typeof PRESERVATION_VIOLATION];

/** What a scoped writer was allowed to change. */
export type PreservationScope =
	| {
			kind: "chat";
			/** Section keys of the previous body inside the patched subtrees. */
			patchedSectionKeys?: readonly string[];
	  }
	| {
			kind: "section";
			/** The revised section's key on the previous body. */
			sectionKey: string;
	  }
	| {
			/** An unreviewed whole-body write: every diagram kept, no target. */
			kind: "whole-body";
	  };

/** How the previous body's diagram read against the stored specs. */
export interface PreservationDiagramClass {
	state: VisualFenceState;
	/** The matching spec's origin, for `generated` only. */
	origin?: VisualOrigin;
}

/** One thing the change did not keep. Ids and keys only, never text. */
export interface PreservationViolation {
	code: PreservationViolationCode;
	/** The previous body's section the change touched (or, if added, next's). */
	sectionKey?: string;
	/** For a diagram: its 0-based position among the previous body's diagrams. */
	ordinal?: number;
	/** For a diagram that carried a valid marker: its visual id. */
	visualId?: string;
	/** For a diagram: its classification in the previous body. */
	classification?: PreservationDiagramClass;
}

export type PreservationResult =
	| { ok: true }
	| { ok: false; violations: PreservationViolation[] };

export interface PreservationInput {
	/** Main before the change, as stored. */
	previous: string;
	/** Main after the change, as it would be saved. */
	next: string;
	scope: PreservationScope;
	/** The document's stored visual specs; only used to name a diagram. */
	visualSpecs?: readonly VisualSpecSummary[];
}

/**
 * Whether `next` kept what `scope` says it must keep of `previous`. See the
 * module comment for the rules.
 */
export function checkPreservation(
	input: PreservationInput,
): PreservationResult {
	const { scope } = input;
	const previousSource = normalizeSource(input.previous);
	const previous = readDocument(previousSource);
	const next = readDocument(normalizeSource(input.next));

	let sectionViolations: PreservationViolation[] = [];
	let removable = new Set<string>();
	if (scope.kind === "section") {
		const checked = checkTargetSection(previous, next, scope.sectionKey);
		if (checked === null) {
			// The target is not in the previous body: nothing is in scope.
			return { ok: false, violations: [outsideTarget(scope.sectionKey)] };
		}
		sectionViolations = checked;
	} else if (scope.kind === "chat") {
		const patched = scope.patchedSectionKeys
			? new Set(scope.patchedSectionKeys)
			: null;
		if (patched) {
			sectionViolations = checkUnpatchedSections(previous, next, patched);
		}
		removable = removedSectionKeys(previous, next, patched);
	}
	// `whole-body`: no section is checked, and no diagram is removable.

	const missing = missingDiagrams(previous, next, removable);
	const violations = [...sectionViolations];
	if (missing.length > 0) {
		const classes = classifyVisualFences(
			previousSource,
			input.visualSpecs ?? [],
		);
		for (const diagram of missing) {
			const fence = classes[diagram.ordinal];
			violations.push({
				code: PRESERVATION_VIOLATION.CHANGED_DIAGRAM,
				sectionKey: diagram.sectionKey,
				ordinal: diagram.ordinal,
				...(diagram.visualId ? { visualId: diagram.visualId } : {}),
				...(fence
					? {
							classification: fence.origin
								? { state: fence.state, origin: fence.origin }
								: { state: fence.state },
						}
					: {}),
			});
		}
	}

	return violations.length === 0 ? { ok: true } : { ok: false, violations };
}

/**
 * The fingerprint of the section `sectionKey` of `body`, as this check
 * compares sections (see the module comment): heading, prose hash, link and
 * image destinations, diagrams. Equal for a body and the editor's
 * re-serialisation of it, different when a destination changed. Undefined
 * when `body` has no such section.
 *
 * It holds the section's destinations and heading text, so a caller that
 * hands it to a client hashes it first.
 */
export function sectionFingerprint(
	body: string,
	sectionKey: string,
): string | undefined {
	return readDocument(normalizeSource(body)).sections.find(
		(section) => section.key === sectionKey,
	)?.fingerprint;
}

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

/**
 * A chat's sections: every previous section outside the patched keys must
 * match a distinct next section.
 */
function checkUnpatchedSections(
	previous: ScopedDocument,
	next: ScopedDocument,
	patched: ReadonlySet<string>,
): PreservationViolation[] {
	const available = countBy(next.sections, (section) => section.fingerprint);
	const violations: PreservationViolation[] = [];
	for (const section of previous.sections) {
		if (patched.has(section.key)) {
			continue;
		}
		if (!take(available, section.fingerprint)) {
			violations.push(outsideTarget(section.key));
		}
	}
	return violations;
}

/**
 * A finding revision's sections: the same sections in the same order, only
 * the target's own lines changed, its heading kept. Null when the previous
 * body has no such target.
 */
function checkTargetSection(
	previous: ScopedDocument,
	next: ScopedDocument,
	targetKey: string,
): PreservationViolation[] | null {
	const target = previous.sections.find(
		(section) => section.key === targetKey,
	);
	if (!target) {
		return null;
	}
	const keepsHeading = (section: ScopedSection) =>
		section.key === target.key &&
		section.depth === target.depth &&
		section.headingText === target.headingText;

	const violations: PreservationViolation[] = [];
	if (previous.sections.length === next.sections.length) {
		previous.sections.forEach((before, index) => {
			const after = next.sections[index];
			const kept =
				before === target
					? keepsHeading(after)
					: after.fingerprint === before.fingerprint;
			if (!kept) {
				violations.push(outsideTarget(before.key));
			}
		});
		return violations;
	}

	// A section was added or removed: name what has no counterpart.
	const nextTarget = next.sections.find(keepsHeading);
	if (!nextTarget) {
		violations.push(outsideTarget(target.key));
	}
	const available = countBy(
		next.sections.filter((section) => section !== nextTarget),
		(section) => section.fingerprint,
	);
	for (const section of previous.sections) {
		if (section !== target && !take(available, section.fingerprint)) {
			violations.push(outsideTarget(section.key));
		}
	}
	// What is left in `available` has no previous counterpart: it was added.
	for (const section of next.sections) {
		if (section !== nextTarget && take(available, section.fingerprint)) {
			violations.push(outsideTarget(section.key));
		}
	}
	return violations;
}

/**
 * The previous sections a chat removed together with their diagrams: see
 * the module comment. `patched` null means every section counts as patched.
 */
function removedSectionKeys(
	previous: ScopedDocument,
	next: ScopedDocument,
	patched: ReadonlySet<string> | null,
): Set<string> {
	const before = countBy(previous.sections, (section) => section.path);
	const after = countBy(next.sections, (section) => section.path);
	const patchedOnPath = new Map<string, string[]>();
	for (const section of previous.sections) {
		if (patched === null || patched.has(section.key)) {
			const keys = patchedOnPath.get(section.path) ?? [];
			keys.push(section.key);
			patchedOnPath.set(section.path, keys);
		}
	}

	const removed = new Set<string>();
	for (const [path, keys] of patchedOnPath) {
		const gone = (before.get(path) ?? 0) - (after.get(path) ?? 0);
		if (gone >= keys.length) {
			for (const key of keys) {
				removed.add(key);
			}
		}
	}
	return removed;
}

/**
 * Every previous diagram outside `removable` sections without a distinct
 * equal diagram (source hash and caption) anywhere in the next body.
 */
function missingDiagrams(
	previous: ScopedDocument,
	next: ScopedDocument,
	removable: ReadonlySet<string>,
): ScopedDiagram[] {
	const available = countBy(next.diagrams, (diagram) => diagram.fingerprint);
	return previous.diagrams.filter(
		(diagram) =>
			!removable.has(diagram.sectionKey) &&
			!take(available, diagram.fingerprint),
	);
}

function outsideTarget(sectionKey: string): PreservationViolation {
	return { code: PRESERVATION_VIOLATION.OUTSIDE_TARGET, sectionKey };
}

// ---------------------------------------------------------------------------
// Reading a body
// ---------------------------------------------------------------------------

interface ScopedSection {
	key: string;
	depth: number;
	/** Decoded heading text; the preamble's is the title's, or null. */
	headingText: string | null;
	/** Level and heading path: what stays when a section is rewritten. */
	path: string;
	fingerprint: string;
}

interface ScopedDiagram {
	/** 0-based position among the body's diagram fences. */
	ordinal: number;
	sectionKey: string;
	visualId: string | null;
	/** Source hash and caption. */
	fingerprint: string;
}

interface ScopedDocument {
	sections: ScopedSection[];
	diagrams: ScopedDiagram[];
}

/** One parse for the section map, destinations and the title. */
function readDocument(source: string): ScopedDocument {
	const root = parseMarkdownAst(source);
	const map = buildSectionMapFromRoot(root, source);
	const lineCount = source.split("\n").length;

	// The preamble always gets an entry, the title line among its lines.
	const firstHeading = map.sections.find(
		(section) => section.key !== PREAMBLE_SECTION_KEY,
	);
	const ranges: ProseSection[] = map.sections.some(
		(section) => section.key === PREAMBLE_SECTION_KEY,
	)
		? map.sections
		: [
				{
					key: PREAMBLE_SECTION_KEY,
					headingText: null,
					depth: 0,
					headingPath: [],
					occurrenceIndex: 0,
					startLine: 1,
					endLine: firstHeading
						? firstHeading.startLine - 1
						: lineCount,
					proseHash: "",
				},
				...map.sections,
			];
	const indexAt = (line: number) =>
		Math.max(
			0,
			ranges.findIndex(
				(section) =>
					line >= section.startLine && line <= section.endLine,
			),
		);

	const definitions = new Map<string, string>();
	const destinations: string[][] = ranges.map(() => []);
	const visit = (node: Nodes, index: number) => {
		switch (node.type) {
			case "link":
			case "image":
				destinations[index].push(destination(node.url));
				break;
			case "definition":
				definitions.set(node.identifier, node.url);
				destinations[index].push(destination(node.url));
				break;
			case "html":
				for (const url of htmlDestinations(node.value)) {
					destinations[index].push(destination(url));
				}
				break;
		}
		if ("children" in node) {
			for (const child of node.children) {
				visit(child, index);
			}
		}
	};
	for (const block of root.children) {
		visit(block, indexAt(lineOf(block)));
	}
	// A reference reads its destination from a definition anywhere in the body.
	const resolve = (node: Nodes, index: number) => {
		if (node.type === "linkReference" || node.type === "imageReference") {
			const url = definitions.get(node.identifier);
			destinations[index].push(
				url === undefined ? `[${node.identifier}]` : destination(url),
			);
		}
		if ("children" in node) {
			for (const child of node.children) {
				resolve(child, index);
			}
		}
	};
	for (const block of root.children) {
		resolve(block, indexAt(lineOf(block)));
	}

	const title = titleText(root.children);
	const fenceParts: string[][] = ranges.map(() => []);
	const diagrams = diagramFences(source).map((fence, ordinal) => {
		const index = indexAt(lineOf(fence));
		const fingerprint = JSON.stringify([
			visualSourceHash(fence.value),
			readDiagramCaption(fence.value) ?? "",
		]);
		fenceParts[index].push(fingerprint);
		return {
			ordinal,
			sectionKey: ranges[index].key,
			visualId: readVisualMarker(fence.value).visualId,
			fingerprint,
		};
	});

	const sections = ranges.map((section, index) => {
		const path = JSON.stringify([section.depth, section.headingPath]);
		const headingText =
			section.key === PREAMBLE_SECTION_KEY ? title : section.headingText;
		return {
			key: section.key,
			depth: section.depth,
			headingText,
			path,
			fingerprint: JSON.stringify([
				path,
				headingText,
				section.proseHash,
				destinations[index],
				fenceParts[index],
			]),
		};
	});
	return { sections, diagrams };
}

function lineOf(node: Nodes): number {
	return node.position?.start.line ?? 1;
}

/**
 * A destination as compared: percent-escapes decoded, since the editor's
 * load percent-encodes destinations and an encoding is not a change.
 */
function destination(url: string): string {
	let decoded = url;
	try {
		decoded = decodeURI(url);
	} catch {
		// A malformed escape stays as written.
	}
	return decoded.normalize("NFC");
}

/** `href` and `src` attribute values of raw HTML, in order. */
const HTML_DESTINATION =
	/\s(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;

function htmlDestinations(html: string): string[] {
	return [...html.matchAll(HTML_DESTINATION)].map(
		(match) => match[1] ?? match[2] ?? match[3] ?? "",
	);
}

/**
 * The title's text when the first heading is a `#`, the rule
 * `buildSectionMap` applies; `section-hash.ts` leaves it out of every
 * section, so the preamble carries it here.
 */
function titleText(blocks: readonly RootContent[]): string | null {
	const first = blocks.find((block) => block.type === "heading");
	if (first?.type !== "heading" || first.depth !== 1) {
		return null;
	}
	return inlineText(first.children)
		.normalize("NFC")
		.replace(/\s+/g, " ")
		.trim();
}

function inlineText(nodes: readonly PhrasingContent[]): string {
	let text = "";
	for (const node of nodes) {
		if (node.type === "text" || node.type === "inlineCode") {
			text += node.value;
		} else if (node.type === "image" || node.type === "imageReference") {
			text += node.alt ?? "";
		} else if (node.type === "break") {
			text += " ";
		} else if ("children" in node) {
			text += inlineText(node.children);
		}
	}
	return text;
}

// ---------------------------------------------------------------------------
// Multisets
// ---------------------------------------------------------------------------

function countBy<T>(
	items: readonly T[],
	keyOf: (item: T) => string,
): Map<string, number> {
	const counts = new Map<string, number>();
	for (const item of items) {
		const key = keyOf(item);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return counts;
}

/** Takes one `key` out of `counts`; false when none is left. */
function take(counts: Map<string, number>, key: string): boolean {
	const count = counts.get(key) ?? 0;
	if (count === 0) {
		return false;
	}
	counts.set(key, count - 1);
	return true;
}
