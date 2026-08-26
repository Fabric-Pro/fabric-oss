/**
 * The resolver is the only sanctioned path from an attachment's bytes to prompt
 * text, so these tests are mostly about what it REFUSES to deliver: protected
 * assets, deleted rows, and formats whose text nobody extracted.
 *
 * The failure-path cases matter as much as the happy one. A ticket-level AI run
 * that dies because one attached PDF was malformed is a worse product than one
 * that quietly proceeds without it, and that posture is only real if it is
 * asserted.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	db: {
		storyAttachment: { findMany: vi.fn(), update: vi.fn() },
	},
}));
vi.mock("@repo/config", () => ({
	config: {
		storage: { bucketNames: { projectContexts: "project-contexts" } },
	},
}));
vi.mock("@repo/storage", () => ({ downloadFile: vi.fn() }));
vi.mock("@repo/rag", () => ({
	extractionFactory: { extract: vi.fn() },
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { db } from "@repo/database";
import { extractionFactory } from "@repo/rag";
import { downloadFile } from "@repo/storage";
import { resolveStoryAttachmentAiContexts } from "../story-attachment-ai-context";

const findMany = db.storyAttachment.findMany as unknown as ReturnType<
	typeof vi.fn
>;
const update = db.storyAttachment.update as unknown as ReturnType<typeof vi.fn>;
const download = downloadFile as unknown as ReturnType<typeof vi.fn>;
const extract = extractionFactory.extract as unknown as ReturnType<
	typeof vi.fn
>;

const tenant = { userId: "u1", organizationId: null };

function row(overrides: Record<string, unknown> = {}) {
	return {
		id: "a1",
		filename: "spec.md",
		mimeType: "text/markdown",
		storageKey: "story-attachments/p1/s1/a1.md",
		extractedText: null,
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	download.mockResolvedValue({ data: Buffer.from("raw") });
	extract.mockResolvedValue({ text: "extracted body", metadata: {} });
	update.mockResolvedValue({});
});

describe("resolveStoryAttachmentAiContexts", () => {
	it("returns one envelope entry carrying the file's text", async () => {
		findMany.mockResolvedValue([row()]);

		const entries = await resolveStoryAttachmentAiContexts("s1", tenant);

		expect(entries).toHaveLength(1);
		expect(entries[0]).toContain("extracted body");
		expect(entries[0]).toContain("spec.md");
	});

	it("queries only live, UNLOCKED rows", async () => {
		// The designation and soft-delete gates are applied in the query rather
		// than in memory, so this assertion is what proves a LOCKED row is never
		// even loaded — see AE1/AE4.
		findMany.mockResolvedValue([]);

		await resolveStoryAttachmentAiContexts("s1", tenant);

		expect(findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					storyId: "s1",
					deletedAt: null,
					designation: "UNLOCKED",
				},
			}),
		);
	});

	it("drops an attachment whose type carries no extractable text", async () => {
		findMany.mockResolvedValue([
			row({ id: "img", filename: "shot.png", mimeType: "image/png" }),
		]);

		expect(await resolveStoryAttachmentAiContexts("s1", tenant)).toEqual(
			[],
		);
		expect(download).not.toHaveBeenCalled();
	});

	it("extracts a .xlsx now that spreadsheets reach ticket AI context", async () => {
		// Once deferred; that decision was reversed. The workbook is eligible,
		// so it is downloaded, extracted, and its text reaches the prompt entry.
		findMany.mockResolvedValue([
			row({
				id: "sheet",
				filename: "budget.xlsx",
				mimeType:
					"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			}),
		]);
		extract.mockResolvedValue({ text: "Sheet1\nA1\tB1", metadata: {} });

		const entries = await resolveStoryAttachmentAiContexts("s1", tenant);

		expect(entries).toHaveLength(1);
		expect(entries[0]).toContain("budget.xlsx");
		expect(entries[0]).toContain("A1");
		expect(download).toHaveBeenCalledTimes(1);
	});

	it("passes the workbook walk caps so a large sheet stays bounded", async () => {
		// `local-xlsx` is the one accepted format that reads the extractor
		// options. Passing only the budget would let a huge sheet walk under the
		// compiled defaults instead of the operator's configured caps.
		findMany.mockResolvedValue([
			row({
				id: "sheet",
				filename: "budget.xlsx",
				mimeType:
					"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			}),
		]);

		await resolveStoryAttachmentAiContexts("s1", tenant);

		const opts = extract.mock.calls[0]?.[3]?.extractionOptions ?? {};
		expect(opts.maxSheets).toBeGreaterThan(0);
		expect(opts.maxRows).toBeGreaterThan(0);
		expect(opts.maxCells).toBeGreaterThan(0);
	});

	it("still drops legacy .xls — never extractable", async () => {
		findMany.mockResolvedValue([
			row({
				id: "legacy",
				filename: "budget.xls",
				mimeType: "application/vnd.ms-excel",
			}),
		]);

		expect(await resolveStoryAttachmentAiContexts("s1", tenant)).toEqual(
			[],
		);
		expect(download).not.toHaveBeenCalled();
	});

	it("reuses cached text without re-extracting", async () => {
		findMany.mockResolvedValue([row({ extractedText: "cached body" })]);

		const entries = await resolveStoryAttachmentAiContexts("s1", tenant);

		expect(entries[0]).toContain("cached body");
		expect(download).not.toHaveBeenCalled();
		expect(extract).not.toHaveBeenCalled();
		expect(update).not.toHaveBeenCalled();
	});

	it("extracts once on a miss and persists the result", async () => {
		findMany.mockResolvedValue([row()]);

		await resolveStoryAttachmentAiContexts("s1", tenant);

		expect(extract).toHaveBeenCalledTimes(1);
		expect(update).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "a1" },
				data: expect.objectContaining({
					extractedText: "extracted body",
				}),
			}),
		);
	});

	it("truncates an oversized extraction instead of caching it whole", async () => {
		// Asserts the budget is HONOURED, not merely passed. The earlier version
		// of this test checked `extractionOptions.extractedTextBudgetChars > 0`
		// — which passed while the budget did nothing, because none of the
		// formats this resolver accepts (txt/md/csv/pdf/docx) read that option.
		// Only the workbook extractor does, and workbooks are excluded.
		//
		// The failure it was hiding: a 300 KB transcript cached whole, then got
		// dropped entirely by the story budget on every run — named in the
		// omission notice and never read, permanently.
		extract.mockResolvedValue({
			text: "y".repeat(300_000),
			metadata: {},
		});
		findMany.mockResolvedValue([row()]);

		const entries = await resolveStoryAttachmentAiContexts("s1", tenant);

		expect(entries).toHaveLength(1);
		expect(entries[0].length).toBeLessThan(150_000);
	});

	it("caches the truncated text, not the original", async () => {
		// If the whole text were cached, every later run would re-apply the
		// story budget to an oversized string and drop the file again.
		extract.mockResolvedValue({ text: "y".repeat(300_000), metadata: {} });
		findMany.mockResolvedValue([row()]);

		await resolveStoryAttachmentAiContexts("s1", tenant);

		const cached = update.mock.calls[0]?.[0]?.data?.extractedText as string;
		expect(cached.length).toBeLessThan(150_000);
	});

	it("marks an oversized extraction so it can be re-extracted later", async () => {
		// This is what makes the re-extraction path above reachable at all.
		extract.mockResolvedValue({ text: "y".repeat(300_000), metadata: {} });
		findMany.mockResolvedValue([row()]);

		const entries = await resolveStoryAttachmentAiContexts("s1", tenant);

		expect(entries[0]).toMatch(/truncated/i);
	});

	it("delivers a large file rather than dropping it", async () => {
		// The regression in plain terms: raw transcripts are the motivating use
		// case and are exactly the size that used to be omitted entirely.
		extract.mockResolvedValue({ text: "y".repeat(300_000), metadata: {} });
		findMany.mockResolvedValue([
			row({ filename: "standup-transcript.md" }),
		]);

		const joined = (
			await resolveStoryAttachmentAiContexts("s1", tenant)
		).join("");

		expect(joined).toContain("standup-transcript.md");
		expect(joined).not.toMatch(/were NOT included/i);
	});

	it("keeps the extractor's truncation marker in the delivered text", async () => {
		// The extractor names the omission inside the text it returns. The
		// resolver must not strip or reformat that — a truncated file the model
		// believes is complete is worse than no file.
		extract.mockResolvedValue({
			text: "body...\n[truncated: 400 of 900 lines omitted]",
			metadata: { truncated: true },
		});
		findMany.mockResolvedValue([row()]);

		const entries = await resolveStoryAttachmentAiContexts("s1", tenant);

		expect(entries[0]).toContain("400 of 900 lines omitted");
	});

	it("skips one failed extraction and still returns the others", async () => {
		findMany.mockResolvedValue([
			row({
				id: "bad",
				filename: "broken.pdf",
				mimeType: "application/pdf",
			}),
			row({ id: "good", filename: "notes.md" }),
		]);
		extract
			.mockRejectedValueOnce(new Error("parse blew up"))
			.mockResolvedValueOnce({ text: "good body", metadata: {} });

		const entries = await resolveStoryAttachmentAiContexts("s1", tenant);

		expect(entries).toHaveLength(1);
		expect(entries[0]).toContain("good body");
	});

	it("skips an attachment whose object is missing from storage", async () => {
		findMany.mockResolvedValue([row()]);
		download.mockRejectedValue(new Error("NoSuchKey"));

		await expect(
			resolveStoryAttachmentAiContexts("s1", tenant),
		).resolves.toEqual([]);
	});

	it("does not cache an empty extraction", async () => {
		// Leaving the column null lets a later run retry — caching "" would
		// permanently mark the file as read-and-empty.
		findMany.mockResolvedValue([row()]);
		extract.mockResolvedValue({ text: "   ", metadata: {} });

		expect(await resolveStoryAttachmentAiContexts("s1", tenant)).toEqual(
			[],
		);
		expect(update).not.toHaveBeenCalled();
	});

	it("re-extracts a cached copy that was truncated under a smaller budget", async () => {
		// The budget is operator-tunable and files are immutable, so nothing
		// else would ever invalidate this cache. Without the check, raising
		// FABRIC_AI_CHAT_EXTRACTED_TEXT_BUDGET_CHARS silently does nothing for
		// every file already extracted — the old fragment is served forever.
		findMany.mockResolvedValue([
			row({
				extractedText:
					"short body\n\n[Document truncated — 900 of 1,000 characters omitted]",
			}),
		]);

		await resolveStoryAttachmentAiContexts("s1", tenant);

		expect(extract).toHaveBeenCalledTimes(1);
	});

	it("does not re-extract a truncated copy that still fills the budget", async () => {
		// Truncated but already at the ceiling — a round trip would return the
		// same length and buy nothing.
		findMany.mockResolvedValue([
			row({
				extractedText: `${"x".repeat(120_000)}\n\n[Document truncated — 900 of 1,000 characters omitted]`,
			}),
		]);

		await resolveStoryAttachmentAiContexts("s1", tenant);

		expect(extract).not.toHaveBeenCalled();
	});

	it("does not re-extract an untruncated cached copy", async () => {
		findMany.mockResolvedValue([row({ extractedText: "complete body" })]);

		await resolveStoryAttachmentAiContexts("s1", tenant);

		expect(extract).not.toHaveBeenCalled();
	});

	it("bounds the TOTAL text across attachments, not just each file", async () => {
		// A work item accepts 20 attachments. Per-file bounding alone would let
		// 20x the budget into one prompt — and unlike the chat path, this text
		// is persistent: it rides along on every maturation run and every
		// assistant message, not one pasted turn.
		const huge = "x".repeat(80_000);
		findMany.mockResolvedValue([
			row({ id: "a", filename: "one.md", extractedText: huge }),
			row({ id: "b", filename: "two.md", extractedText: huge }),
			row({ id: "c", filename: "three.md", extractedText: huge }),
		]);

		const entries = await resolveStoryAttachmentAiContexts("s1", tenant);
		const total = entries.join("").length;

		// Default budget is 100k chars; three 80k files must not all fit.
		expect(total).toBeLessThan(200_000);
		expect(entries.length).toBeLessThan(4);
	});

	it("names the attachments it dropped rather than omitting them silently", async () => {
		// Same disclosure principle as a truncation marker: a model handed 1 of
		// 3 attachments will answer as though it saw all 3.
		const huge = "x".repeat(80_000);
		findMany.mockResolvedValue([
			row({ id: "a", filename: "kept.md", extractedText: huge }),
			row({ id: "b", filename: "dropped.md", extractedText: huge }),
		]);

		const joined = (
			await resolveStoryAttachmentAiContexts("s1", tenant)
		).join("");

		expect(joined).toContain("dropped.md");
		expect(joined).toMatch(/not included|exceeded/i);
	});

	it("adds no omission notice when everything fits", async () => {
		findMany.mockResolvedValue([row({ extractedText: "short" })]);

		const entries = await resolveStoryAttachmentAiContexts("s1", tenant);

		expect(entries).toHaveLength(1);
		expect(entries.join("")).not.toMatch(/not included|exceeded/i);
	});

	it("returns an empty list for a story with no attachments", async () => {
		findMany.mockResolvedValue([]);
		expect(await resolveStoryAttachmentAiContexts("s1", tenant)).toEqual(
			[],
		);
	});

	it("preserves upload order across multiple attachments", async () => {
		findMany.mockResolvedValue([
			row({
				id: "first",
				filename: "one.md",
				extractedText: "first body",
			}),
			row({
				id: "second",
				filename: "two.md",
				extractedText: "second body",
			}),
		]);

		const entries = await resolveStoryAttachmentAiContexts("s1", tenant);

		expect(entries[0]).toContain("first body");
		expect(entries[1]).toContain("second body");
		expect(findMany).toHaveBeenCalledWith(
			expect.objectContaining({ orderBy: { createdAt: "asc" } }),
		);
	});
});
