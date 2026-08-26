import { describe, expect, it } from "vitest";
// Imported from the CLIENT-SAFE module, which is where the rule now lives so the
// settings form can apply it too. Taking it from here rather than re-exporting
// it through `publishing-preferences` is deliberate: this suite's whole claim is
// that the form, the write boundary and the snapshot share ONE function, and the
// only honest way to assert that is to import the one they all import.
import { normalizePreferenceLabel } from "../src/publishing-post-types";
import {
	buildPublishingPreferencesSnapshot,
	clampLookbackDays,
	computePublishingPreferencesHash,
} from "../src/publishing-preferences";

const hashOf = (
	source: Parameters<typeof buildPublishingPreferencesSnapshot>[0],
) =>
	computePublishingPreferencesHash(
		buildPublishingPreferencesSnapshot(source),
	);

describe("clampLookbackDays", () => {
	it("resolves an absent window to the engine default", () => {
		expect(clampLookbackDays(null)).toBe(180);
		expect(clampLookbackDays(undefined)).toBe(180);
	});

	it("rejects a non-finite value rather than producing an invalid window", () => {
		expect(clampLookbackDays(Number.NaN)).toBe(180);
		expect(clampLookbackDays(Number.POSITIVE_INFINITY)).toBe(180);
	});

	it("clamps to 1..365, mirroring the workflow", () => {
		expect(clampLookbackDays(0)).toBe(1);
		expect(clampLookbackDays(9999)).toBe(365);
		expect(clampLookbackDays(30)).toBe(30);
	});
});

describe("computePublishingPreferencesHash", () => {
	it("treats a null window and an explicit default as the same run", () => {
		// Behaviourally identical — charging a recovery run for clearing the
		// field back to its own default would be a run spent on nothing.
		expect(hashOf({ lookbackDays: null })).toBe(
			hashOf({ lookbackDays: 180 }),
		);
	});

	it("treats an out-of-range window as the value it will actually be clamped to", () => {
		expect(hashOf({ lookbackDays: 9999 })).toBe(
			hashOf({ lookbackDays: 365 }),
		);
	});

	it("changes when the effective window changes", () => {
		expect(hashOf({ lookbackDays: 30 })).not.toBe(
			hashOf({ lookbackDays: 90 }),
		);
	});

	it("ignores list ORDER — there is no ranking dimension to reorder", () => {
		expect(hashOf({ lookbackDays: 30, preferredThemes: ["b", "a"] })).toBe(
			hashOf({ lookbackDays: 30, preferredThemes: ["a", "b"] }),
		);
	});

	it("folds case on EXCLUSIONS, because the filter that consumes them is case-insensitive", () => {
		expect(
			hashOf({
				lookbackDays: 30,
				excludedKeywords: ["  Beta   Release "],
			}),
		).toBe(
			hashOf({ lookbackDays: 30, excludedKeywords: ["beta release"] }),
		);
	});

	it("PRESERVES case on themes, because the prompt that consumes them does", () => {
		// "API" and "api" reach the model as different words. Folding them here
		// would report "unchanged" for an edit that genuinely changes the prompt,
		// and the run under the new guidance would never happen.
		expect(hashOf({ lookbackDays: 30, preferredThemes: ["API"] })).not.toBe(
			hashOf({ lookbackDays: 30, preferredThemes: ["api"] }),
		);
	});

	it("still ignores duplicates and blank entries on every list", () => {
		expect(
			hashOf({
				lookbackDays: 30,
				preferredThemes: ["a", "a", "", "   "],
			}),
		).toBe(hashOf({ lookbackDays: 30, preferredThemes: ["a"] }));
	});

	it("treats blank free text as unset", () => {
		expect(hashOf({ lookbackDays: 30, strategicPriorities: "   " })).toBe(
			hashOf({ lookbackDays: 30, strategicPriorities: null }),
		);
	});

	it("keeps free-text priorities VERBATIM apart from trimming", () => {
		// This field is prompt guidance, reproduced as written. Two of the three
		// variants below differ only in line structure or capitalisation, and both
		// of those change the instruction the model receives — so all three must
		// hash apart.
		const variants = [
			"Ship notes:\n- security\n- performance",
			"Ship notes: - security - performance",
			"ship notes:\n- security\n- performance",
		];
		const hashes = variants.map((strategicPriorities) =>
			hashOf({ lookbackDays: 30, strategicPriorities }),
		);
		expect(new Set(hashes).size).toBe(3);
	});

	it("changes when a preference genuinely changes", () => {
		expect(
			hashOf({ lookbackDays: 30, excludedKeywords: ["alpha"] }),
		).not.toBe(hashOf({ lookbackDays: 30, excludedKeywords: ["beta"] }));
	});

	it("keeps the fields APART — moving a value between them is a real change", () => {
		// A positional canonical form would collide these if two list fields were
		// ever concatenated instead of kept as separate slots.
		expect(hashOf({ lookbackDays: 30, preferredThemes: ["x"] })).not.toBe(
			hashOf({ lookbackDays: 30, excludedKeywords: ["x"] }),
		);
	});

	it("is stable across calls — the recovery run depends on it not drifting", () => {
		expect(hashOf({ lookbackDays: 30 })).toBe(hashOf({ lookbackDays: 30 }));
	});

	it("hashes an unconfigured project identically whether or not the preference fields exist yet", () => {
		// Slice C-2 adds the four columns. An unconfigured project must not be
		// charged a recovery run merely because the SELECT grew.
		expect(hashOf({ lookbackDays: 30 })).toBe(
			hashOf({
				lookbackDays: 30,
				preferredThemes: [],
				excludedKeywords: [],
				preferredPostTypes: [],
				strategicPriorities: null,
			}),
		);
	});
});

/**
 * The write boundary and the snapshot must share ONE per-item rule.
 *
 * Raised in adversarial review: the oRPC boundary only trimmed, while this
 * module also collapses whitespace runs — so the settings row an admin read back
 * could differ from the text the prompt was built from, and a theme carrying a
 * line break would have been rendered into the middle of the clause's list.
 *
 * The fix was to EXPORT the rule rather than to write a second one that agrees
 * today. These cases live here, against the real module, because the api suite
 * that exercises the boundary replaces `@repo/database` wholesale — a comparison
 * made there would compare a test double with itself.
 */
describe("normalizePreferenceLabel — the rule both sides share", () => {
	it("is the exact rule buildPublishingPreferencesSnapshot applies to themes", () => {
		const NEWLINE = String.fromCharCode(10);
		const TAB = String.fromCharCode(9);
		const raw = [
			"  Developer   Experience  ",
			"Release" + NEWLINE + "Engineering",
			"API" + TAB + TAB + "Design",
		];

		// Item-by-item equality, then the whole list: the snapshot also sorts and
		// dedupes, and those are deliberately NOT the boundary's job — the row
		// keeps the order the admin typed. Only the per-item rule is shared, and
		// this is the assertion that says exactly that much and no more.
		const perItem = raw.map(normalizePreferenceLabel);
		expect(perItem).toEqual([
			"Developer Experience",
			"Release Engineering",
			"API Design",
		]);
		expect(
			buildPublishingPreferencesSnapshot({ preferredThemes: raw })
				.preferredThemes,
		).toEqual([...perItem].sort());
	});

	it("returns the empty string for every shape that means 'nothing was entered'", () => {
		// What the boundary's piped `.min(1)` turns into a rejection. A rule that
		// returned the input unchanged for these would let a whitespace-only theme
		// through, and the snapshot would then drop it — the row claiming a
		// preference the prompt has never heard of.
		const TAB = String.fromCharCode(9);
		const NEWLINE = String.fromCharCode(10);
		for (const blank of ["", "   ", TAB, NEWLINE + "  " + TAB]) {
			expect(normalizePreferenceLabel(blank)).toBe("");
		}
		// Non-strings collapse to the same answer rather than throwing: this runs
		// on unvalidated stored rows as well as on freshly validated input.
		for (const notAString of [null, undefined, 42, {}, []]) {
			expect(normalizePreferenceLabel(notAString)).toBe("");
		}
	});
});
