import {
	DEFAULT_AI_CHAT_EXTRACTED_TEXT_BUDGET_CHARS,
	DEFAULT_AI_CHAT_EXTRACTION_DEADLINE_MS,
	DEFAULT_AI_CHAT_MAX_CELLS,
	DEFAULT_AI_CHAT_MAX_FILE_BYTES,
	DEFAULT_AI_CHAT_MAX_INFLATED_BYTES,
	DEFAULT_AI_CHAT_MAX_ROWS,
	DEFAULT_AI_CHAT_MAX_SHEETS,
	DEFAULT_AI_CHAT_MIME_ALLOWLIST,
} from "@repo/utils/ai-chat-attachment";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	AI_CHAT_MAX_BYTES_CEILING,
	resolveAiChatAttachmentLimits,
	resolveAiChatUploadMime,
} from "../ai-chat-attachment-limits";

const ENV_KEYS = [
	"FABRIC_AI_CHAT_MAX_BYTES",
	"FABRIC_AI_CHAT_MIME_ALLOWLIST",
	"FABRIC_AI_CHAT_MAX_INFLATED_BYTES",
	"FABRIC_AI_CHAT_EXTRACTED_TEXT_BUDGET_CHARS",
	"FABRIC_AI_CHAT_MAX_SHEETS",
	"FABRIC_AI_CHAT_MAX_ROWS",
	"FABRIC_AI_CHAT_MAX_CELLS",
	"FABRIC_AI_CHAT_EXTRACTION_DEADLINE_MS",
] as const;

beforeEach(() => {
	for (const k of ENV_KEYS) {
		delete process.env[k];
	}
});
afterEach(() => {
	for (const k of ENV_KEYS) {
		delete process.env[k];
	}
});

const XLSX_MIME =
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const LEGACY_EXCEL_MIME = "application/vnd.ms-excel";

describe("resolveAiChatAttachmentLimits", () => {
	it("returns the shared vocabulary's defaults when no env is set", () => {
		const l = resolveAiChatAttachmentLimits();
		expect(l.maxBytes).toBe(DEFAULT_AI_CHAT_MAX_FILE_BYTES);
		expect(l.allowlist).toEqual(DEFAULT_AI_CHAT_MIME_ALLOWLIST);
		expect(l.maxInflatedBytes).toBe(DEFAULT_AI_CHAT_MAX_INFLATED_BYTES);
		expect(l.extractedTextBudgetChars).toBe(
			DEFAULT_AI_CHAT_EXTRACTED_TEXT_BUDGET_CHARS,
		);
		expect(l.maxSheets).toBe(DEFAULT_AI_CHAT_MAX_SHEETS);
		expect(l.maxRows).toBe(DEFAULT_AI_CHAT_MAX_ROWS);
		expect(l.maxCells).toBe(DEFAULT_AI_CHAT_MAX_CELLS);
		expect(l.extractionDeadlineMs).toBe(
			DEFAULT_AI_CHAT_EXTRACTION_DEADLINE_MS,
		);
	});

	it("replaces the default allowlist with a comma-separated override", () => {
		process.env.FABRIC_AI_CHAT_MIME_ALLOWLIST = `application/pdf, ${XLSX_MIME}`;
		expect(resolveAiChatAttachmentLimits().allowlist).toEqual([
			"application/pdf",
			XLSX_MIME,
		]);
	});

	it("fails closed on a present-but-empty allowlist env", () => {
		process.env.FABRIC_AI_CHAT_MIME_ALLOWLIST = "";
		expect(resolveAiChatAttachmentLimits().allowlist).toEqual([]);
	});

	it("fails closed on an allowlist env of only separators", () => {
		process.env.FABRIC_AI_CHAT_MIME_ALLOWLIST = " , , ";
		expect(resolveAiChatAttachmentLimits().allowlist).toEqual([]);
	});

	it("applies a valid byte override", () => {
		process.env.FABRIC_AI_CHAT_MAX_BYTES = "1048576";
		expect(resolveAiChatAttachmentLimits().maxBytes).toBe(1048576);
	});

	it("clamps an over-ceiling byte override to the ceiling (fail closed)", () => {
		process.env.FABRIC_AI_CHAT_MAX_BYTES = "9999999999";
		expect(resolveAiChatAttachmentLimits().maxBytes).toBe(
			AI_CHAT_MAX_BYTES_CEILING,
		);
	});

	it("ignores a garbage byte override and uses the default", () => {
		process.env.FABRIC_AI_CHAT_MAX_BYTES = "not-a-number";
		expect(resolveAiChatAttachmentLimits().maxBytes).toBe(
			DEFAULT_AI_CHAT_MAX_FILE_BYTES,
		);
	});

	it("applies overrides to the extraction bounds U5 reads", () => {
		process.env.FABRIC_AI_CHAT_MAX_INFLATED_BYTES = "2048";
		process.env.FABRIC_AI_CHAT_EXTRACTED_TEXT_BUDGET_CHARS = "512";
		process.env.FABRIC_AI_CHAT_MAX_SHEETS = "3";
		process.env.FABRIC_AI_CHAT_MAX_ROWS = "40";
		process.env.FABRIC_AI_CHAT_MAX_CELLS = "500";
		process.env.FABRIC_AI_CHAT_EXTRACTION_DEADLINE_MS = "250";
		const l = resolveAiChatAttachmentLimits();
		expect(l.maxInflatedBytes).toBe(2048);
		expect(l.extractedTextBudgetChars).toBe(512);
		expect(l.maxSheets).toBe(3);
		expect(l.maxRows).toBe(40);
		expect(l.maxCells).toBe(500);
		expect(l.extractionDeadlineMs).toBe(250);
	});
});

describe("resolveAiChatUploadMime", () => {
	it("admits a browser-mislabeled .xlsx as the spreadsheet MIME", () => {
		// Windows with Excel installed reports .xlsx uploads as legacy ms-excel.
		expect(
			resolveAiChatUploadMime("quarterly.xlsx", LEGACY_EXCEL_MIME),
		).toBe(XLSX_MIME);
	});

	it("rejects a genuine legacy .xls", () => {
		expect(resolveAiChatUploadMime("legacy.xls", LEGACY_EXCEL_MIME)).toBe(
			null,
		);
	});

	it("passes an honestly-declared xlsx through unchanged", () => {
		expect(resolveAiChatUploadMime("quarterly.xlsx", XLSX_MIME)).toBe(
			XLSX_MIME,
		);
	});

	it("rejects a type outside the allowlist", () => {
		expect(resolveAiChatUploadMime("archive.zip", "application/zip")).toBe(
			null,
		);
	});

	it("resolves an unknown declared MIME by extension", () => {
		expect(
			resolveAiChatUploadMime("notes.pdf", "application/octet-stream"),
		).toBe("application/pdf");
	});

	it("fails closed against an empty allowlist env", () => {
		process.env.FABRIC_AI_CHAT_MIME_ALLOWLIST = "";
		expect(resolveAiChatUploadMime("quarterly.xlsx", XLSX_MIME)).toBe(null);
	});
});
