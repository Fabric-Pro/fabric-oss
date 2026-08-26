/**
 * Bounded-extraction coverage for `LocalXlsxExtractor` (U5: R5, R6, R7, R14, R15).
 *
 * The first test is the load-bearing one. This extractor is a single shared
 * instance behind `extractionFactory`, reached by four Temporal ingestion
 * activities besides the inline chat path, and project contexts already accept
 * xlsx today. If a chat-sized character budget were ever hardcoded here, those
 * callers would start ingesting truncated knowledge-base documents with a
 * truncation marker embedded as though it were content — silently. So
 * "no options means unbounded" is pinned before anything else (KTD5).
 */

import { DEFAULT_AI_CHAT_EXTRACTED_TEXT_BUDGET_CHARS } from "@repo/utils/ai-chat-attachment";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { LocalXlsxExtractor } from "../local-xlsx";

const TRUNCATION_MARKER = "[Spreadsheet truncated";

/** Zip header signatures and the offset of the uncompressed-size field in each. */
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_UNCOMPRESSED_SIZE_OFFSET = 22;
const CENTRAL_HEADER_UNCOMPRESSED_SIZE_OFFSET = 24;

interface SheetSpec {
	name: string;
	rows: Array<Array<string | number>>;
	state?: "visible" | "hidden" | "veryHidden";
}

async function buildWorkbook(sheets: SheetSpec[]): Promise<Buffer> {
	const workbook = new ExcelJS.Workbook();
	for (const spec of sheets) {
		const worksheet = workbook.addWorksheet(
			spec.name,
			spec.state ? { state: spec.state } : undefined,
		);
		for (const row of spec.rows) {
			worksheet.addRow(row);
		}
	}
	return Buffer.from(await workbook.xlsx.writeBuffer());
}

function rows(count: number, prefix = "row"): Array<Array<string | number>> {
	return Array.from({ length: count }, (_, i) => [
		`${prefix}-${i}`,
		i,
		`payload-${i}-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
	]);
}

/**
 * An archive holding one highly compressible entry — a decompression bomb in
 * miniature. It is not a valid workbook, and does not need to be: the inflation
 * ceiling is measured before exceljs is ever handed the buffer.
 */
async function buildInflatingArchive(
	uncompressedBytes: number,
): Promise<Buffer> {
	const zip = new JSZip();
	zip.file("xl/worksheets/sheet1.xml", Buffer.alloc(uncompressedBytes, 0x41));
	return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

/**
 * Rewrite the uncompressed-size field in every local and central header, so the
 * archive lies about how far it inflates.
 *
 * This is the AE8 fixture and it is built by hand on purpose: the central
 * directory is written by whoever built the archive — the attacker — and jszip
 * reports it verbatim. A fixture that only ever tells the truth would leave the
 * declared-size early-reject looking like a control when it is only a shortcut.
 */
function understateUncompressedSize(archive: Buffer, lie: number): Buffer {
	const patched = Buffer.from(archive);
	for (let i = 0; i <= patched.length - 4; i++) {
		const signature = patched.readUInt32LE(i);
		if (signature === LOCAL_FILE_HEADER_SIGNATURE) {
			patched.writeUInt32LE(
				lie,
				i + LOCAL_HEADER_UNCOMPRESSED_SIZE_OFFSET,
			);
		} else if (signature === CENTRAL_DIRECTORY_SIGNATURE) {
			patched.writeUInt32LE(
				lie,
				i + CENTRAL_HEADER_UNCOMPRESSED_SIZE_OFFSET,
			);
		}
	}
	return patched;
}

/** The text as the model would read it, minus the marker the bounds appended. */
function bodyBeforeMarker(text: string): string {
	const at = text.indexOf(TRUNCATION_MARKER);
	return at === -1 ? text : text.slice(0, at).trimEnd();
}

describe("LocalXlsxExtractor", () => {
	const extractor = new LocalXlsxExtractor();

	describe("the character budget is opt-in (R6, KTD5)", () => {
		it("returns the full text when the caller passes no budget, even past the chat budget", async () => {
			// Comfortably larger than the chat path's budget, so "unbounded"
			// is an observable claim rather than a workbook that happened to fit.
			const buffer = await buildWorkbook([
				{ name: "Data", rows: rows(4000) },
			]);

			const result = await extractor.extract(
				buffer,
				"knowledge-base.xlsx",
			);

			expect(result.text.length).toBeGreaterThan(
				DEFAULT_AI_CHAT_EXTRACTED_TEXT_BUDGET_CHARS,
			);
			expect(result.text).toContain("row-0");
			expect(result.text).toContain("row-3999");
			expect(result.text).not.toContain(TRUNCATION_MARKER);
			expect(result.metadata?.truncated).toBe(false);
			expect(result.metadata?.rowCount).toBe(4000);
		});

		it("stops at the budget and marks the text when the chat caller supplies one", async () => {
			const budget = 300;
			const buffer = await buildWorkbook([
				{ name: "Alpha", rows: rows(40, "alpha") },
				{ name: "Beta", rows: rows(40, "beta") },
			]);

			const result = await extractor.extract(buffer, "big.xlsx", {
				extractedTextBudgetChars: budget,
			});

			expect(bodyBeforeMarker(result.text).length).toBeLessThanOrEqual(
				budget,
			);
			expect(result.text).toContain(TRUNCATION_MARKER);
			expect(result.metadata?.truncated).toBe(true);
			expect(result.metadata?.truncationReason).toBe("budget");
		});

		it("names the omitted row count and the sheets that were cut", async () => {
			const buffer = await buildWorkbook([
				{ name: "Alpha", rows: rows(40, "alpha") },
				{ name: "Beta", rows: rows(40, "beta") },
			]);

			const result = await extractor.extract(buffer, "big.xlsx", {
				extractedTextBudgetChars: 300,
			});

			// The marker is the model's only signal that rows exist which it was
			// not shown — without it an omitted row reads as absent data (AE2).
			expect(result.text).toMatch(
				/\[Spreadsheet truncated — \d+ rows omitted/,
			);
			expect(result.text).toContain("sheets not fully read:");
			expect(result.text).toContain("Alpha");
			expect(result.text).toContain("Beta");
			expect(result.metadata?.omittedRowCount).toBeGreaterThan(0);
			expect(result.metadata?.truncatedSheetNames).toContain("Beta");
		});
	});

	describe("workbooks within every bound", () => {
		it("extracts fully, with no marker and no truncation flag", async () => {
			const buffer = await buildWorkbook([
				{ name: "Small", rows: rows(5) },
			]);

			const result = await extractor.extract(buffer, "small.xlsx", {
				extractedTextBudgetChars: 100_000,
			});

			expect(result.text).toContain("=== Sheet: Small ===");
			expect(result.text).toContain("row-4");
			expect(result.text).not.toContain(TRUNCATION_MARKER);
			expect(result.metadata?.truncated).toBe(false);
			expect(result.metadata?.truncationReason).toBeUndefined();
			expect(result.metadata?.rowCount).toBe(5);
		});

		it("covers AE1: yields content from all three sheets when under the budget", async () => {
			const buffer = await buildWorkbook([
				{ name: "First", rows: [["alpha-cell"]] },
				{ name: "Second", rows: [["beta-cell"]] },
				{ name: "Third", rows: [["gamma-cell"]] },
			]);

			const result = await extractor.extract(buffer, "three.xlsx", {
				extractedTextBudgetChars: 100_000,
			});

			expect(result.text).toContain("alpha-cell");
			expect(result.text).toContain("beta-cell");
			// The third sheet is the one AE1's prompt asks about.
			expect(result.text).toContain("gamma-cell");
			expect(result.metadata?.sheetCount).toBe(3);
			expect(result.metadata?.truncated).toBe(false);
		});

		it("returns empty text and no marker for an empty workbook", async () => {
			const buffer = await buildWorkbook([{ name: "Empty", rows: [] }]);

			const result = await extractor.extract(buffer, "empty.xlsx", {
				extractedTextBudgetChars: 100_000,
			});

			expect(result.text).toBe("");
			expect(result.text).not.toContain(TRUNCATION_MARKER);
			expect(result.metadata?.truncated).toBe(false);
			expect(result.metadata?.rowCount).toBe(0);
		});
	});

	describe("walk caps apply to every caller (R15)", () => {
		it("covers AE9: terminates at the cell cap and truncates rather than throwing", async () => {
			const buffer = await buildWorkbook([
				{ name: "Wide", rows: rows(10, "cell") },
			]);

			const result = await extractor.extract(buffer, "wide.xlsx", {
				maxCells: 6,
			});

			expect(result.metadata?.truncated).toBe(true);
			expect(result.metadata?.truncationReason).toBe("cells");
			expect(result.metadata?.cellCount).toBeLessThanOrEqual(6);
			expect(result.text).toContain("cell-0");
			expect(result.text).toContain(TRUNCATION_MARKER);
		});

		it("stops at the row cap", async () => {
			const buffer = await buildWorkbook([
				{ name: "Tall", rows: rows(50) },
			]);

			const result = await extractor.extract(buffer, "tall.xlsx", {
				maxRows: 4,
			});

			expect(result.metadata?.rowCount).toBe(4);
			expect(result.metadata?.truncationReason).toBe("rows");
			expect(result.text).toContain(TRUNCATION_MARKER);
		});

		it("stops at the sheet cap", async () => {
			const buffer = await buildWorkbook([
				{ name: "One", rows: [["a"]] },
				{ name: "Two", rows: [["b"]] },
				{ name: "Three", rows: [["c"]] },
			]);

			const result = await extractor.extract(buffer, "sheets.xlsx", {
				maxSheets: 2,
			});

			expect(result.metadata?.sheetCount).toBe(2);
			expect(result.metadata?.truncationReason).toBe("sheets");
			expect(result.text).not.toContain("=== Sheet: Three ===");
			expect(result.text).toContain(TRUNCATION_MARKER);
		});

		it("returns what it had plus a marker when the walk passes its deadline", async () => {
			// Driven through the real synchronous walk, not a mock: a
			// Promise.race/setTimeout wrapper could not fire here, because the
			// timer cannot be scheduled until the walk it is meant to interrupt
			// has already run to completion (KTD9). Only an elapsed-time check
			// inside the row callback can stop this, so only that passes.
			//
			// Time is injected rather than raced. Forcing the deadline against the
			// real clock means setting it to a millisecond or two, and nothing
			// stops the process being descheduled between the walk's start and its
			// first row — CI did exactly that, the walk correctly returned zero
			// rows for a deadline that had already passed, and the assertion below
			// failed. The behaviour was right; the fixture was hoping to outrun the
			// scheduler. A scripted clock removes the race without weakening what
			// is asserted, and still exercises the real in-loop check.
			const buffer = await buildWorkbook([
				{ name: "Enormous", rows: rows(40_000) },
			]);

			const DEADLINE_MS = 5_000;
			const ROWS_BEFORE_DEADLINE = 10;
			let reads = 0;
			// Call 1 is the walk's start stamp; the next N report no elapsed time,
			// so exactly N rows are read; everything after is past the deadline.
			const now = () => {
				const call = reads++;
				if (call === 0) {
					return 0;
				}
				return call <= ROWS_BEFORE_DEADLINE ? 0 : DEADLINE_MS;
			};

			const result = await extractor.extract(buffer, "enormous.xlsx", {
				extractionDeadlineMs: DEADLINE_MS,
				now,
				// Keep the other caps clear of the workbook so the deadline is
				// unambiguously what stopped it.
				maxRows: 1_000_000,
				maxCells: 10_000_000,
			});

			expect(result.metadata?.truncationReason).toBe("deadline");
			expect(result.metadata?.truncated).toBe(true);
			expect(result.text).toContain(TRUNCATION_MARKER);
			// "what it had" — a partial read, not an empty one and not the lot.
			expect(result.metadata?.rowCount).toBe(ROWS_BEFORE_DEADLINE);
		});

		it("uses the real clock when the caller injects none", async () => {
			// The seam above is test-only; production must not depend on it. A
			// deadline of 0 is rejected as a non-positive option, so this falls
			// back to the default and completes — proving `now` is optional.
			const buffer = await buildWorkbook([
				{ name: "Small", rows: rows(3) },
			]);

			const result = await extractor.extract(buffer, "small.xlsx", {});

			expect(result.metadata?.truncated).toBe(false);
			expect(result.metadata?.rowCount).toBe(3);
		});
	});

	describe("the inflation ceiling is measured, not declared (R14)", () => {
		it("covers AE8: aborts on an archive that understates its uncompressed size", async () => {
			const honest = await buildInflatingArchive(16 * 1024 * 1024);
			const liar = understateUncompressedSize(honest, 1024);

			// The lie lands: the declared total now sits far under the ceiling,
			// so the cheap early reject waves it through and only the measured
			// inflate can stop it. This is the whole reason the declared value
			// is not the control.
			const declared = await JSZip.loadAsync(liar);
			const entry = declared.file("xl/worksheets/sheet1.xml");
			expect(
				(entry as unknown as { _data: { uncompressedSize: number } })
					._data.uncompressedSize,
			).toBe(1024);

			await expect(
				extractor.extract(liar, "bomb.xlsx", {
					maxInflatedBytes: 64 * 1024,
				}),
			).rejects.toThrow(/inflating passed the/);
		});

		it("rejects an honestly declared over-ceiling archive without inflating it", async () => {
			const honest = await buildInflatingArchive(16 * 1024 * 1024);

			await expect(
				extractor.extract(honest, "big.xlsx", {
					maxInflatedBytes: 64 * 1024,
				}),
			).rejects.toThrow(/refused before inflating/);
		});

		it("lets a workbook under the ceiling through and reports its inflated size", async () => {
			const buffer = await buildWorkbook([
				{ name: "Fine", rows: rows(5) },
			]);

			const result = await extractor.extract(buffer, "fine.xlsx", {
				maxInflatedBytes: 100 * 1024 * 1024,
			});

			expect(result.text).toContain("row-0");
			expect(result.metadata?.inflatedBytes).toBeGreaterThan(0);
		});
	});

	describe("hidden sheets are read and disclosed (R5, R10)", () => {
		it("covers AE6: extracts hidden and veryHidden sheets and reports their state", async () => {
			const buffer = await buildWorkbook([
				{ name: "Shown", rows: [["visible-cell"]] },
				{ name: "Tucked", rows: [["hidden-cell"]], state: "hidden" },
				{
					name: "Buried",
					rows: [["very-hidden-cell"]],
					state: "veryHidden",
				},
			]);

			const result = await extractor.extract(buffer, "hidden.xlsx", {
				extractedTextBudgetChars: 100_000,
			});

			// R5: every sheet is parsed. A hidden sheet is not skipped — the
			// user is told about it instead (R10), which is what lets them learn
			// what they are about to share before sending.
			expect(result.text).toContain("visible-cell");
			expect(result.text).toContain("hidden-cell");
			expect(result.text).toContain("very-hidden-cell");

			expect(result.metadata?.sheets).toEqual([
				{ name: "Shown", state: "visible", hidden: false, rowsRead: 1 },
				{ name: "Tucked", state: "hidden", hidden: true, rowsRead: 1 },
				{
					name: "Buried",
					state: "veryHidden",
					hidden: true,
					rowsRead: 1,
				},
			]);
		});
	});
});
