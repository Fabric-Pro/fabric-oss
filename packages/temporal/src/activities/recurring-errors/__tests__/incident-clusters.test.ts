/**
 * Clustering of open bug reports for the recurring-error scan.
 *
 * The duplicate detector's LLM verifier over a project's open bugs can outlast
 * the scan's own timeout, so the scan must hand it a durable run rather than
 * await it, and cluster only the DUPLICATE edges already confirmed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const listOpenBugStoriesForClustering = vi.hoisted(() => vi.fn());
const listDuplicateEdgesAmong = vi.hoisted(() => vi.fn());
vi.mock("@repo/database", () => ({
	listOpenBugStoriesForClustering,
	listDuplicateEdgesAmong,
}));

const triggerDuplicateDetection = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/trigger-duplicate-detection", () => ({
	triggerDuplicateDetection,
}));

const runDuplicateScanCore = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/duplicate-scan-core", () => ({ runDuplicateScanCore }));

import { findOpenBugClusters } from "../incident-clusters";

const story = (id: string) => ({ id, identifier: id, title: `Bug ${id}` });

const input = {
	projectId: "project-1",
	organizationId: "org-1",
	userId: "user-1",
	minSize: 3,
	minConfidence: 0.8,
	excludeStoryIds: new Set<string>(),
};

beforeEach(() => {
	vi.clearAllMocks();
	triggerDuplicateDetection.mockResolvedValue({ workflowId: "dup-detect-1" });
	listDuplicateEdgesAmong.mockResolvedValue([]);
});

describe("findOpenBugClusters", () => {
	it("starts a durable duplicate check instead of running it inside the scan", async () => {
		listOpenBugStoriesForClustering.mockResolvedValue(
			["a", "b", "c"].map(story),
		);

		await findOpenBugClusters(input);

		expect(triggerDuplicateDetection).toHaveBeenCalledWith({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			targetStoryIds: ["a", "b", "c"],
		});
		expect(runDuplicateScanCore).not.toHaveBeenCalled();
	});

	it("clusters the duplicate edges already confirmed, at or above the minimum size", async () => {
		listOpenBugStoriesForClustering.mockResolvedValue(
			["a", "b", "c", "d", "e"].map(story),
		);
		listDuplicateEdgesAmong.mockResolvedValue([
			{ storyAId: "a", storyBId: "b" },
			{ storyAId: "b", storyBId: "c" },
			{ storyAId: "d", storyBId: "e" },
		]);

		const clusters = await findOpenBugClusters(input);

		expect(clusters.map((members) => members.map((s) => s.id))).toEqual([
			["a", "b", "c"],
		]);
	});

	it("still clusters existing edges when the duplicate check cannot be enqueued", async () => {
		listOpenBugStoriesForClustering.mockResolvedValue(
			["a", "b", "c"].map(story),
		);
		triggerDuplicateDetection.mockResolvedValue(null);
		listDuplicateEdgesAmong.mockResolvedValue([
			{ storyAId: "a", storyBId: "b" },
			{ storyAId: "a", storyBId: "c" },
		]);

		const clusters = await findOpenBugClusters(input);

		expect(clusters).toHaveLength(1);
	});

	it("does nothing for a project with fewer open bugs than the minimum", async () => {
		listOpenBugStoriesForClustering.mockResolvedValue(
			["a", "b"].map(story),
		);

		const clusters = await findOpenBugClusters(input);

		expect(clusters).toEqual([]);
		expect(triggerDuplicateDetection).not.toHaveBeenCalled();
	});

	it("only joins bugs by duplicate edges at the project's similarity threshold", async () => {
		listOpenBugStoriesForClustering.mockResolvedValue(
			["a", "b", "c"].map(story),
		);

		await findOpenBugClusters(input);

		expect(listDuplicateEdgesAmong).toHaveBeenCalledWith(
			"project-1",
			["a", "b", "c"],
			0.8,
		);
	});

	it("leaves out the scan's own consolidations", async () => {
		listOpenBugStoriesForClustering.mockResolvedValue(
			["a", "b", "c", "consolidated"].map(story),
		);

		await findOpenBugClusters({
			...input,
			excludeStoryIds: new Set(["consolidated"]),
		});

		expect(triggerDuplicateDetection).toHaveBeenCalledWith(
			expect.objectContaining({ targetStoryIds: ["a", "b", "c"] }),
		);
	});
});
