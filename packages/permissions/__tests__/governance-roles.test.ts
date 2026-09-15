import { describe, expect, it } from "vitest";
import { hasPermission } from "../lib/evaluator";
import { Permissions } from "../lib/permissions";
import { ORG_ROLE_PERMISSIONS, PROJECT_ROLE_PERMISSIONS } from "../lib/roles";

/**
 * Role-matrix tests for the two governance keys introduced by the
 * inverted-loop plan (docs/features/inverted-loop-delivery-tracks.md §3.4).
 * The coverage test only proves a procedure declares a valid key; these
 * assert which roles hold and lack the keys.
 */
describe("PROJECT_GOVERNANCE_MANAGE", () => {
	it("is granted to org owner and admin only", () => {
		expect(
			hasPermission(
				ORG_ROLE_PERMISSIONS.owner,
				Permissions.PROJECT_GOVERNANCE_MANAGE,
			),
		).toBe(true);
		expect(
			hasPermission(
				ORG_ROLE_PERMISSIONS.admin,
				Permissions.PROJECT_GOVERNANCE_MANAGE,
			),
		).toBe(true);
		expect(
			hasPermission(
				ORG_ROLE_PERMISSIONS.member,
				Permissions.PROJECT_GOVERNANCE_MANAGE,
			),
		).toBe(false);
		expect(
			hasPermission(
				ORG_ROLE_PERMISSIONS.viewer,
				Permissions.PROJECT_GOVERNANCE_MANAGE,
			),
		).toBe(false);
	});

	it("is granted to project OWNER only; editors cannot downgrade governance", () => {
		expect(
			hasPermission(
				PROJECT_ROLE_PERMISSIONS.OWNER,
				Permissions.PROJECT_GOVERNANCE_MANAGE,
			),
		).toBe(true);
		for (const role of [
			"PROJECT_ADMIN",
			"EDITOR",
			"COMMENTER",
			"VIEWER",
		] as const) {
			expect(
				hasPermission(
					PROJECT_ROLE_PERMISSIONS[role],
					Permissions.PROJECT_GOVERNANCE_MANAGE,
				),
			).toBe(false);
		}
	});

	it("editors keep PROJECT_UPDATE, so the split is meaningful", () => {
		expect(
			hasPermission(
				PROJECT_ROLE_PERMISSIONS.EDITOR,
				Permissions.PROJECT_UPDATE,
			),
		).toBe(true);
	});
});

describe("STORY_STAGE_APPROVE", () => {
	it("is granted to org owner and admin, not member or viewer", () => {
		expect(
			hasPermission(
				ORG_ROLE_PERMISSIONS.owner,
				Permissions.STORY_STAGE_APPROVE,
			),
		).toBe(true);
		expect(
			hasPermission(
				ORG_ROLE_PERMISSIONS.admin,
				Permissions.STORY_STAGE_APPROVE,
			),
		).toBe(true);
		expect(
			hasPermission(
				ORG_ROLE_PERMISSIONS.member,
				Permissions.STORY_STAGE_APPROVE,
			),
		).toBe(false);
		expect(
			hasPermission(
				ORG_ROLE_PERMISSIONS.viewer,
				Permissions.STORY_STAGE_APPROVE,
			),
		).toBe(false);
	});

	it("is granted to project OWNER and PROJECT_ADMIN, not EDITOR/COMMENTER/VIEWER", () => {
		expect(
			hasPermission(
				PROJECT_ROLE_PERMISSIONS.OWNER,
				Permissions.STORY_STAGE_APPROVE,
			),
		).toBe(true);
		expect(
			hasPermission(
				PROJECT_ROLE_PERMISSIONS.PROJECT_ADMIN,
				Permissions.STORY_STAGE_APPROVE,
			),
		).toBe(true);
		for (const role of ["EDITOR", "COMMENTER", "VIEWER"] as const) {
			expect(
				hasPermission(
					PROJECT_ROLE_PERMISSIONS[role],
					Permissions.STORY_STAGE_APPROVE,
				),
			).toBe(false);
		}
	});

	it("uses the <domain>:<resource>:<action> naming rule", () => {
		expect(Permissions.PROJECT_GOVERNANCE_MANAGE).toBe(
			"project:governance:manage",
		);
		expect(Permissions.STORY_STAGE_APPROVE).toBe("story:stage:approve");
	});
});
