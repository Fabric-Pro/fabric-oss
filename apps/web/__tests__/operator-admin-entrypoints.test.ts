import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("operator admin server pages", () => {
	it.each([
		"layout.tsx",
		"page.tsx",
		"ai-adoption/page.tsx",
		"audit-log-explorer/page.tsx",
		"chatgpt-plan-health/page.tsx",
		"feature-flags/page.tsx",
		"monitoring/page.tsx",
	])("guards %s with the shared predicate", (file) => {
		const source = readFileSync(
			join(
				__dirname,
				"../app/(saas)/app/(organizations)/[organizationSlug]/admin",
				file,
			),
			"utf8",
		);
		expect(source).toContain("await isPlatformAdmin(session.user)");
		expect(source).not.toContain('role !== "admin"');
	});
});
