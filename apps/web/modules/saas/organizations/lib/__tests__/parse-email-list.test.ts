import { describe, expect, it } from "vitest";
import { parseEmailList } from "../parse-email-list";

describe("parseEmailList", () => {
	it("splits on new lines, commas, semicolons and spaces", () => {
		expect(
			parseEmailList(
				"a@example.com\nb@example.com, c@example.com;d@example.com e@example.com",
			),
		).toEqual([
			"a@example.com",
			"b@example.com",
			"c@example.com",
			"d@example.com",
			"e@example.com",
		]);
	});

	it("takes the address out of a mail client's name format", () => {
		expect(
			parseEmailList(
				"Jane Doe <jane@example.com>; John Roe <john@example.com>",
			),
		).toEqual(["jane@example.com", "john@example.com"]);
	});

	it("keeps a bare address that sits before a named one", () => {
		expect(
			parseEmailList("a@example.com Jane Doe <b@example.com>"),
		).toEqual(["a@example.com", "b@example.com"]);
	});

	it("does not split a quoted display name on its comma", () => {
		expect(
			parseEmailList('"Doe, Jane" <jane@example.com>, john@example.com'),
		).toEqual(["jane@example.com", "john@example.com"]);
	});

	it("keeps name words that have no address, for the server to report", () => {
		expect(parseEmailList("Jane Doe, b@example.com")).toEqual([
			"Jane",
			"Doe",
			"b@example.com",
		]);
	});

	it("drops empty entries", () => {
		expect(parseEmailList(" \n,, ;\n")).toEqual([]);
	});

	it("keeps malformed entries for the server to report", () => {
		expect(parseEmailList("not-an-email")).toEqual(["not-an-email"]);
	});
});
