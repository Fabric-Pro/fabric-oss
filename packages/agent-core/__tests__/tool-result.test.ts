import { describe, expect, it } from "vitest";
import { isToolResultError } from "../src/tool-result";

describe("tool result error rule", () => {
	it.each([
		[{ status: "error", content: "failed" }, true],
		[{ additional_kwargs: { status: "error" }, content: "failed" }, true],
		[{ content: "Error: failed" }, true],
		[{ content: "  Error failed" }, true],
		[{ content: '{"error":"data"}' }, false],
		[{ content: "done" }, false],
	])("classifies %j", (fields, expected) => {
		expect(isToolResultError({ type: "tool", ...fields })).toBe(expected);
	});
});
