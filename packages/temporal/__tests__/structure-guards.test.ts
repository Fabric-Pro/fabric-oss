/**
 * Unit tests for the structure-preservation guard primitives.
 *
 * These back the "safe-hold" policy: a rewrite that would destroy a work item's
 * structure (drop a bug's diagnostic sections, collapse the body, reformat a bug
 * as a feature) must be detected so the caller keeps the existing body. Targeted
 * edits — including a single justified section removal — must NOT trip the guard.
 */

import { describe, expect, it } from "vitest";
import {
	detectContentFloorBreach,
	detectDestructiveRewrite,
	extractSectionBody,
	spliceSectionBody,
} from "../src/lib/structure-guards";

const BUG_BODY = `## Bug: Login button does nothing

## Steps to Reproduce
1. Open /login
2. Click "Sign in"

## Expected Result
User is signed in.

## Actual Result
Nothing happens; no network request.

## Environment
Chrome 120, Windows 11

## Root Cause
Unknown — pending investigation.

## Original Description from User (Do Not Modify)
the login button is broken, clicking does nothing
`;

describe("detectDestructiveRewrite", () => {
	it("flags an empty rewrite of a non-empty body", () => {
		expect(
			detectDestructiveRewrite({
				existing: BUG_BODY,
				candidate: "   ",
				kind: "BUG",
			}),
		).toEqual({ destructive: true, reason: "empty_output" });
	});

	it("does not flag empty→empty", () => {
		expect(
			detectDestructiveRewrite({
				existing: "",
				candidate: "",
				kind: "BUG",
			}).destructive,
		).toBe(false);
	});

	it("flags a bug rewrite that drops ALL diagnostic sections", () => {
		const reformatted = `## Feature Overview
A nicer login experience.

## Acceptance Criteria
GIVEN a user WHEN they sign in THEN it works.`;
		const res = detectDestructiveRewrite({
			existing: BUG_BODY,
			candidate: reformatted,
			kind: "BUG",
		});
		expect(res.destructive).toBe(true);
		// either cross_type_reformat (Feature Narrative-ish) or sections dropped
		expect(["bug_sections_dropped", "cross_type_reformat"]).toContain(
			res.reason,
		);
	});

	it("flags a bug rewrite that injects feature-only sections", () => {
		const reformatted = `${BUG_BODY}\n## Feature Narrative\nAs a user...`;
		expect(
			detectDestructiveRewrite({
				existing: BUG_BODY,
				candidate: reformatted,
				kind: "BUG",
			}),
		).toEqual({ destructive: true, reason: "cross_type_reformat" });
	});

	it("does NOT flag a targeted bug edit (root cause filled in, sections kept)", () => {
		const edited = BUG_BODY.replace(
			"Unknown — pending investigation.",
			"Click handler is never bound because the form ref is null on first render.",
		);
		expect(
			detectDestructiveRewrite({
				existing: BUG_BODY,
				candidate: edited,
				kind: "BUG",
			}).destructive,
		).toBe(false);
	});

	it("does NOT flag a single justified section removal", () => {
		// Remove only the Root Cause section; all other bug sections remain.
		const removed = BUG_BODY.replace(
			/## Root Cause[\s\S]*?(?=## Original Description)/,
			"",
		);
		expect(
			detectDestructiveRewrite({
				existing: BUG_BODY,
				candidate: removed,
				kind: "BUG",
			}).destructive,
		).toBe(false);
	});

	it("flags a gross body collapse", () => {
		const big = `Some intro.\n${"section text ".repeat(120)}`;
		expect(
			detectDestructiveRewrite({
				existing: big,
				candidate: "tiny",
				kind: "FEATURE",
			}),
		).toEqual({ destructive: true, reason: "body_collapsed" });
	});

	it("does NOT flag a normal feature edit of similar length", () => {
		const feature = `As a user, I want X, so that Y.\n\n## Overview\n${"detail ".repeat(80)}`;
		const edited = `${feature}\n\nAdded one clarifying sentence from the meeting.`;
		expect(
			detectDestructiveRewrite({
				existing: feature,
				candidate: edited,
				kind: "FEATURE",
			}).destructive,
		).toBe(false);
	});
});

describe("detectDestructiveRewrite — FEATURE direction (Fizzy #2048)", () => {
	const FEATURE_BODY = `## Feature Narrative
A reviewer can pick a template by hand.

## User Story
As a reviewer, I want to choose the prompt so the draft matches my intent.

## Benefit Hypothesis
Fewer rewrites after the first draft.

## Business Impact
Reviewers stop hand-repairing generated bodies.`;

	it("flags a feature rewrite that drops ALL narrative sections", () => {
		const reformatted = `## Steps to Reproduce
1. Open the editor.

## Expected Result
It opens.`;
		expect(
			detectDestructiveRewrite({
				existing: FEATURE_BODY,
				candidate: reformatted,
				kind: "FEATURE",
			}),
		).toEqual({ destructive: true, reason: "feature_sections_dropped" });
	});

	it("does not flag a targeted edit that keeps the narrative sections", () => {
		const edited = FEATURE_BODY.replace(
			"Fewer rewrites after the first draft.",
			"Fewer rewrites after the first draft, measured over a sprint.",
		);
		expect(
			detectDestructiveRewrite({
				existing: FEATURE_BODY,
				candidate: edited,
				kind: "FEATURE",
			}).destructive,
		).toBe(false);
	});

	/**
	 * The reason the bug direction's cross-type check is NOT mirrored here.
	 * `countHeadingMatches` matches by substring and BUG_SIGNATURE_SECTIONS
	 * carries "Impact", so a feature headed "Business Impact" would be refused
	 * on every edit if the mirror existed. This pins that it is not.
	 */
	it("does not treat a feature's own '## Business Impact' heading as a bug section", () => {
		const edited = `${FEATURE_BODY}\n\n## Business Impact\nRestated.`;
		expect(
			detectDestructiveRewrite({
				existing: FEATURE_BODY,
				candidate: edited,
				kind: "FEATURE",
			}).destructive,
		).toBe(false);
	});

	it("applies the kind-agnostic checks to features too — an empty rewrite is destructive", () => {
		expect(
			detectDestructiveRewrite({
				existing: FEATURE_BODY,
				candidate: "   ",
				kind: "FEATURE",
			}),
		).toEqual({ destructive: true, reason: "empty_output" });
	});
});

/**
 * The KIND-AGNOSTIC content floor, split out of `detectDestructiveRewrite` for
 * the type-conversion regeneration (Fizzy #2048). That path deliberately
 * reshapes a body from one kind's template into the other's, so it must run
 * these two rules and none of the section-signature ones — running those would
 * refuse every legitimate conversion by construction.
 *
 * The block below pins both halves of that split: the floor behaves the same
 * whichever kind is involved (it never asks), and `detectDestructiveRewrite`
 * still returns exactly what it returned before the extraction — the cases in
 * the blocks above are the regression surface for that second half.
 */
describe("detectContentFloorBreach", () => {
	const FEATURE_BODY = `## Feature Narrative
A reviewer can pick a template by hand.

## Benefit Hypothesis
Fewer rewrites after the first draft.`;

	it("flags an empty rewrite of a non-empty body", () => {
		expect(
			detectContentFloorBreach({
				existing: BUG_BODY,
				candidate: "   ",
			}),
		).toEqual({ belowFloor: true, reason: "empty_output" });
	});

	it("does not flag empty→empty — nothing was lost", () => {
		expect(
			detectContentFloorBreach({ existing: "", candidate: "" })
				.belowFloor,
		).toBe(false);
	});

	it("does not flag a first body written over a blank one", () => {
		expect(
			detectContentFloorBreach({
				existing: null,
				candidate: BUG_BODY,
			}).belowFloor,
		).toBe(false);
	});

	it("flags a gross body collapse", () => {
		const big = `Some intro.\n${"section text ".repeat(120)}`;
		expect(
			detectContentFloorBreach({ existing: big, candidate: "tiny" }),
		).toEqual({ belowFloor: true, reason: "body_collapsed" });
	});

	it("does not flag a short card that a legitimate tightening shrank", () => {
		// Under the 600-char floor the ratio rule never applies — short cards
		// swing wildly on an honest edit.
		expect(
			detectContentFloorBreach({
				existing: "A short note about the export failing.",
				candidate: "Export fails.",
			}).belowFloor,
		).toBe(false);
	});

	/**
	 * The point of the split. A conversion rewrites a bug body into feature shape
	 * and vice versa, dropping the source kind's entire section signature by
	 * design. The floor must stay silent on that — it is `detectDestructiveRewrite`
	 * that would refuse it, which is precisely why the conversion path calls this
	 * instead.
	 */
	it("stays silent on a full cross-type reshape that keeps the content", () => {
		expect(
			detectContentFloorBreach({
				existing: BUG_BODY,
				candidate: `${FEATURE_BODY}\n${BUG_BODY.replace(/^## .*$/gm, "")}`,
			}).belowFloor,
		).toBe(false);
		// The same pair through the kind-aware guard IS refused — the two are not
		// interchangeable, and this is the behaviour the conversion path avoids.
		expect(
			detectDestructiveRewrite({
				existing: BUG_BODY,
				candidate: FEATURE_BODY,
				kind: "BUG",
			}).destructive,
		).toBe(true);
	});

	it("asks nothing about kind — the same pair scores the same either way", () => {
		const pair = { existing: BUG_BODY, candidate: "   " };
		expect(detectContentFloorBreach(pair)).toEqual(
			detectContentFloorBreach(pair),
		);
		// And the kind-aware guard reports the floor's reason verbatim, so the
		// two cannot drift apart on the shared rules.
		expect(
			detectDestructiveRewrite({ ...pair, kind: "FEATURE" }).reason,
		).toBe(detectContentFloorBreach(pair).reason);
	});
});

describe("extractSectionBody / spliceSectionBody", () => {
	it("extracts the body under a header up to the next heading", () => {
		expect(extractSectionBody(BUG_BODY, "Environment")).toBe(
			"Chrome 120, Windows 11",
		);
	});

	it("returns null when the header is absent", () => {
		expect(extractSectionBody(BUG_BODY, "Workaround")).toBeNull();
	});

	it("splices a new body into a section, preserving the heading", () => {
		const out = spliceSectionBody(
			BUG_BODY,
			"Environment",
			"Firefox 121, macOS",
		);
		expect(out).toContain("## Environment");
		expect(out).toContain("Firefox 121, macOS");
		expect(out).not.toContain("Chrome 120, Windows 11");
		// other sections preserved
		expect(out).toContain("## Steps to Reproduce");
		expect(out).toContain("the login button is broken");
	});

	it("is a no-op when the header is absent", () => {
		expect(spliceSectionBody(BUG_BODY, "Nonexistent", "x")).toBe(BUG_BODY);
	});
});

/**
 * These two helpers are the GENERALIZED copy of the Re-evaluate Bug server-side
 * guard (`reanalyze-body-by-kind.ts` calls them out as mirroring it). Both
 * copies must behave identically for decorated and undecorated headings, so this
 * block mirrors
 * `packages/api/modules/projects/procedures/stories/__tests__/reevaluate-bug-original-description.test.ts`.
 *
 * The stakes: when the lookup misses, `extractSectionBody` returns `null` and
 * the caller's verbatim-preserve guard is SKIPPED — it fails open, and the
 * model's rewrite of the reporter's own words is persisted with nothing raised.
 * A heading the PO merely highlighted in the editor (TipTap stores
 * `## <mark data-color="#fef08a">…</mark>`) used to be enough to trigger that.
 */
describe("extractSectionBody / spliceSectionBody — decorated headings", () => {
	const ORIGINAL_HEADER = "Original Description from User (Do Not Modify)";
	const ORIGINAL_BODY = [
		"the login button is broken, clicking does nothing",
		"",
		"happens on my work laptop every morning, first click only",
		"tried a hard refresh, no change",
	].join("\n");

	/** A bug card whose Original Description heading is written `heading`. */
	const card = (heading: string) =>
		[
			"## Steps to Reproduce",
			"1. Open /login",
			"",
			heading,
			ORIGINAL_BODY,
			"",
			"## Environment",
			"Chrome 120, Windows 11",
			"",
		].join("\n");

	const PLAIN = `## ${ORIGINAL_HEADER}`;
	const HIGHLIGHTED = `## <mark data-color="#fef08a">${ORIGINAL_HEADER}</mark>`;
	const BOLD = `## **${ORIGINAL_HEADER}**`;

	it("extracts the verbatim body under an undecorated heading", () => {
		expect(extractSectionBody(card(PLAIN), ORIGINAL_HEADER)).toBe(
			ORIGINAL_BODY,
		);
	});

	it.each([
		["highlighted", HIGHLIGHTED],
		["bolded", BOLD],
		["inline-coded", `## \`${ORIGINAL_HEADER}\``],
	])(
		"still finds the section when the heading is %s, with the same verbatim body",
		(_label, heading) => {
			expect(extractSectionBody(card(heading), ORIGINAL_HEADER)).toBe(
				ORIGINAL_BODY,
			);
		},
	);

	it("does NOT match a body line that only LOOKS like the heading once stripped", () => {
		// Forgery guard: an inline-code body line normalizes to heading shape and
		// must never move a section boundary.
		const forged = [
			"## Steps to Reproduce",
			`\`## ${ORIGINAL_HEADER}\``,
			"not the user's words at all",
		].join("\n");
		expect(extractSectionBody(forged, ORIGINAL_HEADER)).toBeNull();
	});

	it("stops at a DECORATED following heading (terminators are left un-normalized on purpose)", () => {
		// `/^##? \S/` is already satisfied by `<`, `*`, `~` and a backtick.
		// Normalizing the terminator could only LOSE the match — a heading whose
		// text sits entirely inside the stripped tag collapses to a bare `##` —
		// and the body would over-read to EOF, swallowing Environment.
		const body = [
			PLAIN,
			"reporter line one",
			'## <mark data-color="#fef08a">Environment</mark>',
			"Chrome 120, Windows 11",
		].join("\n");
		expect(extractSectionBody(body, ORIGINAL_HEADER)).toBe(
			"reporter line one",
		);
	});

	it("restores the FULL body under a decorated heading, not a truncated one", () => {
		const mutated = card(HIGHLIGHTED).replace(
			ORIGINAL_BODY,
			"The login button does not respond to the first click.",
		);
		const restored = spliceSectionBody(
			mutated,
			ORIGINAL_HEADER,
			ORIGINAL_BODY,
		);

		for (const line of ORIGINAL_BODY.split("\n").filter(Boolean)) {
			expect(restored).toContain(line);
		}
		expect(extractSectionBody(restored, ORIGINAL_HEADER)).toBe(
			ORIGINAL_BODY,
		);
		expect(restored).not.toContain(
			"The login button does not respond to the first click.",
		);
		// The rest of the card survives and the heading line is carried over
		// unchanged — the normalized form is match-only, never written back.
		expect(restored).toContain("## Steps to Reproduce");
		expect(restored).toContain("## Environment");
		expect(restored).toContain("Chrome 120, Windows 11");
		expect(restored).toContain(HIGHLIGHTED);
	});

	it("keeps a DECORATED following heading as the splice boundary", () => {
		const mutated = [
			HIGHLIGHTED,
			"model rewrote this",
			"## **Environment**",
			"Chrome 120, Windows 11",
		].join("\n");
		const restored = spliceSectionBody(
			mutated,
			ORIGINAL_HEADER,
			ORIGINAL_BODY,
		);
		expect(restored).toContain("## **Environment**");
		expect(restored).toContain("Chrome 120, Windows 11");
		expect(restored).not.toContain("model rewrote this");
		expect(extractSectionBody(restored, ORIGINAL_HEADER)).toBe(
			ORIGINAL_BODY,
		);
	});
});
