/**
 * Spike acceptance / discard (plan Slice 3).
 *
 * Run with: pnpm --filter @repo/database test __tests__/spike-runs.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	client: {
		codingRun: { findFirst: vi.fn(), updateMany: vi.fn() },
		userStory: { findFirst: vi.fn(), update: vi.fn() },
		featureVersion: { findFirst: vi.fn(), create: vi.fn() },
	},
	updateStoryDraftingStage: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: { ...mocks.client, $transaction: async (fn: any) => fn(mocks.client) },
}));

vi.mock("../prisma/queries/projects/stories", () => ({
	updateStoryDraftingStage: mocks.updateStoryDraftingStage,
}));

import {
	appendSpikeFindingsToDescription,
	applySpikeFindings,
	discardSpikeRun,
	SpikeRunNotFoundError,
	SpikeRunStateError,
} from "../prisma/queries/coding-runs";
import { StageTransitionBlockedError } from "../src/delivery/transition-story";

const client = mocks.client as any;

const demoReadyRun = {
	id: "run-1",
	kind: "SPIKE",
	status: "DEMO_READY",
	storyId: "story-1",
	projectId: "proj-1",
	findings: "## Answer\nYes, feasible.",
	demoUrl: "/app/frames/frame-1",
};

const story = {
	id: "story-1",
	version: 3,
	description: "Original description",
	acceptanceCriteria: "AC",
	draftingStage: "PLACEHOLDER",
};

const params = {
	codingRunId: "run-1",
	projectId: "proj-1",
	organizationId: "org-1",
	userId: "user-1",
	playNotes: "Tried the demo with the PM; export worked end to end.",
};

beforeEach(() => {
	vi.clearAllMocks();
	client.codingRun.findFirst.mockResolvedValue(demoReadyRun);
	client.userStory.findFirst.mockResolvedValue(story);
	client.featureVersion.findFirst.mockResolvedValue({ version: 3 });
	client.featureVersion.create.mockResolvedValue({});
	client.userStory.update.mockResolvedValue({});
	client.codingRun.updateMany.mockResolvedValue({ count: 1 });
	mocks.updateStoryDraftingStage.mockResolvedValue({ id: "story-1" });
});

describe("appendSpikeFindingsToDescription", () => {
	it("appends a markdown section to plain text", () => {
		const out = appendSpikeFindingsToDescription("Body", {
			codingRunId: "run-1",
			findings: "## Answer\nYes",
			demoUrl: "/app/frames/f1",
		});
		expect(out).toBe(
			"Body\n\n## Spike findings (run run-1)\n\n## Answer\nYes\n\nDemo: /app/frames/f1",
		);
	});

	it("appends nodes to a TipTap document", () => {
		const doc = JSON.stringify({
			type: "doc",
			content: [
				{
					type: "paragraph",
					content: [{ type: "text", text: "Body" }],
				},
			],
		});
		const out = JSON.parse(
			appendSpikeFindingsToDescription(doc, {
				codingRunId: "run-1",
				findings: "Para one\n\nPara two",
				demoUrl: "/app/frames/f1",
			}),
		);
		expect(out.type).toBe("doc");
		expect(out.content).toHaveLength(1 + 1 + 2 + 1);
		expect(out.content[1]).toEqual({
			type: "heading",
			attrs: { level: 2 },
			content: [{ type: "text", text: "Spike findings (run run-1)" }],
		});
		expect(out.content[4].content[0].text).toBe("Demo: /app/frames/f1");
	});

	it("starts a fresh section when the description is empty", () => {
		const out = appendSpikeFindingsToDescription(null, {
			codingRunId: "run-1",
			findings: "Yes",
			demoUrl: null,
		});
		expect(out).toBe("## Spike findings (run run-1)\n\nYes");
	});
});

describe("applySpikeFindings", () => {
	it("appends findings, snapshots a version, sets COMPLETED with play notes and advances the stage", async () => {
		const result = await applySpikeFindings(params);

		expect(client.codingRun.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "run-1",
					projectId: "proj-1",
					organizationId: "org-1",
				},
			}),
		);
		expect(client.featureVersion.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				storyId: "story-1",
				version: 4,
				description: expect.stringContaining(
					"Spike findings (run run-1)",
				),
				changeDescription: "Spike findings applied (run run-1)",
				changedBy: "user-1",
				organizationId: "org-1",
			}),
		});
		expect(client.userStory.update).toHaveBeenCalledWith({
			where: { id: "story-1" },
			data: {
				description: expect.stringContaining("Yes, feasible."),
				version: 4,
			},
		});
		expect(client.codingRun.updateMany).toHaveBeenCalledWith({
			where: { id: "run-1", status: "DEMO_READY" },
			data: { status: "COMPLETED", playNotes: params.playNotes },
		});
		expect(mocks.updateStoryDraftingStage).toHaveBeenCalledWith(
			"story-1",
			"proj-1",
			"ACTIVE_ANALYSIS",
			expect.objectContaining({
				userId: "user-1",
				organizationId: "org-1",
				changedBy: "user-1",
				transitionReason: "spike_accepted",
			}),
		);
		expect(result).toEqual({
			codingRunId: "run-1",
			status: "COMPLETED",
			storyId: "story-1",
			projectId: "proj-1",
			version: 4,
			stageTransition: { outcome: "applied", toStage: "ACTIVE_ANALYSIS" },
		});
	});

	it("honours nextTrack as a HUMAN track change", async () => {
		await applySpikeFindings({ ...params, nextTrack: "SPECIFY" });
		expect(client.userStory.update).toHaveBeenCalledWith({
			where: { id: "story-1" },
			data: expect.objectContaining({
				deliveryTrack: "SPECIFY",
				trackSetBy: "HUMAN",
				trackRationale: "Set on spike acceptance",
				trackUpdatedAt: expect.any(Date),
			}),
		});
	});

	it("does not advance a story already at or above ACTIVE_ANALYSIS", async () => {
		client.userStory.findFirst.mockResolvedValue({
			...story,
			draftingStage: "DRAFT",
		});
		const result = await applySpikeFindings(params);
		expect(mocks.updateStoryDraftingStage).not.toHaveBeenCalled();
		expect(result.stageTransition).toEqual({
			outcome: "skipped",
			reason: "already_at_or_above",
		});
	});

	it("tolerates a governed request result (acceptance still succeeds)", async () => {
		mocks.updateStoryDraftingStage.mockResolvedValue({
			id: "story-1",
			pendingStageRequestId: "req-1",
		});
		const result = await applySpikeFindings(params);
		expect(result.status).toBe("COMPLETED");
		expect(result.stageTransition).toEqual({
			outcome: "requested",
			requestId: "req-1",
		});
	});

	it("tolerates a blocked stage transition (acceptance still succeeds)", async () => {
		mocks.updateStoryDraftingStage.mockRejectedValue(
			new StageTransitionBlockedError({
				toStage: "ACTIVE_ANALYSIS",
				readiness: {
					ready: false,
					missing: ["ACCEPTANCE_CRITERIA_MISSING"],
					advisory: [],
					effectiveTrack: "SPIKE",
				} as any,
			}),
		);
		const result = await applySpikeFindings(params);
		expect(result.status).toBe("COMPLETED");
		expect(result.stageTransition.outcome).toBe("blocked");
	});

	it("rethrows unexpected stage transition errors", async () => {
		mocks.updateStoryDraftingStage.mockRejectedValue(new Error("db down"));
		await expect(applySpikeFindings(params)).rejects.toThrow("db down");
	});

	it("throws SpikeRunNotFoundError for a run outside the project/tenant", async () => {
		client.codingRun.findFirst.mockResolvedValue(null);
		await expect(applySpikeFindings(params)).rejects.toBeInstanceOf(
			SpikeRunNotFoundError,
		);
		expect(client.userStory.update).not.toHaveBeenCalled();
	});

	it("throws SpikeRunStateError when the run is not DEMO_READY", async () => {
		client.codingRun.findFirst.mockResolvedValue({
			...demoReadyRun,
			status: "RUNNING",
		});
		await expect(applySpikeFindings(params)).rejects.toBeInstanceOf(
			SpikeRunStateError,
		);
		expect(client.featureVersion.create).not.toHaveBeenCalled();
	});

	it("throws SpikeRunStateError when the run is not a spike", async () => {
		client.codingRun.findFirst.mockResolvedValue({
			...demoReadyRun,
			kind: "IMPLEMENT",
		});
		await expect(applySpikeFindings(params)).rejects.toBeInstanceOf(
			SpikeRunStateError,
		);
	});

	it("fails closed when a DEMO_READY run has no findings", async () => {
		client.codingRun.findFirst.mockResolvedValue({
			...demoReadyRun,
			findings: null,
		});
		await expect(applySpikeFindings(params)).rejects.toBeInstanceOf(
			SpikeRunStateError,
		);
	});

	it("fails when a concurrent acceptance won the compare-and-swap", async () => {
		client.codingRun.updateMany.mockResolvedValue({ count: 0 });
		await expect(applySpikeFindings(params)).rejects.toBeInstanceOf(
			SpikeRunStateError,
		);
		expect(mocks.updateStoryDraftingStage).not.toHaveBeenCalled();
	});
});

describe("discardSpikeRun", () => {
	it("moves DEMO_READY to CANCELLED and records the reason", async () => {
		const result = await discardSpikeRun({
			codingRunId: "run-1",
			projectId: "proj-1",
			organizationId: null,
			reason: "Not worth it",
		});
		expect(client.codingRun.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "run-1",
					projectId: "proj-1",
					organizationId: null,
				},
			}),
		);
		expect(client.codingRun.updateMany).toHaveBeenCalledWith({
			where: { id: "run-1", status: "DEMO_READY" },
			data: { status: "CANCELLED", playNotes: "Not worth it" },
		});
		expect(result).toEqual({
			codingRunId: "run-1",
			status: "CANCELLED",
			storyId: "story-1",
		});
	});

	it("rejects a run that is not DEMO_READY", async () => {
		client.codingRun.findFirst.mockResolvedValue({
			...demoReadyRun,
			status: "COMPLETED",
		});
		await expect(
			discardSpikeRun({ codingRunId: "run-1", projectId: "proj-1" }),
		).rejects.toBeInstanceOf(SpikeRunStateError);
		expect(client.codingRun.updateMany).not.toHaveBeenCalled();
	});
});
