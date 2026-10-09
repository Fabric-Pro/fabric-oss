/**
 * The coordinated Proposal branch of the document generation child workflow
 * (Fizzy #2801).
 *
 * For a Proposal in an organization, the child asks the plan activity first.
 * A null plan (the rollout gate is off) leaves today's path exactly; a plan
 * pins the client-only Main prompt for generation, adds visuals before the
 * save, guards the save, version and FAILED writes with the run token, and
 * starts the Internal Analysis once Main is saved, never failing the child
 * for it.
 *
 * Harness convention (see `supplied-context-wiring.test.ts`): mock the
 * activity surface and drive the workflow body as a plain async function.
 * Replay safety is pinned separately, against real bundles, in
 * `document-generation-proposal-artifact-replay.test.ts`.
 */

import {
	ActivityFailure,
	ApplicationFailure,
	ParentClosePolicy,
} from "@temporalio/workflow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type ProposalArtifactPlan,
	proposalAnalysisWorkflowId,
} from "../../lib/proposal-artifact/types";

const h = vi.hoisted(() => {
	const calls: string[] = [];
	const names = [
		"planProposalArtifact",
		"retrieveProjectContexts",
		"retrieveAndFormatEpisodicMemory",
		"checkProjectHasTeamsIntegration",
		"fetchRecentTeamsMessages",
		"checkProjectHasSlackIntegration",
		"fetchRecentSlackMessages",
		"generateDocumentWithAgent",
		"generateProposalVisuals",
		"saveProjectDocument",
		"runDocumentDecisionPrecheckActivity",
		"createDocumentVersion",
		"embedProjectDocumentActivity",
		"createProposalAnalysisRun",
		"clearProposalLiveContent",
		"failProposalAnalysisRun",
		"updateProjectDocumentStatus",
	] as const;
	const activities = Object.fromEntries(
		names.map((name) => [name, vi.fn()]),
	) as Record<(typeof names)[number], ReturnType<typeof vi.fn>>;
	return {
		calls,
		activities,
		patched: vi.fn((_id: string) => true),
		startChild: vi.fn(),
		/** Workflow start, as an offset from the workflow clock. */
		childAgeMs: 0,
	};
});

vi.mock("@temporalio/workflow", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@temporalio/workflow")>();
	return {
		...actual,
		log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		patched: h.patched,
		proxyActivities: vi.fn(() => h.activities),
		startChild: h.startChild,
		workflowInfo: () => ({
			startTime: new Date(Date.now() - h.childAgeMs),
			// The child execution's run id is the run token.
			runId: "live-run-1",
		}),
	};
});

import { documentGenerationChildWorkflow } from "../document-generation-child";

const INPUT = {
	projectId: "project-1",
	documentId: "doc-1",
	documentType: "PROPOSAL",
	userId: "user-1",
	organizationId: "org-1",
	aiToken: "token-1",
	promptId: "prompt-from-editor",
	planEligible: true,
};

const GENERATED = "# Proposal\n\n## Scope\n\nWhat the client gets.";
const WITH_VISUALS = `${GENERATED}\n\n\`\`\`mermaid\nflowchart TD\n\`\`\``;
const CONTEXTS = ["Source one.", "Source two."];

function planFor(liveRunId: string): ProposalArtifactPlan {
	return {
		liveRunId,
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
}

const PLAN = planFor("live-run-1");

const STALE_MESSAGE =
	"This document changed while it was being regenerated, so the regenerated text was discarded and the newer version was kept. Regenerate again to start from the current version.";

function wrapped(failure: ApplicationFailure, activityType: string) {
	return new ActivityFailure(
		"Activity task failed",
		activityType,
		"1",
		"NON_RETRYABLE_FAILURE",
		"worker@example.com",
		failure,
	);
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => {
			throw new Error("expected a failure");
		},
		(error: unknown) => error,
	);
}

/** Activity calls in order, the progress writes left out. */
function callOrder(): string[] {
	return h.calls.filter((name) => name !== "updateProjectDocumentStatus");
}

function argsOf(name: keyof typeof h.activities, index = 0): unknown[] {
	const call = h.activities[name].mock.calls[index];
	if (!call) {
		throw new Error(`${name} was not called`);
	}
	return call;
}

beforeEach(() => {
	vi.clearAllMocks();
	h.calls.length = 0;
	h.childAgeMs = 0;
	h.patched.mockImplementation(() => true);
	for (const [name, fn] of Object.entries(h.activities)) {
		fn.mockReset();
		fn.mockImplementation(async () => {
			h.calls.push(name);
			return undefined;
		});
	}
	const returns = (
		name: keyof typeof h.activities,
		value: (...args: never[]) => unknown,
	) =>
		h.activities[name].mockImplementation(async (...args: never[]) => {
			h.calls.push(name);
			return value(...args);
		});
	returns("planProposalArtifact", () => PLAN);
	returns("retrieveProjectContexts", () => [...CONTEXTS]);
	returns("retrieveAndFormatEpisodicMemory", () => ({
		formattedContext: "",
		episodeCount: 0,
	}));
	returns("checkProjectHasTeamsIntegration", () => false);
	returns("checkProjectHasSlackIntegration", () => false);
	returns("generateDocumentWithAgent", () => ({
		content: GENERATED,
		resolvedPromptVersionId: "prompt-main-v4",
	}));
	returns("generateProposalVisuals", () => ({
		content: WITH_VISUALS,
		insertedCount: 1,
	}));
	returns("createDocumentVersion", () => ({ version: 2, versionId: "v-2" }));
	returns("embedProjectDocumentActivity", () => ({ success: true }));
	returns(
		"createProposalAnalysisRun",
		(input: { documentId: string; liveRunId: string }) => ({
			kind: "ready",
			runId: `analysis-${input.liveRunId}`,
			runKey: proposalAnalysisWorkflowId(
				input.documentId,
				input.liveRunId,
			),
		}),
	);
	returns("clearProposalLiveContent", () => ({ outcome: "written" }));
	returns("failProposalAnalysisRun", () => ({ outcome: "written" }));
	h.startChild.mockImplementation(async () => {
		h.calls.push("startChild");
		return {};
	});
});

describe("gate off — today's path", () => {
	beforeEach(() => {
		h.activities.planProposalArtifact.mockImplementation(async () => {
			h.calls.push("planProposalArtifact");
			return null;
		});
	});

	it("asks the plan once, then runs exactly today's sequence", async () => {
		const result = await documentGenerationChildWorkflow(INPUT);
		expect(result).not.toHaveProperty("liveRunId");

		expect(result.success).toBe(true);
		expect(h.patched).toHaveBeenCalledWith("proposal-artifact-v1");
		expect(argsOf("planProposalArtifact")).toEqual([
			{
				projectId: "project-1",
				documentId: "doc-1",
				documentType: "PROPOSAL",
				userId: "user-1",
				organizationId: "org-1",
				liveRunId: "live-run-1",
			},
		]);
		expect(callOrder()).toEqual([
			"planProposalArtifact",
			"retrieveProjectContexts",
			"retrieveAndFormatEpisodicMemory",
			"checkProjectHasTeamsIntegration",
			"checkProjectHasSlackIntegration",
			"generateDocumentWithAgent",
			"saveProjectDocument",
			"runDocumentDecisionPrecheckActivity",
			"createDocumentVersion",
			"embedProjectDocumentActivity",
		]);
		expect(h.startChild).not.toHaveBeenCalled();
	});

	it("generates with the request's prompt and saves with today's arguments", async () => {
		await documentGenerationChildWorkflow(INPUT);

		const [generation] = argsOf("generateDocumentWithAgent") as [
			Record<string, unknown>,
		];
		expect(generation.promptId).toBe("prompt-from-editor");
		expect(generation.artifact).toBeUndefined();
		expect(argsOf("saveProjectDocument")).toEqual([
			"doc-1",
			GENERATED,
			"user-1",
		]);
		expect(argsOf("createDocumentVersion")).toEqual([
			"doc-1",
			GENERATED,
			"user-1",
			"prompt-main-v4",
		]);
	});

	it("writes today's progress, with no run guard", async () => {
		await documentGenerationChildWorkflow(INPUT);

		const progressWrites =
			h.activities.updateProjectDocumentStatus.mock.calls
				.map(([input]) => input as Record<string, unknown>)
				.filter((input) => input.status === "GENERATING");
		expect(progressWrites).toHaveLength(5);
		for (const write of progressWrites) {
			expect(write.liveRunId).toBeUndefined();
		}
	});

	it("writes today's FAILED status, with no run guard, when generation fails", async () => {
		h.activities.generateDocumentWithAgent.mockRejectedValue(
			new Error("agent unreachable"),
		);

		const failure = await failureOf(documentGenerationChildWorkflow(INPUT));

		expect(h.activities.clearProposalLiveContent).not.toHaveBeenCalled();
		expect(h.activities.updateProjectDocumentStatus).toHaveBeenCalledWith({
			documentId: "doc-1",
			status: "FAILED",
			progress: 0,
			error: "agent unreachable",
		});
		// No run token for a parent to guard with: today's failure.
		expect((failure as ApplicationFailure).details ?? []).toEqual([]);
	});
});

describe("documents the branch never plans", () => {
	it("asks no plan for a Business Case, gate or not", async () => {
		const result = await documentGenerationChildWorkflow({
			...INPUT,
			documentType: "BUSINESS_CASE",
		});

		expect(result.success).toBe(true);
		expect(h.activities.planProposalArtifact).not.toHaveBeenCalled();
		expect(h.patched).not.toHaveBeenCalledWith("proposal-artifact-v1");
		expect(h.activities.generateProposalVisuals).not.toHaveBeenCalled();
		expect(h.startChild).not.toHaveBeenCalled();
	});

	it("asks no plan without an organization", async () => {
		await documentGenerationChildWorkflow({
			...INPUT,
			organizationId: undefined,
		});

		expect(h.activities.planProposalArtifact).not.toHaveBeenCalled();
		expect(h.patched).not.toHaveBeenCalledWith("proposal-artifact-v1");
	});

	it("asks no plan when replaying a history recorded before the branch", async () => {
		h.patched.mockImplementation(
			(id: string) => id !== "proposal-artifact-v1",
		);

		const result = await documentGenerationChildWorkflow(INPUT);

		expect(result.success).toBe(true);
		expect(h.activities.planProposalArtifact).not.toHaveBeenCalled();
		expect(h.activities.generateProposalVisuals).not.toHaveBeenCalled();
		expect(argsOf("saveProjectDocument")).toHaveLength(3);
	});
});

describe("gate on — the coordinated run", () => {
	it("plans, retrieves, generates, adds visuals, saves, versions, embeds, then starts the analysis", async () => {
		const result = await documentGenerationChildWorkflow(INPUT);

		expect(result.success).toBe(true);
		expect(result.documentContent).toBe(WITH_VISUALS);
		// The token goes back to a parent, for its own status writes.
		expect(result.liveRunId).toBe("live-run-1");
		expect(callOrder()).toEqual([
			"planProposalArtifact",
			"retrieveProjectContexts",
			"retrieveAndFormatEpisodicMemory",
			"checkProjectHasTeamsIntegration",
			"checkProjectHasSlackIntegration",
			"generateDocumentWithAgent",
			"generateProposalVisuals",
			"saveProjectDocument",
			"runDocumentDecisionPrecheckActivity",
			"createDocumentVersion",
			"embedProjectDocumentActivity",
			"createProposalAnalysisRun",
			"startChild",
		]);
	});

	it("generates from the pinned Main prompt under the run token", async () => {
		await documentGenerationChildWorkflow(INPUT);

		const [generation] = argsOf("generateDocumentWithAgent") as [
			Record<string, unknown>,
		];
		expect(generation.artifact).toEqual({
			liveRunId: "live-run-1",
			promptId: "prompt-main",
			promptVersionNumber: 4,
		});
		expect(generation.contexts).toEqual(CONTEXTS);
	});

	it("hands the visuals the generated Main and saves what they return, under the run token", async () => {
		await documentGenerationChildWorkflow(INPUT);

		expect(argsOf("generateProposalVisuals")).toEqual([
			{
				projectId: "project-1",
				documentId: "doc-1",
				organizationId: "org-1",
				userId: "user-1",
				liveRunId: "live-run-1",
				content: GENERATED,
				planEligible: true,
			},
		]);
		expect(argsOf("saveProjectDocument")).toEqual([
			"doc-1",
			WITH_VISUALS,
			"user-1",
			{
				baselineVersion: 3,
				liveRunId: "live-run-1",
				baselineContentHash: "planned-main-identity",
			},
		]);
		expect(argsOf("createDocumentVersion")).toEqual([
			"doc-1",
			WITH_VISUALS,
			"user-1",
			"prompt-main-v4",
			{ baselineVersion: 3, liveRunId: "live-run-1" },
		]);
	});

	it("guards the save with the version it planned at, even when a visual slot reports a later one", async () => {
		h.activities.generateDocumentWithAgent.mockImplementation(async () => ({
			content: GENERATED,
			resolvedPromptVersionId: "prompt-main-v4",
			baselineVersion: 7,
		}));

		await documentGenerationChildWorkflow(INPUT);

		expect(argsOf("saveProjectDocument")[3]).toEqual({
			baselineVersion: 3,
			liveRunId: "live-run-1",
			baselineContentHash: "planned-main-identity",
		});
		expect(argsOf("createDocumentVersion")[4]).toEqual({
			baselineVersion: 3,
			liveRunId: "live-run-1",
		});
	});

	it("keeps the generation's slot baseline for a plan recorded without a version", async () => {
		const {
			baselineVersion: _unrecordedVersion,
			baselineContentHash: _unrecordedBody,
			...recordedBefore
		} = PLAN;
		h.activities.planProposalArtifact.mockImplementation(
			async () => recordedBefore,
		);
		h.activities.generateDocumentWithAgent.mockImplementation(async () => ({
			content: GENERATED,
			resolvedPromptVersionId: "prompt-main-v4",
			baselineVersion: 7,
		}));

		await documentGenerationChildWorkflow(INPUT);

		expect(argsOf("saveProjectDocument")[3]).toEqual({
			baselineVersion: 7,
			liveRunId: "live-run-1",
		});
		expect(argsOf("createDocumentVersion")[4]).toEqual({
			baselineVersion: 7,
			liveRunId: "live-run-1",
		});
	});

	it("a plan recorded without a version and no slot saves under the run token alone", async () => {
		const {
			baselineVersion: _unrecordedVersion,
			baselineContentHash: _unrecordedBody,
			...recordedBefore
		} = PLAN;
		h.activities.planProposalArtifact.mockImplementation(
			async () => recordedBefore,
		);

		await documentGenerationChildWorkflow(INPUT);

		expect(argsOf("saveProjectDocument")[3]).toEqual({
			liveRunId: "live-run-1",
		});
	});

	it("records the analysis run from the plan and the generation's contexts, and starts it abandoned with ids only", async () => {
		await documentGenerationChildWorkflow(INPUT);

		expect(argsOf("createProposalAnalysisRun")).toEqual([
			{
				organizationId: "org-1",
				projectId: "project-1",
				documentId: "doc-1",
				userId: "user-1",
				liveRunId: "live-run-1",
				analysisPrompt: PLAN.analysisPrompt,
				analysisSkipReason: null,
				triggeredByGuest: false,
				contexts: CONTEXTS,
			},
		]);
		expect(h.startChild).toHaveBeenCalledTimes(1);
		expect(h.startChild).toHaveBeenCalledWith("proposalAnalysisWorkflow", {
			workflowId: "proposal-analysis-doc-1-live-run-1",
			parentClosePolicy: ParentClosePolicy.PARENT_CLOSE_POLICY_ABANDON,
			args: [
				{
					runId: "analysis-live-run-1",
					organizationId: "org-1",
					projectId: "project-1",
					documentId: "doc-1",
					userId: "user-1",
					planEligible: true,
				},
			],
		});
	});

	it("gives a regeneration with identical settings its own analysis run", async () => {
		await documentGenerationChildWorkflow(INPUT);
		h.activities.planProposalArtifact.mockImplementation(async () =>
			planFor("live-run-2"),
		);
		await documentGenerationChildWorkflow(INPUT);

		const workflowIds = h.startChild.mock.calls.map(
			(call) => (call[1] as { workflowId: string }).workflowId,
		);
		expect(workflowIds).toEqual([
			"proposal-analysis-doc-1-live-run-1",
			"proposal-analysis-doc-1-live-run-2",
		]);
		expect(
			(argsOf("createProposalAnalysisRun", 1)[0] as { liveRunId: string })
				.liveRunId,
		).toBe("live-run-2");
	});
});

describe("gate on — the run token and the attempt's identity", () => {
	it("hands the plan the child execution's run id as the token, and the attempt's identity when the run has one", async () => {
		await documentGenerationChildWorkflow({
			...INPUT,
			generationStartedAt: "2026-10-07T09:00:00.123Z",
		});

		expect(argsOf("planProposalArtifact")[0]).toMatchObject({
			liveRunId: "live-run-1",
			generationStartedAt: "2026-10-07T09:00:00.123Z",
		});
	});

	it("stops without writing anything when the plan finds a newer request owns the document", async () => {
		h.activities.planProposalArtifact.mockImplementation(async () => {
			h.calls.push("planProposalArtifact");
			return { superseded: true };
		});

		const failure = await failureOf(
			documentGenerationChildWorkflow({
				...INPUT,
				generationStartedAt: "2026-10-07T09:00:00.123Z",
			}),
		);

		expect(failure).toBeInstanceOf(ApplicationFailure);
		expect((failure as ApplicationFailure).type).toBe(
			"DOCUMENT_GENERATION_SUPERSEDED",
		);
		expect((failure as ApplicationFailure).nonRetryable).toBe(true);
		// Nothing after the plan: no retrieval, no generation, and — the
		// newer run owns the document — no cleanup and no status write of
		// any kind, guarded or not.
		expect(h.calls).toEqual(["planProposalArtifact"]);
		expect(h.activities.clearProposalLiveContent).not.toHaveBeenCalled();
		expect(h.activities.updateProjectDocumentStatus).not.toHaveBeenCalled();
	});
});

describe("gate on — a plan that refuses", () => {
	it("fails the run with the actionable message before any generation or save", async () => {
		const message =
			'No prompt is bound to the "Proposal (client)" action, so this Proposal cannot be generated.';
		h.activities.planProposalArtifact.mockRejectedValue(
			wrapped(
				ApplicationFailure.nonRetryable(
					message,
					"PROPOSAL_PROMPT_NOT_BOUND",
				),
				"planProposalArtifact",
			),
		);

		const failure = await failureOf(documentGenerationChildWorkflow(INPUT));

		expect(failure).toBeInstanceOf(ApplicationFailure);
		expect((failure as ApplicationFailure).nonRetryable).toBe(true);
		expect((failure as ApplicationFailure).message).toBe(message);
		// A refusal, not a supersession: the parents record it as today.
		expect((failure as ApplicationFailure).type).toBe(
			"DOCUMENT_GENERATION_CHILD_FAILED",
		);
		expect(h.activities.retrieveProjectContexts).not.toHaveBeenCalled();
		expect(h.activities.generateDocumentWithAgent).not.toHaveBeenCalled();
		expect(h.activities.saveProjectDocument).not.toHaveBeenCalled();
		// No plan, so no run token to clean up under.
		expect(h.activities.clearProposalLiveContent).not.toHaveBeenCalled();
		expect(h.activities.updateProjectDocumentStatus).toHaveBeenCalledWith({
			documentId: "doc-1",
			status: "FAILED",
			progress: 0,
			error: message,
		});
	});
});

describe("gate on — visuals never block Main", () => {
	it("saves the unvisualized Main when the visuals step fails", async () => {
		h.activities.generateProposalVisuals.mockRejectedValue(
			new Error("Activity task timed out"),
		);

		const result = await documentGenerationChildWorkflow(INPUT);

		expect(result.success).toBe(true);
		expect(argsOf("saveProjectDocument")[1]).toBe(GENERATED);
		expect(h.startChild).toHaveBeenCalledTimes(1);
	});

	it("skips the visuals once the child has run ten minutes", async () => {
		h.childAgeMs = 10 * 60 * 1000 + 1;

		const result = await documentGenerationChildWorkflow(INPUT);

		expect(result.success).toBe(true);
		expect(h.activities.generateProposalVisuals).not.toHaveBeenCalled();
		expect(argsOf("saveProjectDocument")[1]).toBe(GENERATED);
	});

	it("still runs the visuals just inside the limit", async () => {
		h.childAgeMs = 10 * 60 * 1000 - 1_000;

		await documentGenerationChildWorkflow(INPUT);

		expect(h.activities.generateProposalVisuals).toHaveBeenCalledTimes(1);
	});
});

describe("gate on — the analysis never fails the child", () => {
	it("completes Main when the analysis run cannot be recorded", async () => {
		h.activities.createProposalAnalysisRun.mockRejectedValue(
			new Error("database unavailable"),
		);

		const result = await documentGenerationChildWorkflow(INPUT);

		expect(result.success).toBe(true);
		expect(h.startChild).not.toHaveBeenCalled();
		// There is no run to mark.
		expect(h.activities.failProposalAnalysisRun).not.toHaveBeenCalled();
		expect(
			h.activities.updateProjectDocumentStatus,
		).not.toHaveBeenCalledWith(
			expect.objectContaining({ status: "FAILED" }),
		);
	});

	it("marks the run START_FAILED when the analysis workflow cannot be started", async () => {
		h.startChild.mockRejectedValue(new Error("namespace unavailable"));

		const result = await documentGenerationChildWorkflow(INPUT);

		expect(result.success).toBe(true);
		expect(argsOf("failProposalAnalysisRun")).toEqual([
			{
				runId: "analysis-live-run-1",
				organizationId: "org-1",
				projectId: "project-1",
				documentId: "doc-1",
				userId: "user-1",
				errorCode: "START_FAILED",
			},
		]);
		expect(
			h.activities.updateProjectDocumentStatus,
		).not.toHaveBeenCalledWith(
			expect.objectContaining({ status: "FAILED" }),
		);
	});

	it("starts nothing, and marks nothing, when a newer generation took the document before the run was recorded", async () => {
		h.activities.createProposalAnalysisRun.mockImplementation(async () => {
			h.calls.push("createProposalAnalysisRun");
			return { kind: "superseded" };
		});

		const result = await documentGenerationChildWorkflow(INPUT);

		expect(result.success).toBe(true);
		expect(h.startChild).not.toHaveBeenCalled();
		expect(h.activities.failProposalAnalysisRun).not.toHaveBeenCalled();
	});

	it("still completes when even the START_FAILED write fails", async () => {
		h.startChild.mockRejectedValue(new Error("namespace unavailable"));
		h.activities.failProposalAnalysisRun.mockRejectedValue(
			new Error("database unavailable"),
		);

		const result = await documentGenerationChildWorkflow(INPUT);

		expect(result.success).toBe(true);
	});

	it("leaves a run whose workflow is already running to that workflow", async () => {
		const { WorkflowExecutionAlreadyStartedError } = await import(
			"@temporalio/common"
		);
		h.startChild.mockRejectedValue(
			new WorkflowExecutionAlreadyStartedError(
				"Workflow execution already started",
				"proposal-analysis-doc-1-live-run-1",
				"proposalAnalysisWorkflow",
			),
		);

		const result = await documentGenerationChildWorkflow(INPUT);

		expect(result.success).toBe(true);
		expect(h.activities.failProposalAnalysisRun).not.toHaveBeenCalled();
	});

	it.each([
		["the analysis prompt is unbound", "PROMPT_NOT_BOUND"],
		["a project guest triggered the run", "GUEST_TRIGGERED"],
	] as const)("starts nothing when %s", async (_case, errorCode) => {
		h.activities.planProposalArtifact.mockImplementation(async () => ({
			...PLAN,
			analysisPrompt: null,
			analysisSkipReason: errorCode,
			triggeredByGuest: errorCode === "GUEST_TRIGGERED",
		}));
		h.activities.createProposalAnalysisRun.mockImplementation(async () => ({
			kind: "skipped",
			runId: "analysis-skipped",
			runKey: "proposal-analysis-doc-1-live-run-1",
			errorCode,
		}));

		const result = await documentGenerationChildWorkflow(INPUT);

		expect(result.success).toBe(true);
		expect(
			(argsOf("createProposalAnalysisRun")[0] as Record<string, unknown>)
				.analysisSkipReason,
		).toBe(errorCode);
		expect(h.startChild).not.toHaveBeenCalled();
		expect(h.activities.failProposalAnalysisRun).not.toHaveBeenCalled();
	});
});

describe("gate on — failures under the run token", () => {
	it("clears the run's live preview, then writes FAILED under its token, when generation fails mid-stream", async () => {
		h.activities.generateDocumentWithAgent.mockRejectedValue(
			new Error("agent stream broke"),
		);

		await failureOf(documentGenerationChildWorkflow(INPUT));

		expect(argsOf("clearProposalLiveContent")).toEqual([
			{ documentId: "doc-1", liveRunId: "live-run-1" },
		]);
		expect(
			h.activities.updateProjectDocumentStatus,
		).toHaveBeenLastCalledWith({
			documentId: "doc-1",
			status: "FAILED",
			progress: 0,
			error: "agent stream broke",
			liveRunId: "live-run-1",
		});
		const order = h.calls;
		expect(order.lastIndexOf("clearProposalLiveContent")).toBeLessThan(
			order.lastIndexOf("updateProjectDocumentStatus"),
		);
		expect(h.activities.saveProjectDocument).not.toHaveBeenCalled();
		expect(h.startChild).not.toHaveBeenCalled();
	});

	it("still writes FAILED when the live preview cannot be cleared", async () => {
		h.activities.generateDocumentWithAgent.mockRejectedValue(
			new Error("agent stream broke"),
		);
		h.activities.clearProposalLiveContent.mockRejectedValue(
			new Error("database unavailable"),
		);

		await failureOf(documentGenerationChildWorkflow(INPUT));

		expect(h.activities.updateProjectDocumentStatus).toHaveBeenCalledWith(
			expect.objectContaining({
				status: "FAILED",
				liveRunId: "live-run-1",
			}),
		);
	});

	it("abandons a superseded run whose save is refused, touching nothing of the newer run", async () => {
		h.activities.saveProjectDocument.mockRejectedValue(
			wrapped(
				ApplicationFailure.nonRetryable(
					STALE_MESSAGE,
					"DOCUMENT_GENERATION_STALE",
				),
				"saveProjectDocument",
			),
		);

		const failure = await failureOf(documentGenerationChildWorkflow(INPUT));

		expect(failure).toBeInstanceOf(ApplicationFailure);
		expect((failure as ApplicationFailure).nonRetryable).toBe(true);
		expect((failure as ApplicationFailure).message).toBe(STALE_MESSAGE);
		// The type a parent recognizes: it must not write FAILED either.
		expect((failure as ApplicationFailure).type).toBe(
			"DOCUMENT_GENERATION_SUPERSEDED",
		);
		// Both writes carry this run's token, so against a document a newer
		// run owns, each is a guarded no-op.
		expect(argsOf("clearProposalLiveContent")).toEqual([
			{ documentId: "doc-1", liveRunId: "live-run-1" },
		]);
		expect(
			h.activities.updateProjectDocumentStatus,
		).toHaveBeenLastCalledWith(
			expect.objectContaining({
				status: "FAILED",
				liveRunId: "live-run-1",
			}),
		);
		expect(h.activities.createDocumentVersion).not.toHaveBeenCalled();
		expect(
			h.activities.embedProjectDocumentActivity,
		).not.toHaveBeenCalled();
		expect(h.activities.createProposalAnalysisRun).not.toHaveBeenCalled();
		expect(h.startChild).not.toHaveBeenCalled();
	});

	it("guards every progress write after the plan with the run token", async () => {
		await documentGenerationChildWorkflow(INPUT);

		const progressWrites =
			h.activities.updateProjectDocumentStatus.mock.calls
				.map(([input]) => input as Record<string, unknown>)
				.filter((input) => input.status === "GENERATING");
		// 15, 25, 30 on the retrieval path, then 35 and 80 around generation.
		expect(progressWrites.map((input) => input.progress)).toEqual([
			15, 25, 30, 35, 80,
		]);
		for (const write of progressWrites) {
			expect(write.liveRunId).toBe("live-run-1");
		}
	});

	it("abandons the run when its version write is refused as stale, with no visual-slot baseline", async () => {
		h.activities.createDocumentVersion.mockRejectedValue(
			wrapped(
				ApplicationFailure.nonRetryable(
					STALE_MESSAGE,
					"DOCUMENT_GENERATION_STALE",
				),
				"createDocumentVersion",
			),
		);

		const failure = await failureOf(documentGenerationChildWorkflow(INPUT));

		expect((failure as ApplicationFailure).message).toBe(STALE_MESSAGE);
		expect((failure as ApplicationFailure).type).toBe(
			"DOCUMENT_GENERATION_SUPERSEDED",
		);
		expect(
			h.activities.embedProjectDocumentActivity,
		).not.toHaveBeenCalled();
		expect(h.startChild).not.toHaveBeenCalled();
	});

	it("ends any other coordinated-run failure with today's type", async () => {
		h.activities.generateDocumentWithAgent.mockRejectedValue(
			new Error("agent stream broke"),
		);

		const failure = await failureOf(documentGenerationChildWorkflow(INPUT));

		expect((failure as ApplicationFailure).type).toBe(
			"DOCUMENT_GENERATION_CHILD_FAILED",
		);
		expect((failure as ApplicationFailure).message).toBe(
			"agent stream broke",
		);
		// The run token, for the parent's own FAILED write.
		expect((failure as ApplicationFailure).details).toEqual([
			{ liveRunId: "live-run-1" },
		]);
	});

	it("treats any other version failure as non-fatal, as today", async () => {
		h.activities.createDocumentVersion.mockRejectedValue(
			new Error("connection reset"),
		);

		const result = await documentGenerationChildWorkflow(INPUT);

		expect(result.success).toBe(true);
		expect(h.startChild).toHaveBeenCalledTimes(1);
	});
});
