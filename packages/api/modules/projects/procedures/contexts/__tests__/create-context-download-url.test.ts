/**
 * Integration tests for `createContextDownloadUrlProcedure`.
 *
 * Covers the scenarios enumerated in spec §13.2 for
 * `projects.contexts.createDownloadUrl`:
 *   - Class A happy path (presigned URL for original object).
 *   - Class B happy path (synthesized `.md`, shared header, upload+presign).
 *   - Class C happy path (synthesized `.txt`, integration suffix).
 *   - Missing `s3Path` on Class A → BAD_REQUEST / CONTENT_UNAVAILABLE.
 *   - Empty `content` on Class B/C → BAD_REQUEST / CONTENT_UNAVAILABLE.
 *   - Cross-tenant `contextId` → NOT_FOUND.
 *   - Wrong `projectId` for valid `contextId` → NOT_FOUND (IDOR).
 *   - Org context, non-member → FORBIDDEN, membership check invoked.
 *
 * Mocks the Prisma query surface (`@repo/database`), `@repo/storage`,
 * `@repo/config`, the org membership helper, and the procedure base so
 * the handler can be invoked directly without a full oRPC runtime.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockUrlPagesFindMany = vi.fn();
vi.mock("@repo/database", () => ({
	getContextById: vi.fn(),
	db: {
		projectContextUrlPage: {
			findMany: (...args: unknown[]) => mockUrlPagesFindMany(...args),
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

const mockGetSignedUrl = vi.fn();
const mockUploadFile = vi.fn();
vi.mock("@repo/storage", () => ({
	getSignedUrl: (...args: unknown[]) => mockGetSignedUrl(...args),
	uploadFile: (...args: unknown[]) => mockUploadFile(...args),
}));

vi.mock("../../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: vi.fn(),
}));

// Stub the procedure base so we can call `.handler` directly.
vi.mock("../../../../../orpc/procedures", () => {
	const builder: Record<string, unknown> = {};
	builder.use = () => builder;
	builder.route = () => builder;
	builder.input = () => builder;
	builder.handler = (fn: unknown) => ({ handler: fn });
	return {
		tenantProtectedProcedure: builder,
		resolveOrganizationId: (orgId: string | null | undefined) =>
			orgId ?? null,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
		requireProjectPermission: () => (c: unknown) => c,
	};
});

import { getContextById } from "@repo/database";
import { verifyOrganizationMembership } from "../../../../organizations/lib/membership";

type Handler = (args: {
	input: {
		contextId: string;
		projectId: string;
		organizationId?: string | null;
	};
	context: { user: { id: string }; session: { id: string } };
}) => Promise<unknown>;

async function loadHandler(): Promise<Handler> {
	const mod = await import("../create-context-download-url");
	return (mod.createContextDownloadUrlProcedure as any).handler as Handler;
}

const personalContext = {
	user: { id: "user-1" },
	session: { id: "session-1" },
};

const orgCallerContext = {
	user: { id: "user-1" },
	session: { id: "session-1" },
};

beforeEach(() => {
	vi.clearAllMocks();
	mockGetSignedUrl.mockReset();
	mockUploadFile.mockReset();
	mockUrlPagesFindMany.mockReset();
});

describe("createContextDownloadUrl — Class A (binary)", () => {
	it("returns a presigned URL for the original object", async () => {
		vi.mocked(getContextById).mockResolvedValueOnce({
			id: "ctx-1",
			projectId: "proj-1",
			type: "FILE",
			s3Path: "projects/proj-1/ctx-1.pdf",
			s3Bucket: "test-bucket",
			originalFilename: "report.pdf",
			mimeType: "application/pdf",
			fileSize: 1024,
			content: null,
			sourceTitle: "Report",
			metadata: {},
			createdAt: new Date("2026-04-15T00:00:00Z"),
		} as any);
		mockGetSignedUrl.mockResolvedValueOnce("https://s3.test/signed-a");

		const handler = await loadHandler();
		const before = Date.now();
		const result = (await handler({
			input: { contextId: "ctx-1", projectId: "proj-1" },
			context: personalContext,
		})) as {
			url: string;
			filename: string;
			expiresAt: string;
			contextClass: "A" | "B" | "C";
		};

		expect(result.url).toBe("https://s3.test/signed-a");
		expect(result.contextClass).toBe("A");
		expect(result.filename).toBe("report.pdf");
		expect(mockGetSignedUrl).toHaveBeenCalledTimes(1);
		expect(mockGetSignedUrl).toHaveBeenCalledWith(
			"projects/proj-1/ctx-1.pdf",
			expect.objectContaining({
				bucket: "test-bucket",
				expiresIn: 300,
			}),
		);
		expect(mockUploadFile).not.toHaveBeenCalled();

		// expiresAt ≈ now + 300s (allow generous drift for CI latency).
		const expiresMs = new Date(result.expiresAt).getTime();
		expect(expiresMs).toBeGreaterThanOrEqual(before + 290_000);
		expect(expiresMs).toBeLessThanOrEqual(Date.now() + 310_000);
	});

	it("throws BAD_REQUEST/CONTENT_UNAVAILABLE when s3Path is missing", async () => {
		vi.mocked(getContextById).mockResolvedValueOnce({
			id: "ctx-2",
			projectId: "proj-1",
			type: "FILE",
			s3Path: null,
			originalFilename: "lost.pdf",
			mimeType: "application/pdf",
			content: null,
			createdAt: new Date(),
			metadata: {},
		} as any);

		const handler = await loadHandler();
		await expect(
			handler({
				input: { contextId: "ctx-2", projectId: "proj-1" },
				context: personalContext,
			}),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			data: expect.objectContaining({ code: "CONTENT_UNAVAILABLE" }),
		});
		expect(mockGetSignedUrl).not.toHaveBeenCalled();
	});
});

describe("createContextDownloadUrl — Class B (synthesized Markdown)", () => {
	it("uploads a `.md` payload and returns a presigned URL", async () => {
		vi.mocked(getContextById).mockResolvedValueOnce({
			id: "ctx-b",
			projectId: "proj-1",
			type: "TEXT",
			s3Path: null,
			content: "# Project notes\nHello world",
			sourceTitle: "Project notes",
			metadata: { title: "Project notes" },
			createdAt: new Date("2026-04-15T00:00:00Z"),
		} as any);
		mockUploadFile.mockResolvedValueOnce(undefined);
		mockGetSignedUrl.mockResolvedValueOnce("https://s3.test/signed-b");

		const handler = await loadHandler();
		const result = (await handler({
			input: { contextId: "ctx-b", projectId: "proj-1" },
			context: personalContext,
		})) as {
			url: string;
			filename: string;
			contextClass: "A" | "B" | "C";
		};

		expect(result.contextClass).toBe("B");
		expect(result.filename).toMatch(/\.md$/);
		expect(result.url).toBe("https://s3.test/signed-b");

		expect(mockUploadFile).toHaveBeenCalledTimes(1);
		const [uploadPath, body, uploadOpts] = mockUploadFile.mock.calls[0] as [
			string,
			Buffer,
			{ bucket: string; contentType: string },
		];
		expect(uploadPath).toMatch(
			/^downloads\/project-contexts\/proj-1\/single\/[^/]+\.md$/,
		);
		expect(uploadOpts.bucket).toBe("test-bucket");
		expect(uploadOpts.contentType).toMatch(/markdown|text/);
		// Shared header per spec §8.2.
		const bodyStr =
			body instanceof Buffer ? body.toString("utf8") : String(body);
		expect(bodyStr.startsWith("Fabric Context Export\n")).toBe(true);
		expect(bodyStr).toContain("# Project notes");

		expect(mockGetSignedUrl).toHaveBeenCalledWith(
			uploadPath,
			expect.objectContaining({ bucket: "test-bucket", expiresIn: 300 }),
		);
	});

	it("throws CONTENT_UNAVAILABLE when Class B content is empty", async () => {
		vi.mocked(getContextById).mockResolvedValueOnce({
			id: "ctx-b-empty",
			projectId: "proj-1",
			type: "TEXT",
			s3Path: null,
			content: "",
			metadata: {},
			createdAt: new Date(),
		} as any);

		const handler = await loadHandler();
		await expect(
			handler({
				input: { contextId: "ctx-b-empty", projectId: "proj-1" },
				context: personalContext,
			}),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			data: expect.objectContaining({ code: "CONTENT_UNAVAILABLE" }),
		});
		expect(mockUploadFile).not.toHaveBeenCalled();
	});
});

describe("createContextDownloadUrl — Class C (synthesized .txt)", () => {
	it("uses `.txt` for CODE_FILE contexts", async () => {
		vi.mocked(getContextById).mockResolvedValueOnce({
			id: "ctx-c",
			projectId: "proj-1",
			type: "CODE_FILE",
			s3Path: null,
			content: "function hello() { return 'world'; }",
			sourceTitle: "src/hello.ts",
			metadata: { path: "src/hello.ts" },
			createdAt: new Date("2026-04-15T00:00:00Z"),
		} as any);
		mockUploadFile.mockResolvedValueOnce(undefined);
		mockGetSignedUrl.mockResolvedValueOnce("https://s3.test/signed-c");

		const handler = await loadHandler();
		const before = Date.now();
		const result = (await handler({
			input: { contextId: "ctx-c", projectId: "proj-1" },
			context: personalContext,
		})) as {
			url: string;
			filename: string;
			expiresAt: string;
			contextClass: "A" | "B" | "C";
		};

		expect(result.contextClass).toBe("C");
		expect(result.filename).toMatch(/\.txt$/);
		const [uploadPath] = mockUploadFile.mock.calls[0] as [string];
		expect(uploadPath).toMatch(
			/^downloads\/project-contexts\/proj-1\/single\/[^/]+\.txt$/,
		);
		const expiresMs = new Date(result.expiresAt).getTime();
		expect(expiresMs).toBeGreaterThanOrEqual(before + 290_000);
		expect(expiresMs).toBeLessThanOrEqual(Date.now() + 310_000);
	});

	it("throws CONTENT_UNAVAILABLE when Class C content is null", async () => {
		vi.mocked(getContextById).mockResolvedValueOnce({
			id: "ctx-c-null",
			projectId: "proj-1",
			type: "LINK",
			s3Path: null,
			content: null,
			metadata: {},
			createdAt: new Date(),
		} as any);

		const handler = await loadHandler();
		await expect(
			handler({
				input: { contextId: "ctx-c-null", projectId: "proj-1" },
				context: personalContext,
			}),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			data: expect.objectContaining({ code: "CONTENT_UNAVAILABLE" }),
		});
	});
});

describe("createContextDownloadUrl — Class B URL Source (LINK)", () => {
	it("SINGLE_PAGE LINK uses parent.content and does NOT query child pages", async () => {
		vi.mocked(getContextById).mockResolvedValueOnce({
			id: "ctx-link-single",
			projectId: "proj-1",
			type: "LINK",
			urlScope: "SINGLE_PAGE",
			s3Path: null,
			content: "# Single page\n\nbody",
			sourceTitle: "Example Single",
			metadata: { sourceTitle: "Example Single" },
			createdAt: new Date("2026-04-15T00:00:00Z"),
		} as any);
		mockUploadFile.mockResolvedValueOnce(undefined);
		mockGetSignedUrl.mockResolvedValueOnce(
			"https://s3.test/signed-link-single",
		);

		const handler = await loadHandler();
		const result = (await handler({
			input: { contextId: "ctx-link-single", projectId: "proj-1" },
			context: personalContext,
		})) as {
			url: string;
			filename: string;
			contextClass: "A" | "B" | "C";
		};

		expect(result.contextClass).toBe("B");
		expect(result.filename).toMatch(/\.md$/);

		// SINGLE_PAGE must NOT trigger the child-page concatenation query.
		expect(mockUrlPagesFindMany).not.toHaveBeenCalled();

		// Body contains the parent.content verbatim under the shared header.
		const [, body] = mockUploadFile.mock.calls[0] as [
			string,
			Buffer,
			Record<string, unknown>,
		];
		const bodyStr =
			body instanceof Buffer ? body.toString("utf8") : String(body);
		expect(bodyStr).toContain("# Single page");
	});

	it("PATH_PREFIX LINK concatenates child pages ordered by pageUrl ASC", async () => {
		vi.mocked(getContextById).mockResolvedValueOnce({
			id: "ctx-link-prefix",
			projectId: "proj-1",
			type: "LINK",
			urlScope: "PATH_PREFIX",
			s3Path: null,
			content: "", // parent.content is empty for path-prefix crawls
			sourceTitle: "Example Docs",
			metadata: { sourceTitle: "Example Docs" },
			createdAt: new Date("2026-04-15T00:00:00Z"),
		} as any);
		// Children pre-sorted by pageUrl ASC — that's the contract from the
		// query side. Test asserts the procedure preserves that order.
		mockUrlPagesFindMany.mockResolvedValueOnce([
			{
				pageUrl: "https://example.com/docs/a",
				pageTitle: "Alpha",
				content: "Alpha body",
			},
			{
				pageUrl: "https://example.com/docs/b",
				pageTitle: null,
				content: "Bravo body",
			},
		]);
		mockUploadFile.mockResolvedValueOnce(undefined);
		mockGetSignedUrl.mockResolvedValueOnce(
			"https://s3.test/signed-link-prefix",
		);

		const handler = await loadHandler();
		const result = (await handler({
			input: { contextId: "ctx-link-prefix", projectId: "proj-1" },
			context: personalContext,
		})) as { contextClass: "A" | "B" | "C"; filename: string };

		expect(result.contextClass).toBe("B");
		expect(result.filename).toMatch(/\.md$/);

		// Concatenation query was scoped to the parent + caller's tenant.
		expect(mockUrlPagesFindMany).toHaveBeenCalledTimes(1);
		const findManyArgs = mockUrlPagesFindMany.mock.calls[0]?.[0] as {
			where: Record<string, unknown>;
			orderBy: { pageUrl: "asc" | "desc" };
		};
		expect(findManyArgs.where).toMatchObject({
			parentContextId: "ctx-link-prefix",
			organizationId: null,
			userId: "user-1",
		});
		expect(findManyArgs.orderBy).toEqual({ pageUrl: "asc" });

		const [, body] = mockUploadFile.mock.calls[0] as [
			string,
			Buffer,
			Record<string, unknown>,
		];
		const bodyStr =
			body instanceof Buffer ? body.toString("utf8") : String(body);
		// Alpha then Bravo, each with a `## heading` block + URL line and the
		// horizontal-rule separator between sections.
		const alphaIdx = bodyStr.indexOf("## Alpha");
		const bravoIdx = bodyStr.indexOf("## https://example.com/docs/b");
		expect(alphaIdx).toBeGreaterThanOrEqual(0);
		expect(bravoIdx).toBeGreaterThan(alphaIdx);
		expect(bodyStr).toMatch(/Alpha body/);
		expect(bodyStr).toMatch(/Bravo body/);
		expect(bodyStr).toMatch(/\n---\n/);
	});

	it("PATH_PREFIX LINK with zero indexed pages → CONTENT_UNAVAILABLE", async () => {
		vi.mocked(getContextById).mockResolvedValueOnce({
			id: "ctx-link-empty",
			projectId: "proj-1",
			type: "LINK",
			urlScope: "PATH_PREFIX",
			s3Path: null,
			content: "",
			sourceTitle: "Pending crawl",
			metadata: {},
			createdAt: new Date(),
		} as any);
		mockUrlPagesFindMany.mockResolvedValueOnce([]);

		const handler = await loadHandler();
		await expect(
			handler({
				input: { contextId: "ctx-link-empty", projectId: "proj-1" },
				context: personalContext,
			}),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			data: expect.objectContaining({ code: "CONTENT_UNAVAILABLE" }),
		});
		expect(mockUploadFile).not.toHaveBeenCalled();
	});
});

describe("createContextDownloadUrl — tenant isolation", () => {
	it("returns NOT_FOUND when context belongs to a different tenant", async () => {
		// Query helper already applied XOR filter → null means cross-tenant.
		vi.mocked(getContextById).mockResolvedValueOnce(null);

		const handler = await loadHandler();
		await expect(
			handler({
				input: { contextId: "ctx-other", projectId: "proj-1" },
				context: personalContext,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		expect(getContextById).toHaveBeenCalledWith(
			"ctx-other",
			"proj-1",
			expect.objectContaining({ userId: "user-1", organizationId: null }),
		);
	});

	it("returns NOT_FOUND on projectId mismatch (IDOR defense-in-depth)", async () => {
		// The scoped query form filters on projectId, so a mismatch also yields null.
		vi.mocked(getContextById).mockResolvedValueOnce(null);

		const handler = await loadHandler();
		await expect(
			handler({
				input: { contextId: "ctx-real", projectId: "proj-wrong" },
				context: personalContext,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		expect(getContextById).toHaveBeenCalledWith(
			"ctx-real",
			"proj-wrong",
			expect.any(Object),
		);
	});
});

describe("createContextDownloadUrl — org membership", () => {
	it("throws FORBIDDEN when caller is not an active member", async () => {
		vi.mocked(verifyOrganizationMembership).mockResolvedValueOnce(null);

		const handler = await loadHandler();
		await expect(
			handler({
				input: {
					contextId: "ctx-b",
					projectId: "proj-1",
					organizationId: "org-1",
				},
				context: orgCallerContext,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		expect(verifyOrganizationMembership).toHaveBeenCalledTimes(1);
		expect(verifyOrganizationMembership).toHaveBeenCalledWith(
			"org-1",
			"user-1",
		);
		// Should not reach the query layer.
		expect(getContextById).not.toHaveBeenCalled();
	});

	it("calls query with organizationId when caller is a member (personal XOR disabled)", async () => {
		vi.mocked(verifyOrganizationMembership).mockResolvedValueOnce({
			organization: { id: "org-1" } as any,
			role: "member",
		});
		vi.mocked(getContextById).mockResolvedValueOnce({
			id: "ctx-a-org",
			projectId: "proj-1",
			type: "FILE",
			s3Path: "projects/proj-1/ctx-a-org.pdf",
			originalFilename: "org-report.pdf",
			mimeType: "application/pdf",
			fileSize: 10,
			content: null,
			metadata: {},
			createdAt: new Date(),
		} as any);
		mockGetSignedUrl.mockResolvedValueOnce("https://s3.test/signed-org");

		const handler = await loadHandler();
		const result = (await handler({
			input: {
				contextId: "ctx-a-org",
				projectId: "proj-1",
				organizationId: "org-1",
			},
			context: orgCallerContext,
		})) as { url: string; contextClass: string };

		expect(result.url).toBe("https://s3.test/signed-org");
		expect(result.contextClass).toBe("A");
		expect(getContextById).toHaveBeenCalledWith(
			"ctx-a-org",
			"proj-1",
			expect.objectContaining({
				userId: "user-1",
				organizationId: "org-1",
			}),
		);
	});
});
