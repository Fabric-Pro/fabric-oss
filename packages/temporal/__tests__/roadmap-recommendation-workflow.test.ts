/**
 * Behavioral (TestWorkflowEnvironment) tests for
 * `roadmapRecommendationWorkflow` (Fizzy #2208). Bundles the REAL workflow
 * from the workflows barrel (so the export is proven by executing it by name)
 * and injects mocked activities.
 *
 * Offline note: `TestWorkflowEnvironment.createTimeSkipping()` downloads a
 * Temporal test-server binary on first use.
 *
 * Run with:
 *   pnpm --filter @repo/temporal test __tests__/roadmap-recommendation-workflow.test.ts
 */

import { resolve } from "node:path";
import { WorkflowFailedError } from "@temporalio/client";
import { ApplicationFailure } from "@temporalio/common";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import {
	bundleWorkflowCode,
	Worker,
	type WorkflowBundleWithSourceMap,
} from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RoadmapRecommendationInput } from "../src/workflows/roadmap-recommendation-workflow";

const WORKFLOWS_PATH = resolve(__dirname, "..", "src", "workflows");
const WORKFLOW_NAME = "roadmapRecommendationWorkflow";

const INPUT: RoadmapRecommendationInput = {
	projectId: "p1",
	userId: "u1",
	organizationId: "org-1",
	entryPoint: "MATURE_ROADMAP",
	requestedAt: "2026-09-23T10:00:00.000Z",
};

const GATHERED = {
	fetchedContext: { ragContext: "RAG: brokers need status" },
	existingBacklog: { stories: [] },
	stats: { ragChunkCount: 2, roadmapItemCount: 0, descriptionChars: 0 },
	insufficient: false,
};

let env: TestWorkflowEnvironment;
let workflowBundle: WorkflowBundleWithSourceMap;

beforeAll(async () => {
	env = await TestWorkflowEnvironment.createTimeSkipping();
	workflowBundle = await bundleWorkflowCode({
		workflowsPath: WORKFLOWS_PATH,
	});
}, 120_000);

afterAll(async () => {
	await env?.teardown();
});

let taskQueueSeq = 0;

type Mocks = {
	gatherRoadmapRecommendationContext: ReturnType<typeof vi.fn>;
	analyzeContextAndPropose: ReturnType<typeof vi.fn>;
	persistRoadmapRecommendations: ReturnType<typeof vi.fn>;
};

async function runWorkflow(mocks: Mocks): Promise<unknown> {
	const taskQueue = `roadmap-recommendation-${taskQueueSeq++}`;
	const worker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowBundle,
		activities: mocks,
	});
	return await worker.runUntil(
		env.client.workflow.execute(WORKFLOW_NAME, {
			args: [INPUT],
			taskQueue,
			workflowId: `${taskQueue}-wf`,
		}),
	);
}

describe("roadmapRecommendationWorkflow", () => {
	it("returns INSUFFICIENT_CONTEXT without calling the analyzer", async () => {
		const mocks = {
			gatherRoadmapRecommendationContext: vi
				.fn()
				.mockResolvedValue({ ...GATHERED, insufficient: true }),
			analyzeContextAndPropose: vi.fn(),
			persistRoadmapRecommendations: vi.fn(),
		};
		const result = await runWorkflow(mocks);
		expect(result).toEqual({
			outcome: "INSUFFICIENT_CONTEXT",
			entryPoint: "MATURE_ROADMAP",
			proposalId: null,
			changeCount: 0,
		});
		expect(mocks.analyzeContextAndPropose).not.toHaveBeenCalled();
		expect(mocks.persistRoadmapRecommendations).not.toHaveBeenCalled();
	});

	it("generates in recommend mode and returns the persisted batch", async () => {
		const proposal = { summary: "", changes: [] };
		const mocks = {
			gatherRoadmapRecommendationContext: vi
				.fn()
				.mockResolvedValue(GATHERED),
			analyzeContextAndPropose: vi.fn().mockResolvedValue(proposal),
			persistRoadmapRecommendations: vi.fn().mockResolvedValue({
				outcome: "GENERATED",
				proposalId: "batch-1",
				changeCount: 27,
			}),
		};
		const result = await runWorkflow(mocks);
		expect(result).toEqual({
			outcome: "GENERATED",
			entryPoint: "MATURE_ROADMAP",
			proposalId: "batch-1",
			changeCount: 27,
		});
		expect(mocks.analyzeContextAndPropose).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "p1",
				userId: "u1",
				organizationId: "org-1",
				fetchedContext: GATHERED.fetchedContext,
				intakeMode: "recommend",
				allowUpdates: false,
				allowRouting: false,
				deferDecisionPrecheck: true,
			}),
		);
		expect(mocks.persistRoadmapRecommendations).toHaveBeenCalledWith(
			expect.objectContaining({
				entryPoint: "MATURE_ROADMAP",
				proposal,
				stats: GATHERED.stats,
				workflowId: expect.stringMatching(/-wf$/),
				runId: expect.any(String),
			}),
		);
	});

	it("fails the workflow when the analyzer fails", async () => {
		const mocks = {
			gatherRoadmapRecommendationContext: vi
				.fn()
				.mockResolvedValue(GATHERED),
			analyzeContextAndPropose: vi
				.fn()
				.mockRejectedValue(
					ApplicationFailure.nonRetryable("model down", "AI_FAILURE"),
				),
			persistRoadmapRecommendations: vi.fn(),
		};
		await expect(runWorkflow(mocks)).rejects.toBeInstanceOf(
			WorkflowFailedError,
		);
		expect(mocks.persistRoadmapRecommendations).not.toHaveBeenCalled();
	});
});
