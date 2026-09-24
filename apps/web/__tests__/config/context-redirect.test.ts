/**
 * Pins non-permanent redirects routing legacy /context links to ?tab=context.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("context tab redirects", () => {
	it("redirects legacy project context routes to ?tab=context non-permanently", () => {
		const nextConfig = readFileSync(
			resolve(__dirname, "../../next.config.ts"),
			"utf8",
		);

		const orgRedirect = nextConfig.match(
			/\{[^}]*source:\s*"\/app\/:organizationSlug\/projects\/:id\/context"[^}]*\}/,
		)?.[0];
		expect(orgRedirect).toBeDefined();
		expect(orgRedirect).toContain(
			'destination: "/app/:organizationSlug/projects/:id?tab=context"',
		);
		expect(orgRedirect).toContain("permanent: false");

		const personalRedirect = nextConfig.match(
			/\{[^}]*source:\s*"\/app\/projects\/:id\/context"[^}]*\}/,
		)?.[0];
		expect(personalRedirect).toBeDefined();
		expect(personalRedirect).toContain(
			'destination: "/app/projects/:id?tab=context"',
		);
		expect(personalRedirect).toContain("permanent: false");
	});
});
