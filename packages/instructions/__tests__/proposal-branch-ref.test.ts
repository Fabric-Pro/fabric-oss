import { describe, expect, it } from "vitest";
import {
	MEMBER_BRANCH_PATTERN,
	memberBranchId4,
	memberBranchRef,
	memberBranchSlug,
} from "../src/proposal-branch-ref";

describe("member branch ref (spec Decision 3)", () => {
	it("normalises a display name to [a-z0-9-], collapsing runs and trimming ends", () => {
		expect(memberBranchSlug("  Ada   Lovelace!! ")).toBe("ada-lovelace");
		expect(memberBranchSlug("Émile Zola")).toBe("mile-zola");
	});

	it("falls back to member for an empty or unsafe name", () => {
		expect(memberBranchSlug("")).toBe("member");
		expect(memberBranchSlug("!!!")).toBe("member");
		expect(memberBranchSlug(null)).toBe("member");
		expect(memberBranchSlug(undefined)).toBe("member");
		// Address- and URL-shaped names take the #2563 §5.2 fallback first.
		expect(memberBranchSlug("dev@example.com")).toBe("member");
		expect(memberBranchSlug("https://example.com")).toBe("member");
	});

	it("drops control characters before slugging", () => {
		expect(memberBranchSlug("Pat\nExample")).toBe("patexample");
	});

	it("caps the slug at 40 characters without a trailing dash", () => {
		const slug = memberBranchSlug(`${"a".repeat(39)}-bcdef`);
		expect(slug.length).toBeLessThanOrEqual(40);
		expect(slug.endsWith("-")).toBe(false);
		expect(slug).toBe("a".repeat(39));
	});

	it("derives a stable four-character base-36 id from the user id", () => {
		expect(memberBranchId4("user_1")).toMatch(/^[0-9a-z]{4}$/);
		expect(memberBranchId4("user_1")).toBe(memberBranchId4("user_1"));
		expect(memberBranchId4("user_1")).not.toBe(memberBranchId4("user_2"));
	});

	it("builds refs that match the member pattern and never the #2563 one", () => {
		const ref = memberBranchRef({
			displayName: "Dev Example",
			userId: "user_1",
			n: 3,
		});
		expect(ref).toMatch(
			/^fabric\/instructions\/members\/dev-example-[0-9a-z]{4}\/3$/,
		);
		expect(MEMBER_BRANCH_PATTERN.test(ref)).toBe(true);
		expect(/^fabric\/instructions\/[a-z][a-z0-9]{23}/.test(ref)).toBe(
			false,
		);
	});

	it("builds a fallback ref for an unsafe name", () => {
		const ref = memberBranchRef({
			displayName: "dev@example.com",
			userId: "user_1",
			n: 1,
		});
		expect(ref).toMatch(
			/^fabric\/instructions\/members\/member-[0-9a-z]{4}\/1$/,
		);
	});

	it("rejects n outside 1..999999", () => {
		expect(() =>
			memberBranchRef({ displayName: "x", userId: "u", n: 0 }),
		).toThrow();
		expect(() =>
			memberBranchRef({ displayName: "x", userId: "u", n: 1_000_000 }),
		).toThrow();
		expect(() =>
			memberBranchRef({ displayName: "x", userId: "u", n: 1.5 }),
		).toThrow();
		expect(
			memberBranchRef({ displayName: "x", userId: "u", n: 999_999 }),
		).toMatch(MEMBER_BRANCH_PATTERN);
	});

	it("the pattern refuses a zero-led number and an uppercase slug", () => {
		expect(
			MEMBER_BRANCH_PATTERN.test(
				"fabric/instructions/members/dev-abcd/01",
			),
		).toBe(false);
		expect(
			MEMBER_BRANCH_PATTERN.test(
				"fabric/instructions/members/Dev-abcd/1",
			),
		).toBe(false);
		expect(
			MEMBER_BRANCH_PATTERN.test(
				"fabric/instructions/members/dev-abcd/1",
			),
		).toBe(true);
	});
});
