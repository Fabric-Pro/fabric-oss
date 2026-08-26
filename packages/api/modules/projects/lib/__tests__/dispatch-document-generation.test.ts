/**
 * Unit tests for `dispatchDocumentGeneration` — the single copy of the
 * generation-start sequence now shared by the editor's regenerate route and the
 * Documents tab's create-and-generate call.
 *
 * Scope note: the tri-state `describe()` recovery this helper carries is
 * exercised end-to-end through `generate-document.test.ts`, against the real
 * `WorkflowNotFoundError` class. It is not duplicated here — this file covers
 * the ordering guarantee and the workflow argument shape, which are the two
 * things a second call site can get wrong without any existing test noticing.
 *
 * Covered surfaces:
 *   - The row is marked GENERATING before `workflow.start` (issue #720).
 *   - Supplied context and the excluded-context id reach the workflow args, and
 *     are absent — not null, not empty string — when the caller has none.
 *   - The organization the caller resolved reaches both the AI token and the
 *     workflow args.
 *   - Infrastructure errors propagate raw, for the procedure boundary to log
 *     and generalize.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		markDocumentGenerationStarted: vi.fn(),
		markDocumentGenerationFailed: vi.fn(),
		issueAIToken: vi.fn(),
		getTemporalClient: vi.fn(),
		workflowStart: vi.fn(),
		workflowDescribe: vi.fn(),
		getHandle: vi.fn(),
		loggerWarn: vi.fn(),
	},
}));

vi.mock("@repo/database/prisma/queries/projects/documents", () => ({
	markDocumentGenerationStarted: mocks.markDocumentGenerationStarted,
	markDocumentGenerationFailed: mocks.markDocumentGenerationFailed,
}));

vi.mock("@repo/ai-token", () => ({ issueAIToken: mocks.issueAIToken }));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: mocks.getTemporalClient,
}));

vi.mock("@repo/logs", () => ({
	logger: {
		warn: mocks.loggerWarn,
		info: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock("../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: <T>(args: T) => args,
}));

import { dispatchDocumentGeneration } from "../dispatch-document-generation";

const DOCUMENT_ID = "doc-1";
const PROJECT_ID = "project-1";
const USER_ID = "user-1";
const ORG_ID = "org-1";
const STARTED_AT = new Date("2026-08-18T00:00:00.000Z");

function baseInput(overrides: Record<string, unknown> = {}) {
	return {
		documentId: DOCUMENT_ID,
		projectId: PROJECT_ID,
		documentType: "PRD",
		userId: USER_ID,
		organizationId: ORG_ID,
		...overrides,
	};
}

/** The single argument object handed to the workflow. */
function workflowArgs() {
	return mocks.workflowStart.mock.calls[0]?.[1].args[0];
}

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		m.mockReset();
	}
	mocks.issueAIToken.mockResolvedValue("ai-token");
	mocks.markDocumentGenerationStarted.mockResolvedValue({
		id: DOCUMENT_ID,
		generationStartedAt: STARTED_AT,
	});
	mocks.workflowStart.mockResolvedValue({
		workflowId: "wf-1",
		firstExecutionRunId: "run-1",
	});
	mocks.getHandle.mockReturnValue({ describe: mocks.workflowDescribe });
	mocks.getTemporalClient.mockResolvedValue({
		workflow: { start: mocks.workflowStart, getHandle: mocks.getHandle },
	});
});

describe("dispatchDocumentGeneration — ordering", () => {
	it("marks the document generating before starting the workflow", async () => {
		await dispatchDocumentGeneration(baseInput());

		expect(mocks.markDocumentGenerationStarted).toHaveBeenCalledWith(
			DOCUMENT_ID,
		);

		// The guarantee that made this helper worth extracting: a second call
		// site that started the workflow first would reintroduce issue #720 —
		// a fast-failing run's own FAILED write clobbered by this one landing
		// after it, and the editor's poller left with nothing to watch.
		const [startedOrder] =
			mocks.markDocumentGenerationStarted.mock.invocationCallOrder;
		const [workflowOrder] = mocks.workflowStart.mock.invocationCallOrder;
		expect(startedOrder).toBeLessThan(workflowOrder);
	});

	it("returns the started workflow's identifiers", async () => {
		const result = await dispatchDocumentGeneration(baseInput());

		expect(result).toMatchObject({ workflowId: "wf-1", runId: "run-1" });
	});
});

describe("dispatchDocumentGeneration — workflow arguments", () => {
	it("carries supplied context and the excluded-context id when the caller has them", async () => {
		await dispatchDocumentGeneration(
			baseInput({
				suppliedContext:
					"<fabric_attachment>\nsource text\n</fabric_attachment>",
				excludeContextId: "ctx-1",
				prompt: "extra instructions",
				promptId: "prompt-9",
				promptVersionId: "v3",
			}),
		);

		expect(workflowArgs()).toMatchObject({
			projectId: PROJECT_ID,
			documentId: DOCUMENT_ID,
			documentType: "PRD",
			userId: USER_ID,
			organizationId: ORG_ID,
			prompt: "extra instructions",
			promptId: "prompt-9",
			promptVersionId: "v3",
			suppliedContext:
				"<fabric_attachment>\nsource text\n</fabric_attachment>",
			excludeContextId: "ctx-1",
		});
	});

	it("leaves both new fields undefined for a caller with no supplied source", async () => {
		// The regenerate route's shape. An empty string or a null here would
		// reach the workflow as a present-but-blank source and could be joined
		// into the context array as an empty section.
		await dispatchDocumentGeneration(
			baseInput({ currentDocument: "existing content" }),
		);

		const args = workflowArgs();
		expect(args.suppliedContext).toBeUndefined();
		expect(args.excludeContextId).toBeUndefined();
		expect(args.currentDocument).toBe("existing content");
	});

	it("threads the caller-resolved organization into the AI token and the run", async () => {
		await dispatchDocumentGeneration(baseInput({ organizationId: ORG_ID }));

		expect(mocks.issueAIToken).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: USER_ID,
				organizationId: ORG_ID,
				source: "project-document-generation",
			}),
		);
		expect(workflowArgs().organizationId).toBe(ORG_ID);
	});

	it("passes an undefined organization straight through for a personal project", async () => {
		await dispatchDocumentGeneration(
			baseInput({ organizationId: undefined }),
		);

		expect(
			mocks.issueAIToken.mock.calls[0]?.[0].organizationId,
		).toBeUndefined();
		expect(workflowArgs().organizationId).toBeUndefined();
	});

	it("starts the project-document generation workflow on its own task queue", async () => {
		await dispatchDocumentGeneration(baseInput());

		expect(mocks.workflowStart.mock.calls[0]?.[0]).toBe(
			"projectDocumentGenerationWorkflow",
		);
		expect(mocks.workflowStart.mock.calls[0]?.[1]).toMatchObject({
			taskQueue: "project-documents",
		});
		expect(mocks.workflowStart.mock.calls[0]?.[1].workflowId).toMatch(
			new RegExp(`^project-document-generation-${DOCUMENT_ID}-\\d+$`),
		);
	});
});

describe("dispatchDocumentGeneration — failure propagation", () => {
	it("propagates a token-issuance failure raw, without marking the row", async () => {
		// The procedure boundary owns the generic client message; leaking the
		// raw text from here would defeat that.
		mocks.issueAIToken.mockRejectedValue(
			new Error("token service unreachable: internal-host:9000"),
		);

		await expect(dispatchDocumentGeneration(baseInput())).rejects.toThrow(
			"internal-host",
		);
		expect(mocks.markDocumentGenerationStarted).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});
});
