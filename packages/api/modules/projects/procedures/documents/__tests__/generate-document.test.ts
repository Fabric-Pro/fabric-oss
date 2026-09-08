/**
 * Unit tests for `generateDocumentProcedure` — the QUEUED/FAILED status
 * writes around the Temporal workflow start (issue #720).
 *
 * Before this fix, the row was never touched by this procedure: a failed
 * workflow run left `status: FAILED` + the old `generationError` in place
 * until (or unless) the workflow's own first milestone write arrived, and
 * the editor's poller — which only watches for new content — had nothing to
 * react to.
 *
 * The ordering has since inverted, and deliberately: the row is marked QUEUED
 * AFTER the start attempt, with a guarded write. The workflow id is now a hash
 * of the run's inputs, so an equivalent repeat request is refused by Temporal
 * as a duplicate — and a mark written before that refusal would have stamped a
 * fresh `generationStartedAt` over the live attempt's own identity. The guard
 * (`markDocumentGenerationQueued` declines to write over a COMPLETE/FAILED row)
 * is what makes marking afterwards safe, and is what now protects the
 * fast-failing run's own FAILED write that issue #720 was about.
 *
 * Covered surfaces:
 *   - Happy path marks the row QUEUED (progress 0, error cleared) AFTER
 *     `workflow.start` is called, carrying this attempt's identity and the
 *     workflow id.
 *   - `workflow.start` throwing marks the row FAILED with a generic message
 *     (never the raw internal error) and still surfaces
 *     INTERNAL_SERVER_ERROR to the caller.
 *   - The QUEUED write happens even when the workflow never starts —
 *     it must not be skipped when access checks pass but the start throws.
 *   - The FAILED write is attempt-scoped: the `generationStartedAt` the
 *     procedure passes to `markDocumentGenerationFailed` is exactly the one
 *     it queued the row with for THIS attempt (the query helper itself — not
 *     this file — owns the guarded-write mechanism; see
 *     `documents-generation-status.test.ts` in `packages/database`).
 *   - `workflow.start` throwing does NOT mean the workflow didn't start —
 *     a lost response or a racing identical workflowId can leave it live.
 *     When `client.workflow.getHandle(workflowId).describe()` proves the
 *     workflow exists despite the throw, the procedure treats the start as
 *     successful (same return shape, built from the local `workflowId`) and
 *     never calls `markDocumentGenerationFailed` — a false FAILED would
 *     otherwise tell the editor a live run had died.
 *   - The describe() probe itself is TRI-STATE, not a boolean: only a
 *     definite `WorkflowNotFoundError` proves the workflow never started
 *     (→ FAILED write + rethrow). Any OTHER describe() failure (deadline
 *     exceeded, connection reset, namespace hiccup) is ambiguous (UNKNOWN)
 *     — the procedure must NOT write FAILED in that case (it could be
 *     clobbering a live run it just can't currently see). It also does NOT
 *     rethrow: rethrowing would stop the client's polling and re-enable
 *     Regenerate, risking a second workflow racing a possibly-live one.
 *     Instead it returns a success-like response (`runId: null`) so the
 *     client keeps polling — real outcome resolves via the workflow's own
 *     milestone writes, or the client's existing safety timer if it
 *     genuinely never started.
 *
 * oRPC mocks mirror the sibling `set-auto-refresh.test.ts` / the backlog
 * `retry-failed-proposal.test.ts` pattern (chainable builder that captures
 * the raw handler). `WorkflowNotFoundError` is imported for real from
 * `@temporalio/client` (not mocked) so the `instanceof` check inside the
 * tri-state branch is exercised against the exact class it checks against,
 * not a stand-in.
 *
 * Note on scope after the Documents-tab create flow landed: the dispatch
 * sequence itself — token issuance, the deterministic workflow id, the guarded
 * queue write after the start, and the tri-state recovery — now lives in
 * `modules/projects/lib/dispatch-document-generation.ts`, because the create
 * flow dispatches generation too and a second copy of those rules would
 * drift. These tests deliberately still drive it THROUGH this procedure: the
 * ordering guarantee is a property of what this endpoint does, and asserting
 * it only against the helper would let the procedure stop calling it without
 * a red test. The helper's own file adds the argument-shape coverage this one
 * cannot express.
 */

import {
	WorkflowExecutionAlreadyStartedError,
	WorkflowNotFoundError,
} from "@temporalio/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks, captured } = vi.hoisted(() => ({
	mocks: {
		getDocumentById: vi.fn(),
		markDocumentGenerationQueued: vi.fn(),
		markDocumentGenerationFailed: vi.fn(),
		resolveEffectiveProjectPermissions: vi.fn(),
		issueAIToken: vi.fn(),
		getTemporalClient: vi.fn(),
		workflowStart: vi.fn(),
		workflowDescribe: vi.fn(),
		getHandle: vi.fn(),
		loggerWarn: vi.fn(),
		loggerError: vi.fn(),
	},
	/** The declared input schema — captured, not discarded. See the ceiling test. */
	captured: { inputSchema: undefined as unknown },
}));

vi.mock("@repo/database/prisma/queries/projects/documents", () => ({
	getDocumentById: mocks.getDocumentById,
	markDocumentGenerationQueued: mocks.markDocumentGenerationQueued,
	markDocumentGenerationFailed: mocks.markDocumentGenerationFailed,
}));

vi.mock("../../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions:
		mocks.resolveEffectiveProjectPermissions,
}));

// Real membership semantics, not a stub that always passes — the whole point
// of this gate is that it inspects the resolved permission set.
vi.mock("@repo/permissions", () => ({
	hasPermission: (granted: readonly string[], permission: string) =>
		granted.includes(permission),
}));

vi.mock("@repo/ai-token", () => ({
	issueAIToken: mocks.issueAIToken,
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: mocks.getTemporalClient,
}));

vi.mock("@repo/logs", () => ({
	logger: {
		warn: mocks.loggerWarn,
		info: vi.fn(),
		error: mocks.loggerError,
		debug: vi.fn(),
	},
}));

vi.mock("../../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: <T>(args: T) => args,
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chain: Record<string, unknown> = {};
	Object.assign(chain, {
		use: () => chain,
		route: () => chain,
		input: (schema: unknown) => {
			captured.inputSchema = schema;
			return chain;
		},
		output: () => chain,
		handler: (fn: (...args: unknown[]) => unknown) => ({ _handler: fn }),
	});
	return {
		tenantProtectedProcedure: chain,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
	};
});

import { MAX_RUN_INSTRUCTIONS_CHARS } from "../../../lib/dispatch-document-generation";
import { generateDocumentProcedure } from "../generate-document";

type Handler = (args: {
	input: Record<string, unknown>;
	context: { user: { id: string; name?: string } };
}) => Promise<Record<string, unknown>>;

const wired = (p: unknown) => p as unknown as { _handler: Handler };
const handler = wired(generateDocumentProcedure)._handler;

const DOCUMENT_ID = "doc-1";
const PROJECT_ID = "project-1";

function makeDocument(overrides: Record<string, unknown> = {}) {
	return {
		id: DOCUMENT_ID,
		projectId: PROJECT_ID,
		type: "PRD",
		content: "existing content",
		project: { organizationId: "org-1" },
		...overrides,
	};
}

const ctx = { user: { id: "user-1" } };

/**
 * The workflow id shape: the document, then a truncated sha256 of the run's
 * inputs. Pinned here because a regression to the old `Date.now()` salt would
 * leave every other assertion in this file green while quietly restoring the
 * duplicate-run behaviour the deterministic id exists to stop.
 */
const WORKFLOW_ID_PATTERN = new RegExp(
	`^project-document-generation-${DOCUMENT_ID}-[0-9a-f]{16}$`,
);

/**
 * This attempt's identity, as the dispatch minted it and handed it to the
 * queued mark. Read back rather than fixed to a constant: the dispatcher owns
 * the timestamp now, because the workflow has to be told it at start time and
 * the row cannot be marked until the start is known not to be a duplicate.
 */
function queuedIdentity(): Date {
	const [, options] = mocks.markDocumentGenerationQueued.mock.calls[0] as [
		string,
		{ generationStartedAt: Date; workflowId: string },
	];
	return options.generationStartedAt;
}

function input(overrides: Record<string, unknown> = {}) {
	return { id: DOCUMENT_ID, prompt: "", ...overrides };
}

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		m.mockReset();
	}
	mocks.getDocumentById.mockResolvedValue(makeDocument());
	mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
		permissions: ["DOCUMENT_UPDATE"],
		source: "project-member",
		organizationId: "org-1",
	});
	mocks.issueAIToken.mockResolvedValue("ai-token");
	mocks.markDocumentGenerationQueued.mockImplementation(
		async (_id: string, options: { generationStartedAt?: Date } = {}) => ({
			applied: true,
			generationStartedAt: options.generationStartedAt ?? new Date(),
		}),
	);
	mocks.markDocumentGenerationFailed.mockResolvedValue(undefined);
	// Echoes the id back, the way Temporal does — the deterministic id the
	// dispatcher computed is what a started run reports.
	mocks.workflowStart.mockImplementation(
		async (_name: string, options: { workflowId: string }) => ({
			workflowId: options.workflowId,
			firstExecutionRunId: "run-1",
		}),
	);
	// Default: the workflow genuinely doesn't exist when we go looking for
	// it — a REAL WorkflowNotFoundError, so the procedure's `instanceof`
	// check actually exercises the definite-absence branch. Matches the
	// "start truly failed" test cases below. The other two failure-path
	// tests override this: one to resolve (workflow actually live), one to
	// reject with a generic Error (ambiguous describe() failure).
	mocks.workflowDescribe.mockRejectedValue(
		new WorkflowNotFoundError(
			"Workflow execution not found",
			"unused-placeholder-workflow-id",
			undefined,
		),
	);
	mocks.getHandle.mockReturnValue({ describe: mocks.workflowDescribe });
	mocks.getTemporalClient.mockResolvedValue({
		workflow: { start: mocks.workflowStart, getHandle: mocks.getHandle },
	});
});

describe("generateDocumentProcedure — happy path", () => {
	it("marks the row QUEUED after starting the workflow, never GENERATING before it", async () => {
		await handler({ input: input(), context: ctx });

		expect(mocks.markDocumentGenerationQueued).toHaveBeenCalledTimes(1);
		expect(mocks.workflowStart).toHaveBeenCalledTimes(1);

		// Ordering: the start goes first, so a duplicate Temporal refuses can
		// never stamp a fresh identity over the live attempt's. What protects
		// a fast-failing run's own FAILED write is now the guard inside
		// markDocumentGenerationQueued, not the ordering.
		const queuedOrder =
			mocks.markDocumentGenerationQueued.mock.invocationCallOrder[0];
		const workflowStartOrder =
			mocks.workflowStart.mock.invocationCallOrder[0];
		expect(workflowStartOrder).toBeLessThan(queuedOrder);

		expect(mocks.markDocumentGenerationFailed).not.toHaveBeenCalled();
	});

	it("returns the deterministic workflow id and the run id", async () => {
		const result = await handler({ input: input(), context: ctx });

		expect(result.outcome).toBe("started");
		expect(result.workflowId).toMatch(WORKFLOW_ID_PATTERN);
		expect(result.runId).toBe("run-1");
	});

	it("hands the workflow this attempt's identity and writes it to the row with the workflow id", async () => {
		// Two silent breakages in one assertion. Without `generationStartedAt`
		// in the args the run SKIPS its QUEUED → GENERATING flip and the
		// document queues forever; without the workflow id on the row, the
		// watchdog's liveness check — the only guard that can recover an
		// orphaned QUEUED row, which has no age ceiling — has nothing to probe.
		const result = await handler({ input: input(), context: ctx });

		const [documentId, options] = mocks.markDocumentGenerationQueued.mock
			.calls[0] as [
			string,
			{ generationStartedAt: Date; workflowId: string },
		];
		expect(documentId).toBe(DOCUMENT_ID);
		expect(options.workflowId).toBe(result.workflowId);

		const args = mocks.workflowStart.mock.calls[0]?.[1].args[0];
		expect(args.generationStartedAt).toBe(
			options.generationStartedAt.toISOString(),
		);
	});
});

describe("generateDocumentProcedure — workflow-start failure", () => {
	it("marks the row FAILED with a generic message and surfaces INTERNAL_SERVER_ERROR", async () => {
		mocks.workflowStart.mockRejectedValue(
			new Error("temporal connection refused: internal-host:1234"),
		);

		// The client-facing error must be generic: the raw start error can
		// carry infrastructure details (hosts, connection strings) and the
		// editor renders this message in a toast. The details go to the
		// server log instead.
		await expect(
			handler({ input: input(), context: ctx }),
		).rejects.toMatchObject({
			code: "INTERNAL_SERVER_ERROR",
			message: "Failed to start document generation",
		});
		expect(mocks.loggerError).toHaveBeenCalledTimes(1);
		expect(String(mocks.loggerError.mock.calls[0]?.[0])).toContain(
			"internal-host",
		);

		expect(mocks.markDocumentGenerationQueued).toHaveBeenCalledTimes(1);
		expect(mocks.markDocumentGenerationFailed).toHaveBeenCalledTimes(1);

		const [failedDocId, failedStartedAt, failedMessage] = mocks
			.markDocumentGenerationFailed.mock.calls[0] as [
			string,
			Date,
			string,
		];
		expect(failedDocId).toBe(DOCUMENT_ID);
		// Attempt-scoped: the exact generationStartedAt this attempt queued
		// the row with, not a freshly generated timestamp — this is what lets
		// the query-layer guard (packages/database) reject a write from a
		// superseded attempt.
		expect(failedStartedAt).toBe(queuedIdentity());
		// Never leak the raw internal error into the persisted message.
		expect(failedMessage).not.toContain("internal-host");
		expect(failedMessage.length).toBeGreaterThan(0);
	});

	it("still surfaces INTERNAL_SERVER_ERROR when the FAILED write itself also fails", async () => {
		mocks.workflowStart.mockRejectedValue(new Error("temporal hiccup"));
		mocks.markDocumentGenerationFailed.mockRejectedValue(
			new Error("db unavailable"),
		);

		await expect(
			handler({ input: input(), context: ctx }),
		).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
	});
});

describe("generateDocumentProcedure — ambiguous describe() failure", () => {
	it("does NOT mark the row FAILED and does NOT throw — returns success-like so the client keeps polling", async () => {
		// The start call rejects, and the follow-up describe() probe ALSO
		// fails — but with a generic/transient error (deadline exceeded,
		// connection reset, namespace hiccup), not a definite
		// WorkflowNotFoundError. This is the "we genuinely don't know" case:
		// the workflow might be live, might not be. Guessing FAILED risks
		// clobbering a real run; rethrowing would stop the client's polling
		// and re-enable Regenerate, risking a SECOND workflow racing a
		// possibly-live one. So the handler must resolve (not reject) with a
		// success-like payload that keeps the client's polling/regenerating
		// state alive, and never touch the row.
		mocks.workflowStart.mockRejectedValue(
			new Error("temporal connection refused"),
		);
		mocks.workflowDescribe.mockRejectedValue(
			new Error("deadline exceeded"),
		);

		const result = await handler({ input: input(), context: ctx });

		expect(result.outcome).toBe("statusUnknown");
		expect(result.workflowId).toMatch(WORKFLOW_ID_PATTERN);
		expect(result.runId).toBeNull();
		expect(mocks.markDocumentGenerationFailed).not.toHaveBeenCalled();

		// Operator visibility into the ambiguous outcome.
		expect(mocks.loggerWarn).toHaveBeenCalledTimes(1);
	});

	it("treats a FALSY describe() rejection value as ambiguous too, not as definite absence", async () => {
		// A promise can reject with any value, including a falsy one. Only
		// WorkflowNotFoundError proves the workflow is absent — a falsy
		// rejection must take the UNKNOWN branch, not the FAILED write. This
		// pins the discriminant against regressing into a truthiness check
		// on the captured rejection value.
		mocks.workflowStart.mockRejectedValue(
			new Error("temporal connection refused"),
		);
		mocks.workflowDescribe.mockRejectedValue(undefined);

		const result = await handler({ input: input(), context: ctx });

		expect(result.workflowId).toMatch(WORKFLOW_ID_PATTERN);
		expect(result.runId).toBeNull();
		expect(mocks.markDocumentGenerationFailed).not.toHaveBeenCalled();
		expect(mocks.loggerWarn).toHaveBeenCalledTimes(1);
	});
});

describe("generateDocumentProcedure — workflow.start throws but the workflow actually started", () => {
	it("treats the run as live: returns success, and never marks the row FAILED", async () => {
		// The start call rejects (e.g. a lost response), but describe() proves
		// Temporal really did register the workflow.
		mocks.workflowStart.mockRejectedValue(
			new Error("temporal connection refused"),
		);
		mocks.workflowDescribe.mockResolvedValue({
			runId: "live-run-id",
			status: { name: "RUNNING" },
		});

		const result = await handler({ input: input(), context: ctx });

		// The success shape, built from the LOCAL workflowId (there is no
		// `handle` from `workflow.start` to read it off — start threw).
		expect(result.workflowId).toMatch(WORKFLOW_ID_PATTERN);
		expect(result.runId).toBe("live-run-id");
		expect(mocks.getHandle).toHaveBeenCalledWith(result.workflowId);

		// A false FAILED here would tell the editor a live run had died —
		// must never happen once describe() confirms the workflow exists.
		expect(mocks.markDocumentGenerationFailed).not.toHaveBeenCalled();
	});
});

/**
 * Regenerating with settings a live run already holds. The deterministic
 * workflow id lands the second request on the first run's id, Temporal refuses
 * the duplicate start, and the endpoint reports that rather than pretending a
 * second run began.
 */
describe("generateDocumentProcedure — an equivalent run is already live", () => {
	beforeEach(() => {
		mocks.workflowStart.mockRejectedValue(
			new WorkflowExecutionAlreadyStartedError(
				"Workflow execution already started",
				"unused-placeholder-workflow-id",
				"projectDocumentGenerationWorkflow",
			),
		);
	});

	it("resolves with alreadyInProgress instead of failing the call", async () => {
		const result = await handler({ input: input(), context: ctx });

		expect(result.outcome).toBe("alreadyInProgress");
		expect(result.workflowId).toMatch(WORKFLOW_ID_PATTERN);
		expect(result.runId).toBeNull();
		// A duplicate is not an infrastructure failure; nothing to log or
		// generalize at the procedure boundary.
		expect(mocks.loggerError).not.toHaveBeenCalled();
	});

	it("leaves the live attempt's row and identity untouched", async () => {
		await handler({ input: input(), context: ctx });

		expect(mocks.markDocumentGenerationQueued).not.toHaveBeenCalled();
		expect(mocks.markDocumentGenerationFailed).not.toHaveBeenCalled();
		// Decided before the probe: describe() would RESOLVE here — the other
		// run really is live — and the tri-state recovery would then report a
		// started run, a silent success where the caller needs to know it
		// joined an existing one.
		expect(mocks.workflowDescribe).not.toHaveBeenCalled();
	});
});

describe("generateDocumentProcedure — guard rejections", () => {
	it("throws NOT_FOUND when the document does not exist, without marking anything", async () => {
		mocks.getDocumentById.mockResolvedValue(null);

		await expect(
			handler({ input: input(), context: ctx }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		expect(mocks.markDocumentGenerationQueued).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("throws FORBIDDEN when the caller lacks project access, without marking anything", async () => {
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: [],
			source: "none",
			organizationId: "org-1",
		});

		await expect(
			handler({ input: input(), context: ctx }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		expect(mocks.markDocumentGenerationQueued).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});
});

/**
 * The gate itself. Regeneration overwrites a document's content, so read-only
 * access must not reach it. Before this became project-authoritative, the
 * procedure asked only whether a membership row existed — never what role it
 * carried — behind an org-level middleware that personal tenant context skips
 * outright.
 */
describe("generateDocumentProcedure — project-authoritative authorization", () => {
	it("refuses a project member whose role does not grant document update", async () => {
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: ["DOCUMENT_READ"],
			source: "project-member",
			organizationId: "org-1",
		});

		await expect(
			handler({ input: input(), context: ctx }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		expect(mocks.markDocumentGenerationQueued).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("allows a project member whose role grants document update", async () => {
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: ["DOCUMENT_UPDATE"],
			source: "project-member",
			organizationId: "org-1",
		});

		await expect(
			handler({ input: input(), context: ctx }),
		).resolves.toMatchObject({ workflowId: expect.any(String) });

		expect(mocks.workflowStart).toHaveBeenCalledTimes(1);
	});

	it("allows a personal-project owner even with an empty permission set", async () => {
		// Owner passes unconditionally, matching requireProjectPermission's
		// owner path. Personal projects are the case the old org-level
		// middleware skipped entirely, so this is the regression guard for
		// tightening the gate.
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: [],
			source: "owner",
			organizationId: null,
		});

		await expect(
			handler({ input: input(), context: ctx }),
		).resolves.toMatchObject({ workflowId: expect.any(String) });

		expect(mocks.workflowStart).toHaveBeenCalledTimes(1);
	});

	it("allows an org viewer who holds an editor role on the project", async () => {
		// The inverse error the org-level gate made: the org role lacks
		// DOCUMENT_UPDATE, but an active ProjectMember row is authoritative
		// and grants it.
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: ["DOCUMENT_UPDATE"],
			source: "project-member",
			organizationId: "org-1",
		});

		await expect(
			handler({ input: input(), context: ctx }),
		).resolves.toMatchObject({ workflowId: expect.any(String) });
	});

	it("reports a missing project as not-found rather than forbidden", async () => {
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue(null);

		await expect(
			handler({ input: input(), context: ctx }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("resolves permissions against the document's project, not caller input", async () => {
		await handler({ input: input(), context: ctx });

		expect(mocks.resolveEffectiveProjectPermissions).toHaveBeenCalledWith(
			PROJECT_ID,
			"user-1",
		);
	});
});

/**
 * The regenerate route must keep producing exactly the workflow arguments it
 * produced before the create flow added two optional fields to the shared
 * dispatch helper.
 *
 * This is the silent-drop case in reverse. The API starts the workflow by name
 * with untyped args, so nothing type-checks what lands in that object: a field
 * accidentally defaulted to `""` or `null` here would reach the workflow as a
 * present-but-empty source and could be joined into the run's context array as
 * an empty section — with every existing test still green.
 */
describe("generateDocumentProcedure — regeneration carries no supplied source", () => {
	it("sends neither supplied context nor an excluded-context id", async () => {
		await handler({ input: input(), context: ctx });

		const args = mocks.workflowStart.mock.calls[0]?.[1].args[0];
		expect(args.suppliedContext).toBeUndefined();
		expect(args.excludeContextId).toBeUndefined();
	});

	it("still passes the existing content, the prompt selection, and the project's organization", async () => {
		await handler({
			input: input({
				prompt: "tighten the risks section",
				promptId: "prompt-7",
				promptVersionId: "v2",
			}),
			context: ctx,
		});

		const args = mocks.workflowStart.mock.calls[0]?.[1].args[0];
		expect(args).toMatchObject({
			projectId: PROJECT_ID,
			documentId: DOCUMENT_ID,
			documentType: "PRD",
			userId: "user-1",
			// Taken from the document's own project record, never from caller
			// input — the same derivation the create flow uses.
			organizationId: "org-1",
			prompt: "tighten the risks section",
			promptId: "prompt-7",
			promptVersionId: "v2",
			currentDocument: "existing content",
		});
	});

	it("issues the AI token against the project's organization", async () => {
		await handler({ input: input(), context: ctx });

		expect(mocks.issueAIToken).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				organizationId: "org-1",
				source: "project-document-generation",
			}),
		);
	});
});

/**
 * The instruction ceiling, asserted here as well as on the create path.
 *
 * Both procedures feed the same generation run, so a bound declared on only one
 * of them is not a bound — a caller that wants an unbounded instruction string
 * simply uses the other door. That is why the constant lives in the shared
 * dispatch module rather than beside either schema, and why this test exists
 * despite being near-identical to the create-side one.
 */
describe("generateDocumentProcedure — instruction ceiling", () => {
	const parse = (prompt: string) =>
		(
			captured.inputSchema as {
				safeParse: (v: unknown) => { success: boolean };
			}
		).safeParse({ id: DOCUMENT_ID, prompt });

	it("accepts instructions exactly at the ceiling", () => {
		expect(parse("a".repeat(MAX_RUN_INSTRUCTIONS_CHARS)).success).toBe(
			true,
		);
	});

	it("refuses instructions one character over the ceiling", () => {
		expect(parse("a".repeat(MAX_RUN_INSTRUCTIONS_CHARS + 1)).success).toBe(
			false,
		);
	});
});

/**
 * The one workflow input a client must never reach.
 *
 * `skipDependencyWait` tells the run to generate without waiting for the
 * project's outstanding context work. It exists for a single in-process
 * Temporal caller — the ingestion workflow that spawns a generation as a child
 * of the extraction producing its source, and would otherwise deadlock on it.
 * Arriving through the API it is the "generate anyway" switch this feature
 * forbids, so the schema must not carry it and the dispatcher must not forward
 * it.
 */
describe("generateDocumentProcedure — skipDependencyWait is not a client input", () => {
	it("drops the flag at the schema boundary", () => {
		const parsed = (
			captured.inputSchema as {
				safeParse: (v: unknown) => {
					success: boolean;
					data?: Record<string, unknown>;
				};
			}
		).safeParse({
			id: DOCUMENT_ID,
			prompt: "",
			skipDependencyWait: true,
		});

		expect(parsed.success).toBe(true);
		expect(parsed.data?.skipDependencyWait).toBeUndefined();
	});

	it("never lets it reach the workflow arguments", async () => {
		await handler({
			input: input({ skipDependencyWait: true }),
			context: ctx,
		});

		const args = mocks.workflowStart.mock.calls[0]?.[1].args[0];
		expect(args.skipDependencyWait).toBeUndefined();
	});
});
