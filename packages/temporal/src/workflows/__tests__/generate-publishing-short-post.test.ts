import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Short Post workflow's DEGRADATION BOUNDARY (Fizzy #1853, Phase 2B-2).
 *
 * Everything here is about what happens when something goes wrong, because that
 * is the whole job of this file in production: the workflow is started and not
 * awaited, so a thrown error is invisible to the caller AND strands the row on
 * GENERATING, where it holds the partial unique index against every retry until
 * the deadline sweep reclaims it.
 */

const activityStubs = vi.hoisted(() => ({
	generateShortPostActivity: vi.fn(),
	markShortPostFailedActivity: vi.fn(),
}));

vi.mock("@temporalio/workflow", () => ({
	proxyActivities: vi.fn(() => activityStubs),
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { generatePublishingShortPostWorkflow } from "../generate-publishing-short-post";

const INPUT = {
	draftId: "d1",
	topicId: "topic_1",
	projectId: "p1",
	organizationId: "org1",
	actorUserId: "u1",
	guidance: null,
};

beforeEach(() => {
	vi.clearAllMocks();
	activityStubs.generateShortPostActivity.mockResolvedValue({
		status: "READY",
	});
	activityStubs.markShortPostFailedActivity.mockResolvedValue(undefined);
});

describe("generatePublishingShortPostWorkflow", () => {
	it("returns READY on the happy path", async () => {
		const result = await generatePublishingShortPostWorkflow(INPUT);

		expect(result).toEqual({ status: "READY" });
		expect(
			activityStubs.markShortPostFailedActivity,
		).not.toHaveBeenCalled();
	});

	it("passes the run's guidance through to the activity", async () => {
		// Guidance is carried on the workflow input rather than re-read from the
		// row, so it is what the user typed on THIS click even if a later attempt
		// has since rewritten the column.
		await generatePublishingShortPostWorkflow({
			...INPUT,
			guidance: "Keep it under 200 characters",
		});

		expect(activityStubs.generateShortPostActivity).toHaveBeenCalledWith(
			expect.objectContaining({
				guidance: "Keep it under 200 characters",
			}),
		);
	});

	it("never throws to the fire-and-forget caller; flips the row FAILED instead", async () => {
		activityStubs.generateShortPostActivity.mockRejectedValue(
			new Error("model timeout"),
		);

		const result = await generatePublishingShortPostWorkflow(INPUT);

		expect(result).toEqual({ status: "FAILED" });
		expect(activityStubs.markShortPostFailedActivity).toHaveBeenCalledWith({
			draftId: "d1",
			projectId: "p1",
			message: "model timeout",
		});
	});

	it("does NOT mark a superseded attempt failed", async () => {
		// SUPERSEDED means a deadline sweep reclaimed this attempt while the model
		// ran and a newer one owns the content type. The row is already terminal,
		// so the CAS would refuse the write and the log line would be untrue.
		activityStubs.generateShortPostActivity.mockResolvedValue({
			status: "SUPERSEDED",
		});

		const result = await generatePublishingShortPostWorkflow(INPUT);

		expect(result).toEqual({ status: "SUPERSEDED" });
		expect(
			activityStubs.markShortPostFailedActivity,
		).not.toHaveBeenCalled();
	});

	it("still returns FAILED when even the failure marker throws", async () => {
		// The row will sit GENERATING until the deadline sweep. Nothing further
		// this workflow can do — but it must not throw, or the failure is recorded
		// twice and read as a crash.
		activityStubs.generateShortPostActivity.mockRejectedValue(
			new Error("model timeout"),
		);
		activityStubs.markShortPostFailedActivity.mockRejectedValue(
			new Error("database unreachable"),
		);

		await expect(
			generatePublishingShortPostWorkflow(INPUT),
		).resolves.toEqual({ status: "FAILED" });
	});

	it("survives a non-Error rejection", async () => {
		// A provider SDK can reject with a string or a plain object. Reading
		// `.message` off one is how a degradation boundary becomes the crash it
		// exists to prevent.
		activityStubs.generateShortPostActivity.mockRejectedValue(
			"just a string",
		);

		const result = await generatePublishingShortPostWorkflow(INPUT);

		expect(result).toEqual({ status: "FAILED" });
		expect(activityStubs.markShortPostFailedActivity).toHaveBeenCalledWith(
			expect.objectContaining({ message: "Unknown error" }),
		);
	});
});
