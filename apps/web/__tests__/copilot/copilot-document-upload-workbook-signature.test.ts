/**
 * U4 — the client-side half of workbook rejection (AE3, R3, R11, R12).
 *
 * This check is an advisory UX affordance, not a control: `accept` is only a
 * picker hint, paste/drop bypass it, and the oRPC endpoint is reachable
 * directly. Its whole job is to refuse a bad workbook at *selection*, with a
 * reason, before any network call. The server re-runs the same classifier on
 * the bytes it actually receives — covered in `@repo/api`'s
 * `process-document.test.ts` and `upload.test.ts`.
 */

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockToastError,
	mockToastInfo,
	mockCompressImage,
	mockCreateUploadUrl,
	mockUpload,
	mockProcess,
} = vi.hoisted(() => ({
	mockToastError: vi.fn(),
	mockToastInfo: vi.fn(),
	mockCompressImage: vi.fn(async (f: File) => f),
	mockCreateUploadUrl: vi.fn(),
	mockUpload: vi.fn(),
	mockProcess: vi.fn(),
}));

vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	// The hook reads OPENAPI_SPEC_CONTEXT through the provider, which only the
	// app layout mounts. `true` is the interesting value here: it lets the
	// spec guard run, so these suites exercise the same path production does.
	useFeatureFlag: () => true,
}));

vi.mock("sonner", () => ({
	toast: { error: mockToastError, info: mockToastInfo, success: vi.fn() },
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
	compressImage: mockCompressImage,
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		ai: {
			documents: {
				createUploadUrl: mockCreateUploadUrl,
				upload: mockUpload,
				process: mockProcess,
			},
		},
	},
}));

import { useCopilotDocumentUpload } from "@saas/shared/components/copilot/use-copilot-document-upload";

const XLSX_MIME =
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const LEGACY_XLS_MIME = "application/vnd.ms-excel";

/** OLE compound file header — legacy Office, and encrypted OOXML. */
const OLE_BYTES = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a]);
/** A real .xlsx is a zip. */
const ZIP_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);

function fileOf(bytes: Uint8Array, name: string, type: string): File {
	return new File([bytes], name, { type });
}

beforeEach(() => {
	vi.clearAllMocks();
});

function renderUpload() {
	return renderHook(() => useCopilotDocumentUpload({ organizationId: null }));
}

describe("useCopilotDocumentUpload — workbook signature at selection", () => {
	it("refuses a genuine .xls with a message naming .xlsx, and fires no request", async () => {
		// AE3 / R3. The extension guard would otherwise refuse this first with a
		// bare "File type not supported", never telling the user what to do.
		const { result } = renderUpload();

		await act(async () => {
			await result.current.addFiles([
				fileOf(OLE_BYTES, "budget.xls", LEGACY_XLS_MIME),
			]);
		});

		expect(mockToastError).toHaveBeenCalledTimes(1);
		expect(mockToastError).toHaveBeenCalledWith(
			expect.stringContaining(".xlsx"),
		);
		expect(result.current.attachedFiles).toHaveLength(0);

		// Rejected at selection — no chip, so nothing to upload.
		await act(async () => {
			await result.current.uploadAttachments();
		});
		expect(mockCreateUploadUrl).not.toHaveBeenCalled();
	});

	it("refuses an OLE-signed .xlsx as likely password-protected, hedged not asserted", async () => {
		// R11. OLE is the container for every legacy Office format, so this
		// branch is a best guess — the copy must say so.
		const { result } = renderUpload();

		await act(async () => {
			await result.current.addFiles([
				fileOf(OLE_BYTES, "budget.xlsx", XLSX_MIME),
			]);
		});

		expect(mockToastError).toHaveBeenCalledWith(
			expect.stringMatching(/likely password-protected/i),
		);
		expect(result.current.attachedFiles).toHaveLength(0);
		expect(mockCreateUploadUrl).not.toHaveBeenCalled();
	});

	it("refuses an .xlsx carrying neither signature as unreadable", async () => {
		// R12.
		const { result } = renderUpload();

		await act(async () => {
			await result.current.addFiles([
				fileOf(
					new Uint8Array([0x13, 0x37, 0x42, 0x99]),
					"budget.xlsx",
					XLSX_MIME,
				),
			]);
		});

		expect(mockToastError).toHaveBeenCalledWith(
			expect.stringMatching(/couldn't be read/i),
		);
		expect(result.current.attachedFiles).toHaveLength(0);
	});

	it("refuses a 0-byte .xlsx once, without the empty-file notice contradicting it", async () => {
		// R12. A 0-byte file cannot be a workbook. The signature check is
		// ordered ahead of FR-15's empty-file notice so the user is not first
		// told the file was "attached" and then told it was refused.
		const { result } = renderUpload();

		await act(async () => {
			await result.current.addFiles([
				fileOf(new Uint8Array([]), "budget.xlsx", XLSX_MIME),
			]);
		});

		expect(mockToastError).toHaveBeenCalledTimes(1);
		expect(mockToastError).toHaveBeenCalledWith(
			expect.stringMatching(/couldn't be read/i),
		);
		expect(mockToastInfo).not.toHaveBeenCalled();
		expect(result.current.attachedFiles).toHaveLength(0);
	});

	it("still attaches a 0-byte non-workbook with the empty-file notice (FR-15)", async () => {
		// The classifier must not have widened the empty-file rule beyond
		// workbooks — an empty .txt is still the user's call to attach.
		const { result } = renderUpload();

		await act(async () => {
			await result.current.addFiles([
				fileOf(new Uint8Array([]), "notes.txt", "text/plain"),
			]);
		});

		expect(mockToastError).not.toHaveBeenCalled();
		expect(mockToastInfo).toHaveBeenCalledWith(
			expect.stringContaining("is empty"),
		);
		expect(result.current.attachedFiles).toHaveLength(1);
	});

	it("accepts a zip-signed .xlsx", async () => {
		const { result } = renderUpload();

		await act(async () => {
			await result.current.addFiles([
				fileOf(ZIP_BYTES, "budget.xlsx", XLSX_MIME),
			]);
		});

		expect(mockToastError).not.toHaveBeenCalled();
		expect(result.current.attachedFiles).toHaveLength(1);
		expect(result.current.attachedFiles[0].name).toBe("budget.xlsx");
	});

	it("accepts an .xlsx the browser mislabels with the legacy Excel MIME", async () => {
		// R4. Windows with Excel installed reports .xlsx as ms-excel; the
		// signature is zip, so the classifier stays quiet and the extension
		// guard admits it.
		const { result } = renderUpload();

		await act(async () => {
			await result.current.addFiles([
				fileOf(ZIP_BYTES, "budget.xlsx", LEGACY_XLS_MIME),
			]);
		});

		expect(mockToastError).not.toHaveBeenCalled();
		expect(result.current.attachedFiles).toHaveLength(1);
	});

	it("leaves non-workbook formats alone", async () => {
		// A PDF is neither zip nor OLE. If the classifier gated every file,
		// this would be refused as unreadable.
		const { result } = renderUpload();

		await act(async () => {
			await result.current.addFiles([
				fileOf(
					new Uint8Array([0x25, 0x50, 0x44, 0x46]),
					"spec.pdf",
					"application/pdf",
				),
				fileOf(new Uint8Array([0x68, 0x69]), "notes.txt", "text/plain"),
				fileOf(
					new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
					"shot.png",
					"image/png",
				),
			]);
		});

		expect(mockToastError).not.toHaveBeenCalled();
		expect(result.current.attachedFiles).toHaveLength(3);
	});

	it("keeps the image cap intact now that validation awaits a byte read", async () => {
		// The signature read is hoisted above the image-count read precisely so
		// that read → validate → reserve stays one synchronous block. Two
		// concurrent addFiles calls (paste racing drop) must not both see a
		// pre-reservation count and both admit a full quota.
		const { result } = renderHook(() =>
			useCopilotDocumentUpload({
				organizationId: null,
				maxImageCount: 2,
				allowedImageTypes: ["image/png"],
			}),
		);

		const png = (n: string) =>
			fileOf(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), n, "image/png");

		await act(async () => {
			await Promise.all([
				result.current.addFiles([png("a.png"), png("b.png")], "paste"),
				result.current.addFiles([png("c.png"), png("d.png")], "drop"),
			]);
		});

		expect(result.current.attachedFiles).toHaveLength(2);
		expect(mockToastError).toHaveBeenCalledWith(
			expect.stringContaining("up to 2 images"),
		);
	});
});
