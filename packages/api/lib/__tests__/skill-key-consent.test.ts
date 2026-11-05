import { describe, expect, it } from "vitest";
import {
	refusedSkillKeyScopes,
	requiresSkillKeyConsent,
} from "../skill-key-consent";

describe("user-key and REST Skills mint consent ceiling", () => {
	it.each(["skills:write", "skills:publish", "governance:write", "*"])(
		"requires current organization membership for %s",
		(scope) => {
			expect(requiresSkillKeyConsent([scope])).toBe(true);
			expect(refusedSkillKeyScopes([scope])).not.toEqual([]);
		},
	);
	it.each(["skills:write", "skills:publish", "governance:write", "*"])(
		"refuses viewer grants for %s including wildcard",
		(scope) =>
			expect(refusedSkillKeyScopes([scope], "viewer")).not.toEqual([]),
	);
	it("allows genuine reads without inventing a personal tenant", () => {
		expect(
			requiresSkillKeyConsent(["skills:read", "governance:read"]),
		).toBe(false);
		expect(
			refusedSkillKeyScopes(["skills:read", "governance:read"], "viewer"),
		).toEqual([]);
	});
	it("permits member authoring while reserving governance and wildcard to administrators", () => {
		expect(
			refusedSkillKeyScopes(["skills:write", "skills:publish"], "member"),
		).toEqual([]);
		expect(refusedSkillKeyScopes(["governance:write"], "member")).toEqual([
			"governance:write",
		]);
		expect(refusedSkillKeyScopes(["*"], "member")).toEqual([
			"governance:write",
		]);
	});
	it.each(["admin", "owner"])(
		"permits explicit %s effective grants",
		(role) => expect(refusedSkillKeyScopes(["*"], role)).toEqual([]),
	);
});
