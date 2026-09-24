/**
 * `projects.contexts.upsertSyncedFile` and the shared `upsertSyncedContext`
 * behind it (Fizzy #2616).
 *
 * The procedure is the API half of pushing a text file into a project's
 * Context by its path; the MCP tool is the other half and calls the same
 * `upsertSyncedContext`, so the side effects pinned here — which outcomes
 * start an embedding, which re-embed, which write an audit row — are the ones
 * both surfaces get.
 *
 * What this pins:
 *  - authorization: a caller without CONTEXT_CREATE on the project (a
 *    Viewer) is refused before any context row is read, so is an org member
 *    whose org role grants CONTEXT_CREATE but who cannot see the project,
 *    and the write runs under the project's HOSTING organization, not the
 *    session's;
 *  - validation: the path is normalised, blank content and anything over
 *    2 MiB of UTF-8 are refused before the database is reached;
 *  - side effects: `created` and `updated` both start the embedding workflow
 *    with `reembed: true` (the hash-guarded pass: stale chunks are deleted
 *    first, and a push that lands mid-embed is picked up), and only those two
 *    record an audit row; `unchanged`, `duplicate` and `conflict` do none of
 *    it;
 *  - a conflict answers 409 with the stored hash and the last writer's name,
 *    never the stored content;
 *  - a Temporal outage never costs the caller the row it just wrote.
 *
 * `upsertContextBySourcePath` itself is covered in
 * `packages/database/__tests__/upsert-context-by-source-path.test.ts`; here it
 * is mocked so each outcome can be driven directly.
 */
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	resolveEffectiveProjectPermissions: vi.fn(),
	hasProjectAccess: vi.fn(),
	grantProjectAccess: vi.fn(),
	upsertContextBySourcePath: vi.fn(),
	findUser: vi.fn(),
	workflowStart: vi.fn(),
	getTemporalClient: vi.fn(),
	recordAuditFromRequest: vi.fn(),
	emitContextChange: vi.fn(),
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	captured: {
		inputSchema: undefined as unknown,
		/** The procedure's `.use(...)` middlewares, in declaration order. */
		middlewares: [] as unknown[],
	},
}));

vi.mock("@repo/database", async () => {
	// The pure helpers are the real ones: the path rules and the hash are part
	// of what the procedure promises, so they are not stubbed here.
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
		upsertContextBySourcePath: mocks.upsertContextBySourcePath,
		db: { user: { findUnique: mocks.findUser } },
	};
});

vi.mock("../../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions:
		mocks.resolveEffectiveProjectPermissions,
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: mocks.getTemporalClient,
}));

vi.mock("../../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: <T>(options: T) => options,
}));

vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: mocks.recordAuditFromRequest,
}));

vi.mock("../../../../../lib/realtime", () => ({
	emitContextChange: mocks.emitContextChange,
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
		content: string;
		title?: string;
		expectedContentHash?: string;
		movedFromSourcePath?: string;
	};
	context: {
		user: { id: string; name?: string; email: string };
		session: { id: string; activeOrganizationId?: string | null };
	};
}) => Promise<Record<string, unknown>>;

async function loadHandler(): Promise<Handler> {
	const mod = await import("../upsert-synced-file");
	return (mod.upsertSyncedFileProcedure as unknown as { handler: Handler })
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

const MIB = 1024 * 1024;
const CONTENT = "# Architecture\n\nThe API talks to one database.\n";
const EDITOR_PERMISSIONS = ["context:read", "context:create", "context:update"];

// The caller's session sits in org-1; the project lives in org-host. The
// write must land in org-host.
const requestContext = {
	user: { id: "user-1", name: "Example Dev", email: "dev@example.com" },
	session: { id: "sess-1", activeOrganizationId: "org-1" },
};

function row(overrides: Record<string, unknown> = {}) {
	return {
		id: "ctx-1",
		projectId: "proj-1",
		type: "TEXT",
		sourceTitle: null,
		originalFilename: null,
		metadata: {
			title: "architecture.md",
			sourcePath: "docs/architecture.md",
		},
		sourcePath: "docs/architecture.md",
		contentHash: sha(CONTENT),
		contentUpdatedAt: new Date("2026-09-22T12:00:00Z"),
		contentUpdatedByUserId: "user-1",
		updatedAt: new Date("2026-09-22T12:00:00Z"),
		...overrides,
	};
}

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
		sourcePath: "./docs\\architecture.md",
		content: CONTENT,
		...input,
	});
}

/** Let the fire-and-forget workflow start run to completion. */
async function flushBackgroundWork() {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
	vi.clearAllMocks();
	// The real permission middleware records a guest's carve-out on the
	// request context; start every case from the context as sent.
	Reflect.deleteProperty(requestContext, "allowedProjectIds");
	mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
		permissions: EDITOR_PERMISSIONS,
		source: "project-member",
		organizationId: "org-host",
	});
	mocks.hasProjectAccess.mockResolvedValue(true);
	mocks.upsertContextBySourcePath.mockResolvedValue({
		status: "created",
		context: row(),
	});
	mocks.findUser.mockResolvedValue({ id: "user-2", name: "Other Dev" });
	mocks.workflowStart.mockResolvedValue(undefined);
	mocks.getTemporalClient.mockResolvedValue({
		workflow: { start: mocks.workflowStart },
	});
	mocks.emitContextChange.mockResolvedValue(undefined);
});

describe("upsertSyncedFile — authorization", () => {
	it("refuses a Viewer before any context row is read", async () => {
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: ["context:read"],
			source: "project-member",
			organizationId: "org-host",
		});

		await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });

		expect(mocks.resolveEffectiveProjectPermissions).toHaveBeenCalledWith(
			"proj-1",
			"user-1",
		);
		expect(mocks.upsertContextBySourcePath).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
		expect(mocks.recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("answers an org member the org role alone lets write, on a project hidden from them, as if it did not exist", async () => {
		// `resolveEffectiveProjectPermissions` path 3 hands every org member
		// their org role's permissions on every project in the organization,
		// including CONTEXT_CREATE on a project they have no standing on. The
		// Context tab's create path and the MCP twin both refuse that caller
		// on visibility; this surface has to as well.
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: EDITOR_PERMISSIONS,
			source: "org",
			organizationId: "org-host",
		});
		mocks.hasProjectAccess.mockResolvedValue(false);

		await expect(call()).rejects.toMatchObject({
			code: "NOT_FOUND",
			message: "Project not found",
		});

		expect(mocks.hasProjectAccess).toHaveBeenCalledWith("proj-1", "user-1");
		expect(mocks.upsertContextBySourcePath).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
		expect(mocks.recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("answers NOT_FOUND for a project that does not exist", async () => {
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue(null);

		await expect(call()).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.upsertContextBySourcePath).not.toHaveBeenCalled();
	});

	it("lets an Editor write, under the project's hosting organization", async () => {
		const result = await call({
			expectedContentHash: sha("the version I read\n"),
		});

		expect(mocks.upsertContextBySourcePath).toHaveBeenCalledWith({
			projectId: "proj-1",
			// Normalised: backslash and leading ./ gone.
			sourcePath: "docs/architecture.md",
			content: CONTENT,
			// Defaults to the path's basename.
			title: "architecture.md",
			expectedContentHash: sha("the version I read\n"),
			userId: "user-1",
			organizationId: "org-host",
		});
		expect(result).toEqual({
			status: "created",
			contextId: "ctx-1",
			sourcePath: "docs/architecture.md",
			contentHash: sha(CONTENT),
		});
	});

	it("refuses a project with no organization instead of writing a personal row", async () => {
		// ADR-018: the organization is the only tenant context; a new feature
		// never routes into the fail-closed personal arm.
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: EDITOR_PERMISSIONS,
			source: "owner",
			organizationId: null,
		});

		await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.upsertContextBySourcePath).not.toHaveBeenCalled();
	});
});

describe("upsertSyncedFile — visibility is decided before permission", () => {
	// Same rule as the delete twin: a permission refusal says the project
	// exists, so a caller who cannot see it hears what a missing id hears.

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
		expect(mocks.resolveEffectiveProjectPermissions).not.toHaveBeenCalled();
		expect(mocks.upsertContextBySourcePath).not.toHaveBeenCalled();
	});

	it("still answers FORBIDDEN, naming the permission, to a caller who can see the project but may not add to it", async () => {
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: ["context:read"],
			source: "project-member",
			organizationId: "org-host",
		});

		await expect(call()).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: "Missing required permission: context:create",
		});
		expect(mocks.hasProjectAccess).toHaveBeenCalledWith("proj-1", "user-1");
		expect(mocks.upsertContextBySourcePath).not.toHaveBeenCalled();
	});
});

describe("upsertSyncedFile — validation", () => {
	it("accepts exactly 2 MiB of UTF-8 in the input schema", async () => {
		const schema = await inputSchema();

		expect(
			schema.safeParse({
				projectId: "proj-1",
				sourcePath: "docs/big.md",
				content: "x".repeat(2 * MIB),
			}).success,
		).toBe(true);
	});

	it("rejects 2 MiB + 1 byte in the input schema, counting bytes, not characters", async () => {
		const schema = await inputSchema();

		expect(
			schema.safeParse({
				projectId: "proj-1",
				sourcePath: "docs/big.md",
				content: "x".repeat(2 * MIB + 1),
			}).success,
		).toBe(false);
		// 1 MiB + 1 two-byte characters: under the character count, over the
		// byte count.
		expect(
			schema.safeParse({
				projectId: "proj-1",
				sourcePath: "docs/big.md",
				content: "é".repeat(MIB + 1),
			}).success,
		).toBe(false);
	});

	it("rejects 2 MiB + 1 byte in the shared function too, before the database", async () => {
		// The MCP tool reaches the shared function without this schema, so the
		// bound has to hold there on its own.
		await expect(
			call({ content: "x".repeat(2 * MIB + 1) }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.upsertContextBySourcePath).not.toHaveBeenCalled();
	});

	it("rejects an expectedContentHash that is not a sha256 hex digest", async () => {
		const schema = await inputSchema();

		expect(
			schema.safeParse({
				projectId: "proj-1",
				sourcePath: "docs/a.md",
				content: CONTENT,
				expectedContentHash: "not-a-hash",
			}).success,
		).toBe(false);
	});

	it.each([
		["../outside.md", /'\.' or '\.\.' segments/],
		["/etc/hosts", /absolute/],
		["docs/", /directory/],
	])("refuses the path %j as a 400", async (sourcePath, message) => {
		await expect(call({ sourcePath })).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringMatching(message),
		});
		expect(mocks.upsertContextBySourcePath).not.toHaveBeenCalled();
	});

	it("refuses content with no non-whitespace character", async () => {
		await expect(call({ content: " \n\t " })).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		expect(mocks.upsertContextBySourcePath).not.toHaveBeenCalled();
	});

	it("refuses a NUL byte in the content, which Postgres text cannot store", async () => {
		await expect(
			call({ content: "# Notes\n\u0000binary tail\n" }),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringMatching(/NUL/),
		});
		expect(mocks.upsertContextBySourcePath).not.toHaveBeenCalled();
	});

	it("accepts a control character other than NUL in the content", async () => {
		// The v1 route's body envelope is sized for this: U+0001 is six bytes
		// on the wire, and it is valid content.
		await expect(
			call({ content: "# Notes\n\u0001 marker\n" }),
		).resolves.toMatchObject({ status: "created" });
		expect(mocks.upsertContextBySourcePath).toHaveBeenCalledTimes(1);
	});

	it("refuses a NUL byte in the title", async () => {
		await expect(
			call({ title: "Architecture\u0000" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.upsertContextBySourcePath).not.toHaveBeenCalled();
	});

	it("refuses a bidi override in the title, which becomes the audit resource name", async () => {
		// U+202E RIGHT-TO-LEFT OVERRIDE: renders "architecture.md" reversed
		// on the Context tab and in the audit log without changing a byte a
		// reader can see.
		await expect(
			call({ title: "notes\u202Edm.erutcetihcra" }),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringMatching(/title/),
		});
		expect(mocks.upsertContextBySourcePath).not.toHaveBeenCalled();
	});

	it("refuses a zero-width character in a path segment", async () => {
		await expect(
			call({ sourcePath: "docs/arch\u200Bitecture.md" }),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringMatching(/sourcePath/),
		});
		expect(mocks.upsertContextBySourcePath).not.toHaveBeenCalled();
	});

	it("uses a caller-supplied title instead of the basename", async () => {
		await call({ title: "  System architecture  " });

		expect(mocks.upsertContextBySourcePath).toHaveBeenCalledWith(
			expect.objectContaining({ title: "System architecture" }),
		);
	});
});

describe("upsertSyncedFile — embedding and audit", () => {
	it("starts the hash-guarded embedding workflow once for a created row, without the body", async () => {
		await call();
		await flushBackgroundWork();

		expect(mocks.workflowStart).toHaveBeenCalledTimes(1);
		const [workflowType, options] = mocks.workflowStart.mock.calls[0];
		expect(workflowType).toBe("contextEmbeddingWorkflow");
		expect(options.taskQueue).toBe("project-documents");
		expect(options.workflowId).toMatch(/^context-embedding-ctx-1-\d+$/);
		expect(options.args).toEqual([
			{
				contextId: "ctx-1",
				projectId: "proj-1",
				userId: "user-1",
				organizationId: "org-host",
				type: "TEXT",
				metadata: {
					filename: "docs/architecture.md",
					sourceTitle: "architecture.md",
					sourcePath: "docs/architecture.md",
				},
				// A create takes the hash-guarded pass too: its workflow reads
				// the row when it runs, so a replace that lands first must not
				// be overwritten in the index by the older version.
				reembed: true,
			},
		]);
		// Up to 2 MiB would not fit a Temporal payload; the activity reads
		// the body back from the row.
		expect(options.args[0]).not.toHaveProperty("content");
	});

	it("records one audit row and one realtime event for a created row", async () => {
		await call();

		expect(mocks.recordAuditFromRequest).toHaveBeenCalledTimes(1);
		const [auditContext, event] =
			mocks.recordAuditFromRequest.mock.calls[0];
		expect(auditContext).toBe(requestContext);
		expect(event).toEqual({
			action: "project.context_source.content_upserted",
			category: "project",
			organizationId: "org-host",
			projectId: "proj-1",
			resource: {
				type: "project_context",
				id: "ctx-1",
				name: "architecture.md",
			},
			metadata: {
				outcome: "created",
				sourcePath: "docs/architecture.md",
				contentHash: sha(CONTENT),
				bytes: Buffer.byteLength(CONTENT, "utf8"),
				via: "web",
			},
		});
		expect(mocks.emitContextChange).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "proj-1",
				contextId: "ctx-1",
				action: "added",
				userId: "user-1",
			}),
		);
	});

	it("re-embeds an updated row and audits what it replaced", async () => {
		mocks.upsertContextBySourcePath.mockResolvedValue({
			status: "updated",
			context: row(),
			previousHash: sha("previous version\n"),
		});

		const result = await call({
			expectedContentHash: sha("previous version\n"),
		});
		await flushBackgroundWork();

		expect(result.status).toBe("updated");
		expect(mocks.workflowStart).toHaveBeenCalledTimes(1);
		expect(mocks.workflowStart.mock.calls[0][1].args[0]).toMatchObject({
			contextId: "ctx-1",
			reembed: true,
		});
		expect(mocks.recordAuditFromRequest).toHaveBeenCalledTimes(1);
		expect(mocks.recordAuditFromRequest.mock.calls[0][1].metadata).toEqual({
			outcome: "updated",
			sourcePath: "docs/architecture.md",
			contentHash: sha(CONTENT),
			bytes: Buffer.byteLength(CONTENT, "utf8"),
			previousContentHash: sha("previous version\n"),
			via: "web",
		});
		expect(mocks.emitContextChange).toHaveBeenCalledWith(
			expect.objectContaining({ action: "updated" }),
		);
	});

	it("does nothing further for unchanged content", async () => {
		mocks.upsertContextBySourcePath.mockResolvedValue({
			status: "unchanged",
			context: row(),
		});

		const result = await call();
		await flushBackgroundWork();

		expect(result).toEqual({
			status: "unchanged",
			contextId: "ctx-1",
			sourcePath: "docs/architecture.md",
			contentHash: sha(CONTENT),
		});
		expect(mocks.workflowStart).not.toHaveBeenCalled();
		expect(mocks.recordAuditFromRequest).not.toHaveBeenCalled();
		expect(mocks.emitContextChange).not.toHaveBeenCalled();
	});

	it("reports a duplicate with the existing row and does nothing further", async () => {
		mocks.upsertContextBySourcePath.mockResolvedValue({
			status: "duplicate",
			existing: row({
				id: "ctx-existing",
				sourcePath: "notes/architecture-copy.md",
			}),
		});

		const result = await call();
		await flushBackgroundWork();

		expect(result).toEqual({
			status: "duplicate",
			contextId: "ctx-existing",
			sourcePath: "docs/architecture.md",
			contentHash: sha(CONTENT),
			duplicateOfContextId: "ctx-existing",
			duplicateOfSourcePath: "notes/architecture-copy.md",
		});
		expect(mocks.workflowStart).not.toHaveBeenCalled();
		expect(mocks.recordAuditFromRequest).not.toHaveBeenCalled();
		expect(mocks.emitContextChange).not.toHaveBeenCalled();
	});

	it("refuses a row a repository sync owns with CONFLICT naming the repository and branch, and does nothing further", async () => {
		// Living Memory design 2026-09-23 §6: the repository is the file's
		// author of record.
		mocks.upsertContextBySourcePath.mockResolvedValue({
			status: "repository-managed",
			context: row({ repositorySyncId: "sync-1" }),
			sync: { repository: "example-org/handbook", ref: "main" },
		});

		const error = await call().catch((caught: unknown) => caught);
		await flushBackgroundWork();

		expect(error).toMatchObject({
			code: "CONFLICT",
			message:
				"docs/architecture.md is synced from example-org/handbook @ main; change it in the repository and run Sync now.",
			data: {
				code: "REPOSITORY_MANAGED",
				repository: "example-org/handbook",
				ref: "main",
			},
		});
		expect(mocks.workflowStart).not.toHaveBeenCalled();
		expect(mocks.recordAuditFromRequest).not.toHaveBeenCalled();
		expect(mocks.emitContextChange).not.toHaveBeenCalled();
	});

	it("names the connected repository when the sync configuration was removed between the reads", async () => {
		mocks.upsertContextBySourcePath.mockResolvedValue({
			status: "repository-managed",
			context: row({
				repositorySyncId: "sync-1",
				sourcePath: "docs/old-name.md",
			}),
			sync: { repository: null, ref: null },
		});

		const error = await call({
			movedFromSourcePath: "docs/old-name.md",
			expectedContentHash: sha(CONTENT),
		}).catch((caught: unknown) => caught);

		// The managed row's own path: here the move's source.
		expect(error).toMatchObject({
			code: "CONFLICT",
			message:
				"docs/old-name.md is synced from the connected repository; change it in the repository and run Sync now.",
			data: { code: "REPOSITORY_MANAGED", repository: null, ref: null },
		});
	});

	it("answers a conflict with 409, the stored hash and who last changed it — never the content", async () => {
		mocks.upsertContextBySourcePath.mockResolvedValue({
			status: "conflict",
			current: {
				contextId: "ctx-1",
				contentHash: sha("someone else's version\n"),
				contentUpdatedAt: new Date("2026-09-22T11:00:00Z"),
				contentUpdatedByUserId: "user-2",
			},
		});

		const error = await call({ content: "my version\n" }).catch(
			(caught: unknown) => caught,
		);
		await flushBackgroundWork();

		expect(error).toMatchObject({
			code: "CONFLICT",
			data: {
				status: "conflict",
				contextId: "ctx-1",
				sourcePath: "docs/architecture.md",
				contentHash: sha("my version\n"),
				current: {
					contextId: "ctx-1",
					contentHash: sha("someone else's version\n"),
					contentUpdatedAt: new Date("2026-09-22T11:00:00Z"),
					contentUpdatedBy: { id: "user-2", name: "Other Dev" },
				},
			},
		});
		expect(mocks.findUser).toHaveBeenCalledWith({
			where: { id: "user-2" },
			select: { id: true, name: true },
		});
		expect(JSON.stringify((error as { data: unknown }).data)).not.toContain(
			"someone else's version",
		);
		expect(mocks.workflowStart).not.toHaveBeenCalled();
		expect(mocks.recordAuditFromRequest).not.toHaveBeenCalled();
		expect(mocks.emitContextChange).not.toHaveBeenCalled();
	});

	it("answers a named hash on a deleted path with 409 and no current version, and names nobody", async () => {
		mocks.upsertContextBySourcePath.mockResolvedValue({
			status: "conflict",
			current: null,
		});

		const error = await call({
			content: "my version\n",
			expectedContentHash: sha("the version I last saw\n"),
		}).catch((caught: unknown) => caught);
		await flushBackgroundWork();

		expect(error).toMatchObject({
			code: "CONFLICT",
			data: {
				status: "conflict",
				contextId: null,
				sourcePath: "docs/architecture.md",
				contentHash: sha("my version\n"),
				current: null,
			},
		});
		expect((error as Error).message).toMatch(/deleted/i);
		expect((error as Error).message).toMatch(/without expectedContentHash/);
		expect((error as Error).message).toMatch(
			/answers duplicate instead if that content already exists elsewhere in the project/,
		);
		expect(mocks.findUser).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
		expect(mocks.recordAuditFromRequest).not.toHaveBeenCalled();
		expect(mocks.emitContextChange).not.toHaveBeenCalled();
	});

	it("keeps the row when Temporal is down, and says so in the log", async () => {
		mocks.getTemporalClient.mockRejectedValue(
			new Error("connect ECONNREFUSED"),
		);

		const result = await call();
		await flushBackgroundWork();

		expect(result.status).toBe("created");
		expect(mocks.recordAuditFromRequest).toHaveBeenCalledTimes(1);
		expect(mocks.logger.error).toHaveBeenCalledWith(
			expect.stringContaining(
				"Failed to start context embedding workflow for ctx-1",
			),
		);
	});
});

describe("upsertSyncedFile — a move (Fizzy #2636)", () => {
	const FROM_HASH = sha(CONTENT);

	function movedRow(overrides: Record<string, unknown> = {}) {
		return row({
			metadata: {
				title: "architecture.md",
				sourcePath: "docs/architecture.md",
			},
			...overrides,
		});
	}

	it("accepts movedFromSourcePath in the input schema", async () => {
		const schema = await inputSchema();

		const parsed = schema.safeParse({
			projectId: "proj-1",
			sourcePath: "docs/a.md",
			content: CONTENT,
			movedFromSourcePath: "a.md",
			expectedContentHash: FROM_HASH,
		});
		expect(parsed.success).toBe(true);
		// Kept, not stripped as an unknown key.
		expect(parsed.data?.movedFromSourcePath).toBe("a.md");
	});

	it("requires expectedContentHash with movedFromSourcePath, before the database", async () => {
		await expect(
			call({ movedFromSourcePath: "notes/arch.md" }),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringMatching(/expectedContentHash/),
		});
		expect(mocks.upsertContextBySourcePath).not.toHaveBeenCalled();
	});

	it("refuses a movedFromSourcePath that normalizes to the same path", async () => {
		await expect(
			call({
				movedFromSourcePath: "docs//architecture.md",
				expectedContentHash: FROM_HASH,
			}),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringMatching(/movedFromSourcePath/),
		});
		expect(mocks.upsertContextBySourcePath).not.toHaveBeenCalled();
	});

	it("refuses a movedFromSourcePath the path rules refuse, naming the field", async () => {
		await expect(
			call({
				movedFromSourcePath: "../outside.md",
				expectedContentHash: FROM_HASH,
			}),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringMatching(/movedFromSourcePath/),
		});
		expect(mocks.upsertContextBySourcePath).not.toHaveBeenCalled();
	});

	it("hands the normalized old path and the named hash to the database", async () => {
		mocks.upsertContextBySourcePath.mockResolvedValue({
			status: "moved",
			context: movedRow(),
			movedFromSourcePath: "notes/arch.md",
		});

		await call({
			movedFromSourcePath: ".\\notes\\arch.md",
			expectedContentHash: FROM_HASH,
		});

		expect(mocks.upsertContextBySourcePath).toHaveBeenCalledWith(
			expect.objectContaining({
				sourcePath: "docs/architecture.md",
				movedFromSourcePath: "notes/arch.md",
				expectedContentHash: FROM_HASH,
			}),
		);
	});

	it("answers moved, re-embeds under the new path and audits both paths", async () => {
		mocks.upsertContextBySourcePath.mockResolvedValue({
			status: "moved",
			context: movedRow({
				metadata: {
					title: "Architecture overview",
					sourcePath: "docs/architecture.md",
				},
			}),
			movedFromSourcePath: "notes/arch.md",
		});

		const result = await call({
			movedFromSourcePath: "notes/arch.md",
			expectedContentHash: FROM_HASH,
		});
		await flushBackgroundWork();

		expect(result).toEqual({
			status: "moved",
			contextId: "ctx-1",
			sourcePath: "docs/architecture.md",
			contentHash: FROM_HASH,
			movedFromSourcePath: "notes/arch.md",
		});
		// The index carries the path (as the filename) and the title, so a
		// move re-embeds exactly as a replace does.
		expect(mocks.workflowStart).toHaveBeenCalledTimes(1);
		expect(mocks.workflowStart.mock.calls[0][1].args[0]).toEqual({
			contextId: "ctx-1",
			projectId: "proj-1",
			userId: "user-1",
			organizationId: "org-host",
			type: "TEXT",
			metadata: {
				filename: "docs/architecture.md",
				sourceTitle: "Architecture overview",
				sourcePath: "docs/architecture.md",
			},
			reembed: true,
		});
		expect(mocks.recordAuditFromRequest).toHaveBeenCalledTimes(1);
		const [, event] = mocks.recordAuditFromRequest.mock.calls[0];
		expect(event).toMatchObject({
			action: "project.context_source.content_upserted",
			resource: { id: "ctx-1", name: "Architecture overview" },
			metadata: {
				outcome: "moved",
				sourcePath: "docs/architecture.md",
				previousSourcePath: "notes/arch.md",
				contentHash: FROM_HASH,
				via: "web",
			},
		});
		expect(mocks.emitContextChange).toHaveBeenCalledWith(
			expect.objectContaining({ action: "updated", contextId: "ctx-1" }),
		);
	});

	it.each([
		["created", "source-missing"],
		["unchanged", "target-exists"],
	] as const)(
		"passes on why a move was not applied with a %s answer",
		async (status, reason) => {
			mocks.upsertContextBySourcePath.mockResolvedValue({
				status,
				context: row(),
				moveNotApplied: {
					movedFromSourcePath: "notes/arch.md",
					reason,
				},
			});

			const result = await call({
				movedFromSourcePath: "notes/arch.md",
				expectedContentHash: FROM_HASH,
			});

			expect(result).toEqual({
				status,
				contextId: "ctx-1",
				sourcePath: "docs/architecture.md",
				contentHash: FROM_HASH,
				moveNotApplied: {
					movedFromSourcePath: "notes/arch.md",
					reason,
				},
			});
		},
	);

	it("passes on why a move was not applied with a duplicate answer", async () => {
		mocks.upsertContextBySourcePath.mockResolvedValue({
			status: "duplicate",
			existing: row({ id: "ctx-other", sourcePath: "elsewhere.md" }),
			moveNotApplied: {
				movedFromSourcePath: "notes/arch.md",
				reason: "source-missing",
			},
		});

		const result = await call({
			movedFromSourcePath: "notes/arch.md",
			expectedContentHash: FROM_HASH,
		});

		expect(result).toMatchObject({
			status: "duplicate",
			duplicateOfContextId: "ctx-other",
			moveNotApplied: { reason: "source-missing" },
		});
	});

	it("answers a changed old path with 409 naming its version, the old path and what to do", async () => {
		mocks.upsertContextBySourcePath.mockResolvedValue({
			status: "conflict",
			current: {
				contextId: "ctx-1",
				contentHash: sha("someone else's version\n"),
				contentUpdatedAt: new Date("2026-09-22T11:00:00Z"),
				contentUpdatedByUserId: "user-2",
			},
			moveNotApplied: {
				movedFromSourcePath: "notes/arch.md",
				reason: "source-changed",
			},
		});

		const error = await call({
			movedFromSourcePath: "notes/arch.md",
			expectedContentHash: FROM_HASH,
		}).catch((caught: unknown) => caught);

		expect(error).toMatchObject({
			code: "CONFLICT",
			data: {
				status: "conflict",
				contextId: "ctx-1",
				sourcePath: "docs/architecture.md",
				current: {
					contentHash: sha("someone else's version\n"),
					contentUpdatedBy: { id: "user-2", name: "Other Dev" },
				},
				moveNotApplied: {
					movedFromSourcePath: "notes/arch.md",
					reason: "source-changed",
				},
			},
		});
		expect((error as Error).message).toMatch(/notes\/arch\.md/);
		expect((error as Error).message).toMatch(/nothing was written/i);
		expect(mocks.workflowStart).not.toHaveBeenCalled();
		expect(mocks.recordAuditFromRequest).not.toHaveBeenCalled();
	});
});
