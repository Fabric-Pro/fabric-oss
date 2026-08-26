/**
 * Local XLSX extractor using ExcelJS
 * Free, good-quality text extraction from modern Excel workbooks
 *
 * Two classes of bound live here and the difference between them is the point:
 *
 * - **Unconditional** — the inflation ceiling and the sheet/row/cell/deadline
 *   walk caps. A decompression bomb harms whoever parses it, so these apply to
 *   every caller, defaulted from the shared AI-chat vocabulary.
 * - **Opt-in** — the character budget. This extractor is ONE shared instance
 *   behind `extractionFactory`, reached by four Temporal ingestion activities
 *   besides the chat path, and project contexts already accept xlsx today. A
 *   chat-sized budget hardcoded here would silently truncate knowledge-base
 *   ingestion and embed a truncation marker as if it were document content. So
 *   the budget travels as a caller option and the extractor stays unbounded
 *   without one.
 *
 * See KTD5 (option vs. unconditional), KTD8 (why the buffered load stays), and
 * KTD9 (why the deadline is checked inside the walk) in
 * `docs/plans/2026-07-16-001-feat-excel-chat-attachments-plan.md`.
 */

import { logger } from "@repo/logs";
import {
	DEFAULT_AI_CHAT_EXTRACTION_DEADLINE_MS,
	DEFAULT_AI_CHAT_MAX_CELLS,
	DEFAULT_AI_CHAT_MAX_INFLATED_BYTES,
	DEFAULT_AI_CHAT_MAX_ROWS,
	DEFAULT_AI_CHAT_MAX_SHEETS,
} from "@repo/utils/ai-chat-attachment";
import JSZip from "jszip";
import type { ExtractionResult, IDocumentExtractor } from "../types";
import { XlsxInflationCeilingError } from "../types";

// Use inline type instead of `import type` from exceljs — even type-only
// imports of exceljs cause Turbopack to attempt module resolution. jszip needs
// no such escape hatch: it is pure JS with a browser build, so it imports
// statically, exactly as `mammoth` and `pdf-parse` already do in the siblings.
type CellValue = null | number | string | boolean | Date | object;

/** What stopped the walk early. `null` means it ran to completion. */
type TruncationReason = "sheets" | "rows" | "cells" | "deadline" | "budget";

/** A sheet the walk actually opened, and how it presents in Excel. */
interface SheetReport {
	name: string;
	/** `visible` | `hidden` | `veryHidden` — R10 surfaces this to the user. */
	state: string;
	hidden: boolean;
	rowsRead: number;
}

interface ExtractionBounds {
	maxInflatedBytes: number;
	maxSheets: number;
	maxRows: number;
	maxCells: number;
	deadlineMs: number;
	/** Chat-only. `undefined` leaves the text unbounded — the default. */
	budgetChars: number | undefined;
	/**
	 * Clock the walk measures its deadline against. Production never passes one.
	 *
	 * It exists because the deadline is the one bound that cannot be tested
	 * against the real clock without racing it: forcing it means a deadline of a
	 * millisecond or two, and nothing guarantees the process is not descheduled
	 * between the walk's start and its first row — on a loaded CI runner it is,
	 * and the walk correctly returns zero rows for a deadline that had already
	 * passed. That is right in production and useless in a fixture, so the test
	 * drives time instead of hoping to outrun it.
	 */
	now: () => number;
}

function positiveIntOption(
	options: Record<string, unknown> | undefined,
	key: string,
): number | undefined {
	const raw = options?.[key];
	if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
		return undefined;
	}
	return Math.floor(raw);
}

function clockOption(
	options: Record<string, unknown> | undefined,
): () => number {
	const raw = options?.now;
	return typeof raw === "function" ? (raw as () => number) : Date.now;
}

/**
 * Resolve the bounds for one call. The resource bounds fall back to the shared
 * defaults so an unconfigured caller is still protected; the budget has no
 * fallback on purpose — absent means unbounded (KTD5).
 */
function resolveBounds(
	options: Record<string, unknown> | undefined,
): ExtractionBounds {
	return {
		maxInflatedBytes:
			positiveIntOption(options, "maxInflatedBytes") ??
			DEFAULT_AI_CHAT_MAX_INFLATED_BYTES,
		maxSheets:
			positiveIntOption(options, "maxSheets") ??
			DEFAULT_AI_CHAT_MAX_SHEETS,
		maxRows:
			positiveIntOption(options, "maxRows") ?? DEFAULT_AI_CHAT_MAX_ROWS,
		maxCells:
			positiveIntOption(options, "maxCells") ?? DEFAULT_AI_CHAT_MAX_CELLS,
		deadlineMs:
			positiveIntOption(options, "extractionDeadlineMs") ??
			DEFAULT_AI_CHAT_EXTRACTION_DEADLINE_MS,
		budgetChars: positiveIntOption(options, "extractedTextBudgetChars"),
		now: clockOption(options),
	};
}

function cellToText(value: CellValue): string {
	if (value === null || value === undefined) {
		return "";
	}
	if (typeof value === "string") {
		return value;
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	if (value instanceof Date) {
		return value.toISOString();
	}
	if (typeof value === "object") {
		const v = value as unknown as Record<string, unknown>;
		if (Array.isArray(v.richText)) {
			return (v.richText as Array<{ text?: string }>)
				.map((rt) => rt.text ?? "")
				.join("");
		}
		if ("formula" in v || "sharedFormula" in v) {
			return cellToText((v.result as CellValue) ?? null);
		}
		if ("hyperlink" in v) {
			return String(v.text ?? v.hyperlink ?? "");
		}
		if ("text" in v) {
			return String(v.text ?? "");
		}
		if ("error" in v) {
			return "";
		}
	}
	return "";
}

/**
 * Sum of the uncompressed sizes the archive *claims* in its central directory.
 * Returns null when any entry's claim is unreadable.
 *
 * This is a cheap early reject and NEVER the control: the field is written by
 * whoever built the archive, which in this threat model is the attacker, and
 * jszip reads it verbatim. A bomb that understates its size sails straight past
 * this — the measured pass in `assertInflatesUnderCeiling` is what actually
 * stops it (R14, AE8).
 */
function declaredUncompressedBytes(zip: JSZip): number | null {
	let total = 0;
	for (const entry of Object.values(zip.files)) {
		if (entry.dir) {
			continue;
		}
		// `_data.uncompressedSize` is jszip-private — its own typings keep the
		// CompressedObject interface commented out. Read it defensively so a
		// shape change degrades to "measure it" rather than throwing.
		const declared = (
			entry as unknown as { _data?: { uncompressedSize?: unknown } }
		)._data?.uncompressedSize;
		if (
			typeof declared !== "number" ||
			!Number.isFinite(declared) ||
			declared < 0
		) {
			return null;
		}
		total += declared;
	}
	return total;
}

/**
 * Inflate one entry through a byte counter, discarding the bytes, and abort the
 * moment it passes `remaining`.
 *
 * `nodeStream` is jszip's public, typed streaming read and it honours
 * backpressure, so `destroy()` stops pako mid-entry — a 200 MB bomb entry
 * surrenders after ~`remaining` bytes rather than materializing. The bytes are
 * counted and dropped, never accumulated, so this pass costs no memory.
 */
function countEntryInflatedBytes(
	entry: JSZip.JSZipObject,
	remaining: number,
): Promise<{ bytes: number; exceeded: boolean }> {
	return new Promise((resolve, reject) => {
		let bytes = 0;
		let settled = false;
		// jszip types nodeStream as the minimal NodeJS.ReadableStream, which
		// omits `destroy`. The runtime object is a readable-stream Readable and
		// does have it — and destroy is the entire abort mechanism here, so the
		// cast names that one dependency rather than widening to Readable.
		const stream = entry.nodeStream(
			"nodebuffer",
		) as NodeJS.ReadableStream & {
			destroy(): void;
		};
		stream.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > remaining && !settled) {
				settled = true;
				stream.destroy();
				resolve({ bytes, exceeded: true });
			}
		});
		stream.on("end", () => {
			if (settled) {
				return;
			}
			settled = true;
			resolve({ bytes, exceeded: false });
		});
		stream.on("error", (error: Error) => {
			// Our own destroy() surfaces here after we have already resolved.
			if (settled) {
				return;
			}
			settled = true;
			reject(error);
		});
	});
}

/**
 * Refuse an archive that inflates past the ceiling, measuring rather than
 * trusting the declaration (R14). Only a cleared archive reaches
 * `workbook.xlsx.load()`, which per KTD8 is the only usable exceljs read API and
 * takes no abort signal — so this ceiling is the memory bound, not a redundant
 * early-out in front of a streaming reader.
 */
async function assertInflatesUnderCeiling(
	buffer: Buffer,
	ceiling: number,
): Promise<number> {
	// loadAsync parses the central directory only — it does not inflate.
	const zip = await JSZip.loadAsync(buffer);

	const declared = declaredUncompressedBytes(zip);
	if (declared !== null && declared > ceiling) {
		throw new XlsxInflationCeilingError({
			ceilingBytes: ceiling,
			observedBytes: declared,
			refusedBeforeInflating: true,
		});
	}

	let total = 0;
	for (const entry of Object.values(zip.files)) {
		if (entry.dir) {
			continue;
		}
		const { bytes, exceeded } = await countEntryInflatedBytes(
			entry,
			ceiling - total,
		);
		total += bytes;
		if (exceeded || total > ceiling) {
			throw new XlsxInflationCeilingError({
				ceilingBytes: ceiling,
				observedBytes: total,
				refusedBeforeInflating: false,
			});
		}
	}
	return total;
}

interface WalkOutcome {
	text: string;
	sheets: SheetReport[];
	rowCount: number;
	cellCount: number;
	truncated: boolean;
	truncationReason: TruncationReason | null;
	omittedRowCount: number;
	truncatedSheetNames: string[];
}

/**
 * Count rows the walk never reached, and name the sheets they sit on.
 *
 * Read from the loaded workbook rather than tracked during the walk: once the
 * walk has stopped it is not going to visit the rest, so the totals exceljs
 * already holds are both cheaper and more honest than a running estimate.
 */
function summarizeOmissions(
	// biome-ignore lint/suspicious/noExplicitAny: runtime-only require, no types available
	workbook: any,
	sheets: SheetReport[],
): { omittedRowCount: number; truncatedSheetNames: string[] } {
	const rowsReadByName = new Map(sheets.map((s) => [s.name, s.rowsRead]));
	let omittedRowCount = 0;
	const truncatedSheetNames: string[] = [];

	// biome-ignore lint/suspicious/noExplicitAny: runtime-only require, no types available
	for (const worksheet of workbook.worksheets as any[]) {
		const total = worksheet.actualRowCount ?? worksheet.rowCount ?? 0;
		const read = rowsReadByName.get(worksheet.name) ?? 0;
		const omitted = Math.max(0, total - read);
		if (omitted > 0) {
			omittedRowCount += omitted;
			truncatedSheetNames.push(worksheet.name);
		}
	}

	return { omittedRowCount, truncatedSheetNames };
}

/**
 * Walk every sheet — including hidden and `veryHidden` ones (R5) — under the
 * resource caps, the in-loop deadline, and (when supplied) the character budget.
 *
 * Every bound truncates rather than throws (R15): hitting one must leave the
 * caller with the same shape it would have got from a small workbook, plus the
 * facts about what was cut.
 */
function walkWorkbook(
	// biome-ignore lint/suspicious/noExplicitAny: runtime-only require, no types available
	workbook: any,
	bounds: ExtractionBounds,
): WalkOutcome {
	const { maxSheets, maxRows, maxCells, deadlineMs, budgetChars, now } =
		bounds;
	// The deadline runs from the start of the walk. The load phase ahead of it
	// takes no abort signal (KTD9), so the inflation ceiling — not a clock — is
	// what bounds that phase; this deadline owns the walk.
	const walkStartedAt = now();

	const sections: string[] = [];
	const sheets: SheetReport[] = [];
	let rowCount = 0;
	let cellCount = 0;
	let charCount = 0;
	let truncationReason: TruncationReason | null = null;

	const stop = (reason: TruncationReason): void => {
		// First bound to bite owns the reason; later ones are consequences.
		truncationReason ??= reason;
	};
	const stopped = (): boolean => truncationReason !== null;

	// eachSheet/eachRow/eachCell are synchronous forEach-style loops with no
	// break, so every one of them gates on the flag instead (KTD9).
	// biome-ignore lint/suspicious/noExplicitAny: runtime-only require, no types available
	workbook.eachSheet((worksheet: any) => {
		if (stopped()) {
			return;
		}
		if (sheets.length >= maxSheets) {
			stop("sheets");
			return;
		}

		const state: string = worksheet.state ?? "visible";
		const report: SheetReport = {
			name: worksheet.name,
			state,
			hidden: state !== "visible",
			rowsRead: 0,
		};
		sheets.push(report);

		const header = `=== Sheet: ${worksheet.name} ===`;
		const lines: string[] = [header];
		// Tracks this section's exact contribution to `text`, separator
		// included, so the budget check below measures the real string rather
		// than an estimate that drifts by two chars per sheet.
		let pendingChars = header.length + (sections.length > 0 ? 2 : 0);

		// biome-ignore lint/suspicious/noExplicitAny: runtime-only require, no types available
		worksheet.eachRow({ includeEmpty: false }, (row: any) => {
			if (stopped()) {
				return;
			}
			if (now() - walkStartedAt >= deadlineMs) {
				stop("deadline");
				return;
			}
			if (rowCount >= maxRows) {
				stop("rows");
				return;
			}
			if (cellCount >= maxCells) {
				stop("cells");
				return;
			}

			const values: string[] = [];
			// biome-ignore lint/suspicious/noExplicitAny: runtime-only require, no types available
			row.eachCell((cell: any, colNumber: number) => {
				if (cellCount >= maxCells) {
					stop("cells");
					return;
				}
				values[colNumber - 1] = cellToText(cell.value).trim();
				cellCount++;
			});

			if (values.length === 0) {
				return;
			}

			const line = values.join("\t");
			if (
				budgetChars !== undefined &&
				charCount + pendingChars + line.length + 1 > budgetChars
			) {
				// Cut on a row boundary rather than mid-row: half a row of
				// tab-separated values reads as data, and would be wrong data.
				stop("budget");
				return;
			}

			lines.push(line);
			pendingChars += line.length + 1;
			report.rowsRead++;
			rowCount++;
		});

		// A sheet with no rows contributes no section — matching the extractor's
		// long-standing output — but it stays in `sheets`: it was read, and
		// `sheetCount` has always counted it. R10 wants it named too.
		if (lines.length > 1) {
			sections.push(lines.join("\n"));
			charCount += pendingChars;
		}
	});

	const text = sections.join("\n\n");
	const truncated = truncationReason !== null;
	const { omittedRowCount, truncatedSheetNames } = truncated
		? summarizeOmissions(workbook, sheets)
		: { omittedRowCount: 0, truncatedSheetNames: [] };

	return {
		text,
		sheets,
		rowCount,
		cellCount,
		truncated,
		truncationReason,
		omittedRowCount,
		truncatedSheetNames,
	};
}

/**
 * Name what was dropped, in the text itself.
 *
 * The marker belongs in `text` because that is the only channel the model reads
 * — metadata reaches the UI, not the prompt. Without it the model treats a cut
 * workbook as a complete one and reports an omitted row as absent from the data
 * rather than as unread (R7, AE2). Shape follows the existing precedent in
 * `lib/chunking/contextual-enrichment.ts`.
 */
function buildTruncationMarker(outcome: WalkOutcome): string {
	const parts = [
		`${outcome.omittedRowCount} row${outcome.omittedRowCount === 1 ? "" : "s"} omitted`,
	];
	if (outcome.truncatedSheetNames.length > 0) {
		parts.push(
			`sheets not fully read: ${outcome.truncatedSheetNames.join(", ")}`,
		);
	}
	return `\n\n[Spreadsheet truncated — ${parts.join("; ")}]`;
}

export class LocalXlsxExtractor implements IDocumentExtractor {
	name = "local-xlsx";
	supportedMimeTypes = [
		"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	];

	async extract(
		buffer: Buffer,
		filename: string,
		options?: Record<string, unknown>,
	): Promise<ExtractionResult> {
		const startTime = Date.now();
		const bounds = resolveBounds(options);
		logger.info(`[LocalXlsxExtractor] Extracting text from ${filename}`);

		try {
			// Measured ceiling first: nothing past this line is safe to run on
			// an archive that inflates without bound, least of all a buffered
			// load that takes no abort signal.
			const inflatedBytes = await assertInflatesUnderCeiling(
				buffer,
				bounds.maxInflatedBytes,
			);

			// Runtime require — Turbopack cannot resolve exceljs at build time
			// (it's a Node-native package). require() is invisible to Turbopack's
			// static analysis, unlike import/import().
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			// biome-ignore lint/suspicious/noExplicitAny: runtime-only require, no types available
			const ExcelJS = require("exceljs") as any;
			const workbook = new ExcelJS.Workbook();
			// ExcelJS typings predate the @types/node generic `Buffer<T>` change.
			// The runtime value is compatible; the cast bridges the type gap.
			// biome-ignore lint/suspicious/noExplicitAny: known exceljs/@types/node type drift
			await workbook.xlsx.load(buffer as any);

			const outcome = walkWorkbook(workbook, bounds);
			const text = outcome.truncated
				? `${outcome.text}${buildTruncationMarker(outcome)}`
				: outcome.text;

			const extractionTime = Date.now() - startTime;
			logger.info(
				`[LocalXlsxExtractor] Extracted ${text.length} characters from ${outcome.sheets.length} sheet(s), ${outcome.rowCount} row(s) in ${extractionTime}ms`,
				outcome.truncated
					? {
							truncated: true,
							truncationReason: outcome.truncationReason,
							omittedRowCount: outcome.omittedRowCount,
						}
					: undefined,
			);

			return {
				text,
				extractorUsed: this.name,
				extractionTime,
				cost: 0,
				pageCount: undefined,
				hasTables: false,
				hasImages: false,
				metadata: {
					sheetCount: outcome.sheets.length,
					rowCount: outcome.rowCount,
					cellCount: outcome.cellCount,
					inflatedBytes,
					// R5/R10: every sheet the walk read, with its hidden state,
					// so the user can see what they are about to share. U6 reads
					// these; nothing here decides how they are presented.
					sheets: outcome.sheets.map((sheet) => ({
						name: sheet.name,
						state: sheet.state,
						hidden: sheet.hidden,
						rowsRead: sheet.rowsRead,
					})),
					truncated: outcome.truncated,
					truncationReason: outcome.truncationReason ?? undefined,
					omittedRowCount: outcome.omittedRowCount,
					truncatedSheetNames: outcome.truncatedSheetNames,
				},
			};
		} catch (error) {
			logger.error(
				`[LocalXlsxExtractor] Failed to extract XLSX: ${error}`,
			);
			// A ceiling refusal is a verdict the upload surface reports to the
			// user; re-wrapping it in a generic Error would erase the class the
			// caller discriminates on and collapse it into "extraction failed".
			if (error instanceof XlsxInflationCeilingError) {
				throw error;
			}
			throw new Error(
				`XLSX extraction failed: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
	}

	async isAvailable(): Promise<boolean> {
		return true;
	}

	async estimateCost(_buffer: Buffer): Promise<number> {
		return 0;
	}
}
