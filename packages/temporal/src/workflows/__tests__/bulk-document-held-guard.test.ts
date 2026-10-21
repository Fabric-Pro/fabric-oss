/**
 * The batch and existing-project-setup parents write only the documents their
 * run still holds (Fizzy #2946).
 *
 * Each parent starts a document with a GENERATING write that names the run
 * holding it: its kind, the child it is about to start and, on a resume,
 * which run it continues. When the activity reports `held: false` (a
 * person's save, a newer generation or a Cancel took the row since), the
 * parent starts no child, no evaluation and no COMPLETE write; the batch
 * records no result for it, and the setup counts it finished but not
 * generated. That skip sits behind `patched()`: a history recorded before it
 * takes today's sequence whatever the write returned. The COMPLETE and FAILED
 * writes after a child that hands back no run token are scoped to the
 * attempt the GENERATING write started, and the writes that fail the waiting
 * documents at the pause cap carry the pause's hold. Replay safety is pinned
 * separately, on real bundles, in `bulk-document-held-replay.test.ts`.
 *
 * Harness convention (see `document-generation-superseded-parents.test.ts`):
 * mock the activity surface and drive the workflow body as a plain function.
 */

import {
	ApplicationFailure,
	ChildWorkflowFailure,
	RetryState,
} from "@temporalio/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

const HELD_PATCH = "bulk-document-held-guard-v1";

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
		patched: vi.fn((_id: string) => true),
		workflowId: "wf-parent",
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
		runId: "run-parent",
		workflowType: "parentWorkflow",
		taskQueue: "project-documents",
		executionTimeoutMs: 7_200_000,
		startTime: new Date(),
	}),
}));

import { batchDocumentGenerationWorkflow } from "../batch-document-generation";
import { existingProjectSetupWorkflow } from "../existing-project-setup";

const HOUR = 60 * 60_000;
const CAP_MESSAGE = "Every ChatGPT plan stayed spent through every pause.";

const CHILD_SUCCESS = {
	success: true,
	documentId: "",
	// Non-empty, so a generated document's evaluation starts.
	documentContent: "# Generated",
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

type StatusWrite = Record<string, unknown> & {
	documentId: string;
	status: string;
};

/**
 * What the GENERATING write returns per document: not held for the ids in
 * `released`, the attempt it started for every other one.
 */
function generatingWrites(released: string[] = []) {
	h.activities.updateProjectDocumentStatus.mockImplementation(
		async (input: StatusWrite) => {
			if (input.status !== "GENERATING") {
				return undefined;
			}
			return released.includes(input.documentId)
				? { held: false }
				: { generationStartedAt: `attempt-of-${input.documentId}` };
		},
	);
}

/** A child failure as the parent receives it: wrapped by the child call. */
function childFailure(
	message: string,
	type: string,
	...details: unknown[]
): ChildWorkflowFailure {
	return new ChildWorkflowFailure(
		"default",
		{ workflowId: "wf-child", runId: "run-child" },
		"documentGenerationChildWorkflow",
		RetryState.NON_RETRYABLE_FAILURE,
		ApplicationFailure.nonRetryable(message, type, ...details),
	);
}

/** A child that ended with the plan pause, as the parent receives it. */
function childPaused(): ChildWorkflowFailure {
	return childFailure(
		"Every ChatGPT plan this work may use is spent; pausing.",
		"ChatGptPlanPause",
		{ waitMs: 3 * HOUR, resetKnown: true },
	);
}

/** The child's outcome per document id; any other id succeeds. */
function children(
	outcomes: Record<
		string,
		ChildWorkflowFailure | { coordinatedRun: string }
	> = {},
) {
	h.executeChild.mockImplementation(
		async (
			_workflow: unknown,
			options: { args: [{ documentId: string }] },
		) => {
			const { documentId } = options.args[0];
			const outcome = outcomes[documentId];
			if (outcome === undefined) {
				return { ...CHILD_SUCCESS, documentId };
			}
			if ("coordinatedRun" in outcome) {
				return {
					...CHILD_SUCCESS,
					documentId,
					liveRunId: outcome.coordinatedRun,
				};
			}
			throw outcome;
		},
	);
}

/** The document ids the parent started a child for, in order. */
function childDocumentIds(): string[] {
	return h.executeChild.mock.calls.map(
		([, options]) =>
			(options as { args: [{ documentId: string }] }).args[0].documentId,
	);
}

/** The workflow id the parent started `documentId`'s child under. */
function childWorkflowIdOf(documentId: string): string | undefined {
	const call = h.executeChild.mock.calls.find(
		([, options]) =>
			(options as { args: [{ documentId: string }] }).args[0]
				.documentId === documentId,
	);
	return (call?.[1] as { workflowId?: string } | undefined)?.workflowId;
}

/** The document ids an evaluation was started for. */
function evaluatedDocumentIds(): string[] {
	return h.startChild.mock.calls.map(
		([, options]) =>
			(options as { args: [{ projectDocumentId: string }] }).args[0]
				.projectDocumentId,
	);
}

function writesOf(documentId: string): StatusWrite[] {
	return h.activities.updateProjectDocumentStatus.mock.calls
		.map(([input]) => input as StatusWrite)
		.filter((input) => input.documentId === documentId);
}

function writeOf(documentId: string, status: string): StatusWrite | undefined {
	return writesOf(documentId).find((input) => input.status === status);
}

function statusesOf(documentId: string): string[] {
	return writesOf(documentId).map((input) => input.status);
}

/** Every patch on except the held-document guard: a history from before it. */
function recordedBeforeTheHeldGuard() {
	h.patched.mockImplementation((id: string) => id !== HELD_PATCH);
}

beforeEach(() => {
	vi.clearAllMocks();
	h.workflowId = "wf-parent";
	h.patched.mockImplementation(() => true);
	for (const fn of Object.values(h.activities)) {
		fn.mockReset();
		fn.mockResolvedValue(undefined);
	}
	h.activities.createAgentTask.mockResolvedValue({ id: "task-1" });
	h.activities.issueGenerationToken.mockResolvedValue({
		aiToken: "fresh-token",
	});
	h.activities.pauseBulkRunActivity.mockImplementation(
		async (input: { pauseCount: number }) => ({
			paused: true,
			resumesAt: "2026-10-21T21:00:00.000Z",
			pauseCount: input.pauseCount + 1,
		}),
	);
	h.startChild.mockResolvedValue({});
	generatingWrites();
	children();
});

describe("batchDocumentGenerationWorkflow — documents the batch no longer holds", () => {
	const documents = [
		{
			id: "doc-business",
			type: "BUSINESS_CASE",
			title: "Case",
			prompt: "",
		},
		{ id: "doc-proposal", type: "PROPOSAL", title: "Proposal", prompt: "" },
		{ id: "doc-prd", type: "PRD", title: "PRD", prompt: "" },
	];
	const input = {
		projectId: "project-1",
		userId: "user-1",
		organizationId: "org-1",
		aiToken: "token-1",
		documents,
	};
	const resumeOf = {
		runId: "task-1",
		pauseCount: 1,
		workflowIdBase: "wf-parent",
	};

	it("skips a document it no longer holds: no child, no evaluation, no COMPLETE and no result", async () => {
		generatingWrites(["doc-proposal"]);

		const output = await batchDocumentGenerationWorkflow(input);

		expect(childDocumentIds()).toEqual(["doc-business", "doc-prd"]);
		expect(evaluatedDocumentIds()).toEqual(["doc-business", "doc-prd"]);
		expect(statusesOf("doc-proposal")).toEqual(["GENERATING"]);
		// Neither this run's success nor its failure: the batch reports
		// only the documents it generated.
		expect(output.results.map((r) => r.documentId)).toEqual([
			"doc-business",
			"doc-prd",
		]);
		expect(output).toMatchObject({ success: true });
		expect(h.activities.updateAgentTaskStatus).toHaveBeenLastCalledWith(
			expect.objectContaining({
				status: "COMPLETED",
				result: expect.objectContaining({
					documentCount: 2,
					successCount: 2,
					failedCount: 0,
				}),
			}),
		);
	});

	it("takes today's sequence for a history recorded before the guard, whatever the write returned", async () => {
		recordedBeforeTheHeldGuard();
		generatingWrites(["doc-proposal"]);

		const output = await batchDocumentGenerationWorkflow(input);

		expect(childDocumentIds()).toEqual([
			"doc-business",
			"doc-proposal",
			"doc-prd",
		]);
		expect(statusesOf("doc-proposal")).toEqual(["GENERATING", "COMPLETE"]);
		expect(output.results).toContainEqual(
			expect.objectContaining({
				documentId: "doc-proposal",
				status: "success",
			}),
		);
	});

	it("carries on when the write returned no hold at all, as every earlier result did", async () => {
		h.activities.updateProjectDocumentStatus.mockResolvedValue(undefined);

		await batchDocumentGenerationWorkflow(input);

		expect(childDocumentIds()).toEqual([
			"doc-business",
			"doc-proposal",
			"doc-prd",
		]);
	});

	it("names the run holding the document: its kind and the very child it starts", async () => {
		await batchDocumentGenerationWorkflow(input);

		const generating = writeOf("doc-proposal", "GENERATING");
		expect(generating).toEqual({
			documentId: "doc-proposal",
			status: "GENERATING",
			progress: 0,
			heldBy: {
				kind: "DOCUMENT_BATCH",
				childWorkflowId: "wf-parent-child-doc-proposal",
			},
		});
		expect(childWorkflowIdOf("doc-proposal")).toBe(
			(generating?.heldBy as { childWorkflowId: string }).childWorkflowId,
		);
	});

	it("names the run it continues on a resume", async () => {
		h.workflowId = "wf-parent-resume-1";
		h.activities.claimBulkRunResumeActivity.mockResolvedValue({
			claimed: true,
			progress: { results: [] },
		});

		await batchDocumentGenerationWorkflow({
			...input,
			aiToken: "",
			documents: [documents[1]],
			resumeOf,
		});

		expect(writeOf("doc-proposal", "GENERATING")?.heldBy).toEqual({
			kind: "DOCUMENT_BATCH",
			childWorkflowId: "wf-parent-resume-1-child-doc-proposal",
			resumeOf,
		});
		expect(childWorkflowIdOf("doc-proposal")).toBe(
			"wf-parent-resume-1-child-doc-proposal",
		);
	});

	it("scopes the COMPLETE and FAILED writes to the attempt when the child hands back no token", async () => {
		children({
			"doc-proposal": childFailure(
				"agent unreachable",
				"DOCUMENT_GENERATION_CHILD_FAILED",
			),
		});

		await batchDocumentGenerationWorkflow(input);

		expect(writeOf("doc-prd", "COMPLETE")).toEqual({
			documentId: "doc-prd",
			status: "COMPLETE",
			progress: 100,
			generationStartedAt: "attempt-of-doc-prd",
		});
		expect(writeOf("doc-proposal", "FAILED")).toEqual({
			documentId: "doc-proposal",
			status: "FAILED",
			progress: 0,
			error: expect.any(String),
			generationStartedAt: "attempt-of-doc-proposal",
		});
	});

	it("keeps a coordinated Proposal's writes under its run token alone", async () => {
		children({
			"doc-proposal": childFailure(
				"agent unreachable",
				"DOCUMENT_GENERATION_CHILD_FAILED",
				{ liveRunId: "child-run-7" },
			),
			"doc-prd": { coordinatedRun: "child-run-8" },
		});

		await batchDocumentGenerationWorkflow(input);

		expect(writeOf("doc-proposal", "FAILED")).toEqual({
			documentId: "doc-proposal",
			status: "FAILED",
			progress: 0,
			error: expect.any(String),
			liveRunId: "child-run-7",
		});
		expect(writeOf("doc-prd", "COMPLETE")).toEqual({
			documentId: "doc-prd",
			status: "COMPLETE",
			progress: 100,
			liveRunId: "child-run-8",
		});
	});

	it("fails the documents still waiting at the pause cap only under the pause's hold", async () => {
		children({ "doc-proposal": childPaused() });
		h.activities.pauseBulkRunActivity.mockResolvedValue({
			paused: false,
			message: CAP_MESSAGE,
		});

		await batchDocumentGenerationWorkflow(input);

		for (const id of ["doc-proposal", "doc-prd"]) {
			expect(writeOf(id, "FAILED")).toEqual({
				documentId: id,
				status: "FAILED",
				progress: 0,
				error: CAP_MESSAGE,
				heldByPause: { kind: "DOCUMENT_BATCH" },
			});
		}
	});

	it("names the run a resume continues in the pause's hold at the cap", async () => {
		h.workflowId = "wf-parent-resume-1";
		h.activities.claimBulkRunResumeActivity.mockResolvedValue({
			claimed: true,
			progress: { results: [] },
		});
		children({ "doc-proposal": childPaused() });
		h.activities.pauseBulkRunActivity.mockResolvedValue({
			paused: false,
			message: CAP_MESSAGE,
		});

		// Nothing of the resume succeeded, so the batch ends failed.
		await expect(
			batchDocumentGenerationWorkflow({
				...input,
				aiToken: "",
				documents: documents.slice(1),
				resumeOf,
			}),
		).rejects.toThrow("All 2 documents failed to generate");

		expect(writeOf("doc-prd", "FAILED")?.heldByPause).toEqual({
			kind: "DOCUMENT_BATCH",
			resumeOf,
		});
	});
});

describe("existingProjectSetupWorkflow — documents the setup no longer holds", () => {
	const DOCUMENTS = [
		{ id: "doc-prd", type: "PRD" },
		{ id: "doc-proposal", type: "PROPOSAL" },
		{ id: "doc-architecture", type: "ARCHITECTURE" },
	];
	const input = {
		projectId: "project-1",
		userId: "user-1",
		organizationId: "org-1",
		aiToken: "token-1",
		// No repositories and no PM tool: straight to the documents.
		repoUrls: [] as string[],
		selectedDocumentTypes: ["PRD", "PROPOSAL", "ARCHITECTURE"],
		projectTypes: [],
		projectName: "Example project",
	};
	const resumeOf = {
		runId: "task-1",
		pauseCount: 1,
		workflowIdBase: "wf-parent",
	};

	beforeEach(() => {
		h.activities.createExistingProjectDocumentRecords.mockResolvedValue({
			documents: DOCUMENTS,
		});
	});

	/** A resume of the paused setup, with the documents it had created. */
	function resumed(progress: Record<string, unknown> = {}) {
		h.workflowId = "wf-parent-resume-1";
		h.activities.claimBulkRunResumeActivity.mockResolvedValue({
			claimed: true,
			progress: {
				analysisDone: true,
				backlogDone: true,
				documents: DOCUMENTS,
				documentIds: [],
				finishedDocumentIds: [],
				...progress,
			},
		});
		return { ...input, aiToken: "", resumeOf };
	}

	it("skips a document it no longer holds: no child, no evaluation, no COMPLETE, and not generated", async () => {
		generatingWrites(["doc-proposal"]);

		const output = await existingProjectSetupWorkflow(input);

		expect(childDocumentIds()).toEqual(["doc-prd", "doc-architecture"]);
		expect(evaluatedDocumentIds()).toEqual(["doc-prd", "doc-architecture"]);
		expect(statusesOf("doc-proposal")).toEqual(["GENERATING"]);
		expect(output).toMatchObject({
			success: true,
			documentIds: ["doc-prd", "doc-architecture"],
		});
	});

	it("counts the skipped document finished, so a pause queues it for no resume", async () => {
		generatingWrites(["doc-proposal"]);
		children({ "doc-architecture": childPaused() });

		await existingProjectSetupWorkflow(input);

		expect(h.activities.pauseBulkRunActivity).toHaveBeenCalledTimes(1);
		expect(
			h.activities.pauseBulkRunActivity.mock.calls[0][0],
		).toMatchObject({
			queuedDocumentIds: ["doc-architecture"],
			progress: {
				documentIds: ["doc-prd"],
				finishedDocumentIds: ["doc-prd", "doc-proposal"],
				// The resume's verdict needs to know it was not a failure.
				skippedDocumentIds: ["doc-proposal"],
			},
		});
	});

	it("saves today's progress on a pause when it skipped nothing", async () => {
		children({ "doc-proposal": childPaused() });

		await existingProjectSetupWorkflow(input);

		const { progress } = h.activities.pauseBulkRunActivity.mock
			.calls[0][0] as { progress: Record<string, unknown> };
		expect(progress).not.toHaveProperty("skippedDocumentIds");
	});

	/** The statuses the setup closed the project's analysis and its run with. */
	function verdicts(): { analysis: string[]; run: string[] } {
		return {
			analysis:
				h.activities.updateProjectCodeAnalysisStatus.mock.calls.map(
					([write]) => (write as { status: string }).status,
				),
			run: h.activities.updateAgentTaskStatus.mock.calls.map(
				([write]) => (write as { status: string }).status,
			),
		};
	}

	it("completes, not fails, when it skipped every document: nothing failed", async () => {
		generatingWrites(DOCUMENTS.map((doc) => doc.id));

		const output = await existingProjectSetupWorkflow(input);

		expect(h.executeChild).not.toHaveBeenCalled();
		expect(verdicts()).toEqual({
			analysis: ["SCANNING", "COMPLETED"],
			run: ["RUNNING", "COMPLETED"],
		});
		expect(output).toMatchObject({ success: true, documentIds: [] });
	});

	it("still fails when the documents it did not skip all failed", async () => {
		generatingWrites(["doc-proposal"]);
		children({
			"doc-prd": childFailure(
				"agent unreachable",
				"DOCUMENT_GENERATION_CHILD_FAILED",
			),
			"doc-architecture": childFailure(
				"agent unreachable",
				"DOCUMENT_GENERATION_CHILD_FAILED",
			),
		});

		const output = await existingProjectSetupWorkflow(input);

		expect(verdicts()).toEqual({
			analysis: ["SCANNING", "FAILED"],
			run: ["RUNNING", "FAILED"],
		});
		expect(output).toMatchObject({ success: false, documentIds: [] });
	});

	it("completes a resume when the paused run and the resume skipped every document between them", async () => {
		generatingWrites(["doc-architecture"]);

		const output = await existingProjectSetupWorkflow(
			resumed({
				finishedDocumentIds: ["doc-prd", "doc-proposal"],
				skippedDocumentIds: ["doc-prd", "doc-proposal"],
			}),
		);

		expect(h.executeChild).not.toHaveBeenCalled();
		expect(verdicts().analysis).toEqual(["COMPLETED"]);
		expect(output).toMatchObject({ success: true, documentIds: [] });
	});

	it("keeps today's verdict for a history recorded before the guard", async () => {
		recordedBeforeTheHeldGuard();
		generatingWrites(DOCUMENTS.map((doc) => doc.id));
		children(
			Object.fromEntries(
				DOCUMENTS.map((doc) => [
					doc.id,
					childFailure(
						"agent unreachable",
						"DOCUMENT_GENERATION_CHILD_FAILED",
					),
				]),
			),
		);

		const output = await existingProjectSetupWorkflow(input);

		// Nothing was skipped, every child ran and failed: today's FAILED.
		expect(childDocumentIds()).toHaveLength(3);
		expect(verdicts()).toEqual({
			analysis: ["SCANNING", "FAILED"],
			run: ["RUNNING", "FAILED"],
		});
		expect(output).toMatchObject({ success: false, documentIds: [] });
	});

	it("takes today's sequence for a history recorded before the guard, whatever the write returned", async () => {
		recordedBeforeTheHeldGuard();
		generatingWrites(["doc-proposal"]);

		const output = await existingProjectSetupWorkflow(input);

		expect(childDocumentIds()).toEqual([
			"doc-prd",
			"doc-proposal",
			"doc-architecture",
		]);
		expect(statusesOf("doc-proposal")).toEqual(["GENERATING", "COMPLETE"]);
		expect(output.documentIds).toEqual([
			"doc-prd",
			"doc-proposal",
			"doc-architecture",
		]);
	});

	it("names the run holding the document: its kind and the very child it starts", async () => {
		await existingProjectSetupWorkflow(input);

		const generating = writeOf("doc-proposal", "GENERATING");
		expect(generating).toEqual({
			documentId: "doc-proposal",
			status: "GENERATING",
			progress: 5,
			startsAttempt: true,
			heldBy: {
				kind: "PROJECT_SETUP",
				childWorkflowId: "wf-parent-doc-doc-proposal",
			},
		});
		expect(childWorkflowIdOf("doc-proposal")).toBe(
			(generating?.heldBy as { childWorkflowId: string }).childWorkflowId,
		);
	});

	it("names the run it continues on a resume", async () => {
		await existingProjectSetupWorkflow(resumed());

		expect(writeOf("doc-proposal", "GENERATING")?.heldBy).toEqual({
			kind: "PROJECT_SETUP",
			childWorkflowId: "wf-parent-resume-1-doc-doc-proposal",
			resumeOf,
		});
		expect(childWorkflowIdOf("doc-proposal")).toBe(
			"wf-parent-resume-1-doc-doc-proposal",
		);
	});

	it("scopes the COMPLETE and FAILED writes to the attempt when the child hands back no token", async () => {
		children({
			"doc-proposal": childFailure(
				"agent unreachable",
				"DOCUMENT_GENERATION_CHILD_FAILED",
			),
		});

		await existingProjectSetupWorkflow(input);

		expect(writeOf("doc-prd", "COMPLETE")).toEqual({
			documentId: "doc-prd",
			status: "COMPLETE",
			progress: 100,
			generationStartedAt: "attempt-of-doc-prd",
		});
		expect(writeOf("doc-proposal", "FAILED")).toEqual({
			documentId: "doc-proposal",
			status: "FAILED",
			progress: 0,
			error: expect.any(String),
			generationStartedAt: "attempt-of-doc-proposal",
		});
	});

	it("keeps a coordinated Proposal's writes under its run token alone", async () => {
		children({
			"doc-proposal": childFailure(
				"agent unreachable",
				"DOCUMENT_GENERATION_CHILD_FAILED",
				{ liveRunId: "child-run-7" },
			),
			"doc-prd": { coordinatedRun: "child-run-8" },
		});

		await existingProjectSetupWorkflow(input);

		expect(writeOf("doc-proposal", "FAILED")).toEqual({
			documentId: "doc-proposal",
			status: "FAILED",
			progress: 0,
			error: expect.any(String),
			liveRunId: "child-run-7",
		});
		expect(writeOf("doc-prd", "COMPLETE")).toEqual({
			documentId: "doc-prd",
			status: "COMPLETE",
			progress: 100,
			liveRunId: "child-run-8",
		});
	});

	it("names the run a resume continues in the pause's hold at the cap", async () => {
		children({ "doc-proposal": childPaused() });
		h.activities.pauseBulkRunActivity.mockResolvedValue({
			paused: false,
			message: CAP_MESSAGE,
		});

		await existingProjectSetupWorkflow(resumed());

		for (const id of ["doc-proposal", "doc-architecture"]) {
			expect(writeOf(id, "FAILED")).toEqual({
				documentId: id,
				status: "FAILED",
				progress: 0,
				error: CAP_MESSAGE,
				heldByPause: { kind: "PROJECT_SETUP", resumeOf },
			});
		}
	});
});
