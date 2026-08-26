import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	recordPriorityMoveMock,
	txFindUniqueMock,
	txUpdateMock,
	txUpdateManyMock,
	txVersionCreateManyMock,
	transactionMock,
} = vi.hoisted(() => ({
	recordPriorityMoveMock: vi.fn(),
	txFindUniqueMock: vi.fn(),
	txUpdateMock: vi.fn(),
	txUpdateManyMock: vi.fn(),
	txVersionCreateManyMock: vi.fn(),
	transactionMock: vi.fn(),
}));

vi.mock("../../../client", () => ({
	db: { $transaction: transactionMock },
}));

vi.mock("../priority-history", () => ({
	recordPriorityMove: recordPriorityMoveMock,
}));

import { type UpdateStoryData, updateStory } from "../stories";

const STORY_ID = "story-1";
const PROJECT_ID = "project-1";
const EXISTING_LAST_EDIT = new Date("2026-08-01T09:00:00.000Z");

const CURRENT_STORY = {
	updatedAt: new Date("2026-08-01T10:00:00.000Z"),
	version: 7,
	title: "Original title",
	description: "Original description",
	acceptanceCriteria: "Original criteria",
	priority: "P2_MEDIUM" as const,
	size: "M" as const,
	storyPoints: 5,
	labels: ["frontend"],
	assigneeId: "user-1",
	statusId: "status-backlog",
	draftingStage: "DRAFT" as const,
	maturationStatus: "DISCOVERY" as const,
	kind: "FEATURE" as const,
	needsMoreInfo: false,
	coverageOverrideReason: null,
	coverageOverrideById: null,
	coverageOverrideAt: null,
	roadmapOrder: 2,
	externalId: null,
	externalMcpServerId: null,
	lastEditedAt: EXISTING_LAST_EDIT,
	lastEditedByName: "Previous editor",
	lastEditedSource: "MANUAL",
};

beforeEach(() => {
	vi.clearAllMocks();
	txFindUniqueMock.mockResolvedValue(CURRENT_STORY);
	txUpdateMock.mockResolvedValue({ id: STORY_ID });
	txUpdateManyMock.mockResolvedValue({ count: 1 });
	txVersionCreateManyMock.mockResolvedValue({ count: 1 });
	recordPriorityMoveMock.mockResolvedValue({ roadmapOrder: 3 });

	transactionMock.mockImplementation(async (fn: (tx: unknown) => unknown) =>
		fn({
			userStory: {
				findUnique: txFindUniqueMock,
				update: txUpdateMock,
				updateMany: txUpdateManyMock,
			},
			featureVersion: { createMany: txVersionCreateManyMock },
			pendingPmStateChange: { updateMany: vi.fn() },
			pmTicketMissingStreak: { deleteMany: vi.fn() },
		}),
	);
});

function lastWriteData(): Record<string, unknown> {
	const update = txUpdateMock.mock.calls.at(-1)?.[0] as
		| { data: Record<string, unknown> }
		| undefined;
	const updateMany = txUpdateManyMock.mock.calls.at(-1)?.[0] as
		| { data: Record<string, unknown> }
		| undefined;
	return update?.data ?? updateMany?.data ?? {};
}

const GENUINE_EDITS: Array<[string, UpdateStoryData]> = [
	["title", { title: "Changed title" }],
	["acceptance criteria", { acceptanceCriteria: "Changed criteria" }],
	["size", { size: "L" }],
	["story points", { storyPoints: 8 }],
	["labels", { labels: ["frontend", "urgent"] }],
	["assignee", { assigneeId: null }],
	["status", { statusId: "status-progress" }],
	["drafting stage", { draftingStage: "PUBLISHED" }],
	["maturation status", { maturationStatus: "DONE" }],
	["kind", { kind: "BUG" }],
	["needs-more-info", { needsMoreInfo: true }],
];

describe("updateStory semantic last-edit event", () => {
	it.each(GENUINE_EDITS)(
		"stamps one atomic tuple when %s changes",
		async (_name, data) => {
			await updateStory(STORY_ID, PROJECT_ID, data, {
				lastEditedByName: "Ada Lovelace",
				lastEditedSource: "MANUAL",
			});

			const writeData = lastWriteData();
			expect(writeData.lastEditedAt).toBeInstanceOf(Date);
			expect(writeData).toMatchObject({
				lastEditedByName: "Ada Lovelace",
				lastEditedSource: "MANUAL",
			});
		},
	);

	it("stamps priority metadata and the edit tuple in the same story write", async () => {
		await updateStory(
			STORY_ID,
			PROJECT_ID,
			{ priority: "P1_HIGH" },
			{
				lastEditedByName: "Grace Hopper",
				lastEditedSource: "MANUAL",
			},
		);

		const writeData = lastWriteData();
		expect(writeData).toMatchObject({
			priority: "P1_HIGH",
			roadmapOrder: 3,
			lastEditedByName: "Grace Hopper",
			lastEditedSource: "MANUAL",
		});
		expect(writeData.lastEditedAt).toBeInstanceOf(Date);
	});

	it("preserves the complete tuple for an identical payload", async () => {
		await updateStory(
			STORY_ID,
			PROJECT_ID,
			{
				title: CURRENT_STORY.title,
				description: CURRENT_STORY.description,
				acceptanceCriteria: CURRENT_STORY.acceptanceCriteria,
				priority: CURRENT_STORY.priority,
				size: CURRENT_STORY.size,
				storyPoints: CURRENT_STORY.storyPoints,
				labels: [...CURRENT_STORY.labels],
				assigneeId: CURRENT_STORY.assigneeId,
				statusId: CURRENT_STORY.statusId,
				draftingStage: CURRENT_STORY.draftingStage,
				maturationStatus: CURRENT_STORY.maturationStatus,
				kind: CURRENT_STORY.kind,
				needsMoreInfo: CURRENT_STORY.needsMoreInfo,
			},
			{
				lastEditedByName: "No-op editor",
				lastEditedSource: "MANUAL",
			},
		);

		expect(lastWriteData()).not.toHaveProperty("lastEditedAt");
		expect(lastWriteData()).not.toHaveProperty("lastEditedByName");
		expect(lastWriteData()).not.toHaveProperty("lastEditedSource");
	});

	it("records an autonomous edit with a null human actor", async () => {
		await updateStory(
			STORY_ID,
			PROJECT_ID,
			{ description: "Pulled description" },
			{ lastEditedSource: "PM_PULL" },
		);

		expect(lastWriteData()).toMatchObject({
			lastEditedAt: expect.any(Date),
			lastEditedByName: null,
			lastEditedSource: "PM_PULL",
		});
	});

	it("does not stamp operational-only changes", async () => {
		await updateStory(
			STORY_ID,
			PROJECT_ID,
			{ pmAutoSyncEnabled: true, externalId: "PM-123" },
			{
				lastEditedByName: "Operator",
				lastEditedSource: "MANUAL",
			},
		);

		expect(lastWriteData()).not.toHaveProperty("lastEditedAt");
		expect(lastWriteData()).not.toHaveProperty("lastEditedByName");
		expect(lastWriteData()).not.toHaveProperty("lastEditedSource");
	});

	it("cannot stamp a stale versioned write", async () => {
		await expect(
			updateStory(
				STORY_ID,
				PROJECT_ID,
				{ acceptanceCriteria: "Stale criteria" },
				{
					expectedVersion: CURRENT_STORY.version - 1,
					lastEditedByName: "Stale editor",
					lastEditedSource: "MANUAL",
				},
			),
		).rejects.toThrow(/updated by another request/i);

		expect(txUpdateMock).not.toHaveBeenCalled();
		expect(txUpdateManyMock).not.toHaveBeenCalled();
	});
});
