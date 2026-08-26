/**
 * Integration tests for `projects.stories.createBatchDownloadUrl`.
 *
 * The tests follow the same "mock the procedure base + call handler
 * directly" pattern used by `create-contexts-batch-download-url.test.ts`.
 * All external dependencies (database, storage, archiver, logger, membership
 * verifier, oRPC procedure builder) are mocked at the module boundary so
 * each test is a pure function of its inputs.
 */

import { PassThrough, type Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — set up BEFORE the procedure is imported.
// ---------------------------------------------------------------------------

const {
	mockGetProjectForDownload,
	mockListStoriesForDownload,
	mockPutObjectStream,
	mockGetSignedUrl,
	mockVerifyOrganizationMembership,
} = vi.hoisted(() => ({
	mockGetProjectForDownload: vi.fn(),
	mockListStoriesForDownload: vi.fn(),
	mockPutObjectStream: vi.fn(),
	mockGetSignedUrl: vi.fn(),
	mockVerifyOrganizationMembership: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getProjectForDownload: mockGetProjectForDownload,
	listStoriesForDownload: mockListStoriesForDownload,
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

// Capture archive entries so we can assert on the rendered ZIP contents
// without spinning up a real `archiver`.
interface CapturedEntry {
	name: string;
	content: string;
}
let capturedEntries: CapturedEntry[] = [];

vi.mock("archiver", () => {
	return {
		default: (_format: string, _opts?: unknown) => {
			const passthrough = new PassThrough();
			const archive = {
				on(_event: string, _fn: (...a: unknown[]) => void) {
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
							content: body,
						});
					} else if (Buffer.isBuffer(body)) {
						capturedEntries.push({
							name: options.name,
							content: body.toString("utf8"),
						});
					} else {
						capturedEntries.push({
							name: options.name,
							content: "",
						});
						body.on("error", () => {});
						body.resume();
					}
				},
				async finalize() {
					passthrough.end("ZIP");
				},
			};
			return archive;
		},
	};
});

// Mock the oRPC procedure base so we can invoke the handler directly.
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
// Test fixtures
// ---------------------------------------------------------------------------

interface TestStory {
	id: string;
	identifier: string;
	title: string;
	description: string | null;
	acceptanceCriteria: string | null;
	priority: string | null;
	size: string | null;
	draftingStage: string;
	tasks: Array<{
		id: string;
		identifier: string | null;
		title: string;
		isCompleted: boolean;
		order: number;
	}>;
}

function makeStory(partial: Partial<TestStory> & { id: string }): TestStory {
	// Use `in` checks so callers can pass an explicit `null` to override the
	// default content (otherwise `??` would coerce null back to the default
	// and a "stub" fixture would silently render as a non-stub).
	return {
		id: partial.id,
		identifier: partial.identifier ?? `F-${partial.id}`,
		title: partial.title ?? "Test feature",
		description:
			"description" in partial
				? (partial.description ?? null)
				: "Some description.",
		acceptanceCriteria:
			"acceptanceCriteria" in partial
				? (partial.acceptanceCriteria ?? null)
				: "Some criteria.",
		priority: partial.priority ?? "P1_HIGH",
		size: partial.size ?? "M",
		draftingStage: partial.draftingStage ?? "DRAFT",
		tasks: partial.tasks ?? [],
	};
}

const baseContext = {
	user: { id: "user-1", email: "owner@example.com" },
	session: { id: "session-1", activeOrganizationId: null },
};

async function runHandler(args: {
	input: {
		projectId: string;
		storyIds: string[];
		organizationId?: string | null;
	};
	context?: typeof baseContext;
}) {
	const { createStoriesBatchDownloadUrlProcedure } = await import(
		"../create-stories-batch-download-url"
	);
	const handler = (
		createStoriesBatchDownloadUrlProcedure as unknown as {
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

describe("createStoriesBatchDownloadUrl", () => {
	beforeEach(() => {
		mockGetProjectForDownload.mockReset();
		mockListStoriesForDownload.mockReset();
		mockPutObjectStream.mockReset();
		mockGetSignedUrl.mockReset();
		mockVerifyOrganizationMembership.mockReset();
		capturedEntries = [];

		mockGetProjectForDownload.mockResolvedValue({
			id: "proj-1",
			name: "Acme Web",
		});
		mockListStoriesForDownload.mockResolvedValue([]);
		mockGetSignedUrl.mockResolvedValue("https://signed.example/zip");
		mockPutObjectStream.mockImplementation(
			async (_key: string, body: Readable) => {
				await new Promise<void>((resolve, reject) => {
					body.on("data", () => {});
					body.on("end", () => resolve());
					body.on("error", reject);
				});
			},
		);
		mockVerifyOrganizationMembership.mockResolvedValue({
			organization: { id: "org-1" },
			role: "admin",
		});
	});

	it("happy path: 3 readable non-stub stories produce a presigned URL with 3 included files", async () => {
		const stories = [
			makeStory({ id: "s1", identifier: "F-001", title: "First" }),
			makeStory({ id: "s2", identifier: "F-002", title: "Second" }),
			makeStory({ id: "s3", identifier: "F-003", title: "Third" }),
		];
		mockListStoriesForDownload.mockResolvedValueOnce(stories);

		const result = (await runHandler({
			input: {
				projectId: "proj-1",
				storyIds: ["s1", "s2", "s3"],
				organizationId: null,
			},
		})) as {
			url: string;
			expiresAt: string;
			manifest: {
				included: Array<{ storyId: string; filename: string }>;
				skipped: unknown[];
			};
		};

		expect(result.url).toBe("https://signed.example/zip");
		expect(result.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(result.manifest.included).toHaveLength(3);
		expect(result.manifest.skipped).toHaveLength(0);
		// Last entry is always the manifest.
		expect(capturedEntries.at(-1)?.name).toBe("MANIFEST.txt");
		// Three .md entries, one MANIFEST.
		const mdEntries = capturedEntries.filter((e) => e.name.endsWith(".md"));
		expect(mdEntries).toHaveLength(3);
		// Each rendered Markdown must contain the title and footer.
		expect(mdEntries[0].content).toContain("# F-001 — First");
		expect(mdEntries[0].content).toContain("Acme Web");
		// Outer ZIP filename is forced via Content-Disposition.
		expect(mockGetSignedUrl).toHaveBeenCalledWith(
			expect.stringMatching(
				/^batch-downloads\/stories\/proj-1\/[0-9a-f-]+\.zip$/,
			),
			expect.objectContaining({
				bucket: "test-bucket",
				responseContentDisposition: expect.stringMatching(
					/^attachment; filename="features-[0-9a-f-]+\.zip"$/,
				),
			}),
		);
	});

	it("mixed valid + stub stories: stubs are skipped with INSUFFICIENT_CONTENT", async () => {
		const stories = [
			makeStory({ id: "s1", identifier: "F-001", title: "Has content" }),
			makeStory({
				id: "s2",
				identifier: "F-002",
				title: "Empty stub",
				description: null,
				acceptanceCriteria: null,
				tasks: [],
			}),
			makeStory({
				id: "s3",
				identifier: "F-003",
				title: "Placeholder stage",
				draftingStage: "PLACEHOLDER",
			}),
		];
		mockListStoriesForDownload.mockResolvedValueOnce(stories);

		const result = (await runHandler({
			input: {
				projectId: "proj-1",
				storyIds: ["s1", "s2", "s3"],
				organizationId: null,
			},
		})) as {
			manifest: {
				included: Array<{ storyId: string }>;
				skipped: Array<{ storyId: string; reason: string }>;
			};
		};

		expect(result.manifest.included.map((r) => r.storyId)).toEqual(["s1"]);
		expect(result.manifest.skipped).toHaveLength(2);
		expect(result.manifest.skipped.map((r) => r.reason)).toEqual([
			"INSUFFICIENT_CONTENT",
			"INSUFFICIENT_CONTENT",
		]);
	});

	it("cross-tenant attack id: missing rows are recorded as NOT_FOUND_OR_NO_PERMISSION", async () => {
		// Caller passes 3 ids but the tenant-scoped query only returns 2.
		mockListStoriesForDownload.mockResolvedValueOnce([
			makeStory({ id: "s1", identifier: "F-001", title: "Mine" }),
			makeStory({ id: "s2", identifier: "F-002", title: "Also mine" }),
		]);

		const result = (await runHandler({
			input: {
				projectId: "proj-1",
				storyIds: ["s1", "evil-cross-tenant", "s2"],
				organizationId: null,
			},
		})) as {
			manifest: {
				included: Array<{ storyId: string }>;
				skipped: Array<{
					storyId: string;
					identifier: string | null;
					reason: string;
				}>;
			};
		};

		expect(result.manifest.included).toHaveLength(2);
		expect(result.manifest.skipped).toHaveLength(1);
		expect(result.manifest.skipped[0]).toEqual({
			storyId: "evil-cross-tenant",
			identifier: null,
			reason: "NOT_FOUND_OR_NO_PERMISSION",
		});
	});

	it("all-stub input throws BAD_REQUEST with projects.stories.download.empty", async () => {
		mockListStoriesForDownload.mockResolvedValueOnce([
			makeStory({
				id: "s1",
				draftingStage: "PLACEHOLDER",
			}),
			makeStory({
				id: "s2",
				description: null,
				acceptanceCriteria: null,
				tasks: [],
			}),
		]);

		await expect(
			runHandler({
				input: {
					projectId: "proj-1",
					storyIds: ["s1", "s2"],
					organizationId: null,
				},
			}),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: "projects.stories.download.empty",
		});
	});

	it("Zod input rejects more than MAX_BATCH_DOWNLOAD_STORIES (51) ids", async () => {
		const { createStoriesBatchDownloadUrlInput } = await import(
			"../create-stories-batch-download-url"
		);
		const ids = Array.from({ length: 51 }, (_, i) => `s${i}`);
		const result = createStoriesBatchDownloadUrlInput.safeParse({
			projectId: "proj-1",
			storyIds: ids,
		});
		expect(result.success).toBe(false);
	});

	it("Zod input rejects duplicate ids", async () => {
		const { createStoriesBatchDownloadUrlInput } = await import(
			"../create-stories-batch-download-url"
		);
		const result = createStoriesBatchDownloadUrlInput.safeParse({
			projectId: "proj-1",
			storyIds: ["s1", "s2", "s1"],
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues[0].message).toBe(
				"storyIds must be unique",
			);
		}
	});

	it("rejects with NOT_FOUND when the project is not visible to the caller", async () => {
		mockGetProjectForDownload.mockResolvedValueOnce(null);

		await expect(
			runHandler({
				input: {
					projectId: "ghost",
					storyIds: ["s1"],
					organizationId: null,
				},
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("rejects with FORBIDDEN when an org caller is not an active member", async () => {
		mockVerifyOrganizationMembership.mockResolvedValueOnce(null);

		await expect(
			runHandler({
				input: {
					projectId: "proj-1",
					storyIds: ["s1"],
					organizationId: "org-9",
				},
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("S3 upload failure throws INTERNAL_SERVER_ERROR (no partial leak)", async () => {
		mockListStoriesForDownload.mockResolvedValueOnce([
			makeStory({ id: "s1", identifier: "F-001", title: "Good" }),
		]);
		mockPutObjectStream.mockImplementationOnce(async () => {
			throw new Error("S3 timeout");
		});

		await expect(
			runHandler({
				input: {
					projectId: "proj-1",
					storyIds: ["s1"],
					organizationId: null,
				},
			}),
		).rejects.toMatchObject({
			code: "INTERNAL_SERVER_ERROR",
		});

		// No presigned URL should leak when the upload failed.
		expect(mockGetSignedUrl).not.toHaveBeenCalled();
	});

	it("manifest body contains both INCLUDED and SKIPPED blocks when mixed", async () => {
		mockListStoriesForDownload.mockResolvedValueOnce([
			makeStory({ id: "s1", identifier: "F-001", title: "Real" }),
			makeStory({
				id: "s2",
				identifier: "F-002",
				draftingStage: "PLACEHOLDER",
			}),
		]);

		await runHandler({
			input: {
				projectId: "proj-1",
				storyIds: ["s1", "s2"],
				organizationId: null,
			},
		});

		const manifest = capturedEntries.find((e) => e.name === "MANIFEST.txt");
		expect(manifest?.content).toBeDefined();
		expect(manifest?.content).toContain("--- INCLUDED (1) ---");
		expect(manifest?.content).toContain("--- SKIPPED (1) ---");
		expect(manifest?.content).toContain("F-001");
		expect(manifest?.content).toContain("F-002");
		expect(manifest?.content).toContain("SKIPPED — insufficient content");
	});
});
