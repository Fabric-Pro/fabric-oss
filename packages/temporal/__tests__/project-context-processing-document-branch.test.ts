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
	failTargetDocument: vi.fn(),
	fillTargetDocument: vi.fn(),
	embedProjectDocumentActivity: vi.fn(),
	issueGenerationToken: vi.fn(),
}));

const executeChildMock = vi.hoisted(() => vi.fn());

vi.mock("@temporalio/workflow", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	proxyActivities: vi.fn(() => stubs),
	executeChild: executeChildMock,
	ApplicationFailure: {
		nonRetryable: (message: string) => new Error(message),
	},
}));

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
	stubs.cleanupImportedContent.mockResolvedValue("# Formatted\n\ntext");
	stubs.createImportedDocument.mockResolvedValue({ documentId: "doc-new" });
	stubs.fillTargetDocument.mockResolvedValue({ applied: true });
	stubs.failTargetDocument.mockResolvedValue({ applied: true });
	stubs.embedProjectDocumentActivity.mockResolvedValue(undefined);
	stubs.issueGenerationToken.mockResolvedValue({ aiToken: "tok" });
	executeChildMock.mockReset();
	executeChildMock.mockResolvedValue(undefined);
});

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
						suppliedContextId: "ctx-1",
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
