import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock runtime dependencies so the module can be loaded without DB/network.
vi.mock("@repo/database", () => ({
	setAiUsageRecorder: vi.fn(),
	db: {
		projectStoryStatus: { findMany: vi.fn() },
		userStory: { findMany: vi.fn() },
	},
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@temporalio/activity", () => ({
	heartbeat: vi.fn(),
}));

import { db } from "@repo/database";
import {
	AHEAD_LOOKAHEAD_HOURS,
	collectAhead,
	shouldIncludeMeeting,
} from "../src/activities/daily-brief/collect-ahead";

describe("shouldIncludeMeeting", () => {
	const now = new Date("2026-04-23T08:00:00Z");

	it("includes meetings inside the lookahead window", () => {
		const nextMeeting = new Date(now.getTime() + 2 * 60 * 60 * 1000);
		expect(shouldIncludeMeeting({ start: nextMeeting, now })).toBe(true);
	});

	it("excludes meetings beyond the lookahead window", () => {
		const far = new Date(
			now.getTime() + (AHEAD_LOOKAHEAD_HOURS + 1) * 60 * 60 * 1000,
		);
		expect(shouldIncludeMeeting({ start: far, now })).toBe(false);
	});

	it("excludes past meetings", () => {
		const past = new Date(now.getTime() - 60 * 60 * 1000);
		expect(shouldIncludeMeeting({ start: past, now })).toBe(false);
	});
});

describe("collectAhead", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		vi.mocked(db.projectStoryStatus.findMany).mockResolvedValue([
			{ id: "status-in-progress", name: "In Progress" },
		] as never);
	});

	it("emits a story_about_to_transition item when ratio >= 0.8 and not all tasks are done", async () => {
		vi.mocked(db.userStory.findMany).mockResolvedValueOnce([
			{
				id: "s1",
				identifier: "F-12",
				title: "Refund split",
				tasks: [
					{ id: "t1", agentCompletedAt: new Date() },
					{ id: "t2", agentCompletedAt: new Date() },
					{ id: "t3", agentCompletedAt: new Date() },
					{ id: "t4", agentCompletedAt: new Date() },
					{ id: "t5", agentCompletedAt: null },
				],
			},
		] as never);

		const items = await collectAhead({
			projectId: "p1",
			organizationId: null,
		});

		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({
			kind: "story_about_to_transition",
			title: "Refund split",
			targetIdentifier: "F-12",
			context: "4/5 tasks completed",
		});
	});

	it("skips stories with zero tasks", async () => {
		vi.mocked(db.userStory.findMany).mockResolvedValueOnce([
			{
				id: "s2",
				identifier: "F-99",
				title: "Empty",
				tasks: [],
			},
		] as never);

		const items = await collectAhead({
			projectId: "p1",
			organizationId: null,
		});
		expect(items).toHaveLength(0);
	});

	it("skips stories where ALL tasks are done (already effectively Done)", async () => {
		vi.mocked(db.userStory.findMany).mockResolvedValueOnce([
			{
				id: "s3",
				identifier: "F-7",
				title: "Fully done",
				tasks: [
					{ id: "a", agentCompletedAt: new Date() },
					{ id: "b", agentCompletedAt: new Date() },
				],
			},
		] as never);

		const items = await collectAhead({
			projectId: "p1",
			organizationId: null,
		});
		expect(items).toHaveLength(0);
	});

	it("skips stories below the 80% completion threshold", async () => {
		vi.mocked(db.userStory.findMany).mockResolvedValueOnce([
			{
				id: "s4",
				identifier: "F-3",
				title: "Half done",
				tasks: [
					{ id: "a", agentCompletedAt: new Date() },
					{ id: "b", agentCompletedAt: new Date() },
					{ id: "c", agentCompletedAt: null },
					{ id: "d", agentCompletedAt: null },
				],
			},
		] as never);

		const items = await collectAhead({
			projectId: "p1",
			organizationId: null,
		});
		expect(items).toHaveLength(0);
	});

	it("returns empty array when no statuses match the active regex", async () => {
		vi.mocked(db.projectStoryStatus.findMany).mockResolvedValueOnce([
			{ id: "status-backlog", name: "Backlog" },
		] as never);

		const items = await collectAhead({
			projectId: "p1",
			organizationId: null,
		});
		expect(items).toHaveLength(0);
		// Short-circuits before querying userStory when no active statuses.
		expect(db.userStory.findMany).not.toHaveBeenCalled();
	});
});
