/**
 * `composePrReviewComment` — what Fabric writes into somebody else's repository.
 *
 * This is the only place the product publishes outward, so the body is pinned by
 * test rather than reviewed by eye.
 *
 * Imported from `lib/`, deliberately. These tests used to import the procedure's
 * own copy of the composer, which nothing called: the procedure delegates to the
 * library. Ten tests were pinning a duplicate while the code that actually runs
 * on every webhook and button press was unpinned. Three properties matter and the rest is
 * wording:
 *
 *  1. **The marker is present**, or the next run posts a second comment instead
 *     of editing this one, and a busy pull request collects one per commit.
 *  2. **Dismissed findings are omitted.** Somebody judged them wrong inside
 *     Fabric; republishing them puts a withdrawn verdict back in front of the
 *     team.
 *  3. **An empty result says so.** A comment that renders as a heading with
 *     nothing under it reads as a broken bot.
 */

import { describe, expect, it } from "vitest";

import {
	composePrReviewComment,
	PR_REVIEW_COMMENT_MARKER,
} from "../../../lib/pr-review-comment";

function finding(over: Record<string, unknown> = {}) {
	return {
		id: "f-1",
		lens: "QA",
		severity: "HIGH",
		title: "Retry path is untested",
		detail: "The new retry branch has no case asserting a single capture.",
		recommendation: "Add a case that retries twice and asserts one charge.",
		filePath: "src/payments/capture.ts",
		line: 12,
		storyId: null,
		criterionRef: null,
		status: "OPEN",
		promotedStoryId: null,
		model: "gpt-4.1-mini",
		createdAt: new Date("2026-08-13T00:00:00.000Z"),
		...over,
	} as Parameters<typeof composePrReviewComment>[0]["findings"][number];
}

/**
 * Both lenses ran and completed. The default context for the wording tests —
 * the states where a lens did NOT run have their own describe block below,
 * because telling those apart is the whole point of this argument.
 */
function bothRan(): Parameters<typeof composePrReviewComment>[0]["lenses"] {
	const analysedAt = new Date("2026-08-13T00:00:00.000Z");
	return [
		{ lens: "QA", enabled: true, analysedAt, unavailable: null },
		{ lens: "ARCHITECTURE", enabled: true, analysedAt, unavailable: null },
	];
}

describe("composePrReviewComment", () => {
	it("carries the marker the next run edits in place", () => {
		const body = composePrReviewComment({
			findings: [finding()],
			reviewUrl: null,
			lenses: bothRan(),
		});

		expect(body.startsWith(PR_REVIEW_COMMENT_MARKER)).toBe(true);
	});

	it("states severity, title, location and the recommendation", () => {
		const body = composePrReviewComment({
			findings: [finding()],
			reviewUrl: null,
			lenses: bothRan(),
		});

		expect(body).toContain("**HIGH** — Retry path is untested");
		expect(body).toContain("`src/payments/capture.ts:12`");
		expect(body).toContain(
			"_Recommendation:_ Add a case that retries twice and asserts one charge.",
		);
	});

	it("prints the path alone when no line was verified", () => {
		const body = composePrReviewComment({
			findings: [finding({ line: null })],
			reviewUrl: null,
			lenses: bothRan(),
		});

		expect(body).toContain("`src/payments/capture.ts`");
		expect(body).not.toContain("capture.ts:");
	});

	it("omits the location entirely for an observation about the whole change", () => {
		const body = composePrReviewComment({
			findings: [finding({ filePath: null, line: null })],
			reviewUrl: null,
			lenses: bothRan(),
		});

		expect(body).toContain("Retry path is untested");
		expect(body).not.toContain("``");
	});

	it("groups findings under a heading per lens", () => {
		const body = composePrReviewComment({
			findings: [
				finding(),
				finding({
					id: "f-2",
					lens: "ARCHITECTURE",
					title: "Circular import: a.ts ↔ b.ts",
				}),
			],
			reviewUrl: null,
			lenses: bothRan(),
		});

		expect(body).toContain("### Test coverage");
		expect(body).toContain("### Architecture");
	});

	it("leaves out a finding somebody dismissed", () => {
		const body = composePrReviewComment({
			findings: [
				finding(),
				finding({
					id: "f-2",
					title: "This one was judged wrong",
					status: "DISMISSED",
				}),
			],
			reviewUrl: null,
			lenses: bothRan(),
		});

		expect(body).toContain("Retry path is untested");
		expect(body).not.toContain("This one was judged wrong");
	});

	it("says plainly when nothing is outstanding", () => {
		const body = composePrReviewComment({
			findings: [finding({ status: "DISMISSED" })],
			reviewUrl: null,
			lenses: bothRan(),
		});

		expect(body).toContain("No open findings");
	});

	it("states that it blocks nothing, with or without a link back", () => {
		const linked = composePrReviewComment({
			findings: [finding()],
			reviewUrl: "https://app.example.com/review",
			lenses: bothRan(),
		});
		const bare = composePrReviewComment({
			findings: [finding()],
			reviewUrl: null,
			lenses: bothRan(),
		});

		expect(linked).toContain("Advisory only");
		expect(linked).toContain("https://app.example.com/review");
		expect(bare).toContain("Advisory only");
		expect(bare).not.toContain("](");
	});

	it("flattens a multi-line detail so the list stays a list", () => {
		const body = composePrReviewComment({
			findings: [finding({ detail: "First line.\n\nSecond line." })],
			reviewUrl: null,
			lenses: bothRan(),
		});

		expect(body).toContain("First line. Second line.");
	});
});

/**
 * The defect QA measured, expressed as its own measurement.
 *
 * Four states — a clean pass, a crashed lens, a project with no AI provider, and
 * both lenses switched off — produced ONE byte-identical body: "No open
 * findings. The lenses that ran on this pull request reported nothing
 * outstanding." Read on a pull request that is a clean bill of health, and in
 * three of those four states nothing had been checked at all.
 *
 * QA's count was "distinct bodies across the four states = 1". This asserts 4.
 */
describe("a comment must not claim a clean pass it did not earn", () => {
	const analysedAt = new Date("2026-08-13T00:00:00.000Z");

	const cleanPass = [
		{ lens: "QA", enabled: true, analysedAt, unavailable: null },
		{ lens: "ARCHITECTURE", enabled: true, analysedAt, unavailable: null },
	];
	const crashedLens = [
		{
			lens: "QA",
			enabled: true,
			analysedAt: null,
			unavailable: "failed" as const,
		},
		{ lens: "ARCHITECTURE", enabled: true, analysedAt, unavailable: null },
	];
	const noAiProvider = [
		{
			lens: "QA",
			enabled: true,
			analysedAt: null,
			unavailable: "no-ai-provider" as const,
		},
		{ lens: "ARCHITECTURE", enabled: true, analysedAt, unavailable: null },
	];
	const bothOff = [
		{ lens: "QA", enabled: false, analysedAt: null, unavailable: null },
		{
			lens: "ARCHITECTURE",
			enabled: false,
			analysedAt: null,
			unavailable: null,
		},
	];

	const states = { cleanPass, crashedLens, noAiProvider, bothOff };

	function bodyFor(lenses: (typeof states)[keyof typeof states]) {
		return composePrReviewComment({
			findings: [],
			reviewUrl: null,
			lenses,
		});
	}

	it("produces a DISTINCT body for each of the four states", () => {
		const bodies = Object.values(states).map(bodyFor);

		expect(new Set(bodies).size).toBe(4);
	});

	it("claims a clean pass only when every lens actually ran", () => {
		expect(bodyFor(cleanPass)).toContain(
			"Every lens ran on this pull request and reported nothing outstanding",
		);
		for (const name of [
			"crashedLens",
			"noAiProvider",
			"bothOff",
		] as const) {
			expect(bodyFor(states[name])).not.toContain("Every lens ran");
		}
	});

	it("says nothing was checked when no lens ran", () => {
		const body = bodyFor(bothOff);

		expect(body).toContain("No lens ran on this pull request");
		expect(body).toContain("not a clean bill of health");
		expect(body).toContain("switched off for this project");
	});

	it("names the lens that did not complete, and why", () => {
		expect(bodyFor(crashedLens)).toContain("did not complete on this run");
		expect(bodyFor(noAiProvider)).toContain(
			"no AI provider is configured for this project",
		);
	});

	it("still reports the lens that DID run when its partner failed", () => {
		const body = bodyFor(crashedLens);

		expect(body).toContain("**Architecture** — ran, nothing outstanding.");
		expect(body).toContain("not every lens ran");
	});
});

/**
 * A lens can be switched off AFTER it ran.
 *
 * `enabled` is read from the project's CURRENT settings; `analysedAt` and the
 * findings come from the stored review. A comment gets retried when its first
 * attempt never reached the host, so by then the switch may have moved. The body
 * then listed the lens's findings and, a few lines below, announced that the lens
 * was switched off and nothing had been checked — one comment contradicting
 * itself in front of the customer's team.
 */
describe("a lens switched off after it ran", () => {
	const analysedAt = new Date("2026-08-19T10:00:00.000Z");

	it("does not claim nothing was checked when it demonstrably was", () => {
		const body = composePrReviewComment({
			findings: [finding()],
			reviewUrl: null,
			lenses: [
				{ lens: "QA", enabled: false, analysedAt, unavailable: null },
				{
					lens: "ARCHITECTURE",
					enabled: true,
					analysedAt,
					unavailable: null,
				},
			],
		});

		// The finding is still listed, so the status line must not contradict it.
		expect(body).toContain("Retry path is untested");
		expect(body).not.toContain("Nothing was checked");
		expect(body).toContain(
			"ran earlier, and has since been switched off for this project",
		);
	});

	it("still says nothing was checked when the lens never ran at all", () => {
		const body = composePrReviewComment({
			findings: [],
			reviewUrl: null,
			lenses: [
				{
					lens: "QA",
					enabled: false,
					analysedAt: null,
					unavailable: null,
				},
			],
		});

		expect(body).toContain("Nothing was checked");
	});
});
