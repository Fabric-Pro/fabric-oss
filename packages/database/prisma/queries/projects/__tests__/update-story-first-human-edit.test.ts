import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	recordPriorityMoveMock,
	txFindUniqueMock,
	txUpdateManyMock,
	txVersionCreateManyMock,
	transactionMock,
} = vi.hoisted(() => ({
	recordPriorityMoveMock: vi.fn(),
	txFindUniqueMock: vi.fn(),
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

import {
	type UpdateStoryData,
	type UpdateStoryVersionContext,
	updateStory,
} from "../stories";

const STORY_ID = "story-1";
const PROJECT_ID = "project-1";

const AI_RECOMMENDED_STORY = {
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
	lastEditedAt: new Date("2026-08-01T09:00:00.000Z"),
	source: "AI_RECOMMENDED" as const,
	firstHumanEditAt: null as Date | null,
};

const PERSON: UpdateStoryVersionContext = {
	userId: "user-7",
	organizationId: "org-1",
	changedBy: "user-7",
	lastEditedByName: "Example Editor",
	lastEditedSource: "MANUAL",
};

beforeEach(() => {
	vi.clearAllMocks();
	txFindUniqueMock.mockResolvedValue(AI_RECOMMENDED_STORY);
	txUpdateManyMock.mockResolvedValue({ count: 1 });
	txVersionCreateManyMock.mockResolvedValue({ count: 1 });
	recordPriorityMoveMock.mockResolvedValue({ roadmapOrder: 3 });

	transactionMock.mockImplementation(async (fn: (tx: unknown) => unknown) =>
		fn({
			userStory: {
				findUnique: txFindUniqueMock,
				findFirst: vi.fn(async () => ({
					draftingStage: AI_RECOMMENDED_STORY.draftingStage,
					deliveryTrack: "SPECIFY",
					description: AI_RECOMMENDED_STORY.description,
					acceptanceCriteria: AI_RECOMMENDED_STORY.acceptanceCriteria,
				})),
				updateMany: txUpdateManyMock,
			},
			featureVersion: { createMany: txVersionCreateManyMock },
			pendingPmStateChange: { updateMany: vi.fn() },
			pmTicketMissingStreak: { deleteMany: vi.fn() },
			project: {
				findUnique: vi.fn(async () => ({
					engagementProfile: "PROPOSAL",
					enforceSpecifyGate: false,
					enforceSpikeGate: false,
					enforceDiscoveryGate: false,
					organizationId: "org-1",
					userId: "owner-1",
					_count: { stageApprovers: 0 },
				})),
			},
			codingRun: { count: vi.fn(async () => 0) },
			projectDocument: { findFirst: vi.fn(async () => null) },
			stageTransitionRequest: {
				updateMany: vi.fn(async () => ({ count: 0 })),
				create: vi.fn(),
			},
		}),
	);
});

function lastWriteData(): Record<string, unknown> {
	const call = txUpdateManyMock.mock.calls.at(-1)?.[0] as
		| { data: Record<string, unknown> }
		| undefined;
	return call?.data ?? {};
}

describe("updateStory firstHumanEditAt (Fizzy #2211)", () => {
	it.each<[string, UpdateStoryData]>([
		["title", { title: "Changed title" }],
		["priority", { priority: "P1_HIGH" }],
		["size", { size: "L" }],
		["story points", { storyPoints: 8 }],
	])(
		"stamps it with the edit time when a person changes the %s of an AI-recommended item",
		async (_name, data) => {
			await updateStory(STORY_ID, PROJECT_ID, data, PERSON);

			const writeData = lastWriteData();
			expect(writeData.firstHumanEditAt).toBeInstanceOf(Date);
			expect(writeData.firstHumanEditAt).toBe(writeData.lastEditedAt);
		},
	);

	it("never overwrites an existing stamp", async () => {
		txFindUniqueMock.mockResolvedValue({
			...AI_RECOMMENDED_STORY,
			firstHumanEditAt: new Date("2026-08-02T00:00:00.000Z"),
		});

		await updateStory(STORY_ID, PROJECT_ID, { title: "Again" }, PERSON);

		expect(lastWriteData()).not.toHaveProperty("firstHumanEditAt");
	});

	it("does not stamp a MANUAL edit with no userId (the PM webhook)", async () => {
		await updateStory(
			STORY_ID,
			PROJECT_ID,
			{ title: "From the PM tool" },
			{ lastEditedByName: null, lastEditedSource: "MANUAL" },
		);

		expect(lastWriteData()).not.toHaveProperty("firstHumanEditAt");
	});

	it.each(["AI_BACKLOG_UPDATE", "AI_MATURATION", "PM_PULL"] as const)(
		"does not stamp an %s edit",
		async (lastEditedSource) => {
			await updateStory(
				STORY_ID,
				PROJECT_ID,
				{ title: "Machine title" },
				{ ...PERSON, lastEditedSource },
			);

			expect(lastWriteData()).not.toHaveProperty("firstHumanEditAt");
		},
	);

	it.each<[string, UpdateStoryData]>([
		["kind", { kind: "BUG" }],
		["status", { statusId: "status-progress" }],
		["labels", { labels: ["frontend", "urgent"] }],
		["assignee", { assigneeId: null }],
		["drafting stage", { draftingStage: "PUBLISHED" }],
	])(
		"does not stamp a change to the %s alone, which is workflow, not content",
		async (_name, data) => {
			await updateStory(STORY_ID, PROJECT_ID, data, PERSON);

			const writeData = lastWriteData();
			expect(writeData.lastEditedAt).toBeInstanceOf(Date);
			expect(writeData).not.toHaveProperty("firstHumanEditAt");
		},
	);

	it("does not stamp a confirmed AI context refresh, which still counts as the last edit", async () => {
		await updateStory(
			STORY_ID,
			PROJECT_ID,
			{ description: "Refreshed from new project context" },
			{ ...PERSON, aiContextRefresh: true },
		);

		const writeData = lastWriteData();
		expect(writeData.lastEditedAt).toBeInstanceOf(Date);
		expect(writeData).not.toHaveProperty("firstHumanEditAt");
	});

	it("does not stamp an item that was not AI-recommended", async () => {
		txFindUniqueMock.mockResolvedValue({
			...AI_RECOMMENDED_STORY,
			source: "MANUAL",
		});

		await updateStory(STORY_ID, PROJECT_ID, { title: "Changed" }, PERSON);

		expect(lastWriteData()).not.toHaveProperty("firstHumanEditAt");
	});

	it("does not stamp a save that changes nothing", async () => {
		await updateStory(
			STORY_ID,
			PROJECT_ID,
			{
				title: AI_RECOMMENDED_STORY.title,
				description: AI_RECOMMENDED_STORY.description,
				priority: AI_RECOMMENDED_STORY.priority,
			},
			PERSON,
		);

		expect(lastWriteData()).not.toHaveProperty("firstHumanEditAt");
	});

	it("stamps on the versioned write when a person changes the description", async () => {
		await updateStory(
			STORY_ID,
			PROJECT_ID,
			{ description: "Rewritten by a person" },
			PERSON,
		);

		expect(txVersionCreateManyMock).toHaveBeenCalledTimes(1);
		const writeData = lastWriteData();
		expect(writeData.version).toEqual({ increment: 1 });
		expect(writeData.firstHumanEditAt).toBeInstanceOf(Date);
	});

	// Known limitation, accepted for #2211: the public v1 API writes as MANUAL
	// with the API key owner's userId, so an API-key or coding-agent edit is
	// indistinguishable from a person's and marks the item edited.
	it("counts a public v1 API edit as a person's (named limitation)", async () => {
		await updateStory(
			STORY_ID,
			PROJECT_ID,
			{ title: "Rewritten through the API" },
			{
				userId: "key-owner",
				organizationId: "org-1",
				changedBy: "key-owner",
				lastEditedSource: "MANUAL",
				lastEditedByName: null,
			},
		);

		expect(lastWriteData().firstHumanEditAt).toBeInstanceOf(Date);
	});
});
