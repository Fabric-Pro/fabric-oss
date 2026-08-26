import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	queryRawMock,
	statusDeleteMock,
	statusFindManyMock,
	statusUpdateMock,
	storyUpdateManyMock,
	transactionMock,
} = vi.hoisted(() => ({
	queryRawMock: vi.fn(),
	statusDeleteMock: vi.fn(),
	statusFindManyMock: vi.fn(),
	statusUpdateMock: vi.fn(),
	storyUpdateManyMock: vi.fn(),
	transactionMock: vi.fn(),
}));

vi.mock("../../../client", () => ({
	db: { $transaction: transactionMock },
}));

vi.mock("../priority-history", () => ({
	recordPriorityMove: vi.fn(),
}));

import { deleteStoryStatus } from "../stories";

beforeEach(() => {
	vi.clearAllMocks();
	statusFindManyMock.mockResolvedValue([
		{ id: "status-old", isDefault: true },
		{ id: "status-target", isDefault: false },
	]);
	statusUpdateMock.mockResolvedValue({
		id: "status-target",
		isDefault: true,
	});
	storyUpdateManyMock.mockResolvedValue({ count: 2 });
	statusDeleteMock.mockResolvedValue({ id: "status-old" });
	transactionMock.mockImplementation(async (run: (tx: unknown) => unknown) =>
		run({
			$queryRaw: queryRawMock,
			projectStoryStatus: {
				findMany: statusFindManyMock,
				update: statusUpdateMock,
				delete: statusDeleteMock,
			},
			userStory: { updateMany: storyUpdateManyMock },
		}),
	);
});

describe("deleteStoryStatus", () => {
	it("moves stories, stamps the human edit event, and deletes in one transaction", async () => {
		await deleteStoryStatus("status-old", "project-1", {
			lastEditedByName: "Ada Lovelace",
			lastEditedSource: "MANUAL",
		});

		expect(transactionMock).toHaveBeenCalledOnce();
		expect(queryRawMock).toHaveBeenCalledOnce();
		expect(statusUpdateMock).toHaveBeenCalledWith({
			where: { id: "status-target", projectId: "project-1" },
			data: { isDefault: true },
		});
		expect(storyUpdateManyMock).toHaveBeenCalledWith({
			where: { statusId: "status-old", projectId: "project-1" },
			data: {
				statusId: "status-target",
				lastEditedAt: expect.any(Date),
				lastEditedByName: "Ada Lovelace",
				lastEditedSource: "MANUAL",
			},
		});
		expect(statusDeleteMock).toHaveBeenCalledWith({
			where: { id: "status-old", projectId: "project-1" },
		});
	});
});
