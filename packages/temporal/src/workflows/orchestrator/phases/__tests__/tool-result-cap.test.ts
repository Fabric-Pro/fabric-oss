import { describe, expect, it } from "vitest";
import { pagedBodyMaxLength, toolResultCap } from "../../tool-result-cap";

describe("toolResultCap", () => {
	it.each([false, true])(
		"preserves skill allowance with marker=%s",
		(enabled) => {
			for (const name of ["load_skill", "read_skill_file"]) {
				expect(toolResultCap(name, false, enabled)).toBe(64_000);
			}
		},
	);
	it("preserves unlimited schema in call_tool mode", () => {
		expect(toolResultCap("get_tool_schema", true, true)).toBe(
			Number.MAX_SAFE_INTEGER,
		);
	});
	it("limits schema outside call_tool mode", () => {
		expect(toolResultCap("get_tool_schema", false, true)).toBe(32_000);
	});
	it("uses the new cap when patched", () => {
		expect(toolResultCap("example_tool", false, true)).toBe(32_000);
	});
	it("preserves the legacy cap without the marker", () => {
		expect(toolResultCap("example_tool", false, false)).toBe(12_000);
	});
});

describe("pagedBodyMaxLength", () => {
	it.each([
		[true, 24_000],
		[false, 8_000],
	] as const)("marker=%s selects %s", (enabled, expected) => {
		expect(pagedBodyMaxLength(enabled)).toBe(expected);
	});
});
