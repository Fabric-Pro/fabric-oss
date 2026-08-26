import { describe, expect, it } from "vitest";
import { computeGroupMemberCounts, membersHoldingTags } from "../function-tags";

const roster = [
	{ userId: "a", tags: ["DEVELOPER" as const] },
	{ userId: "b", tags: ["DEVELOPER" as const, "ARCHITECT" as const] },
	{ userId: "c", tags: [] },
];

describe("membersHoldingTags", () => {
	it("returns deduped userIds holding ANY of the tags", () => {
		expect(membersHoldingTags(roster, ["DEVELOPER"])).toEqual(["a", "b"]);
		expect(membersHoldingTags(roster, ["ARCHITECT"])).toEqual(["b"]);
		expect(membersHoldingTags(roster, ["SME"])).toEqual([]);
	});
	it("counts a member once even if they hold two requested tags", () => {
		expect(membersHoldingTags(roster, ["DEVELOPER", "ARCHITECT"])).toEqual([
			"a",
			"b",
		]);
	});
});

describe("computeGroupMemberCounts", () => {
	it("counts holders per tag; untagged and absent tags are zero", () => {
		const counts = computeGroupMemberCounts(roster);
		expect(counts.DEVELOPER).toBe(2);
		expect(counts.ARCHITECT).toBe(1);
		expect(counts.SME).toBe(0);
	});
});
