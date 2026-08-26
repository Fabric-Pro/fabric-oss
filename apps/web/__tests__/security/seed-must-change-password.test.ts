/**
 * Validates that the seed script sets mustChangePassword: true ONLY on the
 * newly-created-user branch — never on the existing-user update branch.
 *
 * The force-change-password flow is a one-time prompt on first login: set on
 * creation, cleared by the auth after-hook (packages/auth/auth.ts) once the
 * user changes their password. Re-setting it on every seed run would force
 * every seeded user to change their password again on the next re-seed —
 * see https://github.com/Fabric-Pro/fabric/pull/984.
 *
 * This is a structural assertion against the source file rather than an
 * execution test — we verify the flag is present (and absent) in the right
 * places. The branches are delimited by `if (existingUser)` (update branch)
 * and `db.$transaction` (create branch).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const seedSource = readFileSync(
	resolve(__dirname, "../../../../packages/database/prisma/seed.ts"),
	"utf-8",
);

describe("Seed script mustChangePassword flag", () => {
	it("should set mustChangePassword: true exactly once (create branch only)", () => {
		const matches = seedSource.match(/mustChangePassword:\s*true/g);
		expect(matches).not.toBeNull();
		expect(matches!.length).toBe(1);
	});

	it("should NOT set mustChangePassword in the existing-user update block", () => {
		// Existing-user update block runs from `if (existingUser)` to the
		// `continue;` that ends that branch — re-setting the flag here is the
		// bug fixed in PR #984. We check for the literal `mustChangePassword:`
		// assignment (not just the word, which appears in the explanatory
		// comment).
		const existingUserBranchMatch = seedSource.match(
			/if \(existingUser\)[\s\S]*?continue;/,
		);
		expect(existingUserBranchMatch).not.toBeNull();
		expect(existingUserBranchMatch![0]).not.toMatch(
			/mustChangePassword:\s*\w/,
		);
	});

	it("should include mustChangePassword: true in the newly-created-user create block", () => {
		// The create branch starts at `db.$transaction` (after the
		// `continue;` of the existing-user branch).
		const createBranch = seedSource.split("db.$transaction")[1];
		expect(createBranch).toBeDefined();
		expect(createBranch).toContain("mustChangePassword: true");
	});
});
