/**
 * `projects.contexts.memoryWrites.{createUploadUrls, submit, get}` — staging,
 * admitting and reading a write into a Living Memory write folder (ADR-022).
 *
 * Each call runs the procedure's REAL middleware chain in its declared order
 * (`projectNotFoundUnlessVisible`, then the real `requireProjectPermission`)
 * before the handler, and the handler runs the REAL admission over a mocked
 * database and a map-backed storage, so the rules, the byte checks, the
 * staging and the refusals are the real ones. What the transaction itself
 * writes is `memory-writes.test.ts`'s in `@repo/database`.
 *
 * What this pins:
 *  - a request that cannot be admitted is BAD_REQUEST with EVERY problem in
 *    `data.problems`, and writes no receipt, stages nothing and starts nothing;
 *  - staged bytes are read back and must be the file named (size and SHA-256),
 *    inline text is staged by the server after admission, and the receipt
 *    carries only keys;
 *  - an identical request returns its receipt (`deduplicated`), without a second
 *    audit row or a second staging; a member at the cap is refused 429 with
 *    `TOO_MANY_PENDING_WRITES`;
 *  - a workflow that cannot be started closes its receipt out `FAILED`;
 *  - `get` answers the receipt of the project's host organization, the typed
 *    outcome and the paths, never a staged key.
 */
import { createHash, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	resolveEffectiveProjectPermissions: vi.fn(),
	hasProjectAccess: vi.fn(),
	grantProjectAccess: vi.fn(),
	recordAuditFromRequest: vi.fn(),
	getMemoryWriteAdmissionState: vi.fn(),
	submitMemoryWrite: vi.fn(),
	settleMemoryWrite: vi.fn(),
	getMemoryWriteReceipt: vi.fn(),
	startMemoryWriteWorkflow: vi.fn(),
	storage: new Map<string, Buffer>(),
	uploads: [] as Array<{ key: string; bytes: Buffer; contentType: string }>,
	deleted: [] as string[][],
	downloads: [] as string[],
	signed: [] as Array<{ key: string; options: Record<string, unknown> }>,
	presigned: true,
}));

vi.mock("@repo/database", async () => ({
	...(await import(
		"@repo/database/prisma/queries/projects/context-source-path"
	)),
	...(await import(
		"@repo/database/prisma/queries/projects/context-repository-sync-selection"
	)),
	db: {},
	hasProjectAccess: m.hasProjectAccess,
	grantProjectAccess: m.grantProjectAccess,
	getMemoryWriteAdmissionState: m.getMemoryWriteAdmissionState,
	submitMemoryWrite: m.submitMemoryWrite,
	settleMemoryWrite: m.settleMemoryWrite,
	getMemoryWriteReceipt: m.getMemoryWriteReceipt,
}));
vi.mock("@repo/storage", () => ({
	getStorageProvider: () => ({
		supportsPresignedUrls: m.presigned,
		getSignedUploadUrl: m.presigned
			? async (key: string, options: Record<string, unknown>) => {
					m.signed.push({ key, options });
					return `https://storage.example.com/${key}?signed=1`;
				}
			: null,
		getFileMetadata: async (key: string) => {
			const data = m.storage.get(key);
			return data ? { size: data.length } : null;
		},
		downloadFile: async (key: string) => {
			m.downloads.push(key);
			const data = m.storage.get(key);
			if (!data) {
				throw new Error("missing");
			}
			return { data };
		},
		uploadFile: async (
			key: string,
			bytes: Buffer,
			options: { contentType: string },
		) => {
			m.uploads.push({ key, bytes, contentType: options.contentType });
			m.storage.set(key, bytes);
		},
		deleteObjects: async (keys: string[]) => {
			m.deleted.push(keys);
			return { deleted: keys.length, errors: [] };
		},
	}),
}));
vi.mock("../../../../../../lib/audit", () => ({
	recordAuditFromRequest: m.recordAuditFromRequest,
}));
vi.mock("../../../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: m.resolveEffectiveProjectPermissions,
}));
vi.mock("../../../../lib/memory-write/start-memory-write-workflow", () => ({
	startMemoryWriteWorkflow: m.startMemoryWriteWorkflow,
}));

// Each `.use(...)` returns a builder carrying its own chain;
// `requireProjectPermission` is the real one.
vi.mock("../../../../../../orpc/procedures", async () => {
	const { requireProjectPermission } = await vi.importActual<
		typeof import("../../../../../../orpc/middleware/require-permission")
	>("../../../../../../orpc/middleware/require-permission");
	const { Permissions } =
		await vi.importActual<typeof import("@repo/permissions")>(
			"@repo/permissions",
		);
	function builder(chain: unknown[], schema?: unknown) {
		const b: Record<string, unknown> = {};
		b.use = (middleware: unknown) =>
			builder([...chain, middleware], schema);
		b.route = () => b;
		b.input = (next: unknown) => builder(chain, next);
		b.handler = (fn: unknown) => ({
			handler: fn,
			middlewares: chain,
			inputSchema: schema,
		});
		return b;
	}
	return {
		tenantProtectedProcedure: builder([]),
		requireProjectPermission,
		Permissions,
	};
});

import { createMemoryWriteUploadUrlsProcedure } from "../create-upload-urls";
import { getMemoryWriteProcedure } from "../get";
import { submitMemoryWriteProcedure } from "../submit";

type Ctx = {
	user: { id: string; name: string; email: string };
	session: { id: string; activeOrganizationId: string | null };
};
type Middleware = (
	options: {
		context: Ctx;
		next: (options?: {
			context?: object;
		}) => Promise<{ output: unknown; context: object }>;
	},
	input: unknown,
) => Promise<{ output: unknown }>;
type Built = {
	handler: (args: { input: unknown; context: Ctx }) => Promise<unknown>;
	middlewares: Middleware[];
	inputSchema: {
		safeParse(v: unknown): { success: boolean; data?: unknown };
	};
};

const procedures = {
	createUploadUrls: createMemoryWriteUploadUrlsProcedure,
	submit: submitMemoryWriteProcedure,
	get: getMemoryWriteProcedure,
} as unknown as Record<"createUploadUrls" | "submit" | "get", Built>;

// The caller's session sits in org-session; the project lives in org-host.
const ctx: Ctx = {
	user: { id: "user-1", name: "Example Member", email: "dev@example.com" },
	session: { id: "sess-1", activeOrganizationId: "org-session" },
};

/** Run the procedure as oRPC would: its middlewares in order, then the handler. */
async function call(
	name: keyof typeof procedures,
	input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const procedure = procedures[name];
	const parsed = procedure.inputSchema.safeParse(input);
	if (!parsed.success) {
		throw Object.assign(new Error("input validation failed"), {
			code: "BAD_REQUEST",
		});
	}
	const run = async (
		index: number,
		context: Ctx,
	): Promise<{ output: unknown; context: object }> => {
		const middleware = procedure.middlewares[index];
		if (!middleware) {
			return {
				output: await procedure.handler({
					input: parsed.data,
					context,
				}),
				context: {},
			};
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
			parsed.data,
		)) as { output: unknown; context: object };
	};
	return (await run(0, { ...ctx })).output as Record<string, unknown>;
}

const VIEWER = ["context:read"];
const EDITOR = ["context:read", "context:create"];

function grant(permissions: string[]) {
	m.resolveEffectiveProjectPermissions.mockResolvedValue({
		permissions,
		source: "project-member",
		organizationId: "org-host",
	});
}

const sha256 = (bytes: Buffer) =>
	createHash("sha256").update(bytes).digest("hex");

/** An object a caller staged straight into storage, as `createUploadUrls` lets it. */
function staged(content: string, projectId = "proj-1") {
	const bytes = Buffer.from(content, "utf8");
	const stagedKey = `memory-writes/${projectId}/${randomUUID()}`;
	m.storage.set(stagedKey, bytes);
	return { stagedKey, bytes: bytes.length, sha256: sha256(bytes) };
}

const admission = {
	readOnlyMode: false,
	sync: {
		id: "sync-1",
		userId: "user-delegate",
		ref: "main",
		repositoryIntegrationId: "int-1",
		paths: ["docs", "notes/team.md"],
		excludedPaths: ["docs/drafts"],
		automatic: true,
		automaticPausedReason: null,
	},
	target: {
		id: "target-1",
		version: 4,
		folder: "docs/memory",
		mode: "DIRECT_PUSH",
	},
	instructionRoots: [],
	managedCount: 3,
	managedKeys: [],
};

const submitInput = {
	projectId: "proj-1",
	targetId: "target-1",
	message: "Add a note",
	entries: [{ path: "docs/memory/a.md", op: "PUT", content: "# A\n" }],
};

/** A synthetic token, built at run time so no source line is one. */
const githubToken = () => `ghp_${"A1".repeat(18)}`;

function nothingWasAdmitted() {
	expect(m.submitMemoryWrite).not.toHaveBeenCalled();
	expect(m.uploads).toEqual([]);
	expect(m.startMemoryWriteWorkflow).not.toHaveBeenCalled();
	expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
	expect(m.settleMemoryWrite).not.toHaveBeenCalled();
}

beforeEach(() => {
	vi.clearAllMocks();
	m.storage.clear();
	m.uploads = [];
	m.deleted = [];
	m.downloads = [];
	m.signed = [];
	m.presigned = true;
	m.hasProjectAccess.mockResolvedValue(true);
	grant(EDITOR);
	m.getMemoryWriteAdmissionState.mockResolvedValue({ ...admission });
	m.submitMemoryWrite.mockResolvedValue({
		kind: "created",
		write: { id: "write-1", status: "PENDING", digest: "digest-from-db" },
	});
	m.settleMemoryWrite.mockResolvedValue({ applied: true, status: "FAILED" });
	m.startMemoryWriteWorkflow.mockResolvedValue(undefined);
});

// =============================================================================
// Authorization
// =============================================================================

describe("authorization", () => {
	it("requires CONTEXT_CREATE to stage and to submit, and CONTEXT_READ to get", async () => {
		grant(VIEWER);

		await expect(
			call("createUploadUrls", {
				projectId: "proj-1",
				files: [{ bytes: 5 }],
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(call("submit", submitInput)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		nothingWasAdmitted();

		m.getMemoryWriteReceipt.mockResolvedValue(null);
		await expect(
			call("get", { projectId: "proj-1", writeId: "write-1" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("answers NOT_FOUND, before any permission, for a project the caller cannot see", async () => {
		m.hasProjectAccess.mockResolvedValue(false);
		m.resolveEffectiveProjectPermissions.mockResolvedValue(null);

		for (const [name, input] of [
			["submit", submitInput],
			["get", { projectId: "proj-1", writeId: "write-1" }],
			[
				"createUploadUrls",
				{ projectId: "proj-1", files: [{ bytes: 5 }] },
			],
		] as const) {
			await expect(call(name, input), name).rejects.toMatchObject({
				code: "NOT_FOUND",
			});
		}
	});

	it("refuses a personal project: the sync is organization-scoped", async () => {
		m.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: EDITOR,
			source: "owner",
			organizationId: null,
		});

		await expect(call("submit", submitInput)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		nothingWasAdmitted();
	});
});

// =============================================================================
// createUploadUrls
// =============================================================================

describe("createUploadUrls", () => {
	it("signs one short-lived PUT per file, for text of the size declared, under the project's own staging keys", async () => {
		const result = (await call("createUploadUrls", {
			projectId: "proj-1",
			files: [{ bytes: 10 }, { bytes: 2 * 1024 * 1024 }],
		})) as {
			expiresInSeconds: number;
			uploads: Array<{ stagedKey: string; url: string; bytes: number }>;
		};

		expect(result.expiresInSeconds).toBe(600);
		expect(result.uploads).toHaveLength(2);
		for (const [index, upload] of result.uploads.entries()) {
			expect(upload.stagedKey).toMatch(
				/^memory-writes\/proj-1\/[0-9a-f-]{36}$/,
			);
			expect(upload.url).toContain(upload.stagedKey);
			expect(m.signed[index]).toEqual({
				key: upload.stagedKey,
				options: {
					bucket: expect.any(String),
					contentType: "text/plain; charset=utf-8",
					contentLength: upload.bytes,
					expiresIn: 600,
				},
			});
		}
		expect(result.uploads.map((upload) => upload.bytes)).toEqual([
			10,
			2 * 1024 * 1024,
		]);
		expect(
			new Set(result.uploads.map((upload) => upload.stagedKey)).size,
		).toBe(2);
	});

	it("refuses when storage cannot sign uploads", async () => {
		m.presigned = false;

		await expect(
			call("createUploadUrls", {
				projectId: "proj-1",
				files: [{ bytes: 5 }],
			}),
		).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
	});

	it.each([
		["no files", { files: [] }],
		[
			"more than fifty files",
			{ files: Array.from({ length: 51 }, () => ({ bytes: 1 })) },
		],
		["an empty file", { files: [{ bytes: 0 }] }],
		["a file over two MiB", { files: [{ bytes: 2 * 1024 * 1024 + 1 }] }],
		["a size that is not a whole number", { files: [{ bytes: 1.5 }] }],
	])("refuses %s", (_name, body) => {
		expect(
			procedures.createUploadUrls.inputSchema.safeParse({
				projectId: "proj-1",
				...body,
			}).success,
		).toBe(false);
	});
});

// =============================================================================
// submit
// =============================================================================

describe("submit", () => {
	it("admits a request: the receipt freezes the target, inline text is staged by the server, the workflow starts and the audit row is written", async () => {
		const result = await call("submit", submitInput);

		expect(result).toEqual({
			writeId: "write-1",
			status: "PENDING",
			digest: "digest-from-db",
			deduplicated: false,
		});
		expect(m.getMemoryWriteAdmissionState).toHaveBeenCalledWith({
			projectId: "proj-1",
			organizationId: "org-host",
			targetId: "target-1",
			putPaths: ["docs/memory/a.md"],
		});
		// The server staged the inline text, once, under a key of the project's own.
		expect(m.uploads).toHaveLength(1);
		const [upload] = m.uploads;
		expect(upload?.key).toMatch(/^memory-writes\/proj-1\/[0-9a-f-]{36}$/);
		expect(upload?.bytes.toString("utf8")).toBe("# A\n");
		const submitted = m.submitMemoryWrite.mock.calls[0]?.[0];
		expect(submitted).toMatchObject({
			projectId: "proj-1",
			organizationId: "org-host",
			userId: "user-1",
			via: "APP",
			oauthClientId: null,
			target: {
				id: "target-1",
				version: 4,
				folder: "docs/memory",
				mode: "DIRECT_PUSH",
				ref: "main",
				repositoryIntegrationId: "int-1",
			},
			message: "Add a note",
			dedupeWindowMs: 2 * 60 * 60_000,
			maxPending: 5,
		});
		expect(submitted.digest).toMatch(/^[0-9a-f]{64}$/);
		expect(submitted.entries).toEqual([
			{
				path: "docs/memory/a.md",
				op: "PUT",
				ifMatchOid: null,
				stagedKey: upload?.key,
				bytes: 4,
				sha256: sha256(Buffer.from("# A\n")),
			},
		]);
		// The receipt and the workflow carry keys and ids, never the text.
		expect(JSON.stringify(m.submitMemoryWrite.mock.calls)).not.toContain(
			"# A",
		);
		expect(m.startMemoryWriteWorkflow).toHaveBeenCalledWith({
			writeId: "write-1",
			projectId: "proj-1",
			organizationId: "org-host",
		});
		expect(m.recordAuditFromRequest).toHaveBeenCalledTimes(1);
		expect(m.recordAuditFromRequest.mock.calls[0]?.[1]).toMatchObject({
			action: "project.context.memory_write_submitted",
			organizationId: "org-host",
			projectId: "proj-1",
			resource: { type: "project_memory_write", id: "write-1" },
			metadata: {
				folder: "docs/memory",
				mode: "DIRECT_PUSH",
				via: "APP",
				fileCount: 1,
			},
		});
		expect(
			JSON.stringify(m.recordAuditFromRequest.mock.calls),
		).not.toContain("# A");
	});

	it("digests an inline file and the same file staged alike, so an agent may retry by either route", async () => {
		await call("submit", submitInput);
		await call("submit", {
			...submitInput,
			entries: [
				{ path: "docs/memory/a.md", op: "PUT", ...staged("# A\n") },
			],
		});

		const [inline, byStaging] = m.submitMemoryWrite.mock.calls.map(
			(callArgs) => callArgs[0].digest,
		);
		expect(inline).toBe(byStaging);
	});

	describe("a staged file", () => {
		it("is read back and, when it is the file named, kept under the caller's key without a second copy", async () => {
			const file = staged("# Staged\n");

			await call("submit", {
				...submitInput,
				entries: [{ path: "docs/memory/a.md", op: "PUT", ...file }],
			});

			expect(m.downloads).toEqual([file.stagedKey]);
			expect(m.uploads).toEqual([]);
			expect(m.submitMemoryWrite.mock.calls[0]?.[0].entries).toEqual([
				{
					path: "docs/memory/a.md",
					op: "PUT",
					ifMatchOid: null,
					stagedKey: file.stagedKey,
					bytes: file.bytes,
					sha256: file.sha256,
				},
			]);
		});

		it("is refused when its SHA-256 is not the one named, writing no receipt", async () => {
			const file = staged("# Staged\n");

			await expect(
				call("submit", {
					...submitInput,
					entries: [
						{
							path: "docs/memory/a.md",
							op: "PUT",
							...file,
							sha256: "0".repeat(64),
						},
					],
				}),
			).rejects.toMatchObject({
				code: "BAD_REQUEST",
				data: {
					code: "MEMORY_WRITE_REFUSED",
					problems: [
						{
							path: "docs/memory/a.md",
							code: "STAGED_OBJECT_MISMATCH",
							detail: "sha256",
						},
					],
				},
			});
			nothingWasAdmitted();
		});

		it("is refused when its size is not the one named, before it is downloaded", async () => {
			const file = staged("# Staged\n");

			await expect(
				call("submit", {
					...submitInput,
					entries: [
						{
							path: "docs/memory/a.md",
							op: "PUT",
							...file,
							bytes: file.bytes + 1,
						},
					],
				}),
			).rejects.toMatchObject({
				data: {
					problems: [
						expect.objectContaining({
							code: "STAGED_OBJECT_MISMATCH",
							detail: "size",
						}),
					],
				},
			});
			expect(m.downloads).toEqual([]);
			nothingWasAdmitted();
		});

		it.each([
			[
				"an object that is not there",
				() => ({
					stagedKey: `memory-writes/proj-1/${randomUUID()}`,
					bytes: 5,
					sha256: "a".repeat(64),
				}),
				{ code: "STAGED_OBJECT_MISSING", detail: "missing" },
			],
			[
				"another project's key",
				() => staged("# A\n", "proj-2"),
				{ code: "STAGED_OBJECT_INVALID", detail: "key" },
			],
			[
				"a key that is not a staging key at all",
				() => ({
					stagedKey: "projects/proj-1/instructions/snapshots/x/y",
					bytes: 5,
					sha256: "a".repeat(64),
				}),
				{ code: "STAGED_OBJECT_INVALID", detail: "key" },
			],
			[
				"a hash that is not a SHA-256",
				() => ({ ...staged("# A\n"), sha256: "xyz" }),
				{ code: "STAGED_OBJECT_INVALID", detail: "sha256" },
			],
			[
				"a key without its size and hash",
				() => ({ stagedKey: staged("# A\n").stagedKey }),
				{ code: "STAGED_OBJECT_INVALID", detail: "incomplete" },
			],
		])("is refused for %s", async (_name, file, problem) => {
			await expect(
				call("submit", {
					...submitInput,
					entries: [
						{ path: "docs/memory/a.md", op: "PUT", ...file() },
					],
				}),
			).rejects.toMatchObject({
				data: {
					problems: [
						expect.objectContaining({
							path: "docs/memory/a.md",
							...problem,
						}),
					],
				},
			});
			nothingWasAdmitted();
		});

		it("is refused when it is not UTF-8 text, like a binary file sent inline", async () => {
			const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x02]);
			const stagedKey = `memory-writes/proj-1/${randomUUID()}`;
			m.storage.set(stagedKey, bytes);

			await expect(
				call("submit", {
					...submitInput,
					entries: [
						{
							path: "docs/memory/a.md",
							op: "PUT",
							stagedKey,
							bytes: bytes.length,
							sha256: sha256(bytes),
						},
					],
				}),
			).rejects.toMatchObject({
				data: {
					problems: [
						expect.objectContaining({ code: "CONTENT_NOT_TEXT" }),
					],
				},
			});
			nothingWasAdmitted();
		});

		it("is judged on its real bytes: a credential in a staged file is refused without being echoed", async () => {
			const token = githubToken();
			const file = staged(`k: ${token}\n`);

			const error = await call("submit", {
				...submitInput,
				entries: [{ path: "docs/memory/a.md", op: "PUT", ...file }],
			}).catch((e: unknown) => e);

			expect(error).toMatchObject({
				data: {
					problems: [
						{
							path: "docs/memory/a.md",
							code: "SECRET_DETECTED",
							detail: "github-token",
						},
					],
				},
			});
			expect(JSON.stringify(error)).not.toContain(token);
			nothingWasAdmitted();
		});
	});

	describe("a request that cannot be admitted", () => {
		it("reports every problem together, writes no receipt, stages nothing and starts nothing", async () => {
			const error = await call("submit", {
				...submitInput,
				entries: [
					{ path: "docs/other/a.md", op: "PUT", content: "# A\n" },
					{ path: "docs/memory/b.png", op: "PUT", content: "x" },
					{ path: "docs/memory/c.md", op: "DELETE" },
				],
			}).catch((e: unknown) => e);

			expect(error).toMatchObject({ code: "BAD_REQUEST" });
			const problems = (
				error as { data: { problems: Array<{ code: string }> } }
			).data.problems;
			expect(problems.map((problem) => problem.code).sort()).toEqual([
				"DELETE_REQUIRES_IF_MATCH",
				"PATH_OUTSIDE_TARGET",
				"UNSUPPORTED_EXTENSION",
			]);
			nothingWasAdmitted();
		});

		it("refuses a project in read-only mode and a sync that is not ingesting", async () => {
			m.getMemoryWriteAdmissionState.mockResolvedValue({
				...admission,
				readOnlyMode: true,
				sync: { ...admission.sync, automatic: false },
			});

			await expect(call("submit", submitInput)).rejects.toMatchObject({
				data: {
					problems: expect.arrayContaining([
						{ code: "READ_ONLY_MODE" },
						{ code: "SYNC_NOT_INGESTING", detail: "automatic-off" },
					]),
				},
			});
			nothingWasAdmitted();
		});

		it("refuses a target that is not the sync's", async () => {
			m.getMemoryWriteAdmissionState.mockResolvedValue({
				...admission,
				target: null,
			});

			await expect(call("submit", submitInput)).rejects.toMatchObject({
				data: { problems: [{ code: "TARGET_NOT_FOUND" }] },
			});
			nothingWasAdmitted();
		});

		it("refuses a file named both ways, and a DELETE that carries bytes", async () => {
			const file = staged("# A\n");

			await expect(
				call("submit", {
					...submitInput,
					entries: [
						{
							path: "docs/memory/a.md",
							op: "PUT",
							content: "# A\n",
							...file,
						},
						{
							path: "docs/memory/b.md",
							op: "DELETE",
							ifMatchOid: "a".repeat(40),
							...staged("x"),
						},
					],
				}),
			).rejects.toMatchObject({
				data: {
					problems: expect.arrayContaining([
						{ path: "docs/memory/a.md", code: "CONTENT_AMBIGUOUS" },
						{
							path: "docs/memory/b.md",
							code: "DELETE_HAS_CONTENT",
						},
					]),
				},
			});
			nothingWasAdmitted();
		});

		it("refuses more inline text than a request body should carry, before reading any storage", async () => {
			const big = "a".repeat(2 * 1024 * 1024);

			await expect(
				call("submit", {
					...submitInput,
					entries: [
						{ path: "docs/memory/a.md", op: "PUT", content: big },
						{ path: "docs/memory/b.md", op: "PUT", content: big },
					],
				}),
			).rejects.toMatchObject({
				data: {
					problems: [{ code: "REQUEST_TOO_LARGE", detail: "inline" }],
				},
			});
			expect(m.getMemoryWriteAdmissionState).not.toHaveBeenCalled();
			expect(m.downloads).toEqual([]);
			nothingWasAdmitted();
		});

		it("refuses a message that holds a credential or spells a trailer of Fabric's own", async () => {
			for (const message of [
				`rotate ${githubToken()}`,
				"notes\n\nFabric-Memory-Write: cforged00000001",
			]) {
				await expect(
					call("submit", { ...submitInput, message }),
				).rejects.toMatchObject({
					data: {
						problems: [
							expect.objectContaining({
								code: "MESSAGE_INVALID",
							}),
						],
					},
				});
			}
			nothingWasAdmitted();
		});
	});

	describe("an identical request", () => {
		it("returns the receipt it already has, with no second audit row and without keeping the text it staged again", async () => {
			m.submitMemoryWrite.mockResolvedValue({
				kind: "deduplicated",
				write: { id: "write-0", status: "COMMITTED", digest: "d0" },
			});

			const result = await call("submit", submitInput);

			expect(result).toEqual({
				writeId: "write-0",
				status: "COMMITTED",
				digest: "d0",
				deduplicated: true,
			});
			expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
			expect(m.startMemoryWriteWorkflow).not.toHaveBeenCalled();
			// What this request staged for itself is removed again.
			expect(m.deleted).toEqual([[m.uploads[0]?.key]]);
		});

		it("starts the workflow of a receipt that is still pending, in case the first request never did", async () => {
			m.submitMemoryWrite.mockResolvedValue({
				kind: "deduplicated",
				write: { id: "write-0", status: "PENDING", digest: "d0" },
			});

			const result = await call("submit", submitInput);

			expect(result).toMatchObject({
				writeId: "write-0",
				deduplicated: true,
			});
			expect(m.startMemoryWriteWorkflow).toHaveBeenCalledWith({
				writeId: "write-0",
				projectId: "proj-1",
				organizationId: "org-host",
			});
			expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
		});
	});

	describe("the cap on pending writes", () => {
		it("refuses a member who has five pending, 429 TOO_MANY_PENDING_WRITES, removing what it staged", async () => {
			m.submitMemoryWrite.mockResolvedValue({
				kind: "too-many-pending",
				pending: 5,
			});

			await expect(call("submit", submitInput)).rejects.toMatchObject({
				code: "TOO_MANY_REQUESTS",
				data: { code: "TOO_MANY_PENDING_WRITES", limit: 5 },
			});
			expect(m.deleted).toEqual([[m.uploads[0]?.key]]);
			expect(m.startMemoryWriteWorkflow).not.toHaveBeenCalled();
			expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
		});
	});

	describe("a workflow that cannot be started", () => {
		it("closes the new receipt out FAILED, retryable, and tells the caller to try again", async () => {
			m.startMemoryWriteWorkflow.mockRejectedValue(
				new Error("temporal down"),
			);

			await expect(call("submit", submitInput)).rejects.toMatchObject({
				code: "SERVICE_UNAVAILABLE",
				data: { code: "WORKFLOW_START_FAILED" },
			});
			expect(m.settleMemoryWrite).toHaveBeenCalledWith({
				writeId: "write-1",
				projectId: "proj-1",
				organizationId: "org-host",
				status: "FAILED",
				outcome: {
					status: "FAILED",
					code: "WORKFLOW_START_FAILED",
					retryable: true,
				},
				metadata: { code: "WORKFLOW_START_FAILED", retryable: true },
			});
		});

		it("leaves a receipt another request created alone", async () => {
			m.submitMemoryWrite.mockResolvedValue({
				kind: "deduplicated",
				write: { id: "write-0", status: "PENDING", digest: "d0" },
			});
			m.startMemoryWriteWorkflow.mockRejectedValue(
				new Error("temporal down"),
			);

			await expect(call("submit", submitInput)).rejects.toMatchObject({
				code: "SERVICE_UNAVAILABLE",
			});
			expect(m.settleMemoryWrite).not.toHaveBeenCalled();
		});

		it("still tells the caller when closing the receipt out fails too", async () => {
			m.startMemoryWriteWorkflow.mockRejectedValue(
				new Error("temporal down"),
			);
			m.settleMemoryWrite.mockRejectedValue(new Error("db down"));

			await expect(call("submit", submitInput)).rejects.toMatchObject({
				code: "SERVICE_UNAVAILABLE",
			});
		});
	});

	describe("the input", () => {
		it.each([
			["no entries", { entries: [] }],
			[
				"more than fifty entries",
				{
					entries: Array.from({ length: 51 }, (_, i) => ({
						path: `docs/memory/${i}.md`,
						op: "PUT",
						content: "x",
					})),
				},
			],
			["an empty message", { message: "" }],
			[
				"a message over five thousand characters",
				{ message: "m".repeat(5001) },
			],
			[
				"a staged file over two MiB",
				{
					entries: [
						{
							path: "docs/memory/a.md",
							op: "PUT",
							stagedKey: "k",
							bytes: 2 * 1024 * 1024 + 1,
							sha256: "a".repeat(64),
						},
					],
				},
			],
			[
				"an op that is neither PUT nor DELETE",
				{
					entries: [
						{ path: "docs/memory/a.md", op: "PATCH", content: "x" },
					],
				},
			],
		])("refuses %s", (_name, override) => {
			expect(
				procedures.submit.inputSchema.safeParse({
					...submitInput,
					...override,
				}).success,
			).toBe(false);
		});

		it("carries no organization: the project's host is resolved server-side", async () => {
			await call("submit", {
				...submitInput,
				organizationId: "org-session",
			});

			expect(m.submitMemoryWrite.mock.calls[0]?.[0].organizationId).toBe(
				"org-host",
			);
		});
	});
});

// =============================================================================
// get
// =============================================================================

describe("get", () => {
	const receipt = {
		id: "write-1",
		targetId: "target-1",
		targetVersion: 4,
		folder: "docs/memory",
		mode: "DIRECT_PUSH",
		ref: "main",
		via: "APP",
		digest: "d1",
		status: "COMMITTED",
		outcome: {
			status: "COMMITTED",
			sha: "a".repeat(40),
			ref: "main",
			fileCount: 2,
		},
		createdAt: new Date("2026-10-15T10:00:00.000Z"),
		settledAt: new Date("2026-10-15T10:00:05.000Z"),
		entries: [
			{ path: "docs/memory/a.md", op: "PUT" },
			{ path: "docs/memory/b.md", op: "DELETE" },
		],
	};

	it("answers the status, the typed outcome, the paths and operations and the timestamps, for the host organization", async () => {
		grant(VIEWER);
		m.getMemoryWriteReceipt.mockResolvedValue(receipt);

		const result = await call("get", {
			projectId: "proj-1",
			writeId: "write-1",
		});

		expect(result).toEqual({
			writeId: "write-1",
			status: "COMMITTED",
			digest: "d1",
			targetId: "target-1",
			folder: "docs/memory",
			mode: "DIRECT_PUSH",
			ref: "main",
			via: "APP",
			entries: [
				{ path: "docs/memory/a.md", op: "PUT" },
				{ path: "docs/memory/b.md", op: "DELETE" },
			],
			outcome: receipt.outcome,
			createdAt: receipt.createdAt,
			settledAt: receipt.settledAt,
		});
		expect(m.getMemoryWriteReceipt).toHaveBeenCalledWith({
			writeId: "write-1",
			projectId: "proj-1",
			organizationId: "org-host",
		});
	});

	it("answers a pending write with no outcome and no settlement time", async () => {
		m.getMemoryWriteReceipt.mockResolvedValue({
			...receipt,
			status: "PENDING",
			outcome: null,
			settledAt: null,
		});

		expect(
			await call("get", { projectId: "proj-1", writeId: "write-1" }),
		).toMatchObject({ status: "PENDING", outcome: null, settledAt: null });
	});

	it("hands back a conflict with the blob the caller should re-read against", async () => {
		const conflict = {
			status: "CONFLICT",
			paths: [
				{
					path: "docs/memory/a.md",
					code: "IF_MATCH_MISMATCH",
					currentOid: "b".repeat(40),
				},
			],
		};
		m.getMemoryWriteReceipt.mockResolvedValue({
			...receipt,
			status: "CONFLICT",
			outcome: conflict,
		});

		expect(
			await call("get", { projectId: "proj-1", writeId: "write-1" }),
		).toMatchObject({ outcome: conflict });
	});

	it("answers NOT_FOUND for a receipt that is not this project's", async () => {
		m.getMemoryWriteReceipt.mockResolvedValue(null);

		await expect(
			call("get", { projectId: "proj-1", writeId: "write-9" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("never hands back a staged key, the message, or an outcome that is not in the vocabulary", async () => {
		m.getMemoryWriteReceipt.mockResolvedValue({
			...receipt,
			message: "private words",
			entries: [
				{
					path: "docs/memory/a.md",
					op: "PUT",
					stagedKey: "memory-writes/x/y",
				},
			],
			outcome: { status: "COMMITTED", sha: "not-an-oid" },
		});

		const result = await call("get", {
			projectId: "proj-1",
			writeId: "write-1",
		});

		expect(JSON.stringify(result)).not.toContain("memory-writes/x/y");
		expect(JSON.stringify(result)).not.toContain("private words");
		expect(result.outcome).toBeNull();
	});
});
