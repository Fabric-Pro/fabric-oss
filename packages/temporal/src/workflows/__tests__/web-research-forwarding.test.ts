/**
 * A person's per-action web research answer must survive every hop of a
 * generation run: parent → child → generation activity, and every token the
 * run re-issues on the way. A `true` is research allowed; a `false` is a
 * choice offered and declined, which travels so the document can say research
 * was not authorized; a run that offered no choice carries no key, and its
 * payloads stay exactly what they were. Only a `true` reaches a token.
 *
 * The parent→child hop is the dangerous one: the API starts the parent by
 * string name with untyped args, and the parent hands the child an
 * enumerated args object, not a spread of its input. A field forgotten there
 * raises no type error and simply never arrives.
 *
 * "Absent" is asserted with `not.toHaveProperty`, never with `toEqual` or
 * `objectContaining`: those treat a present-but-undefined key as missing, and
 * the conditional spreads exist precisely so the key is not there at all.
 *
 * Harness convention (see `supplied-context-wiring.test.ts`): mock the
 * activity surface and drive the workflow bodies as plain async functions.
 * Determinism is gated separately by the replay suites.
 */

import {
	ActivityFailure,
	ApplicationFailure,
	RetryState,
} from "@temporalio/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { activityMocks, executeChildMock, startChildMock } = vi.hoisted(() => ({
	activityMocks: {
		// Parent workflow's tracking activities
		createAgentTask: vi.fn(),
		updateAgentTaskWorkflow: vi.fn(),
		updateAgentTaskStatus: vi.fn(),
		updateProjectWorkflowStatus: vi.fn(),
		// The parent's dependency queue and the re-issue after a wait
		probeGenerationDependencies: vi.fn(),
		assertRequesterMayGenerate: vi.fn(),
		issueGenerationToken: vi.fn(),
		recordGenerationQueueReason: vi.fn(),
		startGenerationRun: vi.fn(),
		// Child workflow's generation activities
		retrieveProjectContexts: vi.fn(),
		retrieveAndFormatEpisodicMemory: vi.fn(),
		generateDocumentWithAgent: vi.fn(),
		saveProjectDocument: vi.fn(),
		createDocumentVersion: vi.fn(),
		embedProjectDocumentActivity: vi.fn(),
		checkProjectHasTeamsIntegration: vi.fn(),
		fetchRecentTeamsMessages: vi.fn(),
		checkProjectHasSlackIntegration: vi.fn(),
		fetchRecentSlackMessages: vi.fn(),
		updateProjectDocumentStatus: vi.fn(),
		runDocumentDecisionPrecheckActivity: vi.fn(),
		// The ChatGPT plan wait the child's second generation attempt sits behind
		estimatePlanPoolResetActivity: vi.fn(),
		notifyPlanWaitWorkStoppedActivity: vi.fn(),
	},
	executeChildMock: vi.fn(),
	startChildMock: vi.fn(),
}));

vi.mock("@temporalio/workflow", () => {
	class ActivityFailure extends Error {}
	class ApplicationFailure extends Error {
		static nonRetryable(message: string, type?: string) {
			const failure = new ApplicationFailure(message);
			(failure as ApplicationFailure & { type?: string }).type = type;
			return failure;
		}
	}

	return {
		ActivityFailure,
		ApplicationFailure,
		executeChild: executeChildMock,
		startChild: startChildMock,
		log: {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
		},
		ParentClosePolicy: {
			PARENT_CLOSE_POLICY_ABANDON: "ABANDON",
		},
		patched: () => true,
		proxyActivities: () => activityMocks,
		sleep: vi.fn(async () => undefined),
		// No execution timeout: the plan wait then has no deadline to cap it,
		// and never reads `startTime`.
		workflowInfo: () => ({
			workflowId: "wf_1",
			runId: "run_1",
			continueAsNewSuggested: false,
		}),
	};
});

import { documentGenerationChildWorkflow } from "../document-generation-child";
import { projectDocumentGenerationWorkflow } from "../project-document-generation";

const PARENT_INPUT = {
	projectId: "proj_1",
	documentId: "doc_1",
	documentType: "BUSINESS_CASE",
	userId: "user_1",
	organizationId: "org_1",
	aiToken: "dispatch-token",
	prompt: "Include external ROI evidence",
};

const CHILD_INPUT = {
	projectId: "proj_1",
	documentId: "doc_1",
	documentType: "BUSINESS_CASE",
	userId: "user_1",
	organizationId: "org_1",
	aiToken: "dispatch-token",
	prompt: "Include external ROI evidence",
};

/** The args object the parent enumerated for `executeChild`. */
function childArgs(): Record<string, unknown> {
	const call = executeChildMock.mock.calls[0];
	if (!call) {
		throw new Error("executeChild was never called");
	}
	return (call[1] as { args: Record<string, unknown>[] }).args[0];
}

/** The input of the n-th `issueGenerationToken` call. */
function reissueArgs(index = 0): Record<string, unknown> {
	const call = activityMocks.issueGenerationToken.mock.calls[index];
	if (!call) {
		throw new Error(`issueGenerationToken call ${index} never happened`);
	}
	return call[0] as Record<string, unknown>;
}

/** The input of the n-th `generateDocumentWithAgent` call. */
function agentArgs(index = 0): Record<string, unknown> {
	const call = activityMocks.generateDocumentWithAgent.mock.calls[index];
	if (!call) {
		throw new Error(
			`generateDocumentWithAgent call ${index} never happened`,
		);
	}
	return call[0] as Record<string, unknown>;
}

/** Every shared ChatGPT plan is spent, as the workflow receives it. */
function plansSpent(): ActivityFailure {
	return new ActivityFailure(
		"Activity task failed",
		"generateDocumentWithAgent",
		"3",
		RetryState.NON_RETRYABLE_FAILURE,
		"worker",
		ApplicationFailure.nonRetryable(
			"Every ChatGPT plan this work may use has no usage left in this window.",
			"SubscriptionPlanExhaustedError",
		),
	);
}

/** Drives the parent through one dependency wait before it reaches the child. */
function waitOnceThenClear() {
	activityMocks.probeGenerationDependencies
		.mockResolvedValueOnce({
			verdict: "waiting",
			outstanding: [{ category: "sourceExtraction", count: 1 }],
			failed: [],
		})
		.mockResolvedValueOnce({
			verdict: "clear",
			outstanding: [],
			failed: [],
		});
}

/** A bulk child whose first generation attempt finds every plan spent. */
function firstAttemptFindsPlansSpent() {
	activityMocks.generateDocumentWithAgent
		.mockRejectedValueOnce(plansSpent())
		.mockResolvedValueOnce({ content: "# Generated" });
}

beforeEach(() => {
	vi.clearAllMocks();

	executeChildMock.mockResolvedValue({
		success: true,
		documentId: "doc_1",
		documentContent: "# Generated",
		metrics: {
			contextCount: 0,
			episodeCount: 0,
			integrationMessageCount: 0,
			teamsSearchCount: 0,
			documentLength: 11,
			wordCount: 2,
			durationMs: 1,
		},
	});
	startChildMock.mockResolvedValue(undefined);

	activityMocks.createAgentTask.mockResolvedValue({ id: "task_1" });
	activityMocks.updateAgentTaskWorkflow.mockResolvedValue(undefined);
	activityMocks.updateAgentTaskStatus.mockResolvedValue(undefined);
	activityMocks.updateProjectWorkflowStatus.mockResolvedValue(undefined);

	activityMocks.probeGenerationDependencies.mockResolvedValue({
		verdict: "clear",
		outstanding: [],
		failed: [],
	});
	activityMocks.assertRequesterMayGenerate.mockResolvedValue(undefined);
	activityMocks.issueGenerationToken.mockResolvedValue({
		aiToken: "re-issued-token",
	});
	activityMocks.recordGenerationQueueReason.mockResolvedValue(undefined);
	activityMocks.startGenerationRun.mockResolvedValue({ outcome: "started" });

	activityMocks.retrieveProjectContexts.mockResolvedValue([
		"retrieved context A",
	]);
	activityMocks.retrieveAndFormatEpisodicMemory.mockResolvedValue({
		episodeCount: 0,
		formattedContext: "",
	});
	activityMocks.checkProjectHasTeamsIntegration.mockResolvedValue(false);
	activityMocks.checkProjectHasSlackIntegration.mockResolvedValue(false);
	activityMocks.generateDocumentWithAgent.mockResolvedValue({
		content: "# Generated",
	});
	activityMocks.saveProjectDocument.mockResolvedValue(undefined);
	activityMocks.createDocumentVersion.mockResolvedValue(undefined);
	activityMocks.embedProjectDocumentActivity.mockResolvedValue({
		success: true,
	});
	activityMocks.updateProjectDocumentStatus.mockResolvedValue(undefined);
	activityMocks.runDocumentDecisionPrecheckActivity.mockResolvedValue(
		undefined,
	);
	// Zero: the retry runs at once, as for an organization whose own provider
	// takes over.
	activityMocks.estimatePlanPoolResetActivity.mockResolvedValue({
		waitMs: 0,
		jitterMs: 0,
		resetKnown: true,
	});
	activityMocks.notifyPlanWaitWorkStoppedActivity.mockResolvedValue(
		undefined,
	);
});

describe("parent workflow forwards web research to the child", () => {
	it("passes an allowed action's permission in the child args", async () => {
		await projectDocumentGenerationWorkflow({
			...PARENT_INPUT,
			allowWebResearch: true,
		});

		expect(childArgs().allowWebResearch).toBe(true);
	});

	it("leaves the key out of the child args when the field is absent", async () => {
		await projectDocumentGenerationWorkflow(PARENT_INPUT);

		expect(childArgs()).not.toHaveProperty("allowWebResearch");
	});

	it("passes a declined choice as allowWebResearch: false", async () => {
		await projectDocumentGenerationWorkflow({
			...PARENT_INPUT,
			allowWebResearch: false,
		});

		expect(childArgs()).toHaveProperty("allowWebResearch", false);
	});

	it("leaves the key out of the child args for a non-boolean", async () => {
		for (const value of ["true", 1]) {
			executeChildMock.mockClear();

			await projectDocumentGenerationWorkflow({
				...PARENT_INPUT,
				allowWebResearch: value as unknown as boolean,
			});

			expect(childArgs()).not.toHaveProperty("allowWebResearch");
		}
	});
});

describe("parent workflow keeps web research on the token it re-issues after a dependency wait", () => {
	const QUEUED_INPUT = {
		...PARENT_INPUT,
		generationStartedAt: "2026-11-10T09:00:00.000Z",
	};

	it("re-issues with webResearch when the action allowed it", async () => {
		waitOnceThenClear();

		await projectDocumentGenerationWorkflow({
			...QUEUED_INPUT,
			allowWebResearch: true,
		});

		expect(activityMocks.issueGenerationToken).toHaveBeenCalledTimes(1);
		expect(reissueArgs().webResearch).toBe(true);
		// Bound to this run's project, as the dispatch token was.
		expect(reissueArgs().webResearchProjectId).toBe("proj_1");
		// And the child runs under that fresh token, still allowed.
		expect(childArgs().aiToken).toBe("re-issued-token");
		expect(childArgs().allowWebResearch).toBe(true);
	});

	it("re-issues with no webResearch key when the action did not allow it", async () => {
		waitOnceThenClear();

		await projectDocumentGenerationWorkflow(QUEUED_INPUT);

		expect(activityMocks.issueGenerationToken).toHaveBeenCalledTimes(1);
		expect(reissueArgs()).not.toHaveProperty("webResearch");
		expect(reissueArgs()).not.toHaveProperty("webResearchProjectId");
	});

	it("re-issues with no webResearch key for a declined choice, which still reaches the child", async () => {
		waitOnceThenClear();

		await projectDocumentGenerationWorkflow({
			...QUEUED_INPUT,
			allowWebResearch: false,
		});

		expect(activityMocks.issueGenerationToken).toHaveBeenCalledTimes(1);
		expect(reissueArgs()).not.toHaveProperty("webResearch");
		expect(reissueArgs()).not.toHaveProperty("webResearchProjectId");
		expect(childArgs()).toHaveProperty("allowWebResearch", false);
	});
});

describe("child workflow forwards web research to the generation activity", () => {
	it("passes an allowed action's permission to generateDocumentWithAgent", async () => {
		await documentGenerationChildWorkflow({
			...CHILD_INPUT,
			allowWebResearch: true,
		});

		expect(agentArgs().allowWebResearch).toBe(true);
	});

	it("leaves the key out of the activity args when the field is absent", async () => {
		await documentGenerationChildWorkflow(CHILD_INPUT);

		expect(agentArgs()).not.toHaveProperty("allowWebResearch");
	});

	it("passes a declined choice to generateDocumentWithAgent as allowWebResearch: false", async () => {
		await documentGenerationChildWorkflow({
			...CHILD_INPUT,
			allowWebResearch: false,
		});

		expect(agentArgs()).toHaveProperty("allowWebResearch", false);
	});

	it("leaves the key out of the activity args for a non-boolean", async () => {
		await documentGenerationChildWorkflow({
			...CHILD_INPUT,
			allowWebResearch: "true" as unknown as boolean,
		});

		expect(agentArgs()).not.toHaveProperty("allowWebResearch");
	});
});

describe("child workflow hands a research run its attempt identity", () => {
	const STARTED_AT = "2026-11-10T09:00:00.000Z";

	it("passes generationStartedAt to the activity of a run allowed to research", async () => {
		await documentGenerationChildWorkflow({
			...CHILD_INPUT,
			allowWebResearch: true,
			generationStartedAt: STARTED_AT,
		});

		expect(agentArgs().generationStartedAt).toBe(STARTED_AT);
	});

	it.each([
		["declined", false],
		["not offered", undefined],
	])(
		"leaves it out of the activity args when research was %s",
		async (_label, value) => {
			await documentGenerationChildWorkflow({
				...CHILD_INPUT,
				...(value !== undefined && { allowWebResearch: value }),
				generationStartedAt: STARTED_AT,
			});

			expect(agentArgs()).not.toHaveProperty("generationStartedAt");
		},
	);

	it("leaves it out for a research run with no attempt identity", async () => {
		await documentGenerationChildWorkflow({
			...CHILD_INPUT,
			allowWebResearch: true,
		});

		expect(agentArgs()).not.toHaveProperty("generationStartedAt");
	});
});

describe("child workflow keeps web research across a plan-reset retry", () => {
	// No production caller reaches this path with the permission (only bulk
	// parents wait for a plan reset, and they never carry it); it is wired
	// the same way so a retry can never quietly widen or drop it.
	it("re-issues with webResearch and passes it to the retried generation", async () => {
		firstAttemptFindsPlansSpent();

		await documentGenerationChildWorkflow({
			...CHILD_INPUT,
			waitForPlanReset: true,
			allowWebResearch: true,
		});

		expect(activityMocks.generateDocumentWithAgent).toHaveBeenCalledTimes(
			2,
		);
		expect(activityMocks.issueGenerationToken).toHaveBeenCalledTimes(1);
		expect(reissueArgs().webResearch).toBe(true);
		expect(reissueArgs().webResearchProjectId).toBe("proj_1");
		expect(agentArgs(0).allowWebResearch).toBe(true);
		expect(agentArgs(1).allowWebResearch).toBe(true);
		expect(agentArgs(1).aiToken).toBe("re-issued-token");
	});

	it("re-issues with no webResearch key and passes none when the action did not allow it", async () => {
		firstAttemptFindsPlansSpent();

		await documentGenerationChildWorkflow({
			...CHILD_INPUT,
			waitForPlanReset: true,
		});

		expect(activityMocks.generateDocumentWithAgent).toHaveBeenCalledTimes(
			2,
		);
		expect(activityMocks.issueGenerationToken).toHaveBeenCalledTimes(1);
		expect(reissueArgs()).not.toHaveProperty("webResearch");
		expect(reissueArgs()).not.toHaveProperty("webResearchProjectId");
		expect(agentArgs(1)).not.toHaveProperty("allowWebResearch");
	});

	it("re-issues with no webResearch key and keeps a declined choice on the retried generation", async () => {
		firstAttemptFindsPlansSpent();

		await documentGenerationChildWorkflow({
			...CHILD_INPUT,
			waitForPlanReset: true,
			allowWebResearch: false,
		});

		expect(activityMocks.issueGenerationToken).toHaveBeenCalledTimes(1);
		expect(reissueArgs()).not.toHaveProperty("webResearch");
		expect(reissueArgs()).not.toHaveProperty("webResearchProjectId");
		expect(agentArgs(0)).toHaveProperty("allowWebResearch", false);
		expect(agentArgs(1)).toHaveProperty("allowWebResearch", false);
	});
});
