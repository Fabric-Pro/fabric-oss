import { describe, expect, it } from "vitest";
import { instructionTextPage } from "../src/text-page";

describe("instruction character pages", () => {
	it("pages Unicode code points without splitting surrogate pairs", () => {
		const text = "A😀Б\r\nZ";
		const first = instructionTextPage(text, 0, 2);
		const second = instructionTextPage(text, first.nextOffset ?? 0, 4);
		expect(first).toEqual({
			body: "A😀",
			offset: 0,
			nextOffset: 2,
			truncated: true,
		});
		expect(second).toEqual({
			body: "Б\r\nZ",
			offset: 2,
			nextOffset: null,
			truncated: false,
		});
		expect(first.body + second.body).toBe(text);
	});
	it("returns an empty terminal page past the end", () => {
		expect(instructionTextPage("short", 100, 10)).toEqual({
			body: "",
			offset: 100,
			nextOffset: null,
			truncated: false,
		});
	});
});
