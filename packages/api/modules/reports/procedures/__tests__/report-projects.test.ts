/**
 * `reports.project` and `reports.organizationProjects`, with the real report access
 * rules behind them: only the organization membership, the platform role and the
 * resolved project access are stood in for. The fields each query returns are pinned
 * in `packages/database/__tests__/list-projects-project-filter.test.ts`.
 */

import {
	resolveOrgPermissions,
	resolveProjectPermissions,
} from "@repo/permissions";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	handlers: [] as Array<(args: unknown) => Promise<unknown>>,
	access: vi.fn(),
	flag: vi.fn(),
	hasProjectAccess: vi.fn(),
	isPlatformAdmin: vi.fn(),
	isProjectSoftDeleted: vi.fn(),
	listProjects: vi.fn(),
	membership: vi.fn(),
	project: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getOrganizationMembership: m.membership,
	getProjectForReportsOnly: m.project,
	hasProjectAccess: m.hasProjectAccess,
	isFeatureEnabled: m.flag,
	isPlatformAdmin: m.isPlatformAdmin,
	isProjectSoftDeleted: m.isProjectSoftDeleted,
	listOrganizationProjectsForReports: m.listProjects,
}));
vi.mock("@repo/database/prisma/zod", async () => {
	const { z } = await import("zod");
	return { ProjectStatusSchema: z.enum(["ACTIVE", "DRAFT"]) };
});
vi.mock("../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: m.access,
}));
vi.mock("../../../../orpc/procedures", () => {
	const chain: Record<string, unknown> = {};
	Object.assign(chain, {
		use: () => chain,
		input: () => chain,
		handler: (fn: (args: unknown) => Promise<unknown>) => {
			m.handlers.push(fn);
			return {};
		},
	});
	return {
		tenantProtectedProcedure: chain,
		Permissions: { REPORT_READ: "report:read" },
		requireInputOrgPermission: () => () => chain,
		resolveOrganizationId: (input: string | null | undefined) => input,
	};
});

import "../report-projects";

const [projectHandler, organizationProjectsHandler] = m.handlers;

const ORG = "example-org";
const PROJECT = "example-project";
const context = { user: { id: "example-caller", role: "user" }, session: {} };
const narrowProject = { id: PROJECT, name: "Example project" };
const listed = { projects: [], total: 0, statusCounts: {} };

function holdsRole(
	orgRole: string | null,
	projectRole?: string,
	platformAdmin = false,
) {
	m.isPlatformAdmin.mockResolvedValue(platformAdmin);
	m.membership.mockResolvedValue(
		orgRole ? { role: orgRole, organization: { id: ORG } } : null,
	);
	m.hasProjectAccess.mockResolvedValue(projectRole !== undefined);
	if (projectRole) {
		m.access.mockResolvedValue({
			permissions: resolveProjectPermissions(projectRole),
			source: "project-member",
			organizationId: ORG,
			organizationDeleted: false,
		});
	} else if (orgRole) {
		m.access.mockResolvedValue({
			permissions: resolveOrgPermissions(orgRole),
			source: "org",
			organizationId: ORG,
			organizationDeleted: false,
		});
	} else {
		m.access.mockResolvedValue(null);
	}
}

beforeEach(() => {
	vi.clearAllMocks();
	m.flag.mockResolvedValue(true);
	m.isProjectSoftDeleted.mockResolvedValue(false);
	m.project.mockResolvedValue(narrowProject);
	m.listProjects.mockResolvedValue(listed);
});

describe("reports.project", () => {
	const read = (organizationId: string | null = ORG) =>
		projectHandler({ input: { id: PROJECT, organizationId }, context });

	it.each([
		["an organization Admin with no row", "admin", undefined, false],
		["an organization Owner with no row", "owner", undefined, false],
		["a system admin who is a member", "viewer", undefined, true],
		["a Member with a Viewer row", "member", "VIEWER", false],
		["a Viewer with an Editor row", "viewer", "EDITOR", false],
	])("gives %s the narrow project", async (_label, org, row, platform) => {
		holdsRole(org, row, platform);

		await expect(read()).resolves.toEqual({ project: narrowProject });
		expect(m.project).toHaveBeenCalledWith(PROJECT, ORG);
	});

	it.each([
		["an organization Member with no row", "member", undefined, false],
		["an organization Viewer with no row", "viewer", undefined, false],
		["a project guest who is no member", null, "EDITOR", false],
		["a system admin who is no member", null, undefined, true],
		["a member of a foreign organization", null, undefined, false],
	])("gives %s nothing", async (_label, org, row, platform) => {
		holdsRole(org, row, platform);

		await expect(read()).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.project).not.toHaveBeenCalled();
	});

	it("gives an admin with no row nothing where the report suite is off", async () => {
		holdsRole("admin");
		m.flag.mockResolvedValue(false);

		await expect(read()).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.flag).toHaveBeenCalledWith("REPORT_SUITE_V2", ORG);
		expect(m.project).not.toHaveBeenCalled();
	});

	it("keeps a project's own members served where the report suite is off", async () => {
		holdsRole("member", "VIEWER");
		m.flag.mockResolvedValue(false);

		await expect(read()).resolves.toEqual({ project: narrowProject });
	});

	it("gives nobody a project in the trash", async () => {
		holdsRole("admin");
		m.isProjectSoftDeleted.mockResolvedValue(true);

		await expect(read()).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.project).not.toHaveBeenCalled();
	});

	it("answers as for a missing project when the query finds none in the organization", async () => {
		holdsRole("admin");
		m.project.mockResolvedValue(null);

		await expect(read()).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});

describe("reports.organizationProjects", () => {
	const list = (organizationId: string | null = ORG) =>
		organizationProjectsHandler({
			input: { organizationId, limit: 50, offset: 0 },
			context,
		});

	it.each([
		["an organization Admin", "admin", false],
		["an organization Owner", "owner", false],
		["a system admin who is a member", "viewer", true],
	])("lists every live project for %s", async (_label, org, platform) => {
		holdsRole(org, undefined, platform);

		await expect(list()).resolves.toBe(listed);
		expect(m.listProjects).toHaveBeenCalledWith({
			userId: context.user.id,
			organizationId: ORG,
			limit: 50,
			offset: 0,
			status: undefined,
			search: undefined,
		});
	});

	it.each([
		["an organization Member", "member", undefined, false],
		["an organization Viewer", "viewer", undefined, false],
		["a Viewer with an Editor row", "viewer", "EDITOR", false],
		["a project guest who is no member", null, "EDITOR", false],
		["a system admin who is no member", null, undefined, true],
		["a member of a foreign organization", null, undefined, false],
	])("refuses %s", async (_label, org, row, platform) => {
		holdsRole(org, row, platform);

		await expect(list()).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.listProjects).not.toHaveBeenCalled();
	});

	it("refuses an admin where the report suite is off", async () => {
		holdsRole("admin");
		m.flag.mockResolvedValue(false);

		await expect(list()).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.listProjects).not.toHaveBeenCalled();
	});
});
