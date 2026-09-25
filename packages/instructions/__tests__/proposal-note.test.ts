import { describe, expect, it } from "vitest";
import { proposalNoteSchema } from "../src/proposal-note";

/** The first issue's field, the only detail NOTE_REJECTED may name (spec §5.3). */
function rejectedField(input: unknown): unknown {
	const parsed = proposalNoteSchema.safeParse(input);
	expect(parsed.success).toBe(false);
	return parsed.success ? undefined : parsed.error.issues[0]?.path[0];
}

describe("proposalNoteSchema (spec §5.1 step 6)", () => {
	it("accepts an empty note", () => {
		expect(proposalNoteSchema.parse({})).toEqual({});
	});

	it("accepts a title and a multi-line body", () => {
		expect(
			proposalNoteSchema.parse({
				title: "Tighten the review rule",
				body: "First line\r\nSecond line\n",
			}),
		).toEqual({
			title: "Tighten the review rule",
			body: "First line\r\nSecond line\n",
		});
	});

	it("NFC-normalises the title and the body", () => {
		const parsed = proposalNoteSchema.parse({
			title: "café",
			body: "résumé",
		});
		expect(parsed.title).toBe("café");
		expect(parsed.body).toBe("résumé");
	});

	it.each([
		["a line feed", "one\ntwo"],
		["a carriage return", "one\rtwo"],
	])("refuses a title with %s: the title is one line", (_, title) => {
		expect(rejectedField({ title })).toBe("title");
	});

	it("counts title length in code points, after NFC", () => {
		// U+1F600 is one code point but two UTF-16 units: 120 code points is
		// 121 units long, and must still pass.
		const emoji = "\u{1F600}";
		expect(
			proposalNoteSchema.safeParse({
				title: `${"a".repeat(119)}${emoji}`,
			}).success,
		).toBe(true);
		expect(rejectedField({ title: `${"a".repeat(120)}${emoji}` })).toBe(
			"title",
		);
		// 120 decomposed "é" are 240 code points before NFC and 120 after.
		expect(
			proposalNoteSchema.safeParse({ title: "é".repeat(120) }).success,
		).toBe(true);
	});

	it("measures the body in UTF-8 bytes, after NFC", () => {
		// "é" is two bytes: 2048 of them are 4096 bytes, 2049 are over.
		expect(
			proposalNoteSchema.safeParse({ body: "é".repeat(2048) }).success,
		).toBe(true);
		expect(rejectedField({ body: "é".repeat(2049) })).toBe("body");
		// Decomposed, the same text is three bytes a character until NFC.
		expect(
			proposalNoteSchema.safeParse({ body: "é".repeat(2048) }).success,
		).toBe(true);
	});

	it.each([
		["title", "a\u0000b"],
		["body", "a\u0000b"],
		["title", "a\uD800b"],
		["body", "a\uD800"],
		["body", "\uDC00a"],
	])("refuses NUL and lone surrogates in the %s", (field, value) => {
		expect(rejectedField({ [field]: value })).toBe(field);
	});

	it("keeps a well-formed surrogate pair", () => {
		expect(proposalNoteSchema.parse({ body: "ok \u{1F600}" }).body).toBe(
			"ok \u{1F600}",
		);
	});

	it("refuses a non-string title", () => {
		expect(rejectedField({ title: 42 })).toBe("title");
	});
});
