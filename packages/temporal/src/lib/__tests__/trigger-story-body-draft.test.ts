/**
 * `triggerStoryBodyDraft` starts the existing body-rewrite workflow for a work
 * item that was created from a person's own words, and never lets a failure to
 * start it break the create that called it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockStart, mockGetClient, mockIsAvailable } = vi.hoisted(() => ({
	mockStart: vi.fn(),
	mockGetClient: vi.fn(),
	mockIsAvailable: vi.fn(),
}));

vi.mock("../../client", () => ({
	getTemporalClient: mockGetClient,
	isTemporalAvailable: mockIsAvailable,
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { triggerStoryBodyDraft } from "../trigger-story-body-draft";

const params = {
	storyId: "story-1",
	projectId: "project-1",
	userId: "user-1",
	organizationId: "org-1",
	targetKind: "FEATURE" as const,
};

beforeEach(() => {
	vi.clearAllMocks();
	mockIsAvailable.mockResolvedValue(true);
	mockStart.mockResolvedValue({ workflowId: "story-body-draft-story-1" });
	mockGetClient.mockResolvedValue({ workflow: { start: mockStart } });
});

describe("triggerStoryBodyDraft", () => {
	it("starts the body-rewrite workflow for the item, under one id per item", async () => {
		const result = await triggerStoryBodyDraft(params);

		expect(result).toEqual({ workflowId: "story-body-draft-story-1" });
		expect(mockStart).toHaveBeenCalledWith(
			"regenerateBodyForKindWorkflow",
			expect.objectContaining({
				taskQueue: "ai-chat",
				workflowId: "story-body-draft-story-1",
				args: [
					{
						storyId: "story-1",
						projectId: "project-1",
						organizationId: "org-1",
						userId: "user-1",
						targetKind: "FEATURE",
						entryPoint: "agentCreateDeferredDraft",
					},
				],
			}),
		);
	});

	it("returns null without starting anything when Temporal is unavailable", async () => {
		mockIsAvailable.mockResolvedValue(false);

		expect(await triggerStoryBodyDraft(params)).toBeNull();
		expect(mockStart).not.toHaveBeenCalled();
	});

	it("returns null instead of throwing when the start fails", async () => {
		mockStart.mockRejectedValue(new Error("Temporal down"));

		expect(await triggerStoryBodyDraft(params)).toBeNull();
	});
});
