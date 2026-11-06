/**
 * The document branch of the context-processing workflow.
 *
 * Three behaviours the Documents-tab create flow depends on, all reached only
 * when the upload carries the metadata that flow writes. The fourth assertion in
 * each case is the same one: an upload without that metadata — the Context tab,
 * project onboarding — must behave exactly as it always has, since that is what
 * lets this ship without a version gate.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const stubs = vi.hoisted(() => ({
	updateProjectContextStatus: vi.fn(),
	getProjectContextStatus: vi.fn(),
	processProjectContext: vi.fn(),
	retryProjectContext: vi.fn(),
	cleanupImportedContent: vi.fn(),
	createImportedDocument: vi.fn(),
	failContextTargetDocument: vi.fn(),
	failTargetDocument: vi.fn(),
	fillTargetDocument: vi.fn(),
	embedProjectDocumentActivity: vi.fn(),
	issueGenerationToken: vi.fn(),
}));

const executeChildMock = vi.hoisted(() => vi.fn());
const patchedMock = vi.hoisted(() => vi.fn());

vi.mock("@temporalio/workflow", () => {
	// A class, not a plain object: the workflow's outer catch tells its own
	// failure apart with `instanceof`, which a failure-path test reaches.
	class ApplicationFailure extends Error {
		static nonRetryable(message: string) {
			return new ApplicationFailure(message);
		}
	}
	return {
		log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		proxyActivities: vi.fn(() => stubs),
		executeChild: executeChildMock,
		patched: patchedMock,
		ApplicationFailure,
	};
});

import { projectContextProcessingWorkflow } from "../src/workflows/project-context-processing";

const input = {
	contextId: "ctx-1",
	projectId: "proj-1",
	userId: "user-1",
	organizationId: "org-1",
};

const extraction = (over: Record<string, unknown> = {}) => ({
	success: true,
	chunkCount: 1,
	extractorUsed: "local",
	qdrantIds: ["q-1"],
	documentTag: "PRD",
	documentTitle: "Spec",
	extractedContent: "the extracted text",
	...over,
});

beforeEach(() => {
	for (const stub of Object.values(stubs)) {
		stub.mockReset();
	}
	stubs.updateProjectContextStatus.mockResolvedValue(undefined);
	stubs.getProjectContextStatus.mockResolvedValue("FAILED");
	stubs.cleanupImportedContent.mockResolvedValue("# Formatted\n\ntext");
	stubs.createImportedDocument.mockResolvedValue({ documentId: "doc-new" });
	stubs.fillTargetDocument.mockResolvedValue({ applied: true });
	stubs.failTargetDocument.mockResolvedValue({ applied: true });
	stubs.failContextTargetDocument.mockResolvedValue({ applied: true });
	stubs.embedProjectDocumentActivity.mockResolvedValue(undefined);
	stubs.issueGenerationToken.mockResolvedValue({ aiToken: "tok" });
	executeChildMock.mockReset();
	executeChildMock.mockResolvedValue(undefined);
	patchedMock.mockReset();
	patchedMock.mockReturnValue(true);
});

/** Every activity the run called, in the order it called them. */
const activityCalls = () =>
	Object.entries(stubs)
		.flatMap(([name, stub]) =>
			stub.mock.invocationCallOrder.map((order) => ({ name, order })),
		)
		.sort((a, b) => a.order - b.order)
		.map(({ name }) => name);

describe("Use As-Is skips the AI formatting pass", () => {
	it("does not rewrite the extracted text", async () => {
		stubs.processProjectContext.mockResolvedValue(
			extraction({ documentUsage: "AS_IS", targetDocumentId: "doc-1" }),
		);

		await projectContextProcessingWorkflow(input);

		expect(stubs.cleanupImportedContent).not.toHaveBeenCalled();
		expect(stubs.fillTargetDocument).toHaveBeenCalledWith(
			expect.objectContaining({ content: "the extracted text" }),
		);
	});

	/**
	 * The gate is the usage flag, not the tag. An ordinary tagged import still
	 * gets its markdown structure — dropping that would degrade every PDF and
	 * DOCX brought in through onboarding, which this change has no business
	 * touching.
	 */
	it("still formats an upload that carries no usage", async () => {
		stubs.processProjectContext.mockResolvedValue(extraction());

		await projectContextProcessingWorkflow(input);

		expect(stubs.cleanupImportedContent).toHaveBeenCalled();
		expect(stubs.createImportedDocument).toHaveBeenCalledWith(
			expect.objectContaining({ content: "# Formatted\n\ntext" }),
		);
	});
});

describe("a pre-created document is filled, not duplicated", () => {
	it("fills the target row and creates nothing", async () => {
		stubs.processProjectContext.mockResolvedValue(
			extraction({ documentUsage: "AS_IS", targetDocumentId: "doc-1" }),
		);

		await projectContextProcessingWorkflow(input);

		expect(stubs.fillTargetDocument).toHaveBeenCalledWith(
			expect.objectContaining({
				documentId: "doc-1",
				contextId: "ctx-1",
			}),
		);
		expect(stubs.createImportedDocument).not.toHaveBeenCalled();
	});

	it("creates a row when no target was supplied", async () => {
		stubs.processProjectContext.mockResolvedValue(extraction());

		await projectContextProcessingWorkflow(input);

		expect(stubs.createImportedDocument).toHaveBeenCalled();
		expect(stubs.fillTargetDocument).not.toHaveBeenCalled();
	});

	/**
	 * A row that left GENERATING while extraction ran has something newer in it
	 * than this late write would produce — a hand edit, or another attempt that
	 * finished first. It stands, and the workflow stops short of embedding, so
	 * the corpus does not get content the document no longer holds.
	 */
	it("leaves a row that is no longer generating alone", async () => {
		stubs.processProjectContext.mockResolvedValue(
			extraction({ documentUsage: "AS_IS", targetDocumentId: "doc-1" }),
		);
		stubs.fillTargetDocument.mockResolvedValue({ applied: false });

		const out = await projectContextProcessingWorkflow(input);

		expect(out.success).toBe(true);
		expect(stubs.embedProjectDocumentActivity).not.toHaveBeenCalled();
	});
});

describe("an unreadable file says so on the document", () => {
	it("fails the target row when extraction produced nothing", async () => {
		stubs.processProjectContext.mockResolvedValue(
			extraction({
				documentUsage: "AS_IS",
				targetDocumentId: "doc-1",
				extractedContent: "   ",
			}),
		);

		await projectContextProcessingWorkflow(input);

		expect(stubs.failTargetDocument).toHaveBeenCalledWith(
			expect.objectContaining({
				documentId: "doc-1",
				reason: expect.stringMatching(/could not be read/i),
			}),
		);
		expect(stubs.fillTargetDocument).not.toHaveBeenCalled();
	});

	/**
	 * Without a pre-created row there is nothing to fail — the old silent
	 * outcome, preserved deliberately for the paths that never had a row.
	 */
	it("has nothing to fail when no row was pre-created", async () => {
		stubs.processProjectContext.mockResolvedValue(
			extraction({ extractedContent: "" }),
		);
		stubs.cleanupImportedContent.mockResolvedValue("");

		const out = await projectContextProcessingWorkflow(input);

		expect(out.success).toBe(true);
		expect(stubs.failTargetDocument).not.toHaveBeenCalled();
		expect(stubs.createImportedDocument).not.toHaveBeenCalled();
	});
});

/**
 * Unreachable for new uploads — the upload procedure refuses that mode — but
 * still exercised, for the two cases that keep it in the workflow: a recorded
 * history replaying through it, and a context row written before that refusal
 * shipped. Deleting the branch instead was a nondeterminism error, caught by
 * replay validation against exactly those histories.
 */
describe("Use as Context, still reachable only by rows written before the refusal", () => {
	/**
	 * The promise the whole feature rests on: supplied source reaches the model
	 * directly rather than through similarity search. A file cannot keep that
	 * promise at submit time — its text does not exist yet — so the run waits
	 * for extraction and starts here.
	 */
	it("dispatches generation with the extracted text as supplied context", async () => {
		stubs.processProjectContext.mockResolvedValue(
			extraction({ documentUsage: "CONTEXT", targetDocumentId: "doc-1" }),
		);

		await projectContextProcessingWorkflow(input);

		expect(executeChildMock).toHaveBeenCalledWith(
			"projectDocumentGenerationWorkflow",
			expect.objectContaining({
				args: [
					expect.objectContaining({
						documentId: "doc-1",
						suppliedContext: "# Formatted\n\ntext",
						// `excludeContextId` is the field the child declares.
						// This assertion previously named `suppliedContextId`,
						// which the input has never had — written from the same
						// reading as the call site it was checking, so it
						// certified the misspelling instead of catching it.
						excludeContextId: "ctx-1",
						aiToken: "tok",
					}),
				],
			}),
		);
	});

	it("writes nothing into the document itself", async () => {
		stubs.processProjectContext.mockResolvedValue(
			extraction({ documentUsage: "CONTEXT", targetDocumentId: "doc-1" }),
		);

		await projectContextProcessingWorkflow(input);

		expect(stubs.fillTargetDocument).not.toHaveBeenCalled();
		expect(stubs.createImportedDocument).not.toHaveBeenCalled();
	});

	it("fails the document instead of generating from an unreadable file", async () => {
		stubs.processProjectContext.mockResolvedValue(
			extraction({
				documentUsage: "CONTEXT",
				targetDocumentId: "doc-1",
				extractedContent: "",
			}),
		);
		stubs.cleanupImportedContent.mockResolvedValue("");

		await projectContextProcessingWorkflow(input);

		expect(executeChildMock).not.toHaveBeenCalled();
		expect(stubs.failTargetDocument).toHaveBeenCalled();
	});

	/**
	 * The queue the API dispatches generation on, named rather than inherited.
	 * A child takes its parent's queue by default, which would put a long model
	 * run on the queue sized for RAG extraction — competing for slots with the
	 * very work that feeds it.
	 */
	it("runs the child on the generation queue, not the extraction one", async () => {
		stubs.processProjectContext.mockResolvedValue(
			extraction({ documentUsage: "CONTEXT", targetDocumentId: "doc-1" }),
		);

		await projectContextProcessingWorkflow(input);

		expect(executeChildMock).toHaveBeenCalledWith(
			"projectDocumentGenerationWorkflow",
			expect.objectContaining({ taskQueue: "project-documents" }),
		);
	});

	/**
	 * The surrounding branch treats failures as best-effort and swallows them.
	 * Right for an import nobody is waiting on; wrong here, where the document
	 * already exists and the user is looking at it. A swallowed failure left it
	 * generating with no error and no end, until the stale sweep cleared it half
	 * an hour later.
	 */
	it("fails the document when the generation run does not finish", async () => {
		stubs.processProjectContext.mockResolvedValue(
			extraction({ documentUsage: "CONTEXT", targetDocumentId: "doc-1" }),
		);
		executeChildMock.mockRejectedValue(new Error("child died"));

		const out = await projectContextProcessingWorkflow(input);

		expect(stubs.failTargetDocument).toHaveBeenCalledWith(
			expect.objectContaining({
				documentId: "doc-1",
				reason: expect.stringMatching(/did not finish/i),
			}),
		);
		expect(out.success).toBe(true);
	});

	it("starts no run for an upload that carries no usage", async () => {
		stubs.processProjectContext.mockResolvedValue(extraction());

		await projectContextProcessingWorkflow(input);

		expect(executeChildMock).not.toHaveBeenCalled();
	});
});

/**
 * A corrupt or empty file fails its context row. The document the create flow
 * made for it has to fail too, with a reason, or it sits on "generating"
 * until the stale-generation sweep clears it half an hour later.
 */
describe("a file that yields no text fails its document, not only its context row", () => {
	const failures = [
		{
			label: "extraction throws on its last attempt",
			arrange: () =>
				stubs.processProjectContext.mockRejectedValue(
					new Error("Activity task failed"),
				),
			error: "Activity task failed",
			// A throw cannot be told apart from an outage that outlasted the
			// retries, so the reason does not blame the file outright.
			reason: /could not be read\. Try creating the document again, and use a different file if this happens again/,
		},
		{
			label: "extraction returns a failure",
			arrange: () =>
				stubs.processProjectContext.mockResolvedValue({
					success: false,
					chunkCount: 0,
					qdrantIds: [],
					error: "No readable text could be extracted from this file.",
				}),
			error: "No readable text could be extracted from this file.",
			reason: /could not be read, or contained no text/,
		},
	];

	it.each(failures)(
		"fails the document once, after the context row, when $label",
		async ({ arrange, error, reason }) => {
			arrange();

			await expect(
				projectContextProcessingWorkflow(input),
			).rejects.toThrow(error);

			expect(stubs.failContextTargetDocument).toHaveBeenCalledTimes(1);
			expect(stubs.failContextTargetDocument).toHaveBeenCalledWith({
				contextId: "ctx-1",
				projectId: "proj-1",
				userId: "user-1",
				organizationId: "org-1",
				reason: expect.stringMatching(reason),
			});
			expect(activityCalls()).toEqual([
				"processProjectContext",
				"getProjectContextStatus",
				"updateProjectContextStatus",
				"failContextTargetDocument",
			]);
		},
	);

	/**
	 * The text was stored before a later step threw: the context row stays
	 * COMPLETED, and the document must not be told its file was unreadable.
	 */
	it("says the file was read when the context row kept its stored text", async () => {
		stubs.processProjectContext.mockRejectedValue(
			new Error("Activity task failed"),
		);
		stubs.getProjectContextStatus.mockResolvedValue("COMPLETED");

		await expect(projectContextProcessingWorkflow(input)).rejects.toThrow(
			"Activity task failed",
		);

		expect(stubs.failContextTargetDocument).toHaveBeenCalledTimes(1);
		expect(stubs.failContextTargetDocument).toHaveBeenCalledWith({
			contextId: "ctx-1",
			projectId: "proj-1",
			userId: "user-1",
			organizationId: "org-1",
			reason: expect.stringMatching(/was read, but .* did not finish/i),
		});
		expect(activityCalls()).toEqual([
			"processProjectContext",
			"getProjectContextStatus",
			"failContextTargetDocument",
		]);
	});

	/**
	 * A history recorded before this call existed has no marker, so `patched()`
	 * answers false on replay. Its failure must issue exactly the commands it
	 * always did, or replay fails with a nondeterminism error.
	 */
	it.each(failures)(
		"issues the old command sequence for a recorded history when $label",
		async ({ arrange, error }) => {
			arrange();
			patchedMock.mockReturnValue(false);

			await expect(
				projectContextProcessingWorkflow(input),
			).rejects.toThrow(error);

			expect(activityCalls()).toEqual([
				"processProjectContext",
				"getProjectContextStatus",
				"updateProjectContextStatus",
			]);
		},
	);

	it.each(failures)(
		"still fails with its own error when failing the document fails, when $label",
		async ({ arrange, error }) => {
			arrange();
			stubs.failContextTargetDocument.mockRejectedValue(
				new Error("database unavailable"),
			);

			const failure = await projectContextProcessingWorkflow(input).then(
				() => undefined,
				(caught: unknown) => caught,
			);

			expect(failure).toBeInstanceOf(Error);
			expect((failure as Error).message).toBe(error);
			expect(stubs.failContextTargetDocument).toHaveBeenCalledTimes(1);
		},
	);

	/** A company source has no document, and its run records no marker. */
	it.each(failures)(
		"leaves a company source alone when $label",
		async ({ arrange, error }) => {
			arrange();

			await expect(
				projectContextProcessingWorkflow({
					contextId: "src-1",
					userId: "user-1",
					organizationId: "org-1",
					owner: { kind: "company", organizationId: "org-1" },
				}),
			).rejects.toThrow(error);

			expect(stubs.failContextTargetDocument).not.toHaveBeenCalled();
			expect(patchedMock).not.toHaveBeenCalled();
		},
	);

	/**
	 * Retries happen inside the activity call, so an attempt that a later one
	 * recovers from reaches the workflow as a success, and the document is
	 * filled rather than failed.
	 */
	it("leaves the document to be filled when extraction succeeds", async () => {
		stubs.processProjectContext.mockResolvedValue(
			extraction({ documentUsage: "AS_IS", targetDocumentId: "doc-1" }),
		);

		await projectContextProcessingWorkflow(input);

		expect(stubs.fillTargetDocument).toHaveBeenCalled();
		expect(stubs.failContextTargetDocument).not.toHaveBeenCalled();
		expect(patchedMock).not.toHaveBeenCalled();
	});
});

/**
 * The import branch swallows its failures, which is right for an import nobody
 * is waiting on. A pre-created document is being watched, so a write to it
 * that failed must not leave it generating.
 */
describe("a pre-created document is not left generating when writing it fails", () => {
	it("fails the document when filling it fails", async () => {
		stubs.processProjectContext.mockResolvedValue(
			extraction({ documentUsage: "AS_IS", targetDocumentId: "doc-1" }),
		);
		stubs.fillTargetDocument.mockRejectedValue(
			new Error("Activity task failed"),
		);

		const out = await projectContextProcessingWorkflow(input);

		expect(out.success).toBe(true);
		expect(stubs.failContextTargetDocument).toHaveBeenCalledTimes(1);
		expect(stubs.failContextTargetDocument).toHaveBeenCalledWith({
			contextId: "ctx-1",
			projectId: "proj-1",
			userId: "user-1",
			organizationId: "org-1",
			reason: expect.stringMatching(/was read, but .* did not finish/i),
		});
	});

	it("issues the old command sequence for a recorded history", async () => {
		stubs.processProjectContext.mockResolvedValue(
			extraction({ documentUsage: "AS_IS", targetDocumentId: "doc-1" }),
		);
		stubs.fillTargetDocument.mockRejectedValue(
			new Error("Activity task failed"),
		);
		patchedMock.mockReturnValue(false);

		const out = await projectContextProcessingWorkflow(input);

		expect(out.success).toBe(true);
		expect(activityCalls()).toEqual([
			"processProjectContext",
			"fillTargetDocument",
		]);
	});

	it("has nothing to fail for an import without a pre-created document", async () => {
		stubs.processProjectContext.mockResolvedValue(extraction());
		stubs.createImportedDocument.mockRejectedValue(
			new Error("Activity task failed"),
		);

		const out = await projectContextProcessingWorkflow(input);

		expect(out.success).toBe(true);
		expect(stubs.failContextTargetDocument).not.toHaveBeenCalled();
		expect(patchedMock).not.toHaveBeenCalled();
	});
});
