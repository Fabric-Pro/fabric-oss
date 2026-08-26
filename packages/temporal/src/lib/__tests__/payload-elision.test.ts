/**
 * Unit tests for the payload elision helpers (Fizzy #1997).
 *
 * Run with:
 *   pnpm --filter @repo/temporal test src/lib/__tests__/payload-elision.test.ts
 */

import { describe, expect, it } from "vitest";
import {
	DESCRIPTION_CAP_LADDER,
	ELISION_MARKER,
	MCP_TOOL_RESULT_MAX_BYTES,
	type SlimmableWorkItem,
	slimWorkItemSummaries,
	truncateMcpTextOutput,
} from "../payload-elision";
import { measureSerializedBytes } from "../payload-size-guard";

function boardOf(
	cardCount: number,
	descriptionChars: number,
): Array<{
	id: string;
	title: string;
	description: string;
	state: string;
}> {
	return Array.from({ length: cardCount }, (_, i) => ({
		id: String(i),
		title: `Card ${i}`,
		description: "d".repeat(descriptionChars),
		state: "In Progress",
	}));
}

describe("slimWorkItemSummaries", () => {
	it("returns the input untouched when it already fits", () => {
		const items = boardOf(5, 100);
		const result = slimWorkItemSummaries(items, 1_000_000);
		expect(result.items).toBe(items);
		expect(result.fits).toBe(true);
		expect(result.elidedDescriptions).toBe(0);
		expect(result.droppedRaw).toBe(0);
	});

	it("shortens descriptions at a ladder cap until the payload fits", () => {
		const items = boardOf(600, 4000); // ~2.4MB of bodies
		const budget = measureSerializedBytes(items) / 10;

		const result = slimWorkItemSummaries(items, budget);

		expect(result.fits).toBe(true);
		expect(result.bytes).toBeLessThanOrEqual(budget);
		expect(result.elidedDescriptions).toBe(items.length);
		expect(result.droppedRaw).toBe(0);
		// Identity fields survive.
		expect(result.items[0].id).toBe("0");
		expect(result.items[0].title).toBe("Card 0");
		expect(result.items[0].state).toBe("In Progress");
		// Bodies are shortened, not fabricated.
		for (const item of result.items) {
			const body = item.description ?? "";
			expect(body.length).toBeLessThan(4000);
			expect(body).toContain(ELISION_MARKER.trim());
		}
	});

	it("falls back to stripping descriptions and raw payloads when no cap fits", () => {
		// Even 200-char bodies blow the budget → strip pass must run.
		const tinyBudget = 200;
		const items: Array<SlimmableWorkItem & { id: string }> = [
			{
				id: "a",
				description: "x".repeat(300),
				raw: { blob: "y".repeat(500) },
			},
			{ id: "b", description: null, raw: undefined },
		];

		const result = slimWorkItemSummaries(items, tinyBudget);

		// Stripped to ids plus the elision marker (~40 bytes), so it fits the
		// tiny budget. The marker lands only on items that HAD a body — a
		// body-less card must not gain a fake "truncated" body (it would
		// spuriously fire downstream re-fetch triggers).
		expect(result.fits).toBe(true);
		expect(result.elidedDescriptions).toBe(1);
		expect(result.droppedRaw).toBe(1);
		expect(result.items[0].description).toBe(ELISION_MARKER.trimStart());
		expect(result.items[0].raw).toBeUndefined();
		expect(result.items[1].description).toBeNull();
	});

	it("drops null elements from providers instead of throwing", () => {
		const items = [
			null,
			{ id: "b", description: "x".repeat(4000) },
		] as unknown as Array<SlimmableWorkItem & { id: string }>;

		const result = slimWorkItemSummaries(items, 500);

		expect(result.items).toHaveLength(1);
		expect(result.items[0].id).toBe("b");
		expect((result.items[0] as SlimmableWorkItem).description).toContain(
			ELISION_MARKER.trim(),
		);
	});

	it("never mutates the input array or its items", () => {
		const items = boardOf(3, 4000);
		const snapshot = JSON.stringify(items);
		slimWorkItemSummaries(items, 500);
		expect(JSON.stringify(items)).toBe(snapshot);
	});
});

describe("truncateMcpTextOutput", () => {
	it("passes through an output that fits", () => {
		const output = {
			content: [{ type: "text", text: "small" }],
			isError: false,
		};
		const result = truncateMcpTextOutput(output, MCP_TOOL_RESULT_MAX_BYTES);
		expect(result.truncated).toBe(false);
		expect(result.output).toBe(output);
	});

	it("cuts oversized prose text blocks while preserving structure", () => {
		const output = {
			content: [
				{
					type: "text",
					text: `# Listing\n\n${"z".repeat(2_000_000)}`,
				},
				{ type: "text", text: "second block" },
			],
			isError: false,
		};

		const result = truncateMcpTextOutput(output, 64 * 1024);

		expect(result.truncated).toBe(true);
		expect(result.originalBytes).toBeGreaterThan(64 * 1024);
		expect(measureSerializedBytes(result.output)).toBeLessThanOrEqual(
			64 * 1024 + 256,
		); // small marker/JSON overhead tolerance

		const content = (result.output as typeof output).content;
		// Structure preserved: same block count, same types, second block intact.
		expect(content).toHaveLength(2);
		expect(content[0].type).toBe("text");
		expect(content[1]).toEqual(output.content[1]);
		expect((content[0].text ?? "").endsWith(ELISION_MARKER)).toBe(true);
	});

	it("refuses to cut a JSON-shaped listing — the caller's guard decides", () => {
		// PM listing pages cross as JSON text that consumers JSON.parse; a
		// mid-document cut corrupts them (review finding, #1997).
		const listing = JSON.stringify({
			cards: Array.from({ length: 400 }, (_, i) => ({
				id: i,
				description: "d".repeat(10_000),
			})),
		});
		const output = {
			content: [{ type: "text", text: listing }],
			isError: false,
		};

		const result = truncateMcpTextOutput(output, 64 * 1024);

		expect(result.truncated).toBe(false);
		expect(result.output).toBe(output); // byte-identical passthrough
	});

	it("vetoes the whole output when an earlier block starves a later JSON one", () => {
		// Executed counterexample from post-ship review (#1997): an earlier
		// prose block consumes most of the budget, leaving the JSON block
		// above its per-turn remainder — the naive guard missed this shape.
		const prose = `# Notes\n\n${"p".repeat(100_000)}`;
		const listing = JSON.stringify({
			cards: Array.from({ length: 5000 }, (_, i) => ({ id: i })),
		});
		const output = {
			content: [
				{ type: "text", text: prose },
				{ type: "text", text: listing },
			],
		};

		const result = truncateMcpTextOutput(output, 128 * 1024);

		expect(result.truncated).toBe(false);
		expect(result.output).toBe(output); // nothing modified — guard decides
	});

	it("spreads the budget across sequential text blocks, both ending shortened", () => {
		const output = {
			content: [
				{ type: "text", text: "a".repeat(60_000) },
				{ type: "text", text: "b".repeat(60_000) },
			],
		};
		const result = truncateMcpTextOutput(output, 32 * 1024);

		expect(result.truncated).toBe(true);
		// Original ≈120KB of body vs a 32KB budget → ~95KB elided.
		expect(result.elidedBytes).toBeGreaterThan(50_000);
		const content = (result.output as typeof output).content;
		expect(measureSerializedBytes(result.output)).toBeLessThan(40 * 1024);
		// Both blocks keep a real prefix and end with the elision marker.
		for (const block of content) {
			const text = block.text ?? "";
			expect(text.length).toBeGreaterThan(ELISION_MARKER.length * 2);
			expect(text.endsWith(ELISION_MARKER)).toBe(true);
		}
	});

	it("leaves non-text blocks untouched and counts them as overhead", () => {
		const image = { data: "i".repeat(80_000), mimeType: "image/png" };
		const output = {
			content: [
				{ type: "resource", resource: image },
				{ type: "text", text: "t".repeat(200_000) },
			],
		};
		// 128KB budget: above the ~80KB image overhead (so truncation has room
		// to work) but far under the ~280KB total — the text block carries all
		// the reduction and the image stays byte-identical.
		const result = truncateMcpTextOutput(output, 128 * 1024);

		expect(result.truncated).toBe(true);
		const content = (result.output as typeof output).content;
		expect(content[0]).toEqual(output.content[0]); // image block byte-identical

		// Non-truncatable shape: no content array → passthrough, caller's guard decides.
		const weird = { foo: "bar".repeat(1_000_000) };
		const passthrough = truncateMcpTextOutput(weird, 1024);
		expect(passthrough.truncated).toBe(false);
		expect(passthrough.output).toBe(weird);
	});
});

describe("ladder contract", () => {
	it("caps are strictly decreasing and end above zero", () => {
		for (let i = 1; i < DESCRIPTION_CAP_LADDER.length; i++) {
			expect(DESCRIPTION_CAP_LADDER[i]).toBeLessThan(
				DESCRIPTION_CAP_LADDER[i - 1],
			);
		}
		expect(DESCRIPTION_CAP_LADDER.at(-1)).toBeGreaterThan(0);
	});
});
