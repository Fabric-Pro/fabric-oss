import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Blog Post workflow's DEGRADATION BOUNDARY (Fizzy #1853, Phase 2B-3).
 *
 * Everything here is about what happens when something goes wrong, because that
 * is the whole job of this file in production: the workflow is started and not
 * awaited, so a thrown error is invisible to the caller AND strands the row on
 * GENERATING, where it holds the partial unique index against every retry until
 * the deadline sweep reclaims it.
 */

const activityStubs = vi.hoisted(() => ({
	generateBlogPostActivity: vi.fn(),
	markBlogPostFailedActivity: vi.fn(),
}));

vi.mock("@temporalio/workflow", () => ({
	proxyActivities: vi.fn(() => activityStubs),
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { generatePublishingBlogPostWorkflow } from "../generate-publishing-blog-post";

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
	activityStubs.generateBlogPostActivity.mockResolvedValue({
		status: "READY",
		seededWorkingDraft: true,
	});
	activityStubs.markBlogPostFailedActivity.mockResolvedValue(undefined);
});

describe("generatePublishingBlogPostWorkflow", () => {
	it("returns READY on the happy path", async () => {
		const result = await generatePublishingBlogPostWorkflow(INPUT);

		expect(result).toEqual({ status: "READY", seededWorkingDraft: true });
		expect(activityStubs.markBlogPostFailedActivity).not.toHaveBeenCalled();
	});

	it("reports whether the first run seeded a working draft", async () => {
		// The observable difference between a first generation and a
		// regeneration: one lands the reader in an editor, the other offers an
		// adopt control instead.
		activityStubs.generateBlogPostActivity.mockResolvedValue({
			status: "READY",
			seededWorkingDraft: false,
		});

		const result = await generatePublishingBlogPostWorkflow(INPUT);

		expect(result).toEqual({ status: "READY", seededWorkingDraft: false });
	});

	it("passes the run's guidance through to the activity", async () => {
		// Guidance is carried on the workflow input rather than re-read from the
		// row, so it is what the user typed on THIS click even if a later attempt
		// has since rewritten the column.
		await generatePublishingBlogPostWorkflow({
			...INPUT,
			guidance: "Aim it at platform teams",
		});

		expect(activityStubs.generateBlogPostActivity).toHaveBeenCalledWith(
			expect.objectContaining({ guidance: "Aim it at platform teams" }),
		);
	});

	it("does NOT mark a SUPERSEDED attempt failed", async () => {
		// A deadline sweep reclaimed this attempt while the model ran and a
		// newer one owns the content type. The row is already terminal, so the
		// write would be refused and the log line would be untrue.
		activityStubs.generateBlogPostActivity.mockResolvedValue({
			status: "SUPERSEDED",
			seededWorkingDraft: false,
		});

		const result = await generatePublishingBlogPostWorkflow(INPUT);

		expect(result).toEqual({
			status: "SUPERSEDED",
			seededWorkingDraft: false,
		});
		expect(activityStubs.markBlogPostFailedActivity).not.toHaveBeenCalled();
	});

	it("marks the row FAILED rather than throwing", async () => {
		// Nobody awaits this workflow. Throwing would be invisible and would
		// leave the row holding the in-flight index for ten minutes.
		activityStubs.generateBlogPostActivity.mockRejectedValue(
			new Error("provider timed out"),
		);

		const result = await generatePublishingBlogPostWorkflow(INPUT);

		expect(result).toEqual({ status: "FAILED", seededWorkingDraft: false });
		expect(activityStubs.markBlogPostFailedActivity).toHaveBeenCalledWith(
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
		activityStubs.generateBlogPostActivity.mockRejectedValue(
			new Error("provider timed out"),
		);
		activityStubs.markBlogPostFailedActivity.mockRejectedValue(
			new Error("database unreachable"),
		);

		const result = await generatePublishingBlogPostWorkflow(INPUT);

		expect(result).toEqual({ status: "FAILED", seededWorkingDraft: false });
	});

	it("handles a non-Error rejection without losing the failure", async () => {
		activityStubs.generateBlogPostActivity.mockRejectedValue("a string");

		const result = await generatePublishingBlogPostWorkflow(INPUT);

		expect(result).toEqual({ status: "FAILED", seededWorkingDraft: false });
		expect(activityStubs.markBlogPostFailedActivity).toHaveBeenCalledWith(
			expect.objectContaining({ message: "Unknown error" }),
		);
	});
});
