/**
 * Unit tests for `dispatchDocumentGeneration` — the single copy of the
 * generation-start sequence shared by the editor's regenerate route and the
 * Documents tab's create-and-generate call.
 *
 * Scope note: the tri-state `describe()` recovery this helper carries is also
 * exercised end-to-end through `generate-document.test.ts`, against the real
 * `WorkflowNotFoundError` class. What this file owns is everything a second
 * call site can get wrong without any procedure-level test noticing.
 *
 * Covered surfaces:
 *   - The workflow id is a function of the run's inputs, not of the clock:
 *     equivalent requests collide on purpose, different ones do not, and
 *     surrounding whitespace in the instructions is not a difference.
 *   - The conflict AND reuse policies are both set explicitly — the id is
 *     stable forever, so an inherited reuse default would eventually make a
 *     document ungeneratable.
 *   - A duplicate start is answered `alreadyInProgress` WITHOUT probing
 *     describe() and WITHOUT touching the row.
 *   - The row is marked QUEUED (never GENERATING) after the start, carrying
 *     this attempt's identity and the workflow id the watchdog reads.
 *   - The workflow is told that same identity, without which its
 *     QUEUED → GENERATING flip is skipped entirely.
 *   - `skipDependencyWait` never reaches the workflow from a caller.
 *   - Supplied context and the excluded-context id reach the workflow args, and
 *     are absent — not null, not empty string — when the caller has none.
 *   - The organization the caller resolved reaches both the AI token and the
 *     workflow args.
 *   - Infrastructure errors propagate raw, for the procedure boundary to log
 *     and generalize.
 */

import {
	WorkflowExecutionAlreadyStartedError,
	WorkflowNotFoundError,
} from "@temporalio/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		markDocumentGenerationQueued: vi.fn(),
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
	markDocumentGenerationQueued: mocks.markDocumentGenerationQueued,
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

/**
 * The id shape the whole feature rests on: the document, then a truncated
 * sha256 of the run's inputs. Pinned as a regex because a regression to a
 * `Date.now()` salt would keep every other assertion in this file green.
 */
const WORKFLOW_ID_PATTERN = new RegExp(
	`^project-document-generation-${DOCUMENT_ID}-[0-9a-f]{16}$`,
);

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
function workflowArgs(call = 0) {
	return mocks.workflowStart.mock.calls[call]?.[1].args[0];
}

/** The start options bag (task queue, policies, workflow id). */
function startOptions(call = 0) {
	return mocks.workflowStart.mock.calls[call]?.[1];
}

/** Dispatch once and report the workflow id Temporal was asked to start. */
async function idFor(overrides: Record<string, unknown> = {}) {
	const result = await dispatchDocumentGeneration(baseInput(overrides));
	return result.workflowId;
}

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		m.mockReset();
	}
	mocks.issueAIToken.mockResolvedValue("ai-token");
	mocks.markDocumentGenerationQueued.mockImplementation(
		async (_id: string, options: { generationStartedAt?: Date } = {}) => ({
			applied: true,
			generationStartedAt: options.generationStartedAt ?? new Date(),
		}),
	);
	mocks.markDocumentGenerationFailed.mockResolvedValue(undefined);
	mocks.workflowStart.mockImplementation(
		async (_name: string, options: { workflowId: string }) => ({
			workflowId: options.workflowId,
			firstExecutionRunId: "run-1",
		}),
	);
	mocks.getHandle.mockReturnValue({ describe: mocks.workflowDescribe });
	mocks.getTemporalClient.mockResolvedValue({
		workflow: { start: mocks.workflowStart, getHandle: mocks.getHandle },
	});
});

describe("dispatchDocumentGeneration — deterministic workflow id", () => {
	it("derives the id from the document and a digest of the run's inputs", async () => {
		const id = await idFor();

		expect(id).toMatch(WORKFLOW_ID_PATTERN);
		expect(startOptions().workflowId).toBe(id);
	});

	it("gives two identical requests the same id, so the second joins the first", async () => {
		const first = await idFor({
			prompt: "tighten the risks section",
			promptId: "prompt-9",
			promptVersionId: "v3",
			currentDocument: "existing content",
			suppliedContext: "<fabric_attachment>src</fabric_attachment>",
			excludeContextId: "ctx-1",
		});
		const second = await idFor({
			prompt: "tighten the risks section",
			promptId: "prompt-9",
			promptVersionId: "v3",
			currentDocument: "existing content",
			suppliedContext: "<fabric_attachment>src</fabric_attachment>",
			excludeContextId: "ctx-1",
		});

		expect(second).toBe(first);
	});

	it("ignores leading and trailing whitespace in the instructions", async () => {
		// A textarea supplies plenty of it, and surrounding blanks are not a
		// different request — hashing them would mint a second live run for
		// what the user experiences as the same click.
		const bare = await idFor({ prompt: "rewrite the summary" });
		const padded = await idFor({ prompt: "  \n rewrite the summary \t " });

		expect(padded).toBe(bare);
	});

	it.each([
		["documentId", { documentId: "doc-2" }],
		["documentType", { documentType: "BRD" }],
		["promptId", { promptId: "prompt-other" }],
		["promptVersionId", { promptVersionId: "v9" }],
		["instructions", { prompt: "a materially different instruction" }],
		["suppliedContext", { suppliedContext: "different source text" }],
		["excludeContextId", { excludeContextId: "ctx-2" }],
	])("gives a different id when %s changes", async (_field, overrides) => {
		const baseline = await idFor({
			prompt: "rewrite the summary",
			promptId: "prompt-9",
			promptVersionId: "v3",
			suppliedContext: "source text",
			excludeContextId: "ctx-1",
		});

		const changed = await idFor({
			prompt: "rewrite the summary",
			promptId: "prompt-9",
			promptVersionId: "v3",
			suppliedContext: "source text",
			excludeContextId: "ctx-1",
			...overrides,
		});

		expect(changed).not.toBe(baseline);
	});

	it("does not fold the per-call AI token into the id", async () => {
		// The token is minted inside the dispatcher and differs on every call.
		// Hashing it would make every id unique again and silently undo the
		// entire deduplication mechanism while every id-shape test stayed green.
		mocks.issueAIToken.mockResolvedValueOnce("token-a");
		const first = await idFor();
		mocks.issueAIToken.mockResolvedValueOnce("token-b");
		const second = await idFor();

		expect(second).toBe(first);
	});
});

describe("dispatchDocumentGeneration — conflict and reuse policy", () => {
	it("refuses a duplicate start and still allows reuse of a closed run's id", async () => {
		await dispatchDocumentGeneration(baseInput());

		expect(startOptions()).toMatchObject({
			taskQueue: "project-documents",
			// FAIL: a live run under this id must reject the second start
			// rather than take it over.
			workflowIdConflictPolicy: "FAIL",
			// ALLOW_DUPLICATE: the id is stable forever, so a CLOSED prior run
			// under it must still permit a new start — otherwise a document
			// could never be regenerated twice with identical settings.
			workflowIdReusePolicy: "ALLOW_DUPLICATE",
		});
	});

	it("starts the project-document generation workflow by name", async () => {
		await dispatchDocumentGeneration(baseInput());

		expect(mocks.workflowStart.mock.calls[0]?.[0]).toBe(
			"projectDocumentGenerationWorkflow",
		);
		expect(startOptions().workflowId).toMatch(WORKFLOW_ID_PATTERN);
	});

	it("starts a new run when a prior run under the same id has closed", async () => {
		// ALLOW_DUPLICATE is what makes this possible: Temporal accepts the
		// start, and the dispatcher reports a fresh run rather than reusing the
		// closed one's answer.
		const first = await dispatchDocumentGeneration(baseInput());
		const second = await dispatchDocumentGeneration(baseInput());

		expect(first.outcome).toBe("started");
		expect(second.outcome).toBe("started");
		expect(second.workflowId).toBe(first.workflowId);
		expect(mocks.workflowStart).toHaveBeenCalledTimes(2);
	});
});

describe("dispatchDocumentGeneration — a run is already live", () => {
	beforeEach(() => {
		mocks.workflowStart.mockRejectedValue(
			new WorkflowExecutionAlreadyStartedError(
				"Workflow execution already started",
				"unused-placeholder-workflow-id",
				"projectDocumentGenerationWorkflow",
			),
		);
	});

	it("reports alreadyInProgress rather than a second start", async () => {
		const result = await dispatchDocumentGeneration(baseInput());

		expect(result.outcome).toBe("alreadyInProgress");
		expect(result.workflowId).toMatch(WORKFLOW_ID_PATTERN);
		expect(result.runId).toBeNull();
	});

	it("never touches the document row", async () => {
		// The live attempt's `generationStartedAt` is its identity: stamping a
		// fresh one here would strand its own QUEUED → GENERATING flip.
		await dispatchDocumentGeneration(baseInput());

		expect(mocks.markDocumentGenerationQueued).not.toHaveBeenCalled();
		expect(mocks.markDocumentGenerationFailed).not.toHaveBeenCalled();
	});

	it("is decided before the describe() probe runs", async () => {
		// The probe would RESOLVE — the other run really is live — and the
		// tri-state recovery would then report "Document generation started",
		// a silent success where the caller needs a distinguishable answer.
		await dispatchDocumentGeneration(baseInput());

		expect(mocks.getHandle).not.toHaveBeenCalled();
		expect(mocks.workflowDescribe).not.toHaveBeenCalled();
	});
});

describe("dispatchDocumentGeneration — the queued mark", () => {
	it("marks the row QUEUED after the start, never GENERATING before it", async () => {
		await dispatchDocumentGeneration(baseInput());

		// The guarded queue write is what replaced the old
		// mark-GENERATING-before-start ordering: a duplicate start must not
		// stamp the row before Temporal has had the chance to refuse it.
		expect(mocks.markDocumentGenerationQueued).toHaveBeenCalledTimes(1);
		const [queuedOrder] =
			mocks.markDocumentGenerationQueued.mock.invocationCallOrder;
		const [workflowOrder] = mocks.workflowStart.mock.invocationCallOrder;
		expect(workflowOrder).toBeLessThan(queuedOrder);
	});

	it("persists the workflow id the watchdog's liveness check reads", async () => {
		// QUEUED has no age ceiling — a dependency wait can legitimately run
		// for an hour — so the liveness check on this id is the ONLY thing that
		// can recover an orphaned queued row.
		const result = await dispatchDocumentGeneration(baseInput());

		const [documentId, options] =
			mocks.markDocumentGenerationQueued.mock.calls[0];
		expect(documentId).toBe(DOCUMENT_ID);
		expect(options.workflowId).toBe(result.workflowId);
	});

	it("tells the workflow the same identity it writes to the row", async () => {
		// Without `generationStartedAt` in the args the run SKIPS its
		// QUEUED → GENERATING flip, and every document queues forever.
		await dispatchDocumentGeneration(baseInput());

		const [, options] = mocks.markDocumentGenerationQueued.mock.calls[0];
		expect(options.generationStartedAt).toBeInstanceOf(Date);
		expect(workflowArgs().generationStartedAt).toBe(
			options.generationStartedAt.toISOString(),
		);
	});

	it("still reports a started run when the mark is a no-op", async () => {
		// The row was already terminalized — a dependency probe that failed
		// inside the first second writes FAILED — and the guard is what makes
		// that answer stand. The dispatch itself succeeded regardless.
		mocks.markDocumentGenerationQueued.mockResolvedValue({
			applied: false,
			generationStartedAt: new Date(),
		});

		const result = await dispatchDocumentGeneration(baseInput());

		expect(result.outcome).toBe("started");
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

	it("never forwards a caller-supplied skipDependencyWait", async () => {
		// The flag is settable only by the in-process Temporal caller that
		// spawns a generation as a child of the ingestion producing its source.
		// Arriving through the API it would be the "generate anyway" switch this
		// feature exists to forbid — so the dispatcher's input type does not
		// carry it, and nothing copies it across even when a caller invents it.
		await dispatchDocumentGeneration(
			baseInput({ skipDependencyWait: true }) as never,
		);

		expect(workflowArgs().skipDependencyWait).toBeUndefined();
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
});

/**
 * The recovery for a start that threw for any reason OTHER than a duplicate.
 * Unchanged by the deterministic id: only `WorkflowExecutionAlreadyStartedError`
 * jumps the queue ahead of it.
 */
describe("dispatchDocumentGeneration — tri-state recovery", () => {
	beforeEach(() => {
		mocks.workflowStart.mockRejectedValue(
			new Error("temporal connection refused: internal-host:1234"),
		);
	});

	it("treats a describe() that resolves as a live run and reports started", async () => {
		mocks.workflowDescribe.mockResolvedValue({
			runId: "live-run-id",
			status: { name: "RUNNING" },
		});

		const result = await dispatchDocumentGeneration(baseInput());

		expect(result).toMatchObject({
			outcome: "started",
			runId: "live-run-id",
		});
		expect(result.workflowId).toMatch(WORKFLOW_ID_PATTERN);
		expect(mocks.markDocumentGenerationFailed).not.toHaveBeenCalled();
	});

	it("marks the attempt failed and rethrows when describe() proves absence", async () => {
		mocks.workflowDescribe.mockRejectedValue(
			new WorkflowNotFoundError(
				"Workflow execution not found",
				"unused-placeholder-workflow-id",
				undefined,
			),
		);

		await expect(dispatchDocumentGeneration(baseInput())).rejects.toThrow(
			"internal-host",
		);

		const [documentId, startedAt, message] =
			mocks.markDocumentGenerationFailed.mock.calls[0];
		expect(documentId).toBe(DOCUMENT_ID);
		// Attempt-scoped: the exact identity this attempt queued the row with,
		// so a newer attempt's state can never be clobbered by this write.
		const [, queuedOptions] =
			mocks.markDocumentGenerationQueued.mock.calls[0];
		expect(startedAt).toBe(queuedOptions.generationStartedAt);
		// Never the raw infrastructure error — the editor renders this string.
		expect(message).not.toContain("internal-host");
	});

	it("returns statusUnknown without failing the row when describe() is ambiguous", async () => {
		mocks.workflowDescribe.mockRejectedValue(
			new Error("deadline exceeded"),
		);

		const result = await dispatchDocumentGeneration(baseInput());

		expect(result).toMatchObject({ outcome: "statusUnknown", runId: null });
		expect(mocks.markDocumentGenerationFailed).not.toHaveBeenCalled();
		// The row is left QUEUED with its workflow id, which is exactly what
		// the watchdog's liveness check needs to sweep it up if the start
		// really never happened.
		expect(mocks.markDocumentGenerationQueued).toHaveBeenCalledTimes(1);
		expect(mocks.loggerWarn).toHaveBeenCalledTimes(1);
	});

	it("treats a falsy describe() rejection as ambiguous, not as definite absence", async () => {
		// A promise can reject with any value. Only WorkflowNotFoundError
		// proves absence; a truthiness check on the captured value would send
		// this down the FAILED write instead.
		mocks.workflowDescribe.mockRejectedValue(undefined);

		const result = await dispatchDocumentGeneration(baseInput());

		expect(result.outcome).toBe("statusUnknown");
		expect(mocks.markDocumentGenerationFailed).not.toHaveBeenCalled();
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
		expect(mocks.markDocumentGenerationQueued).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});
});
