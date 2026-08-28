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
	mockUrlPageFindMany,
	mockGetCapturedConversationMarkdown,
	mockGetObjectStream,
	mockPutObjectStream,
	mockGetSignedUrl,
	mockDeleteObjects,
	mockVerifyOrganizationMembership,
} = vi.hoisted(() => ({
	mockListContextsForDownload: vi.fn(),
	mockGetProjectForDownload: vi.fn(),
	mockUrlPageFindMany: vi.fn(),
	mockGetCapturedConversationMarkdown: vi.fn(),
	mockGetObjectStream: vi.fn(),
	mockPutObjectStream: vi.fn(),
	mockGetSignedUrl: vi.fn(),
	mockDeleteObjects: vi.fn(),
	mockVerifyOrganizationMembership: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	listContextsForDownload: mockListContextsForDownload,
	getProjectForDownload: mockGetProjectForDownload,
	// Monitored Teams / Slack channels read their transcript out of
	// `ProjectContextConversationBundle` children through this query — the
	// same parent/child shape as a crawled link, one feature over.
	getCapturedConversationMarkdown: mockGetCapturedConversationMarkdown,
	// Crawled (`PATH_PREFIX`) LINK contexts read their markdown out of
	// `ProjectContextUrlPage` children via the shared assembly helper.
	db: {
		projectContextUrlPage: {
			findMany: mockUrlPageFindMany,
		},
	},
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
	// The cleanup an archive that dies mid-stream owes: the object is already
	// uploaded by then and nobody is ever handed a URL for it.
	deleteObjects: mockDeleteObjects,
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

/**
 * The manifest builder, wrapped rather than replaced: every test but one runs
 * the real implementation (the MANIFEST's text is what most of this file
 * asserts on), and the exception makes it throw to reach the one failure inside
 * the guarded region that happens BEFORE anything is handed to the archive.
 */
const { manifestBuildError } = vi.hoisted(() => ({
	manifestBuildError: { current: null as Error | null },
}));

vi.mock("../../../lib/context-download-manifest", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("../../../lib/context-download-manifest")
		>();
	return {
		...actual,
		buildContextDownloadManifest: (
			args: Parameters<typeof actual.buildContextDownloadManifest>[0],
		) => {
			if (manifestBuildError.current) {
				throw manifestBuildError.current;
			}
			return actual.buildContextDownloadManifest(args);
		},
	};
});

// Collect archive entries in-memory so we can assert on structure.
interface CapturedEntry {
	name: string;
	kind: "stream" | "string";
	content?: string;
}
let capturedEntries: CapturedEntry[] = [];
/**
 * Make the fake archiver emit a fatal `error` once this many entries have been
 * appended, modelling a build that dies with bytes already uploaded. Null
 * disables it, which is every test that does not say otherwise.
 */
let archiveFailsAfterEntries: number | null = null;
/**
 * Make `finalize()` reject, modelling archiver failing on the final flush —
 * one of the three exits that used to walk past the orphan cleanup. Null
 * disables it.
 */
let archiveFinalizeError: Error | null = null;
/**
 * Whether a rejecting `finalize()` still ends the archive's output stream.
 *
 * `true` models a flush that got its bytes out and then failed. `false` models
 * the stall — the sink is left waiting on a stream that will never end, which
 * is the case where a delete issued straight away would race the upload that is
 * still running underneath it.
 */
let archiveFinalizeEndsStream = true;
// Stream-bodied entries (every Class B/C payload, and Class A object reads)
// are appended as a Readable, so their text only exists once the stream has
// drained. `runHandler` awaits these before the assertions run.
let pendingStreamReads: Array<Promise<void>> = [];

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
						const entry: CapturedEntry = {
							name: options.name,
							kind: "stream",
							content: "",
						};
						capturedEntries.push(entry);
						// Drain (avoids leaked handles) while accumulating the
						// bytes, so tests can assert on synthesized payload text
						// and not just on entry names.
						pendingStreamReads.push(
							new Promise<void>((resolve) => {
								const chunks: Buffer[] = [];
								body.on("data", (chunk: Buffer | string) => {
									chunks.push(Buffer.from(chunk));
								});
								body.on("end", () => {
									entry.content =
										Buffer.concat(chunks).toString("utf8");
									resolve();
								});
								body.on("error", () => resolve());
							}),
						);
					}
					// A fatal archiver error AFTER bytes have gone out — the
					// only shape of failure that can orphan the uploaded
					// object, since the upload runs concurrently with the
					// writes. Fired once, from the entry count the test names.
					if (
						archiveFailsAfterEntries !== null &&
						capturedEntries.length === archiveFailsAfterEntries
					) {
						for (const fn of handlers.get("error") ?? []) {
							fn(new Error("archive stream aborted"));
						}
					}
				},
				async finalize() {
					if (archiveFinalizeError) {
						// A flush that failed may or may not have got its bytes
						// out; the flag says which, and the handler has to
						// collect the orphan either way.
						if (archiveFinalizeEndsStream) {
							passthrough.end("ZIP");
						}
						throw archiveFinalizeError;
					}
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
	extractionStatus: string | null;
	urlScope: string | null;
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
		urlScope: null,
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
		urlScope: null,
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
		urlScope: null,
		extractionStatus: "COMPLETED",
		metadata: { path: "src/hello.ts" },
		createdAt: new Date("2026-04-03T12:00:00Z"),
		...partial,
	};
}

/**
 * A LINK crawled with `urlScope = "PATH_PREFIX"`. The crawl parks the markdown
 * on `ProjectContextUrlPage` children, so the parent's `content` is empty by
 * design — not because the row is broken.
 */
function makeCrawledLinkContext(partial: Partial<TestCtx> = {}): TestCtx {
	return {
		id: `ctx_${Math.random().toString(36).slice(2)}`,
		type: "LINK",
		content: "",
		s3Path: null,
		s3Bucket: null,
		originalFilename: null,
		mimeType: null,
		fileSize: null,
		sourceTitle: "Handbook",
		sourceUrl: "https://example.com/handbook",
		urlScope: "PATH_PREFIX",
		extractionStatus: "COMPLETED",
		metadata: { title: "Handbook" },
		createdAt: new Date("2026-04-04T12:00:00Z"),
		...partial,
	};
}

/**
 * A monitored Teams / Slack channel. Its `ProjectContext` row is a pointer —
 * a cursor and dedup markers, never the messages — so `content` is empty by
 * design, exactly like a crawled link's parent. The transcript lives in
 * `ProjectContextConversationBundle` children.
 */
function makeMonitoredChannelContext(partial: Partial<TestCtx> = {}): TestCtx {
	return {
		id: `ctx_${Math.random().toString(36).slice(2)}`,
		type: "INTEGRATION",
		content: "",
		s3Path: null,
		s3Bucket: null,
		originalFilename: null,
		mimeType: null,
		fileSize: null,
		sourceTitle: "#delivery",
		sourceUrl: null,
		urlScope: null,
		extractionStatus: "COMPLETED",
		metadata: {
			provider: "SLACK",
			channelId: "C123",
			channelName: "delivery",
			title: "#delivery",
		},
		createdAt: new Date("2026-04-05T12:00:00Z"),
		...partial,
	};
}

/**
 * One stored bundle's text, in the shape `formatConversationBundle` writes it
 * at capture time: headed with the window the bundle covers, then the
 * messages. The export never composes this heading — it inherits it — which is
 * what AE11 turns on.
 */
function bundleText(params: {
	channel: string;
	from: string;
	to: string;
	lines: string[];
}): string {
	return [
		`## Conversation in #${params.channel} — ${params.from} to ${params.to}`,
		"",
		...params.lines,
	].join("\n");
}

/** How `getCapturedConversationMarkdown` joins bundles: oldest first, ruled. */
function capturedMarkdown(...bundles: string[]): string {
	return bundles.join("\n\n---\n\n");
}

/** An ordinary single-URL LINK, whose markdown sits on the row itself. */
function makeSinglePageLinkContext(partial: Partial<TestCtx> = {}): TestCtx {
	return {
		...makeCrawledLinkContext(),
		content: "# Changelog\n\nEverything is on the row.",
		sourceTitle: "Changelog",
		sourceUrl: "https://example.com/changelog",
		urlScope: "SINGLE_PAGE",
		metadata: { title: "Changelog" },
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
	const result = await handler({
		input: args.input,
		context: args.context ?? baseContext,
	});
	// Let every appended Readable finish draining so `CapturedEntry.content`
	// is populated by the time the caller asserts on it.
	await Promise.all(pendingStreamReads);
	return result;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createContextsBatchDownloadUrl", () => {
	beforeEach(() => {
		mockListContextsForDownload.mockReset();
		mockGetProjectForDownload.mockReset();
		mockUrlPageFindMany.mockReset();
		mockUrlPageFindMany.mockResolvedValue([]);
		mockGetCapturedConversationMarkdown.mockReset();
		// Nothing captured is the default, so a test that says nothing about
		// conversations describes a channel with no bundles.
		mockGetCapturedConversationMarkdown.mockResolvedValue("");
		mockGetObjectStream.mockReset();
		mockPutObjectStream.mockReset();
		mockGetSignedUrl.mockReset();
		mockDeleteObjects.mockReset();
		mockDeleteObjects.mockResolvedValue({ deleted: 1, errors: [] });
		mockVerifyOrganizationMembership.mockReset();
		capturedEntries = [];
		pendingStreamReads = [];
		archiveFailsAfterEntries = null;
		archiveFinalizeError = null;
		archiveFinalizeEndsStream = true;
		manifestBuildError.current = null;
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

	it("rejects projects exceeding MAX_BATCH_DOWNLOAD_BYTES, without building anything", async () => {
		// The size ceiling stays a genuine refusal — unlike the item ceiling,
		// which truncates. There is no truthful partial archive to hand back
		// when the weight is what makes the build impossible, so nothing is
		// uploaded and no URL is signed.
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

		expect(capturedEntries).toHaveLength(0);
		expect(mockPutObjectStream).not.toHaveBeenCalled();
		expect(mockGetSignedUrl).not.toHaveBeenCalled();
		// And nothing to collect: the refusal lands before a key is even
		// minted, so there is no object for the orphan cleanup to chase.
		expect(mockDeleteObjects).not.toHaveBeenCalled();
	});

	it("leaves a row with nothing to export out of the pre-flight estimate", async () => {
		// The estimate weighs the rows this build intends to WRITE. A Class A
		// row with no storage location is skipped rather than written, so its
		// recorded `fileSize` — which describes an object the export cannot
		// reach — must not be able to refuse an export that would otherwise
		// fit.
		mockListContextsForDownload.mockResolvedValueOnce([
			makeClassAContext({
				id: "orphan",
				s3Path: null,
				fileSize: 500 * 1024 * 1024 + 1,
			}),
			makeClassBContext({ id: "b1", content: "still exports" }),
		]);

		const result = (await runHandler({
			input: { projectId: "proj-1", organizationId: null },
		})) as { includedCount: number; skippedCount: number };

		expect(result.includedCount).toBe(1);
		expect(result.skippedCount).toBe(1);
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

	it("Class B with empty content is skipped as nothing stored, even when extraction COMPLETED", async () => {
		// Emptiness — not extraction state — is what makes a text-bearing row
		// unexportable: there is nothing to put in the zip. Pinned with an
		// explicit COMPLETED so this skip can never be read as a status gate.
		mockListContextsForDownload.mockResolvedValueOnce([
			makeClassBContext({
				id: "empty",
				content: "",
				extractionStatus: "COMPLETED",
			}),
		]);

		const result = (await runHandler({
			input: { projectId: "proj-1", organizationId: null },
		})) as {
			includedCount: number;
			skippedCount: number;
			skippedByReason: Record<string, number>;
		};
		expect(result.includedCount).toBe(0);
		expect(result.skippedCount).toBe(1);
		expect(result.skippedByReason.NOTHING_STORED).toBe(1);
		const manifest = capturedEntries.find((e) => e.name === "MANIFEST.txt");
		expect(manifest?.content).toContain("No content stored for this item");
	});

	// -------------------------------------------------------------------------
	// Extraction status never gates a text-bearing export — Fizzy #2228.
	//
	// This block used to assert the opposite: a Class B/C context whose
	// extraction had not reached COMPLETED was skipped as "Context not ready",
	// which silently dropped text Fabric already held (an integration parked in
	// PENDING, a partial extraction that later FAILED). Text we have beats no
	// text at all, so such a row now ships and the manifest marks it as
	// possibly short of its source instead of hiding it.
	// -------------------------------------------------------------------------

	/** The MANIFEST.txt payload captured during the current run. */
	function manifestText(): string {
		return (
			capturedEntries.find((e) => e.name === "MANIFEST.txt")?.content ??
			""
		);
	}

	/** Entry names appended to the archive, excluding the manifest. */
	function archivedNames(): string[] {
		return capturedEntries
			.filter((e) => e.name !== "MANIFEST.txt")
			.map((e) => e.name);
	}

	it("Class B whose extraction FAILED is exported, not skipped", async () => {
		mockListContextsForDownload.mockResolvedValueOnce([
			makeClassBContext({
				id: "failed",
				content: "the partial text we already hold",
				extractionStatus: "FAILED",
			}),
		]);

		const result = (await runHandler({
			input: { projectId: "proj-1", organizationId: null },
		})) as { includedCount: number; skippedCount: number };

		expect(result.includedCount).toBe(1);
		expect(result.skippedCount).toBe(0);
		expect(archivedNames()).toEqual(["notes/kickoff-notes.md"]);
		expect(manifestText()).toContain("1 included, 0 skipped");
		expect(manifestText()).not.toContain("--- SKIPPED");
		expect(manifestText()).not.toContain("Context not ready");
		expect(manifestText()).toContain(
			"notes/kickoff-notes.md  (extraction FAILED — text may be incomplete)",
		);
	});

	it.each(["PENDING", "EXTRACTING"])(
		"Class B with %s extraction status is exported and marked as possibly incomplete",
		async (status) => {
			mockListContextsForDownload.mockResolvedValueOnce([
				makeClassBContext({
					id: "in-flight",
					content: "partial",
					extractionStatus: status,
				}),
			]);

			const result = (await runHandler({
				input: { projectId: "proj-1", organizationId: null },
			})) as { includedCount: number; skippedCount: number };

			expect(result.includedCount).toBe(1);
			expect(result.skippedCount).toBe(0);
			expect(archivedNames()).toEqual(["notes/kickoff-notes.md"]);
			expect(manifestText()).toContain(
				`notes/kickoff-notes.md  (extraction ${status} — text may be incomplete)`,
			);
		},
	);

	it("Class B whose extraction COMPLETED carries no incompleteness marker", async () => {
		mockListContextsForDownload.mockResolvedValueOnce([
			makeClassBContext({
				id: "done",
				content: "the whole thing",
				extractionStatus: "COMPLETED",
			}),
		]);

		const result = (await runHandler({
			input: { projectId: "proj-1", organizationId: null },
		})) as { includedCount: number; skippedCount: number };

		expect(result.includedCount).toBe(1);
		expect(result.skippedCount).toBe(0);
		expect(manifestText()).toContain("notes/kickoff-notes.md");
		expect(manifestText()).not.toContain("may be incomplete");
	});

	it("Class B with no extraction status at all is exported unmarked", async () => {
		// Free text never goes through extraction, so the column can come back
		// empty. That is not a reason to withhold the text, nor to warn about
		// its completeness.
		mockListContextsForDownload.mockResolvedValueOnce([
			makeClassBContext({
				id: "no-status",
				content: "typed straight into the app",
				extractionStatus: null,
			}),
		]);

		const result = (await runHandler({
			input: { projectId: "proj-1", organizationId: null },
		})) as { includedCount: number; skippedCount: number };

		expect(result.includedCount).toBe(1);
		expect(result.skippedCount).toBe(0);
		expect(archivedNames()).toEqual(["notes/kickoff-notes.md"]);
		expect(manifestText()).not.toContain("may be incomplete");
	});

	it("Class C marks only the row whose extraction FAILED, not its healthy sibling", async () => {
		mockListContextsForDownload.mockResolvedValueOnce([
			makeClassCContext({
				id: "c-failed",
				content: "half a file",
				sourceTitle: "src/broken.ts",
				metadata: { title: "broken" },
				extractionStatus: "FAILED",
			}),
			makeClassCContext({
				id: "c-done",
				content: "a whole file",
				sourceTitle: "src/whole.ts",
				metadata: { title: "whole" },
				extractionStatus: "COMPLETED",
			}),
		]);

		const result = (await runHandler({
			input: { projectId: "proj-1", organizationId: null },
		})) as { includedCount: number; skippedCount: number };

		expect(result.includedCount).toBe(2);
		expect(result.skippedCount).toBe(0);
		expect(archivedNames()).toEqual(["code/broken.txt", "code/whole.txt"]);
		expect(manifestText()).toContain(
			"code/broken.txt  (extraction FAILED — text may be incomplete)",
		);
		// The healthy sibling's row ends at its path — the marker is per-row.
		expect(manifestText()).toMatch(/code\/whole\.txt\s*$/m);
	});

	it("Class A whose extraction FAILED still ships its raw bytes, unmarked", async () => {
		// Extraction status describes derived text, not the stored object. A
		// failed extraction says nothing about the completeness of the upload,
		// so the binary path must be untouched by this rule.
		mockListContextsForDownload.mockResolvedValueOnce([
			makeClassAContext({
				id: "a-failed",
				s3Path: "projects/p1/file.pdf",
				extractionStatus: "FAILED",
			}),
		]);

		const result = (await runHandler({
			input: { projectId: "proj-1", organizationId: null },
		})) as { includedCount: number; skippedCount: number };

		expect(result.includedCount).toBe(1);
		expect(result.skippedCount).toBe(0);
		expect(mockGetObjectStream).toHaveBeenCalledTimes(1);
		expect(capturedEntries[0]).toMatchObject({
			name: "files/spec.pdf",
			kind: "stream",
		});
		expect(manifestText()).not.toContain("may be incomplete");
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
	// -------------------------------------------------------------------------
	// Crawled (`PATH_PREFIX`) LINK contexts — Fizzy #2228.
	//
	// A crawled link parks its markdown on `ProjectContextUrlPage` children and
	// leaves `parent.content` empty. The single-item download has always
	// reassembled those children; the batch export read `content`, saw nothing,
	// and skipped the row — so the same link exported fine one-at-a-time and
	// vanished from "Download All". These pin the shared assembly.
	// -------------------------------------------------------------------------

	it("crawled link with empty parent content is included, assembled from its child pages", async () => {
		const link = makeCrawledLinkContext({ id: "link-crawled" });
		mockListContextsForDownload.mockResolvedValueOnce([link]);
		mockUrlPageFindMany.mockResolvedValue([
			{
				pageUrl: "https://example.com/handbook/a",
				pageTitle: "Onboarding",
				content: "Day one.",
			},
			{
				pageUrl: "https://example.com/handbook/b",
				pageTitle: null,
				content: "Day two.",
			},
		]);

		const result = (await runHandler({
			input: { projectId: "proj-1", organizationId: null },
		})) as { includedCount: number; skippedCount: number };

		expect(result.includedCount).toBe(1);
		expect(result.skippedCount).toBe(0);

		const entry = capturedEntries.find((e) => e.name !== "MANIFEST.txt");
		expect(entry?.name).toBe("links/handbook.md");
		expect(entry?.content).toContain("Day one.");
		expect(entry?.content).toContain("Day two.");

		// The child-page lookup re-derives tenant XOR from the caller, never
		// from the parent row.
		expect(mockUrlPageFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					parentContextId: "link-crawled",
					organizationId: null,
					userId: "user-1",
				},
				orderBy: { pageUrl: "asc" },
			}),
		);
	});

	it("crawled link's archive entry is byte-identical to what the single-item path builds for the same row", async () => {
		const link = makeCrawledLinkContext({ id: "link-parity" });
		mockListContextsForDownload.mockResolvedValueOnce([link]);
		mockUrlPageFindMany.mockResolvedValue([
			{
				pageUrl: "https://example.com/handbook/a",
				pageTitle: "Onboarding",
				content: "Day one.",
			},
			{
				pageUrl: "https://example.com/handbook/b",
				pageTitle: null,
				content: "Day two.",
			},
		]);

		await runHandler({
			input: { projectId: "proj-1", organizationId: null },
		});

		// Rebuild the payload the way `create-context-download-url` does: the
		// shared `buildPathPrefixMarkdown` for the body, then the shared
		// `buildContextTextPayload` header. Both procedures now call the same
		// two helpers, and this asserts the batch actually produces their
		// output rather than an approximation of it.
		const { buildPathPrefixMarkdown } = await import(
			"../../../lib/path-prefix-link-markdown"
		);
		const { buildContextTextPayload } = await import(
			"../../../lib/build-context-text-payload"
		);
		const expected = buildContextTextPayload({
			id: link.id,
			title: "Handbook",
			type: "LINK",
			integrationProvider: null,
			createdAt: link.createdAt,
			content: await buildPathPrefixMarkdown(link.id, {
				organizationId: null,
				userId: "user-1",
			}),
		});

		const entry = capturedEntries.find((e) => e.name !== "MANIFEST.txt");
		expect(entry?.content).toBe(expected);
	});

	it("crawled link whose children hold no content is skipped as Crawl indexed no pages, not as an empty row", async () => {
		mockListContextsForDownload.mockResolvedValueOnce([
			makeCrawledLinkContext({ id: "link-empty-crawl" }),
		]);
		// The crawl produced rows but indexed nothing usable — and the
		// zero-child case collapses to the same empty assembly.
		mockUrlPageFindMany.mockResolvedValue([
			{
				pageUrl: "https://example.com/handbook/a",
				pageTitle: "Onboarding",
				content: "",
			},
		]);

		const result = (await runHandler({
			input: { projectId: "proj-1", organizationId: null },
		})) as {
			includedCount: number;
			skippedCount: number;
			skippedByReason: Record<string, number>;
		};

		expect(result.includedCount).toBe(0);
		expect(result.skippedCount).toBe(1);
		expect(result.skippedByReason.CRAWL_INDEXED_NO_PAGES).toBe(1);
		expect(result.skippedByReason.NOTHING_STORED).toBe(0);

		const manifest = capturedEntries.find((e) => e.name === "MANIFEST.txt");
		expect(manifest?.content).toContain("Crawl indexed no pages");
		expect(manifest?.content).not.toContain(
			"No content stored for this item",
		);
	});

	it("crawled link with zero child pages is skipped as Crawl indexed no pages", async () => {
		mockListContextsForDownload.mockResolvedValueOnce([
			makeCrawledLinkContext({ id: "link-no-children" }),
		]);
		mockUrlPageFindMany.mockResolvedValue([]);

		const result = (await runHandler({
			input: { projectId: "proj-1", organizationId: null },
		})) as { skippedCount: number };

		expect(result.skippedCount).toBe(1);
		const manifest = capturedEntries.find((e) => e.name === "MANIFEST.txt");
		expect(manifest?.content).toContain("Crawl indexed no pages");
	});

	it("ordinary single-URL link is included straight off the row, with no child-page query", async () => {
		mockListContextsForDownload.mockResolvedValueOnce([
			makeSinglePageLinkContext({ id: "link-single" }),
		]);

		const result = (await runHandler({
			input: { projectId: "proj-1", organizationId: null },
		})) as { includedCount: number; skippedCount: number };

		expect(result.includedCount).toBe(1);
		expect(result.skippedCount).toBe(0);

		const entry = capturedEntries.find((e) => e.name !== "MANIFEST.txt");
		expect(entry?.name).toBe("links/changelog.md");
		expect(entry?.content).toContain("Everything is on the row.");

		// The cheap path stays cheap — no per-link round-trip for a link that
		// never had children.
		expect(mockUrlPageFindMany).not.toHaveBeenCalled();
	});

	it("issues the child-page query once per crawled link, not once per context", async () => {
		mockListContextsForDownload.mockResolvedValueOnce([
			makeClassAContext({ id: "a1" }),
			makeClassBContext({ id: "b1" }),
			makeClassCContext({ id: "c1" }),
			makeSinglePageLinkContext({ id: "link-single" }),
			makeCrawledLinkContext({ id: "link-crawled-1" }),
			makeCrawledLinkContext({
				id: "link-crawled-2",
				sourceTitle: "Guides",
				metadata: { title: "Guides" },
			}),
		]);
		mockUrlPageFindMany.mockResolvedValue([
			{
				pageUrl: "https://example.com/handbook/a",
				pageTitle: "Onboarding",
				content: "Day one.",
			},
		]);

		const result = (await runHandler({
			input: { projectId: "proj-1", organizationId: "org-1" },
		})) as { includedCount: number; totalCount: number };

		expect(result.totalCount).toBe(6);
		expect(result.includedCount).toBe(6);

		// Six contexts, two of them crawled links → exactly two lookups.
		expect(mockUrlPageFindMany).toHaveBeenCalledTimes(2);
		const parentIds = mockUrlPageFindMany.mock.calls.map(
			(call) =>
				(call[0] as { where: { parentContextId: string } }).where
					.parentContextId,
		);
		expect(parentIds).toEqual(["link-crawled-1", "link-crawled-2"]);
		// Org callers filter on the organization alone — no personal fallback.
		for (const call of mockUrlPageFindMany.mock.calls) {
			expect((call[0] as { where: unknown }).where).toEqual({
				parentContextId: expect.any(String),
				organizationId: "org-1",
			});
		}
	});

	// -------------------------------------------------------------------------
	// Captured conversations on monitored channels — Fizzy #2228.
	//
	// A linked Teams / Slack channel's context row is a pointer; the messages
	// are captured into `ProjectContextConversationBundle` children, embedded,
	// and readable through assistant retrieval and the MCP gateway. The batch
	// export read the pointer's empty `content`, saw nothing, and reported
	// "Linked Slack conversation — no messages captured yet" for a channel
	// whose transcripts Fabric was already citing — a false statement about
	// content it holds. These pin the assembly that fixes it.
	// -------------------------------------------------------------------------

	it("Covers AE5. a monitored channel with a captured bundle is included, carrying the bundle's text", async () => {
		const channel = makeMonitoredChannelContext({ id: "chan-slack" });
		mockListContextsForDownload.mockResolvedValueOnce([channel]);
		mockGetCapturedConversationMarkdown.mockResolvedValue(
			capturedMarkdown(
				bundleText({
					channel: "delivery",
					from: "2026-04-05T09:00:00.000Z",
					to: "2026-04-05T09:45:00.000Z",
					lines: [
						"**Dana** (2026-04-05T09:00:00.000Z): the migration is queued",
					],
				}),
			),
		);

		const result = (await runHandler({
			input: { projectId: "proj-1", organizationId: null },
		})) as {
			includedCount: number;
			skippedCount: number;
			skippedByReason: Record<string, number>;
		};

		expect(result.includedCount).toBe(1);
		expect(result.skippedCount).toBe(0);
		expect(result.skippedByReason.CONVERSATION_NOT_CAPTURED).toBe(0);

		const entry = capturedEntries.find((e) => e.name !== "MANIFEST.txt");
		expect(entry?.name).toBe("integrations/slack/delivery.md");
		expect(entry?.content).toContain("the migration is queued");
		expect(manifestText()).not.toContain("no messages captured yet");

		// The bundle read re-derives tenant XOR from the caller, never from
		// the parent row.
		expect(mockGetCapturedConversationMarkdown).toHaveBeenCalledWith(
			"chan-slack",
			{ userId: "user-1", organizationId: null },
		);
	});

	it("Covers AE6. a channel captured twice produces one entry holding both bundles in order, not two entries", async () => {
		const first = bundleText({
			channel: "delivery",
			from: "2026-04-05T09:00:00.000Z",
			to: "2026-04-05T09:45:00.000Z",
			lines: [
				"**Dana** (2026-04-05T09:00:00.000Z): the migration is queued",
			],
		});
		const second = bundleText({
			channel: "delivery",
			from: "2026-04-06T11:00:00.000Z",
			to: "2026-04-06T11:20:00.000Z",
			lines: [
				"**Dana** (2026-04-06T11:00:00.000Z): the migration is finished",
			],
		});
		mockListContextsForDownload.mockResolvedValueOnce([
			makeMonitoredChannelContext({ id: "chan-two-bundles" }),
		]);
		// Oldest first, which is the order `listConversationBundlesForContext`
		// reads them in — `bundleStartedAt ASC`, so a bundle captured late for
		// an earlier window still sorts where the conversation happened.
		mockGetCapturedConversationMarkdown.mockResolvedValue(
			capturedMarkdown(first, second),
		);

		const result = (await runHandler({
			input: { projectId: "proj-1", organizationId: null },
		})) as { includedCount: number };

		// One channel, one archive entry — bundles are child rows, so they
		// never become items of their own.
		expect(result.includedCount).toBe(1);
		expect(archivedNames()).toEqual(["integrations/slack/delivery.md"]);

		const entry = capturedEntries.find((e) => e.name !== "MANIFEST.txt");
		const body = entry?.content ?? "";
		expect(body).toContain("the migration is queued");
		expect(body).toContain("the migration is finished");
		expect(body.indexOf("the migration is queued")).toBeLessThan(
			body.indexOf("the migration is finished"),
		);
	});

	it("Covers AE11. the channel's archive entry states the period its captured content covers", async () => {
		mockListContextsForDownload.mockResolvedValueOnce([
			makeMonitoredChannelContext({ id: "chan-coverage" }),
		]);
		mockGetCapturedConversationMarkdown.mockResolvedValue(
			capturedMarkdown(
				bundleText({
					channel: "delivery",
					from: "2026-04-05T09:00:00.000Z",
					to: "2026-04-05T09:45:00.000Z",
					lines: ["**Dana** (2026-04-05T09:00:00.000Z): morning"],
				}),
				bundleText({
					channel: "delivery",
					from: "2026-04-06T11:00:00.000Z",
					to: "2026-04-06T11:20:00.000Z",
					lines: ["**Dana** (2026-04-06T11:00:00.000Z): afternoon"],
				}),
			),
		);

		await runHandler({
			input: { projectId: "proj-1", organizationId: null },
		});

		// The window is written into each bundle at capture time by
		// `formatConversationBundle`; the export's job is to carry it through
		// intact rather than to re-render or strip it, so every captured
		// window reaches the reader.
		const body =
			capturedEntries.find((e) => e.name !== "MANIFEST.txt")?.content ??
			"";
		expect(body).toContain(
			"2026-04-05T09:00:00.000Z to 2026-04-05T09:45:00.000Z",
		);
		expect(body).toContain(
			"2026-04-06T11:00:00.000Z to 2026-04-06T11:20:00.000Z",
		);
	});

	it("a monitored channel with no captured bundles is still skipped as a conversation, naming its source system", async () => {
		mockListContextsForDownload.mockResolvedValueOnce([
			makeMonitoredChannelContext({ id: "chan-empty" }),
		]);
		mockGetCapturedConversationMarkdown.mockResolvedValue("");

		const result = (await runHandler({
			input: { projectId: "proj-1", organizationId: null },
		})) as {
			includedCount: number;
			skippedCount: number;
			skippedByReason: Record<string, number>;
		};

		// The assembly ran and found nothing — which must still read as an
		// uncaptured conversation, not as a generic empty row and not as a
		// read failure.
		expect(mockGetCapturedConversationMarkdown).toHaveBeenCalledTimes(1);
		expect(result.includedCount).toBe(0);
		expect(result.skippedCount).toBe(1);
		expect(result.skippedByReason.CONVERSATION_NOT_CAPTURED).toBe(1);
		expect(result.skippedByReason.NOTHING_STORED).toBe(0);
		expect(result.skippedByReason.STORAGE_READ_FAILED).toBe(0);
		expect(manifestText()).toContain(
			"Linked Slack conversation — no messages captured yet",
		);
	});

	it("reports a linked group chat as excluded by design, not as awaiting capture", async () => {
		// Capture covers shared channels only. A group or one-to-one chat is
		// left alone deliberately, so the archive must say so — "no messages
		// captured yet" would promise a future export that never comes.
		mockListContextsForDownload.mockResolvedValueOnce([
			makeMonitoredChannelContext({
				id: "chat-group",
				sourceTitle: "Delivery sync",
				metadata: {
					provider: "MICROSOFT_TEAMS",
					chatType: "group",
					chatId: "19:meeting@thread.v2",
					chatTopic: "Delivery sync",
					title: "Delivery sync",
				},
			}),
		]);
		mockGetCapturedConversationMarkdown.mockResolvedValue("");

		const result = (await runHandler({
			input: { projectId: "proj-1", organizationId: null },
		})) as {
			includedCount: number;
			skippedCount: number;
			skippedByReason: Record<string, number>;
		};

		expect(result.includedCount).toBe(0);
		expect(result.skippedCount).toBe(1);
		expect(result.skippedByReason.PRIVATE_CONVERSATION_EXCLUDED).toBe(1);
		// The channel reason must NOT be the one that fires — the whole point
		// of the split is that these two rows read differently.
		expect(result.skippedByReason.CONVERSATION_NOT_CAPTURED).toBe(0);
		expect(result.skippedByReason.NOTHING_STORED).toBe(0);

		const manifest = manifestText();
		expect(manifest).toContain("Delivery sync");
		expect(manifest).toContain(
			"Linked Microsoft Teams chat — one-to-one and group chats are not captured by design; their messages stay in Microsoft Teams",
		);
		expect(manifest).not.toContain("no messages captured yet");
	});

	it("an integration that is not a monitored channel keeps exporting its own row content", async () => {
		// Nothing captured against it, but the row carries text of its own.
		// The captured assembly must supplement `content`, never replace it.
		mockListContextsForDownload.mockResolvedValueOnce([
			makeMonitoredChannelContext({
				id: "integration-doc",
				content: "# Release checklist\n\nOn the row.",
				sourceTitle: "Release checklist",
				metadata: { provider: "SLACK", title: "Release checklist" },
			}),
		]);
		mockGetCapturedConversationMarkdown.mockResolvedValue("");

		const result = (await runHandler({
			input: { projectId: "proj-1", organizationId: null },
		})) as { includedCount: number; skippedCount: number };

		expect(result.includedCount).toBe(1);
		expect(result.skippedCount).toBe(0);
		const entry = capturedEntries.find((e) => e.name !== "MANIFEST.txt");
		expect(entry?.content).toContain("On the row.");
	});

	it("a bundle lookup failure skips that channel as a read failure, and the archive still ships", async () => {
		mockListContextsForDownload.mockResolvedValueOnce([
			makeMonitoredChannelContext({ id: "chan-broken" }),
			makeClassBContext({ id: "b1", content: "still exports" }),
		]);
		mockGetCapturedConversationMarkdown.mockRejectedValue(
			new Error("connection reset"),
		);

		const result = (await runHandler({
			input: { projectId: "proj-1", organizationId: null },
		})) as {
			includedCount: number;
			skippedCount: number;
			skippedByReason: Record<string, number>;
		};

		expect(result.includedCount).toBe(1);
		expect(result.skippedCount).toBe(1);
		expect(result.skippedByReason.STORAGE_READ_FAILED).toBe(1);
		// The failure reports on its own row, rather than being reported as a
		// conversation nobody has captured — the export knows it could not
		// look, which is a different fact from finding nothing.
		expect(result.skippedByReason.CONVERSATION_NOT_CAPTURED).toBe(0);
		expect(archivedNames()).toEqual(["notes/kickoff-notes.md"]);
	});

	it("issues the bundle query once per INTEGRATION row, not once per context", async () => {
		mockListContextsForDownload.mockResolvedValueOnce([
			makeClassAContext({ id: "a1" }),
			makeClassBContext({ id: "b1" }),
			makeClassCContext({ id: "c1" }),
			makeSinglePageLinkContext({ id: "link-single" }),
			makeMonitoredChannelContext({ id: "chan-1" }),
			makeMonitoredChannelContext({
				id: "chan-2",
				sourceTitle: "#platform",
				metadata: {
					provider: "MICROSOFT_TEAMS",
					channelId: "19:abc",
					title: "#platform",
				},
			}),
		]);
		mockGetCapturedConversationMarkdown.mockResolvedValue(
			capturedMarkdown(
				bundleText({
					channel: "delivery",
					from: "2026-04-05T09:00:00.000Z",
					to: "2026-04-05T09:45:00.000Z",
					lines: ["**Dana** (2026-04-05T09:00:00.000Z): hello"],
				}),
			),
		);

		const result = (await runHandler({
			input: { projectId: "proj-1", organizationId: "org-1" },
		})) as { includedCount: number; totalCount: number };

		expect(result.totalCount).toBe(6);
		expect(result.includedCount).toBe(6);

		// Six contexts, two of them channels → exactly two lookups.
		expect(mockGetCapturedConversationMarkdown).toHaveBeenCalledTimes(2);
		expect(
			mockGetCapturedConversationMarkdown.mock.calls.map(
				(call) => call[0],
			),
		).toEqual(["chan-1", "chan-2"]);
		// Org callers carry the organization; the query collapses this to the
		// organization alone, with no personal fallback.
		for (const call of mockGetCapturedConversationMarkdown.mock.calls) {
			expect(call[1]).toEqual({
				userId: "user-1",
				organizationId: "org-1",
			});
		}
	});

	it("counts a captured channel's bundle bytes in the pre-flight estimate", async () => {
		// A channel's text lives on its bundle rows, so `content` is empty and
		// an estimate that only reads the row weighs a whole captured
		// conversation at zero. The Class A row alone sits just under the size
		// ceiling: only the bundles can push the estimate over it.
		const nearlyFull = () =>
			makeClassAContext({
				id: "a-nearly-full",
				fileSize: 500 * 1024 * 1024 - 1024,
			});

		// Control: a short transcript keeps the estimate under the ceiling.
		mockListContextsForDownload.mockResolvedValueOnce([
			nearlyFull(),
			makeMonitoredChannelContext({ id: "chan-small" }),
		]);
		mockGetCapturedConversationMarkdown.mockResolvedValue("y".repeat(32));

		const fits = (await runHandler({
			input: { projectId: "proj-1", organizationId: null },
		})) as { includedCount: number };
		expect(fits.includedCount).toBe(2);

		// The same channel with a longer transcript tips it over — which can
		// only happen if the bundles are being weighed.
		mockListContextsForDownload.mockResolvedValueOnce([
			nearlyFull(),
			makeMonitoredChannelContext({ id: "chan-big" }),
		]);
		mockGetCapturedConversationMarkdown.mockResolvedValue("y".repeat(2048));

		await expect(
			runHandler({
				input: { projectId: "proj-1", organizationId: null },
			}),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			data: { reason: "too_large" },
		});
	});

	// -------------------------------------------------------------------------
	// Two byte counts, and an item ceiling that truncates — Fizzy #2228.
	//
	// The manifest used to report a pre-flight sum over every row the export
	// looked at, including rows it then skipped, so `Total size` described an
	// archive that was never built. And a project past the item ceiling got a
	// `too_many` refusal and no archive at all, even though the ceiling exists
	// to bound build time rather than because the content was too heavy.
	// -------------------------------------------------------------------------

	it("manifest total covers only entries actually written when a storage read fails mid-loop", async () => {
		// One text row lands, then a Class A read blows up after streaming has
		// begun, then another Class A row lands. The pre-flight had weighed all
		// three; only two reached the archive.
		mockListContextsForDownload.mockResolvedValueOnce([
			makeClassBContext({
				id: "b-first",
				content: "a".repeat(1024),
				metadata: { title: "Kickoff" },
			}),
			makeClassAContext({
				id: "a-broken",
				s3Path: "projects/p1/broken.pdf",
				originalFilename: "broken.pdf",
				fileSize: 4096,
				metadata: { title: "Broken" },
			}),
			makeClassAContext({
				id: "a-fine",
				s3Path: "projects/p1/fine.pdf",
				originalFilename: "fine.pdf",
				fileSize: 1024,
				metadata: { title: "Fine" },
			}),
		]);
		mockGetObjectStream.mockImplementation(async (path: string) => {
			if (path === "projects/p1/broken.pdf") {
				throw new Error("connection reset while reading object");
			}
			return Readable.from(["a"]);
		});

		const result = (await runHandler({
			input: { projectId: "proj-1", organizationId: null },
		})) as { includedCount: number; skippedCount: number };

		expect(result.includedCount).toBe(2);
		expect(result.skippedCount).toBe(1);
		expect(manifestText()).toContain("Storage read failed");

		// 1024 (text) + 1024 (the Class A row that read cleanly) = 2 KB. The
		// failed row's 4096 bytes never reached the archive, so they are not
		// the archive's size — the pre-flight's 6 KB is not what is reported.
		expect(manifestText()).toContain("Total size    : 2.0 KB");
		expect(manifestText()).not.toContain("Total size    : 6.0 KB");
	});

	it("a project over the item ceiling still produces an archive, naming every excluded row", async () => {
		const rows = Array.from({ length: 203 }, (_, i) =>
			makeClassBContext({
				id: `ctx_${String(i).padStart(3, "0")}`,
				content: "x",
				metadata: { title: `note ${String(i).padStart(3, "0")}` },
			}),
		);
		mockListContextsForDownload.mockResolvedValueOnce(rows);

		const result = (await runHandler({
			input: { projectId: "proj-1", organizationId: null },
		})) as {
			url: string;
			includedCount: number;
			skippedCount: number;
			excludedCount: number;
			totalCount: number;
		};

		// An archive, not a refusal.
		expect(result.url).toBe("https://signed.example/zip");
		expect(result.totalCount).toBe(203);
		expect(result.includedCount).toBe(200);
		expect(result.excludedCount).toBe(3);
		expect(result.skippedCount).toBe(3);
		expect(archivedNames()).toHaveLength(200);

		// One skip row per excluded item, each naming the item — so the
		// remainder stays retrievable through single-item download.
		const limitLines = manifestText()
			.split("\n")
			.filter((line) => line.includes("Beyond the batch item limit"));
		expect(limitLines).toHaveLength(3);
		expect(limitLines[0]).toContain("note 200");
		expect(limitLines[1]).toContain("note 201");
		expect(limitLines[2]).toContain("note 202");
		expect(manifestText()).toContain("--- SKIPPED (3) ---");
	});

	it("truncation takes the ordered prefix, so a repeat export produces the same archive", async () => {
		const rows = Array.from({ length: 202 }, (_, i) =>
			makeClassBContext({
				id: `ctx_${String(i).padStart(3, "0")}`,
				content: "x",
				metadata: { title: `note ${String(i).padStart(3, "0")}` },
			}),
		);
		mockListContextsForDownload.mockResolvedValue(rows);

		await runHandler({
			input: { projectId: "proj-1", organizationId: null },
		});
		const firstRun = archivedNames();
		const firstManifest = manifestText();

		capturedEntries = [];
		pendingStreamReads = [];

		await runHandler({
			input: { projectId: "proj-1", organizationId: null },
		});

		// Same rows in, same archive out — the cut is a prefix of the query's
		// order, never a sample of it.
		expect(archivedNames()).toEqual(firstRun);
		expect(firstRun[0]).toBe("notes/note-000.md");
		expect(firstRun.at(-1)).toBe("notes/note-199.md");
		expect(firstRun).not.toContain("notes/note-200.md");
		expect(manifestText()).toBe(firstManifest);
	});

	it("a project at exactly the item ceiling is not truncated and reports no exclusions", async () => {
		const rows = Array.from({ length: 200 }, (_, i) =>
			makeClassBContext({
				id: `ctx_${String(i).padStart(3, "0")}`,
				content: "x",
				metadata: { title: `note ${String(i).padStart(3, "0")}` },
			}),
		);
		mockListContextsForDownload.mockResolvedValueOnce(rows);

		const result = (await runHandler({
			input: { projectId: "proj-1", organizationId: null },
		})) as {
			includedCount: number;
			skippedCount: number;
			excludedCount: number;
		};

		expect(result.includedCount).toBe(200);
		expect(result.excludedCount).toBe(0);
		expect(result.skippedCount).toBe(0);
		expect(archivedNames()).toHaveLength(200);
		expect(manifestText()).not.toContain("--- SKIPPED");
	});

	it("counts a crawled link's child-page bytes in the pre-flight estimate", async () => {
		// A crawled link's text lives on its child pages, so `content` is
		// empty and the old estimate weighed the whole site at zero. Here the
		// Class A row alone sits just under the size ceiling: only the child
		// pages can push the estimate over it.
		const nearlyFull = () =>
			makeClassAContext({
				id: "a-nearly-full",
				fileSize: 500 * 1024 * 1024 - 1024,
			});
		const crawledPage = (bytes: number) => [
			{
				pageUrl: "https://example.com/handbook/a",
				pageTitle: "Onboarding",
				content: "y".repeat(bytes),
			},
		];

		// Control: a small page keeps the estimate under the ceiling, and the
		// export goes through.
		mockListContextsForDownload.mockResolvedValueOnce([
			nearlyFull(),
			makeCrawledLinkContext({ id: "link-small" }),
		]);
		mockUrlPageFindMany.mockResolvedValue(crawledPage(32));

		const fits = (await runHandler({
			input: { projectId: "proj-1", organizationId: null },
		})) as { includedCount: number };
		expect(fits.includedCount).toBe(2);

		// A larger page of the same crawled text tips it over — which can only
		// happen if the child pages are being weighed.
		mockListContextsForDownload.mockResolvedValueOnce([
			nearlyFull(),
			makeCrawledLinkContext({ id: "link-big" }),
		]);
		mockUrlPageFindMany.mockResolvedValue(crawledPage(2048));

		await expect(
			runHandler({
				input: { projectId: "proj-1", organizationId: null },
			}),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			data: { reason: "too_large" },
		});
	});

	// -------------------------------------------------------------------------
	// Per-reason skip reporting — Fizzy #2228.
	//
	// The manifest inside the ZIP and the counts handed to the client are two
	// renderings of the same classification. These assert they agree, and that
	// the counts add up to the number the summary quotes.
	// -------------------------------------------------------------------------

	it("returns per-reason counts that sum to the total skipped", async () => {
		mockListContextsForDownload.mockResolvedValueOnce([
			makeClassBContext({ id: "ok", content: "exports fine" }),
			makeClassBContext({ id: "empty", content: "" }),
			makeClassBContext({
				id: "dead",
				content: "",
				type: "LINK",
				urlScope: "SINGLE_PAGE",
				extractionStatus: "FAILED",
			}),
			makeClassAContext({ id: "no-object", s3Path: null }),
			makeCrawledLinkContext({ id: "empty-crawl" }),
		]);
		mockUrlPageFindMany.mockResolvedValue([]);

		const result = (await runHandler({
			input: { projectId: "proj-1", organizationId: null },
		})) as {
			includedCount: number;
			skippedCount: number;
			skippedByReason: Record<string, number>;
		};

		expect(result.includedCount).toBe(1);
		expect(result.skippedCount).toBe(4);
		expect(result.skippedByReason).toMatchObject({
			NOTHING_STORED: 2,
			EXTRACTION_FAILED: 1,
			CRAWL_INDEXED_NO_PAGES: 1,
			CONVERSATION_NOT_CAPTURED: 0,
			BEYOND_ITEM_LIMIT: 0,
		});
		expect(
			Object.values(result.skippedByReason).reduce((a, b) => a + b, 0),
		).toBe(result.skippedCount);
	});

	it("reports a linked channel with nothing captured as a conversation, naming its source system", async () => {
		mockListContextsForDownload.mockResolvedValueOnce([
			makeClassBContext({
				id: "slack-channel",
				type: "INTEGRATION",
				content: "",
				sourceTitle: "#delivery",
				metadata: {
					provider: "SLACK",
					channelId: "C123",
					channelName: "delivery",
					title: "#delivery",
				},
			}),
		]);

		const result = (await runHandler({
			input: { projectId: "proj-1", organizationId: null },
		})) as {
			skippedCount: number;
			skippedByReason: Record<string, number>;
		};

		expect(result.skippedCount).toBe(1);
		expect(result.skippedByReason.CONVERSATION_NOT_CAPTURED).toBe(1);
		expect(result.skippedByReason.NOTHING_STORED).toBe(0);
		expect(manifestText()).toContain(
			"Linked Slack conversation — no messages captured yet",
		);
	});

	it("counts the ceiling remainder under its own reason, never as a processing delay", async () => {
		const rows = Array.from({ length: 202 }, (_, i) =>
			makeClassBContext({
				id: `ctx_${String(i).padStart(3, "0")}`,
				content: "x",
				metadata: { title: `note ${String(i).padStart(3, "0")}` },
			}),
		);
		mockListContextsForDownload.mockResolvedValueOnce(rows);

		const result = (await runHandler({
			input: { projectId: "proj-1", organizationId: null },
		})) as {
			excludedCount: number;
			skippedCount: number;
			skippedByReason: Record<string, number>;
		};

		expect(result.skippedByReason.BEYOND_ITEM_LIMIT).toBe(2);
		// `excludedCount` and the taxonomy must not be able to disagree.
		expect(result.skippedByReason.BEYOND_ITEM_LIMIT).toBe(
			result.excludedCount,
		);
		expect(result.skippedByReason.NOTHING_STORED).toBe(0);
	});

	// -------------------------------------------------------------------------
	// The size ceiling guards memory, so it has to run before the memory —
	// Fizzy #2228.
	//
	// Both child assemblies MATERIALISE text: every crawled link's markdown and
	// every monitored channel's transcript are held for the length of the
	// build. Weighing the project only once all of that had been fetched meant
	// a project refused for size allocated all of it first.
	// -------------------------------------------------------------------------

	it("stops assembling child content once the size ceiling is crossed", async () => {
		// One heavy file puts the build a hair under the ceiling before a
		// single child query runs, so the FIRST crawled link to come back tips
		// it over. Forty links follow it, and one monitored channel after
		// those.
		const links = Array.from({ length: 40 }, (_, i) =>
			makeCrawledLinkContext({
				id: `link-${String(i).padStart(2, "0")}`,
			}),
		);
		mockListContextsForDownload.mockResolvedValueOnce([
			makeClassAContext({
				id: "a-nearly-full",
				fileSize: 500 * 1024 * 1024 - 1024,
			}),
			...links,
			makeMonitoredChannelContext({ id: "chan" }),
		]);
		mockUrlPageFindMany.mockResolvedValue([
			{
				pageUrl: "https://example.com/handbook/a",
				pageTitle: "Onboarding",
				content: "y".repeat(4096),
			},
		]);

		await expect(
			runHandler({
				input: { projectId: "proj-1", organizationId: null },
			}),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			data: { reason: "too_large" },
		});

		// The assertion that matters: the query COUNT, not just the refusal.
		// A ceiling checked after the fan-out would show all forty here.
		expect(mockUrlPageFindMany.mock.calls.length).toBeLessThan(
			links.length,
		);
		// The bounded fan-out dispatches its whole first wave before any of
		// them can report a byte, so the floor is the concurrency cap
		// (`CHILD_ASSEMBLY_CONCURRENCY`, 8) and not one. If that constant
		// changes, this bound is what needs updating — not the behaviour.
		expect(mockUrlPageFindMany.mock.calls.length).toBeLessThanOrEqual(8);
		// The conversation pass runs after the crawl pass, so by the time it
		// is reached the budget is already blown and it must not query at all.
		expect(mockGetCapturedConversationMarkdown).not.toHaveBeenCalled();
		// And nothing was built.
		expect(mockPutObjectStream).not.toHaveBeenCalled();
		expect(mockGetSignedUrl).not.toHaveBeenCalled();
	});

	it("deletes the uploaded archive when the build fails mid-stream", async () => {
		// The upload is started before the entries are written — archiver
		// stalls on back-pressure otherwise — so a fatal error partway through
		// leaves a truncated object in `downloads/project-contexts/…` that no
		// caller will ever be handed a URL for.
		mockListContextsForDownload.mockResolvedValueOnce([
			makeClassBContext({ id: "b-first", content: "first note" }),
			makeClassBContext({ id: "b-second", content: "second note" }),
		]);
		archiveFailsAfterEntries = 1;

		await expect(
			runHandler({
				input: { projectId: "proj-1", organizationId: null },
			}),
		).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });

		expect(mockDeleteObjects).toHaveBeenCalledTimes(1);
		const [keys, options] = mockDeleteObjects.mock.calls[0];
		// The key the upload was given, in the bucket it went to — read off
		// the upload call rather than reconstructed, since it carries a UUID.
		expect(keys).toEqual([mockPutObjectStream.mock.calls[0][0]]);
		expect(options).toMatchObject({ bucket: "test-bucket" });
		// No URL is signed for an archive that is being deleted.
		expect(mockGetSignedUrl).not.toHaveBeenCalled();
	});

	it("keeps the build's own error when the orphan cleanup itself fails", async () => {
		// The cleanup is best-effort. A storage delete that throws must not
		// replace the reason the export failed with a complaint about the
		// delete — the caller would then be told the wrong thing went wrong.
		mockListContextsForDownload.mockResolvedValueOnce([
			makeClassBContext({ id: "b-first", content: "first note" }),
			makeClassBContext({ id: "b-second", content: "second note" }),
		]);
		archiveFailsAfterEntries = 1;
		mockDeleteObjects.mockRejectedValue(new Error("storage unreachable"));

		await expect(
			runHandler({
				input: { projectId: "proj-1", organizationId: null },
			}),
		).rejects.toMatchObject({
			code: "INTERNAL_SERVER_ERROR",
			message: "Failed to build context archive",
		});
	});

	it("deletes the uploaded archive when finalize rejects", async () => {
		// The archiver's `error` event is not the only way a build dies. A
		// `finalize()` that rejects never reaches the `fatalError` check at all
		// — it walked straight past the cleanup, leaving the parts already
		// uploaded under `downloads/project-contexts/…` with no expiry rule
		// that can be relied on to collect them.
		mockListContextsForDownload.mockResolvedValueOnce([
			makeClassBContext({ id: "b1", content: "a note" }),
		]);
		archiveFinalizeError = new Error("archive flush failed");

		await expect(
			runHandler({
				input: { projectId: "proj-1", organizationId: null },
			}),
		).rejects.toThrow("archive flush failed");

		expect(mockDeleteObjects).toHaveBeenCalledTimes(1);
		const [keys, options] = mockDeleteObjects.mock.calls[0];
		expect(keys).toEqual([mockPutObjectStream.mock.calls[0][0]]);
		expect(options).toMatchObject({ bucket: "test-bucket" });
		// The cleanup never speaks for the failure: the caller still gets the
		// flush error, not an ORPCError about the delete.
		expect(mockGetSignedUrl).not.toHaveBeenCalled();
	});

	it("settles a still-running upload before deleting the archive", async () => {
		// A `finalize()` that fails can leave the sink waiting on a stream that
		// will never end, so the upload is still in flight when the cleanup
		// runs. Deleting underneath a live multipart upload is undone by that
		// upload's own completion, which would put the orphan straight back.
		mockListContextsForDownload.mockResolvedValueOnce([
			makeClassBContext({ id: "b1", content: "a note" }),
		]);
		archiveFinalizeError = new Error("archive flush stalled");
		archiveFinalizeEndsStream = false;

		const order: string[] = [];
		mockPutObjectStream.mockImplementationOnce(
			async (_key: string, body: Readable) => {
				await new Promise<void>((resolve, reject) => {
					body.on("data", () => {});
					body.on("end", () => resolve());
					body.on("error", reject);
				});
				order.push("upload-settled");
			},
		);
		mockDeleteObjects.mockImplementationOnce(async () => {
			order.push("delete");
			return { deleted: 1, errors: [] };
		});

		await expect(
			runHandler({
				input: { projectId: "proj-1", organizationId: null },
			}),
		).rejects.toThrow("archive flush stalled");

		expect(order).toEqual(["upload-settled", "delete"]);
	});

	it("deletes the uploaded archive when the upload itself rejects", async () => {
		// The second exit that walked past the cleanup: lib-storage rejects
		// having already written parts. `fatalError` is null — archiver was
		// fine — so the old shape returned through the `if` and never deleted.
		mockListContextsForDownload.mockResolvedValueOnce([
			makeClassBContext({ id: "b1", content: "a note" }),
		]);

		let sawData = false;
		mockPutObjectStream.mockImplementationOnce(
			async (_key: string, body: Readable) => {
				await new Promise<void>((resolve, reject) => {
					body.on("data", () => {
						sawData = true;
					});
					body.on("end", () => resolve());
					body.on("error", reject);
				});
				throw new Error("multipart upload aborted");
			},
		);

		await expect(
			runHandler({
				input: { projectId: "proj-1", organizationId: null },
			}),
		).rejects.toThrow("multipart upload aborted");

		// Bytes reached the sink, so there is something at `key` to collect.
		expect(sawData).toBe(true);
		expect(mockDeleteObjects).toHaveBeenCalledTimes(1);
		expect(mockDeleteObjects.mock.calls[0][0]).toEqual([
			mockPutObjectStream.mock.calls[0][0],
		]);
		expect(mockGetSignedUrl).not.toHaveBeenCalled();
	});

	it("deletes the uploaded archive when presigning rejects", async () => {
		// The third exit, and the one that leaves the WHOLE archive behind
		// rather than a truncated one: the object uploaded cleanly and only the
		// URL could not be produced, so nobody can ever reach it.
		mockListContextsForDownload.mockResolvedValueOnce([
			makeClassBContext({ id: "b1", content: "a note" }),
		]);
		mockGetSignedUrl.mockRejectedValueOnce(new Error("presign failed"));

		await expect(
			runHandler({
				input: { projectId: "proj-1", organizationId: null },
			}),
		).rejects.toThrow("presign failed");

		expect(mockDeleteObjects).toHaveBeenCalledTimes(1);
		const [keys, options] = mockDeleteObjects.mock.calls[0];
		expect(keys).toEqual([mockPutObjectStream.mock.calls[0][0]]);
		expect(options).toMatchObject({ bucket: "test-bucket" });
	});

	it("does not delete a key nothing was ever streamed to", async () => {
		// The negative the guard exists for. An export with no rows to write
		// fails building its MANIFEST — inside the guarded region, but before a
		// single entry has been handed to the archive — so `key` holds nothing
		// and a delete against it is a round trip spent on an object that does
		// not exist.
		mockListContextsForDownload.mockResolvedValueOnce([]);
		manifestBuildError.current = new Error("manifest build failed");

		await expect(
			runHandler({
				input: { projectId: "proj-1", organizationId: null },
			}),
		).rejects.toThrow("manifest build failed");

		expect(capturedEntries).toHaveLength(0);
		expect(mockDeleteObjects).not.toHaveBeenCalled();
		expect(mockGetSignedUrl).not.toHaveBeenCalled();
	});

	it("never writes the reason U1 made unreachable", async () => {
		mockListContextsForDownload.mockResolvedValueOnce([
			makeClassBContext({
				id: "pending",
				content: "",
				extractionStatus: "PENDING",
			}),
			makeClassBContext({
				id: "extracting",
				content: "",
				extractionStatus: "EXTRACTING",
			}),
		]);

		const result = (await runHandler({
			input: { projectId: "proj-1", organizationId: null },
		})) as { skippedByReason: Record<string, number> };

		expect(result.skippedByReason.NOTHING_STORED).toBe(2);
		expect(manifestText()).not.toContain("Context not ready");
	});
});
