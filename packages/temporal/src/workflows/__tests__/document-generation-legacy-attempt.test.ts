/**
 * The document generation child scopes a legacy run's writes to its attempt
 * (Fizzy #2946).
 *
 * A run that is not a coordinated Proposal has no run token, so its progress,
 * save, version and FAILED writes used to land by document id alone: a newer
 * generation, a person's save or the watchdog could have their row flipped
 * back to GENERATING, overwritten or failed by a run they had replaced. When
 * the parent hands the child the attempt's identity (`generationStartedAt`),
 * every one of those writes carries it, and the activity lands it only while
 * the document is still that attempt's. A run without one keeps exactly the
 * arguments it always had, and a coordinated Proposal keeps its run-token
 * save and version unchanged.
 *
 * Harness convention (see `document-generation-stale-regeneration.test.ts`):
 * mock the activity surface and drive the workflow body as a plain function.
 */
import { ActivityFailure, ApplicationFailure } from "@temporalio/workflow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProposalArtifactPlan } from "../../lib/proposal-artifact/types";

const activityStubs = vi.hoisted(() => ({
	retrieveProjectContexts: vi.fn(),
	retrieveAndFormatEpisodicMemory: vi.fn(),
	generateDocumentWithAgent: vi.fn(),
	generateProposalVisuals: vi.fn(),
	saveProjectDocument: vi.fn(),
	createDocumentVersion: vi.fn(),
	embedProjectDocumentActivity: vi.fn(),
	checkProjectHasTeamsIntegration: vi.fn(),
	fetchRecentTeamsMessages: vi.fn(),
	checkProjectHasSlackIntegration: vi.fn(),
	fetchRecentSlackMessages: vi.fn(),
	updateProjectDocumentStatus: vi.fn(),
	runDocumentDecisionPrecheckActivity: vi.fn(),
	planProposalArtifact: vi.fn(),
	clearProposalLiveContent: vi.fn(),
	createProposalAnalysisRun: vi.fn(),
	failProposalAnalysisRun: vi.fn(),
}));

vi.mock("@temporalio/workflow", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@temporalio/workflow")>();
	return {
		...actual,
		log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		patched: vi.fn(() => true),
		proxyActivities: vi.fn(() => activityStubs),
		startChild: vi.fn(async () => ({})),
		workflowInfo: () => ({ runId: "live-run-1", startTime: new Date() }),
	};
});

import { documentGenerationChildWorkflow } from "../document-generation-child";

const ATTEMPT = "2026-10-21T09:00:00.000Z";

const INPUT = {
	projectId: "project-1",
	documentId: "doc-1",
	documentType: "PRD",
	userId: "user-1",
	organizationId: "org-1",
	aiToken: "token-1",
	generationStartedAt: ATTEMPT,
};

const GENERATED = "# PRD\n\nThe generated body.";

const STALE_MESSAGE =
	"This document changed while it was being regenerated, so the regenerated text was discarded and the newer version was kept. Regenerate again to start from the current version.";

const PLAN: ProposalArtifactPlan = {
	liveRunId: "live-run-1",
	baselineVersion: 3,
	baselineContentHash: "planned-main-identity",
	mainPrompt: {
		promptId: "prompt-main",
		versionNumber: 4,
		promptVersionId: "prompt-main-v4",
	},
	analysisPrompt: {
		promptId: "prompt-analysis",
		versionNumber: 2,
		promptVersionId: "prompt-analysis-v2",
	},
	analysisSkipReason: null,
	triggeredByGuest: false,
};

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => {
			throw new Error("expected a failure");
		},
		(error: unknown) => error,
	);
}

function statusWrites(status: string): Array<Record<string, unknown>> {
	return activityStubs.updateProjectDocumentStatus.mock.calls
		.map(([input]) => input as Record<string, unknown>)
		.filter((input) => input.status === status);
}

beforeEach(() => {
	vi.clearAllMocks();
	for (const fn of Object.values(activityStubs)) {
		fn.mockReset();
		fn.mockResolvedValue(undefined);
	}
	// The Proposal artifact gate is off unless a test turns it on.
	activityStubs.planProposalArtifact.mockResolvedValue(null);
	activityStubs.retrieveProjectContexts.mockResolvedValue([]);
	activityStubs.retrieveAndFormatEpisodicMemory.mockResolvedValue({
		formattedContext: "",
		episodeCount: 0,
	});
	activityStubs.checkProjectHasTeamsIntegration.mockResolvedValue(false);
	activityStubs.checkProjectHasSlackIntegration.mockResolvedValue(false);
	activityStubs.generateDocumentWithAgent.mockResolvedValue({
		content: GENERATED,
		resolvedPromptVersionId: "prompt-v1",
	});
	activityStubs.embedProjectDocumentActivity.mockResolvedValue({
		success: true,
	});
});

describe("document generation — a legacy run with an attempt identity", () => {
	it("reports every progress step under the attempt", async () => {
		await documentGenerationChildWorkflow(INPUT);

		const progress = statusWrites("GENERATING");
		// 15, 25, 30 on the retrieval path, then 35 and 80 around generation.
		expect(progress.map((write) => write.progress)).toEqual([
			15, 25, 30, 35, 80,
		]);
		for (const write of progress) {
			expect(write).toMatchObject({ generationStartedAt: ATTEMPT });
			expect(write.liveRunId).toBeUndefined();
		}
	});

	it("reports progress under the attempt on the direct-context path too", async () => {
		await documentGenerationChildWorkflow({
			...INPUT,
			directContext: ["The orchestrator's analysis."],
		});

		const progress = statusWrites("GENERATING");
		expect(progress.map((write) => write.progress)).toEqual([30, 35, 80]);
		for (const write of progress) {
			expect(write).toMatchObject({ generationStartedAt: ATTEMPT });
		}
	});

	it("saves and versions under the attempt", async () => {
		const result = await documentGenerationChildWorkflow(INPUT);

		expect(result.success).toBe(true);
		expect(activityStubs.saveProjectDocument.mock.calls).toEqual([
			["doc-1", GENERATED, "user-1", { generationStartedAt: ATTEMPT }],
		]);
		expect(activityStubs.createDocumentVersion.mock.calls).toEqual([
			[
				"doc-1",
				GENERATED,
				"user-1",
				"prompt-v1",
				{ generationStartedAt: ATTEMPT },
			],
		]);
	});

	it("hands a visual-slot baseline and the attempt to both writes", async () => {
		activityStubs.generateDocumentWithAgent.mockResolvedValue({
			content: GENERATED,
			resolvedPromptVersionId: "prompt-v1",
			baselineVersion: 7,
		});

		await documentGenerationChildWorkflow(INPUT);

		expect(activityStubs.saveProjectDocument.mock.calls).toEqual([
			[
				"doc-1",
				GENERATED,
				"user-1",
				{ baselineVersion: 7, generationStartedAt: ATTEMPT },
			],
		]);
		expect(activityStubs.createDocumentVersion.mock.calls).toEqual([
			[
				"doc-1",
				GENERATED,
				"user-1",
				"prompt-v1",
				{ baselineVersion: 7, generationStartedAt: ATTEMPT },
			],
		]);
	});

	it("marks the document FAILED under the attempt when generation fails", async () => {
		activityStubs.generateDocumentWithAgent.mockRejectedValue(
			new Error("agent unreachable"),
		);

		const failure = await failureOf(documentGenerationChildWorkflow(INPUT));

		expect((failure as ApplicationFailure).type).toBe(
			"DOCUMENT_GENERATION_CHILD_FAILED",
		);
		expect(statusWrites("FAILED")).toEqual([
			{
				documentId: "doc-1",
				status: "FAILED",
				progress: 0,
				error: "agent unreachable",
				liveRunId: undefined,
				generationStartedAt: ATTEMPT,
			},
		]);
	});

	it("ends with today's failure type when the save under the attempt is refused", async () => {
		activityStubs.saveProjectDocument.mockRejectedValue(
			new ActivityFailure(
				"Activity task failed",
				"saveProjectDocument",
				"1",
				"NON_RETRYABLE_FAILURE",
				"worker@example.com",
				ApplicationFailure.nonRetryable(
					STALE_MESSAGE,
					"DOCUMENT_GENERATION_STALE",
				),
			),
		);

		const failure = await failureOf(documentGenerationChildWorkflow(INPUT));

		// The parents' handling stays today's: their own FAILED write is
		// scoped to the same attempt, so it is a no-op on a replaced row.
		expect((failure as ApplicationFailure).type).toBe(
			"DOCUMENT_GENERATION_CHILD_FAILED",
		);
		expect((failure as ApplicationFailure).message).toBe(STALE_MESSAGE);
		expect(statusWrites("FAILED")).toEqual([
			expect.objectContaining({ generationStartedAt: ATTEMPT }),
		]);
		expect(activityStubs.createDocumentVersion).not.toHaveBeenCalled();
		expect(
			activityStubs.embedProjectDocumentActivity,
		).not.toHaveBeenCalled();
	});
});

describe("document generation — a legacy run without an attempt identity", () => {
	it("keeps today's arguments on every write", async () => {
		const { generationStartedAt: _attempt, ...withoutAttempt } = INPUT;

		await documentGenerationChildWorkflow(withoutAttempt);

		for (const write of statusWrites("GENERATING")) {
			expect(write).not.toHaveProperty("generationStartedAt");
		}
		const [save] = activityStubs.saveProjectDocument.mock.calls;
		expect(save).toEqual(["doc-1", GENERATED, "user-1"]);
		expect(save).toHaveLength(3);
		const [version] = activityStubs.createDocumentVersion.mock.calls;
		expect(version).toEqual(["doc-1", GENERATED, "user-1", "prompt-v1"]);
		expect(version).toHaveLength(4);
	});

	it("marks the document FAILED with today's input", async () => {
		const { generationStartedAt: _attempt, ...withoutAttempt } = INPUT;
		activityStubs.generateDocumentWithAgent.mockRejectedValue(
			new Error("agent unreachable"),
		);

		await failureOf(documentGenerationChildWorkflow(withoutAttempt));

		expect(statusWrites("FAILED")).toHaveLength(1);
		expect(statusWrites("FAILED")[0]).not.toHaveProperty(
			"generationStartedAt",
		);
	});
});

describe("document generation — a coordinated Proposal with an attempt identity", () => {
	beforeEach(() => {
		activityStubs.planProposalArtifact.mockResolvedValue(PLAN);
	});

	it("keeps its run-token save and version exactly as they were", async () => {
		await documentGenerationChildWorkflow({
			...INPUT,
			documentType: "PROPOSAL",
		});

		expect(activityStubs.saveProjectDocument.mock.calls).toEqual([
			[
				"doc-1",
				GENERATED,
				"user-1",
				{
					baselineVersion: 3,
					liveRunId: "live-run-1",
					baselineContentHash: "planned-main-identity",
				},
			],
		]);
		expect(activityStubs.createDocumentVersion.mock.calls).toEqual([
			[
				"doc-1",
				GENERATED,
				"user-1",
				"prompt-v1",
				{ baselineVersion: 3, liveRunId: "live-run-1" },
			],
		]);
		// Its progress writes stay under the run token, which the activity
		// applies ahead of anything else.
		for (const write of statusWrites("GENERATING")) {
			expect(write.liveRunId).toBe("live-run-1");
		}
	});
});
