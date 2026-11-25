import { call, os } from "@orpc/server";
import { logger } from "@repo/logs";
import { type Permission, Permissions } from "@repo/permissions";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";

const db = vi.hoisted(() => ({
	project: { findUnique: vi.fn() },
	user: { findUnique: vi.fn() },
	member: { findFirst: vi.fn() },
	projectMember: { findFirst: vi.fn(), findUnique: vi.fn() },
}));
vi.mock("@repo/database", () => ({ db, grantProjectAccess: vi.fn() }));
vi.mock("@repo/logs", () => ({ logger: { error: vi.fn() } }));

import * as effectiveAccess from "../../../lib/effective-project-permissions";
import { getProjectPermissionDecision } from "../../../lib/project-permission-decision";
import { userHasProjectPermissionStrict } from "../../../modules/projects/lib/governance";
import {
	findParlumeAttendeeWithoutRead,
	mayReadParlumeProject,
} from "../../../modules/projects/lib/parlume-attendee-standing";

import {
	assertProjectPermission,
	getPermissionFromMiddleware,
	PERMISSION_MIDDLEWARE_TAG,
	requirePermissionAllowGuest,
	userHasProjectPermission,
} from "../require-permission";

const organizationId = "example-org";
const projectId = "example-project";
const userId = "example-user";
const project: {
	id: string;
	organizationId: string | null;
	userId: string;
	organization: { deletedAt: Date | null } | null;
} = {
	id: projectId,
	organizationId,
	userId: "example-owner",
	organization: { deletedAt: null },
};
const acceptedAt = new Date("2026-01-10T00:00:00Z");
const check = (
	permission: Permission = Permissions.PROJECT_SETTINGS_EDIT,
	id = projectId,
) => userHasProjectPermission({ userId, projectId: id, permission });

beforeEach(() => {
	vi.resetAllMocks();
	vi.stubEnv("RBAC_DRY_RUN", "false");
	db.project.findUnique.mockResolvedValue(project);
	db.projectMember.findUnique.mockResolvedValue(null);
	db.projectMember.findFirst.mockResolvedValue(null);
	db.member.findFirst.mockResolvedValue(null);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

it("reads the tag on a real callable permission middleware", () => {
	const middleware = requirePermissionAllowGuest(Permissions.PROJECT_READ);
	expect(getPermissionFromMiddleware(middleware)).toBe(
		Permissions.PROJECT_READ,
	);
});

it("reads the tag on an object and returns undefined for untagged values", () => {
	expect(
		getPermissionFromMiddleware({
			[PERMISSION_MIDDLEWARE_TAG]: Permissions.PROJECT_READ,
		}),
	).toBe(Permissions.PROJECT_READ);
	for (const value of [null, undefined, 1, {}, () => undefined]) {
		expect(getPermissionFromMiddleware(value)).toBeUndefined();
	}
});

it("fails closed on a database read failure and logs the operation safely", async () => {
	const failure = new Error("example sensitive query details");
	db.project.findUnique.mockRejectedValue(failure);
	await expect(check()).resolves.toBe(false);
	expect(logger.error).toHaveBeenCalledExactlyOnceWith(
		"Project permission lookup failed",
	);
	await expect(
		getProjectPermissionDecision({
			userId,
			projectId,
			permission: Permissions.PROJECT_READ,
		}),
	).resolves.toEqual({ allowed: false, organizationId: null });
	await expect(
		assertProjectPermission(projectId, userId, Permissions.PROJECT_READ),
	).rejects.toBe(failure);
	await expect(
		userHasProjectPermissionStrict(
			projectId,
			userId,
			Permissions.PROJECT_READ,
		),
	).rejects.toBe(failure);
});

type GateCase = {
	name: string;
	row?: typeof project | null;
	orgRole?: string;
	projectRole?: string;
	acceptance?: "pending" | "expired";
	permission?: Permission;
	allowed: boolean;
};

const organizationRoles = ["viewer", "member", "admin", "owner"];
const gateCases: GateCase[] = [
	...organizationRoles.map((orgRole) => ({
		name: `unreachable organization ${orgRole}`,
		orgRole,
		allowed: false,
		permission: Permissions.PROJECT_READ,
	})),
	...["admin", "owner"].map((orgRole) => ({
		name: `unreachable organization ${orgRole} requesting project settings edit`,
		orgRole,
		allowed: false,
	})),
	...organizationRoles.map((orgRole) => ({
		name: `creator with organization role ${orgRole}`,
		row: { ...project, userId },
		orgRole,
		allowed: orgRole === "admin" || orgRole === "owner",
	})),
	...["VIEWER", "COMMENTER", "EDITOR", "PROJECT_ADMIN", "OWNER"].map(
		(projectRole) => ({
			name: `active project ${projectRole} who is an org admin`,
			orgRole: "admin",
			projectRole,
			allowed: projectRole === "PROJECT_ADMIN" || projectRole === "OWNER",
		}),
	),
	{
		name: "pending row for a non-creator",
		orgRole: "owner",
		projectRole: "PROJECT_ADMIN",
		acceptance: "pending",
		allowed: false,
	},
	{
		name: "expired row for a non-creator",
		orgRole: "owner",
		projectRole: "PROJECT_ADMIN",
		acceptance: "expired",
		allowed: false,
	},
	{
		name: "pending row for an admin creator",
		row: { ...project, userId },
		orgRole: "admin",
		projectRole: "VIEWER",
		acceptance: "pending",
		allowed: true,
	},
	{
		name: "expired row for an admin creator",
		row: { ...project, userId },
		orgRole: "admin",
		projectRole: "VIEWER",
		acceptance: "expired",
		allowed: true,
	},
	{
		name: "organization member with a project admin row",
		orgRole: "member",
		projectRole: "PROJECT_ADMIN",
		allowed: true,
	},
	{
		name: "retained personal project non-owner",
		row: { ...project, organizationId: null, organization: null },
		allowed: false,
	},
	{
		name: "project admin guest",
		projectRole: "PROJECT_ADMIN",
		allowed: true,
	},
	{
		name: "viewer guest with project read",
		projectRole: "VIEWER",
		permission: Permissions.PROJECT_READ,
		allowed: true,
	},
	{
		name: "retained personal owner for an organization permission",
		row: { ...project, userId, organizationId: null, organization: null },
		permission: Permissions.ORG_SETTINGS_EDIT,
		allowed: true,
	},
	{
		name: "deleted organization with an active project admin",
		row: { ...project, organization: { deletedAt: acceptedAt } },
		projectRole: "PROJECT_ADMIN",
		allowed: false,
	},
	{ name: "missing project", row: null, allowed: false },
	{ name: "no project tie", allowed: false },
];

it.each(gateCases)("matches the project gate for $name", async (scenario) => {
	const row = scenario.row === undefined ? project : scenario.row;
	const permission = scenario.permission ?? Permissions.PROJECT_SETTINGS_EDIT;
	db.project.findUnique.mockResolvedValue(row);
	db.member.findFirst.mockResolvedValue(
		scenario.orgRole ? { role: scenario.orgRole } : null,
	);
	db.projectMember.findUnique.mockResolvedValue(
		scenario.projectRole
			? {
					role: scenario.projectRole,
					acceptedAt:
						scenario.acceptance === "pending" ? null : acceptedAt,
					expiresAt:
						scenario.acceptance === "expired" ? new Date(0) : null,
				}
			: null,
	);

	const gate = assertProjectPermission(projectId, userId, permission);
	if (scenario.allowed) {
		await expect(gate).resolves.toMatchObject({
			organizationId: row?.organizationId,
		});
	} else {
		await expect(gate).rejects.toMatchObject({
			code: expect.stringMatching(/NOT_FOUND|FORBIDDEN/),
		});
	}
	await expect(check(permission)).resolves.toBe(scenario.allowed);
	await expect(
		userHasProjectPermissionStrict(projectId, userId, permission),
	).resolves.toBe(scenario.allowed);
	await expect(
		getProjectPermissionDecision({ userId, projectId, permission }),
	).resolves.toEqual({
		allowed: scenario.allowed,
		organizationId: row?.organizationId ?? null,
	});
});

it("refuses a resolver result that gives the actor no project standing", async () => {
	// Isolate the source check from the usual accompanying visibility refusal.
	vi.spyOn(
		effectiveAccess,
		"resolveEffectiveProjectPermissions",
	).mockResolvedValue({
		organizationId,
		source: "none",
		isVisible: true,
		permissions: [Permissions.PROJECT_READ],
	});
	await expect(check(Permissions.PROJECT_READ)).resolves.toBe(false);
});

it("treats an organization member without project reach as an unverified Parlume attendee", async () => {
	db.member.findFirst.mockResolvedValue({ role: "member" });
	db.user.findUnique.mockResolvedValue({ name: "Example Participant" });
	await expect(mayReadParlumeProject({ userId, projectId })).resolves.toBe(
		false,
	);
	await expect(
		findParlumeAttendeeWithoutRead({ projectId, userIds: [userId] }),
	).resolves.toEqual({ name: "Example Participant" });
});

it("grants a guest read on the invited object and refuses edits and other projects", async () => {
	db.project.findUnique.mockImplementation(async ({ where }) => ({
		...project,
		id: where.id,
	}));
	db.projectMember.findUnique.mockImplementation(async ({ where }) =>
		where.projectId_userId.projectId === projectId
			? { role: "VIEWER", acceptedAt, expiresAt: null }
			: null,
	);
	await expect(check(Permissions.PROJECT_READ)).resolves.toBe(true);
	await expect(check()).resolves.toBe(false);
	expect(db.member.findFirst).not.toHaveBeenCalled();
	await expect(
		check(Permissions.PROJECT_READ, "other-project"),
	).resolves.toBe(false);
	expect(db.projectMember.findUnique).toHaveBeenLastCalledWith({
		where: { projectId_userId: { projectId: "other-project", userId } },
		select: { role: true, acceptedAt: true, expiresAt: true },
	});
	expect(db.member.findFirst).toHaveBeenCalledWith({
		where: { organizationId, userId },
		select: { role: true },
	});
});

it.each([
	{ name: "pending", acceptedAt: null, expiresAt: null },
	{ name: "expired", acceptedAt, expiresAt: new Date(0) },
])("ignores a $name project membership", async ({ name: _, ...dates }) => {
	db.projectMember.findUnique.mockResolvedValue({
		role: "PROJECT_ADMIN",
		...dates,
	});
	await expect(check()).resolves.toBe(false);
	expect(db.member.findFirst).toHaveBeenCalledWith({
		where: { organizationId, userId },
		select: { role: true },
	});
});

it.each(["admin", "member"])(
	"evaluates the creator's live organization role (%s)",
	async (role) => {
		db.project.findUnique.mockResolvedValue({ ...project, userId });
		db.member.findFirst.mockResolvedValue({ role });
		await expect(check()).resolves.toBe(role === "admin");
		expect(db.member.findFirst).toHaveBeenCalledWith({
			where: { organizationId, userId },
			select: { role: true },
		});
	},
);

const handler = vi.fn(() => "list allowed");
const guestList = os
	.$context<{
		user: { id: string };
		session: { activeOrganizationId?: string | null };
		activeOrganizationRole: string | null;
		allowedProjectIds: string[];
		tenantContext: {
			userId: string;
			type: "organization" | "personal";
			organizationId: string | null;
		};
	}>()
	.input(z.object({ organizationId: z.string().nullable().optional() }))
	.use(requirePermissionAllowGuest(Permissions.PROJECT_READ))
	.handler(handler);
const ctx = {
	user: { id: userId },
	session: { activeOrganizationId: organizationId },
	activeOrganizationRole: null,
	allowedProjectIds: [],
	tenantContext: { userId, type: "organization" as const, organizationId },
};

it("admits the guest list only when an accepted project belongs to the requested organization", async () => {
	db.projectMember.findFirst
		.mockResolvedValueOnce({ id: "example-member" })
		.mockResolvedValueOnce(null);
	await expect(call(guestList, {}, { context: ctx })).resolves.toBe(
		"list allowed",
	);
	await expect(
		call(guestList, { organizationId: "other-org" }, { context: ctx }),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	for (const [index, org] of [organizationId, "other-org"].entries()) {
		expect(db.projectMember.findFirst).toHaveBeenNthCalledWith(index + 1, {
			where: {
				userId,
				acceptedAt: { not: null },
				OR: [
					{ expiresAt: null },
					{ expiresAt: { gt: expect.any(Date) } },
				],
				project: { organizationId: org },
			},
			select: { id: true },
		});
	}
	expect(handler).toHaveBeenCalledOnce();
});

it("does not fall back to the session for explicit null organization", async () => {
	await expect(
		call(guestList, { organizationId: null }, { context: ctx }),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	expect(db.projectMember.findFirst).not.toHaveBeenCalled();
	expect(handler).not.toHaveBeenCalled();
});

it("denies a guest list without an input or session organization", async () => {
	await expect(
		call(guestList, {}, { context: { ...ctx, session: {} } }),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	expect(db.projectMember.findFirst).not.toHaveBeenCalled();
	expect(handler).not.toHaveBeenCalled();
});

it("defers the retained personal context arm to tenant filtering", async () => {
	await expect(
		call(
			guestList,
			{},
			{
				context: {
					...ctx,
					tenantContext: {
						userId,
						type: "personal",
						organizationId: null,
					},
				},
			},
		),
	).resolves.toBe("list allowed");
	expect(db.projectMember.findFirst).not.toHaveBeenCalled();
});
