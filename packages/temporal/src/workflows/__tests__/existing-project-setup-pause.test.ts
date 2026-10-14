/**
 * Project setup pauses for a ChatGPT plan reset and resumes later (Fizzy
 * #2770): a document child that ends with the pause, or a code analysis the
 * spent plans refuse, saves what the setup finished on its run row and ends
 * it; the resume claims the row back, mints a fresh agent token, and redoes
 * none of what finished — no second set of document records, no completed
 * document generated again, no backlog ingested twice. A resume that lost its
 * claim ends without doing anything, the pause cap fails the documents still
 * waiting, and a run recorded before the patch never pauses.
 *
 * Harness convention (see `document-generation-superseded-parents.test.ts`):
 * mock the activity surface and drive the workflow body as a plain function.
 */

import {
	ActivityFailure,
	ApplicationFailure,
	ChildWorkflowFailure,
	RetryState,
} from "@temporalio/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
	const names = [
		"createAgentTask",
		"updateAgentTaskWorkflow",
		"updateAgentTaskStatus",
		"issueGenerationToken",
		"updateProjectDocumentStatus",
		"updateProjectCodeAnalysisStatus",
		"updateProjectRagSettings",
		"createExistingProjectDocumentRecords",
		"findMcpConfigsForRepos",
		"logRepoContextAccessedActivity",
		"createAnalysisContextRecord",
		"appendAnalysisContentChunk",
		"embedCodeAnalysisContext",
		"ingestBacklogForRAG",
		"assertSharedPlansNotSpentActivity",
		"estimatePlanPoolResetActivity",
		"pauseBulkRunActivity",
		"claimBulkRunResumeActivity",
	] as const;
	return {
		activities: Object.fromEntries(
			names.map((name) => [name, vi.fn()]),
		) as Record<(typeof names)[number], ReturnType<typeof vi.fn>>,
		executeChild: vi.fn(),
		startChild: vi.fn(),
		patched: vi.fn(() => true),
		workflowId: "existing-setup-project-1",
	};
});

vi.mock("@temporalio/workflow", async (importOriginal) => ({
	...(await importOriginal<typeof import("@temporalio/workflow")>()),
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	patched: h.patched,
	proxyActivities: () => h.activities,
	executeChild: h.executeChild,
	startChild: h.startChild,
	workflowInfo: () => ({
		workflowId: h.workflowId,
		runId: "run-1",
		workflowType: "existingProjectSetupWorkflow",
		taskQueue: "project-documents",
		executionTimeoutMs: 7_200_000,
		startTime: new Date(),
	}),
}));

import { existingProjectSetupWorkflow } from "../existing-project-setup";

const HOUR = 60 * 60_000;

const DOCUMENTS = [
	{ id: "doc-prd", type: "PRD", title: "PRD" },
	{ id: "doc-proposal", type: "PROPOSAL", title: "Proposal" },
	{ id: "doc-architecture", type: "ARCHITECTURE", title: "Architecture" },
];

const baseInput = {
	projectId: "project-1",
	userId: "user-1",
	organizationId: "org-1",
	aiToken: "original-token",
	repoUrls: [] as string[],
	selectedDocumentTypes: ["PRD", "PROPOSAL", "ARCHITECTURE"],
	projectTypes: [],
	projectName: "Example project",
	jobType: "project-setup" as const,
};

/** A child that ended with the pause, as the parent receives it. */
function childPaused(): ChildWorkflowFailure {
	return new ChildWorkflowFailure(
		"default",
		{ workflowId: "wf-child", runId: "run-child" },
		"documentGenerationChildWorkflow",
		RetryState.NON_RETRYABLE_FAILURE,
		ApplicationFailure.nonRetryable(
			"Every ChatGPT plan this work may use is spent; pausing.",
			"ChatGptPlanPause",
			{ waitMs: 3 * HOUR, resetKnown: true },
		),
	);
}

/** The shared-plan probe's refusal, as the workflow receives it. */
function plansSpent(): ActivityFailure {
	return new ActivityFailure(
		"Activity task failed",
		"assertSharedPlansNotSpentActivity",
		"7",
		RetryState.NON_RETRYABLE_FAILURE,
		"worker",
		ApplicationFailure.nonRetryable(
			"Every ChatGPT plan this work may use has no usage left in this window.",
			"SubscriptionPlanExhaustedError",
		),
	);
}

const CHILD_SUCCESS = {
	success: true,
	documentId: "",
	documentContent: "",
	metrics: {
		contextCount: 0,
		episodeCount: 0,
		integrationMessageCount: 0,
		teamsSearchCount: 0,
		documentLength: 0,
		wordCount: 0,
		durationMs: 0,
	},
};

/** A code analysis long and complete enough to pass the quality check. */
const ANALYSIS = [
	"Project Overview",
	"Tech Stack",
	"Architecture",
	"Features & Capabilities",
	"API Surface",
	"Data Model",
]
	.map(
		(section) =>
			`## ${section}\n${"Concrete detail read from the repository. ".repeat(4)}`,
	)
	.join("\n\n");

/** Document children fail with the pause for these ids; others succeed. */
function documentChildren(pausedIds: string[] = []) {
	h.executeChild.mockImplementation(
		async (
			_workflow: unknown,
			options: {
				args: [{ documentId?: string; message?: string }];
			},
		) => {
			const [args] = options.args;
			if (args.message !== undefined) {
				return { status: "completed", response: ANALYSIS };
			}
			if (args.documentId && pausedIds.includes(args.documentId)) {
				throw childPaused();
			}
			return { ...CHILD_SUCCESS, documentId: args.documentId };
		},
	);
}

function childDocumentIds(): string[] {
	return h.executeChild.mock.calls
		.map(
			([, options]) =>
				(options as { args: [{ documentId?: string }] }).args[0]
					.documentId,
		)
		.filter((id): id is string => id !== undefined);
}

function statusWrites(documentId: string): string[] {
	return h.activities.updateProjectDocumentStatus.mock.calls
		.map(([input]) => input as { documentId: string; status: string })
		.filter((input) => input.documentId === documentId)
		.map((input) => input.status);
}

function projectStatuses(): string[] {
	return h.activities.updateProjectCodeAnalysisStatus.mock.calls.map(
		([input]) => (input as { status: string }).status,
	);
}

function runStatuses(): string[] {
	return h.activities.updateAgentTaskStatus.mock.calls.map(
		([input]) => (input as { status: string }).status,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	h.patched.mockReturnValue(true);
	h.workflowId = "existing-setup-project-1";
	h.activities.createAgentTask.mockResolvedValue({ id: "task-1" });
	h.activities.createExistingProjectDocumentRecords.mockResolvedValue({
		documents: DOCUMENTS,
	});
	h.activities.issueGenerationToken.mockResolvedValue({
		aiToken: "fresh-token",
	});
	h.activities.estimatePlanPoolResetActivity.mockResolvedValue({
		waitMs: 3 * HOUR,
		jitterMs: 0,
		resetKnown: true,
	});
	h.activities.pauseBulkRunActivity.mockImplementation(
		async (input: { pauseCount: number }) => ({
			paused: true,
			resumesAt: "2026-10-12T21:00:00.000Z",
			pauseCount: input.pauseCount + 1,
		}),
	);
	h.activities.findMcpConfigsForRepos.mockResolvedValue({
		allMcpConfigIds: ["mcp-1"],
		mappings: [{ repoUrl: "https://example.com/acme/app" }],
		usedProjectCredentials: false,
	});
	h.activities.createAnalysisContextRecord.mockResolvedValue({
		contextId: "analysis-ctx",
	});
	h.activities.ingestBacklogForRAG.mockResolvedValue({
		contextId: "backlog-ctx",
		itemCounts: {},
	});
});

/** The one pause the run recorded. */
function recordedPause(): Record<string, unknown> {
	expect(h.activities.pauseBulkRunActivity).toHaveBeenCalledTimes(1);
	return h.activities.pauseBulkRunActivity.mock.calls[0][0] as Record<
		string,
		unknown
	>;
}

describe("existingProjectSetupWorkflow — a document child pauses", () => {
	it("saves the finished documents, queues the rest for the resume, and fails nothing", async () => {
		documentChildren(["doc-proposal"]);

		const output = await existingProjectSetupWorkflow(baseInput);

		expect(output).toMatchObject({
			paused: true,
			resumesAt: "2026-10-12T21:00:00.000Z",
			documentIds: ["doc-prd"],
		});
		// The architecture document never started: it waits too.
		expect(childDocumentIds()).toEqual(["doc-prd", "doc-proposal"]);
		const pause = recordedPause();
		expect(pause).toMatchObject({
			kind: "PROJECT_SETUP",
			runId: "task-1",
			pauseCount: 0,
			workflowIdBase: "existing-setup-project-1",
			waitMs: 3 * HOUR,
			queuedDocumentIds: ["doc-proposal", "doc-architecture"],
			progress: {
				analysisDone: true,
				backlogDone: true,
				documents: DOCUMENTS.map(({ id, type }) => ({ id, type })),
				documentIds: ["doc-prd"],
				finishedDocumentIds: ["doc-prd"],
			},
		});
		// Never a credential on the saved input.
		expect((pause.input as { aiToken: string }).aiToken).toBe("");
		expect(statusWrites("doc-proposal")).toEqual(["GENERATING"]);
		expect(statusWrites("doc-architecture")).toEqual([]);
		// The project's analysis is still under way, and so is the run.
		expect(projectStatuses()).toEqual(["SCANNING"]);
		expect(runStatuses()).toEqual(["RUNNING"]);
	});

	it("asks every document child to pause rather than wait long", async () => {
		documentChildren();

		await existingProjectSetupWorkflow(baseInput);

		for (const [, options] of h.executeChild.mock.calls) {
			expect(
				(options as { args: [Record<string, unknown>] }).args[0],
			).toMatchObject({ waitForPlanReset: true, pauseOnPlanSpent: true });
		}
		expect(runStatuses()).toEqual(["RUNNING", "COMPLETED"]);
	});

	it("resumes from the saved progress: no new records, no finished document again, a fresh token", async () => {
		documentChildren(["doc-proposal"]);
		await existingProjectSetupWorkflow(baseInput);
		const pause = recordedPause();

		vi.clearAllMocks();
		h.workflowId = "existing-setup-project-1-resume-1";
		h.activities.issueGenerationToken.mockResolvedValue({
			aiToken: "fresh-token",
		});
		h.activities.claimBulkRunResumeActivity.mockResolvedValue({
			claimed: true,
			progress: pause.progress,
		});
		documentChildren();

		const output = await existingProjectSetupWorkflow({
			...(pause.input as typeof baseInput),
			resumeOf: {
				runId: "task-1",
				pauseCount: 1,
				workflowIdBase: "existing-setup-project-1",
			},
		});

		expect(h.activities.claimBulkRunResumeActivity).toHaveBeenCalledWith({
			kind: "PROJECT_SETUP",
			resumeOf: {
				runId: "task-1",
				pauseCount: 1,
				workflowIdBase: "existing-setup-project-1",
			},
			viaApiOverride: false,
		});
		expect(
			h.activities.createExistingProjectDocumentRecords,
		).not.toHaveBeenCalled();
		expect(h.activities.createAgentTask).not.toHaveBeenCalled();
		expect(childDocumentIds()).toEqual([
			"doc-proposal",
			"doc-architecture",
		]);
		for (const [, options] of h.executeChild.mock.calls) {
			expect(
				(options as { args: [{ aiToken: string }] }).args[0].aiToken,
			).toBe("fresh-token");
		}
		expect(statusWrites("doc-prd")).toEqual([]);
		// The project was SCANNING throughout; the resume only closes it, and
		// only while the analysis is still this setup's: a setup started
		// since owns it, and the resume never writes over it.
		expect(projectStatuses()).toEqual(["COMPLETED"]);
		expect(
			h.activities.updateProjectCodeAnalysisStatus,
		).toHaveBeenCalledWith({
			projectId: "project-1",
			status: "COMPLETED",
			onlyIfWorkflowId: "existing-setup-project-1",
		});
		expect(h.activities.updateAgentTaskStatus).toHaveBeenCalledWith(
			expect.objectContaining({ id: "task-1", status: "COMPLETED" }),
		);
		expect(output).toMatchObject({
			success: true,
			documentIds: ["doc-prd", "doc-proposal", "doc-architecture"],
		});
	});

	it("fails the documents still waiting with the reason when the pause cap is reached", async () => {
		documentChildren(["doc-proposal"]);
		h.activities.pauseBulkRunActivity.mockResolvedValue({
			paused: false,
			message: "Every ChatGPT plan stayed spent through every pause.",
		});

		const output = await existingProjectSetupWorkflow(baseInput);

		expect(output.paused).toBeUndefined();
		for (const id of ["doc-proposal", "doc-architecture"]) {
			expect(
				h.activities.updateProjectDocumentStatus,
			).toHaveBeenCalledWith({
				documentId: id,
				status: "FAILED",
				progress: 0,
				error: "Every ChatGPT plan stayed spent through every pause.",
			});
		}
		expect(projectStatuses()).toEqual(["SCANNING", "COMPLETED"]);
		expect(runStatuses()).toEqual(["RUNNING", "COMPLETED"]);
	});
});

describe("existingProjectSetupWorkflow — the code analysis pauses", () => {
	const withRepoAndBacklog = {
		...baseInput,
		repoUrls: ["https://example.com/acme/app"],
		pmMcpConfigId: "pm-1",
		pmContainerId: "container-1",
	};

	it("keeps the ingested backlog, creates no documents yet, and leaves the project scanning", async () => {
		h.executeChild.mockRejectedValue(new Error("Orchestrator failed"));
		h.activities.assertSharedPlansNotSpentActivity.mockRejectedValue(
			plansSpent(),
		);

		const output = await existingProjectSetupWorkflow(withRepoAndBacklog);

		expect(output).toMatchObject({ paused: true, documentIds: [] });
		expect(recordedPause()).toMatchObject({
			kind: "PROJECT_SETUP",
			runId: "task-1",
			progress: {
				analysisDone: false,
				backlogDone: true,
				backlogContextId: "backlog-ctx",
			},
		});
		expect(recordedPause()).not.toHaveProperty("queuedDocumentIds");
		expect(
			h.activities.createExistingProjectDocumentRecords,
		).not.toHaveBeenCalled();
		expect(projectStatuses()).toEqual(["SCANNING"]);
	});

	it("runs only the analysis again on resume", async () => {
		h.activities.claimBulkRunResumeActivity.mockResolvedValue({
			claimed: true,
			progress: {
				analysisDone: false,
				backlogDone: true,
				backlogContextId: "backlog-ctx",
			},
		});
		documentChildren();

		const output = await existingProjectSetupWorkflow({
			...withRepoAndBacklog,
			aiToken: "",
			resumeOf: {
				runId: "task-1",
				pauseCount: 1,
				workflowIdBase: "existing-setup-project-1",
			},
		});

		expect(h.activities.ingestBacklogForRAG).not.toHaveBeenCalled();
		expect(h.activities.embedCodeAnalysisContext).toHaveBeenCalled();
		expect(output).toMatchObject({
			success: true,
			analysisContextId: "analysis-ctx",
			backlogContextId: "backlog-ctx",
		});
		expect(childDocumentIds()).toEqual([
			"doc-prd",
			"doc-proposal",
			"doc-architecture",
		]);
	});

	it("fails the setup with the cap's reason when the pause is refused", async () => {
		h.executeChild.mockRejectedValue(new Error("Orchestrator failed"));
		h.activities.assertSharedPlansNotSpentActivity.mockRejectedValue(
			plansSpent(),
		);
		h.activities.pauseBulkRunActivity.mockResolvedValue({
			paused: false,
			message: "Every ChatGPT plan stayed spent through every pause.",
		});

		await expect(
			existingProjectSetupWorkflow(withRepoAndBacklog),
		).rejects.toThrow(
			"Every ChatGPT plan stayed spent through every pause.",
		);
		expect(projectStatuses()).toEqual(["SCANNING", "FAILED"]);
		// A first run owns the analysis it started: its writes are unguarded.
		for (const [write] of h.activities.updateProjectCodeAnalysisStatus.mock
			.calls) {
			expect(write).not.toHaveProperty("onlyIfWorkflowId");
		}
		expect(h.activities.updateAgentTaskStatus).toHaveBeenLastCalledWith(
			expect.objectContaining({ id: "task-1", status: "FAILED" }),
		);
	});
});

describe("existingProjectSetupWorkflow — resume and replay edges", () => {
	it("ends without doing anything when its resume lost the claim", async () => {
		h.activities.claimBulkRunResumeActivity.mockResolvedValue({
			claimed: false,
		});

		const output = await existingProjectSetupWorkflow({
			...baseInput,
			resumeOf: {
				runId: "task-1",
				pauseCount: 1,
				workflowIdBase: "existing-setup-project-1",
			},
		});

		expect(output).toEqual({ success: false, documentIds: [] });
		expect(h.executeChild).not.toHaveBeenCalled();
		expect(
			h.activities.updateProjectCodeAnalysisStatus,
		).not.toHaveBeenCalled();
		expect(h.activities.issueGenerationToken).not.toHaveBeenCalled();
	});

	it("never pauses a run recorded before the patch: no run row, and a paused child is a failure", async () => {
		h.patched.mockReturnValue(false);
		documentChildren(["doc-proposal"]);

		const output = await existingProjectSetupWorkflow(baseInput);

		expect(h.activities.createAgentTask).not.toHaveBeenCalled();
		expect(h.activities.pauseBulkRunActivity).not.toHaveBeenCalled();
		for (const [, options] of h.executeChild.mock.calls) {
			expect(
				(options as { args: [Record<string, unknown>] }).args[0],
			).not.toHaveProperty("pauseOnPlanSpent");
		}
		expect(statusWrites("doc-proposal")).toEqual(["GENERATING", "FAILED"]);
		expect(output.documentIds).toEqual(["doc-prd", "doc-architecture"]);
	});
});
