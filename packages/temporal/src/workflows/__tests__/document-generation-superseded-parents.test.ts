/**
 * The batch and existing-project-setup parents leave a superseded child's
 * document alone (Fizzy #2801).
 *
 * A coordinated Proposal run that a newer generation superseded ends its
 * child with `DOCUMENT_GENERATION_SUPERSEDED`; its own writes were guarded on
 * its run token and wrote nothing. These parents write the document's FAILED
 * status with no guard at all, so they must skip that write for this one
 * type, or they stamp FAILED onto the newer run's document. Every other child
 * failure keeps today's FAILED write. Replay safety is pinned separately, on
 * real bundles, in `document-generation-superseded-parents-replay.test.ts`.
 *
 * Harness convention (see `supplied-context-wiring.test.ts`): mock the
 * activity surface and drive the workflow body as a plain async function.
 */

import {
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
		"updateProjectDocumentStatus",
		"updateProjectCodeAnalysisStatus",
		"updateProjectRagSettings",
		"createExistingProjectDocumentRecords",
	] as const;
	return {
		activities: Object.fromEntries(
			names.map((name) => [name, vi.fn()]),
		) as Record<(typeof names)[number], ReturnType<typeof vi.fn>>,
		executeChild: vi.fn(),
		startChild: vi.fn(),
	};
});

vi.mock("@temporalio/workflow", async (importOriginal) => ({
	...(await importOriginal<typeof import("@temporalio/workflow")>()),
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	patched: () => true,
	proxyActivities: () => h.activities,
	executeChild: h.executeChild,
	startChild: h.startChild,
	workflowInfo: () => ({ workflowId: "wf-parent", runId: "run-parent" }),
}));

import { batchDocumentGenerationWorkflow } from "../batch-document-generation";
import { existingProjectSetupWorkflow } from "../existing-project-setup";

const SUPERSEDED_MESSAGE =
	"A newer generation of this document started, so this one stopped without changing it.";

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

/** The input the parent started `documentId`'s child with. */
function childInputOf(documentId: string): Record<string, unknown> | undefined {
	return h.executeChild.mock.calls
		.map(
			([, options]) =>
				(options as { args: [Record<string, unknown>] }).args[0],
		)
		.find((input) => input.documentId === documentId);
}

/** Each GENERATING write starts an attempt; this is what the activity returns. */
function attemptsStartAt(stamp: (documentId: string) => string) {
	h.activities.updateProjectDocumentStatus.mockImplementation(
		async (input: { documentId: string; status: string }) =>
			input.status === "GENERATING"
				? { generationStartedAt: stamp(input.documentId) }
				: undefined,
	);
}

/** The parent's FAILED write for `documentId`. */
function failedWriteOf(documentId: string): unknown {
	return h.activities.updateProjectDocumentStatus.mock.calls
		.map(([input]) => input as { documentId: string; status: string })
		.find(
			(input) =>
				input.documentId === documentId && input.status === "FAILED",
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

/** The child's outcome per document id. */
function children(
	outcomes: Record<
		string,
		ChildWorkflowFailure | "success" | { coordinatedRun: string }
	>,
) {
	h.executeChild.mockImplementation(
		async (
			_workflow: unknown,
			options: { args: [{ documentId: string }] },
		) => {
			const outcome = outcomes[options.args[0].documentId];
			if (outcome === undefined || outcome === "success") {
				return CHILD_SUCCESS;
			}
			if ("coordinatedRun" in outcome) {
				return { ...CHILD_SUCCESS, liveRunId: outcome.coordinatedRun };
			}
			throw outcome;
		},
	);
}

/** The parent's COMPLETE write for `documentId`. */
function completeWriteOf(documentId: string): unknown {
	return h.activities.updateProjectDocumentStatus.mock.calls
		.map(([input]) => input as { documentId: string; status: string })
		.find(
			(input) =>
				input.documentId === documentId && input.status === "COMPLETE",
		);
}

/** Every status the parent wrote for `documentId`, in order. */
function statusesOf(documentId: string): string[] {
	return h.activities.updateProjectDocumentStatus.mock.calls
		.map(([input]) => input as { documentId: string; status: string })
		.filter((input) => input.documentId === documentId)
		.map((input) => input.status);
}

beforeEach(() => {
	vi.clearAllMocks();
	for (const fn of Object.values(h.activities)) {
		fn.mockReset();
		fn.mockResolvedValue(undefined);
	}
	h.activities.createAgentTask.mockResolvedValue({ id: "task-1" });
	h.startChild.mockResolvedValue({});
});

describe("batchDocumentGenerationWorkflow", () => {
	const input = {
		projectId: "project-1",
		userId: "user-1",
		organizationId: "org-1",
		aiToken: "token-1",
		documents: [
			{
				id: "doc-proposal",
				type: "PROPOSAL",
				title: "Proposal",
				prompt: "",
			},
			{ id: "doc-prd", type: "PRD", title: "PRD", prompt: "" },
		],
	};

	it("writes nothing to a document whose child a newer generation superseded", async () => {
		children({
			"doc-proposal": childFailure(
				SUPERSEDED_MESSAGE,
				"DOCUMENT_GENERATION_SUPERSEDED",
			),
		});

		const result = await batchDocumentGenerationWorkflow(input);

		// The GENERATING mark before the child is today's; the FAILED write
		// after it is what would land on the newer run.
		expect(statusesOf("doc-proposal")).toEqual(["GENERATING"]);
		expect(statusesOf("doc-prd")).toEqual(["GENERATING", "COMPLETE"]);
		expect(result.results).toContainEqual({
			documentId: "doc-proposal",
			status: "failed",
			error: expect.any(String),
		});
	});

	it("still marks a document FAILED when its child failed for any other reason", async () => {
		children({
			"doc-proposal": childFailure(
				"agent unreachable",
				"DOCUMENT_GENERATION_CHILD_FAILED",
			),
		});

		await batchDocumentGenerationWorkflow(input);

		expect(statusesOf("doc-proposal")).toEqual(["GENERATING", "FAILED"]);
		// No token in the failure: today's unguarded write.
		expect(failedWriteOf("doc-proposal")).toEqual({
			documentId: "doc-proposal",
			status: "FAILED",
			progress: 0,
			error: expect.any(String),
		});
	});

	it("marks a coordinated Proposal FAILED only under the run token its failure carries", async () => {
		children({
			"doc-proposal": childFailure(
				"agent unreachable",
				"DOCUMENT_GENERATION_CHILD_FAILED",
				{ liveRunId: "child-run-7" },
			),
		});

		await batchDocumentGenerationWorkflow(input);

		// A newer generation that took the document over keeps its status.
		expect(failedWriteOf("doc-proposal")).toEqual({
			documentId: "doc-proposal",
			status: "FAILED",
			progress: 0,
			error: expect.any(String),
			liveRunId: "child-run-7",
		});
	});

	it("still marks a document FAILED when its child failed with the stale type a legacy run uses", async () => {
		// A slot-baseline refusal outside a coordinated run keeps today's
		// type, and so today's handling.
		children({
			"doc-proposal": childFailure(
				"This document changed while it was being regenerated.",
				"DOCUMENT_GENERATION_STALE",
			),
		});

		await batchDocumentGenerationWorkflow(input);

		expect(statusesOf("doc-proposal")).toEqual(["GENERATING", "FAILED"]);
	});

	it("scopes each child's plan to the attempt its GENERATING write started", async () => {
		attemptsStartAt((documentId) =>
			documentId === "doc-proposal"
				? "2026-10-08T09:00:00.000Z"
				: "2026-10-08T09:05:00.000Z",
		);
		children({});

		await batchDocumentGenerationWorkflow(input);

		expect(childInputOf("doc-proposal")).toMatchObject({
			generationStartedAt: "2026-10-08T09:00:00.000Z",
		});
		expect(childInputOf("doc-prd")).toMatchObject({
			generationStartedAt: "2026-10-08T09:05:00.000Z",
		});
	});

	it("gives the child today's input when the GENERATING write returned no identity", async () => {
		children({});

		await batchDocumentGenerationWorkflow(input);

		expect(childInputOf("doc-proposal")).not.toHaveProperty(
			"generationStartedAt",
		);
	});

	it("marks a coordinated Proposal COMPLETE only under its child's run token", async () => {
		children({ "doc-proposal": { coordinatedRun: "child-run-7" } });

		await batchDocumentGenerationWorkflow(input);

		// Guarded: a newer generation that took the document over since the
		// child saved keeps its status and its live preview.
		expect(completeWriteOf("doc-proposal")).toEqual({
			documentId: "doc-proposal",
			status: "COMPLETE",
			progress: 100,
			liveRunId: "child-run-7",
		});
		// Any other child hands back no token: today's write.
		expect(completeWriteOf("doc-prd")).toEqual({
			documentId: "doc-prd",
			status: "COMPLETE",
			progress: 100,
		});
	});
});

describe("existingProjectSetupWorkflow", () => {
	const input = {
		projectId: "project-1",
		userId: "user-1",
		organizationId: "org-1",
		aiToken: "token-1",
		// No repositories and no PM tool: straight to the documents.
		repoUrls: [],
		selectedDocumentTypes: ["PRD", "PROPOSAL"],
		projectTypes: [],
		projectName: "Example project",
	};

	beforeEach(() => {
		h.activities.createExistingProjectDocumentRecords.mockResolvedValue({
			documents: [
				{ id: "doc-prd", type: "PRD" },
				{ id: "doc-proposal", type: "PROPOSAL" },
			],
		});
	});

	it("writes nothing to a document whose child a newer generation superseded", async () => {
		children({
			"doc-proposal": childFailure(
				SUPERSEDED_MESSAGE,
				"DOCUMENT_GENERATION_SUPERSEDED",
			),
		});

		const result = await existingProjectSetupWorkflow(input);

		expect(statusesOf("doc-proposal")).toEqual(["GENERATING"]);
		expect(statusesOf("doc-prd")).toEqual(["GENERATING", "COMPLETE"]);
		expect(result.documentIds).toEqual(["doc-prd"]);
	});

	it("still marks a document FAILED when its child failed for any other reason", async () => {
		children({
			"doc-proposal": childFailure(
				"agent unreachable",
				"DOCUMENT_GENERATION_CHILD_FAILED",
			),
		});

		await existingProjectSetupWorkflow(input);

		expect(statusesOf("doc-proposal")).toEqual(["GENERATING", "FAILED"]);
		expect(failedWriteOf("doc-proposal")).not.toHaveProperty("liveRunId");
	});

	it("marks a coordinated Proposal FAILED only under the run token its failure carries", async () => {
		children({
			"doc-proposal": childFailure(
				"agent unreachable",
				"DOCUMENT_GENERATION_CHILD_FAILED",
				{ liveRunId: "child-run-7" },
			),
		});

		await existingProjectSetupWorkflow(input);

		expect(failedWriteOf("doc-proposal")).toMatchObject({
			status: "FAILED",
			liveRunId: "child-run-7",
		});
	});

	it("starts each document's attempt and scopes its child's plan to it", async () => {
		attemptsStartAt(() => "2026-10-08T09:10:00.000Z");
		children({});

		await existingProjectSetupWorkflow(input);

		expect(h.activities.updateProjectDocumentStatus).toHaveBeenCalledWith({
			documentId: "doc-proposal",
			status: "GENERATING",
			progress: 5,
			startsAttempt: true,
		});
		expect(childInputOf("doc-proposal")).toMatchObject({
			generationStartedAt: "2026-10-08T09:10:00.000Z",
		});
	});

	it("marks a coordinated Proposal COMPLETE only under its child's run token", async () => {
		children({ "doc-proposal": { coordinatedRun: "child-run-7" } });

		await existingProjectSetupWorkflow(input);

		expect(completeWriteOf("doc-proposal")).toEqual({
			documentId: "doc-proposal",
			status: "COMPLETE",
			progress: 100,
			liveRunId: "child-run-7",
		});
		expect(completeWriteOf("doc-prd")).toEqual({
			documentId: "doc-prd",
			status: "COMPLETE",
			progress: 100,
		});
	});
});
