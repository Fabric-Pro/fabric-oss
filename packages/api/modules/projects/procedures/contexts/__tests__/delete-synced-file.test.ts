/**
 * `projects.contexts.deleteSyncedFile` and the shared `deleteSyncedContext`
 * behind it (Fizzy #2636) — the session twin of
 * `DELETE /api/v1/projects/:projectId/contexts/synced-files`, which
 * `fabric context push --prune` calls.
 *
 * What this pins:
 *  - authorization: visibility first (a project the caller cannot see is
 *    NOT_FOUND, exactly as a missing one), then CONTEXT_DELETE on the
 *    project, so the API is never broader than the Context tab's own delete
 *    and never says which hidden projects exist; the delete runs under the
 *    project's HOSTING organization;
 *  - validation: the path is normalised and a sha256 hash is required, before
 *    the database is reached;
 *  - the destructive steps run in `syncedContextDeletionWorkflow`, started
 *    with the correlation memo, the request's sanitized audit context and
 *    an operation id of the request's own (a fresh UUID), under the id
 *    `synced-context-deletion-<contextId>-<operationId>` — so a request can
 *    never attach to another request's run, open or closed; a path with no
 *    row answers `absent` without starting anything;
 *  - the workflow records the deletion (its audit row commits with the row
 *    delete) and publishes it to the realtime channels, so the request
 *    writes no audit row and emits nothing of its own: after `deleted` it
 *    only marks the call as curated, so the activity capture adds no
 *    generic row;
 *  - the wait is bounded by ONE deadline set when the call begins: a
 *    Temporal client, a start or a result that has not come by
 *    `SYNCED_CONTEXT_DELETE_WAIT_MS` after it answers `in-progress`;
 *  - a start that failed after Temporal may have accepted it is rejoined by
 *    this request's own workflow id, and only a workflow Temporal does not
 *    know answers "nothing was deleted";
 *  - `absent` and `conflict` record nothing, and a conflict answers 409 with
 *    who changed the file, never its content;
 *  - a failed step answers 500 saying what was and was not done.
 *
 * The workflow and its activities are covered in `@repo/temporal`
 * (`synced-context-deletion-workflow.test.ts`,
 * `synced-context-deletion-activities.test.ts`), and the queries in
 * `packages/database/__tests__/delete-context-by-source-path.test.ts`; here
 * the workflow's answer is driven directly.
 */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	resolveEffectiveProjectPermissions: vi.fn(),
	hasProjectAccess: vi.fn(),
	grantProjectAccess: vi.fn(),
	findSyncedContextIdAtPath: vi.fn(),
	findUser: vi.fn(),
	workflowStart: vi.fn(),
	workflowResult: vi.fn(),
	getHandle: vi.fn(),
	rejoinResult: vi.fn(),
	getTemporalClient: vi.fn(),
	recordAuditFromRequest: vi.fn(),
	auditRequestFields: vi.fn(),
	markCuratedAuditWritten: vi.fn(),
	emitContextChange: vi.fn(),
	emitActivity: vi.fn(),
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	captured: {
		inputSchema: undefined as unknown,
		/** The procedure's `.use(...)` middlewares, in declaration order. */
		middlewares: [] as unknown[],
	},
}));

vi.mock("@repo/database", async () => {
	// The pure helpers are the real ones: the path rules and the hash are part
	// of what the procedure promises.
	const path = await import(
		"@repo/database/prisma/queries/projects/context-source-path"
	);
	const hash = await import(
		"@repo/database/prisma/queries/projects/context-content-hash"
	);
	return {
		...path,
		...hash,
		hasProjectAccess: mocks.hasProjectAccess,
		grantProjectAccess: mocks.grantProjectAccess,
		findSyncedContextIdAtPath: mocks.findSyncedContextIdAtPath,
		upsertContextBySourcePath: vi.fn(),
		db: { user: { findUnique: mocks.findUser } },
	};
});

vi.mock("../../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions:
		mocks.resolveEffectiveProjectPermissions,
}));

// The contract's values, as `@repo/temporal` exports them from
// `src/lib/synced-context-deletion-contract.ts`.
vi.mock("@repo/temporal", () => ({
	getTemporalClient: mocks.getTemporalClient,
	SYNCED_CONTEXT_DELETION_TASK_QUEUE: "project-documents",
	SYNCED_CONTEXT_DELETION_FAILURE: {
		claim: "SYNCED_CONTEXT_CLAIM_FAILED",
		indexCleanup: "SYNCED_CONTEXT_INDEX_CLEANUP_FAILED",
		rowDelete: "SYNCED_CONTEXT_ROW_DELETE_FAILED",
	},
}));

// Marks the options it saw, so a start without the memo shows up.
vi.mock("../../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: <T extends object>(options: T) => ({
		...options,
		memo: { correlationId: "corr-1" },
	}),
}));

vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: mocks.recordAuditFromRequest,
	auditRequestFields: mocks.auditRequestFields,
}));

vi.mock("../../../../../orpc/middleware/audit-timing-middleware", () => ({
	markCuratedAuditWritten: mocks.markCuratedAuditWritten,
}));

vi.mock("../../../../../lib/realtime", () => ({
	emitContextChange: mocks.emitContextChange,
	emitActivity: mocks.emitActivity,
}));

vi.mock("@repo/logs", () => ({ logger: mocks.logger }));

// The builder records each `.use(...)` so `call()` can run the procedure's
// real middleware chain, in its declared order, before the handler: which
// gate answers first is part of what the procedure promises (visibility
// before permission, so an invisible project and a missing one cannot be
// told apart). `requireProjectPermission` is the real one.
vi.mock("../../../../../orpc/procedures", async () => {
	const { requireProjectPermission } = await vi.importActual<
		typeof import("../../../../../orpc/middleware/require-permission")
	>("../../../../../orpc/middleware/require-permission");
	const builder: Record<string, unknown> = {};
	builder.use = (middleware: unknown) => {
		mocks.captured.middlewares.push(middleware);
		return builder;
	};
	builder.route = () => builder;
	builder.input = (schema: unknown) => {
		mocks.captured.inputSchema = schema;
		return builder;
	};
	builder.handler = (fn: unknown) => ({ handler: fn });
	return {
		tenantProtectedProcedure: builder,
		requireProjectPermission,
	};
});

type Handler = (args: {
	input: {
		projectId: string;
		sourcePath: string;
		expectedContentHash?: string;
	};
	context: {
		user: { id: string; name?: string; email: string };
		session: { id: string; activeOrganizationId?: string | null };
	};
}) => Promise<Record<string, unknown>>;

async function loadHandler(): Promise<Handler> {
	const mod = await import("../delete-synced-file");
	return (mod.deleteSyncedFileProcedure as unknown as { handler: Handler })
		.handler;
}

type Parseable = {
	safeParse(input: unknown): {
		success: boolean;
		data?: Record<string, unknown>;
	};
};

async function inputSchema(): Promise<Parseable> {
	await loadHandler();
	return mocks.captured.inputSchema as Parseable;
}

const sha = (content: string) =>
	createHash("sha256").update(content, "utf8").digest("hex");

const CONTENT = "# Glossary\n\nA tenant is an organization.\n";
const HASH = sha(CONTENT);
const MAINTAINER_PERMISSIONS = [
	"context:read",
	"context:create",
	"context:update",
	"context:delete",
];

const requestContext = {
	user: { id: "user-1", name: "Example Dev", email: "dev@example.com" },
	session: { id: "sess-1", activeOrganizationId: "org-1" },
};

/** A workflow failure as `handle.result()` rejects with it. */
function workflowFailure(type: string): Error {
	const error = new Error("Workflow execution failed") as Error & {
		cause?: unknown;
	};
	error.name = "WorkflowFailedError";
	error.cause = Object.assign(new Error(`${type}: boom`), {
		name: "ApplicationFailure",
		type,
	});
	return error;
}

/** What `auditRequestFields` derived from the request: plain values. */
const AUDIT_FIELDS = {
	impersonatedById: null,
	ipAddress: "203.0.113.7",
	userAgent: "Mozilla/5.0",
	requestId: "req-1",
	sessionId: "sess-1",
	correlationId: "corr-1",
};

const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The workflow's input for the default call; the operation id is fresh. */
const WORKFLOW_INPUT = {
	projectId: "proj-1",
	sourcePath: "docs/glossary.md",
	expectedContentHash: HASH,
	userId: "user-1",
	organizationId: "org-host",
	operationId: expect.stringMatching(UUID),
	audit: { via: "web", ...AUDIT_FIELDS },
};

/** The options of the n-th `client.workflow.start` call. */
function started(call = 0): {
	workflowId: string;
	args: [{ operationId: string }];
	[key: string]: unknown;
} {
	return mocks.workflowStart.mock.calls[call][1];
}

/** An error with a gRPC status code, as `client.workflow.start` wraps one. */
function startError(code: number, details: string): Error {
	const cause = Object.assign(new Error(`${code} ${details}`), {
		code,
		details,
		metadata: {},
	});
	return Object.assign(new Error("Failed to start Workflow"), {
		name: "ServiceError",
		cause,
	});
}

function workflowNotFound(): Error {
	return Object.assign(new Error("Workflow not found"), {
		name: "WorkflowNotFoundError",
	});
}

const CLAIMED = {
	contextId: "ctx-1",
	qdrantId: "11111111-2222-3333-4444-555555555555",
	type: "TEXT",
	title: "glossary.md",
};

type Middleware = (
	options: {
		context: typeof requestContext;
		next: (options?: {
			context?: object;
		}) => Promise<{ output: unknown; context: object }>;
	},
	input: unknown,
) => Promise<{ output: unknown }>;

/**
 * Run the procedure as oRPC would: each recorded middleware in order, then
 * the handler, with the context a middleware hands `next` merged in.
 */
async function throughMiddleware(
	input: Parameters<Handler>[0]["input"],
): Promise<Record<string, unknown>> {
	const handler = await loadHandler();
	const chain = mocks.captured.middlewares as Middleware[];
	const run = async (
		index: number,
		context: typeof requestContext,
	): Promise<{ output: unknown; context: object }> => {
		const middleware = chain[index];
		if (!middleware) {
			return { output: await handler({ input, context }), context: {} };
		}
		return (await middleware(
			{
				context,
				next: (options) =>
					run(
						index + 1,
						options?.context
							? { ...context, ...options.context }
							: context,
					),
			},
			input,
		)) as { output: unknown; context: object };
	};
	return (await run(0, requestContext)).output as Record<string, unknown>;
}

async function call(input: Partial<Parameters<Handler>[0]["input"]> = {}) {
	return throughMiddleware({
		projectId: "proj-1",
		sourcePath: "./docs\\glossary.md",
		expectedContentHash: HASH,
		...input,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	// The real permission middleware records a guest's carve-out on the
	// request context; start every case from the context as sent.
	Reflect.deleteProperty(requestContext, "allowedProjectIds");
	mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
		permissions: MAINTAINER_PERMISSIONS,
		source: "project-member",
		organizationId: "org-host",
	});
	mocks.hasProjectAccess.mockResolvedValue(true);
	mocks.findSyncedContextIdAtPath.mockResolvedValue("ctx-1");
	mocks.workflowResult.mockResolvedValue({
		status: "deleted",
		context: CLAIMED,
	});
	mocks.workflowStart.mockImplementation(async () => ({
		workflowId: "synced-context-deletion-ctx-1",
		result: mocks.workflowResult,
	}));
	mocks.findUser.mockResolvedValue({ id: "user-2", name: "Other Dev" });
	mocks.getHandle.mockImplementation((workflowId: string) => ({
		workflowId,
		result: mocks.rejoinResult,
	}));
	mocks.rejoinResult.mockRejectedValue(workflowNotFound());
	mocks.getTemporalClient.mockResolvedValue({
		workflow: { start: mocks.workflowStart, getHandle: mocks.getHandle },
	});
	mocks.auditRequestFields.mockReturnValue(AUDIT_FIELDS);
	mocks.emitContextChange.mockResolvedValue(undefined);
	mocks.emitActivity.mockResolvedValue(undefined);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("deleteSyncedFile — authorization", () => {
	it("refuses a caller without CONTEXT_DELETE (an Editor who may only add) before anything is read", async () => {
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: ["context:read", "context:create", "context:update"],
			source: "project-member",
			organizationId: "org-host",
		});

		await expect(call()).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: expect.stringMatching(/context:delete/),
		});
		expect(mocks.findSyncedContextIdAtPath).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
		expect(mocks.recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("answers an org member whose org role grants CONTEXT_DELETE on a project hidden from them as if the project did not exist", async () => {
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: MAINTAINER_PERMISSIONS,
			source: "org",
			organizationId: "org-host",
		});
		mocks.hasProjectAccess.mockResolvedValue(false);

		await expect(call()).rejects.toMatchObject({
			code: "NOT_FOUND",
			message: "Project not found",
		});
		expect(mocks.hasProjectAccess).toHaveBeenCalledWith("proj-1", "user-1");
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("answers NOT_FOUND for a project that does not exist", async () => {
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue(null);

		await expect(call()).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("deletes under the project's hosting organization, never the session's", async () => {
		await call();

		expect(mocks.findSyncedContextIdAtPath).toHaveBeenCalledWith({
			projectId: "proj-1",
			// Normalised: backslash and leading ./ gone.
			sourcePath: "docs/glossary.md",
			userId: "user-1",
			organizationId: "org-host",
		});
		expect(mocks.workflowStart.mock.calls[0][1].args).toEqual([
			WORKFLOW_INPUT,
		]);
	});

	it("refuses a project with no organization instead of reaching the personal arm", async () => {
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: MAINTAINER_PERMISSIONS,
			source: "owner",
			organizationId: null,
		});

		await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.findSyncedContextIdAtPath).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});
});

describe("deleteSyncedFile — visibility is decided before permission", () => {
	// A permission refusal says the project exists. Answering it to a caller
	// who cannot see the project would tell them which ids are real in
	// organizations they do not belong to, so visibility answers first, and
	// in exactly the words a missing project gets.

	it("answers an existing project in another organization exactly as it answers an id that does not exist", async () => {
		// The project exists, so the permission resolver finds it (and grants
		// this outsider nothing); the caller cannot see it.
		mocks.hasProjectAccess.mockResolvedValue(false);
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: [],
			source: "none",
			organizationId: "org-other",
		});
		const foreign = (await call({ projectId: "proj-foreign" }).catch(
			(caught: unknown) => caught,
		)) as { code: string; status: number; message: string };

		mocks.resolveEffectiveProjectPermissions.mockResolvedValue(null);
		const missing = (await call({ projectId: "proj-missing" }).catch(
			(caught: unknown) => caught,
		)) as { code: string; status: number; message: string };

		expect(foreign).toMatchObject({
			code: "NOT_FOUND",
			message: "Project not found",
		});
		expect({
			code: foreign.code,
			status: foreign.status,
			message: foreign.message,
		}).toEqual({
			code: missing.code,
			status: missing.status,
			message: missing.message,
		});
		// Decided on visibility alone: the permission was never evaluated.
		expect(mocks.resolveEffectiveProjectPermissions).not.toHaveBeenCalled();
		expect(mocks.findSyncedContextIdAtPath).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("still answers FORBIDDEN, naming the permission, to a caller who can see the project but may not delete from it", async () => {
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: ["context:read", "context:create", "context:update"],
			source: "project-member",
			organizationId: "org-host",
		});

		await expect(call()).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: "Missing required permission: context:delete",
		});
		expect(mocks.hasProjectAccess).toHaveBeenCalledWith("proj-1", "user-1");
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});
});

describe("deleteSyncedFile — validation", () => {
	it("requires a sha256 expectedContentHash in the input schema", async () => {
		const schema = await inputSchema();

		expect(
			schema.safeParse({ projectId: "proj-1", sourcePath: "a.md" })
				.success,
		).toBe(false);
		expect(
			schema.safeParse({
				projectId: "proj-1",
				sourcePath: "a.md",
				expectedContentHash: "not-a-hash",
			}).success,
		).toBe(false);
		expect(
			schema.safeParse({
				projectId: "proj-1",
				sourcePath: "a.md",
				expectedContentHash: HASH,
			}).success,
		).toBe(true);
	});

	it("requires the hash in the shared function too, before the database", async () => {
		await expect(
			call({ expectedContentHash: undefined }),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringMatching(/expectedContentHash/),
		});
		expect(mocks.findSyncedContextIdAtPath).not.toHaveBeenCalled();
	});

	it("reads an upper-case hash as the same hash", async () => {
		await call({ expectedContentHash: HASH.toUpperCase() });

		expect(mocks.workflowStart.mock.calls[0][1].args[0]).toMatchObject({
			expectedContentHash: HASH,
		});
	});

	it("refuses a path the path rules refuse as a 400", async () => {
		await expect(
			call({ sourcePath: "../outside.md" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.findSyncedContextIdAtPath).not.toHaveBeenCalled();
	});
});

describe("deleteSyncedFile — the durable delete", () => {
	it("starts the deletion workflow for the row at the path, named by the row and the version, with the correlation memo, the operation id and the audit context, and waits for it", async () => {
		await call();

		expect(mocks.workflowStart).toHaveBeenCalledTimes(1);
		const [workflowType, options] = mocks.workflowStart.mock.calls[0];
		expect(workflowType).toBe("syncedContextDeletionWorkflow");
		const { operationId } = options.args[0];
		expect(options).toEqual({
			taskQueue: "project-documents",
			// This request's own run: never shared, never joined.
			workflowId: `synced-context-deletion-ctx-1-${operationId}`,
			args: [WORKFLOW_INPUT],
			memo: { correlationId: "corr-1" },
		});
		expect(operationId).toMatch(UUID);
		// No conflict policy: an id no other request uses cannot conflict.
		expect(options).not.toHaveProperty("workflowIdConflictPolicy");
		// Derived from this request, as plain values.
		expect(mocks.auditRequestFields).toHaveBeenCalledWith(requestContext);
		expect(mocks.workflowResult).toHaveBeenCalledTimes(1);
		expect(mocks.getHandle).not.toHaveBeenCalled();
	});

	it("answers deleted writing no audit row and emitting nothing of its own: the workflow recorded and published it", async () => {
		const result = await call();

		expect(result).toEqual({
			status: "deleted",
			contextId: "ctx-1",
			sourcePath: "docs/glossary.md",
			contentHash: HASH,
		});
		expect(mocks.recordAuditFromRequest).not.toHaveBeenCalled();
		// A curated row exists for this call, so the activity capture adds
		// no generic `activity.*` row beside it.
		expect(mocks.markCuratedAuditWritten).toHaveBeenCalledTimes(1);
		// The workflow's last activity publishes the delete, so a delete that
		// finishes after this request answered in-progress, or whose request
		// died, is still seen; the request is not a second publisher.
		expect(mocks.emitContextChange).not.toHaveBeenCalled();
		expect(mocks.emitActivity).not.toHaveBeenCalled();
	});

	it("answers absent without starting anything when no row is at the path", async () => {
		mocks.findSyncedContextIdAtPath.mockResolvedValue(null);

		const result = await call();

		expect(result).toEqual({
			status: "absent",
			sourcePath: "docs/glossary.md",
		});
		expect(mocks.getTemporalClient).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
		expect(mocks.markCuratedAuditWritten).not.toHaveBeenCalled();
		expect(mocks.emitContextChange).not.toHaveBeenCalled();
	});

	it("answers the workflow's absent, and records nothing, when the row went before it was claimed", async () => {
		mocks.workflowResult.mockResolvedValue({ status: "absent" });

		const result = await call();

		expect(result).toEqual({
			status: "absent",
			sourcePath: "docs/glossary.md",
		});
		expect(mocks.recordAuditFromRequest).not.toHaveBeenCalled();
		expect(mocks.markCuratedAuditWritten).not.toHaveBeenCalled();
		expect(mocks.emitContextChange).not.toHaveBeenCalled();
	});

	it("answers a conflict with 409, the stored hash and who changed it — never the content", async () => {
		mocks.workflowResult.mockResolvedValue({
			status: "conflict",
			current: {
				contextId: "ctx-1",
				contentHash: sha("someone else's version\n"),
				// As it crosses Temporal's payload converter.
				contentUpdatedAt: "2026-09-22T11:00:00.000Z",
				contentUpdatedByUserId: "user-2",
			},
		});

		const error = await call().catch((caught: unknown) => caught);

		expect(error).toMatchObject({
			code: "CONFLICT",
			data: {
				status: "conflict",
				contextId: "ctx-1",
				sourcePath: "docs/glossary.md",
				// The version this call named.
				contentHash: HASH,
				current: {
					contextId: "ctx-1",
					contentHash: sha("someone else's version\n"),
					contentUpdatedAt: new Date("2026-09-22T11:00:00Z"),
					contentUpdatedBy: { id: "user-2", name: "Other Dev" },
				},
			},
		});
		expect((error as Error).message).toMatch(/nothing was deleted/i);
		expect(mocks.markCuratedAuditWritten).not.toHaveBeenCalled();
		expect(mocks.emitContextChange).not.toHaveBeenCalled();
	});

	it("answers 500 saying nothing was deleted, and records nothing, when the index cleanup failed", async () => {
		mocks.workflowResult.mockRejectedValue(
			workflowFailure("SYNCED_CONTEXT_INDEX_CLEANUP_FAILED"),
		);

		await expect(call()).rejects.toMatchObject({
			code: "INTERNAL_SERVER_ERROR",
			message:
				"Could not remove this file from the search index, so nothing was deleted. Try again.",
		});
		expect(mocks.markCuratedAuditWritten).not.toHaveBeenCalled();
		expect(mocks.emitContextChange).not.toHaveBeenCalled();
		expect(mocks.logger.error).toHaveBeenCalled();
	});

	it("answers 500 saying nothing was deleted when the claim failed", async () => {
		mocks.workflowResult.mockRejectedValue(
			workflowFailure("SYNCED_CONTEXT_CLAIM_FAILED"),
		);

		await expect(call()).rejects.toMatchObject({
			code: "INTERNAL_SERVER_ERROR",
			message:
				"Could not delete this file, and nothing was deleted. Try again.",
		});
		expect(mocks.markCuratedAuditWritten).not.toHaveBeenCalled();
	});

	it("answers 500 saying the file left search but was not deleted when the row delete failed", async () => {
		mocks.workflowResult.mockRejectedValue(
			workflowFailure("SYNCED_CONTEXT_ROW_DELETE_FAILED"),
		);

		const error = (await call().catch((caught: unknown) => caught)) as {
			code: string;
			message: string;
		};

		expect(error.code).toBe("INTERNAL_SERVER_ERROR");
		expect(error.message).toMatch(/search index/i);
		expect(error.message).not.toMatch(/nothing was deleted/i);
		expect(mocks.markCuratedAuditWritten).not.toHaveBeenCalled();
	});

	it("lets any other workflow failure through unchanged", async () => {
		const unexpected = new Error("terminated");
		mocks.workflowResult.mockRejectedValue(unexpected);

		await expect(call()).rejects.toBe(unexpected);
		expect(mocks.markCuratedAuditWritten).not.toHaveBeenCalled();
	});
});

describe("deleteSyncedFile — the wait is bounded", () => {
	it("answers in-progress after SYNCED_CONTEXT_DELETE_WAIT_MS, leaving the workflow running and recording nothing", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const { SYNCED_CONTEXT_DELETE_WAIT_MS } = await import(
			"../../../lib/delete-synced-context"
		);
		expect(SYNCED_CONTEXT_DELETE_WAIT_MS).toBe(45_000);
		let settle: (value: unknown) => void = () => undefined;
		mocks.workflowResult.mockImplementation(
			() =>
				new Promise((resolve) => {
					settle = resolve;
				}),
		);
		let answered = false;
		const pending = call().then((result) => {
			answered = true;
			return result;
		});

		await vi.advanceTimersByTimeAsync(SYNCED_CONTEXT_DELETE_WAIT_MS - 1);
		expect(answered).toBe(false);
		await vi.advanceTimersByTimeAsync(1);

		expect(await pending).toEqual({
			status: "in-progress",
			sourcePath: "docs/glossary.md",
		});
		expect(mocks.logger.warn).toHaveBeenCalledWith(
			expect.stringContaining(started().workflowId),
		);
		expect(mocks.markCuratedAuditWritten).not.toHaveBeenCalled();
		expect(mocks.emitContextChange).not.toHaveBeenCalled();
		expect(mocks.emitActivity).not.toHaveBeenCalled();
		// It finishes later on its own; nothing waits for it any more.
		settle({ status: "deleted", context: CLAIMED });
		await vi.advanceTimersByTimeAsync(0);
		expect(mocks.emitContextChange).not.toHaveBeenCalled();
	});

	it("does not leave a late workflow failure unhandled once it answered in-progress", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		let fail: (error: unknown) => void = () => undefined;
		mocks.workflowResult.mockImplementation(
			() =>
				new Promise((_resolve, reject) => {
					fail = reject;
				}),
		);
		const unhandled = vi.fn();
		process.on("unhandledRejection", unhandled);
		try {
			const pending = call();
			await vi.advanceTimersByTimeAsync(45_000);
			expect((await pending).status).toBe("in-progress");

			fail(workflowFailure("SYNCED_CONTEXT_ROW_DELETE_FAILED"));
			await vi.advanceTimersByTimeAsync(0);
			await new Promise((resolve) => setImmediate(resolve));
			expect(unhandled).not.toHaveBeenCalled();
		} finally {
			process.off("unhandledRejection", unhandled);
		}
	});

	it("answers as soon as the workflow does, and clears its timer", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

		const result = await call();

		expect(result.status).toBe("deleted");
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("deleteSyncedFile — a start whose outcome is unknown", () => {
	it("rejoins the workflow by its id when the start failed after Temporal may have accepted it, and answers what it answers", async () => {
		mocks.workflowStart.mockRejectedValue(
			startError(14, "Connection dropped"),
		);
		mocks.rejoinResult.mockResolvedValue({
			status: "deleted",
			context: CLAIMED,
		});

		const result = await call();

		expect(mocks.getHandle).toHaveBeenCalledWith(started().workflowId);
		expect(result).toEqual({
			status: "deleted",
			contextId: "ctx-1",
			sourcePath: "docs/glossary.md",
			contentHash: HASH,
		});
		expect(mocks.markCuratedAuditWritten).toHaveBeenCalledTimes(1);
		expect(mocks.emitContextChange).not.toHaveBeenCalled();
	});

	it("answers 500 saying nothing was deleted only when the rejoined workflow does not exist", async () => {
		mocks.workflowStart.mockRejectedValue(new Error("connection refused"));
		mocks.rejoinResult.mockRejectedValue(workflowNotFound());

		await expect(call()).rejects.toMatchObject({
			code: "INTERNAL_SERVER_ERROR",
			message:
				"Could not delete this file, and nothing was deleted. Try again.",
		});
		expect(mocks.getHandle).toHaveBeenCalledWith(started().workflowId);
		expect(mocks.logger.error).toHaveBeenCalled();
		expect(mocks.markCuratedAuditWritten).not.toHaveBeenCalled();
	});

	it("answers in-progress when the rejoined workflow has not answered within the wait either", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		mocks.workflowStart.mockRejectedValue(
			startError(4, "Deadline exceeded"),
		);
		mocks.rejoinResult.mockImplementation(
			() => new Promise(() => undefined),
		);

		const pending = call();
		await vi.advanceTimersByTimeAsync(45_000);

		expect(await pending).toEqual({
			status: "in-progress",
			sourcePath: "docs/glossary.md",
		});
	});

	it("answers 500 saying nothing was deleted, without rejoining, when Temporal refused the start's arguments", async () => {
		mocks.workflowStart.mockRejectedValue(
			startError(3, "WorkflowId length exceeds limit"),
		);

		await expect(call()).rejects.toMatchObject({
			code: "INTERNAL_SERVER_ERROR",
			message: expect.stringMatching(/nothing was deleted/i),
		});
		expect(mocks.getHandle).not.toHaveBeenCalled();
	});

	it("answers 500 saying nothing was deleted, without rejoining, when the client refused the options before sending", async () => {
		mocks.workflowStart.mockRejectedValue(
			new TypeError("taskQueue is required"),
		);

		await expect(call()).rejects.toMatchObject({
			code: "INTERNAL_SERVER_ERROR",
			message: expect.stringMatching(/nothing was deleted/i),
		});
		expect(mocks.getHandle).not.toHaveBeenCalled();
	});

	it("answers 500 saying nothing was deleted when no Temporal client could be had, so nothing was sent", async () => {
		mocks.getTemporalClient.mockRejectedValue(new Error("ECONNREFUSED"));

		await expect(call()).rejects.toMatchObject({
			code: "INTERNAL_SERVER_ERROR",
			message: expect.stringMatching(/nothing was deleted/i),
		});
		expect(mocks.workflowStart).not.toHaveBeenCalled();
		expect(mocks.getHandle).not.toHaveBeenCalled();
		expect(mocks.logger.error).toHaveBeenCalled();
	});
});

describe("deleteSyncedFile — every request runs its own workflow", () => {
	/**
	 * A fake Temporal that keeps every execution it accepted, per workflow
	 * id, as a server does: `getHandle(id).result()` follows the most recent
	 * execution under the id, closed or not, and fails not-found only when
	 * there is none.
	 */
	function fakeTemporal() {
		const executions = new Map<string, Array<{ answer: unknown }>>();
		const accept = (workflowId: string, answer: unknown) => {
			const runs = executions.get(workflowId) ?? [];
			runs.push({ answer });
			executions.set(workflowId, runs);
		};
		mocks.getHandle.mockImplementation((workflowId: string) => ({
			workflowId,
			result: async () => {
				const runs = executions.get(workflowId);
				if (!runs?.length) {
					throw workflowNotFound();
				}
				return runs[runs.length - 1].answer;
			},
		}));
		return { executions, accept };
	}

	it("gives every request a fresh operation id and a workflow id of its own, so two deletes of the same version are two runs", async () => {
		await call();
		await call();

		const first = started(0);
		const second = started(1);
		expect(first.args[0].operationId).toMatch(UUID);
		expect(second.args[0].operationId).toMatch(UUID);
		expect(second.args[0].operationId).not.toBe(first.args[0].operationId);
		expect(second.workflowId).not.toBe(first.workflowId);
		for (const options of [first, second]) {
			expect(options.workflowId).toBe(
				`synced-context-deletion-ctx-1-${options.args[0].operationId}`,
			);
		}
	});

	it("never answers from an older closed run of the same row and version when its own start never landed: nothing was deleted, not absent", async () => {
		const temporal = fakeTemporal();
		// An earlier request's run: the row moved after its claim, so it
		// answered absent and closed. The row has since moved back, holding
		// the same version, so this request names the same row and hash.
		mocks.workflowStart.mockImplementationOnce(
			async (_type: string, options: { workflowId: string }) => {
				temporal.accept(options.workflowId, { status: "absent" });
				return {
					workflowId: options.workflowId,
					result: async () => ({ status: "absent" }),
				};
			},
		);
		expect((await call()).status).toBe("absent");
		// This request's start fails before Temporal ever accepted it.
		mocks.workflowStart.mockRejectedValueOnce(
			startError(14, "Connection dropped"),
		);

		const error = await call().catch((caught: unknown) => caught);

		// Rejoining the older run would have said absent, and the CLI would
		// have dropped the lock entry of a row that still exists.
		expect(error).toMatchObject({
			code: "INTERNAL_SERVER_ERROR",
			message:
				"Could not delete this file, and nothing was deleted. Try again.",
		});
		expect(mocks.getHandle).toHaveBeenCalledTimes(1);
		expect(mocks.getHandle).toHaveBeenCalledWith(started(1).workflowId);
		expect(started(1).workflowId).not.toBe(started(0).workflowId);
		expect(temporal.executions.get(started(1).workflowId)).toBeUndefined();
	});

	it("answers from its own fresh run when its start landed but the acknowledgement was lost, whatever older run the row has", async () => {
		const temporal = fakeTemporal();
		mocks.workflowStart.mockImplementationOnce(
			async (_type: string, options: { workflowId: string }) => {
				temporal.accept(options.workflowId, { status: "absent" });
				return {
					workflowId: options.workflowId,
					result: async () => ({ status: "absent" }),
				};
			},
		);
		expect((await call()).status).toBe("absent");
		mocks.workflowStart.mockImplementationOnce(
			async (_type: string, options: { workflowId: string }) => {
				temporal.accept(options.workflowId, {
					status: "deleted",
					context: CLAIMED,
				});
				throw startError(4, "Deadline exceeded");
			},
		);

		const result = await call();

		expect(result).toEqual({
			status: "deleted",
			contextId: "ctx-1",
			sourcePath: "docs/glossary.md",
			contentHash: HASH,
		});
		expect(mocks.getHandle).toHaveBeenCalledWith(started(1).workflowId);
		expect(temporal.executions.get(started(0).workflowId)).toHaveLength(1);
		expect(temporal.executions.get(started(1).workflowId)).toHaveLength(1);
	});
});

describe("deleteSyncedFile — the wait is one absolute deadline", () => {
	/** A promise that settles only when fake time reaches `ms` from now. */
	function settleAfter<T>(ms: number, value: T): Promise<T> {
		return new Promise((resolve) => setTimeout(() => resolve(value), ms));
	}

	it("answers in-progress 45 s after the call began, counting a slow Temporal connection against the same budget", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		mocks.getTemporalClient.mockImplementation(() =>
			settleAfter(20_000, {
				workflow: {
					start: mocks.workflowStart,
					getHandle: mocks.getHandle,
				},
			}),
		);
		mocks.workflowResult.mockImplementation(
			() => new Promise(() => undefined),
		);
		let answered = false;
		const pending = call().then((result) => {
			answered = true;
			return result;
		});

		await vi.advanceTimersByTimeAsync(20_000);
		expect(mocks.workflowStart).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(24_999);
		expect(answered).toBe(false);
		await vi.advanceTimersByTimeAsync(1);

		// 45 s from the call, not 45 s after the client came (65 s).
		expect(answered).toBe(true);
		expect(await pending).toEqual({
			status: "in-progress",
			sourcePath: "docs/glossary.md",
		});
		expect(vi.getTimerCount()).toBe(0);
	});

	it("answers in-progress, and starts nothing afterwards, when the Temporal connection alone outlasts the deadline", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		mocks.getTemporalClient.mockImplementation(() =>
			settleAfter(60_000, {
				workflow: {
					start: mocks.workflowStart,
					getHandle: mocks.getHandle,
				},
			}),
		);

		const pending = call();
		await vi.advanceTimersByTimeAsync(45_000);

		expect(await pending).toEqual({
			status: "in-progress",
			sourcePath: "docs/glossary.md",
		});
		await vi.advanceTimersByTimeAsync(15_000);
		expect(mocks.workflowStart).not.toHaveBeenCalled();
		expect(mocks.markCuratedAuditWritten).not.toHaveBeenCalled();
	});

	it("answers the known conflict with no editor, never in-progress, when looking up who changed it outlasts the deadline", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		mocks.workflowResult.mockImplementation(() =>
			settleAfter(44_000, {
				status: "conflict",
				current: {
					contextId: "ctx-1",
					contentHash: sha("someone else's version\n"),
					contentUpdatedAt: "2026-09-22T11:00:00.000Z",
					contentUpdatedByUserId: "user-2",
				},
			}),
		);
		// The editor lookup never comes back.
		mocks.findUser.mockImplementation(() => new Promise(() => undefined));
		let settled = false;
		const pending = call().then(
			(result) => {
				settled = true;
				return result;
			},
			(caught: unknown) => {
				settled = true;
				return caught;
			},
		);

		await vi.advanceTimersByTimeAsync(44_000);
		expect(mocks.findUser).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(999);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);

		// 45 s from the call: the conflict is known, only its editor is not.
		expect(settled).toBe(true);
		expect(await pending).toMatchObject({
			code: "CONFLICT",
			data: {
				status: "conflict",
				contextId: "ctx-1",
				sourcePath: "docs/glossary.md",
				contentHash: HASH,
				current: {
					contextId: "ctx-1",
					contentHash: sha("someone else's version\n"),
					contentUpdatedAt: new Date("2026-09-22T11:00:00Z"),
					contentUpdatedBy: null,
				},
			},
		});
		expect(vi.getTimerCount()).toBe(0);
	});

	it("answers in-progress, never nothing-was-deleted, when the start has not been acknowledged by the deadline", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		let failStart: (error: unknown) => void = () => undefined;
		mocks.workflowStart.mockImplementation(
			() =>
				new Promise((_resolve, reject) => {
					failStart = reject;
				}),
		);
		const unhandled = vi.fn();
		process.on("unhandledRejection", unhandled);
		try {
			const pending = call();
			await vi.advanceTimersByTimeAsync(45_000);

			// The start may or may not have reached Temporal; the next run
			// reconciles through absent or deleted.
			expect(await pending).toEqual({
				status: "in-progress",
				sourcePath: "docs/glossary.md",
			});
			expect(mocks.getHandle).not.toHaveBeenCalled();

			// Its late failure is nobody's to handle any more.
			failStart(startError(14, "Connection dropped"));
			await vi.advanceTimersByTimeAsync(0);
			await new Promise((resolve) => setImmediate(resolve));
			expect(unhandled).not.toHaveBeenCalled();
			expect(mocks.getHandle).not.toHaveBeenCalled();
		} finally {
			process.off("unhandledRejection", unhandled);
		}
	});
});
