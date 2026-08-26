/**
 * Verifies `userHasProjectPermission` mirrors the resolution order of the
 * `requireProjectPermission` oRPC middleware, so callers that cannot install
 * middleware (OAuth callbacks, capability flags baked into payloads) still
 * enforce the same rules:
 *
 *   Path A: personal-project owner
 *   Path B: org role on the project's host org grants the permission
 *   Path C: ProjectMember role grants the permission (accepted + unexpired)
 *
 * Regression guard for bug 1018 — the original implementation in
 * connect/disconnect/github-oauth collapsed to `getProjectRole() === "owner"`,
 * which blocked org admins and project PROJECT_ADMIN members from editing
 * repo integration settings.
 */

import { Permissions } from "@repo/permissions";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	db: {
		project: { findUnique: vi.fn() },
		member: { findFirst: vi.fn() },
		projectMember: { findUnique: vi.fn() },
	},
}));

async function loadHelper() {
	const mod = await import("../project-permissions");
	return mod.userHasProjectPermission;
}

async function getMockDb() {
	const mod = await import("@repo/database");
	return mod.db as unknown as {
		project: { findUnique: ReturnType<typeof vi.fn> };
		member: { findFirst: ReturnType<typeof vi.fn> };
		projectMember: { findUnique: ReturnType<typeof vi.fn> };
	};
}

const ORG_ID = "org-A";
const PROJECT_ID = "proj-1";
const CREATOR_ID = "user-creator";
const ORG_ADMIN_ID = "user-org-admin";
const _ORG_MEMBER_ID = "user-org-member";
const PROJECT_ADMIN_ID = "user-project-admin";
const PROJECT_EDITOR_ID = "user-project-editor";
const OUTSIDER_ID = "user-outsider";

beforeEach(async () => {
	const db = await getMockDb();
	db.project.findUnique.mockReset();
	db.member.findFirst.mockReset();
	db.projectMember.findUnique.mockReset();
});

describe("userHasProjectPermission — personal project", () => {
	it("owner → true", async () => {
		const db = await getMockDb();
		db.project.findUnique.mockResolvedValue({
			userId: CREATOR_ID,
			organizationId: null,
		});

		const userHasProjectPermission = await loadHelper();
		const result = await userHasProjectPermission(
			PROJECT_ID,
			CREATOR_ID,
			Permissions.PROJECT_SETTINGS_EDIT,
		);
		expect(result).toBe(true);
	});

	it("non-owner with no ProjectMember → false", async () => {
		const db = await getMockDb();
		db.project.findUnique.mockResolvedValue({
			userId: CREATOR_ID,
			organizationId: null,
		});
		db.projectMember.findUnique.mockResolvedValue(null);

		const userHasProjectPermission = await loadHelper();
		const result = await userHasProjectPermission(
			PROJECT_ID,
			OUTSIDER_ID,
			Permissions.PROJECT_SETTINGS_EDIT,
		);
		expect(result).toBe(false);
	});
});

describe("userHasProjectPermission — org project", () => {
	it("org admin (not creator, no ProjectMember) has PROJECT_SETTINGS_EDIT → true", async () => {
		// Regression guard for bug 1018: org admins are granted
		// PROJECT_SETTINGS_EDIT via the org role matrix even without an
		// explicit ProjectMember row. The old creator-only check blocked this.
		const db = await getMockDb();
		db.project.findUnique.mockResolvedValue({
			userId: CREATOR_ID,
			organizationId: ORG_ID,
		});
		db.member.findFirst.mockResolvedValue({ role: "admin" });

		const userHasProjectPermission = await loadHelper();
		const result = await userHasProjectPermission(
			PROJECT_ID,
			ORG_ADMIN_ID,
			Permissions.PROJECT_SETTINGS_EDIT,
		);
		expect(result).toBe(true);
	});

	it("org owner (not creator) has PROJECT_SETTINGS_EDIT → true", async () => {
		const db = await getMockDb();
		db.project.findUnique.mockResolvedValue({
			userId: CREATOR_ID,
			organizationId: ORG_ID,
		});
		db.member.findFirst.mockResolvedValue({ role: "owner" });

		const userHasProjectPermission = await loadHelper();
		const result = await userHasProjectPermission(
			PROJECT_ID,
			ORG_ADMIN_ID,
			Permissions.PROJECT_SETTINGS_EDIT,
		);
		expect(result).toBe(true);
	});

	it("org member without the permission falls back to ProjectMember path", async () => {
		const db = await getMockDb();
		db.project.findUnique.mockResolvedValue({
			userId: CREATOR_ID,
			organizationId: ORG_ID,
		});
		// `member` role does not grant PROJECT_SETTINGS_EDIT
		db.member.findFirst.mockResolvedValue({ role: "member" });
		// ...but the user has an accepted PROJECT_ADMIN ProjectMember row
		db.projectMember.findUnique.mockResolvedValue({
			role: "PROJECT_ADMIN",
			acceptedAt: new Date("2026-01-01"),
			expiresAt: null,
		});

		const userHasProjectPermission = await loadHelper();
		const result = await userHasProjectPermission(
			PROJECT_ID,
			PROJECT_ADMIN_ID,
			Permissions.PROJECT_SETTINGS_EDIT,
		);
		expect(result).toBe(true);
	});

	it("ProjectMember role=EDITOR is denied PROJECT_SETTINGS_EDIT", async () => {
		const db = await getMockDb();
		db.project.findUnique.mockResolvedValue({
			userId: CREATOR_ID,
			organizationId: ORG_ID,
		});
		db.member.findFirst.mockResolvedValue({ role: "member" });
		db.projectMember.findUnique.mockResolvedValue({
			role: "EDITOR",
			acceptedAt: new Date("2026-01-01"),
			expiresAt: null,
		});

		const userHasProjectPermission = await loadHelper();
		const result = await userHasProjectPermission(
			PROJECT_ID,
			PROJECT_EDITOR_ID,
			Permissions.PROJECT_SETTINGS_EDIT,
		);
		expect(result).toBe(false);
	});

	it("ProjectMember without acceptedAt → false", async () => {
		const db = await getMockDb();
		db.project.findUnique.mockResolvedValue({
			userId: CREATOR_ID,
			organizationId: ORG_ID,
		});
		db.member.findFirst.mockResolvedValue(null);
		db.projectMember.findUnique.mockResolvedValue({
			role: "PROJECT_ADMIN",
			acceptedAt: null,
			expiresAt: null,
		});

		const userHasProjectPermission = await loadHelper();
		const result = await userHasProjectPermission(
			PROJECT_ID,
			PROJECT_ADMIN_ID,
			Permissions.PROJECT_SETTINGS_EDIT,
		);
		expect(result).toBe(false);
	});

	it("expired ProjectMember → false", async () => {
		const db = await getMockDb();
		db.project.findUnique.mockResolvedValue({
			userId: CREATOR_ID,
			organizationId: ORG_ID,
		});
		db.member.findFirst.mockResolvedValue(null);
		db.projectMember.findUnique.mockResolvedValue({
			role: "PROJECT_ADMIN",
			acceptedAt: new Date("2026-01-01"),
			expiresAt: new Date("2026-02-01"), // expired
		});

		const userHasProjectPermission = await loadHelper();
		const result = await userHasProjectPermission(
			PROJECT_ID,
			PROJECT_ADMIN_ID,
			Permissions.PROJECT_SETTINGS_EDIT,
		);
		expect(result).toBe(false);
	});

	it("outsider (no OrgMember, no ProjectMember) → false", async () => {
		const db = await getMockDb();
		db.project.findUnique.mockResolvedValue({
			userId: CREATOR_ID,
			organizationId: ORG_ID,
		});
		db.member.findFirst.mockResolvedValue(null);
		db.projectMember.findUnique.mockResolvedValue(null);

		const userHasProjectPermission = await loadHelper();
		const result = await userHasProjectPermission(
			PROJECT_ID,
			OUTSIDER_ID,
			Permissions.PROJECT_SETTINGS_EDIT,
		);
		expect(result).toBe(false);
	});

	it("nonexistent project → false", async () => {
		const db = await getMockDb();
		db.project.findUnique.mockResolvedValue(null);

		const userHasProjectPermission = await loadHelper();
		const result = await userHasProjectPermission(
			"missing",
			CREATOR_ID,
			Permissions.PROJECT_SETTINGS_EDIT,
		);
		expect(result).toBe(false);
	});

	it("ProjectMember role=OWNER gets PROJECT_SETTINGS_EDIT", async () => {
		const db = await getMockDb();
		db.project.findUnique.mockResolvedValue({
			userId: CREATOR_ID,
			organizationId: ORG_ID,
		});
		db.member.findFirst.mockResolvedValue({ role: "member" });
		db.projectMember.findUnique.mockResolvedValue({
			role: "OWNER",
			acceptedAt: new Date("2026-01-01"),
			expiresAt: null,
		});

		const userHasProjectPermission = await loadHelper();
		const result = await userHasProjectPermission(
			PROJECT_ID,
			"someone",
			Permissions.PROJECT_SETTINGS_EDIT,
		);
		expect(result).toBe(true);
	});
});
