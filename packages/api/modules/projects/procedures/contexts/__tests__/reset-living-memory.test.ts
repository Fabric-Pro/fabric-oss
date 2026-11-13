/**
 * `projects.contexts.resetLivingMemory` and the shared `resetSyncedContexts`
 * behind it — the session twin of `POST /api/v1/projects/:projectId/contexts/reset`,
 * which `fabric context reset` calls.
 *
 * What this pins:
 *  - authorization: visibility first (a project the caller cannot see is
 *    NOT_FOUND, exactly as a missing one), then CONTEXT_DELETE, the
 *    permission that deletes any member's file, so an editor who may only
 *    add files cannot wipe everyone's; the reset runs under the project's
 *    HOSTING organization, and a personal project is refused;
 *  - ONE call to `resetSyncedContextRows`, which deletes, queues the vector
 *    cleanup and writes the audit row in one transaction, under an
 *    operation id of the request's own;
 *  - after a reset that deleted something: ONE bounded drain attempt of the
 *    queued cleanup with every deleted id, one context change and one
 *    activity event, and the call marked curated;
 *  - a reset that found nothing answers `{ deleted: 0 }` and drains,
 *    publishes and marks nothing (a repeat is harmless);
 *  - a configured repository sync answers CONFLICT with
 *    `data.code: "REPOSITORY_SYNC_ACTIVE"` naming the repository and branch;
 *  - a `folder` reaches the delete in its one spelling, under the same
 *    gates, and names itself in the events; one the path rules refuse is
 *    BAD_REQUEST with nothing deleted.
 *
 * `resetSyncedContextRows` itself is covered in
 * `packages/database/__tests__/reset-synced-context-rows.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	resolveEffectiveProjectPermissions: vi.fn(),
	hasProjectAccess: vi.fn(),
	grantProjectAccess: vi.fn(),
	resetSyncedContextRows: vi.fn(),
	drainPendingVectorCleanup: vi.fn(),
	getTemporalClient: vi.fn(),
	recordAuditFromRequest: vi.fn(),
	auditRequestFields: vi.fn(),
	markCuratedAuditWritten: vi.fn(),
	emitContextChange: vi.fn(),
	emitActivity: vi.fn(),
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	captured: { middlewares: [] as unknown[] },
}));

vi.mock("@repo/database", async () => {
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
		// The real permission middleware seeds a project member's tenant
		// carve-out with it on the allowed path.
		grantProjectAccess: mocks.grantProjectAccess,
		resetSyncedContextRows: mocks.resetSyncedContextRows,
		deleteSyncedContextRow: vi.fn(),
		upsertContextBySourcePath: vi.fn(),
		db: { user: { findUnique: vi.fn() } },
	};
});

vi.mock("../../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions:
		mocks.resolveEffectiveProjectPermissions,
}));

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

// Records each `.use(...)` so `call()` runs the real middleware chain, in
// its declared order, before the handler.
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
	builder.input = () => builder;
	builder.handler = (fn: unknown) => ({ handler: fn });
	return {
		tenantProtectedProcedure: builder,
		requireProjectPermission,
	};
});

const requestContext = {
	user: { id: "user-1", name: "Example Dev", email: "dev@example.com" },
	session: { id: "sess-1", activeOrganizationId: "org-session" },
};

type Handler = (args: {
	input: { projectId: string; folder?: string };
	context: typeof requestContext;
}) => Promise<Record<string, unknown>>;

type Middleware = (
	options: {
		context: typeof requestContext;
		next: (options?: {
			context?: object;
		}) => Promise<{ output: unknown; context: object }>;
	},
	input: unknown,
) => Promise<{ output: unknown }>;

async function call(
	projectId = "proj-1",
	options: { folder?: string } = {},
): Promise<Record<string, unknown>> {
	const mod = await import("../reset-living-memory");
	const handler = (
		mod.resetLivingMemoryProcedure as unknown as { handler: Handler }
	).handler;
	const chain = mocks.captured.middlewares as Middleware[];
	const input = { projectId, ...options };
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

const ADMIN_PERMISSIONS = [
	"context:read",
	"context:create",
	"context:update",
	"context:delete",
];

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

beforeEach(() => {
	vi.clearAllMocks();
	Reflect.deleteProperty(requestContext, "allowedProjectIds");
	mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
		permissions: ADMIN_PERMISSIONS,
		source: "project-member",
		organizationId: "org-host",
	});
	mocks.hasProjectAccess.mockResolvedValue(true);
	mocks.resetSyncedContextRows.mockResolvedValue({
		status: "reset",
		deletedIds: ["ctx-1", "ctx-2"],
		cleanupId: "cleanup-1",
	});
	mocks.drainPendingVectorCleanup.mockResolvedValue(undefined);
	mocks.auditRequestFields.mockReturnValue(AUDIT_FIELDS);
	mocks.emitContextChange.mockResolvedValue(undefined);
	mocks.emitActivity.mockResolvedValue(undefined);
});

describe("resetLivingMemory — authorization", () => {
	it("refuses a caller without CONTEXT_DELETE (an editor who may only add files)", async () => {
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: ["context:read", "context:create", "context:update"],
			source: "project-member",
			organizationId: "org-host",
		});

		await expect(call()).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: expect.stringMatching(/context:delete/),
		});
		expect(mocks.resetSyncedContextRows).not.toHaveBeenCalled();
	});

	it("answers a project hidden from the caller as if it did not exist, before the permission", async () => {
		// The org role grants CONTEXT_DELETE, but the project is hidden.
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: ADMIN_PERMISSIONS,
			source: "org",
			organizationId: "org-host",
		});
		mocks.hasProjectAccess.mockResolvedValue(false);

		await expect(call()).rejects.toMatchObject({
			code: "NOT_FOUND",
			message: "Project not found",
		});
		expect(mocks.resetSyncedContextRows).not.toHaveBeenCalled();
	});

	it("answers a hidden project without the permission NOT_FOUND too, never FORBIDDEN", async () => {
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: [],
			source: "none",
			organizationId: "org-other",
		});
		mocks.hasProjectAccess.mockResolvedValue(false);

		await expect(call("proj-foreign")).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
	});

	it("resets under the project's hosting organization, never the session's", async () => {
		await call();

		expect(mocks.resetSyncedContextRows).toHaveBeenCalledTimes(1);
		expect(mocks.resetSyncedContextRows).toHaveBeenCalledWith({
			projectId: "proj-1",
			organizationId: "org-host",
			userId: "user-1",
			operationId: expect.stringMatching(UUID),
			audit: { via: "web", ...AUDIT_FIELDS },
		});
	});

	it("refuses a personal project instead of reaching the personal arm", async () => {
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: ADMIN_PERMISSIONS,
			source: "owner",
			organizationId: null,
		});

		await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.resetSyncedContextRows).not.toHaveBeenCalled();
	});
});

describe("resetLivingMemory — outcomes", () => {
	it("answers the count, drains the one cleanup record with every id, and publishes once", async () => {
		const result = await call();

		expect(result).toEqual({ deleted: 2 });
		expect(mocks.drainPendingVectorCleanup).toHaveBeenCalledTimes(1);
		expect(mocks.drainPendingVectorCleanup).toHaveBeenCalledWith({
			id: "cleanup-1",
			projectId: "proj-1",
			contextIds: ["ctx-1", "ctx-2"],
			userId: null,
			organizationId: "org-host",
		});
		expect(mocks.markCuratedAuditWritten).toHaveBeenCalledTimes(1);
		expect(mocks.emitContextChange).toHaveBeenCalledTimes(1);
		expect(mocks.emitContextChange).toHaveBeenCalledWith(
			expect.objectContaining({ projectId: "proj-1", action: "deleted" }),
		);
		expect(mocks.emitActivity).toHaveBeenCalledTimes(1);
	});

	it("never fails the request when the drain fails: the sweep finishes it", async () => {
		mocks.drainPendingVectorCleanup.mockRejectedValue(
			new Error("vector store unavailable"),
		);

		await expect(call()).resolves.toEqual({ deleted: 2 });
		expect(mocks.logger.warn).toHaveBeenCalled();
	});

	it("is idempotent: a reset that finds nothing answers 0 and does nothing else", async () => {
		mocks.resetSyncedContextRows.mockResolvedValue({
			status: "reset",
			deletedIds: [],
			cleanupId: null,
		});

		await expect(call()).resolves.toEqual({ deleted: 0 });
		expect(mocks.drainPendingVectorCleanup).not.toHaveBeenCalled();
		expect(mocks.markCuratedAuditWritten).not.toHaveBeenCalled();
		expect(mocks.emitContextChange).not.toHaveBeenCalled();
		expect(mocks.emitActivity).not.toHaveBeenCalled();
	});

	it("refuses while a repository sync is configured, naming it", async () => {
		mocks.resetSyncedContextRows.mockResolvedValue({
			status: "repository-sync-active",
			sync: { repository: "example-org/notes", ref: "main" },
		});

		await expect(call()).rejects.toMatchObject({
			code: "CONFLICT",
			message: expect.stringContaining("example-org/notes @ main"),
			data: {
				code: "REPOSITORY_SYNC_ACTIVE",
				repository: "example-org/notes",
				ref: "main",
			},
		});
		expect(mocks.drainPendingVectorCleanup).not.toHaveBeenCalled();
		expect(mocks.emitContextChange).not.toHaveBeenCalled();
	});
});

describe("resetLivingMemory — one folder", () => {
	it("passes the folder in its one spelling, under the same gates", async () => {
		const result = await call("proj-1", { folder: "./docs/guides/" });

		expect(result).toEqual({ deleted: 2 });
		expect(mocks.resetSyncedContextRows).toHaveBeenCalledWith({
			projectId: "proj-1",
			organizationId: "org-host",
			userId: "user-1",
			operationId: expect.stringMatching(UUID),
			audit: { via: "web", ...AUDIT_FIELDS },
			folder: "docs/guides",
		});
	});

	it("sends no folder when none was given", async () => {
		await call();

		expect(
			mocks.resetSyncedContextRows.mock.calls[0]?.[0],
		).not.toHaveProperty("folder");
	});

	it("names the folder in the one context change and activity event", async () => {
		await call("proj-1", { folder: "docs" });

		expect(mocks.emitContextChange).toHaveBeenCalledTimes(1);
		expect(mocks.emitContextChange).toHaveBeenCalledWith(
			expect.objectContaining({
				contextName: "Living Memory folder docs (2 synced files)",
			}),
		);
		expect(mocks.emitActivity).toHaveBeenCalledTimes(1);
		expect(mocks.emitActivity).toHaveBeenCalledWith(
			expect.objectContaining({
				resourceName: "Living Memory folder docs (2 synced files)",
			}),
		);
	});

	it.each([
		["the root", "."],
		["an absolute path", "/etc"],
		["a dot segment", "docs/../other"],
	])(
		"answers BAD_REQUEST for %s and deletes nothing",
		async (_label, folder) => {
			await expect(call("proj-1", { folder })).rejects.toMatchObject({
				code: "BAD_REQUEST",
			});
			expect(mocks.resetSyncedContextRows).not.toHaveBeenCalled();
		},
	);

	it("refuses a folder without CONTEXT_DELETE before reading it", async () => {
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: ["context:read", "context:create", "context:update"],
			source: "project-member",
			organizationId: "org-host",
		});

		await expect(call("proj-1", { folder: "docs" })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(mocks.resetSyncedContextRows).not.toHaveBeenCalled();
	});

	it("refuses a folder while a repository sync is configured", async () => {
		mocks.resetSyncedContextRows.mockResolvedValue({
			status: "repository-sync-active",
			sync: { repository: "example-org/notes", ref: "main" },
		});

		await expect(call("proj-1", { folder: "docs" })).rejects.toMatchObject({
			code: "CONFLICT",
			data: { code: "REPOSITORY_SYNC_ACTIVE" },
		});
	});
});
