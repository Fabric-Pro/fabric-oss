import { describe, expect, it } from "vitest";
import { commitShaSchema } from "../commit-sha";

describe("commitShaSchema", () => {
	it("accepts only full lowercase Git object identifiers", () => {
		expect(commitShaSchema.safeParse("a".repeat(40)).success).toBe(true);
		expect(commitShaSchema.safeParse("b".repeat(64)).success).toBe(true);
		for (const ref of [
			"release/next",
			"HEAD",
			"a".repeat(7),
			"A".repeat(40),
		]) {
			expect(commitShaSchema.safeParse(ref).success).toBe(false);
		}
	});
});
