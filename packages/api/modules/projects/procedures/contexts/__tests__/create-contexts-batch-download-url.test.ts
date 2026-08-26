/**
 * Integration tests for
 * `projects.contexts.createBatchDownloadUrl`.
 *
 * The tests exercise the full handler via the same "mock the procedure
 * base + call handler directly" pattern used by `create-media-upload-url`.
 * All external dependencies (database queries, storage, archiver, logger,
 * membership check) are mocked at the module boundary so the test is a
 * pure function of its inputs.
 */

import { PassThrough, Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — set up BEFORE the procedure is imported.
// ---------------------------------------------------------------------------

const {
	mockListContextsForDownload,
	mockGetProjectForDownload,
	mockGetObjectStream,
	mockPutObjectStream,
	mockGetSignedUrl,
	mockVerifyOrganizationMembership,
} = vi.hoisted(() => ({
	mockListContextsForDownload: vi.fn(),
	mockGetProjectForDownload: vi.fn(),
	mockGetObjectStream: vi.fn(),
	mockPutObjectStream: vi.fn(),
	mockGetSignedUrl: vi.fn(),
	mockVerifyOrganizationMembership: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	listContextsForDownload: mockListContextsForDownload,
	getProjectForDownload: mockGetProjectForDownload,
}));

vi.mock("@repo/config", () => ({
	config: {
		storage: {
			bucketNames: {
				projectContexts: "test-bucket",
			},
		},
	},
}));

vi.mock("@repo/storage", () => ({
	getObjectStream: mockGetObjectStream,
	putObjectStream: mockPutObjectStream,
	getSignedUrl: mockGetSignedUrl,
}));

vi.mock("@repo/logs", () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock("../../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: mockVerifyOrganizationMembership,
}));

// Collect archive entries in-memory so we can assert on structure.
interface CapturedEntry {
	name: string;
	kind: "stream" | "string";
	content?: string;
}
let capturedEntries: CapturedEntry[] = [];

vi.mock("archiver", () => {
	return {
		default: (_format: string, _opts?: unknown) => {
			const handlers = new Map<
				string,
				Array<(...a: unknown[]) => void>
			>();
			const passthrough = new PassThrough();
			const archive = {
				on(event: string, fn: (...a: unknown[]) => void) {
					const list = handlers.get(event) ?? [];
					list.push(fn);
					handlers.set(event, list);
					return archive;
				},
				pipe(dest: NodeJS.WritableStream) {
					passthrough.pipe(dest);
					return dest;
				},
				append(
					body: Readable | Buffer | string,
					options: { name: string },
				) {
					if (typeof body === "string") {
						capturedEntries.push({
							name: options.name,
							kind: "string",
							content: body,
						});
					} else if (Buffer.isBuffer(body)) {
						capturedEntries.push({
							name: options.name,
							kind: "string",
							content: body.toString("utf8"),
						});
					} else {
						capturedEntries.push({
							name: options.name,
							kind: "stream",
						});
						// Drain to avoid leaked handles.
						body.on("error", () => {});
						body.resume();
					}
				},
				async finalize() {
					// Push a single byte so the PassThrough has data and the sink
					// `Upload` mock can resolve deterministically.
					passthrough.end("ZIP");
				},
			};
			return archive;
		},
	};
});

// Mock the oRPC procedure base so we can test the handler directly.
vi.mock("../../../../../orpc/procedures", () => {
	const builder: Record<string, unknown> = {};
	builder.use = () => builder;
	builder.route = () => builder;
	builder.input = () => builder;
	builder.handler = (fn: unknown) => ({ handler: fn });
	return {
		tenantProtectedProcedure: builder,
		resolveOrganizationId: (
			input: string | null | undefined,
			session: { activeOrganizationId?: string | null },
		) => {
			if (input) {
				return input;
			}
			if (input === null) {
				return undefined;
			}
			return session?.activeOrganizationId ?? undefined;
		},
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
		requireProjectPermission: () => (c: unknown) => c,
	};
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

type TestCtx = {
	id: string;
	type: string;
	content: string | null;
	s3Path: string | null;
	s3Bucket: string | null;
	originalFilename: string | null;
	mimeType: string | null;
	fileSize: number | null;
	sourceTitle: string | null;
	sourceUrl: string | null;
	extractionStatus: string;
	metadata: Record<string, unknown> | null;
	createdAt: Date;
};

function makeClassAContext(partial: Partial<TestCtx> = {}): TestCtx {
	return {
		id: `ctx_${Math.random().toString(36).slice(2)}`,
		type: "DOCUMENT",
		content: "",
		s3Path: "projects/p1/file.pdf",
		s3Bucket: "test-bucket",
		originalFilename: "spec.pdf",
		mimeType: "application/pdf",
		fileSize: 1024,
		sourceTitle: null,
		sourceUrl: null,
		extractionStatus: "COMPLETED",
		metadata: { title: "Spec" },
		createdAt: new Date("2026-04-01T12:00:00Z"),
		...partial,
	};
}

function makeClassBContext(partial: Partial<TestCtx> = {}): TestCtx {
	return {
		id: `ctx_${Math.random().toString(36).slice(2)}`,
		type: "TEXT",
		content: "hello world",
		s3Path: null,
		s3Bucket: null,
		originalFilename: null,
		mimeType: null,
		fileSize: null,
		sourceTitle: "Kickoff Notes",
		sourceUrl: null,
		extractionStatus: "COMPLETED",
		metadata: { title: "Kickoff Notes" },
		createdAt: new Date("2026-04-02T12:00:00Z"),
		...partial,
	};
}

function makeClassCContext(partial: Partial<TestCtx> = {}): TestCtx {
	return {
		id: `ctx_${Math.random().toString(36).slice(2)}`,
		// CODE_FILE is the Class C type per spec §8.4 (code-specific synthesized text).
		type: "CODE_FILE",
		content: "function hello() { return 'world'; }",
		s3Path: null,
		s3Bucket: null,
		originalFilename: null,
		mimeType: null,
		fileSize: null,
		sourceTitle: "src/hello.ts",
		sourceUrl: null,
		extractionStatus: "COMPLETED",
		metadata: { path: "src/hello.ts" },
		createdAt: new Date("2026-04-03T12:00:00Z"),
		...partial,
	};
}

const baseContext = {
	user: { id: "user-1", email: "owner@example.com" },
	session: { id: "session-1", activeOrganizationId: null },
};

async function runHandler(args: {
	input: { projectId: string; organizationId?: string | null };
	context?: typeof baseContext;
}) {
	const { createContextsBatchDownloadUrlProcedure } = await import(
		"../create-contexts-batch-download-url"
	);
	const handler = (
		createContextsBatchDownloadUrlProcedure as unknown as {
			handler: (x: {
				input: typeof args.input;
				context: typeof baseContext;
			}) => Promise<unknown>;
		}
	).handler;
	return handler({
		input: args.input,
		context: args.context ?? baseContext,
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createContextsBatchDownloadUrl", () => {
	beforeEach(() => {
		mockListContextsForDownload.mockReset();
		mockGetProjectForDownload.mockReset();
		mockGetObjectStream.mockReset();
		mockPutObjectStream.mockReset();
		mockGetSignedUrl.mockReset();
		mockVerifyOrganizationMembership.mockReset();
		capturedEntries = [];
		mockGetSignedUrl.mockResolvedValue("https://signed.example/zip");
		mockPutObjectStream.mockImplementation(
			async (_key: string, body: Readable) => {
				// Drain to completion so the test never hangs.
				await new Promise<void>((resolve, reject) => {
					body.on("data", () => {});
					body.on("end", () => resolve());
					body.on("error", reject);
				});
			},
		);
		mockGetObjectStream.mockImplementation(async () =>
			Readable.from(["a"]),
		);
		mockGetProjectForDownload.mockResolvedValue({
			id: "proj-1",
			name: "My Project",
		});
		mockListContextsForDownload.mockResolvedValue([]);
		mockVerifyOrganizationMembership.mockResolvedValue({
			organization: { id: "org-1" },
			role: "admin",
		});
	});

	it("returns NOT_FOUND when the project is not visible to the caller", async () => {
		mockGetProjectForDownload.mockResolvedValueOnce(null);
		mockListContextsForDownload.mockResolvedValueOnce([]);

		await expect(
			runHandler({ input: { projectId: "ghost", organizationId: null } }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("returns FORBIDDEN when an org caller is not an active member", async () => {
		mockVerifyOrganizationMembership.mockResolvedValueOnce(null);

		await expect(
			runHandler({
				input: { projectId: "proj-1", organizationId: "org-9" },
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		expect(mockVerifyOrganizationMembership).toHaveBeenCalledTimes(1);
		expect(mockVerifyOrganizationMembership).toHaveBeenCalledWith(
			"org-9",
			"user-1",
		);
	});

	it("rejects projects with more than MAX_BATCH_DOWNLOAD_CONTEXTS contexts", async () => {
		const many = Array.from({ length: 201 }, (_, i) =>
			makeClassBContext({ id: `ctx_${i}`, content: "x" }),
		);
		mockListContextsForDownload.mockImplementation(async () => many);

		await expect(
			runHandler({
				input: { projectId: "proj-1", organizationId: null },
			}),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			data: { reason: "too_many", count: 201, maxCount: 200 },
		});
	});

	it("rejects projects exceeding MAX_BATCH_DOWNLOAD_BYTES", async () => {
		const huge = [
			makeClassAContext({
				id: "big",
				fileSize: 500 * 1024 * 1024 + 1,
			}),
		];
		mockListContextsForDownload.mockResolvedValueOnce(huge);

		await expect(
			runHandler({
				input: { projectId: "proj-1", organizationId: null },
			}),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			data: { reason: "too_large" },
		});
	});

	it("happy path: mixed Class A / B / C contexts produce a signed URL and manifest", async () => {
		const contexts = [
			makeClassAContext({ id: "a1" }),
			makeClassBContext({ id: "b1" }),
			makeClassCContext({ id: "c1" }),
		];
		mockListContextsForDownload.mockResolvedValueOnce(contexts);

		const result = (await runHandler({
			input: { projectId: "proj-1", organizationId: null },
		})) as {
			url: string;
			filename: string;
			includedCount: number;
			skippedCount: number;
			totalCount: number;
			key: string;
		};

		expect(result.url).toBe("https://signed.example/zip");
		expect(result.filename).toMatch(/_context_\d{4}-\d{2}-\d{2}\.zip$/);
		expect(result.includedCount).toBe(3);
		expect(result.skippedCount).toBe(0);
		expect(result.totalCount).toBe(3);
		expect(result.key).toMatch(
			/^downloads\/project-contexts\/proj-1\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]+\.zip$/,
		);

		// Last entry must be MANIFEST.txt.
		expect(capturedEntries.at(-1)?.name).toBe("MANIFEST.txt");
		// Each class maps to its own subfolder per spec §4.4:
		//   Class A → files/, Class B (TEXT) → notes/, Class C (CODE_FILE) → code/
		const payloads = capturedEntries.filter(
			(e) => e.name !== "MANIFEST.txt",
		);
		const folders = payloads.map((e) => e.name.split("/")[0]).sort();
		expect(folders).toEqual(["code", "files", "notes"]);
		expect(payloads).toHaveLength(3);
	});

	it("mid-ZIP failure: getObjectStream throws → that entry is skipped, archive still finalizes", async () => {
		const contexts = [
			makeClassAContext({ id: "good", s3Path: "projects/p1/good.pdf" }),
			makeClassAContext({ id: "bad", s3Path: "projects/p1/missing.pdf" }),
		];
		mockListContextsForDownload.mockResolvedValueOnce(contexts);
		mockGetObjectStream.mockImplementationOnce(async () =>
			Readable.from(["ok"]),
		);
		mockGetObjectStream.mockImplementationOnce(async () => {
			throw Object.assign(new Error("boom"), { name: "NoSuchKey" });
		});

		const result = (await runHandler({
			input: { projectId: "proj-1", organizationId: null },
		})) as { skippedCount: number; includedCount: number };

		expect(result.includedCount).toBe(1);
		expect(result.skippedCount).toBe(1);

		const manifest = capturedEntries.find((e) => e.name === "MANIFEST.txt");
		expect(manifest?.content).toContain(
			"Source object not found in storage",
		);
	});

	it("Class B with empty content is skipped as Content unavailable", async () => {
		mockListContextsForDownload.mockResolvedValueOnce([
			makeClassBContext({ id: "empty", content: "" }),
		]);

		const result = (await runHandler({
			input: { projectId: "proj-1", organizationId: null },
		})) as { includedCount: number; skippedCount: number };
		expect(result.includedCount).toBe(0);
		expect(result.skippedCount).toBe(1);
		const manifest = capturedEntries.find((e) => e.name === "MANIFEST.txt");
		expect(manifest?.content).toContain("Content unavailable");
	});

	it("Class B with PENDING extraction status is skipped as Context not ready", async () => {
		mockListContextsForDownload.mockResolvedValueOnce([
			makeClassBContext({
				id: "pending",
				content: "partial",
				extractionStatus: "PENDING",
			}),
		]);

		const result = (await runHandler({
			input: { projectId: "proj-1", organizationId: null },
		})) as { skippedCount: number };
		expect(result.skippedCount).toBe(1);
		const manifest = capturedEntries.find((e) => e.name === "MANIFEST.txt");
		expect(manifest?.content).toContain("Context not ready");
	});

	it("collision handling: two TEXT contexts with same slug dedupe in notes/", async () => {
		mockListContextsForDownload.mockResolvedValueOnce([
			makeClassBContext({
				id: "b1",
				content: "first",
				metadata: { title: "Spec" },
			}),
			makeClassBContext({
				id: "b2",
				content: "second",
				metadata: { title: "Spec" },
			}),
		]);

		await runHandler({
			input: { projectId: "proj-1", organizationId: null },
		});

		const names = capturedEntries
			.filter((e) => e.name !== "MANIFEST.txt")
			.map((e) => e.name);
		expect(names).toContain("notes/spec.md");
		expect(names).toContain("notes/spec-1.md");
	});

	// -------------------------------------------------------------------------
	// Invariant: manifest count == zip file-entry count.
	//
	// These two cases pin the contract that the procedure cannot ship a zip
	// whose file count diverges from the manifest's `Context count` line, and
	// that `Total size` always matches the bytes actually placed in the zip.
	// -------------------------------------------------------------------------

	it("N=3: zip contains exactly 4 entries (3 contexts + MANIFEST.txt) and the manifest count matches", async () => {
		// Arrange — choose byte counts that produce a clean, deterministic
		// `Total size` formatted as `4.0 KB`. Class A contributes `fileSize`;
		// Class B/C contribute UTF-8 byte length of `content`.
		const classABytes = 1024;
		const classBBytes = 2048;
		const classCBytes = 1024;
		const contexts = [
			makeClassAContext({ id: "a1", fileSize: classABytes }),
			makeClassBContext({
				id: "b1",
				content: "a".repeat(classBBytes),
			}),
			makeClassCContext({
				id: "c1",
				content: "b".repeat(classCBytes),
			}),
		];
		mockListContextsForDownload.mockResolvedValueOnce(contexts);

		// Act
		const result = (await runHandler({
			input: { projectId: "proj-1", organizationId: null },
		})) as {
			includedCount: number;
			skippedCount: number;
			totalCount: number;
		};

		// Assert — zip-level invariant
		expect(capturedEntries).toHaveLength(4);
		expect(capturedEntries.at(-1)?.name).toBe("MANIFEST.txt");
		const fileEntries = capturedEntries.filter(
			(e) => e.name !== "MANIFEST.txt",
		);
		expect(fileEntries).toHaveLength(3);

		// Assert — procedure result mirrors the zip
		expect(result.includedCount).toBe(3);
		expect(result.skippedCount).toBe(0);
		expect(result.totalCount).toBe(3);

		// Assert — manifest text invariant
		const manifest = capturedEntries.find((e) => e.name === "MANIFEST.txt");
		expect(manifest?.content).toContain(
			"Context count : 3 included, 0 skipped",
		);
		// 1024 + 2048 + 1024 = 4096 bytes → `4.0 KB` via humanReadableBytes.
		expect(manifest?.content).toContain("Total size    : 4.0 KB");
	});

	it("N=0: zip contains exactly 1 entry (MANIFEST.txt) and reports zero contexts at zero bytes", async () => {
		// Arrange
		mockListContextsForDownload.mockResolvedValueOnce([]);

		// Act
		const result = (await runHandler({
			input: { projectId: "proj-1", organizationId: null },
		})) as {
			includedCount: number;
			skippedCount: number;
			totalCount: number;
		};

		// Assert — zip-level invariant
		expect(capturedEntries).toHaveLength(1);
		expect(capturedEntries[0]?.name).toBe("MANIFEST.txt");

		// Assert — procedure result mirrors the zip
		expect(result.includedCount).toBe(0);
		expect(result.skippedCount).toBe(0);
		expect(result.totalCount).toBe(0);

		// Assert — manifest text invariant
		const manifest = capturedEntries[0];
		expect(manifest?.content).toContain(
			"Context count : 0 included, 0 skipped",
		);
		expect(manifest?.content).toContain("Total size    : 0 B");
	});
});
