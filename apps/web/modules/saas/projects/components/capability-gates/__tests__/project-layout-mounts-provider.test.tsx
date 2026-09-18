/**
 * The project layout mounts the gating provider (Fizzy #1930).
 *
 * This test carries the guarantee that `useCapabilityGates` deliberately stopped
 * carrying under test. Every gated surface — the security page, the document
 * dialog, the contexts list — is a tab inside `projects/[id]`, so one provider
 * in that layout is what makes all of them work. A throw at each leaf would
 * assert the same thing far less directly, and at the cost of breaking every
 * page suite that mocks react-query.
 *
 * It reads the layout's source rather than rendering it: the layout is an async
 * server component whose siblings reach the database, and the fact worth pinning
 * is structural — the provider wraps the children, once.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const LAYOUT = resolve(
	__dirname,
	"../../../../../../app/(saas)/app/(organizations)/[organizationSlug]/projects/[id]/layout.tsx",
);

describe("project layout", () => {
	const source = readFileSync(LAYOUT, "utf8");

	it("imports the capability gates provider", () => {
		expect(
			source,
			"Every gated surface is a tab inside this route. Without the provider " +
				"here, each one renders ungated and nothing says so.",
		).toContain("CapabilityGatesProvider");
	});

	it("wraps the project's children in it, so every tab is covered", () => {
		// The children must be INSIDE the provider — a provider rendered beside
		// them would type-check, render, and gate nothing.
		expect(source).toMatch(
			/<CapabilityGatesProvider[^>]*>[\s\S]*\{children\}[\s\S]*<\/CapabilityGatesProvider>/,
		);
	});

	it("resolves the matrix once, not once per surface", () => {
		// One mount. A second provider inside a tab would start a second query
		// under a different subtree and quietly double the per-page cost.
		expect(source.match(/<CapabilityGatesProvider/g)).toHaveLength(1);
	});
});
