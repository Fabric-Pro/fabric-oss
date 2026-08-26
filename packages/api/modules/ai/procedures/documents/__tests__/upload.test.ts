import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The non-presigned provider path is one of exactly two server loci holding
 * real attachment bytes (the other is `process-document`, post-download).
 * `create-upload-url` runs before the upload and receives only filename, MIME,
 * and size — there is nothing to sniff there.
 *
 * These cover U4's server-authority scenario: the hook runs the same classifier
 * at file selection, but that check is advisory — `accept` is a picker hint,
 * paste/drop bypass it, and this endpoint is reachable directly.
 */

vi.mock("@repo/config", () => ({
	config: {
		storage: { bucketNames: { chatDocuments: "chat-documents" } },
	},
}));
vi.mock("@repo/database", () => ({
	getChatDocumentByIdForOwner: vi.fn(),
	updateDocumentStatus: vi.fn(),
}));
vi.mock("@repo/storage", () => ({
	getStorageProvider: vi.fn(() => ({ type: "vercel-blob" })),
	uploadFile: vi.fn(async () => ({ url: "https://blob.example/f" })),
}));
vi.mock("../../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: vi.fn(),
}));
vi.mock("../../../../../orpc/procedures", () => {
	const chain: Record<string, unknown> = {};
	for (const m of ["use", "route", "input", "output"]) {
		chain[m] = () => chain;
	}
	chain.handler = (fn: unknown) => ({ handler: fn });
	return {
		tenantProtectedProcedure: chain,
		requirePermission: () => chain,
		Permissions: { AI_CHAT: "ai:chat" },
	};
});

import { getChatDocumentByIdForOwner } from "@repo/database";
import { uploadFile } from "@repo/storage";
import { uploadDocument } from "../upload";

const handler = (uploadDocument as unknown as { handler: Function }).handler;

const XLSX_MIME =
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** OLE compound file header — an encrypted OOXML workbook opens with this. */
const OLE_BASE64 = Buffer.from([
	0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1,
]).toString("base64");
/** A real .xlsx is a zip. */
const ZIP_BASE64 = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]).toString(
	"base64",
);
const PDF_BASE64 = Buffer.from("%PDF-1.7\n%âãÏÓ", "latin1").toString("base64");

const ctx = { user: { id: "u1" }, session: {} };

function givenDocument(filename: string, mimeType: string) {
	vi.mocked(getChatDocumentByIdForOwner).mockResolvedValue({
		id: "d1",
		filename,
		mimeType,
		status: "PENDING",
		organizationId: null,
		userId: "u1",
		chatId: "c1",
		s3Path: "chat/u1/d1",
	} as any);
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("uploadDocument — workbook signature admission", () => {
	it("refuses OLE bytes named .xlsx, naming password protection as likely", async () => {
		// R11. The client check is bypassable; this is where it counts. The
		// declared MIME is the legitimate xlsx one, so type admission passes and
		// only the container signature catches this.
		givenDocument("budget.xlsx", XLSX_MIME);

		await expect(
			handler({
				input: {
					documentId: "d1",
					fileData: OLE_BASE64,
					mimeType: XLSX_MIME,
				},
				context: ctx,
			}),
		).rejects.toThrow(/likely password-protected/i);

		// Refused before the bytes reach storage.
		expect(uploadFile).not.toHaveBeenCalled();
	});

	it("refuses bytes named .xlsx that are neither zip nor OLE", async () => {
		// R12. Corrupt or simply not a workbook.
		givenDocument("budget.xlsx", XLSX_MIME);

		await expect(
			handler({
				input: {
					documentId: "d1",
					fileData: Buffer.from([0x13, 0x37, 0x42, 0x99]).toString(
						"base64",
					),
					mimeType: XLSX_MIME,
				},
				context: ctx,
			}),
		).rejects.toThrow(/couldn't be read/i);
		expect(uploadFile).not.toHaveBeenCalled();
	});

	it("refuses a genuine .xls — type admission catches it before the classifier", async () => {
		// R3. The legacy Excel MIME is not on the allowlist and the extension
		// fallback resolves back to it, so `resolveAiChatUploadMime` fails first.
		// Asserted so the ordering is deliberate: were the allowlist ever to
		// admit ms-excel, the classifier below would still refuse these bytes.
		givenDocument("budget.xls", "application/vnd.ms-excel");

		await expect(
			handler({
				input: {
					documentId: "d1",
					fileData: OLE_BASE64,
					mimeType: "application/vnd.ms-excel",
				},
				context: ctx,
			}),
		).rejects.toThrow(/Unsupported file type/i);
		expect(uploadFile).not.toHaveBeenCalled();
	});

	it("admits a zip-signed .xlsx", async () => {
		givenDocument("budget.xlsx", XLSX_MIME);

		await expect(
			handler({
				input: {
					documentId: "d1",
					fileData: ZIP_BASE64,
					mimeType: XLSX_MIME,
				},
				context: ctx,
			}),
		).resolves.toMatchObject({ success: true, documentId: "d1" });
		expect(uploadFile).toHaveBeenCalledTimes(1);
	});

	it("does not gate non-workbook formats on the signature", async () => {
		// A PDF is neither zip nor OLE. If the classifier applied to every
		// upload, every PDF attachment would be refused as unreadable.
		givenDocument("spec.pdf", "application/pdf");

		await expect(
			handler({
				input: {
					documentId: "d1",
					fileData: PDF_BASE64,
					mimeType: "application/pdf",
				},
				context: ctx,
			}),
		).resolves.toMatchObject({ success: true });
		expect(uploadFile).toHaveBeenCalledTimes(1);
	});
});
