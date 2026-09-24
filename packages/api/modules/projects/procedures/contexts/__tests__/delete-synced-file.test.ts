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
 *  - the delete is synchronous and row-first (Living Memory design
 *    2026-09-23 §6): ONE call to `deleteSyncedContextRow`, which deletes the
 *    row, queues its vector cleanup and writes its audit row in one
 *    transaction, under an operation id of the request's own; no workflow;
 *  - after `deleted`: ONE bounded attempt to drain the queued cleanup record
 *    with the sweep's own drain, whose failure or timeout is logged and left
 *    to the sweep and never fails the request; then the two realtime events
 *    the old workflow's publish step emitted; the call is marked curated so
 *    the activity capture adds no generic row;
 *  - every answer is final: `deleted`, `absent`, a 409 CONFLICT with who
 *    changed the file (never its content), or a CONFLICT with
 *    `data.code: "REPOSITORY_MANAGED"` naming the repository and branch;
 *    `in-progress` is never produced; nothing is drained or published for
 *    anything but `deleted`.
 *
 * `deleteSyncedContextRow` itself is covered in
 * `packages/database/__tests__/delete-synced-context-row.test.ts`; here its
 * answer is driven directly.
 */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	resolveEffectiveProjectPermissions: vi.fn(),
	hasProjectAccess: vi.fn(),
	grantProjectAccess: vi.fn(),
	deleteSyncedContextRow: vi.fn(),
	drainPendingVectorCleanup: vi.fn(),
	findUser: vi.fn(),
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
		deleteSyncedContextRow: mocks.deleteSyncedContextRow,
		upsertContextBySourcePath: vi.fn(),
		db: { user: { findUnique: mocks.findUser } },
	};
});

vi.mock("../../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions:
		mocks.resolveEffectiveProjectPermissions,
}));

// Nothing here may start a workflow; the upsert module beside it imports the
// client, so it is stubbed to prove it is never reached.
vi.mock("@repo/temporal", () => ({
	getTemporalClient: mocks.getTemporalClient,
}));

vi.mock("@repo/temporal/delete-channel-context", () => ({
	drainPendingVectorCleanup: mocks.drainPendingVectorCleanup,
}));

vi.mock("../../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: <T extends object>(options: T) => options,
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

/** The deleted row, as `deleteSyncedContextRow` hands it back. */
const DELETED_ROW = {
	id: "ctx-1",
	projectId: "proj-1",
	type: "TEXT",
	sourcePath: "docs/glossary.md",
	contentHash: HASH,
	metadata: { title: "Glossary", sourcePath: "docs/glossary.md" },
	sourceTitle: null,
	originalFilename: null,
	contentUpdatedAt: new Date("2026-09-20T09:00:00Z"),
	contentUpdatedByUserId: "user-1",
	updatedAt: new Date("2026-09-20T09:00:00Z"),
	repositorySyncId: null,
	qdrantId: "11111111-2222-3333-4444-555555555555",
};

const DELETED = {
	status: "deleted",
	context: DELETED_ROW,
	cleanupId: "cleanup-1",
};

/** The input `deleteSyncedContextRow` gets for the default call. */
const ROW_DELETE_INPUT = {
	projectId: "proj-1",
	organizationId: "org-host",
	sourcePath: "docs/glossary.md",
	expectedContentHash: HASH,
	userId: "user-1",
	operationId: expect.stringMatching(UUID),
	audit: { via: "web", ...AUDIT_FIELDS },
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
	mocks.deleteSyncedContextRow.mockResolvedValue(DELETED);
	mocks.drainPendingVectorCleanup.mockResolvedValue(undefined);
	mocks.findUser.mockResolvedValue({ id: "user-2", name: "Other Dev" });
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
		expect(mocks.deleteSyncedContextRow).not.toHaveBeenCalled();
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
		expect(mocks.deleteSyncedContextRow).not.toHaveBeenCalled();
	});

	it("answers NOT_FOUND for a project that does not exist", async () => {
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue(null);

		await expect(call()).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.deleteSyncedContextRow).not.toHaveBeenCalled();
	});

	it("deletes under the project's hosting organization, never the session's", async () => {
		await call();

		expect(mocks.deleteSyncedContextRow).toHaveBeenCalledWith(
			ROW_DELETE_INPUT,
		);
	});

	it("refuses a project with no organization instead of reaching the personal arm", async () => {
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: MAINTAINER_PERMISSIONS,
			source: "owner",
			organizationId: null,
		});

		await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.deleteSyncedContextRow).not.toHaveBeenCalled();
	});
});

describe("deleteSyncedFile — visibility is decided before permission", () => {
	// A permission refusal says the project exists. Answering it to a caller
	// who cannot see the project would tell them which ids are real in
	// organizations they do not belong to, so visibility answers first, and
	// in exactly the words a missing project gets.

	it("answers an existing project in another organization exactly as it answers an id that does not exist", async () => {
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
		expect(mocks.deleteSyncedContextRow).not.toHaveBeenCalled();
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
		expect(mocks.deleteSyncedContextRow).not.toHaveBeenCalled();
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
		expect(mocks.deleteSyncedContextRow).not.toHaveBeenCalled();
	});

	it("reads an upper-case hash as the same hash", async () => {
		await call({ expectedContentHash: HASH.toUpperCase() });

		expect(mocks.deleteSyncedContextRow).toHaveBeenCalledWith(
			expect.objectContaining({ expectedContentHash: HASH }),
		);
	});

	it("refuses a path the path rules refuse as a 400", async () => {
		await expect(
			call({ sourcePath: "../outside.md" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.deleteSyncedContextRow).not.toHaveBeenCalled();
	});
});

describe("deleteSyncedFile — synchronous and row-first", () => {
	it("deletes through deleteSyncedContextRow once, with the request's own operation id and audit context, and starts no workflow", async () => {
		await call();

		expect(mocks.deleteSyncedContextRow).toHaveBeenCalledTimes(1);
		const [args] = mocks.deleteSyncedContextRow.mock.calls[0];
		expect(args).toEqual(ROW_DELETE_INPUT);
		// The v1 route and this procedure address a path, not a row.
		expect(args).not.toHaveProperty("contextId");
		expect(mocks.auditRequestFields).toHaveBeenCalledWith(requestContext);
		expect(mocks.getTemporalClient).not.toHaveBeenCalled();
	});

	it("gives every request a fresh operation id", async () => {
		await call();
		await call();

		const first = mocks.deleteSyncedContextRow.mock.calls[0][0].operationId;
		const second =
			mocks.deleteSyncedContextRow.mock.calls[1][0].operationId;
		expect(first).toMatch(UUID);
		expect(second).toMatch(UUID);
		expect(second).not.toBe(first);
	});

	it("answers deleted, drains the cleanup record the delete queued, then publishes the two events", async () => {
		const result = await call();

		expect(result).toEqual({
			status: "deleted",
			contextId: "ctx-1",
			sourcePath: "docs/glossary.md",
			contentHash: HASH,
		});
		expect(mocks.drainPendingVectorCleanup).toHaveBeenCalledTimes(1);
		expect(mocks.drainPendingVectorCleanup).toHaveBeenCalledWith({
			id: "cleanup-1",
			projectId: "proj-1",
			contextIds: ["ctx-1"],
			userId: null,
			organizationId: "org-host",
		});
		expect(mocks.emitContextChange).toHaveBeenCalledTimes(1);
		expect(mocks.emitContextChange).toHaveBeenCalledWith({
			projectId: "proj-1",
			contextId: "ctx-1",
			action: "deleted",
			userId: "user-1",
			userName: "Example Dev",
			contextType: "TEXT",
			contextName: "Glossary",
		});
		expect(mocks.emitActivity).toHaveBeenCalledTimes(1);
		expect(mocks.emitActivity).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "proj-1",
				activityType: "context_deleted",
				resourceType: "context",
				resourceId: "ctx-1",
				resourceName: "Glossary",
			}),
		);
		// Row, then drain, then publish.
		expect(
			mocks.deleteSyncedContextRow.mock.invocationCallOrder[0],
		).toBeLessThan(
			mocks.drainPendingVectorCleanup.mock.invocationCallOrder[0],
		);
		expect(
			mocks.drainPendingVectorCleanup.mock.invocationCallOrder[0],
		).toBeLessThan(mocks.emitContextChange.mock.invocationCallOrder[0]);
		// The curated audit row committed with the delete: the activity
		// capture adds no generic row, and the request writes none of its own.
		expect(mocks.markCuratedAuditWritten).toHaveBeenCalledTimes(1);
		expect(mocks.recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("still answers deleted and publishes when the drain fails, leaving the record to the sweep", async () => {
		mocks.drainPendingVectorCleanup.mockRejectedValue(
			new Error("qdrant unavailable"),
		);

		const result = await call();

		expect(result.status).toBe("deleted");
		expect(mocks.logger.warn).toHaveBeenCalledWith(
			expect.stringMatching(/cleanup-1.*sweep.*qdrant unavailable/),
		);
		expect(mocks.emitContextChange).toHaveBeenCalledTimes(1);
	});

	it("bounds the drain: answers deleted once the bound passes, and a late failure is nobody's to handle", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const { SYNCED_CONTEXT_CLEANUP_DRAIN_MS } = await import(
			"../../../lib/delete-synced-context"
		);
		let failDrain: (error: unknown) => void = () => undefined;
		mocks.drainPendingVectorCleanup.mockImplementation(
			() =>
				new Promise((_resolve, reject) => {
					failDrain = reject;
				}),
		);
		const unhandled = vi.fn();
		process.on("unhandledRejection", unhandled);
		try {
			let answered = false;
			const pending = call().then((result) => {
				answered = true;
				return result;
			});

			await vi.advanceTimersByTimeAsync(
				SYNCED_CONTEXT_CLEANUP_DRAIN_MS - 1,
			);
			expect(answered).toBe(false);
			await vi.advanceTimersByTimeAsync(1);

			expect((await pending).status).toBe("deleted");
			expect(mocks.logger.warn).toHaveBeenCalledWith(
				expect.stringMatching(/cleanup-1.*sweep/),
			);
			expect(mocks.emitContextChange).toHaveBeenCalledTimes(1);
			expect(vi.getTimerCount()).toBe(0);

			failDrain(new Error("qdrant unavailable"));
			await vi.advanceTimersByTimeAsync(0);
			await new Promise((resolve) => setImmediate(resolve));
			expect(unhandled).not.toHaveBeenCalled();
		} finally {
			process.off("unhandledRejection", unhandled);
		}
	});

	it("answers absent, and drains, publishes and marks nothing, when no row is at the path", async () => {
		mocks.deleteSyncedContextRow.mockResolvedValue({ status: "absent" });

		const result = await call();

		expect(result).toEqual({
			status: "absent",
			sourcePath: "docs/glossary.md",
		});
		expect(mocks.drainPendingVectorCleanup).not.toHaveBeenCalled();
		expect(mocks.emitContextChange).not.toHaveBeenCalled();
		expect(mocks.emitActivity).not.toHaveBeenCalled();
		expect(mocks.markCuratedAuditWritten).not.toHaveBeenCalled();
	});

	it("answers a conflict with 409, the stored hash and who changed it — never the content", async () => {
		mocks.deleteSyncedContextRow.mockResolvedValue({
			status: "conflict",
			current: {
				contextId: "ctx-1",
				contentHash: sha("someone else's version\n"),
				contentUpdatedAt: new Date("2026-09-22T11:00:00Z"),
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
		expect(mocks.drainPendingVectorCleanup).not.toHaveBeenCalled();
		expect(mocks.markCuratedAuditWritten).not.toHaveBeenCalled();
		expect(mocks.emitContextChange).not.toHaveBeenCalled();
	});

	it("refuses a row a repository sync owns with CONFLICT naming the repository and branch, and does nothing further", async () => {
		mocks.deleteSyncedContextRow.mockResolvedValue({
			status: "repository-managed",
			context: { ...DELETED_ROW, repositorySyncId: "sync-1" },
			sync: { repository: "example-org/handbook", ref: "main" },
		});

		const error = await call().catch((caught: unknown) => caught);

		expect(error).toMatchObject({
			code: "CONFLICT",
			message:
				"docs/glossary.md is synced from example-org/handbook @ main; change it in the repository and run Sync now.",
			data: {
				code: "REPOSITORY_MANAGED",
				repository: "example-org/handbook",
				ref: "main",
			},
		});
		expect(mocks.drainPendingVectorCleanup).not.toHaveBeenCalled();
		expect(mocks.markCuratedAuditWritten).not.toHaveBeenCalled();
		expect(mocks.emitContextChange).not.toHaveBeenCalled();
	});

	it("names the connected repository when the configuration was removed between the reads", async () => {
		mocks.deleteSyncedContextRow.mockResolvedValue({
			status: "repository-managed",
			context: { ...DELETED_ROW, repositorySyncId: "sync-1" },
			sync: { repository: null, ref: null },
		});

		await expect(call()).rejects.toMatchObject({
			code: "CONFLICT",
			message:
				"docs/glossary.md is synced from the connected repository; change it in the repository and run Sync now.",
			data: { code: "REPOSITORY_MANAGED", repository: null, ref: null },
		});
	});

	it("answers deleted without draining or publishing again when the answer came from this operation's receipt", async () => {
		mocks.deleteSyncedContextRow.mockResolvedValue({
			status: "deleted",
			context: null,
			cleanupId: null,
		});

		const result = await call();

		expect(result).toEqual({
			status: "deleted",
			contextId: null,
			sourcePath: "docs/glossary.md",
			contentHash: HASH,
		});
		expect(mocks.drainPendingVectorCleanup).not.toHaveBeenCalled();
		expect(mocks.emitContextChange).not.toHaveBeenCalled();
	});

	it("lets a database failure through: nothing was deleted, since the delete, the cleanup record and the audit row are one transaction", async () => {
		const unexpected = new Error("connection reset");
		mocks.deleteSyncedContextRow.mockRejectedValue(unexpected);

		await expect(call()).rejects.toBe(unexpected);
		expect(mocks.drainPendingVectorCleanup).not.toHaveBeenCalled();
		expect(mocks.markCuratedAuditWritten).not.toHaveBeenCalled();
		expect(mocks.emitContextChange).not.toHaveBeenCalled();
	});
});
