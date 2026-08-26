/**
 * The Job Hub row a type conversion opened is closed from the workflow side,
 * driven off the redraft activity's TYPED status (Fizzy #2048).
 *
 * The mapping is the point of these tests: only `regenerated` wrote a body, so
 * only `regenerated` closes green. Every other outcome left the prior body in
 * place — the safe result, but not the one the user asked for — and closing
 * those COMPLETED would tell them their item was rewritten when it was not.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	jobComplete: vi.fn(),
	jobFail: vi.fn(),
}));

vi.mock("../src/activities/lib/job-progress", () => ({
	jobComplete: mocks.jobComplete,
	jobFail: mocks.jobFail,
}));

import { closeRegenerationJobActivity } from "../src/activities/stories/close-regeneration-job";

beforeEach(() => {
	vi.clearAllMocks();
});

describe("closeRegenerationJobActivity", () => {
	it("closes the row COMPLETED when the body was actually regenerated", async () => {
		await closeRegenerationJobActivity({
			storyId: "story-1",
			status: "regenerated",
		});

		expect(mocks.jobComplete).toHaveBeenCalledWith({ sourceId: "story-1" });
		expect(mocks.jobFail).not.toHaveBeenCalled();
	});

	it.each([
		"story_not_found",
		"model_did_not_run",
		"below_content_floor",
		"stale",
		"workflow_error",
	] as const)(
		"closes the row FAILED, carrying %s as the error class",
		async (status) => {
			await closeRegenerationJobActivity({ storyId: "story-1", status });

			expect(mocks.jobComplete).not.toHaveBeenCalled();
			expect(mocks.jobFail).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({
					sourceId: "story-1",
					errorClass: status,
				}),
			);
		},
	);

	/**
	 * The message is rendered verbatim in the Job Hub. Every refusal has to say
	 * the previous body was kept — that is the fact the user needs before
	 * deciding whether to convert again.
	 */
	it.each([
		"story_not_found",
		"model_did_not_run",
		"below_content_floor",
		"stale",
		"workflow_error",
	] as const)("tells the user their body survived %s", async (status) => {
		await closeRegenerationJobActivity({ storyId: "story-1", status });

		const message = mocks.jobFail.mock.calls[0]?.[0] as string;
		expect(message.toLowerCase()).toMatch(/kept|not rewritten/);
	});
});
