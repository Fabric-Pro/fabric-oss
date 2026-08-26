import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	clearProjectStories: vi.fn(),
	deleteObjects: vi.fn(),
	warn: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	clearProjectStories: (...a: unknown[]) => mocks.clearProjectStories(...a),
}));
vi.mock("@repo/storage", () => ({
	deleteObjects: (...a: unknown[]) => mocks.deleteObjects(...a),
}));
vi.mock("@repo/config", () => ({
	config: {
		storage: { bucketNames: { projectContexts: "project-contexts" } },
	},
}));

import { clearProjectStoriesAndAttachments } from "../clear-project-stories-with-attachments";

beforeEach(() => {
	mocks.clearProjectStories.mockReset();
	mocks.deleteObjects.mockReset();
	mocks.warn.mockReset();
	vi.spyOn(console, "warn").mockImplementation(mocks.warn);
});

describe("clearProjectStoriesAndAttachments", () => {
	it("deletes the captured keys from the project-contexts bucket and returns count", async () => {
		mocks.clearProjectStories.mockResolvedValue({
			count: 2,
			attachmentKeys: ["story-attachments/p/s1/a.png"],
		});
		mocks.deleteObjects.mockResolvedValue({ deleted: 1, errors: [] });

		const res = await clearProjectStoriesAndAttachments("p", true);

		expect(mocks.clearProjectStories).toHaveBeenCalledWith("p", true);
		expect(mocks.deleteObjects).toHaveBeenCalledWith(
			["story-attachments/p/s1/a.png"],
			{ bucket: "project-contexts" },
		);
		expect(res).toEqual({ count: 2 });
	});

	it("does not call deleteObjects when there are no keys", async () => {
		mocks.clearProjectStories.mockResolvedValue({
			count: 0,
			attachmentKeys: [],
		});
		const res = await clearProjectStoriesAndAttachments("p");
		expect(mocks.deleteObjects).not.toHaveBeenCalled();
		expect(res).toEqual({ count: 0 });
	});

	it("is best-effort: logs but does not throw when deleteObjects reports errors", async () => {
		mocks.clearProjectStories.mockResolvedValue({
			count: 1,
			attachmentKeys: ["story-attachments/p/s1/a.png"],
		});
		mocks.deleteObjects.mockResolvedValue({
			deleted: 0,
			errors: [
				{ key: "story-attachments/p/s1/a.png", message: "denied" },
			],
		});
		const res = await clearProjectStoriesAndAttachments("p", true);
		expect(res).toEqual({ count: 1 });
		expect(mocks.warn).toHaveBeenCalledWith(
			expect.stringContaining("[attachments]"),
			expect.anything(),
		);
	});

	it("is best-effort: logs and does not throw when deleteObjects rejects", async () => {
		mocks.clearProjectStories.mockResolvedValue({
			count: 3,
			attachmentKeys: ["story-attachments/p/s1/a.png"],
		});
		mocks.deleteObjects.mockRejectedValue(new Error("network error"));
		const res = await clearProjectStoriesAndAttachments("p", true);
		expect(res).toEqual({ count: 3 });
		expect(mocks.warn).toHaveBeenCalledWith(
			expect.stringContaining("[attachments]"),
			expect.any(Error),
		);
	});

	it("defaults clearPipelineOnly to true", async () => {
		mocks.clearProjectStories.mockResolvedValue({
			count: 0,
			attachmentKeys: [],
		});
		await clearProjectStoriesAndAttachments("p");
		expect(mocks.clearProjectStories).toHaveBeenCalledWith("p", true);
	});
});
