import { beforeEach, describe, expect, it, vi } from "vitest";

const { findFirst, findMany } = vi.hoisted(() => ({
	findFirst: vi.fn(),
	findMany: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		codingRun: {
			findFirst,
			findMany,
		},
		codingRunEvent: {
			create: vi.fn(),
		},
	},
}));

import {
	getCodingRun,
	listCodingRunsForStory,
	listCodingRunsForTask,
} from "../prisma/queries/coding-runs";

describe("coding run query tenant isolation", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		findFirst.mockResolvedValue(null);
		findMany.mockResolvedValue([]);
	});

	it("uses userId + organizationId null for personal getCodingRun lookups", async () => {
		await getCodingRun("run_1", "user_1", null);

		expect(findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "run_1",
					userId: "user_1",
					organizationId: null,
				},
			}),
		);
	});

	it("uses organizationId-only filtering for org getCodingRun lookups", async () => {
		await getCodingRun("run_2", "user_1", "org_1");

		expect(findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "run_2",
					organizationId: "org_1",
				},
			}),
		);
	});

	it("uses XOR tenant filter when listing task coding runs in personal context", async () => {
		await listCodingRunsForTask("task_1", "user_1", null);

		expect(findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					storyTaskId: "task_1",
					userId: "user_1",
					organizationId: null,
				},
			}),
		);
	});

	it("uses org-scoped filter when listing story coding runs in org context", async () => {
		await listCodingRunsForStory("story_1", "user_1", "org_9");

		expect(findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					storyId: "story_1",
					organizationId: "org_9",
				},
			}),
		);
	});
});
