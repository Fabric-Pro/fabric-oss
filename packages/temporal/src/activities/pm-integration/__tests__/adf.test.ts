import { describe, expect, it } from "vitest";
import { descriptionToText, extractTextFromAdf, isAdfDocument } from "../adf";

describe("isAdfDocument", () => {
	it("recognizes an ADF doc node", () => {
		expect(isAdfDocument({ type: "doc", version: 1, content: [] })).toBe(
			true,
		);
	});

	it("rejects strings, null, and non-doc objects", () => {
		expect(isAdfDocument("hello")).toBe(false);
		expect(isAdfDocument(null)).toBe(false);
		expect(isAdfDocument(undefined)).toBe(false);
		expect(isAdfDocument({ type: "paragraph" })).toBe(false);
	});
});

describe("extractTextFromAdf", () => {
	it("flattens a single paragraph to its text", () => {
		const adf = {
			type: "doc",
			version: 1,
			content: [
				{
					type: "paragraph",
					content: [{ type: "text", text: "Hello world" }],
				},
			],
		};
		expect(extractTextFromAdf(adf)).toBe("Hello world");
	});

	it("separates block-level nodes with blank lines and keeps order", () => {
		const adf = {
			type: "doc",
			version: 1,
			content: [
				{
					type: "heading",
					content: [{ type: "text", text: "Big Picture" }],
				},
				{
					type: "paragraph",
					content: [{ type: "text", text: "Small picture" }],
				},
				{
					type: "bulletList",
					content: [
						{
							type: "listItem",
							content: [
								{
									type: "paragraph",
									content: [{ type: "text", text: "one" }],
								},
							],
						},
						{
							type: "listItem",
							content: [
								{
									type: "paragraph",
									content: [{ type: "text", text: "two" }],
								},
							],
						},
					],
				},
			],
		};
		expect(extractTextFromAdf(adf)).toBe(
			"Big Picture\n\nSmall picture\n\none\n\ntwo",
		);
	});

	it("joins adjacent text nodes within a block without inserting spaces", () => {
		const adf = {
			type: "doc",
			content: [
				{
					type: "paragraph",
					content: [
						{
							type: "text",
							text: "bold",
							marks: [{ type: "strong" }],
						},
						{ type: "text", text: " and plain" },
					],
				},
			],
		};
		expect(extractTextFromAdf(adf)).toBe("bold and plain");
	});

	it("returns an empty string for a doc with no text", () => {
		expect(extractTextFromAdf({ type: "doc", content: [] })).toBe("");
	});

	it("never throws on malformed input", () => {
		expect(extractTextFromAdf(null)).toBe("");
		expect(
			extractTextFromAdf({ type: "doc", content: "not-an-array" }),
		).toBe("");
	});
});

describe("descriptionToText", () => {
	it("passes strings through unchanged", () => {
		expect(descriptionToText("plain text")).toBe("plain text");
	});

	it("flattens ADF documents", () => {
		const adf = {
			type: "doc",
			content: [
				{
					type: "paragraph",
					content: [{ type: "text", text: "from adf" }],
				},
			],
		};
		expect(descriptionToText(adf)).toBe("from adf");
	});

	it("returns undefined for non-string, non-ADF values so callers fall through", () => {
		expect(descriptionToText(undefined)).toBeUndefined();
		expect(descriptionToText(null)).toBeUndefined();
		expect(descriptionToText(42)).toBeUndefined();
		expect(descriptionToText({ summary: "x" })).toBeUndefined();
	});
});
