/**
 * U1 — the character budget on text read in the browser (R1, R2, R3).
 *
 * Text formats never reach the server extractor: `isBinaryDocument()` is false
 * for them, so the hook reads them with a `FileReader` and hands the string
 * straight to the envelope builder. That path had no bound at all — the only
 * barrier was the upload byte cap, which is three orders of magnitude larger
 * than the character budget spreadsheets have had since the Excel work.
 *
 * The fixture here is deliberately **one large file** rather than many small
 * ones. The repo's record of the near-identical spreadsheet bug notes that its
 * first regression test passed against the wrong input shape while the real
 * hole stayed open: a per-file budget is not exercised by twenty files that are
 * each under it.
 */

import { DEFAULT_AI_CHAT_EXTRACTED_TEXT_BUDGET_CHARS } from "@repo/utils/ai-chat-attachment";
import { act, renderHook, waitFor } from "@testing-library/react";
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

const BUDGET = DEFAULT_AI_CHAT_EXTRACTED_TEXT_BUDGET_CHARS;

function markdown(content: string, name = "notes.md"): File {
	return new File([content], name, { type: "text/markdown" });
}

/**
 * Attach one text file and wait for the asynchronous `FileReader` read to land
 * on the record. `addFiles` queues the read and returns before it resolves, so
 * awaiting the call alone observes the chip mid-flight.
 */
async function attachText(file: File) {
	const { result } = renderHook(() =>
		useCopilotDocumentUpload({ organizationId: null }),
	);
	await act(async () => {
		await result.current.addFiles([file]);
	});
	await waitFor(() => {
		expect(result.current.attachedFiles[0]?.extractedContent).toBeDefined();
	});
	return result;
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

describe("useCopilotDocumentUpload — character budget on client-read text", () => {
	it("truncates one oversized text file and marks the outcome", async () => {
		// AE1. A single file past the budget, which is the shape that reproduces
		// the gap — not a pile of small ones.
		const total = BUDGET + 5_000;
		const result = await attachText(markdown("a".repeat(total)));

		const attached = result.current.attachedFiles[0];
		expect(attached.extraction).toEqual({
			status: "truncated",
			sheets: [],
			reason: "budget",
			omittedCharCount: 5_000,
		});
		// The kept text plus the marker — never the original length.
		expect(attached.extractedContent?.length).toBeLessThan(total);
		expect(attached.extractedContent).toContain("[Document truncated");
	});

	it("names the limit that was applied, so the model can say what is missing", async () => {
		// R2. Without the counts the model reports an omitted line as absent from
		// the document rather than as unread.
		const result = await attachText(markdown("b".repeat(BUDGET + 1_234)));

		expect(result.current.attachedFiles[0].extractedContent).toContain(
			"1,234 of 101,234 characters omitted",
		);
	});

	it("agrees with itself — a record reporting truncation is in fact cut", async () => {
		// AE1. The chip notice and the model's copy are built from the same call;
		// this pins that they cannot disagree.
		const result = await attachText(markdown("c".repeat(BUDGET + 10)));

		const attached = result.current.attachedFiles[0];
		expect(attached.extraction?.status).toBe("truncated");
		const body = attached.extractedContent?.split(
			"\n\n[Document truncated",
		)[0];
		expect(body).toHaveLength(BUDGET);
	});

	it("leaves a file under the budget untouched and reports no truncation", async () => {
		const content = "# Notes\n\nnothing unusual here";
		const result = await attachText(markdown(content));

		const attached = result.current.attachedFiles[0];
		expect(attached.extractedContent).toBe(content);
		expect(attached.extraction).toEqual({
			status: "extracted",
			sheets: [],
		});
	});

	it("reports an empty text file as empty rather than as truncated", async () => {
		// A zero-byte file is a real upload, not a bound being hit. Reporting it
		// as truncated would tell the user content was dropped when none existed.
		const { result } = renderHook(() =>
			useCopilotDocumentUpload({ organizationId: null }),
		);
		await act(async () => {
			await result.current.addFiles([markdown("   \n  ", "empty.md")]);
		});
		await waitFor(() => {
			expect(result.current.attachedFiles[0]?.extraction).toBeDefined();
		});

		expect(result.current.attachedFiles[0].extraction).toEqual({
			status: "empty",
			sheets: [],
		});
	});
});
