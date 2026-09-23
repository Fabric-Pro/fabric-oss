import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		openExclusiveBackgroundJob: vi.fn(),
		failBackgroundJob: vi.fn(),
		backgroundJobFindFirst: vi.fn(),
	},
}));

vi.mock("@repo/database", () => ({
	openExclusiveBackgroundJob: mocks.openExclusiveBackgroundJob,
	failBackgroundJob: mocks.failBackgroundJob,
	db: { backgroundJob: { findFirst: mocks.backgroundJobFindFirst } },
}));

import {
	failPmStorySyncJob,
	findActivePmStorySync,
	openPmStorySyncJob,
} from "../pm-story-sync-job";

const NOW = new Date("2026-09-23T12:00:00.000Z");

describe("openPmStorySyncJob", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		mocks.openExclusiveBackgroundJob.mockResolvedValue({
			opened: true,
			id: "job-1",
		});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("opens a PM_STORY_SYNC row for a pull under the project's lock, refusing a run live inside the stall window", async () => {
		await expect(
			openPmStorySyncJob({
				workflowId: "wf-1",
				projectId: "project-1",
				userId: "user-1",
				organizationId: "org-1",
				direction: "pull",
			}),
		).resolves.toBeNull();

		expect(mocks.openExclusiveBackgroundJob).toHaveBeenCalledWith({
			lockKey: "pm-story-sync:project-1",
			liveSince: new Date(NOW.getTime() - 40 * 60_000),
			job: {
				kind: "PM_STORY_SYNC",
				title: "Pull from project management",
				projectId: "project-1",
				userId: "user-1",
				organizationId: "org-1",
				workflowId: "wf-1",
				sourceType: "pmStoryPull",
				sourceId: "project-1",
			},
		});
	});

	it("records the push direction in the source type", async () => {
		await openPmStorySyncJob({
			workflowId: "wf-2",
			projectId: "project-1",
			userId: "user-1",
			organizationId: null,
			direction: "push",
		});

		expect(mocks.openExclusiveBackgroundJob).toHaveBeenCalledWith(
			expect.objectContaining({
				job: expect.objectContaining({
					kind: "PM_STORY_SYNC",
					title: "Push to project management",
					sourceType: "pmStoryPush",
					organizationId: null,
				}),
			}),
		);
	});

	it("returns the live run in the way instead of opening a second row", async () => {
		const createdAt = new Date("2026-09-23T11:58:00.000Z");
		mocks.openExclusiveBackgroundJob.mockResolvedValue({
			opened: false,
			active: {
				workflowId: "wf-live",
				sourceType: "pmStoryPush",
				createdAt,
			},
		});

		await expect(
			openPmStorySyncJob({
				workflowId: "wf-3",
				projectId: "project-1",
				userId: "user-1",
				organizationId: "org-1",
				direction: "pull",
			}),
		).resolves.toEqual({
			workflowId: "wf-live",
			direction: "push",
			startedAt: createdAt,
		});
	});
});

describe("failPmStorySyncJob", () => {
	it("fails only this project's row of the workflow, with a class the success close never repairs", async () => {
		await failPmStorySyncJob({
			workflowId: "wf-1",
			projectId: "project-1",
			error: "Sync service unavailable",
		});

		expect(mocks.failBackgroundJob).toHaveBeenCalledWith(
			{ workflowId: "wf-1", sourceId: "project-1" },
			{ error: "Sync service unavailable", errorClass: "StartFailed" },
		);
	});
});

describe("findActivePmStorySync", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("reads only running PM_STORY_SYNC rows heartbeated inside the 40-minute stall window", async () => {
		mocks.backgroundJobFindFirst.mockResolvedValue(null);

		await expect(findActivePmStorySync("project-1")).resolves.toBeNull();

		expect(mocks.backgroundJobFindFirst).toHaveBeenCalledWith({
			where: {
				projectId: "project-1",
				kind: "PM_STORY_SYNC",
				status: "RUNNING",
				heartbeatAt: { gte: new Date(NOW.getTime() - 40 * 60_000) },
			},
			orderBy: { createdAt: "desc" },
			select: { workflowId: true, sourceType: true, createdAt: true },
		});
	});

	it("maps the row's source type back to a direction", async () => {
		const createdAt = new Date("2026-09-23T11:50:00.000Z");
		mocks.backgroundJobFindFirst.mockResolvedValueOnce({
			workflowId: "wf-push",
			sourceType: "pmStoryPush",
			createdAt,
		});
		await expect(findActivePmStorySync("project-1")).resolves.toEqual({
			workflowId: "wf-push",
			direction: "push",
			startedAt: createdAt,
		});

		mocks.backgroundJobFindFirst.mockResolvedValueOnce({
			workflowId: "wf-pull",
			sourceType: "pmStoryPull",
			createdAt,
		});
		await expect(findActivePmStorySync("project-1")).resolves.toMatchObject(
			{
				direction: "pull",
			},
		);
	});
});
