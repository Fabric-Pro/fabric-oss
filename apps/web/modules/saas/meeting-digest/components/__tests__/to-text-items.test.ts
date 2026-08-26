import { describe, expect, it } from "vitest";
import { toTextItems } from "../MeetingDetailSheet";

describe("toTextItems", () => {
	it("returns [] for null", () => {
		expect(toTextItems(null)).toEqual([]);
	});

	it("returns [] for non-array values", () => {
		expect(toTextItems("string")).toEqual([]);
		expect(toTextItems(42)).toEqual([]);
		expect(toTextItems({ text: "foo" })).toEqual([]);
	});

	it("maps array of {text} objects", () => {
		const result = toTextItems([
			{ text: "Ship it" },
			{ text: "Review PR" },
		]);
		expect(result).toEqual([{ text: "Ship it" }, { text: "Review PR" }]);
	});

	it("maps array of strings", () => {
		const result = toTextItems(["Decision A", "Decision B"]);
		expect(result).toEqual([
			{ text: "Decision A" },
			{ text: "Decision B" },
		]);
	});

	it("builds meta from tentativeOwnerName and dueHint", () => {
		const result = toTextItems([
			{
				text: "Fix login bug",
				tentativeOwnerName: "Ann",
				dueHint: "Fri",
			},
		]);
		expect(result).toEqual([
			{ text: "Fix login bug", meta: "Ann · due Fri" },
		]);
	});

	it("builds meta from tentativeOwnerName only", () => {
		const result = toTextItems([
			{ text: "Do the thing", tentativeOwnerName: "Bob" },
		]);
		expect(result).toEqual([{ text: "Do the thing", meta: "Bob" }]);
	});

	it("builds meta from dueHint only", () => {
		const result = toTextItems([{ text: "Review", dueHint: "Monday" }]);
		expect(result).toEqual([{ text: "Review", meta: "due Monday" }]);
	});

	it("falls back to JSON.stringify for unknown object shapes", () => {
		const obj = { foo: "bar" };
		const result = toTextItems([obj]);
		expect(result).toEqual([{ text: JSON.stringify(obj) }]);
	});

	it("carries anchorLine when present and integer, drops non-integers", () => {
		expect(
			toTextItems([
				{ text: "Ship it", anchorLine: 12, sourceQuote: "we ship" },
				{ text: "No anchor" },
				{ text: "Bad anchor", anchorLine: "12" },
				{ text: "Float anchor", anchorLine: 3.5 },
			]),
		).toEqual([
			{ text: "Ship it", anchorLine: 12 },
			{ text: "No anchor" },
			{ text: "Bad anchor" },
			{ text: "Float anchor" },
		]);
	});
});
