/**
 * The Roadmap's one recommendation starter (Fizzy #2208): present only while
 * the flag is on and an AI provider resolves, and a thin wrapper over the run.
 */

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RoadmapBlock } from "../entry-point-states";

const mocks = vi.hoisted(() => ({
	run: vi.fn(),
	start: vi.fn(),
}));

vi.mock("../../recommendations/useRecommendationRun", () => ({
	useRecommendationRun: (args: unknown) => mocks.run(args),
}));

import { useRoadmapRecommendationStarter } from "../recommendation-starter";

function roadmap(overrides: Partial<RoadmapBlock> = {}): RoadmapBlock {
	return {
		canUpdateStories: true,
		canCreateStories: true,
		recommendationsEnabled: true,
		providerAvailable: true,
		activePmSync: null,
		aiRecommendedLifecycleEnabled: false,
		...overrides,
	} as RoadmapBlock;
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.start.mockResolvedValue(undefined);
	mocks.run.mockReturnValue({
		start: mocks.start,
		isStarting: false,
		isRunning: true,
	});
});

describe("useRoadmapRecommendationStarter", () => {
	it.each([
		["the flag is off", roadmap({ recommendationsEnabled: false })],
		["no AI provider resolves", roadmap({ providerAvailable: false })],
		["projects.get is still loading", undefined],
	])("is null and reads nothing when %s", (_label, block) => {
		const { result } = renderHook(() =>
			useRoadmapRecommendationStarter({
				projectId: "p1",
				roadmap: block,
			}),
		);
		expect(result.current).toBeNull();
		expect(mocks.run).toHaveBeenCalledWith({
			projectId: "p1",
			enabled: false,
		});
	});

	it("forwards the entry point, never the preceding pull, and reports the run", async () => {
		const { result } = renderHook(() =>
			useRoadmapRecommendationStarter({
				projectId: "p1",
				roadmap: roadmap(),
			}),
		);
		expect(mocks.run).toHaveBeenCalledWith({
			projectId: "p1",
			enabled: true,
		});
		expect(result.current?.isRunning).toBe(true);
		await result.current?.start({
			entryPoint: "DO_BOTH_AFTER_PULL",
			precedingPullWorkflowId: "pull-1",
		});
		expect(mocks.start).toHaveBeenCalledWith("DO_BOTH_AFTER_PULL");
	});

	it("passes a start rejection through for the caller to report", async () => {
		mocks.start.mockRejectedValue(new Error("Not ready yet."));
		const { result } = renderHook(() =>
			useRoadmapRecommendationStarter({
				projectId: "p1",
				roadmap: roadmap(),
			}),
		);
		await expect(
			result.current?.start({ entryPoint: "EMPTY_ROADMAP" }),
		).rejects.toThrow("Not ready yet.");
	});
});
