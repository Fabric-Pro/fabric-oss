/**
 * The exact text each of the four states writes into a customer's pull request.
 *
 * QA's headline measurement was "distinct bodies across the four states = 1": a
 * clean pass, a crashed lens, a project with no AI provider and both lenses
 * switched off all produced the same sentence, which on a pull request reads as a
 * clean bill of health.
 *
 * `post-review-comment.test.ts` asserts the count is 4. This file pins the actual
 * WORDING, because the wording is the product here — it is the only thing Fabric
 * publishes outward, and "distinct" is not the same as "truthful". A body that
 * changed by accident fails here with a readable diff.
 */

import { describe, expect, it } from "vitest";

import { composePrReviewComment } from "../pr-review-comment";

const ANALYSED = new Date("2026-08-19T09:00:00.000Z");

const ran = (lens: string) => ({
	lens,
	enabled: true,
	analysedAt: ANALYSED,
	unavailable: null,
});
const failed = (lens: string) => ({
	lens,
	enabled: true,
	analysedAt: null,
	unavailable: "failed" as const,
});
const noProvider = (lens: string) => ({
	lens,
	enabled: true,
	analysedAt: null,
	unavailable: "no-ai-provider" as const,
});
const off = (lens: string) => ({
	lens,
	enabled: false,
	analysedAt: null,
	unavailable: null,
});

const body = (lenses: Parameters<typeof composePrReviewComment>[0]["lenses"]) =>
	composePrReviewComment({ findings: [], reviewUrl: null, lenses });

describe("what each of the four states publishes", () => {
	it("1. both lenses ran and found nothing — the only clean bill of health", () => {
		expect(body([ran("QA"), ran("ARCHITECTURE")])).toBe(
			[
				"<!-- fabric-pr-review -->",
				"## Fabric review",
				"",
				"No open findings. Every lens ran on this pull request and reported nothing outstanding.",
				"",
				"### What ran",
				"",
				"- **Test coverage** — ran, nothing outstanding.",
				"- **Architecture** — ran, nothing outstanding.",
				"",
				"Advisory only — this comment blocks nothing.",
			].join("\n"),
		);
	});

	it("2. a lens crashed — says so, and does not claim the run was clean", () => {
		expect(body([failed("QA"), ran("ARCHITECTURE")])).toBe(
			[
				"<!-- fabric-pr-review -->",
				"## Fabric review",
				"",
				"No open findings from the lenses that ran — but **not every lens ran**, so this is not a clean bill of health. See below.",
				"",
				"### What ran",
				"",
				"- **Test coverage** — did not complete on this run. Fabric will try again on the next push.",
				"- **Architecture** — ran, nothing outstanding.",
				"",
				"Advisory only — this comment blocks nothing.",
			].join("\n"),
		);
	});

	it("3. no AI provider — names the reason rather than reporting silence as health", () => {
		expect(body([noProvider("QA"), ran("ARCHITECTURE")])).toBe(
			[
				"<!-- fabric-pr-review -->",
				"## Fabric review",
				"",
				"No open findings from the lenses that ran — but **not every lens ran**, so this is not a clean bill of health. See below.",
				"",
				"### What ran",
				"",
				"- **Test coverage** — did not run: no AI provider is configured for this project.",
				"- **Architecture** — ran, nothing outstanding.",
				"",
				"Advisory only — this comment blocks nothing.",
			].join("\n"),
		);
	});

	it("4. both lenses off — nothing was checked, and the comment says exactly that", () => {
		// The automatic path no longer posts in this state at all (see
		// `pr-review-run.ts`). The body is still pinned, because a person can
		// reach it from the button and because "checked nothing" must never again
		// render as "nothing outstanding".
		expect(body([off("QA"), off("ARCHITECTURE")])).toBe(
			[
				"<!-- fabric-pr-review -->",
				"## Fabric review",
				"",
				"**No lens ran on this pull request**, so this is not a clean bill of health — nothing was checked. See below.",
				"",
				"### What ran",
				"",
				"- **Test coverage** — switched off for this project. Nothing was checked.",
				"- **Architecture** — switched off for this project. Nothing was checked.",
				"",
				"Advisory only — this comment blocks nothing.",
			].join("\n"),
		);
	});

	it("all four differ — QA counted 1 distinct body", () => {
		const bodies = [
			body([ran("QA"), ran("ARCHITECTURE")]),
			body([failed("QA"), ran("ARCHITECTURE")]),
			body([noProvider("QA"), ran("ARCHITECTURE")]),
			body([off("QA"), off("ARCHITECTURE")]),
		];

		expect(new Set(bodies).size).toBe(4);
	});
});
