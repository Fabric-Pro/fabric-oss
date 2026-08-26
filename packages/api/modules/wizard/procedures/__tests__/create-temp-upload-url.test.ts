/**
 * #2139 — the wizard's temp-upload procedure has to behave identically to the
 * project-context one for a file the OS has no MIME registration for. It is a
 * second copy of the same validate-resolve-presign flow on the pre-project
 * path, and the defect reproduced through both pickers.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockCreateWizardTempContext } = vi.hoisted(() => ({
	mockCreateWizardTempContext: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	createWizardTempContext: mockCreateWizardTempContext,
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

vi.mock("../../../../orpc/procedures", () => {
	const chain: Record<string, unknown> = {};
	for (const m of ["use", "route", "input", "output"]) {
		chain[m] = () => chain;
	}
	chain.handler = (fn: unknown) => ({ handler: fn });
	return {
		tenantProtectedProcedure: chain,
		// The wizard gates on requirePermission, not requireProjectPermission —
		// there is no project yet.
		requirePermission: () => () => chain,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
	};
});

import { getStorageProvider } from "@repo/storage";
import { createTempUploadUrlProcedure } from "../create-temp-upload-url";

const handler = (
	createTempUploadUrlProcedure as unknown as { handler: Function }
).handler;

const ctx = {
	user: { id: "user-1" },
	session: { activeOrganizationId: "org-1" },
};

const baseInput = {
	sessionId: "session-1",
	organizationId: "org-1",
	filename: "design.md",
	// The client sends this placeholder because the input schema requires a
	// non-empty string; the server still has to resolve past it.
	mimeType: "application/octet-stream",
	size: 1024,
};

let getSignedUploadUrl: ReturnType<typeof vi.fn>;

beforeEach(() => {
	vi.clearAllMocks();
	mockCreateWizardTempContext.mockResolvedValue({ id: "temp-1" });
	getSignedUploadUrl = vi
		.fn()
		.mockResolvedValue("https://signed.example/put");
	vi.mocked(getStorageProvider).mockReturnValue({
		type: "s3",
		supportsPresignedUrls: true,
		getSignedUploadUrl,
	} as never);
});

describe("createTempUploadUrl", () => {
	it("accepts an untyped .md and persists text/markdown, like the context procedure", async () => {
		const res = await handler({ input: baseInput, context: ctx });

		expect(res.signedUploadUrl).toBe("https://signed.example/put");
		expect(res.contentType).toBe("text/markdown");
		expect(res.s3Path).toMatch(
			/^wizard-temp\/user-1\/session-1\/temp_.+\.md$/,
		);
		expect(mockCreateWizardTempContext).toHaveBeenCalledWith(
			expect.objectContaining({
				mimeType: "text/markdown",
				type: "FILE",
			}),
		);
		expect(getSignedUploadUrl).toHaveBeenCalledWith(
			expect.stringMatching(/\.md$/),
			expect.objectContaining({ contentType: "text/markdown" }),
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
		expect(error.message).toContain("Supported types:");
		expect(error.message).toContain("MD");
		expect(mockCreateWizardTempContext).not.toHaveBeenCalled();
	});

	it("applies the resolved category's size limit — an untyped 15MB png hits the 10MB image cap", async () => {
		const error = await handler({
			input: {
				...baseInput,
				filename: "photo.png",
				mimeType: "application/octet-stream",
				size: 15 * 1024 * 1024,
			},
			context: ctx,
		}).catch((e: { code: string; message: string }) => e);

		expect(error.code).toBe("BAD_REQUEST");
		expect(error.message).toContain("10MB maximum");
		expect(mockCreateWizardTempContext).not.toHaveBeenCalled();
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
		expect(mockCreateWizardTempContext).toHaveBeenCalledWith(
			expect.objectContaining({
				mimeType: "application/pdf",
				type: "DOCUMENT",
			}),
		);
	});
});
