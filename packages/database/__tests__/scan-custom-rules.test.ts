import { describe, expect, it } from "vitest";
import { parseScanCustomRules } from "../prisma/queries/projects/scan";

describe("parseScanCustomRules", () => {
	it("returns an empty array for null / non-array input", () => {
		expect(parseScanCustomRules(null)).toEqual([]);
		expect(parseScanCustomRules("nope")).toEqual([]);
		expect(parseScanCustomRules({})).toEqual([]);
	});

	it("keeps well-formed rules and drops malformed entries", () => {
		const rules = parseScanCustomRules([
			{
				id: "1",
				name: "R1",
				category: "SECURITY",
				severity: "HIGH",
				guidance: "g1",
				enabled: true,
			},
			// bad category — dropped
			{
				id: "2",
				name: "R2",
				category: "NOPE",
				severity: "HIGH",
				guidance: "g2",
			},
			// valid, enabled omitted -> defaults true
			{
				id: "3",
				name: "R3",
				category: "ACCESSIBILITY",
				severity: "LOW",
				guidance: "g3",
			},
			// missing id -> dropped
			{ name: "no id" },
			"garbage",
			null,
		]);
		expect(rules).toHaveLength(2);
		expect(rules[0].id).toBe("1");
		expect(rules[1].id).toBe("3");
		expect(rules[1].enabled).toBe(true);
	});

	it("respects an explicit enabled=false", () => {
		const [rule] = parseScanCustomRules([
			{
				id: "x",
				name: "n",
				category: "SECURITY",
				severity: "MEDIUM",
				guidance: "g",
				enabled: false,
			},
		]);
		expect(rule.enabled).toBe(false);
	});
});
