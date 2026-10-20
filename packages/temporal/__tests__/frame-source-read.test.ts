import { describe, expect, it } from "vitest";
import { parseFrameSourceWindow } from "../src/activities/shared/frame-args";
import { unwrapGatewayResult } from "../src/activities/shared/fabric-gateway-client";
import {
	FRAME_SOURCE_RESULT_MAX_CHARS,
	readFrameSource,
} from "../src/activities/shared/frame-source-read";

function frame(content: string) {
	return {
		id: "frame-1",
		title: "Example",
		updatedAt: new Date("2026-10-14T10:00:00Z"),
		document: {
			version: 1 as const,
			kind: "frame" as const,
			title: "Example",
			blocks: [
				{ id: "other", type: "html" as const, content: "SIBLING-BODY" },
				{ id: "selected", type: "html" as const, content },
			],
		},
	};
}

describe("bounded saved frame source", () => {
	it("reassembles exact escaped and Unicode source without sibling content", () => {
		const content = '"\n\\\u0000😀'.repeat(2_500);
		const saved = frame(content);
		let offset = 0;
		let rebuilt = "";
		let complete = false;
		for (let page = 0; page < 100; page++) {
			const result = readFrameSource(saved, {
				blockId: "selected",
				offset,
				limit: 6_000,
			});
			if ("error" in result) {
				throw new Error(result.error);
			}
			expect(result.updatedAt).toBe("2026-10-14T10:00:00.000Z");
			expect(result.totalChars).toBe(content.length);
			expect(result.block.id).toBe("selected");
			expect(result.returnedLength).toBeGreaterThan(0);
			const serialized = JSON.stringify(result, null, 2);
			expect(serialized.length).toBeLessThanOrEqual(
				FRAME_SOURCE_RESULT_MAX_CHARS,
			);
			const normalized = unwrapGatewayResult({
				content: [{ type: "text", text: serialized }],
			});
			expect(normalized).toEqual(result);
			expect(JSON.stringify(normalized).length).toBeLessThan(12_000);
			expect(serialized).not.toContain("SIBLING-BODY");
			expect(result).not.toHaveProperty("blocks");
			expect(result).not.toHaveProperty("embedUrl");
			rebuilt += result.block.content;
			if (result.complete) {
				complete = true;
				expect(result.nextOffset).toBeUndefined();
				break;
			}
			if (result.nextOffset === undefined) {
				throw new Error(
					"Incomplete source needs a continuation offset",
				);
			}
			expect(result.nextOffset).toBe(offset + result.returnedLength);
			offset = result.nextOffset;
		}
		expect(complete).toBe(true);
		expect(rebuilt).toBe(content);
	});

	it("keeps chunk and caller offsets on complete Unicode characters", () => {
		const saved = frame("A😀B");
		expect(
			readFrameSource(saved, {
				blockId: "selected",
				offset: 0,
				limit: 2,
			}),
		).toMatchObject({ block: { content: "A" }, nextOffset: 1 });
		expect(
			readFrameSource(saved, {
				blockId: "selected",
				offset: 1,
				limit: 2,
			}),
		).toMatchObject({ block: { content: "😀" }, nextOffset: 3 });
		expect(
			readFrameSource(saved, {
				blockId: "selected",
				offset: 2,
				limit: 2,
			}),
		).toHaveProperty("error");
		expect(
			readFrameSource(saved, {
				blockId: "selected",
				offset: 1,
				limit: 1,
			}),
		).toHaveProperty("error");
	});

	it.each([
		{ offset: -1 },
		{ offset: 0.5 },
		{ offset: null },
		{ limit: 0 },
		{ limit: 6_001 },
		{ blockId: "" },
	])("refuses invalid window arguments %j", (window) => {
		expect(parseFrameSourceWindow(window)).toMatchObject({ ok: false });
	});

	it("refuses missing blocks, past-end offsets and oversized metadata", () => {
		const saved = frame("<p>Example</p>");
		expect(
			readFrameSource(saved, {
				blockId: "missing",
				offset: 0,
				limit: 6_000,
			}),
		).toHaveProperty("error");
		expect(
			readFrameSource(saved, { offset: 999, limit: 6_000 }),
		).toHaveProperty("error");
		expect(
			readFrameSource(
				{ ...saved, title: "x".repeat(10_001) },
				{ offset: 0, limit: 6_000 },
			),
		).toHaveProperty("error");
	});
});
