import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { firstCallPosition } from "./_ast-guards";

/**
 * What a refused terminal write says, and how loudly.
 *
 * Four causes used to arrive at fifteen call sites as one bare
 * `{ persisted: false }`, and all fifteen logged the same word: "superseded".
 * That is true of exactly one of them. An operator reading it for the other two goes
 * looking for the newer attempt that supposedly took over, finds none, and ends
 * the investigation more confused than it started — which is a worse outcome
 * than a line that said nothing at all.
 */

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { logDraftRefusal } from "@repo/database";
import { logger } from "@repo/logs";

beforeEach(() => {
	vi.clearAllMocks();
});

describe("logDraftRefusal", () => {
	it("keeps a routine supersession at info", () => {
		// The deadline sweep reclaiming a stale attempt is the system working.
		logDraftRefusal(
			"[publishing-blog-post] draft not committed",
			"superseded",
			{
				draftId: "d1",
			},
		);

		expect(logger.info).toHaveBeenCalledTimes(1);
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it.each([
		"project_ineligible",
		"tenant_changed",
		"attempt_missing",
	] as const)(
		"raises %s to warn — somebody acted on the project mid-run",
		(reason) => {
			logDraftRefusal(
				"[publishing-blog-post] draft not committed",
				reason,
				{
					draftId: "d1",
				},
			);

			expect(logger.warn).toHaveBeenCalledTimes(1);
			expect(logger.info).not.toHaveBeenCalled();
		},
	);

	it("says something different for each reason, and never says superseded for the others", () => {
		// The failure mode being removed is one sentence for three causes. A
		// table with a shared fallback would satisfy a "was it logged" check
		// while reproducing exactly the defect.
		const said = (
			[
				"superseded",
				"project_ineligible",
				"tenant_changed",
				"attempt_missing",
			] as const
		).map((reason) => {
			vi.clearAllMocks();
			logDraftRefusal("[x] draft not committed", reason, {});
			const call =
				(logger.info as unknown as { mock: { calls: unknown[][] } })
					.mock.calls[0] ??
				(logger.warn as unknown as { mock: { calls: unknown[][] } })
					.mock.calls[0];
			return String(call[0]);
		});

		expect(new Set(said).size).toBe(4);
		expect(said[0]).toMatch(/newer attempt/i);
		expect(said[1]).toMatch(/archived or deleted/i);
		expect(said[1]).not.toMatch(/supersede/i);
		expect(said[2]).toMatch(/different organization/i);
		expect(said[2]).not.toMatch(/supersede/i);
		expect(said[3]).toMatch(/no longer exists/i);
		expect(said[3]).not.toMatch(/supersede/i);
	});

	it("puts the reason in the structured bag, not only in the sentence", () => {
		// A human reads the sentence; a query reads the field. Without it,
		// counting how often a project was archived mid-generation means
		// grepping prose.
		logDraftRefusal("[x] draft not committed", "project_ineligible", {
			draftId: "d1",
			projectId: "p1",
		});

		expect(logger.warn).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				draftId: "d1",
				projectId: "p1",
				reason: "project_ineligible",
			}),
		);
	});
});

describe("every publishing terminal write reports its refusal through the table", () => {
	// The rule is only worth having if ALL of the sites obey it, and only a few
	// are exercised by a suite of their own. A file-by-file structural check is
	// what stops the rest drifting back to a hand-written sentence.
	//
	// Fifteen, not ten. The first draft of this guard listed only the Temporal
	// activities, and adversarial review found the five it had missed: each
	// generation procedure rolls its own attempt back when the workflow start
	// fails, and those calls discarded the result entirely. A completeness
	// guard that is itself incomplete is the worst of both, because it reads as
	// proof.
	//
	// `firstCallPosition` and not a source-text search: the comment above each
	// call describes the reasons in prose, so a grep for "superseded" would
	// report the comment, and a grep for the helper name would stay green after
	// the call itself was deleted.
	const PACKAGES = join(__dirname, "..", "..", "..", "..", "..");
	const SITES = [
		"temporal/src/activities/publishing-blog-post/generate-blog-post.ts",
		"temporal/src/activities/publishing-blog-post/mark-blog-post-failed.ts",
		"temporal/src/activities/publishing-case-study/generate-case-study.ts",
		"temporal/src/activities/publishing-case-study/mark-case-study-failed.ts",
		"temporal/src/activities/publishing-short-post/generate-short-post.ts",
		"temporal/src/activities/publishing-short-post/mark-short-post-failed.ts",
		"temporal/src/activities/publishing-stakeholder-email/generate-stakeholder-email.ts",
		"temporal/src/activities/publishing-stakeholder-email/mark-stakeholder-email-failed.ts",
		"temporal/src/activities/publishing-planning/generate-planning-analysis.ts",
		"temporal/src/activities/publishing-planning/mark-planning-analysis-failed.ts",
		"api/modules/projects/procedures/publishing-suite/blog-post.ts",
		"api/modules/projects/procedures/publishing-suite/case-study.ts",
		"api/modules/projects/procedures/publishing-suite/short-post.ts",
		"api/modules/projects/procedures/publishing-suite/stakeholder-email.ts",
		"api/modules/projects/procedures/publishing-suite/planning-analysis.ts",
	];

	it("lists every site — a short completeness guard is worse than none", () => {
		expect(SITES).toHaveLength(15);
	});

	for (const file of SITES) {
		it(`${file} calls logDraftRefusal`, () => {
			expect(
				firstCallPosition(join(PACKAGES, file), "logDraftRefusal"),
			).toBeGreaterThan(-1);
		});
	}
});
