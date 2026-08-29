/**
 * The input-org guard used by every newsletter and daily-brief procedure.
 *
 * The asymmetry is the whole design and the easiest thing to "tidy" away: a
 * null or omitted organizationId must PASS even for an org-owned project,
 * because a guest on a personal-context page legitimately sends null. Turning
 * that into a rejection restores the bug this guard replaced, from the other
 * direction.
 *
 * Run with: pnpm --filter @repo/api test authorized-project-tenant
 */

import { ORPCError } from "@orpc/client";
import { describe, expect, it } from "vitest";

import { assertInputOrgMatchesProject } from "../authorized-project-tenant";

const orgProject = { organizationId: "org-9" };
const personalProject = { organizationId: null };

describe("assertInputOrgMatchesProject", () => {
	it("passes when the input names the project's own organization", () => {
		expect(() =>
			assertInputOrgMatchesProject("org-9", orgProject),
		).not.toThrow();
	});

	it("passes on null for an ORG project — the guest-in-personal-context case", () => {
		expect(() =>
			assertInputOrgMatchesProject(null, orgProject),
		).not.toThrow();
	});

	it("passes on undefined for an ORG project — the same case, field omitted", () => {
		expect(() =>
			assertInputOrgMatchesProject(undefined, orgProject),
		).not.toThrow();
	});

	it("passes on null for a personal project", () => {
		expect(() =>
			assertInputOrgMatchesProject(null, personalProject),
		).not.toThrow();
	});

	it("rejects an organization that is not the project's", () => {
		let thrown: unknown;
		try {
			assertInputOrgMatchesProject("org-someone-else", orgProject);
		} catch (e) {
			thrown = e;
		}
		expect(thrown).toBeInstanceOf(ORPCError);
		expect((thrown as ORPCError<string, unknown>).code).toBe("BAD_REQUEST");
	});

	it("rejects naming an organization for a personal project", () => {
		expect(() =>
			assertInputOrgMatchesProject("org-9", personalProject),
		).toThrow(ORPCError);
	});
});
