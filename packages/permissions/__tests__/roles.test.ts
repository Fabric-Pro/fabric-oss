import { describe, expect, it } from "vitest";
import { hasPermission } from "../lib/evaluator";
import { Permissions } from "../lib/permissions";
import { ORG_ROLE_PERMISSIONS, PROJECT_ROLE_PERMISSIONS } from "../lib/roles";

describe("ORG_ROLE_PERMISSIONS", () => {
	it("owner has ORG_DELETE", () => {
		expect(
			hasPermission(ORG_ROLE_PERMISSIONS.owner, Permissions.ORG_DELETE),
		).toBe(true);
	});

	it("admin does NOT have ORG_DELETE", () => {
		expect(
			hasPermission(ORG_ROLE_PERMISSIONS.admin, Permissions.ORG_DELETE),
		).toBe(false);
	});

	it("admin has ORG_BILLING_MANAGE", () => {
		expect(
			hasPermission(
				ORG_ROLE_PERMISSIONS.admin,
				Permissions.ORG_BILLING_MANAGE,
			),
		).toBe(true);
	});

	it("member does NOT have ORG_BILLING_READ", () => {
		expect(
			hasPermission(
				ORG_ROLE_PERMISSIONS.member,
				Permissions.ORG_BILLING_READ,
			),
		).toBe(false);
	});

	it("admin has ORG_MEMBERS_INVITE", () => {
		expect(
			hasPermission(
				ORG_ROLE_PERMISSIONS.admin,
				Permissions.ORG_MEMBERS_INVITE,
			),
		).toBe(true);
	});

	it("member does NOT have ORG_MEMBERS_INVITE", () => {
		expect(
			hasPermission(
				ORG_ROLE_PERMISSIONS.member,
				Permissions.ORG_MEMBERS_INVITE,
			),
		).toBe(false);
	});

	it("member has PROJECT_CREATE", () => {
		expect(
			hasPermission(
				ORG_ROLE_PERMISSIONS.member,
				Permissions.PROJECT_CREATE,
			),
		).toBe(true);
	});

	it("viewer does NOT have PROJECT_CREATE", () => {
		expect(
			hasPermission(
				ORG_ROLE_PERMISSIONS.viewer,
				Permissions.PROJECT_CREATE,
			),
		).toBe(false);
	});

	it("viewer has PROJECT_READ", () => {
		expect(
			hasPermission(
				ORG_ROLE_PERMISSIONS.viewer,
				Permissions.PROJECT_READ,
			),
		).toBe(true);
	});

	it("admin has ORG_AUDIT_LOG_READ", () => {
		expect(
			hasPermission(
				ORG_ROLE_PERMISSIONS.admin,
				Permissions.ORG_AUDIT_LOG_READ,
			),
		).toBe(true);
	});

	it("admin has ORG_AUDIT_LOG_EXPORT", () => {
		expect(
			hasPermission(
				ORG_ROLE_PERMISSIONS.admin,
				Permissions.ORG_AUDIT_LOG_EXPORT,
			),
		).toBe(true);
	});

	it("owner has ORG_AUDIT_LOG_READ and ORG_AUDIT_LOG_EXPORT", () => {
		expect(
			hasPermission(
				ORG_ROLE_PERMISSIONS.owner,
				Permissions.ORG_AUDIT_LOG_READ,
			),
		).toBe(true);
		expect(
			hasPermission(
				ORG_ROLE_PERMISSIONS.owner,
				Permissions.ORG_AUDIT_LOG_EXPORT,
			),
		).toBe(true);
	});

	it("member does NOT have ORG_AUDIT_LOG_READ", () => {
		expect(
			hasPermission(
				ORG_ROLE_PERMISSIONS.member,
				Permissions.ORG_AUDIT_LOG_READ,
			),
		).toBe(false);
	});

	it("viewer does NOT have ORG_AUDIT_LOG_READ", () => {
		expect(
			hasPermission(
				ORG_ROLE_PERMISSIONS.viewer,
				Permissions.ORG_AUDIT_LOG_READ,
			),
		).toBe(false);
	});

	it("owner is a superset of admin", () => {
		for (const p of ORG_ROLE_PERMISSIONS.admin) {
			expect(ORG_ROLE_PERMISSIONS.owner).toContain(p);
		}
	});

	it("admin is a superset of member", () => {
		for (const p of ORG_ROLE_PERMISSIONS.member) {
			expect(ORG_ROLE_PERMISSIONS.admin).toContain(p);
		}
	});

	it("member is a superset of viewer", () => {
		for (const p of ORG_ROLE_PERMISSIONS.viewer) {
			expect(ORG_ROLE_PERMISSIONS.member).toContain(p);
		}
	});
});

describe("PROJECT_ROLE_PERMISSIONS", () => {
	it("OWNER has PROJECT_DELETE", () => {
		expect(
			hasPermission(
				PROJECT_ROLE_PERMISSIONS.OWNER,
				Permissions.PROJECT_DELETE,
			),
		).toBe(true);
	});

	it("PROJECT_ADMIN does NOT have PROJECT_DELETE", () => {
		expect(
			hasPermission(
				PROJECT_ROLE_PERMISSIONS.PROJECT_ADMIN,
				Permissions.PROJECT_DELETE,
			),
		).toBe(false);
	});

	it("PROJECT_ADMIN has PROJECT_MEMBERS_MANAGE", () => {
		expect(
			hasPermission(
				PROJECT_ROLE_PERMISSIONS.PROJECT_ADMIN,
				Permissions.PROJECT_MEMBERS_MANAGE,
			),
		).toBe(true);
	});

	it("EDITOR has DOCUMENT_UPDATE", () => {
		expect(
			hasPermission(
				PROJECT_ROLE_PERMISSIONS.EDITOR,
				Permissions.DOCUMENT_UPDATE,
			),
		).toBe(true);
	});

	it("EDITOR does NOT have PROJECT_MEMBERS_MANAGE", () => {
		expect(
			hasPermission(
				PROJECT_ROLE_PERMISSIONS.EDITOR,
				Permissions.PROJECT_MEMBERS_MANAGE,
			),
		).toBe(false);
	});

	it("COMMENTER has COMMENT_CREATE", () => {
		expect(
			hasPermission(
				PROJECT_ROLE_PERMISSIONS.COMMENTER,
				Permissions.COMMENT_CREATE,
			),
		).toBe(true);
	});

	it("COMMENTER does NOT have DOCUMENT_UPDATE", () => {
		expect(
			hasPermission(
				PROJECT_ROLE_PERMISSIONS.COMMENTER,
				Permissions.DOCUMENT_UPDATE,
			),
		).toBe(false);
	});

	it("VIEWER has PROJECT_READ", () => {
		expect(
			hasPermission(
				PROJECT_ROLE_PERMISSIONS.VIEWER,
				Permissions.PROJECT_READ,
			),
		).toBe(true);
	});

	it("VIEWER does NOT have COMMENT_CREATE", () => {
		expect(
			hasPermission(
				PROJECT_ROLE_PERMISSIONS.VIEWER,
				Permissions.COMMENT_CREATE,
			),
		).toBe(false);
	});

	it("OWNER is a superset of PROJECT_ADMIN", () => {
		for (const p of PROJECT_ROLE_PERMISSIONS.PROJECT_ADMIN) {
			expect(PROJECT_ROLE_PERMISSIONS.OWNER).toContain(p);
		}
	});

	it("PROJECT_ADMIN is a superset of EDITOR", () => {
		for (const p of PROJECT_ROLE_PERMISSIONS.EDITOR) {
			expect(PROJECT_ROLE_PERMISSIONS.PROJECT_ADMIN).toContain(p);
		}
	});

	it("EDITOR is a superset of COMMENTER", () => {
		for (const p of PROJECT_ROLE_PERMISSIONS.COMMENTER) {
			expect(PROJECT_ROLE_PERMISSIONS.EDITOR).toContain(p);
		}
	});

	it("COMMENTER is a superset of VIEWER", () => {
		for (const p of PROJECT_ROLE_PERMISSIONS.VIEWER) {
			expect(PROJECT_ROLE_PERMISSIONS.COMMENTER).toContain(p);
		}
	});
});

// Regression tests for the stale-role-authorization migration. Each case
// locks in the specific PROJECT_ADMIN capability that motivated the migration
// away from the legacy lowercase-only helpers. If a future role-matrix edit
// removes one of these, it will break user-facing flows (edit project,
// manage members, connect integrations, delete stories) and the test will
// flag the regression.
describe("PROJECT_ADMIN regression coverage", () => {
	it("PROJECT_ADMIN has PROJECT_UPDATE (reported bug: edit project)", () => {
		expect(
			hasPermission(
				PROJECT_ROLE_PERMISSIONS.PROJECT_ADMIN,
				Permissions.PROJECT_UPDATE,
			),
		).toBe(true);
	});

	it("PROJECT_ADMIN has STORY_DELETE", () => {
		expect(
			hasPermission(
				PROJECT_ROLE_PERMISSIONS.PROJECT_ADMIN,
				Permissions.STORY_DELETE,
			),
		).toBe(true);
	});

	it("PROJECT_ADMIN has PROJECT_MEMBERS_MANAGE (manage members)", () => {
		expect(
			hasPermission(
				PROJECT_ROLE_PERMISSIONS.PROJECT_ADMIN,
				Permissions.PROJECT_MEMBERS_MANAGE,
			),
		).toBe(true);
	});

	it("PROJECT_ADMIN has PROJECT_SETTINGS_EDIT (connect integrations)", () => {
		expect(
			hasPermission(
				PROJECT_ROLE_PERMISSIONS.PROJECT_ADMIN,
				Permissions.PROJECT_SETTINGS_EDIT,
			),
		).toBe(true);
	});

	it("PROJECT_ADMIN does NOT have PROJECT_DELETE (stays owner-only)", () => {
		expect(
			hasPermission(
				PROJECT_ROLE_PERMISSIONS.PROJECT_ADMIN,
				Permissions.PROJECT_DELETE,
			),
		).toBe(false);
	});
});
