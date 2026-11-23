/**
 * The task helpers a project-scoped request uses find the task only inside the
 * story and project the permission gate authorized. A task id from another
 * project or organization matches nothing, so nothing is written.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findFirst: vi.fn(),
	update: vi.fn(),
	deleteMany: vi.fn(),
}));
vi.mock("../prisma/client", async (original) => ({
	...(await original<typeof import("../prisma/client")>()),
	db: {
		storyTask: {
			findFirst: mocks.findFirst,
			update: mocks.update,
			deleteMany: mocks.deleteMany,
		},
	},
}));

import {
	deleteTask,
	toggleTaskComplete,
	updateTaskInStory,
} from "../prisma/queries/projects/stories";

const scope = {
	taskId: "task-example",
	storyId: "story-example",
	projectId: "project-example",
};

const scopedWhere = {
	id: "task-example",
	storyId: "story-example",
	story: { projectId: "project-example" },
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.update.mockResolvedValue({ id: "task-example" });
});

describe("updateTaskInStory", () => {
	it("looks the task up inside the story and project", async () => {
		mocks.findFirst.mockResolvedValue({ id: "task-example" });

		const task = await updateTaskInStory(scope, { title: "Renamed" });

		expect(mocks.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({ where: scopedWhere }),
		);
		expect(mocks.update).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "task-example" },
				data: { title: "Renamed" },
			}),
		);
		expect(task).toEqual({ id: "task-example" });
	});

	it("returns null and writes nothing for a task outside the scope", async () => {
		mocks.findFirst.mockResolvedValue(null);

		expect(await updateTaskInStory(scope, { title: "Renamed" })).toBeNull();
		expect(mocks.update).not.toHaveBeenCalled();
	});
});

describe("toggleTaskComplete", () => {
	it("looks the task up inside the story and project, then flips it", async () => {
		mocks.findFirst.mockResolvedValue({
			id: "task-example",
			isCompleted: false,
		});

		await toggleTaskComplete(scope);

		expect(mocks.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({ where: scopedWhere }),
		);
		expect(mocks.update).toHaveBeenCalledWith({
			where: { id: "task-example" },
			data: { isCompleted: true },
		});
	});

	it("returns null and writes nothing for a task outside the scope", async () => {
		mocks.findFirst.mockResolvedValue(null);

		expect(await toggleTaskComplete(scope)).toBeNull();
		expect(mocks.update).not.toHaveBeenCalled();
	});
});

describe("deleteTask", () => {
	it("deletes only inside the story and project", async () => {
		mocks.deleteMany.mockResolvedValue({ count: 1 });

		expect(await deleteTask(scope)).toBe(true);
		expect(mocks.deleteMany).toHaveBeenCalledWith({ where: scopedWhere });
	});

	it("returns false for a task outside the scope", async () => {
		mocks.deleteMany.mockResolvedValue({ count: 0 });

		expect(await deleteTask(scope)).toBe(false);
	});
});
