import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { computePmHash, normalize, stripHtml } from "../pm-sync-hash";

describe("stripHtml", () => {
	it("strips simple tags", () => {
		expect(stripHtml("<div>test</div>")).toBe("test\n");
	});

	it("converts <br> to newline", () => {
		expect(stripHtml("line1<br>line2")).toBe("line1\nline2");
		expect(stripHtml("line1<br/>line2")).toBe("line1\nline2");
		expect(stripHtml("line1<br />line2")).toBe("line1\nline2");
	});

	it("converts closing block tags to newlines", () => {
		expect(stripHtml("<p>para1</p><p>para2</p>")).toBe("para1\npara2\n");
	});

	it("strips inline tags without adding newlines", () => {
		expect(stripHtml("<b>bold</b> and <i>italic</i>")).toBe(
			"bold and italic",
		);
	});

	it("decodes HTML entities", () => {
		expect(stripHtml("&amp; &lt; &gt; &quot; &#39;")).toBe("& < > \" '");
		expect(stripHtml("hello&nbsp;world")).toBe("hello world");
	});

	it("handles ADO-style description", () => {
		expect(stripHtml("<div>Hello world</div>")).toBe("Hello world\n");
	});

	it("returns plain text unchanged", () => {
		expect(stripHtml("no html here")).toBe("no html here");
	});
});

describe("normalize", () => {
	it.each([
		{ name: "null", input: null, expected: "" },
		{ name: "undefined", input: undefined, expected: "" },
		{ name: "empty string", input: "", expected: "" },
		{ name: "plain string", input: "hello", expected: "hello" },
		{ name: "CRLF to LF", input: "a\r\nb\r\nc", expected: "a\nb\nc" },
		{
			name: "trailing whitespace per line",
			input: "line one   \nline two\t\nline three",
			expected: "line one\nline two\nline three",
		},
		{
			name: "leading and trailing whitespace on whole string",
			input: "   hello world   ",
			expected: "hello world",
		},
		{
			name: "combined CRLF + trailing + outer trim",
			input: "  \r\nfirst  \r\nsecond\t\r\n  ",
			expected: "first\nsecond",
		},
	])("returns $expected for $name", ({ input, expected }) => {
		expect(normalize(input)).toBe(expected);
	});

	it("treats null and undefined identically", () => {
		expect(normalize(null)).toBe(normalize(undefined));
	});

	it("produces equal output for CRLF and LF inputs", () => {
		expect(normalize("a\r\nb")).toBe(normalize("a\nb"));
	});

	it("produces equal output for trailing-whitespace and clean inputs", () => {
		expect(normalize("a   \nb\t")).toBe(normalize("a\nb"));
	});
});

describe("computePmHash", () => {
	const SHA256_HEX = /^[0-9a-f]{64}$/;

	it("returns a 64-char lowercase hex sha256 string", () => {
		expect(computePmHash("title", "description")).toMatch(SHA256_HEX);
	});

	it("matches sha256(normalize(title) + \\n + normalize(description))", () => {
		const title = "  Hello  ";
		const description = "world\r\n";
		const expected = createHash("sha256")
			.update(`${normalize(title)}\n${normalize(description)}`, "utf8")
			.digest("hex");
		expect(computePmHash(title, description)).toBe(expected);
	});

	it("is deterministic for empty/null/undefined inputs", () => {
		const fromNulls = computePmHash(null, null);
		const fromUndef = computePmHash(undefined, undefined);
		const fromEmpty = computePmHash("", "");
		expect(fromNulls).toBe(fromUndef);
		expect(fromNulls).toBe(fromEmpty);
	});

	it("treats CRLF and LF inputs as equivalent", () => {
		expect(computePmHash("a\r\nb", "c\r\nd")).toBe(
			computePmHash("a\nb", "c\nd"),
		);
	});

	it("treats trailing per-line whitespace as equivalent", () => {
		expect(computePmHash("a   \nb\t", "c \nd  ")).toBe(
			computePmHash("a\nb", "c\nd"),
		);
	});

	it("treats leading and trailing outer whitespace as equivalent", () => {
		expect(computePmHash("  title  ", "  body  ")).toBe(
			computePmHash("title", "body"),
		);
	});

	it("produces different hashes for distinct inputs", () => {
		expect(computePmHash("title-a", "body")).not.toBe(
			computePmHash("title-b", "body"),
		);
		expect(computePmHash("title", "body-a")).not.toBe(
			computePmHash("title", "body-b"),
		);
	});

	it("is case-sensitive", () => {
		expect(computePmHash("Title", "body")).not.toBe(
			computePmHash("title", "body"),
		);
	});

	it("treats HTML-wrapped and plain text as equivalent (ADO compatibility)", () => {
		expect(computePmHash("title", "<div>description</div>")).toBe(
			computePmHash("title", "description"),
		);
		expect(computePmHash("title", "<p>line1</p><p>line2</p>")).toBe(
			computePmHash("title", "line1\nline2"),
		);
	});

	it("does not collide title/description boundary (newline separator)", () => {
		expect(computePmHash("ab", "cd")).not.toBe(computePmHash("a", "bcd"));
		expect(computePmHash("ab", "cd")).not.toBe(computePmHash("abcd", ""));
	});
});
