/**
 * After a reviewed proposal updates an existing ticket, the apply leaves one
 * Decision Log note on that ticket: the changes as written and what prompted
 * them. The note is keyed by proposal and item (idempotent across retries)
 * and best-effort: a failed note never fails the update.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDb, mocks } = vi.hoisted(() => {
	const mockDb = {
		project: { findFirst: vi.fn() },
		userStory: { findFirst: vi.fn(), findMany: vi.fn() },
		pendingBacklogProposal: { findUnique: vi.fn() },
		pendingBacklogProposalApplication: { findMany: vi.fn() },
		$transaction: vi.fn(),
	};
	const mocks = {
		updateStory: vi.fn(),
		recordAudit: vi.fn(),
		recordProposalApplication: vi.fn(),
		recordProposalReviewNote: vi.fn(),
	};
	return { mockDb, mocks };
});

vi.mock("@repo/database", () => ({
	db: mockDb,
	tenantWhere: vi.fn(() => ({})),
	createStory: vi.fn(),
	updateStory: mocks.updateStory,
	recordAudit: mocks.recordAudit,
	recordProposalApplication: mocks.recordProposalApplication,
	recordProposalDuplicateResolution: vi.fn(),
	recordProposalReviewNote: mocks.recordProposalReviewNote,
	appendAppliedChangeIndexes: vi.fn(),
	getBoundPromptForAgent: vi.fn(),
	normalizeBacklogTitle: (title: string) => title.toLowerCase().trim(),
	TERMINAL_DRAFTING_STAGES: ["DECLINED", "CLOSED"],
	isTerminalWorkItemState: (item: {
		draftingStage: string;
		pmAutoHidden: boolean;
	}) =>
		["DECLINED", "CLOSED"].includes(item.draftingStage) ||
		item.pmAutoHidden === true,
}));

vi.mock("../src/lib/create-story-from-proposal", () => ({
	createStoryFromProposal: vi.fn(),
}));

vi.mock("../src/lib/trigger-duplicate-detection", () => ({
	triggerDuplicateDetection: vi.fn(async () => null),
}));

vi.mock("@repo/ai", () => ({
	Output: { object: (spec: unknown) => spec },
	generateText: vi.fn(),
	getAIModelWithMetadata: vi.fn(),
	logModelUsageAsync: vi.fn(),
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@temporalio/activity", async (importOriginal) => ({
	...(await importOriginal<typeof import("@temporalio/activity")>()),
	heartbeat: vi.fn(),
}));

import {
	applyBacklogChanges,
	type ChangeProposal,
} from "../src/activities/backlog-context/analyze-context";
import { appliedUpdateFields } from "../src/activities/backlog-context/proposal-update-decision-note";

type Change = ChangeProposal["changes"][number];

const STORY_ID = "33333333-3333-4333-8333-333333333333";

function updateChange(extra: Partial<Change> = {}): Change {
	return {
		type: "feature",
		action: "update",
		existingId: STORY_ID,
		existingIdentifier: "F-301",
		title: { from: "Export report", to: "Export report as CSV" },
		description: { from: "Users export.", to: "Users export.\nAs CSV." },
		reasoning: "The team asked for CSV in the release thread.",
		sourceContext: "slack_messages",
		// Body merge is not under test: the proposed body is written as is.
		structurePreserved: true,
		...extra,
	};
}

function apply(
	approvedChanges: Change[],
	proposalId: string | null = "example-proposal",
) {
	return applyBacklogChanges({
		projectId: "example-project",
		userId: "example-user",
		organizationId: "example-org",
		approvedByName: "Example Reviewer",
		approvedChanges,
		existingBacklog: { stories: [] },
		pendingProposalId: proposalId ?? undefined,
		proposalId: proposalId ?? undefined,
		approvedChangeIndexes: proposalId ? [3] : undefined,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mockDb.project.findFirst.mockResolvedValue({ id: "example-project" });
	mockDb.userStory.findMany.mockResolvedValue([]);
	mockDb.userStory.findFirst.mockResolvedValue({
		kind: "FEATURE",
		title: "Export report",
		identifier: "F-301",
		description: "Users export.",
		acceptanceCriteria: null,
		labels: [],
		draftingStage: "DRAFT",
		pmAutoHidden: false,
	});
	mockDb.pendingBacklogProposal.findUnique.mockResolvedValue({
		source: "SLACK_CHANNEL",
		summary: "Export updates from the release thread",
	});
	mockDb.pendingBacklogProposalApplication.findMany.mockResolvedValue([]);
	mockDb.$transaction.mockImplementation(
		async (run: (tx: unknown) => unknown) => run({}),
	);
	mocks.updateStory.mockResolvedValue({});
	mocks.recordProposalReviewNote.mockResolvedValue({ written: true });
});

describe("applyBacklogChanges — reviewed update note", () => {
	it("writes one keyed note with the changes and why", async () => {
		const result = await apply([updateChange()]);

		expect(result.updatedItems).toHaveLength(1);
		expect(mocks.recordProposalReviewNote).toHaveBeenCalledOnce();
		expect(mocks.recordProposalReviewNote).toHaveBeenCalledWith({
			tenantFilter: {
				organizationId: "example-org",
				userId: "example-user",
			},
			userStoryId: STORY_ID,
			proposalId: "example-proposal",
			changeIndex: 3,
			outcome: "applied",
			authorName: "Example Reviewer",
			lines: [
				"Proposed update reviewed and applied.",
				"Title: Renamed “Export report” → “Export report as CSV”",
				"Description: 1 line added. Adds “As CSV.”",
				"Why: The team asked for CSV in the release thread.",
				"Prompted by a Slack channel: Export updates from the release thread",
			],
		});
	});

	it("writes no note for an apply without a proposal", async () => {
		const result = await apply([updateChange()], null);

		expect(result.updatedItems).toHaveLength(1);
		expect(mocks.recordProposalReviewNote).not.toHaveBeenCalled();
	});

	it("writes no note for an AI Update sidebar apply", async () => {
		mockDb.pendingBacklogProposal.findUnique.mockResolvedValue({
			source: "AI_UPDATE_SIDEBAR",
			summary: "1 proposed change(s) from AI Update",
		});

		const result = await apply([updateChange()]);

		expect(result.updatedItems).toHaveLength(1);
		expect(mocks.recordProposalReviewNote).not.toHaveBeenCalled();
	});

	it("writes no note when the update changed nothing", async () => {
		await apply([
			updateChange({
				title: { from: "Export report", to: "Export report" },
				description: undefined,
			}),
		]);

		expect(mocks.updateStory).not.toHaveBeenCalled();
		expect(mocks.recordProposalReviewNote).not.toHaveBeenCalled();
	});

	it("keeps the update when the note cannot be written", async () => {
		mocks.recordProposalReviewNote.mockRejectedValue(new Error("db down"));

		const result = await apply([updateChange()]);

		expect(result.updatedItems).toHaveLength(1);
		expect(result.errors).toEqual([]);
		expect(mocks.recordProposalApplication).toHaveBeenCalledOnce();
	});
});

describe("appliedUpdateFields", () => {
	it("reads bodies against the loaded row and skips unwritten fields", () => {
		expect(
			appliedUpdateFields(
				{
					title: { from: "Stale", to: "New" },
					description: { from: "stale body", to: "proposed" },
					priority: { from: "P3_LOW", to: "P1_HIGH" },
				},
				{ description: "merged body" },
				{
					title: "Current",
					description: "current body",
					acceptanceCriteria: null,
				},
			),
		).toEqual({
			title: null,
			description: { from: "current body", to: "merged body" },
			acceptanceCriteria: null,
			priority: null,
			size: null,
		});
	});
});
