/**
 * U6 — the extraction outcome reaching the attached-file record (R8, R9, R10, R12).
 *
 * The hook's job here is narrow: carry what the server reports about what it
 * actually read onto the chip's record, and never let that reporting turn a
 * completed upload into a failed one. Everything the outcome then *says* is
 * rendered by `CopilotSidebarAttachments` — covered in
 * `copilot-attachment-extraction-notice.test.tsx`.
 *
 * The case that motivates all of this: before U6, `process()` throwing (a
 * password-protected workbook the server refused) was caught, logged to the
 * console, and the chip went green. The upload "succeeded" and the user was
 * never told the file carried nothing.
 */

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockToastError, mockCreateUploadUrl, mockProcess } = vi.hoisted(() => ({
	mockToastError: vi.fn(),
	mockCreateUploadUrl: vi.fn(),
	mockProcess: vi.fn(),
}));

vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	// The hook reads OPENAPI_SPEC_CONTEXT through the provider, which only the
	// app layout mounts. `true` is the interesting value here: it lets the
	// spec guard run, so these suites exercise the same path production does.
	useFeatureFlag: () => true,
}));

vi.mock("sonner", () => ({
	toast: { error: mockToastError, info: vi.fn(), success: vi.fn() },
}));
vi.mock("@saas/projects/lib/image-upload-utils", () => ({
	prepareImageForAi: vi.fn(async (file: File) => ({
		ok: true as const,
		file,
	})),
	// The upload hook calls this after compressImage. A mock without it
	// throws inside preparation; the default stub keeps the pre-existing
	// behaviour of these suites (every image is within budget).
	compressImageToBudget: vi.fn(async (file: File) => ({
		file,
		withinBudget: true,
	})),
	compressImage: vi.fn(async (f: File) => f),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		ai: {
			documents: {
				createUploadUrl: mockCreateUploadUrl,
				upload: vi.fn(),
				process: mockProcess,
			},
		},
	},
}));

import { useCopilotDocumentUpload } from "@saas/shared/components/copilot/use-copilot-document-upload";

const XLSX_MIME =
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
/** A real .xlsx is a zip — this clears U4's selection-time classifier. */
const ZIP_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);

function workbook(name = "budget.xlsx"): File {
	return new File([ZIP_BYTES], name, { type: XLSX_MIME });
}

beforeEach(() => {
	vi.clearAllMocks();
	mockCreateUploadUrl.mockResolvedValue({
		documentId: "doc-1",
		signedUploadUrl: "https://storage.example/put",
		chatId: "chat-1",
		s3Path: "chat/u1/doc-1",
	});
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({ ok: true, status: 200 })),
	);
});

/** Attach one workbook and run the upload to completion. */
async function uploadWorkbook(onContentExtracted?: (entry: string) => void) {
	const { result } = renderHook(() =>
		useCopilotDocumentUpload({ organizationId: null, onContentExtracted }),
	);
	await act(async () => {
		await result.current.addFiles([workbook()]);
	});
	await act(async () => {
		await result.current.uploadAttachments();
	});
	return result;
}

describe("useCopilotDocumentUpload — extraction outcome on the record", () => {
	it("carries the truncated outcome and its counts onto the chip record", async () => {
		// R8. The chip is the only place the user can learn the file was cut.
		mockProcess.mockResolvedValue({
			extractedContent: "Sheet1\nA1",
			extraction: {
				status: "truncated",
				reason: "budget",
				omittedRowCount: 1240,
				truncatedSheetNames: ["Q4"],
				sheets: [{ name: "Q4", hidden: false }],
			},
		});

		const result = await uploadWorkbook();

		expect(result.current.attachedFiles[0].extraction).toEqual({
			status: "truncated",
			reason: "budget",
			omittedRowCount: 1240,
			truncatedSheetNames: ["Q4"],
			sheets: [{ name: "Q4", hidden: false }],
		});
		// Truncated is still content-bearing, and the chip still completes.
		expect(result.current.attachedFiles[0].status).toBe("ready");
	});

	it("carries the empty outcome even though there is no content to store", async () => {
		// R9. The old code only wrote to the record `if (result.extractedContent)`,
		// so precisely the silent cases wrote nothing.
		mockProcess.mockResolvedValue({
			extractedContent: null,
			extraction: {
				status: "empty",
				sheets: [{ name: "Charts", hidden: false }],
			},
		});

		const result = await uploadWorkbook();

		expect(result.current.attachedFiles[0].extraction).toEqual({
			status: "empty",
			sheets: [{ name: "Charts", hidden: false }],
		});
	});

	it("maps a server rejection onto the failed outcome instead of a green chip", async () => {
		// R12. The server refuses a workbook by throwing (a verdict, not a
		// pipeline wobble) and the reason rides on the message. Swallowing it
		// into a console warning is the bug this closes.
		mockProcess.mockRejectedValue(
			new Error(
				`"budget.xlsx" couldn't be read — it's likely password-protected. You may want to attach a copy without protection.`,
			),
		);

		const result = await uploadWorkbook();

		expect(result.current.attachedFiles[0].extraction).toEqual({
			status: "failed",
			reason: expect.stringMatching(/likely password-protected/i),
		});
	});

	it("keeps the upload non-blocking when extraction fails", async () => {
		// The contract U6 must not break: a refused or failed read still leaves a
		// completed attachment, and the envelope still gets the filename so the
		// agent knows the file is in scope.
		const onContentExtracted = vi.fn();
		mockProcess.mockRejectedValue(new Error("boom"));

		const result = await uploadWorkbook(onContentExtracted);

		expect(result.current.attachedFiles[0].status).toBe("ready");
		expect(onContentExtracted).toHaveBeenCalledWith(
			"<fabric_attachment>\n[Uploaded Document: budget.xlsx]\n</fabric_attachment>",
		);
		expect(mockToastError).not.toHaveBeenCalled();
	});

	it("falls back to a readable sentence when the thrown error carries no message", async () => {
		mockProcess.mockRejectedValue(new Error(""));

		const result = await uploadWorkbook();

		expect(result.current.attachedFiles[0].extraction).toEqual({
			status: "failed",
			reason: expect.stringMatching(/couldn't be read/i),
		});
	});

	it("carries the skipped outcome without inventing a warning", async () => {
		// The already-READY early return. Nothing was attempted, so the chip must
		// stay quiet rather than report a file it never tried to read.
		mockProcess.mockResolvedValue({
			extractedContent: null,
			extraction: { status: "skipped" },
		});

		const result = await uploadWorkbook();

		expect(result.current.attachedFiles[0].extraction).toEqual({
			status: "skipped",
		});
		expect(result.current.attachedFiles[0].status).toBe("ready");
	});

	it("reports a client-side outcome for text without a server round-trip", async () => {
		// Text files never reach `process()` — they are read in the browser, and
		// that half is unchanged. What changed with U1 is the other half: the
		// browser now applies the character budget, so it *has* something true to
		// say about what was read. Before that it did not, and this test asserted
		// the field stayed unset because any value would have been invented.
		const { result } = renderHook(() =>
			useCopilotDocumentUpload({ organizationId: null }),
		);
		await act(async () => {
			await result.current.addFiles([
				new File(["hello"], "notes.txt", { type: "text/plain" }),
			]);
		});
		await act(async () => {
			await result.current.uploadAttachments();
		});

		expect(mockProcess).not.toHaveBeenCalled();
		expect(result.current.attachedFiles[0].extraction).toEqual({
			status: "extracted",
			sheets: [],
		});
	});
});
