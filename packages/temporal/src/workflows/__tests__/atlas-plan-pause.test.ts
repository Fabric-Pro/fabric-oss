/**
 * An Atlas analysis pauses for a ChatGPT plan reset and resumes later (Fizzy
 * #2770), in the real workflow: a spent plan in an AI step saves the
 * structure result and ends without failing; the resume claims its run row
 * and continues from there without cloning again; a resume that lost the
 * claim does nothing; the pause cap fails the analysis with its message; and
 * a run started before the run id was passed never pauses.
 *
 * The workflow runs in a time-skipping environment with stubbed activities;
 * the row writes and the delayed start are pinned in the activity's own test.
 */

import { resolve } from "node:path";
import { ApplicationFailure } from "@temporalio/common";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import {
	bundleWorkflowCode,
	Worker,
	type WorkflowBundleWithSourceMap,
} from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const WORKFLOWS = resolve(__dirname, "..");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

let env: TestWorkflowEnvironment;
let atlas: WorkflowBundleWithSourceMap;
let taskQueueSeq = 0;

beforeAll(async () => {
	env = await TestWorkflowEnvironment.createTimeSkipping();
	atlas = await bundleWorkflowCode({
		workflowsPath: resolve(WORKFLOWS, "atlas.ts"),
	});
}, 300_000);

afterAll(async () => {
	await env?.teardown();
});

const spent = () =>
	ApplicationFailure.create({
		message:
			"Every ChatGPT plan this work may use has no usage left in this window.",
		type: "SubscriptionPlanExhaustedError",
		nonRetryable: true,
	});

const atlasInput = {
	analysisId: "analysis-1",
	projectId: "project-1",
	repositoryIntegrationId: "integration-1",
	userId: "user-1",
	organizationId: "org-1",
	incremental: false,
	fresh: false,
	analysisRunId: "run-1",
	jobType: "atlas-analysis",
};

const structureResult = {
	commitSha: "abc123",
	commitAt: null,
	manifest: { "src/a.ts": "hash-a" },
	changedModuleKeys: ["src"],
	nodeCount: 7,
	edgeCount: 5,
	filesAnalyzed: 3,
};

const telemetry = (tokens: number) => ({
	promptTokens: tokens,
	completionTokens: tokens,
	totalTokens: 2 * tokens,
	model: "model",
	reasoning: null,
});

type PauseResult =
	| { paused: true; resumesAt: string; pauseCount: number }
	| { paused: false; message: string };

interface AtlasLog {
	marked: Array<Record<string, unknown>>;
	structureRuns: number;
	describeRuns: number;
	businessRuns: number;
	finalized: Array<Record<string, unknown>>;
}

function atlasLog(): AtlasLog {
	return {
		marked: [],
		structureRuns: 0,
		describeRuns: 0,
		businessRuns: 0,
		finalized: [],
	};
}

async function run(options: {
	input: Record<string, unknown>;
	log: AtlasLog;
	/** The AI step whose plan is spent, every time it runs. */
	spentStep?: "describe" | "business";
	claim?: { claimed: boolean; progress?: unknown };
	pauseResult?: PauseResult;
}) {
	const taskQueue = `atlas-plan-pause-${++taskQueueSeq}`;
	const pauses: Array<Record<string, unknown>> = [];
	const claims: Array<Record<string, unknown>> = [];
	const { log } = options;
	const worker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowBundle: atlas,
		activities: {
			atlasMarkStatusActivity: async (input: Record<string, unknown>) => {
				log.marked.push(input);
			},
			atlasRunStructureActivity: async () => {
				log.structureRuns++;
				return structureResult;
			},
			atlasDescribeModulesActivity: async () => {
				log.describeRuns++;
				if (options.spentStep === "describe") {
					throw spent();
				}
				return { described: 2, requested: 2, ...telemetry(10) };
			},
			atlasDeriveBusinessActivity: async () => {
				log.businessRuns++;
				if (options.spentStep === "business") {
					throw spent();
				}
				return { capabilities: 3, ...telemetry(20) };
			},
			atlasFinalizeActivity: async (input: Record<string, unknown>) => {
				log.finalized.push(input);
			},
			estimatePlanPoolResetActivity: async () => ({
				waitMs: 3 * HOUR,
				jitterMs: 0,
				resetKnown: true,
			}),
			pauseBulkRunActivity: async (input: Record<string, unknown>) => {
				pauses.push(input);
				return (
					options.pauseResult ?? {
						paused: true,
						resumesAt: "2026-10-12T18:00:00.000Z",
						pauseCount: ((input.pauseCount as number) ?? 0) + 1,
					}
				);
			},
			claimBulkRunResumeActivity: async (
				input: Record<string, unknown>,
			) => {
				claims.push(input);
				return options.claim ?? { claimed: true };
			},
		},
	});
	const workflowId = `${taskQueue}-wf`;
	const handle = await env.client.workflow.start("atlasWorkflow", {
		taskQueue,
		workflowId,
		args: [options.input],
		// What `analyze.ts` starts it with.
		workflowExecutionTimeout: 5 * HOUR,
	});
	const output = await worker.runUntil(handle.result());
	return { output, pauses, claims, workflowId };
}

describe("atlasWorkflow pause and resume", () => {
	it("pauses on a spent plan: saves the structure result, marks the analysis waiting, never fails", async () => {
		const log = atlasLog();
		const { output, pauses } = await run({
			input: atlasInput,
			log,
			spentStep: "describe",
		});

		expect(output).toMatchObject({
			status: "WAITING_FOR_PLAN",
			resumesAt: "2026-10-12T18:00:00.000Z",
		});
		expect(log.finalized).toEqual([]);
		expect(log.businessRuns).toBe(0);
		expect(pauses).toHaveLength(1);
		expect(pauses[0]).toMatchObject({
			kind: "ATLAS_ANALYSIS",
			runId: "run-1",
			pauseCount: 0,
			workflowIdBase: expect.stringMatching(/-wf$/),
			workflowType: "atlasWorkflow",
			executionTimeoutMs: 5 * HOUR,
			waitMs: 3 * HOUR,
			resetKnown: true,
			// The job type rides along, so the resume runs as the same job.
			input: {
				analysisId: "analysis-1",
				analysisRunId: "run-1",
				jobType: "atlas-analysis",
			},
			progress: { structure: structureResult },
		});
		expect(
			(pauses[0]?.progress as Record<string, unknown>).describe,
		).toBeUndefined();
		expect(log.marked.map((m) => m.status)).toEqual([
			"ANALYZING",
			"WAITING_FOR_PLAN",
		]);
	}, 120_000);

	it("keeps the describe result when the business step pauses", async () => {
		const log = atlasLog();
		const { pauses } = await run({
			input: atlasInput,
			log,
			spentStep: "business",
		});

		expect(pauses[0]).toMatchObject({
			progress: {
				structure: structureResult,
				describe: { described: 2, totalTokens: 20 },
			},
		});
	}, 120_000);

	it("resumes from the saved progress: claims the run, never clones again", async () => {
		const log = atlasLog();
		const resumeOf = {
			runId: "run-1",
			pauseCount: 1,
			workflowIdBase: "atlas-analysis-1",
		};
		const { output, claims, workflowId } = await run({
			input: { ...atlasInput, resumeOf },
			log,
			claim: { claimed: true, progress: { structure: structureResult } },
		});

		expect(output).toMatchObject({ status: "READY", nodeCount: 7 });
		expect(claims).toEqual([
			{ kind: "ATLAS_ANALYSIS", resumeOf, viaApiOverride: false },
		]);
		expect(log.structureRuns).toBe(0);
		expect(log.describeRuns).toBe(1);
		expect(log.businessRuns).toBe(1);
		// The analysis reads ANALYZING again under the resume's own workflow.
		expect(log.marked).toEqual([
			expect.objectContaining({
				status: "ANALYZING",
				resumedWorkflowId: workflowId,
			}),
		]);
		expect(log.finalized).toEqual([
			expect.objectContaining({
				status: "READY",
				commitSha: "abc123",
				manifest: structureResult.manifest,
			}),
		]);
	}, 120_000);

	it("skips a describe step the paused run had finished, and sums its telemetry", async () => {
		const log = atlasLog();
		await run({
			input: {
				...atlasInput,
				resumeOf: {
					runId: "run-1",
					pauseCount: 1,
					workflowIdBase: "atlas-analysis-1",
				},
				allowApiFallback: true,
			},
			log,
			claim: {
				claimed: true,
				progress: {
					structure: structureResult,
					describe: { described: 2, requested: 2, ...telemetry(10) },
				},
			},
		});

		expect(log.structureRuns).toBe(0);
		expect(log.describeRuns).toBe(0);
		expect(log.businessRuns).toBe(1);
		expect(log.finalized[0]).toMatchObject({
			status: "READY",
			modulesDescribed: 2,
			totalTokens: 60,
		});
	}, 120_000);

	it("ends quietly when the resume lost the claim", async () => {
		const log = atlasLog();
		const { output } = await run({
			input: {
				...atlasInput,
				resumeOf: {
					runId: "run-1",
					pauseCount: 1,
					workflowIdBase: "atlas-analysis-1",
				},
			},
			log,
			claim: { claimed: false },
		});

		expect(output).toMatchObject({ status: "FAILED" });
		expect(log.marked).toEqual([]);
		expect(log.structureRuns).toBe(0);
		expect(log.finalized).toEqual([]);
	}, 120_000);

	it("fails the analysis with the cap message when the pause cannot be taken", async () => {
		const log = atlasLog();
		const message = "Every ChatGPT plan this work may use stayed spent.";
		const { output } = await run({
			input: atlasInput,
			log,
			spentStep: "describe",
			pauseResult: { paused: false, message },
		});

		expect(output).toMatchObject({ status: "FAILED", error: message });
		expect(log.finalized).toEqual([
			expect.objectContaining({ status: "FAILED", error: message }),
		]);
		expect(log.marked.map((m) => m.status)).toEqual(["ANALYZING"]);
	}, 120_000);

	it("never pauses a run started without its run id", async () => {
		const log = atlasLog();
		const { analysisRunId: _omit, ...legacyInput } = atlasInput;
		const { output, pauses } = await run({
			input: legacyInput,
			log,
			spentStep: "describe",
		});

		expect(pauses).toEqual([]);
		expect(output).toMatchObject({ status: "FAILED" });
	}, 120_000);
});
