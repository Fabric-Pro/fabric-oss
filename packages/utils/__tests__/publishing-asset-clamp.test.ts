import { describe, expect, it } from "vitest";
import {
	ASSET_CONFIRMATION_ANSWERS,
	assetConfirmationScope,
	clampConfirmedAssets,
	promoteConfirmedAssets,
	scopeCoversPostType,
} from "../lib/publishing-asset-clamp";

describe("assetConfirmationScope", () => {
	it("reads each offered answer back as its scope", () => {
		expect(
			assetConfirmationScope(ASSET_CONFIRMATION_ANSWERS.ANY_AUDIENCE),
		).toBe("ANY_AUDIENCE");
		expect(
			assetConfirmationScope(ASSET_CONFIRMATION_ANSWERS.INTERNAL_ONLY),
		).toBe("INTERNAL_ONLY");
		expect(
			assetConfirmationScope(ASSET_CONFIRMATION_ANSWERS.NOT_APPROVED),
		).toBe("NOT_APPROVED");
	});

	it("tolerates the casing and spacing an answer picks up in transit", () => {
		expect(
			assetConfirmationScope(
				"  Confirmed — CLEARED for any   audience.  ",
			),
		).toBe("ANY_AUDIENCE");
	});

	it("grants nothing mechanical for a typed answer", () => {
		// The answer still reaches the model in the settled-decisions block.
		// What it must not do is move an asset into the cleared list.
		expect(assetConfirmationScope("yes, go ahead")).toBeNull();
		expect(assetConfirmationScope("Confirmed")).toBeNull();
		expect(assetConfirmationScope("")).toBeNull();
		expect(assetConfirmationScope(null)).toBeNull();
	});
});

describe("scopeCoversPostType", () => {
	it("clears every format on an any-audience confirmation", () => {
		for (const postType of [
			"TWEET",
			"BLOG_POST",
			"CASE_STUDY",
			"STAKEHOLDER_EMAIL",
			"LINKEDIN_POST",
			"WEBINAR_SCRIPT",
			"NEWSLETTER_BLURB",
		]) {
			expect(scopeCoversPostType("ANY_AUDIENCE", postType)).toBe(true);
		}
	});

	it("clears no published format on an internal-only confirmation", () => {
		// The gap this closes: a binary clamp stopped restricting the moment a
		// thread was settled, so "internal use only" unlocked the asset
		// everywhere. Every format the suite writes leaves the company.
		for (const postType of [
			"CASE_STUDY",
			"WEBINAR_SCRIPT",
			"NEWSLETTER_BLURB",
			"STAKEHOLDER_EMAIL",
		]) {
			expect(scopeCoversPostType("INTERNAL_ONLY", postType)).toBe(false);
		}
	});

	it("clears nothing on a refusal", () => {
		expect(scopeCoversPostType("NOT_APPROVED", "BLOG_POST")).toBe(false);
	});
});

describe("promoteConfirmedAssets", () => {
	const base = {
		confirmed: ["the architecture diagram"],
		needsConfirmation: ["the latency chart", "the demo recording"],
		postType: "WEBINAR_SCRIPT",
	};

	it("moves an asset a member cleared for any audience", () => {
		const result = promoteConfirmedAssets({
			...base,
			settled: [{ label: "the latency chart", scope: "ANY_AUDIENCE" }],
		});
		expect(result.confirmed).toEqual([
			"the architecture diagram",
			"the latency chart",
		]);
		expect(result.needsConfirmation).toEqual(["the demo recording"]);
		expect(result.promoted).toEqual([
			{ label: "the latency chart", scope: "ANY_AUDIENCE" },
		]);
	});

	it("matches across casing and spacing, as the clamp does", () => {
		const result = promoteConfirmedAssets({
			...base,
			settled: [{ label: "The  Latency   Chart", scope: "ANY_AUDIENCE" }],
		});
		expect(result.promoted).toHaveLength(1);
		expect(result.needsConfirmation).toEqual(["the demo recording"]);
	});

	it("does NOT promote on a containment near-match", () => {
		// The asymmetry that matters. Containment is right for the clamp, where
		// over-matching demotes; here it would present an asset as cleared
		// because a member confirmed a different, longer-named one.
		const result = promoteConfirmedAssets({
			...base,
			settled: [
				{
					label: "the latency chart from the internal deck",
					scope: "ANY_AUDIENCE",
				},
			],
		});
		expect(result.promoted).toEqual([]);
		expect(result.needsConfirmation).toEqual([
			"the latency chart",
			"the demo recording",
		]);
	});

	it("does NOT promote an internal-only confirmation into a published format", () => {
		const result = promoteConfirmedAssets({
			...base,
			settled: [{ label: "the latency chart", scope: "INTERNAL_ONLY" }],
		});
		expect(result.promoted).toEqual([]);
		expect(result.needsConfirmation).toContain("the latency chart");
	});

	it("does NOT promote a refusal", () => {
		const result = promoteConfirmedAssets({
			...base,
			settled: [{ label: "the latency chart", scope: "NOT_APPROVED" }],
		});
		expect(result.promoted).toEqual([]);
		expect(result.needsConfirmation).toContain("the latency chart");
	});

	it("leaves both lists untouched when nothing is settled", () => {
		const result = promoteConfirmedAssets({ ...base, settled: [] });
		expect(result.confirmed).toEqual(base.confirmed);
		expect(result.needsConfirmation).toEqual(base.needsConfirmation);
		expect(result.promoted).toEqual([]);
	});

	it("does not list an asset twice when the model already claimed it", () => {
		const result = promoteConfirmedAssets({
			confirmed: ["The Latency Chart"],
			needsConfirmation: ["the latency chart"],
			postType: "CASE_STUDY",
			settled: [{ label: "the latency chart", scope: "ANY_AUDIENCE" }],
		});
		expect(result.confirmed).toEqual(["The Latency Chart"]);
		expect(result.needsConfirmation).toEqual([]);
	});
});

describe("promote then clamp — the order the activities run them in", () => {
	it("puts a promoted asset back when a thread still restricts it", () => {
		// A member cleared the chart, and a DIFFERENT approval — an unresolved
		// internal-UI question — still names it. The clamp runs last precisely
		// so the newer restriction wins over the older confirmation.
		const promoted = promoteConfirmedAssets({
			confirmed: [],
			needsConfirmation: ["the latency chart"],
			postType: "CASE_STUDY",
			settled: [{ label: "the latency chart", scope: "ANY_AUDIENCE" }],
		});
		expect(promoted.confirmed).toEqual(["the latency chart"]);

		const clamped = clampConfirmedAssets({
			confirmed: promoted.confirmed,
			needsConfirmation: promoted.needsConfirmation,
			restricted: [{ kind: "INTERNAL_UI", label: "latency chart" }],
		});
		expect(clamped.confirmed).toEqual([]);
		expect(clamped.needsConfirmation).toEqual(["the latency chart"]);
		expect(clamped.moved).toEqual([
			{ label: "the latency chart", kind: "INTERNAL_UI" },
		]);
	});
});

describe("assetConfirmationScope — the planning analysis's own options", () => {
	// These predate the loop and sit answered on live topics. Without them the
	// loop would only ever close for questions a draft raised itself.
	it("reads the analysis's approval as an any-audience confirmation", () => {
		expect(
			assetConfirmationScope(
				"Approved — the draft may use the latency chart.",
			),
		).toBe("ANY_AUDIENCE");
	});

	it("reads the analysis's refusal as a refusal", () => {
		expect(
			assetConfirmationScope(
				"Not approved — leave the latency chart out.",
			),
		).toBe("NOT_APPROVED");
	});

	it("promotes an asset the analysis asked about and a member approved", () => {
		const result = promoteConfirmedAssets({
			confirmed: [],
			needsConfirmation: ["the latency chart"],
			postType: "CASE_STUDY",
			settled: [
				{
					label: "the latency chart",
					scope: assetConfirmationScope(
						"Approved — the draft may use the latency chart.",
					) as "ANY_AUDIENCE",
				},
			],
		});
		expect(result.confirmed).toEqual(["the latency chart"]);
	});

	it("still grants nothing for an answer that only mentions approval", () => {
		expect(assetConfirmationScope("I approved this yesterday")).toBeNull();
	});
});
