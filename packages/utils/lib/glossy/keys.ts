/**
 * Glossy cache and visual keys (Fizzy #2589, KTD7, KTD8).
 *
 * SERVER-ONLY: hashes with `node:crypto`. Browser code never needs a key —
 * it receives them inside the edition content — so keep this module out of
 * client imports; `cleanup.ts` and `outline.ts` are the browser-safe halves.
 *
 * Every builder takes `pipelineVersion` as a required argument (KTD14):
 * callers pass `GLOSSY_PIPELINE_VERSION`, so a prompt or pipeline change
 * re-keys everything without a migration. Each key kind hashes under its own
 * domain tag, so two kinds never collide even over identical inputs.
 *
 * Keys identify reusable work, not document versions. The out-of-date check
 * compares `computeDocumentContentHash`, not these.
 */

import { createHash } from "node:crypto";
import {
	normalizeForComparison,
	normalizeOrderedMarkerEscape,
} from "../normalize-for-comparison";
import { scanFences } from "./outline";

export type GlossyPipelineVersion = string | number;

/** A visual slot as the detection key sees it (KTD8). */
export interface GlossyKeySlot {
	id: string;
	kind: string | null;
	hint: string | null;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/** Any other backslash escape of ASCII punctuation (`\[S1\]`, `\-`, `\#`). */
const PUNCTUATION_ESCAPE = /\\([!-/:-@[-`{-~])/g;

const THEMATIC_BREAK = /^([-*_])(?:[ \t]*\1){2,}[ \t]*$/;

const BULLET_MARKER = /^[*+-][ \t]+/;

const ORDERED_MARKER = /^(\d+[.)])[ \t]+/;

/** A line that starts its own block, so the line before it is not soft-wrapped into it. */
const BLOCK_START = /^(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|>|\||<|---$)/;

/**
 * Normalize markdown for a cache key. Built on `normalizeForComparison`
 * (line endings, trailing whitespace, blank-line runs), then undoes what an
 * editor round trip (TipTap → Turndown) changes without changing meaning:
 * - backslash escapes, including the ordered-marker escape;
 * - list markers (`*`, `+`, `-   `) and their spacing, list indentation;
 * - `_` emphasis, which the serializer rewrites as `*`;
 * - thematic breaks (`* * *` vs `---`) and table cell padding;
 * - soft-wrapped paragraph lines, which the editor joins with a space;
 * - blank lines between a paragraph and the list it introduces.
 *
 * MATCH-ONLY: lossy on purpose, and never stored or shown. A collision only
 * reuses cached work across two texts that differ in formatting alone.
 * Fenced code keeps its lines, escapes, and emphasis; like everything else,
 * its runs of spaces collapse to one.
 */
export function normalizeForKey(markdown: string): string {
	// Collapse whitespace runs first: `normalizeForComparison`'s trailing-space
	// pattern backtracks quadratically over a long interior run.
	const lines = normalizeForComparison(
		markdown.replace(/[ \t]{2,}/g, " "),
	).split("\n");
	// Same fence rule as `parseOutline`.
	const fences = scanFences(lines);
	const out: string[] = [];
	let joinable = false;

	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		if (fences[i] === "inside" || fences[i] === "close") {
			out.push(raw);
			continue;
		}
		if (fences[i] === "open") {
			out.push(raw.trim());
			joinable = false;
			continue;
		}
		if (!raw.trim()) {
			joinable = false;
			continue;
		}

		const line = normalizeKeyLine(raw);
		if (joinable && !BLOCK_START.test(line) && out.length > 0) {
			out[out.length - 1] = `${out[out.length - 1]} ${line}`;
			continue;
		}
		out.push(line);
		joinable =
			!line.startsWith("|") && !line.startsWith("#") && line !== "---";
	}
	return out.join("\n").trim();
}

function normalizeKeyLine(raw: string): string {
	// The ordered-marker escape first, as the regular export strips it.
	const unescaped = normalizeOrderedMarkerEscape(raw)
		.replace(PUNCTUATION_ESCAPE, "$1")
		.trim();
	if (THEMATIC_BREAK.test(unescaped)) {
		return "---";
	}
	if (unescaped.startsWith("|")) {
		return normalizeTableRow(unescaped);
	}
	return unescaped
		.replace(BULLET_MARKER, "- ")
		.replace(ORDERED_MARKER, "$1 ")
		.replace(/_/g, "*")
		.replace(/[ \t]{2,}/g, " ");
}

function normalizeTableRow(row: string): string {
	const cells = row
		.replace(/^\|/, "")
		.replace(/\|$/, "")
		.split("|")
		.map((cell) => {
			const trimmed = cell.trim().replace(/[ \t]{2,}/g, " ");
			return /^:?-+:?$/.test(trimmed)
				? "---"
				: trimmed.replace(/_/g, "*");
		});
	return `| ${cells.join(" | ")} |`;
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/**
 * A section's identity (KTD7): heading anchor path, occurrence index, and
 * normalized text. Pass `GlossySection.markdown` from `cleanupDocument`,
 * which has anchor blocks removed, so adding a slot never re-keys text.
 */
export function computeSectionKey(input: {
	headingPath: readonly string[];
	occurrenceIndex: number;
	markdown: string;
	pipelineVersion: GlossyPipelineVersion;
}): string {
	return hashKey("section", input.pipelineVersion, [
		[...input.headingPath],
		input.occurrenceIndex,
		normalizeForKey(input.markdown),
	]);
}

/** A cached rewrite (KTD8): only guarded successes are stored under it. */
export function computeRewriteKey(input: {
	sectionKey: string;
	lengthMode: string;
	keySectionClass: string;
	documentType: string;
	pipelineVersion: GlossyPipelineVersion;
}): string {
	return hashKey("rewrite", input.pipelineVersion, [
		input.sectionKey,
		input.lengthMode,
		input.keySectionClass,
		input.documentType,
	]);
}

/**
 * A detection result (KTD8): ordered section keys plus the slot set. Slots
 * are a set, so their order does not matter; section order does. Style
 * direction shapes extraction only and is deliberately not an input.
 */
export function computeDetectionKey(input: {
	sectionKeys: readonly string[];
	slots: readonly GlossyKeySlot[];
	documentType: string;
	pipelineVersion: GlossyPipelineVersion;
}): string {
	const slots = input.slots
		.map((slot) => [slot.id, slot.kind ?? "", normalizeFreeText(slot.hint)])
		.sort((a, b) => compareTuples(a, b));
	return hashKey("detection", input.pipelineVersion, [
		[...input.sectionKeys],
		slots,
		input.documentType,
	]);
}

/**
 * A cached extraction (KTD8): what the section, kind, hint, and style
 * direction produced, and for a slot, which slot. Two slots of one kind and
 * hint in a section are two visuals, so each needs its own row. Without a
 * slot id the key is exactly what it was before slots were keyed apart, so
 * every detected, pinned, and confirmed opportunity keeps its cached spec.
 */
export function computeExtractionKey(input: {
	sectionKey: string;
	kind: string;
	slotHint: string | null;
	styleDirection: string | null;
	/** Set for a slot's extraction only; an opportunity passes none. */
	slotId?: string | null;
	pipelineVersion: GlossyPipelineVersion;
}): string {
	const parts: unknown[] = [
		input.sectionKey,
		input.kind,
		normalizeFreeText(input.slotHint),
		normalizeFreeText(input.styleDirection),
	];
	if (input.slotId !== undefined && input.slotId !== null) {
		parts.push(input.slotId);
	}
	return hashKey("extraction", input.pipelineVersion, parts);
}

/** A detected visual's key (KTD8): section key + kind. */
export function computeDetectedVisualKey(input: {
	sectionKey: string;
	kind: string;
	pipelineVersion: GlossyPipelineVersion;
}): string {
	return hashKey("visual:detected", input.pipelineVersion, [
		input.sectionKey,
		input.kind,
	]);
}

/** A slot's visual key (KTD8): slot id + section key. */
export function computeSlotVisualKey(input: {
	slotId: string;
	sectionKey: string;
	pipelineVersion: GlossyPipelineVersion;
}): string {
	return hashKey("visual:slot", input.pipelineVersion, [
		input.slotId,
		input.sectionKey,
	]);
}

/** An existing Mermaid block's visual key (KTD8): its normalized source. */
export function computeMermaidVisualKey(input: {
	source: string;
	pipelineVersion: GlossyPipelineVersion;
}): string {
	return hashKey("visual:mermaid", input.pipelineVersion, [
		normalizeForComparison(input.source),
	]);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * SHA-256 over a JSON array — unambiguous, since JSON escapes every string —
 * led by the key kind and the pipeline version.
 */
function hashKey(
	kind: string,
	pipelineVersion: GlossyPipelineVersion,
	parts: unknown[],
): string {
	if (
		pipelineVersion === undefined ||
		pipelineVersion === null ||
		String(pipelineVersion).trim() === ""
	) {
		throw new Error(`Glossy ${kind} key requires a pipeline version`);
	}
	return createHash("sha256")
		.update(
			JSON.stringify([
				`glossy:${kind}`,
				String(pipelineVersion),
				...parts,
			]),
		)
		.digest("hex");
}

/** Hints and style direction are free text: trimmed, whitespace collapsed, case kept. */
function normalizeFreeText(value: string | null | undefined): string {
	return (value ?? "").trim().replace(/\s+/g, " ");
}

function compareTuples(a: string[], b: string[]): number {
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const left = a[i] ?? "";
		const right = b[i] ?? "";
		if (left !== right) {
			return left < right ? -1 : 1;
		}
	}
	return 0;
}
