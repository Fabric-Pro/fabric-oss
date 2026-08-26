/**
 * #2139 — a file the OS has no MIME registration for must still upload.
 *
 * The browser reports `File.type` as `""` (or the client substitutes
 * `application/octet-stream`) whenever the OS has no registration for the
 * extension, which on a stock Windows box covers `.md` among others. The
 * procedure resolves the effective MIME from the filename before it validates,
 * so these tests pin the three things that resolution has to drive: the
 * accept/refuse decision, the storage key's extension, and the size limit's
 * category. They also pin the refusal message, which must name the file, say
 * "unknown" instead of trailing off after a colon, *and* keep the
 * supported-formats list this surface has always shipped.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockHasProjectAccess, mockCreateFileContext, mockDocumentFindUnique } =
	vi.hoisted(() => ({
		mockHasProjectAccess: vi.fn(),
		mockCreateFileContext: vi.fn(),
		mockDocumentFindUnique: vi.fn(),
	}));

vi.mock("@repo/database", () => ({
	hasProjectAccess: mockHasProjectAccess,
	createFileContext: mockCreateFileContext,
	db: { projectDocument: { findUnique: mockDocumentFindUnique } },
}));

// Separate specifier — the `@repo/database` mock above does not intercept it.
vi.mock("@repo/database/prisma/zod", () => ({
	ProjectDocumentTypeSchema: { options: ["PRD", "SPEC"] },
}));

vi.mock("@repo/config", () => ({
	config: {
		storage: { bucketNames: { projectContexts: "project-contexts" } },
	},
}));

vi.mock("@repo/storage", () => ({ getStorageProvider: vi.fn() }));

vi.mock("../../../../../orpc/procedures", () => {
	const chain: Record<string, unknown> = {};
	for (const m of ["use", "route", "input", "output"]) {
		chain[m] = () => chain;
	}
	chain.handler = (fn: unknown) => ({ handler: fn });
	return {
		tenantProtectedProcedure: chain,
		requireProjectPermission: () => () => chain,
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
	};
});

import { getStorageProvider } from "@repo/storage";
import { createContextUploadUrlProcedure } from "../create-context-upload-url";

const handler = (
	createContextUploadUrlProcedure as unknown as { handler: Function }
).handler;

const ctx = {
	user: { id: "user-1" },
	session: { activeOrganizationId: "org-1" },
};

const baseInput = {
	projectId: "project-1",
	organizationId: "org-1",
	filename: "design.md",
	mimeType: "",
	size: 1024,
};

let getSignedUploadUrl: ReturnType<typeof vi.fn>;

beforeEach(() => {
	vi.clearAllMocks();
	mockHasProjectAccess.mockResolvedValue(true);
	mockCreateFileContext.mockResolvedValue({ id: "ctx-1" });
	mockDocumentFindUnique.mockResolvedValue({
		projectId: "project-1",
		type: "PRD",
	});
	getSignedUploadUrl = vi
		.fn()
		.mockResolvedValue("https://signed.example/put");
	vi.mocked(getStorageProvider).mockReturnValue({
		type: "s3",
		supportsPresignedUrls: true,
		getSignedUploadUrl,
	} as never);
});

describe("createContextUploadUrl", () => {
	it("accepts a .md whose browser mime is empty and persists text/markdown", async () => {
		const res = await handler({ input: baseInput, context: ctx });

		expect(res.signedUploadUrl).toBe("https://signed.example/put");
		expect(res.contentType).toBe("text/markdown");
		expect(mockCreateFileContext).toHaveBeenCalledWith(
			expect.objectContaining({
				mimeType: "text/markdown",
				type: "FILE",
			}),
		);
		expect(getSignedUploadUrl).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ contentType: "text/markdown" }),
		);
	});

	it("accepts a .md sent as application/octet-stream and persists text/markdown", async () => {
		const res = await handler({
			input: { ...baseInput, mimeType: "application/octet-stream" },
			context: ctx,
		});

		expect(res.contentType).toBe("text/markdown");
		expect(mockCreateFileContext).toHaveBeenCalledWith(
			expect.objectContaining({ mimeType: "text/markdown" }),
		);
	});

	it("refuses an unadvertised extension with the filename, unknown, and the format list", async () => {
		const error = await handler({
			input: { ...baseInput, filename: "archive.rar", mimeType: "" },
			context: ctx,
		}).catch((e: { code: string; message: string }) => e);

		expect(error.code).toBe("BAD_REQUEST");
		expect(error.message).toContain('"archive.rar"');
		expect(error.message).toContain("unknown");
		// The format list is the half the AI-chat/story-attachment message shape
		// does not carry; dropping it would regress this surface.
		expect(error.message).toContain("Supported types:");
		expect(error.message).toContain("PDF");
		expect(error.message).toContain("MD");
		expect(mockCreateFileContext).not.toHaveBeenCalled();
	});

	it("builds the storage key from the resolved extension, not the declared type", async () => {
		const res = await handler({ input: baseInput, context: ctx });

		expect(res.s3Path).toMatch(/^projects\/project-1\/ctx_[0-9a-f-]+\.md$/);
		expect(getSignedUploadUrl).toHaveBeenCalledWith(
			expect.stringMatching(/\.md$/),
			expect.anything(),
		);
	});

	it("applies the resolved category's size limit — an untyped 15MB png hits the 10MB image cap", async () => {
		const error = await handler({
			input: {
				...baseInput,
				filename: "photo.png",
				mimeType: "",
				size: 15 * 1024 * 1024,
			},
			context: ctx,
		}).catch((e: { code: string; message: string }) => e);

		expect(error.code).toBe("BAD_REQUEST");
		// 10MB (IMAGE), not the 20MB FILE fallback an unresolved type would take.
		expect(error.message).toContain("10MB maximum");
		expect(mockCreateFileContext).not.toHaveBeenCalled();
	});

	it("uses a recognised declared mime unchanged", async () => {
		const res = await handler({
			input: {
				...baseInput,
				filename: "spec.pdf",
				mimeType: "application/pdf",
			},
			context: ctx,
		});

		expect(res.contentType).toBe("application/pdf");
		expect(res.s3Path).toMatch(/\.pdf$/);
		expect(mockCreateFileContext).toHaveBeenCalledWith(
			expect.objectContaining({
				mimeType: "application/pdf",
				type: "DOCUMENT",
			}),
		);
	});
});

/**
 * The two fields the Documents-tab create flow adds to this upload.
 *
 * Both describe what the file becomes as a *document*, so the checks here are
 * about refusing combinations that would otherwise write somewhere unintended:
 * a usage with no document to apply it to, a target in another project, or a
 * target whose type disagrees with the tag.
 */
describe("createContextUploadUrl — document usage and target", () => {
	const tagged = {
		...baseInput,
		documentTag: "PRD",
		documentUsage: "AS_IS" as const,
		targetDocumentId: "doc-1",
	};

	/**
	 * An uploaded file is used as it is, and only that.
	 *
	 * Generation from a file would have to start once extraction finishes, by
	 * which point this request — the only place holding the AI signing key — is
	 * gone. Accepting the mode produced a document that stayed on "generating"
	 * forever with nothing to explain it, so it is refused at the door rather
	 * than left to a client to get right.
	 */
	it("refuses a file offered as generation input", async () => {
		await expect(
			handler({
				input: { ...tagged, documentUsage: "CONTEXT" as const },
				context: ctx,
			}),
		).rejects.toThrow(/paste the text instead/i);
	});

	it("carries usage and target into the context metadata", async () => {
		await handler({ input: tagged, context: ctx });

		expect(mockCreateFileContext).toHaveBeenCalledWith(
			expect.objectContaining({
				metadata: expect.objectContaining({
					documentTag: "PRD",
					documentUsage: "AS_IS",
					targetDocumentId: "doc-1",
				}),
			}),
		);
	});

	/**
	 * An ordinary Context-tab upload is neither as-is nor context-for-a-run, so
	 * its metadata must stay clean — a stray usage key would send the extraction
	 * workflow down the document branch for a file that is not one.
	 */
	it("writes neither key for an untagged upload", async () => {
		await handler({ input: baseInput, context: ctx });

		const { metadata } = mockCreateFileContext.mock.calls[0][0];
		expect(metadata).not.toHaveProperty("documentUsage");
		expect(metadata).not.toHaveProperty("targetDocumentId");
	});

	it.each([
		["documentUsage", { documentUsage: "AS_IS" as const }],
		["targetDocumentId", { targetDocumentId: "doc-1" }],
	])("refuses %s without a documentTag", async (_label, extra) => {
		await expect(
			handler({ input: { ...baseInput, ...extra }, context: ctx }),
		).rejects.toThrow(/require documentTag/i);
	});

	it("refuses a target document in another project", async () => {
		mockDocumentFindUnique.mockResolvedValue({
			projectId: "someone-elses-project",
			type: "PRD",
		});

		await expect(handler({ input: tagged, context: ctx })).rejects.toThrow(
			/not found/i,
		);
	});

	it("refuses a target document that does not exist", async () => {
		mockDocumentFindUnique.mockResolvedValue(null);

		await expect(handler({ input: tagged, context: ctx })).rejects.toThrow(
			/not found/i,
		);
	});

	/**
	 * The tag decides how the extracted text is treated; the row decides where
	 * it lands. Disagreement would file one type's contents under another.
	 */
	it("refuses a tag that disagrees with the target document's type", async () => {
		mockDocumentFindUnique.mockResolvedValue({
			projectId: "project-1",
			type: "SPEC",
		});

		await expect(handler({ input: tagged, context: ctx })).rejects.toThrow(
			/must match/i,
		);
	});
});
