import { beforeEach, describe, expect, it, vi } from "vitest";
import { extractPdfPageTexts } from "../pdf-page-texts";

/**
 * pdf-parse is replaced by a stand-in that calls `pagerender` the way the
 * real one does, once per page with a pdf.js page proxy, so the test needs
 * no binary fixture.
 */
const parsed = vi.hoisted(() => ({
	pages: [] as { str: string; y: number }[][],
	calls: [] as unknown[],
}));

vi.mock("pdf-parse", () => ({
	default: async (
		_data: Buffer,
		options: {
			pagerender: (pageData: unknown) => Promise<string>;
		},
	) => {
		parsed.calls.push(options);
		// Rendered out of order, as nothing guarantees the order.
		const order = parsed.pages.map((_, index) => index).reverse();
		for (const pageIndex of order) {
			await options.pagerender({
				pageIndex,
				getTextContent: async () => ({
					items: parsed.pages[pageIndex]?.map((item) => ({
						str: item.str,
						transform: [1, 0, 0, 1, 72, item.y],
					})),
				}),
			});
		}
		return { numpages: parsed.pages.length };
	},
}));

describe("extractPdfPageTexts", () => {
	beforeEach(() => {
		parsed.pages = [];
		parsed.calls = [];
	});

	it("returns each page's text by page index, whatever order pages render in", async () => {
		parsed.pages = [
			[{ str: "Example Proposal", y: 700 }],
			[
				{ str: "Contents", y: 700 },
				{ str: "Approach", y: 680 },
			],
			[
				{ str: "PAEXPORTH2N1E", y: 690 },
				{ str: "Approach ", y: 700 },
				{ str: "body", y: 700 },
			],
			[],
		];
		const result = await extractPdfPageTexts(Buffer.from("%PDF-1.4"));
		expect(result.pageCount).toBe(4);
		expect(result.pages).toEqual([
			"Example Proposal",
			"Contents\nApproach",
			"PAEXPORTH2N1E\nApproach body",
			"",
		]);
	});

	it("always passes an options object with its own page renderer", async () => {
		parsed.pages = [[{ str: "One", y: 1 }]];
		await extractPdfPageTexts(Buffer.from("%PDF-1.4"));
		expect(parsed.calls).toHaveLength(1);
		expect(parsed.calls[0]).toEqual(
			expect.objectContaining({ pagerender: expect.any(Function) }),
		);
	});

	it("fills a page pdf-parse never rendered with an empty string", async () => {
		parsed.pages = [[{ str: "Only", y: 1 }]];
		const result = await extractPdfPageTexts(Buffer.from("%PDF-1.4"));
		expect(result.pages).toEqual(["Only"]);
	});
});
