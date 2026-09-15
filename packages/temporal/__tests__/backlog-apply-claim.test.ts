/**
 * Plan §F3 — proposal apply claim protocol and idempotent application.
 *
 *   - `claimPendingProposalForApply` / `finalizeClaimedProposal`: compare-and-
 *     swap on the proposal row so only one apply owns it.
 *   - `applyBacklogChanges` with a `proposalId`: every applied change is
 *     recorded in `pending_backlog_proposal_application`, already-recorded
 *     indexes are skipped, and creates carry an idempotency key so a retry
 *     after a crash reuses the row instead of duplicating it.
 *
 * fabric-dev port: there are no Epic/Feature container tables. Scope lines
 * create UserStory rows directly (`createStory`, IMPORTED_SCOPE); every other
 * proposal create goes through `createStoryFromProposal`; areas are labels.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDb, mocks } = vi.hoisted(() => {
	const mockDb = {
		project: { findFirst: vi.fn() },
		userStory: { findFirst: vi.fn(), findMany: vi.fn() },
		pendingBacklogProposal: {
			updateMany: vi.fn(),
			findUnique: vi.fn(),
			update: vi.fn(),
		},
		pendingBacklogProposalApplication: {
			findMany: vi.fn(),
			create: vi.fn(),
		},
		$transaction: vi.fn(),
	};
	const mocks = {
		createStory: vi.fn(),
		updateStory: vi.fn(),
		recordAudit: vi.fn(),
		recordProposalApplication: vi.fn(),
		createStoryFromProposal: vi.fn(),
	};
	return { mockDb, mocks };
});

vi.mock("@repo/database", async () => {
	return {
		db: mockDb,
		tenantWhere: vi.fn(() => ({})),
		createStory: mocks.createStory,
		updateStory: mocks.updateStory,
		recordAudit: mocks.recordAudit,
		recordProposalApplication: mocks.recordProposalApplication,
		getBoundPromptForAgent: vi.fn(),
		normalizeBacklogTitle: (title: string) => title.toLowerCase().trim(),
		TERMINAL_DRAFTING_STAGES: ["DECLINED", "CLOSED"],
		isTerminalWorkItemState: (item: {
			draftingStage: string;
			pmAutoHidden: boolean;
		}) =>
			["DECLINED", "CLOSED"].includes(item.draftingStage) ||
			item.pmAutoHidden === true,
	};
});

vi.mock("@repo/database/prisma/client", () => ({ db: mockDb }));

vi.mock("../src/lib/create-story-from-proposal", () => ({
	createStoryFromProposal: mocks.createStoryFromProposal,
}));

vi.mock("../src/lib/trigger-duplicate-detection", () => ({
	triggerDuplicateDetection: vi.fn(async () => ({
		workflowId: "dup-detect-test",
	})),
}));

vi.mock("@repo/ai", () => ({
	generateObject: vi.fn(),
	getAIModelWithMetadata: vi.fn(),
	logModelUsageAsync: vi.fn(),
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@temporalio/activity", () => ({
	heartbeat: vi.fn(),
	ApplicationFailure: { nonRetryable: (m: string) => new Error(m) },
}));

import {
	claimPendingProposalForApply,
	finalizeClaimedProposal,
} from "../../database/prisma/queries/projects/pending-backlog-proposals";
import {
	applyBacklogChanges,
	type ChangeProposal,
	isUniqueViolation,
} from "../src/activities/backlog-context/analyze-context";

const emptyBacklog = { stories: [] };

function featureChange(
	title: string,
	extra: Partial<ChangeProposal["changes"][number]> = {},
): ChangeProposal["changes"][number] {
	return {
		type: "feature",
		action: "create",
		title: { to: title },
		reasoning: "test",
		sourceContext: "scope_document",
		...extra,
	};
}

function p2002(target: string) {
	return Object.assign(new Error("Unique constraint failed"), {
		code: "P2002",
		meta: { target: [target] },
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mockDb.project.findFirst.mockResolvedValue({ id: "p1" });
	mockDb.userStory.findMany.mockResolvedValue([]);
	mockDb.pendingBacklogProposalApplication.findMany.mockResolvedValue([]);
	mockDb.$transaction.mockImplementation(
		async (fn: (tx: unknown) => Promise<unknown>) => fn(mockDb),
	);
	let n = 0;
	mocks.createStory.mockImplementation(async (data: { title: string }) => {
		n += 1;
		return {
			id: `story-${n}`,
			identifier: `F-00${n}`,
			title: data.title,
			description: null,
		};
	});
	let m = 0;
	mocks.createStoryFromProposal.mockImplementation(
		async (params: { title: string }) => {
			m += 1;
			return {
				story: {
					id: `drafted-${m}`,
					identifier: `F-10${m}`,
					title: params.title,
					description: null,
				},
				aiDrafted: false,
			};
		},
	);
});

describe("claimPendingProposalForApply", () => {
	it("claims when the CAS updates exactly one PENDING|FAILED row", async () => {
		mockDb.pendingBacklogProposal.updateMany.mockResolvedValueOnce({
			count: 1,
		});
		const ok = await claimPendingProposalForApply({
			proposalId: "prop-1",
			reviewedBy: "u1",
			applyWorkflowId: "wf-1",
		});
		expect(ok).toBe(true);
		const call = mockDb.pendingBacklogProposal.updateMany.mock.calls[0][0];
		expect(call.where).toEqual({
			id: "prop-1",
			status: { in: ["PENDING", "FAILED"] },
		});
		expect(call.data).toMatchObject({
			status: "APPLYING",
			applyWorkflowId: "wf-1",
			reviewedBy: "u1",
			applyError: null,
		});
	});

	it("returns false for the second claimant (row already APPLYING)", async () => {
		mockDb.pendingBacklogProposal.updateMany
			.mockResolvedValueOnce({ count: 1 })
			.mockResolvedValueOnce({ count: 0 });
		const first = await claimPendingProposalForApply({
			proposalId: "prop-1",
			reviewedBy: "u1",
			applyWorkflowId: "wf-1",
		});
		const second = await claimPendingProposalForApply({
			proposalId: "prop-1",
			reviewedBy: "u2",
			applyWorkflowId: "wf-2",
		});
		expect(first).toBe(true);
		expect(second).toBe(false);
	});
});

describe("finalizeClaimedProposal", () => {
	it("only lets the claimant flip APPLYING → APPLIED", async () => {
		mockDb.pendingBacklogProposal.updateMany.mockResolvedValueOnce({
			count: 1,
		});
		const ok = await finalizeClaimedProposal({
			proposalId: "prop-1",
			applyWorkflowId: "wf-1",
			outcome: "applied",
		});
		expect(ok).toBe(true);
		const call = mockDb.pendingBacklogProposal.updateMany.mock.calls[0][0];
		expect(call.where).toEqual({
			id: "prop-1",
			status: "APPLYING",
			applyWorkflowId: "wf-1",
		});
		expect(call.data.status).toBe("APPLIED");
	});

	it("refuses a non-claimant (CAS matches zero rows)", async () => {
		mockDb.pendingBacklogProposal.updateMany.mockResolvedValueOnce({
			count: 0,
		});
		const ok = await finalizeClaimedProposal({
			proposalId: "prop-1",
			applyWorkflowId: "wf-intruder",
			outcome: "failed",
			errorMessage: "boom",
		});
		expect(ok).toBe(false);
		const call = mockDb.pendingBacklogProposal.updateMany.mock.calls[0][0];
		expect(call.where.applyWorkflowId).toBe("wf-intruder");
		expect(call.data).toMatchObject({
			status: "FAILED",
			applyError: "boom",
		});
	});
});

describe("applyBacklogChanges with proposalId", () => {
	it("records an application per applied change, in a transaction", async () => {
		const changes = [
			featureChange("A", { sourceRef: "AA-01" }),
			featureChange("B", { sourceRef: "AA-02" }),
		];
		const result = await applyBacklogChanges({
			projectId: "p1",
			userId: "u1",
			approvedChanges: changes,
			existingBacklog: emptyBacklog,
			proposalId: "prop-1",
			approvedChangeIndexes: [3, 7],
		});
		expect(result.appliedCount).toBe(2);
		expect(result.skippedAlreadyApplied).toEqual([]);
		expect(mocks.recordProposalApplication).toHaveBeenCalledTimes(2);
		expect(mockDb.$transaction).toHaveBeenCalledTimes(2);
		const recorded = mocks.recordProposalApplication.mock.calls.map(
			(c) => c[1],
		);
		expect(recorded).toEqual([
			expect.objectContaining({
				proposalId: "prop-1",
				changeIndex: 3,
				action: "create",
				createdEntityType: "story",
				createdEntityId: "story-1",
			}),
			expect.objectContaining({
				proposalId: "prop-1",
				changeIndex: 7,
				createdEntityId: "story-2",
			}),
		]);
		// Scope lines are created as IMPORTED_SCOPE with provenance and key.
		expect(mocks.createStory.mock.calls[0][0]).toMatchObject({
			source: "IMPORTED_SCOPE",
			sourceRef: "AA-01",
			draftingStage: "PLACEHOLDER",
			proposalApplicationKey: "proposal:prop-1:3",
		});
		expect(mocks.createStoryFromProposal).not.toHaveBeenCalled();
	});

	it("skips indexes already recorded and surfaces their entity ids", async () => {
		mockDb.pendingBacklogProposalApplication.findMany.mockResolvedValue([
			{
				changeIndex: 3,
				createdEntityType: "story",
				createdEntityId: "story-prev",
			},
		]);
		const result = await applyBacklogChanges({
			projectId: "p1",
			userId: "u1",
			approvedChanges: [
				featureChange("A", { sourceRef: "AA-01" }),
				featureChange("B", { sourceRef: "AA-02" }),
			],
			existingBacklog: emptyBacklog,
			proposalId: "prop-1",
			approvedChangeIndexes: [3, 7],
		});
		expect(result.skippedAlreadyApplied).toEqual([3]);
		expect(result.createdItemMap[0]).toBe("story-prev");
		expect(mocks.createStory).toHaveBeenCalledTimes(1);
		expect(mocks.createStory.mock.calls[0][0].title).toBe("B");
		expect(mocks.recordProposalApplication).toHaveBeenCalledTimes(1);
	});

	it("treats a sourceRef unique violation as already applied (crash between create and record)", async () => {
		mocks.createStory.mockRejectedValueOnce(p2002("sourceRef"));
		mockDb.userStory.findFirst.mockResolvedValueOnce({
			id: "story-existing",
			identifier: "F-009",
			title: "A",
			description: null,
		});
		const result = await applyBacklogChanges({
			projectId: "p1",
			userId: "u1",
			approvedChanges: [featureChange("A", { sourceRef: "AA-01" })],
			existingBacklog: emptyBacklog,
			proposalId: "prop-1",
			approvedChangeIndexes: [0],
		});
		expect(result.errors).toEqual([]);
		expect(result.createdItemMap[0]).toBe("story-existing");
		expect(mocks.recordProposalApplication).toHaveBeenCalledTimes(1);
		expect(mockDb.userStory.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { projectId: "p1", sourceRef: "AA-01" },
			}),
		);
	});

	it("uses AI drafting for proposal creates without a sourceRef, carrying the key and the thread context", async () => {
		await applyBacklogChanges({
			projectId: "p1",
			userId: "u1",
			approvedChanges: [
				featureChange("Teams idea", {
					sourceContext: "teams_messages",
					reasoning: "Discussed in #general",
				}),
			],
			existingBacklog: emptyBacklog,
			proposalId: "prop-2",
			approvedChangeIndexes: [4],
			draftingContext: "## Thread in #general\n**bob**: we need X",
		});
		expect(mocks.createStory).not.toHaveBeenCalled();
		expect(mocks.createStoryFromProposal).toHaveBeenCalledTimes(1);
		const params = mocks.createStoryFromProposal.mock.calls[0][0];
		expect(params).toMatchObject({
			proposalApplicationKey: "proposal:prop-2:4",
		});
		expect(params.additionalContext).toContain("#general");
		expect(params.additionalContext).toContain("Discussed in #general");
		expect(mocks.recordProposalApplication.mock.calls[0][1]).toMatchObject({
			changeIndex: 4,
			createdEntityId: "drafted-1",
		});
	});

	it("treats an application-key unique violation as already applied (crash between create and record, no sourceRef)", async () => {
		mocks.createStoryFromProposal.mockRejectedValueOnce(
			p2002("proposalApplicationKey"),
		);
		mockDb.userStory.findFirst.mockResolvedValueOnce({
			id: "story-keyed",
			identifier: "F-011",
			title: "Keyed",
			description: null,
		});
		const result = await applyBacklogChanges({
			projectId: "p1",
			userId: "u1",
			approvedChanges: [featureChange("Keyed")],
			existingBacklog: emptyBacklog,
			proposalId: "prop-3",
			approvedChangeIndexes: [5],
		});
		expect(result.errors).toEqual([]);
		expect(result.createdItemMap[0]).toBe("story-keyed");
		expect(mockDb.userStory.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					projectId: "p1",
					proposalApplicationKey: "proposal:prop-3:5",
				},
			}),
		);
	});

	it("carries scope areas as labels (no container rows in this codebase)", async () => {
		await applyBacklogChanges({
			projectId: "p1",
			userId: "u1",
			approvedChanges: [
				featureChange("Line", {
					sourceRef: "VIS-02",
					labels: ["phase:1", "area:VIS — Visualization"],
				}),
				featureChange("Named parent only", {
					parentEpicTitle: "INT — Integrations",
				}),
			],
			existingBacklog: emptyBacklog,
		});
		expect(mocks.createStory.mock.calls[0][0].labels).toEqual([
			"phase:1",
			"area:VIS — Visualization",
		]);
		expect(mocks.createStoryFromProposal.mock.calls[0][0].labels).toContain(
			"area:INT — Integrations",
		);
	});

	it("is a no-op for application records without a proposalId", async () => {
		await applyBacklogChanges({
			projectId: "p1",
			userId: "u1",
			approvedChanges: [featureChange("Plain")],
			existingBacklog: emptyBacklog,
		});
		expect(mocks.recordProposalApplication).not.toHaveBeenCalled();
		expect(mockDb.pendingBacklogProposalApplication.findMany).not
			.toHaveBeenCalled;
		expect(
			mocks.createStoryFromProposal.mock.calls[0][0]
				.proposalApplicationKey,
		).toBeUndefined();
	});
});

describe("isUniqueViolation", () => {
	it("matches P2002 with or without a target hint", () => {
		const err = {
			code: "P2002",
			meta: { target: ["projectId", "sourceRef"] },
		};
		expect(isUniqueViolation(err)).toBe(true);
		expect(isUniqueViolation(err, "sourceRef")).toBe(true);
		expect(isUniqueViolation({ code: "P2025" })).toBe(false);
		expect(isUniqueViolation(new Error("x"))).toBe(false);
	});
});

describe("applyBacklogChanges for an Explore proposal", () => {
	it("creates the proposed spikes as runnable items carrying the SPIKE track", async () => {
		const changes = [
			featureChange("Can we stream 200 MB PDFs through the browser?", {
				sourceContext: "multiple",
				deliveryTrack: "SPIKE",
			}),
			featureChange("Does the pool-sensor API rate-limit polling?", {
				sourceContext: "multiple",
				deliveryTrack: "SPIKE",
			}),
		];
		const result = await applyBacklogChanges({
			projectId: "p1",
			userId: "u1",
			approvedChanges: changes,
			existingBacklog: emptyBacklog,
			proposalId: "prop-explore",
			approvedChangeIndexes: [0, 1],
		});
		expect(result.appliedCount).toBe(2);
		// Proposal creates without a sourceRef go through the drafting helper;
		// the track must survive that hop.
		expect(mocks.createStoryFromProposal).toHaveBeenCalledTimes(2);
		for (const call of mocks.createStoryFromProposal.mock.calls) {
			expect(call[0]).toMatchObject({
				projectId: "p1",
				deliveryTrack: "SPIKE",
				trackSetBy: "AI",
				source: "AI_UPDATE",
			});
		}
		expect(result.createdItems.map((item) => item.type)).toEqual([
			"feature",
			"feature",
		]);
	});
});
