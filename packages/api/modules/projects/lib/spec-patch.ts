/**
 * Scoped spec patching for Feature Maturation V2 (decision-driven propagation).
 *
 * A confirmed Decision in the maturation flow proposes one or more *scoped*
 * edits to the Clean Specification — the existing freetext markdown stored in
 * `UserStory.description` / `UserStory.acceptanceCriteria`. Rather than letting
 * the model rewrite the whole document (which buries the PO in a 1k-row diff),
 * each edit is expressed as a `{ from, to }` patch and applied to just the
 * targeted block, leaving the rest of the document byte-identical.
 *
 * The `{ from, to }` shape deliberately mirrors the diff-shaped change proposals
 * in `packages/temporal/src/activities/backlog-context/analyze-context.ts`, so
 * the maturation propagation pipeline reuses a contract the codebase already
 * uses for backlog updates.
 *
 * Pure — no I/O, no model calls. This module is the *deterministic* half: it
 * applies a patch the model returned. Producing a tight patch (vs. a full
 * rewrite) is the model's responsibility, validated separately against the live
 * AI gateway before this is wired into the propagation procedure.
 *
 * Safety contract: a patch whose `from` block is missing or appears more than
 * once is REFUSED (reported, never applied). A mis-located patch must surface,
 * never silently corrupt the spec — the whole point of the feature is that the
 * PO trusts the Clean Spec without re-reading it.
 */

import { z } from "zod";

/**
 * A single scoped edit. `to === ""` deletes the matched block. `summary` is the
 * one-sentence human-readable line shown in the Decision Log (never a raw diff).
 */
const SpecPatchSchema = z.object({
	from: z
		.string()
		.describe(
			"The exact existing block to replace — a paragraph or list item, verbatim from the current spec.",
		),
	to: z
		.string()
		.describe(
			"The replacement block. Use an empty string to delete the block.",
		),
	summary: z
		.string()
		.describe(
			"One-sentence human-readable summary of what changed, for the Decision Log.",
		),
});

export type SpecPatch = z.infer<typeof SpecPatchSchema>;

/** Wrapper for a decision proposing one or more patches in a single turn. */
export const SpecPatchSetSchema = z.object({
	patches: z.array(SpecPatchSchema),
});

/**
 * The single source of truth for the scoped-patch prompt. Shared by the live
 * propagation procedure (TG4) and the Phase-0 tightness harness so the contract
 * the model is held to never drifts between the spike and production. The
 * verbatim-`from` requirement is what lets `applySpecPatch` locate the block;
 * the "do not re-emit unaffected parts" instruction is what keeps the PO out of
 * a 1k-row diff. An empty `patches` array is the correct answer when the
 * decision does not change the spec (a formatting-only / no-op decision).
 */
export function buildSpecPatchPrompt(decision: string, spec: string): string {
	return `You are maintaining a developer-ready feature specification. A product decision has been confirmed. Return ONLY the minimal set of scoped edits needed to reflect this decision in the spec — as { from, to } patches where "from" is an EXACT verbatim block (a single paragraph or list item) copied from the current spec, and "to" is its replacement ("" to delete it). Do NOT rewrite, reformat, or re-emit any part of the spec that the decision does not affect. If the decision does not change the spec, return an empty patches array.

CONFIRMED DECISION:
${decision}

CURRENT SPECIFICATION:
${spec}`;
}

export type PatchOutcome =
	| { ok: true; result: string }
	| {
			ok: false;
			reason: "not-found" | "ambiguous" | "empty";
			matchCount: number;
	  };

/**
 * Normalize a block to a comparable line sequence: trim each line and drop a
 * single leading/trailing blank line. Tolerates the model echoing the target
 * block with slightly different surrounding whitespace or indentation.
 */
function normalizeBlock(block: string): string[] {
	return block
		.split("\n")
		.map((line) => line.trim())
		.filter(
			(line, i, all) =>
				!(line === "" && (i === 0 || i === all.length - 1)),
		);
}

/**
 * Locate `from` and replace it with `to`. Two layered strategies, both of which
 * refuse on a missing or ambiguous match (never silently corrupt the doc):
 *
 *   1. Whole-line run (whitespace-tolerant): `from` matches a contiguous run of
 *      lines, compared trimmed. This is the primary path and handles the common
 *      case where the model copies whole lines / list items / paragraphs.
 *   2. Unique-substring fallback: real models sometimes return a sub-line
 *      FRAGMENT — a clause within a longer line (observed against real specs).
 *      When the line run finds nothing, fall back to an EXACT substring match of
 *      the trimmed `from`, applied only when it occurs exactly once in the doc.
 *
 * The substring fallback is gated on uniqueness, so a short/repeated fragment is
 * still refused as ambiguous rather than guessed.
 */
export function applySpecPatch(
	doc: string,
	from: string,
	to: string,
): PatchOutcome {
	const fromLines = normalizeBlock(from);
	if (fromLines.length === 0) {
		return { ok: false, reason: "empty", matchCount: 0 };
	}

	const docLines = doc.split("\n");
	const target = fromLines.join("\n");
	let start = -1;
	let matchCount = 0;
	for (let i = 0; i + fromLines.length <= docLines.length; i++) {
		const window = docLines
			.slice(i, i + fromLines.length)
			.map((line) => line.trim())
			.join("\n");
		if (window === target) {
			if (start === -1) {
				start = i;
			}
			matchCount++;
		}
	}

	if (matchCount === 0) {
		// Whole-line run missed — try the unique-substring fallback for a
		// sub-line fragment before refusing.
		return applySubstringPatch(doc, from, to);
	}
	if (matchCount > 1) {
		return { ok: false, reason: "ambiguous", matchCount };
	}

	const toLines = to === "" ? [] : to.split("\n");
	const next = [
		...docLines.slice(0, start),
		...toLines,
		...docLines.slice(start + fromLines.length),
	];
	return { ok: true, result: next.join("\n") };
}

/**
 * Fallback for a sub-line `from` fragment: replace an EXACT, trimmed substring of
 * the document — but only when it occurs exactly once. Zero matches → not-found;
 * two or more → ambiguous (refused, never guessed). `split/join` (not `replace`)
 * is used so `$`-sequences in `to` are inserted literally.
 */
function applySubstringPatch(
	doc: string,
	from: string,
	to: string,
): PatchOutcome {
	const needle = from.trim();
	if (needle === "") {
		return { ok: false, reason: "empty", matchCount: 0 };
	}

	const occurrences = doc.split(needle).length - 1;
	if (occurrences === 0) {
		return { ok: false, reason: "not-found", matchCount: 0 };
	}
	if (occurrences > 1) {
		return { ok: false, reason: "ambiguous", matchCount: occurrences };
	}

	return { ok: true, result: doc.split(needle).join(to) };
}

export interface PatchFailure {
	patch: SpecPatch;
	reason: "not-found" | "ambiguous" | "empty";
	matchCount: number;
}

export interface SpecPatchResult {
	/** The document after every successfully-applied patch. */
	result: string;
	/** Patches that landed, in application order. */
	applied: SpecPatch[];
	/** Patches that could not be located; the document was left untouched for these. */
	failed: PatchFailure[];
}

/**
 * Apply a decision's patches sequentially against `doc`, accumulating failures
 * instead of throwing. A failed patch never mutates the document; the caller
 * decides whether partial application is acceptable or the set must be retried.
 */
export function applySpecPatches(
	doc: string,
	patches: SpecPatch[],
): SpecPatchResult {
	let result = doc;
	const applied: SpecPatch[] = [];
	const failed: PatchFailure[] = [];

	for (const patch of patches) {
		const outcome = applySpecPatch(result, patch.from, patch.to);
		if (outcome.ok) {
			result = outcome.result;
			applied.push(patch);
		} else {
			failed.push({
				patch,
				reason: outcome.reason,
				matchCount: outcome.matchCount,
			});
		}
	}

	return { result, applied, failed };
}
