import { describe, expect, it } from "vitest";
import { skillListReturnHref, skillSlug } from "../skill-ui";

it("normalizes the truncated chat identifier after the final character is cut", () => {
	expect(skillSlug("Weekly sprint delivery readiness status check", 40)).toBe(
		"weekly-sprint-delivery-readiness-status",
	);
	expect(skillSlug(`${"A".repeat(99)} ending`)).toMatch(
		/^[a-z0-9]+(?:-[a-z0-9]+)*$/,
	);
});

describe("skill library return path", () => {
	it("preserves same-organization list filters", () => {
		expect(
			skillListReturnHref(
				"/app/example-org",
				"/app/example-org/skills?tab=drafts&search=delivery&page=2",
			),
		).toBe("/app/example-org/skills?tab=drafts&search=delivery&page=2");
	});
	it.each([
		"https://example.com/app/example-org/skills?tab=drafts",
		"https://other.example/",
		"//other.example/app/example-org/skills",
		"/app/other-org/skills?tab=drafts",
		"/app/example-org/skills/other-id",
		"/app/example-org/skills?tab=drafts#fragment",
		"/app/example-org/skills/../settings?tab=drafts",
		"/app/example-org/skills-malformed?tab=drafts",
	])(
		"rejects a return target outside the exact organization skills list: %s",
		(candidate) => {
			expect(skillListReturnHref("/app/example-org", candidate)).toBe(
				"/app/example-org/skills",
			);
		},
	);
});
