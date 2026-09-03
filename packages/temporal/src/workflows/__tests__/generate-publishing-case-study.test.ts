import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Case Study workflow's DEGRADATION BOUNDARY (Fizzy #1854, Phase 2C).
 *
 * Everything here is about what happens when something goes wrong, because that
 * is the whole job of this file in production: the workflow is started and not
 * awaited, so a thrown error is invisible to the caller AND strands the row on
 * GENERATING, where it holds the partial unique index against every retry until
 * the deadline sweep reclaims it.
 */

const activityStubs = vi.hoisted(() => ({
	generateCaseStudyActivity: vi.fn(),
	markCaseStudyFailedActivity: vi.fn(),
}));

// Typed with its options argument so the "two bags, not one" case below can
// read what each `proxyActivities` call was actually given.
const proxyActivities = vi.hoisted(() =>
	vi.fn((_options: Record<string, unknown>) => activityStubs),
);

vi.mock("@temporalio/workflow", () => ({
	proxyActivities,
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { generatePublishingCaseStudyWorkflow } from "../generate-publishing-case-study";

const INPUT = {
	draftId: "d1",
	topicId: "topic_1",
	projectId: "p1",
	organizationId: "org1",
	actorUserId: "u1",
	guidance: null,
};

beforeEach(() => {
	activityStubs.generateCaseStudyActivity.mockReset();
	activityStubs.markCaseStudyFailedActivity.mockReset();
	activityStubs.generateCaseStudyActivity.mockResolvedValue({
		status: "READY",
		seededWorkingDraft: true,
	});
	activityStubs.markCaseStudyFailedActivity.mockResolvedValue(undefined);
});

describe("generatePublishingCaseStudyWorkflow", () => {
	it("returns READY on the happy path", async () => {
		const result = await generatePublishingCaseStudyWorkflow(INPUT);

		expect(result).toEqual({ status: "READY", seededWorkingDraft: true });
		expect(
			activityStubs.markCaseStudyFailedActivity,
		).not.toHaveBeenCalled();
	});

	it("reports whether the first run seeded a working draft", async () => {
		// The observable difference between a first generation and a
		// regeneration: one lands the reader in an editor, the other offers an
		// adopt control instead.
		activityStubs.generateCaseStudyActivity.mockResolvedValue({
			status: "READY",
			seededWorkingDraft: false,
		});

		const result = await generatePublishingCaseStudyWorkflow(INPUT);

		expect(result).toEqual({ status: "READY", seededWorkingDraft: false });
	});

	it("passes the run's guidance through to the activity", async () => {
		// Guidance is carried on the workflow input rather than re-read from the
		// row, so it is what the user typed on THIS click even if a later
		// attempt has since rewritten the column.
		await generatePublishingCaseStudyWorkflow({
			...INPUT,
			guidance: "Write it for a technical buyer",
		});

		expect(activityStubs.generateCaseStudyActivity).toHaveBeenCalledWith(
			expect.objectContaining({
				guidance: "Write it for a technical buyer",
			}),
		);
	});

	it("does NOT mark a SUPERSEDED attempt failed", async () => {
		// A deadline sweep reclaimed this attempt while the model ran and a
		// newer one owns the content type. The row is already terminal, so the
		// write would be refused and the log line would be untrue.
		activityStubs.generateCaseStudyActivity.mockResolvedValue({
			status: "SUPERSEDED",
			seededWorkingDraft: false,
		});

		const result = await generatePublishingCaseStudyWorkflow(INPUT);

		expect(result).toEqual({
			status: "SUPERSEDED",
			seededWorkingDraft: false,
		});
		expect(
			activityStubs.markCaseStudyFailedActivity,
		).not.toHaveBeenCalled();
	});

	it("marks the row FAILED rather than throwing", async () => {
		// Nobody awaits this workflow. Throwing would be invisible and would
		// leave the row holding the in-flight index for ten minutes.
		activityStubs.generateCaseStudyActivity.mockRejectedValue(
			new Error("provider timed out"),
		);

		const result = await generatePublishingCaseStudyWorkflow(INPUT);

		expect(result).toEqual({ status: "FAILED", seededWorkingDraft: false });
		expect(activityStubs.markCaseStudyFailedActivity).toHaveBeenCalledWith(
			expect.objectContaining({
				draftId: "d1",
				projectId: "p1",
				message: "provider timed out",
			}),
		);
	});

	it("still does not throw when the failure marker ITSELF fails", async () => {
		// The last-resort path. Throwing here records the failure twice and
		// reads as a crash.
		activityStubs.generateCaseStudyActivity.mockRejectedValue(
			new Error("provider timed out"),
		);
		activityStubs.markCaseStudyFailedActivity.mockRejectedValue(
			new Error("database unreachable"),
		);

		const result = await generatePublishingCaseStudyWorkflow(INPUT);

		expect(result).toEqual({ status: "FAILED", seededWorkingDraft: false });
	});

	it("handles a non-Error rejection without losing the failure", async () => {
		activityStubs.generateCaseStudyActivity.mockRejectedValue("a string");

		const result = await generatePublishingCaseStudyWorkflow(INPUT);

		expect(result).toEqual({ status: "FAILED", seededWorkingDraft: false });
		expect(activityStubs.markCaseStudyFailedActivity).toHaveBeenCalledWith(
			expect.objectContaining({ message: "Unknown error" }),
		);
	});

	it("gives the failure marker its OWN short-timeout proxy", async () => {
		// Two `proxyActivities` bags, not one. A failure marker inheriting the
		// 480s generation timeout leaves a failing run sitting on GENERATING for
		// another eight minutes, holding the partial unique index against every
		// retry — which is exactly the state this workflow exists to avoid.
		const bags = proxyActivities.mock.calls.map((call) => call[0]);
		expect(bags).toHaveLength(2);

		const generation = bags[0];
		expect(generation.startToCloseTimeout).toBe("480s");
		expect(generation.heartbeatTimeout).toBe("2 minutes");
		expect(generation.retry).toMatchObject({
			maximumAttempts: 3,
			nonRetryableErrorTypes: ["ValidationError", "TenantViolation"],
		});

		const marker = bags[1];
		expect(marker.startToCloseTimeout).toBe("30s");
		expect(marker.heartbeatTimeout).toBeUndefined();
	});
});
