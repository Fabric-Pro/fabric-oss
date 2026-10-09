/**
 * Replay safety of the coordinated Proposal branch (Fizzy #2801).
 *
 * The branch adds commands to the child workflow's stream — the plan, the
 * visuals, the analysis run record and the analysis child — all behind one
 * `patched("proposal-artifact-v1")` read at the branch start. This proves the
 * marker is what keeps an in-flight history safe, not the rollout gate:
 *
 * - a history recorded by the code as it was before the branch, with the
 *   gate's answer forced on, replays against today's code;
 * - the same history fails to replay against a copy whose marker is replaced
 *   by `true` — the mutant must fail, or the check proves nothing;
 * - a gate-on history and a gate-off history recorded by today's code replay
 *   against it, and the gate-off history schedules exactly the activities the
 *   pre-branch code schedules, plus the plan that returned null.
 *
 * No production history of this workflow is available locally, so the "before"
 * history is recorded here by the workflow with its marker replaced by
 * `false`: the code that never enters the branch. Every activity is a stub.
 *
 * Offline note: `TestWorkflowEnvironment.createTimeSkipping()` downloads a
 * Temporal test-server binary on first use.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { WorkflowHandle } from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import {
	bundleWorkflowCode,
	Worker,
	type WorkflowBundleWithSourceMap,
} from "@temporalio/worker";
import { DeterminismViolationError } from "@temporalio/workflow";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type PlanProposalArtifactResult,
	type ProposalArtifactPlan,
	proposalAnalysisWorkflowId,
} from "../../lib/proposal-artifact/types";
import { PROJECT_DOCUMENT_GENERATION_ACTIVITY_TASK_QUEUE } from "../../task-queues";

type History = Awaited<ReturnType<WorkflowHandle["fetchHistory"]>>;

const WORKFLOWS_DIR = resolve(__dirname, "..");
const CHILD_PATH = join(WORKFLOWS_DIR, "document-generation-child.ts");
const PATCH_ID = "proposal-artifact-v1";
const PATCH_CALL = `patched("${PATCH_ID}")`;

const LIVE_RUN_ID = "live-run-1";
const PLAN: ProposalArtifactPlan = {
	liveRunId: LIVE_RUN_ID,
	mainPrompt: {
		promptId: "prompt-main",
		versionNumber: 3,
		promptVersionId: "prompt-main-v3",
	},
	analysisPrompt: {
		promptId: "prompt-analysis",
		versionNumber: 1,
		promptVersionId: "prompt-analysis-v1",
	},
	analysisSkipReason: null,
	triggeredByGuest: false,
};

let env: TestWorkflowEnvironment;
/** Today's workflow. */
let currentBundle: WorkflowBundleWithSourceMap;
/** The workflow as it was before the branch: the marker never set. */
let legacyBundle: WorkflowBundleWithSourceMap;
/** The mutant: the branch taken without consulting the marker. */
let bypassBundle: WorkflowBundleWithSourceMap;
let runSeq = 0;

/**
 * Bundle the child workflow with its marker read replaced by `marker`. The
 * copy sits in a temporary directory under __tests__ (which repository scans
 * skip), its relative imports re-pointed at the real modules, and it also
 * exports the analysis workflow so the started child can run.
 */
async function bundleChild(
	marker: string | null,
): Promise<WorkflowBundleWithSourceMap> {
	const original = readFileSync(CHILD_PATH, "utf8");
	const source =
		marker === null ? original : original.replace(PATCH_CALL, marker);
	const dir = mkdtempSync(join(__dirname, ".proposal-artifact-replay-"));
	const fromDir = (specifier: string) => {
		const target = relative(dir, resolve(WORKFLOWS_DIR, specifier))
			.split("\\")
			.join("/");
		return target.startsWith(".") ? target : `./${target}`;
	};
	try {
		const rewritten = source.replace(
			/from "(\.{1,2}\/[^"]+)"/g,
			(_match, specifier: string) => `from "${fromDir(specifier)}"`,
		);
		writeFileSync(
			join(dir, "child.ts"),
			`${rewritten}\nexport { proposalAnalysisWorkflow } from "${fromDir("./proposal-analysis")}";\n`,
		);
		return await bundleWorkflowCode({
			workflowsPath: join(dir, "child.ts"),
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function stubActivities(plan: PlanProposalArtifactResult) {
	return {
		planProposalArtifact: async () => plan,
		retrieveProjectContexts: async () => [
			"Source material for the proposal.",
		],
		retrieveAndFormatEpisodicMemory: async () => ({
			formattedContext: "",
			episodeCount: 0,
		}),
		checkProjectHasTeamsIntegration: async () => false,
		checkProjectHasSlackIntegration: async () => false,
		fetchRecentTeamsMessages: async () => ({ messageCount: 0 }),
		fetchRecentSlackMessages: async () => ({ messageCount: 0 }),
		generateDocumentWithAgent: async () => ({
			content: "# Proposal\n\n## Scope\n\nThe generated body.",
			resolvedPromptVersionId: "prompt-main-v3",
		}),
		generateProposalVisuals: async (input: { content: string }) => ({
			content: input.content,
			insertedCount: 0,
		}),
		saveProjectDocument: async () => undefined,
		runDocumentDecisionPrecheckActivity: async () => undefined,
		createDocumentVersion: async () => ({ version: 2, versionId: "v-2" }),
		embedProjectDocumentActivity: async () => ({ success: true }),
		updateProjectDocumentStatus: async () => undefined,
		createProposalAnalysisRun: async (input: {
			documentId: string;
			liveRunId: string;
		}) => ({
			kind: "ready" as const,
			runId: `analysis-${input.documentId}`,
			runKey: proposalAnalysisWorkflowId(
				input.documentId,
				input.liveRunId,
			),
		}),
		clearProposalLiveContent: async () => ({ outcome: "written" as const }),
		failProposalAnalysisRun: async () => ({ outcome: "written" as const }),
		runProposalAnalysis: async () => ({
			outcome: "completed" as const,
			findingCount: 0,
		}),
	};
}

/** Run the child once on `bundle` and return its history, failed or not. */
async function record(
	bundle: WorkflowBundleWithSourceMap,
	plan: PlanProposalArtifactResult,
): Promise<{ workflowId: string; documentId: string; history: History }> {
	const seq = ++runSeq;
	const workflowId = `proposal-artifact-replay-${seq}`;
	const documentId = `doc-${seq}`;
	const worker = await Worker.create({
		connection: env.nativeConnection,
		// The child's activities name this queue, so one worker serves both.
		taskQueue: PROJECT_DOCUMENT_GENERATION_ACTIVITY_TASK_QUEUE,
		workflowBundle: bundle,
		activities: stubActivities(plan),
	});
	const handle = await env.client.workflow.start(
		"documentGenerationChildWorkflow",
		{
			taskQueue: PROJECT_DOCUMENT_GENERATION_ACTIVITY_TASK_QUEUE,
			workflowId,
			args: [
				{
					projectId: "project-1",
					documentId,
					documentType: "PROPOSAL",
					userId: "user-1",
					organizationId: "org-1",
					aiToken: "token-1",
				},
			],
		},
	);
	await worker.runUntil(async () => {
		// A run that fails still leaves the history this test replays.
		await handle.result().catch(() => undefined);
		// An abandoned analysis child runs on the same worker; let it finish
		// so it does not outlive this one.
		for (const child of startedChildren(await handle.fetchHistory())) {
			if (child.workflowId) {
				await env.client.workflow.getHandle(child.workflowId).result();
			}
		}
	});
	return { workflowId, documentId, history: await handle.fetchHistory() };
}

function startedChildren(history: History) {
	return (history.events ?? []).flatMap((event) => {
		const attributes =
			event.startChildWorkflowExecutionInitiatedEventAttributes;
		return attributes ? [attributes] : [];
	});
}

function scheduledActivities(history: History): string[] {
	return (history.events ?? []).flatMap((event) => {
		const name =
			event.activityTaskScheduledEventAttributes?.activityType?.name;
		return name ? [name] : [];
	});
}

/**
 * Each scheduled activity's serialized input, with the run's document id
 * replaced so two runs compare byte for byte.
 */
function scheduledInputs(history: History, documentId: string): string[] {
	return (history.events ?? []).flatMap((event) => {
		const attributes = event.activityTaskScheduledEventAttributes;
		if (!attributes) {
			return [];
		}
		const input = (attributes.input?.payloads ?? [])
			.map((payload) => Buffer.from(payload.data ?? []).toString("utf8"))
			.join("\n");
		return [
			`${attributes.activityType?.name}: ${input.split(documentId).join("<document>")}`,
		];
	});
}

/** The patch ids the history's markers record. */
function patchMarkers(history: History): string[] {
	return (history.events ?? []).flatMap((event) => {
		const attributes = event.markerRecordedEventAttributes;
		if (!attributes) {
			return [];
		}
		return Object.values(attributes.details ?? {}).flatMap((payloads) =>
			(payloads.payloads ?? []).map((payload) =>
				Buffer.from(payload.data ?? []).toString("utf8"),
			),
		);
	});
}

beforeAll(async () => {
	env = await TestWorkflowEnvironment.createTimeSkipping();
	const source = readFileSync(CHILD_PATH, "utf8");
	// The mutants below replace exactly this call; if it moves or doubles,
	// they would silently test nothing.
	if (source.split(PATCH_CALL).length !== 2) {
		throw new Error("the proposal artifact marker moved; update this test");
	}
	currentBundle = await bundleChild(null);
	legacyBundle = await bundleChild("false");
	bypassBundle = await bundleChild("true");
}, 300_000);

afterAll(async () => {
	await env?.teardown();
});

describe("coordinated Proposal branch — replay", () => {
	it("replays a history recorded before the branch, and the marker is what makes it safe", async () => {
		// The gate's answer is forced on: the code before the branch never
		// asks, so the history holds no plan.
		const legacy = await record(legacyBundle, PLAN);
		expect(scheduledActivities(legacy.history)).not.toContain(
			"planProposalArtifact",
		);
		expect(patchMarkers(legacy.history).join(" ")).not.toContain(PATCH_ID);

		await expect(
			Worker.runReplayHistory(
				{ workflowBundle: currentBundle },
				legacy.history,
				legacy.workflowId,
			),
		).resolves.toBeUndefined();

		// The mutant takes the branch without the marker and schedules the
		// plan where the history scheduled retrieval.
		await expect(
			Worker.runReplayHistory(
				{ workflowBundle: bypassBundle },
				legacy.history,
				legacy.workflowId,
			),
		).rejects.toThrow(DeterminismViolationError);
	}, 120_000);

	it("replays a gate-on history, which plans, adds visuals and starts the analysis", async () => {
		const gateOn = await record(currentBundle, PLAN);
		const activities = scheduledActivities(gateOn.history);
		expect(activities[0]).toBe("planProposalArtifact");
		expect(activities).toEqual(
			expect.arrayContaining([
				"generateProposalVisuals",
				"createProposalAnalysisRun",
			]),
		);
		expect(patchMarkers(gateOn.history).join(" ")).toContain(PATCH_ID);
		const started = startedChildren(gateOn.history);
		expect(started).toHaveLength(1);
		expect(started[0].workflowType?.name).toBe("proposalAnalysisWorkflow");
		expect(started[0].workflowId).toBe(
			proposalAnalysisWorkflowId(gateOn.documentId, LIVE_RUN_ID),
		);

		await expect(
			Worker.runReplayHistory(
				{ workflowBundle: currentBundle },
				gateOn.history,
				gateOn.workflowId,
			),
		).resolves.toBeUndefined();
	}, 120_000);

	it("replays a history whose plan was superseded, which ends after the plan with nothing written", async () => {
		const superseded = await record(currentBundle, { superseded: true });

		expect(scheduledActivities(superseded.history)).toEqual([
			"planProposalArtifact",
		]);
		const failed = (superseded.history.events ?? []).find(
			(event) => event.workflowExecutionFailedEventAttributes,
		)?.workflowExecutionFailedEventAttributes;
		expect(failed?.failure?.applicationFailureInfo?.type).toBe(
			"DOCUMENT_GENERATION_SUPERSEDED",
		);

		await expect(
			Worker.runReplayHistory(
				{ workflowBundle: currentBundle },
				superseded.history,
				superseded.workflowId,
			),
		).resolves.toBeUndefined();
	}, 120_000);

	it("a gate-off history differs from the pre-branch one only by the marker and the plan", async () => {
		const legacy = await record(legacyBundle, null);
		const gateOff = await record(currentBundle, null);

		expect(scheduledActivities(gateOff.history)).toEqual([
			"planProposalArtifact",
			...scheduledActivities(legacy.history),
		]);
		// Not only the same activities: the same inputs, byte for byte. The
		// run-token fields the branch adds are unset here and never reach
		// the payload.
		const [, ...gateOffInputs] = scheduledInputs(
			gateOff.history,
			gateOff.documentId,
		);
		expect(gateOffInputs).toEqual(
			scheduledInputs(legacy.history, legacy.documentId),
		);
		expect(patchMarkers(gateOff.history).join(" ")).toContain(PATCH_ID);

		await expect(
			Worker.runReplayHistory(
				{ workflowBundle: currentBundle },
				gateOff.history,
				gateOff.workflowId,
			),
		).resolves.toBeUndefined();
	}, 120_000);
});
