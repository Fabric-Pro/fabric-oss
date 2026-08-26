import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The presigned path's only sight of real bytes: after `downloadFile`, before
 * extraction. `create-upload-url` runs pre-upload and holds only filename,
 * MIME, and size, and the PUT goes straight to storage — so for every S3-backed
 * caller this procedure is the *first* server code to see what was uploaded,
 * and therefore the authority.
 */

vi.mock("@repo/config", () => ({
	config: {
		storage: { bucketNames: { chatDocuments: "chat-documents" } },
	},
}));
vi.mock("@repo/database", () => ({
	getAiChatByIdForOwner: vi.fn(),
	getChatDocumentByIdForOwner: vi.fn(),
	updateDocumentStatus: vi.fn(),
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@repo/rag", () => ({
	extractionFactory: { extract: vi.fn() },
}));
vi.mock("@repo/storage", () => ({ downloadFile: vi.fn() }));
vi.mock("@repo/temporal", () => ({ getTemporalClient: vi.fn() }));
vi.mock("../../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: (opts: unknown) => opts,
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

import {
	getAiChatByIdForOwner,
	getChatDocumentByIdForOwner,
} from "@repo/database";
import { extractionFactory } from "@repo/rag";
import { XlsxInflationCeilingError } from "@repo/rag/lib/extraction/types";
import { downloadFile } from "@repo/storage";
import { getTemporalClient } from "@repo/temporal";
import { processDocument } from "../process-document";

const handler = (processDocument as unknown as { handler: Function }).handler;

const XLSX_MIME =
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const OLE_BYTES = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ZIP_BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);

const ctx = { user: { id: "u1" }, session: {} };
const input = { documentId: "d1", extractionStrategy: "local-only" as const };

function givenStoredFile(filename: string, mimeType: string, data: Buffer) {
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
	vi.mocked(getAiChatByIdForOwner).mockResolvedValue({
		id: "c1",
		organizationId: null,
	} as any);
	vi.mocked(downloadFile).mockResolvedValue({
		data,
		contentType: mimeType,
		size: data.length,
	});
}

const workflowStart = vi.fn(async () => ({
	workflowId: "document-processing-d1",
	firstExecutionRunId: "run-1",
}));

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(getTemporalClient).mockResolvedValue({
		workflow: { start: workflowStart },
	} as any);
	vi.mocked(extractionFactory.extract).mockResolvedValue({
		text: "Sheet1\nA1\tB1",
		extractorUsed: "local-xlsx",
	} as any);
});

describe("processDocument — workbook signature admission", () => {
	it("refuses OLE bytes named .xlsx even when the client check was bypassed", async () => {
		// R11. The bytes reached storage via a presigned PUT, so this is the
		// first server code to see them.
		givenStoredFile("budget.xlsx", XLSX_MIME, OLE_BYTES);

		await expect(handler({ input, context: ctx })).rejects.toThrow(
			/likely password-protected/i,
		);

		// Refused before extraction, and before the chunking workflow starts —
		// a refused container must not be swallowed into a filename-only
		// fallback that embeds the file anyway.
		expect(extractionFactory.extract).not.toHaveBeenCalled();
		expect(workflowStart).not.toHaveBeenCalled();
	});

	it("refuses OLE bytes named .xls, naming .xlsx as the supported format", async () => {
		// R3. Reachable here because this path performs no MIME admission of
		// its own — it processes whatever row exists.
		givenStoredFile("budget.xls", "application/vnd.ms-excel", OLE_BYTES);

		await expect(handler({ input, context: ctx })).rejects.toThrow(
			/\.xlsx/,
		);
		expect(extractionFactory.extract).not.toHaveBeenCalled();
	});

	it("refuses bytes named .xlsx that carry neither container signature", async () => {
		// R12.
		givenStoredFile(
			"budget.xlsx",
			XLSX_MIME,
			Buffer.from([0x13, 0x37, 0x42, 0x99]),
		);

		await expect(handler({ input, context: ctx })).rejects.toThrow(
			/couldn't be read/i,
		);
		expect(extractionFactory.extract).not.toHaveBeenCalled();
	});

	it("extracts a zip-signed .xlsx and starts the workflow", async () => {
		givenStoredFile("budget.xlsx", XLSX_MIME, ZIP_BYTES);

		await expect(handler({ input, context: ctx })).resolves.toMatchObject({
			status: "PROCESSING",
			extractedContent: "Sheet1\nA1\tB1",
		});
		expect(extractionFactory.extract).toHaveBeenCalledTimes(1);
	});

	it("does not gate non-workbook formats on the signature", async () => {
		// A PDF is neither zip nor OLE — the classifier must stay silent.
		givenStoredFile(
			"spec.pdf",
			"application/pdf",
			Buffer.from("%PDF-1.7", "latin1"),
		);

		await expect(handler({ input, context: ctx })).resolves.toMatchObject({
			status: "PROCESSING",
		});
		expect(extractionFactory.extract).toHaveBeenCalledTimes(1);
	});

	it("still swallows a genuine extractor failure into the workflow fallback", async () => {
		// Pre-existing behavior the classifier's rethrow must not disturb: a
		// flaky pipeline is not a verdict about the file.
		givenStoredFile("budget.xlsx", XLSX_MIME, ZIP_BYTES);
		vi.mocked(extractionFactory.extract).mockRejectedValue(
			new Error("extractor exploded"),
		);

		await expect(handler({ input, context: ctx })).resolves.toMatchObject({
			status: "PROCESSING",
			extractedContent: null,
		});
		expect(workflowStart).toHaveBeenCalledTimes(1);
	});
});

/**
 * U6 — what the caller LEARNS about the extraction.
 *
 * Every case below used to collapse into `extractedContent: null`, which the
 * chip rendered as a clean green check. The upload behaviour is deliberately
 * unchanged — these assert the outcome that now travels beside it.
 */
describe("processDocument — extraction outcome", () => {
	it("reports the empty outcome when the extractor yields no text", async () => {
		// R9 / AE5. A chart-only workbook parses fine and produces nothing. It
		// is not a failure, and conflating the two is what left the user unable
		// to tell "no text in here" from "we broke".
		givenStoredFile("charts.xlsx", XLSX_MIME, ZIP_BYTES);
		vi.mocked(extractionFactory.extract).mockResolvedValue({
			text: "   ",
			extractorUsed: "local-xlsx",
			metadata: {
				sheets: [{ name: "Charts", state: "visible", hidden: false }],
				truncated: false,
			},
		} as any);

		const result = await handler({ input, context: ctx });

		expect(result.extraction).toEqual({
			status: "empty",
			sheets: [{ name: "Charts", hidden: false }],
		});
		expect(result.extractedContent).toBeNull();
		// Non-blocking: nothing about an empty read stops the upload.
		expect(workflowStart).toHaveBeenCalledTimes(1);
	});

	it("reports the truncated outcome with U5's counts", async () => {
		// R8 / AE2. The extractor already marks the omission in the text for the
		// model (R7); this is the same fact routed to the user.
		givenStoredFile("huge.xlsx", XLSX_MIME, ZIP_BYTES);
		vi.mocked(extractionFactory.extract).mockResolvedValue({
			text: "Sheet1\nA1\n\n[Spreadsheet truncated — 1240 rows omitted]",
			extractorUsed: "local-xlsx",
			metadata: {
				sheets: [
					{ name: "Q3", state: "visible", hidden: false },
					{ name: "Q4", state: "visible", hidden: false },
				],
				truncated: true,
				truncationReason: "budget",
				omittedRowCount: 1240,
				truncatedSheetNames: ["Q4"],
			},
		} as any);

		const result = await handler({ input, context: ctx });

		expect(result.extraction).toEqual({
			status: "truncated",
			reason: "budget",
			omittedRowCount: 1240,
			truncatedSheetNames: ["Q4"],
			sheets: [
				{ name: "Q3", hidden: false },
				{ name: "Q4", hidden: false },
			],
		});
		// Truncated text is still content — it must reach the envelope.
		expect(result.extractedContent).toContain("Sheet1");
	});

	it("carries the sheet list with hidden sheets marked", async () => {
		// R10 / AE6. Extraction is not WYSIWYG: without this the user can
		// publish a hidden tab into the tenant knowledge base and never know.
		givenStoredFile("thirdparty.xlsx", XLSX_MIME, ZIP_BYTES);
		vi.mocked(extractionFactory.extract).mockResolvedValue({
			text: "Summary\nA1",
			extractorUsed: "local-xlsx",
			metadata: {
				sheets: [
					{ name: "Summary", state: "visible", hidden: false },
					{ name: "Internal", state: "veryHidden", hidden: true },
				],
				truncated: false,
			},
		} as any);

		const result = await handler({ input, context: ctx });

		expect(result.extraction).toEqual({
			status: "extracted",
			sheets: [
				{ name: "Summary", hidden: false },
				{ name: "Internal", hidden: true },
			],
		});
	});

	it("reports a U5 inflation-ceiling refusal as a reason, not a filename-only fallback", async () => {
		// A refused decompression bomb is a verdict the user hears about, not a
		// pipeline wobble. Discrimination is on the error class — throw the real
		// one, so a reworded message can never silently collapse this branch into
		// the generic "couldn't be read" below it.
		givenStoredFile("bomb.xlsx", XLSX_MIME, ZIP_BYTES);
		vi.mocked(extractionFactory.extract).mockRejectedValue(
			new XlsxInflationCeilingError({
				ceilingBytes: 104_857_600,
				observedBytes: 419_430_400,
				refusedBeforeInflating: false,
			}),
		);

		const result = await handler({ input, context: ctx });

		expect(result.extraction).toMatchObject({ status: "failed" });
		expect((result.extraction as { reason: string }).reason).toMatch(
			/expands to far more data/i,
		);
		// Non-blocking, exactly as before.
		expect(workflowStart).toHaveBeenCalledTimes(1);
	});

	it("reports a thrown extractor error as failed while the upload still succeeds", async () => {
		givenStoredFile("budget.xlsx", XLSX_MIME, ZIP_BYTES);
		vi.mocked(extractionFactory.extract).mockRejectedValue(
			new Error("extractor exploded"),
		);

		const result = await handler({ input, context: ctx });

		expect(result.status).toBe("PROCESSING");
		expect(result.extractedContent).toBeNull();
		expect(result.extraction).toMatchObject({ status: "failed" });
		// The raw crash never reaches the user; the sentence names what they are
		// left with instead.
		expect((result.extraction as { reason: string }).reason).not.toContain(
			"exploded",
		);
		expect((result.extraction as { reason: string }).reason).toMatch(
			/couldn't be read/i,
		);
		expect(workflowStart).toHaveBeenCalledTimes(1);
	});

	it("gives the already-READY early return a defined outcome, not an unclassified null", async () => {
		// This path returns before extraction runs at all. Without a state of
		// its own, its `extractedContent: null` is indistinguishable from a file
		// we failed to read — and the chip would warn about a document that is
		// perfectly fine.
		givenStoredFile("budget.xlsx", XLSX_MIME, ZIP_BYTES);
		vi.mocked(getChatDocumentByIdForOwner).mockResolvedValue({
			id: "d1",
			filename: "budget.xlsx",
			mimeType: XLSX_MIME,
			status: "READY",
			organizationId: null,
			userId: "u1",
			chatId: "c1",
			s3Path: "chat/u1/d1",
			workflowId: "wf-1",
			workflowRunId: "run-1",
		} as any);

		const result = await handler({ input, context: ctx });

		expect(result.extraction).toEqual({ status: "skipped" });
		expect(extractionFactory.extract).not.toHaveBeenCalled();
		expect(workflowStart).not.toHaveBeenCalled();
	});

	it("keeps the outcome on the workflow-start-failure path that has usable content", async () => {
		// Existing behavior: a dead Temporal worker must not discard text we
		// already hold. The outcome rides along — the workflow is what failed,
		// not the read, and a truncated file is still truncated here.
		givenStoredFile("huge.xlsx", XLSX_MIME, ZIP_BYTES);
		vi.mocked(extractionFactory.extract).mockResolvedValue({
			text: "Sheet1\nA1",
			extractorUsed: "local-xlsx",
			metadata: {
				sheets: [{ name: "Q3", state: "visible", hidden: false }],
				truncated: true,
				truncationReason: "rows",
				omittedRowCount: 12,
				truncatedSheetNames: ["Q3"],
			},
		} as any);
		workflowStart.mockRejectedValueOnce(new Error("no worker") as never);

		const result = await handler({ input, context: ctx });

		expect(result.status).toBe("FAILED");
		expect(result.extractedContent).toBe("Sheet1\nA1");
		expect(result.extraction).toMatchObject({
			status: "truncated",
			omittedRowCount: 12,
		});
	});

	it("reports a clean non-workbook extraction with an empty sheet list", async () => {
		// PDFs and DOCX carry no sheet metadata. Absent metadata is an empty
		// list, not a fault — the reader must not read it as one.
		givenStoredFile(
			"spec.pdf",
			"application/pdf",
			Buffer.from("%PDF-1.7", "latin1"),
		);
		vi.mocked(extractionFactory.extract).mockResolvedValue({
			text: "Hello",
			extractorUsed: "local-pdf",
		} as any);

		const result = await handler({ input, context: ctx });

		expect(result.extraction).toEqual({ status: "extracted", sheets: [] });
	});
});

describe("processDocument — the character budget backstop", () => {
	/**
	 * The budget option reaches the extraction factory, but only the workbook
	 * walk honours it — it is the one extractor that can stop mid-file and
	 * report where it stopped. The PDF, DOCX, and plain-text extractors return
	 * whatever they parsed, so a large PDF arrived here whole and went straight
	 * into a prompt.
	 *
	 * That is the same unbounded-inline gap the browser-read path had, on a
	 * path the browser never touches — and it only became reachable once
	 * surfaces started delivering this text inline instead of discarding it.
	 */
	it("bounds a large PDF the extractor returned whole", async () => {
		givenStoredFile(
			"huge.pdf",
			"application/pdf",
			Buffer.from("%PDF-1.7", "latin1"),
		);
		vi.mocked(extractionFactory.extract).mockResolvedValue({
			text: "p".repeat(250_000),
			extractorUsed: "local-pdf",
		} as any);

		const result = await handler({ input, context: ctx });

		expect(result.extraction?.status).toBe("truncated");
		expect(result.extractedContent).toContain("[Document truncated");
		expect((result.extractedContent as string).length).toBeLessThan(
			250_000,
		);
	});

	it("leaves a PDF under the budget untouched", async () => {
		givenStoredFile(
			"small.pdf",
			"application/pdf",
			Buffer.from("%PDF-1.7", "latin1"),
		);
		vi.mocked(extractionFactory.extract).mockResolvedValue({
			text: "a readable paragraph",
			extractorUsed: "local-pdf",
		} as any);

		const result = await handler({ input, context: ctx });

		expect(result.extraction).toEqual({ status: "extracted", sheets: [] });
		expect(result.extractedContent).toBe("a readable paragraph");
	});

	it("does not override a truncation the extractor already reported", async () => {
		// The workbook walk reports rows and sheets, which the backstop cannot
		// know. Re-deriving the outcome here would replace a specific message
		// with a vaguer one.
		givenStoredFile("budget.xlsx", XLSX_MIME, ZIP_BYTES);
		vi.mocked(extractionFactory.extract).mockResolvedValue({
			text: "Sheet1\nA1",
			extractorUsed: "local-xlsx",
			metadata: {
				truncated: true,
				truncationReason: "rows",
				omittedRowCount: 1240,
				truncatedSheetNames: ["Q4"],
			},
		} as any);

		const result = await handler({ input, context: ctx });

		expect(result.extraction).toMatchObject({
			status: "truncated",
			reason: "rows",
			omittedRowCount: 1240,
		});
	});
});
