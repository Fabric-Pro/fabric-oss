import { describe, expect, it } from "vitest";
import { jsonResult } from "../json-result";

describe("JSON tool text result", () => {
	it("preserves the canonical text envelope and two-space indentation", () => {
		expect(jsonResult({ ready: true, label: "🧭" })).toEqual({
			content: [
				{
					type: "text",
					text: '{\n  "ready": true,\n  "label": "🧭"\n}',
				},
			],
		});
	});

	it.each([
		[null, "null"],
		[false, "false"],
		[0, "0"],
		["example", '"example"'],
	])(
		"serializes the JSON value %j without another wrapper",
		(value, text) => {
			expect(jsonResult(value)).toEqual({
				content: [{ type: "text", text }],
			});
		},
	);
});
