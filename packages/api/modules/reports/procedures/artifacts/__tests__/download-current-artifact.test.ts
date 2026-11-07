import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ artifact: vi.fn(), sign: vi.fn() }));
vi.mock("@repo/database", () => ({ getTemplateInstanceArtifact: m.artifact }));
vi.mock("@repo/database/prisma/queries/report-distribution", () => ({
	reportArtifactHash: () => "a".repeat(64),
}));
vi.mock("@repo/storage", () => ({ getSignedUrl: m.sign }));
vi.mock("../../../../../orpc/procedures", () => {
	const chain = {
		use: () => chain,
		input: () => chain,
		handler: (handler: unknown) => handler,
	};
	return {
		tenantProtectedProcedure: chain,
		requireInputOrgPermission: () => () => {},
		Permissions: { REPORT_READ: "report.read" },
		resolveOrganizationId: () => "example-org",
	};
});

import { handleDownloadReportArtifact } from "../download";

const input = {
	id: "example-artifact",
	organizationId: "example-org",
	expiresIn: 300,
};
const context = {
	user: { id: "example-reader" },
	session: { activeOrganizationId: "example-org" },
};
beforeEach(() => {
	vi.clearAllMocks();
	m.artifact.mockResolvedValue({
		id: input.id,
		userId: "example-author",
		organizationId: "example-org",
		name: "Reviewed.pdf",
		content: null,
		s3Path: "example/private.pdf",
		s3Bucket: "example-private",
		mimeType: "application/pdf",
		execution: { status: "COMPLETED" },
	});
	m.sign.mockResolvedValue("https://example.com/private-signed-download");
});
describe("current report artifact download", () => {
	it("loads the TemplateInstanceArtifact using current reader/audience, then signs only its stored PDF", async () => {
		expect(
			await handleDownloadReportArtifact({ input, context }),
		).toMatchObject({
			type: "url",
			filename: "Reviewed.pdf",
			artifactHash: "a".repeat(64),
		});
		expect(m.artifact).toHaveBeenCalledWith(input.id, {
			userId: "example-reader",
			organizationId: "example-org",
		});
		expect(m.sign).toHaveBeenCalledWith(
			"example/private.pdf",
			expect.objectContaining({
				bucket: "example-private",
				expiresIn: 300,
				responseContentType: "application/pdf",
			}),
		);
	});
	it("refuses revoked or cancelled output without minting a file capability", async () => {
		m.artifact.mockResolvedValue(null);
		await expect(
			handleDownloadReportArtifact({ input, context }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		m.artifact.mockResolvedValue({ execution: { status: "CANCELLED" } });
		await expect(
			handleDownloadReportArtifact({ input, context }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.sign).not.toHaveBeenCalled();
	});
	it("returns valid empty inline output without confusing it with missing content", async () => {
		m.artifact.mockResolvedValue({
			userId: "example-author",
			organizationId: "example-org",
			name: "Empty.md",
			content: "",
			s3Path: null,
			mimeType: "text/markdown",
			execution: { status: "COMPLETED" },
		});
		expect(
			await handleDownloadReportArtifact({ input, context }),
		).toMatchObject({ type: "inline", content: "" });
		expect(m.sign).not.toHaveBeenCalled();
	});
});
