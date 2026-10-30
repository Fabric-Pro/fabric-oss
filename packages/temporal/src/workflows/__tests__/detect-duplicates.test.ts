import { beforeEach, describe, expect, it, vi } from "vitest";
import { detectDuplicatesWorkflow } from "../detect-duplicates";

const mocks = vi.hoisted(() => ({
	detectDuplicateStoriesActivity: vi.fn(),
	/** Whether the execution was started after the runs moved into the workflow. */
	patched: vi.fn(() => true),
}));

vi.mock("@temporalio/workflow", () => ({
	patched: mocks.patched,
	proxyActivities: vi.fn(() => ({
		detectDuplicateStoriesActivity: mocks.detectDuplicateStoriesActivity,
	})),
}));

const input = {
	projectId: "project-1",
	userId: "user-1",
	organizationId: "org-1",
	targetStoryIds: ["story-1", "story-2"],
};

function run(truncated: number, verifierFailures = 0) {
	return {
		scanned: 22,
		candidates: 60,
		confirmed: 50,
		truncated,
		verifierFailures,
	};
}

beforeEach(() => {
	mocks.detectDuplicateStoriesActivity.mockReset();
	mocks.patched.mockReset().mockReturnValue(true);
});

describe("detectDuplicatesWorkflow", () => {
	it("runs once when the first run verifies every candidate pair", async () => {
		mocks.detectDuplicateStoriesActivity.mockResolvedValueOnce(run(0));

		const result = await detectDuplicatesWorkflow(input);

		expect(mocks.detectDuplicateStoriesActivity).toHaveBeenCalledTimes(1);
		expect(result).toEqual({
			scanned: 22,
			candidates: 60,
			confirmed: 50,
			truncated: 0,
		});
	});

	it("runs again, each run its own activity, until no pairs are left over", async () => {
		mocks.detectDuplicateStoriesActivity
			.mockResolvedValueOnce(run(31))
			.mockResolvedValueOnce({
				...run(0),
				candidates: 31,
				confirmed: 30,
			});

		const result = await detectDuplicatesWorkflow(input);

		expect(mocks.detectDuplicateStoriesActivity).toHaveBeenCalledTimes(2);
		expect(mocks.detectDuplicateStoriesActivity).toHaveBeenNthCalledWith(
			2,
			input,
		);
		expect(result).toEqual({
			scanned: 22,
			candidates: 91,
			confirmed: 80,
			truncated: 0,
		});
	});

	it("stops after five runs when pairs keep being left over", async () => {
		mocks.detectDuplicateStoriesActivity.mockResolvedValue(run(1));

		const result = await detectDuplicatesWorkflow(input);

		expect(mocks.detectDuplicateStoriesActivity).toHaveBeenCalledTimes(5);
		expect(result.truncated).toBe(1);
	});

	it("does not run again after a run that could not verify some pairs", async () => {
		mocks.detectDuplicateStoriesActivity.mockResolvedValueOnce(run(31, 1));

		const result = await detectDuplicatesWorkflow(input);

		expect(mocks.detectDuplicateStoriesActivity).toHaveBeenCalledTimes(1);
		expect(result.truncated).toBe(31);
	});

	it("keeps an execution started before the change to its single activity call", async () => {
		mocks.patched.mockReturnValue(false);
		mocks.detectDuplicateStoriesActivity.mockResolvedValueOnce(run(31));

		const result = await detectDuplicatesWorkflow(input);

		expect(mocks.patched).toHaveBeenCalledWith(
			"detect-duplicates-runs-in-workflow",
		);
		expect(mocks.detectDuplicateStoriesActivity).toHaveBeenCalledTimes(1);
		expect(result.truncated).toBe(31);
	});
});
