import { describe, expect, it } from "vitest";
import { buildCsv, csvField } from "../csv";

describe("csvField", () => {
	it("leaves plain text and numbers as they are", () => {
		expect(csvField("Development")).toBe("Development");
		expect(csvField(1.5)).toBe("1.5");
		expect(csvField(true)).toBe("true");
	});

	it("writes null and undefined as an empty cell", () => {
		expect(csvField(null)).toBe("");
		expect(csvField(undefined)).toBe("");
	});

	it.each([
		["a,b", '"a,b"'],
		['say "hi"', '"say ""hi"""'],
		["line one\nline two", '"line one\nline two"'],
		["line one\r\nline two", '"line one\r\nline two"'],
	])("quotes %j per RFC 4180", (value, expected) => {
		expect(csvField(value)).toBe(expected);
	});

	it.each([
		["=SUM(A1:A2)", "'=SUM(A1:A2)"],
		["+1", "'+1"],
		["-1", "'-1"],
		["@cmd", "'@cmd"],
		["\tindented", "'\tindented"],
		[
			"\rstarts with a carriage return",
			`"'\rstarts with a carriage return"`,
		],
	])("neutralises the formula start of %j", (value, expected) => {
		expect(csvField(value)).toBe(expected);
	});

	it("neutralises before quoting, so the apostrophe sits inside the quotes", () => {
		expect(csvField('=HYPERLINK("https://example.com")')).toBe(
			`"'=HYPERLINK(""https://example.com"")"`,
		);
	});

	it("does not prefix a number, so a negative amount stays a number", () => {
		expect(csvField(-2)).toBe("-2");
	});

	it("only looks at the first character", () => {
		expect(csvField("a=b")).toBe("a=b");
	});
});

describe("buildCsv", () => {
	it("writes the header, then each row, every line ending in CRLF", () => {
		expect(
			buildCsv(
				["Name", "Hours"],
				[
					["Ada", 1.5],
					["Grace, R.", null],
				],
			),
		).toBe('Name,Hours\r\nAda,1.5\r\n"Grace, R.",\r\n');
	});

	it("writes only the header when there are no rows", () => {
		expect(buildCsv(["Name"], [])).toBe("Name\r\n");
	});
});
