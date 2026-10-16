import { afterEach, describe, expect, it, vi } from "vitest";
import { frameContentFingerprint } from "../frame-content-fingerprint";

const BLOCKS = [{ id: "page", type: "html", content: "<p>refresh</p>" }];

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("frameContentFingerprint", () => {
	it("is a SHA-256, the same for the same page", async () => {
		const first = await frameContentFingerprint({
			blocks: BLOCKS,
			runtimeTools: ["a"],
		});
		const second = await frameContentFingerprint({
			blocks: [{ ...BLOCKS[0] }],
			runtimeTools: ["a"],
		});

		expect(first).toMatch(/^[0-9a-f]{64}$/);
		expect(second).toBe(first);
	});

	it("changes with the content of any block", async () => {
		const before = await frameContentFingerprint({
			blocks: BLOCKS,
			runtimeTools: [],
		});
		const after = await frameContentFingerprint({
			blocks: [
				{ ...BLOCKS[0], content: "<p>refresh</p><script></script>" },
			],
			runtimeTools: [],
		});

		expect(after).not.toBe(before);
	});

	it("changes with the blocks' ids and types, and with their number", async () => {
		const base = await frameContentFingerprint({
			blocks: BLOCKS,
			runtimeTools: [],
		});
		const otherId = await frameContentFingerprint({
			blocks: [{ ...BLOCKS[0], id: "other" }],
			runtimeTools: [],
		});
		const otherType = await frameContentFingerprint({
			blocks: [{ ...BLOCKS[0], type: "markdown" }],
			runtimeTools: [],
		});
		const twoBlocks = await frameContentFingerprint({
			blocks: [...BLOCKS, { id: "b", type: "html", content: "" }],
			runtimeTools: [],
		});

		expect(new Set([base, otherId, otherType, twoBlocks]).size).toBe(4);
	});

	it("changes with the tools the page declares, but not with the order they are listed in", async () => {
		const one = await frameContentFingerprint({
			blocks: BLOCKS,
			runtimeTools: ["a", "b"],
		});
		const reordered = await frameContentFingerprint({
			blocks: BLOCKS,
			runtimeTools: ["b", "a"],
		});
		const widened = await frameContentFingerprint({
			blocks: BLOCKS,
			runtimeTools: ["a", "b", "c"],
		});

		expect(reordered).toBe(one);
		expect(widened).not.toBe(one);
	});

	it("does not mistake one block's content for the next block's id", async () => {
		const split = await frameContentFingerprint({
			blocks: [
				{ id: "a", type: "html", content: "x" },
				{ id: "b", type: "html", content: "y" },
			],
			runtimeTools: [],
		});
		const joined = await frameContentFingerprint({
			blocks: [{ id: "a", type: "html", content: 'x","b' }],
			runtimeTools: [],
		});

		expect(joined).not.toBe(split);
	});

	it("is null where the browser cannot hash", async () => {
		vi.stubGlobal("crypto", {});

		await expect(
			frameContentFingerprint({ blocks: BLOCKS, runtimeTools: [] }),
		).resolves.toBeNull();
	});
});
