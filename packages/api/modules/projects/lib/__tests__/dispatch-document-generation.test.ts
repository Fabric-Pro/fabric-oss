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
 *   - A queue mark that landed nudges the document's open pages once, ids
 *     only and without being waited for; a declined mark, a duplicate or
 *     joined run, and a start that never happened send nothing, and a
 *     failed nudge never fails the dispatch (Fizzy #2946).
 *   - The workflow is told that same identity, without which its
 *     QUEUED → GENERATING flip is skipped entirely.
 *   - `skipDependencyWait` never reaches the workflow from a caller.
 *   - Supplied context and the excluded-context id reach the workflow args, and
 *     are absent — not null, not empty string — when the caller has none.
 *   - The organization the caller resolved reaches both the AI token and the
 *     workflow args.
 *   - Infrastructure errors propagate raw, for the procedure boundary to log
 *     and generalize; the client's failure surfaces ahead of the token's,
 *     without an unhandled rejection.
 *   - A client-document Proposal joins a run that is still live (Fizzy
 *     #2946): its stored workflow is asked about under a per-document lock,
 *     and a new run starts only once that workflow is gone; a workflow
 *     Temporal cannot answer about is `liveRunUnknown`, never the ambiguous
 *     start's `statusUnknown`; every other document supersedes as before.
 *     Its start and describe() run under deadlines that keep the lock's
 *     transaction from timing out under them.
 */

import {
	WorkflowExecutionAlreadyStartedError,
	WorkflowNotFoundError,
} from "@temporalio/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
		isProposalClientDocument: vi.fn(),
		withLiveRunDispatchLock: vi.fn(),
		withDeadline: vi.fn(),
		emitDocumentChange: vi.fn(),
	},
}));

vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/database")>()),
	isProposalClientDocument: mocks.isProposalClientDocument,
	withLiveRunDispatchLock: mocks.withLiveRunDispatchLock,
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

vi.mock("../../../../lib/realtime", () => ({
	emitDocumentChange: mocks.emitDocumentChange,
}));

import {
	dispatchDocumentGeneration,
	LIVE_RUN_START_DEADLINE_MS,
} from "../dispatch-document-generation";
import { WORKFLOW_RUN_LIVENESS_TIMEOUT_MS } from "../workflow-run-liveness";

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
	mocks.emitDocumentChange.mockResolvedValue(undefined);
	mocks.workflowStart.mockImplementation(
		async (_name: string, options: { workflowId: string }) => ({
			workflowId: options.workflowId,
			firstExecutionRunId: "run-1",
		}),
	);
	mocks.getHandle.mockReturnValue({ describe: mocks.workflowDescribe });
	mocks.withDeadline.mockImplementation(
		<R>(_deadline: number, fn: () => Promise<R>) => fn(),
	);
	mocks.getTemporalClient.mockResolvedValue({
		workflow: { start: mocks.workflowStart, getHandle: mocks.getHandle },
		withDeadline: mocks.withDeadline,
	});
	// The real rule's shape: a Proposal in an organization whose gate is on.
	mocks.isProposalClientDocument.mockImplementation(
		async (args: { organizationId?: string; documentType: string }) =>
			proposalArtifactOn &&
			!!args.organizationId &&
			args.documentType === "PROPOSAL",
	);
});

/** The Proposal artifact gate of the project's owning organization. */
let proposalArtifactOn = false;

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

	it("still reports a started run when a newer attempt owns the row", async () => {
		// A newer dispatch stamped the row during this start, and the guard
		// is what makes that answer stand. This dispatch itself succeeded.
		mocks.markDocumentGenerationQueued.mockResolvedValue({
			applied: false,
			generationStartedAt: new Date(),
			declinedFor: "newer-run",
		});

		const result = await dispatchDocumentGeneration(baseInput());

		expect(result.outcome).toBe("started");
	});

	it("asks the mark to take the row back from a write that owns no run, but not a live row", async () => {
		// A title edit during the start declines the freshness mark; the run
		// would wait for its row and stop as superseded (Fizzy #2946). Outside
		// the client-document Proposal lock nothing has ruled on a row that
		// is still QUEUED or GENERATING under an older attempt.
		await dispatchDocumentGeneration(baseInput());

		const [, options] = mocks.markDocumentGenerationQueued.mock.calls[0];
		expect(options.reclaim).toEqual({ liveRowJudged: false });
	});

	it("fails the request when the mark matches nothing a newer attempt explains", async () => {
		mocks.markDocumentGenerationQueued.mockResolvedValue({
			applied: false,
			generationStartedAt: new Date(),
			declinedFor: "unowned",
		});

		await expect(dispatchDocumentGeneration(baseInput())).rejects.toThrow(
			/could not be queued/,
		);
	});

	it("keeps reporting a started run when an older attempt's live row keeps it", async () => {
		mocks.markDocumentGenerationQueued.mockResolvedValue({
			applied: false,
			generationStartedAt: new Date(),
			declinedFor: "live-row",
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

/**
 * A page already open on the document hears nothing else when the row leaves
 * COMPLETE or FAILED for QUEUED, so the dispatch nudges it (Fizzy #2946).
 */
describe("dispatchDocumentGeneration — an open page is told the document is queued", () => {
	it("nudges the document's page once, ids only, after the queue mark lands", async () => {
		const result = await dispatchDocumentGeneration(baseInput());

		expect(result.outcome).toBe("started");
		expect(mocks.emitDocumentChange).toHaveBeenCalledTimes(1);
		const [payload] = mocks.emitDocumentChange.mock.calls[0];
		expect(payload).toEqual({
			projectId: PROJECT_ID,
			documentId: DOCUMENT_ID,
			action: "updated",
			userId: USER_ID,
			userName: expect.any(String),
			documentType: "PRD",
		});
		const [queuedOrder] =
			mocks.markDocumentGenerationQueued.mock.invocationCallOrder;
		const [nudgeOrder] = mocks.emitDocumentChange.mock.invocationCallOrder;
		expect(queuedOrder).toBeLessThan(nudgeOrder);
	});

	it.each(["newer-run", "live-row"] as const)(
		"sends nothing when the mark is declined (%s)",
		async (declinedFor) => {
			// The row stays with whoever owns it; this request queued nothing.
			mocks.markDocumentGenerationQueued.mockResolvedValue({
				applied: false,
				generationStartedAt: new Date(),
				declinedFor,
			});

			const result = await dispatchDocumentGeneration(baseInput());

			expect(result.outcome).toBe("started");
			expect(mocks.emitDocumentChange).not.toHaveBeenCalled();
		},
	);

	it("sends nothing when the mark matches nothing and the request fails", async () => {
		mocks.markDocumentGenerationQueued.mockResolvedValue({
			applied: false,
			generationStartedAt: new Date(),
			declinedFor: "unowned",
		});

		await expect(dispatchDocumentGeneration(baseInput())).rejects.toThrow(
			/could not be queued/,
		);
		expect(mocks.emitDocumentChange).not.toHaveBeenCalled();
	});

	it("sends nothing for a duplicate start, which marks nothing", async () => {
		mocks.workflowStart.mockRejectedValue(
			new WorkflowExecutionAlreadyStartedError(
				"Workflow execution already started",
				"unused-placeholder-workflow-id",
				"projectDocumentGenerationWorkflow",
			),
		);

		const result = await dispatchDocumentGeneration(baseInput());

		expect(result.outcome).toBe("alreadyInProgress");
		expect(mocks.emitDocumentChange).not.toHaveBeenCalled();
	});

	it("sends nothing for a start that never happened, though its mark had landed", async () => {
		mocks.workflowStart.mockRejectedValue(
			new Error("temporal connection refused: internal-host:1234"),
		);
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
		expect(mocks.markDocumentGenerationQueued).toHaveBeenCalledTimes(1);
		expect(mocks.markDocumentGenerationFailed).toHaveBeenCalledTimes(1);
		expect(mocks.emitDocumentChange).not.toHaveBeenCalled();
	});

	it("nudges once when a failed start turns out to be running", async () => {
		mocks.workflowStart.mockRejectedValue(new Error("lost response"));
		mocks.workflowDescribe.mockResolvedValue({
			runId: "live-run-id",
			status: { name: "RUNNING" },
		});

		const result = await dispatchDocumentGeneration(baseInput());

		expect(result.outcome).toBe("started");
		expect(mocks.emitDocumentChange).toHaveBeenCalledTimes(1);
	});

	it("nudges once for an ambiguous start, which is queued and treated as started", async () => {
		mocks.workflowStart.mockRejectedValue(new Error("lost response"));
		mocks.workflowDescribe.mockRejectedValue(
			new Error("deadline exceeded"),
		);

		const result = await dispatchDocumentGeneration(baseInput());

		expect(result.outcome).toBe("statusUnknown");
		expect(mocks.emitDocumentChange).toHaveBeenCalledTimes(1);
	});

	it("does not wait for the nudge", async () => {
		mocks.emitDocumentChange.mockReturnValue(new Promise(() => {}));

		const result = await dispatchDocumentGeneration(baseInput());

		expect(result.outcome).toBe("started");
	});

	it("still reports the started run when the nudge fails, and logs the failure", async () => {
		mocks.emitDocumentChange.mockRejectedValue(
			new Error("realtime unreachable"),
		);

		const result = await dispatchDocumentGeneration(baseInput());

		expect(result.outcome).toBe("started");
		await vi.waitFor(() =>
			expect(mocks.loggerWarn).toHaveBeenCalledWith(
				"background continuation failed",
				expect.objectContaining({ message: "realtime unreachable" }),
			),
		);
	});

	it("still reports the started run when the nudge throws before it is sent", async () => {
		mocks.emitDocumentChange.mockImplementation(() => {
			throw new Error("realtime misconfigured");
		});

		const result = await dispatchDocumentGeneration(baseInput());

		expect(result.outcome).toBe("started");
		await vi.waitFor(() =>
			expect(mocks.loggerWarn).toHaveBeenCalledWith(
				"background continuation failed",
				expect.objectContaining({ message: "realtime misconfigured" }),
			),
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
		expect(mocks.markDocumentGenerationQueued).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("propagates a client failure while the token is issued alongside it", async () => {
		mocks.getTemporalClient.mockRejectedValue(
			new Error("temporal unreachable: internal-host:7233"),
		);

		await expect(dispatchDocumentGeneration(baseInput())).rejects.toThrow(
			"temporal unreachable",
		);
		expect(mocks.issueAIToken).toHaveBeenCalledTimes(1);
		expect(mocks.markDocumentGenerationQueued).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("propagates the client's failure ahead of the token's, leaving no unhandled rejection", async () => {
		const unhandled = vi.fn();
		process.on("unhandledRejection", unhandled);
		try {
			mocks.getTemporalClient.mockRejectedValue(
				new Error("temporal unreachable"),
			);
			mocks.issueAIToken.mockRejectedValue(
				new Error("token service unreachable"),
			);

			await expect(
				dispatchDocumentGeneration(baseInput()),
			).rejects.toThrow("temporal unreachable");
			// Unhandled rejections are reported after the microtask queue
			// drains; give them a macrotask turn to surface.
			await new Promise((resolve) => setImmediate(resolve));
			await new Promise((resolve) => setImmediate(resolve));

			expect(unhandled).not.toHaveBeenCalled();
			expect(mocks.workflowStart).not.toHaveBeenCalled();
		} finally {
			process.off("unhandledRejection", unhandled);
		}
	});
});

// ---------------------------------------------------------------------------
// A client-document Proposal joins its live run (Fizzy #2946)
// ---------------------------------------------------------------------------

/** A workflow another member's request started for the same document. */
const OTHER_WORKFLOW_ID = `project-document-generation-${DOCUMENT_ID}-0123456789abcdef`;

function proposalInput(overrides: Record<string, unknown> = {}) {
	// The caller already refused an unbound Main prompt.
	return baseInput({
		documentType: "PROPOSAL",
		capabilityAlreadyAsserted: true,
		...overrides,
	});
}

function notFound() {
	return new WorkflowNotFoundError(
		"Workflow execution not found",
		"unused-placeholder-workflow-id",
		undefined,
	);
}

describe("dispatchDocumentGeneration — a client-document Proposal joins its live run", () => {
	/** The document's run state, as the lock reads it and the mark writes it. */
	let row: { status: string; workflowId: string | null };
	/** Workflows Temporal reports running. */
	let running: Set<string>;

	beforeEach(() => {
		proposalArtifactOn = true;
		row = { status: "GENERATING", workflowId: OTHER_WORKFLOW_ID };
		running = new Set([OTHER_WORKFLOW_ID]);
		// One holder at a time, as the advisory lock serializes dispatches.
		let held: Promise<void> = Promise.resolve();
		mocks.withLiveRunDispatchLock.mockImplementation(
			async (
				documentId: string,
				dispatch: (current: unknown) => Promise<unknown>,
			) => {
				const previous = held;
				let release = () => {};
				held = new Promise((resolve) => {
					release = resolve;
				});
				await previous;
				try {
					return await dispatch(
						documentId === DOCUMENT_ID ? { ...row } : null,
					);
				} finally {
					release();
				}
			},
		);
		mocks.markDocumentGenerationQueued.mockImplementation(
			async (
				_id: string,
				options: {
					generationStartedAt?: Date;
					workflowId?: string;
				} = {},
			) => {
				row = {
					status: "QUEUED",
					workflowId: options.workflowId ?? row.workflowId,
				};
				return {
					applied: true,
					generationStartedAt:
						options.generationStartedAt ?? new Date(),
				};
			},
		);
		mocks.workflowStart.mockImplementation(
			async (_name: string, options: { workflowId: string }) => {
				running.add(options.workflowId);
				return {
					workflowId: options.workflowId,
					firstExecutionRunId: "run-new",
				};
			},
		);
		mocks.getHandle.mockImplementation((workflowId: string) => ({
			describe: async () => {
				await mocks.workflowDescribe(workflowId);
				if (!running.has(workflowId)) {
					throw notFound();
				}
				return { runId: "run-live", status: { name: "RUNNING" } };
			},
		}));
	});

	afterEach(() => {
		proposalArtifactOn = false;
		vi.useRealTimers();
	});

	it("lets the mark take back a live row whose workflow the lock found gone", async () => {
		running.delete(OTHER_WORKFLOW_ID);

		const result = await dispatchDocumentGeneration(proposalInput());

		expect(result.outcome).toBe("started");
		const [, options] = mocks.markDocumentGenerationQueued.mock.calls[0];
		expect(options.reclaim).toEqual({ liveRowJudged: true });
	});

	it("does not let the mark take back a live row that names no workflow", async () => {
		row = { status: "GENERATING", workflowId: null };

		await dispatchDocumentGeneration(proposalInput());

		const [, options] = mocks.markDocumentGenerationQueued.mock.calls[0];
		expect(options.reclaim).toEqual({ liveRowJudged: false });
	});

	it("asks the owning organization's client-document rule, and takes the document's lock", async () => {
		await dispatchDocumentGeneration(proposalInput());

		expect(mocks.isProposalClientDocument).toHaveBeenCalledWith({
			organizationId: ORG_ID,
			documentType: "PROPOSAL",
		});
		expect(mocks.withLiveRunDispatchLock).toHaveBeenCalledWith(
			DOCUMENT_ID,
			expect.any(Function),
		);
	});

	it.each(["QUEUED", "GENERATING"])(
		"joins a %s run whose workflow still runs: nothing started, nothing written",
		async (status) => {
			row.status = status;

			const result = await dispatchDocumentGeneration(proposalInput());

			expect(result).toEqual({
				outcome: "alreadyInProgress",
				workflowId: OTHER_WORKFLOW_ID,
				runId: null,
				message: "Document generation already in progress",
			});
			expect(mocks.getHandle).toHaveBeenCalledWith(OTHER_WORKFLOW_ID);
			expect(mocks.workflowStart).not.toHaveBeenCalled();
			expect(mocks.markDocumentGenerationQueued).not.toHaveBeenCalled();
			expect(mocks.markDocumentGenerationFailed).not.toHaveBeenCalled();
		},
	);

	it("treats a paused run as live", async () => {
		mocks.getHandle.mockReturnValue({
			describe: async () => ({
				runId: "run-live",
				status: { name: "PAUSED" },
			}),
		});

		const result = await dispatchDocumentGeneration(proposalInput());

		expect(result.outcome).toBe("alreadyInProgress");
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("answers liveRunUnknown and starts nothing when Temporal cannot say, then asks again on the next request", async () => {
		mocks.workflowDescribe.mockRejectedValueOnce(
			new Error("deadline exceeded"),
		);

		const unknown = await dispatchDocumentGeneration(proposalInput());

		// Its own answer, not the ambiguous start's `statusUnknown`: that one
		// queues the row and reads as started, this one wrote nothing.
		expect(unknown).toMatchObject({
			outcome: "liveRunUnknown",
			workflowId: OTHER_WORKFLOW_ID,
			runId: null,
		});
		expect(mocks.workflowStart).not.toHaveBeenCalled();
		expect(mocks.markDocumentGenerationQueued).not.toHaveBeenCalled();
		expect(mocks.loggerWarn).toHaveBeenCalledTimes(1);

		// The probe recovers and the run is still going: the request joins it.
		const joined = await dispatchDocumentGeneration(proposalInput());
		expect(joined.outcome).toBe("alreadyInProgress");
		expect(mocks.workflowStart).not.toHaveBeenCalled();

		// The run has ended meanwhile: the next request starts a new one.
		running.delete(OTHER_WORKFLOW_ID);
		const started = await dispatchDocumentGeneration(proposalInput());
		expect(started.outcome).toBe("started");
		expect(mocks.workflowStart).toHaveBeenCalledTimes(1);
	});

	it("answers liveRunUnknown when Temporal does not answer in time", async () => {
		vi.useFakeTimers();
		mocks.getHandle.mockReturnValue({
			describe: () => new Promise(() => {}),
		});

		const pending = dispatchDocumentGeneration(proposalInput());
		await vi.advanceTimersByTimeAsync(WORKFLOW_RUN_LIVENESS_TIMEOUT_MS);
		const result = await pending;

		expect(result.outcome).toBe("liveRunUnknown");
		expect(mocks.workflowStart).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("still answers statusUnknown, queued for the attempt, when the Proposal's own start is ambiguous", async () => {
		// Nothing live on the row, so the join arm lets the start go; the
		// start throws and Temporal cannot say whether it registered. That is
		// the pre-existing ambiguous start, which reads as started — not the
		// join arm's "could not confirm".
		row = { status: "COMPLETE", workflowId: OTHER_WORKFLOW_ID };
		mocks.workflowStart.mockRejectedValue(new Error("connection reset"));
		mocks.getHandle.mockReturnValue({
			describe: () => Promise.reject(new Error("deadline exceeded")),
		});

		const result = await dispatchDocumentGeneration(proposalInput());

		expect(result).toMatchObject({ outcome: "statusUnknown", runId: null });
		expect(result.workflowId).not.toBe(OTHER_WORKFLOW_ID);
		expect(mocks.markDocumentGenerationQueued).toHaveBeenCalledTimes(1);
		expect(mocks.markDocumentGenerationFailed).not.toHaveBeenCalled();
	});

	it("bounds the start under the lock, and settles a start that never answers as statusUnknown, queued", async () => {
		vi.useFakeTimers();
		row = { status: "COMPLETE", workflowId: OTHER_WORKFLOW_ID };
		// Temporal accepts the connection and never answers: neither the
		// start nor the describe() after it.
		mocks.workflowStart.mockImplementation(() => new Promise(() => {}));
		mocks.getHandle.mockReturnValue({
			describe: () => new Promise(() => {}),
		});
		// The client's deadline, as the real one behaves: the call is
		// abandoned with DEADLINE_EXCEEDED once the deadline passes.
		mocks.withDeadline.mockImplementation(
			(deadline: number, fn: () => Promise<unknown>) =>
				new Promise((resolve, reject) => {
					fn().then(resolve, reject);
					setTimeout(
						() => reject(new Error("4 DEADLINE_EXCEEDED")),
						deadline - Date.now(),
					);
				}),
		);
		const dispatchedAt = Date.now();
		let settled = false;

		const pending = dispatchDocumentGeneration(proposalInput()).finally(
			() => {
				settled = true;
			},
		);
		await vi.advanceTimersByTimeAsync(LIVE_RUN_START_DEADLINE_MS);
		expect(settled).toBe(false);
		// The queue mark commits before the describe() wait, inside the lock.
		expect(mocks.markDocumentGenerationQueued).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(WORKFLOW_RUN_LIVENESS_TIMEOUT_MS);
		const result = await pending;

		expect(result).toMatchObject({ outcome: "statusUnknown", runId: null });
		expect(Date.now() - dispatchedAt).toBeLessThan(30_000);
		expect(mocks.markDocumentGenerationFailed).not.toHaveBeenCalled();
		const [deadline] = mocks.withDeadline.mock.calls[0];
		expect(deadline - dispatchedAt).toBe(LIVE_RUN_START_DEADLINE_MS);
		// The lock's transaction allows 30 s: the start's deadline, one retry
		// backoff past it (5 s) and the describe() bound fit inside it.
		expect(
			LIVE_RUN_START_DEADLINE_MS +
				5_000 +
				2 * WORKFLOW_RUN_LIVENESS_TIMEOUT_MS,
		).toBeLessThan(30_000);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("leaves a PRD's start without a deadline, outside any lock", async () => {
		await dispatchDocumentGeneration(baseInput({ documentType: "PRD" }));

		expect(mocks.withDeadline).not.toHaveBeenCalled();
		expect(mocks.workflowStart).toHaveBeenCalledTimes(1);
	});

	it.each([
		["Temporal no longer knows it", () => Promise.reject(notFound())],
		[
			"it closed",
			() =>
				Promise.resolve({
					runId: "run-old",
					status: { name: "TIMED_OUT" },
				}),
		],
	])(
		"starts a new run when the stored workflow is gone: %s",
		async (_case, describe) => {
			mocks.getHandle.mockReturnValue({ describe });

			const result = await dispatchDocumentGeneration(proposalInput());

			expect(result.outcome).toBe("started");
			expect(mocks.workflowStart).toHaveBeenCalledTimes(1);
			const [, options] =
				mocks.markDocumentGenerationQueued.mock.calls[0];
			expect(options.workflowId).toBe(result.workflowId);
			expect(result.workflowId).not.toBe(OTHER_WORKFLOW_ID);
		},
	);

	it.each([["COMPLETE"], ["FAILED"]])(
		"starts without asking Temporal when the row is %s",
		async (status) => {
			row.status = status;

			const result = await dispatchDocumentGeneration(proposalInput());

			expect(result.outcome).toBe("started");
			expect(mocks.getHandle).not.toHaveBeenCalled();
		},
	);

	it("leaves an equivalent repeat to Temporal's duplicate refusal, without asking about the run", async () => {
		const first = await dispatchDocumentGeneration(
			proposalInput({ userId: "user-2" }),
		);
		expect(first.outcome).toBe("alreadyInProgress");
		running.delete(OTHER_WORKFLOW_ID);
		const own = await dispatchDocumentGeneration(proposalInput());
		expect(own.outcome).toBe("started");
		mocks.getHandle.mockClear();
		mocks.workflowStart.mockRejectedValueOnce(
			new WorkflowExecutionAlreadyStartedError(
				"Workflow execution already started",
				own.workflowId,
				"projectDocumentGenerationWorkflow",
			),
		);

		const repeat = await dispatchDocumentGeneration(proposalInput());

		expect(repeat).toMatchObject({
			outcome: "alreadyInProgress",
			workflowId: own.workflowId,
		});
		expect(mocks.getHandle).not.toHaveBeenCalled();
	});

	it("starts exactly one run for two near-simultaneous requests from different members", async () => {
		row = { status: "COMPLETE", workflowId: OTHER_WORKFLOW_ID };
		running.clear();

		const [first, second] = await Promise.all([
			dispatchDocumentGeneration(proposalInput({ userId: "user-1" })),
			dispatchDocumentGeneration(proposalInput({ userId: "user-2" })),
		]);

		expect(mocks.workflowStart).toHaveBeenCalledTimes(1);
		expect(first.outcome).toBe("started");
		expect(second).toMatchObject({
			outcome: "alreadyInProgress",
			workflowId: first.workflowId,
		});
		expect(mocks.markDocumentGenerationQueued).toHaveBeenCalledTimes(1);
	});

	it("keeps superseding a PRD in the same situation", async () => {
		const result = await dispatchDocumentGeneration(
			baseInput({ documentType: "PRD" }),
		);

		expect(result.outcome).toBe("started");
		expect(mocks.withLiveRunDispatchLock).not.toHaveBeenCalled();
		expect(mocks.getHandle).not.toHaveBeenCalled();
		expect(mocks.workflowStart).toHaveBeenCalledTimes(1);
	});

	it("nudges the page once when a new run is queued under the lock, without holding the lock for it", async () => {
		running.delete(OTHER_WORKFLOW_ID);
		mocks.emitDocumentChange.mockReturnValue(new Promise(() => {}));

		const result = await dispatchDocumentGeneration(proposalInput());

		expect(result.outcome).toBe("started");
		expect(mocks.withLiveRunDispatchLock).toHaveBeenCalledTimes(1);
		expect(mocks.emitDocumentChange).toHaveBeenCalledTimes(1);
		expect(mocks.emitDocumentChange.mock.calls[0][0]).toMatchObject({
			projectId: PROJECT_ID,
			documentId: DOCUMENT_ID,
			action: "updated",
			documentType: "PROPOSAL",
		});
	});

	it("sends nothing when the request joins the live run", async () => {
		const result = await dispatchDocumentGeneration(
			proposalInput({ userId: "user-2" }),
		);

		expect(result.outcome).toBe("alreadyInProgress");
		expect(mocks.emitDocumentChange).not.toHaveBeenCalled();
	});

	it("sends nothing when Temporal cannot say whether the live run still goes", async () => {
		mocks.workflowDescribe.mockRejectedValue(new Error("unavailable"));

		const result = await dispatchDocumentGeneration(proposalInput());

		expect(result.outcome).toBe("liveRunUnknown");
		expect(mocks.emitDocumentChange).not.toHaveBeenCalled();
	});

	it("keeps superseding a Proposal while the Proposal artifact is off", async () => {
		proposalArtifactOn = false;

		const result = await dispatchDocumentGeneration(proposalInput());

		expect(result.outcome).toBe("started");
		expect(mocks.withLiveRunDispatchLock).not.toHaveBeenCalled();
		expect(mocks.getHandle).not.toHaveBeenCalled();
	});
});
