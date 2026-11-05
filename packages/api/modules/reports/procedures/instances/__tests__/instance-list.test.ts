/**
 * `reports.instances.list` for a project, with the real report access rules behind
 * it: only the organization membership, the platform role and the resolved project
 * access are stood in for.
 */

import {
	resolveOrgPermissions,
	resolveProjectPermissions,
} from "@repo/permissions";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	handler: undefined as undefined | ((args: unknown) => Promise<unknown>),
	access: vi.fn(),
	assertProject: vi.fn(),
	hasProjectAccess: vi.fn(),
	isPlatformAdmin: vi.fn(),
	isProjectSoftDeleted: vi.fn(),
	list: vi.fn(),
	membership: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getOrganizationMembership: m.membership,
	getProjectReportSetupReason: () => undefined,
	hasProjectAccess: m.hasProjectAccess,
	isPlatformAdmin: m.isPlatformAdmin,
	isProjectSoftDeleted: m.isProjectSoftDeleted,
	listTemplateInstances: m.list,
}));
vi.mock("../../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: m.access,
}));
vi.mock("../../../../../orpc/procedures", () => {
	const chain: Record<string, unknown> = {};
	Object.assign(chain, {
		use: () => chain,
		input: () => chain,
		handler: (fn: (args: unknown) => Promise<unknown>) => {
			m.handler = fn;
			return {};
		},
	});
	return {
		tenantProtectedProcedure: chain,
		Permissions: { REPORT_READ: "report:read" },
		assertProjectPermission: m.assertProject,
		requirePermission: () => () => chain,
		resolveOrganizationId: (input: string | null | undefined) => input,
	};
});

import "../list";

const ORG = "example-org";
const PROJECT = "example-project";
const context = { user: { id: "example-caller", role: "user" }, session: {} };

function holdsRole(orgRole: string | null, projectRole?: string) {
	m.membership.mockResolvedValue(
		orgRole ? { role: orgRole, organization: { id: ORG } } : null,
	);
	m.hasProjectAccess.mockResolvedValue(projectRole !== undefined);
	m.access.mockResolvedValue({
		permissions: projectRole
			? resolveProjectPermissions(projectRole)
			: resolveOrgPermissions(orgRole ?? "viewer"),
		source: projectRole ? "project-member" : "org",
		organizationId: ORG,
		organizationDeleted: false,
	});
}

function report(overrides: Record<string, unknown> = {}) {
	return {
		id: "example-report",
		sId: "example-sid",
		version: 1,
		status: "ACTIVE",
		name: "Example report",
		description: null,
		templateId: "example-template",
		template: { name: "Example template", definition: {}, connections: {} },
		projectId: PROJECT,
		userId: "example-owner",
		isActive: true,
		connections: {},
		fabricConfig: null,
		parameterDefaults: null,
		executions: [],
		schedule: null,
		scheduleMode: "INHERIT",
		lastRunAt: null,
		nextRunAt: null,
		createdAt: new Date(0),
		updatedAt: new Date(0),
		_count: { executions: 0 },
		...overrides,
	};
}

function call(input: Record<string, unknown> = {}) {
	if (!m.handler) {
		throw new Error("The procedure did not register a handler");
	}
	return m.handler({
		input: {
			projectId: PROJECT,
			organizationId: ORG,
			ownedByCaller: false,
			limit: 20,
			offset: 0,
			...input,
		},
		context,
	}) as Promise<{ instances: Array<{ id: string; canGenerate: boolean }> }>;
}

beforeEach(() => {
	vi.clearAllMocks();
	m.assertProject.mockResolvedValue(undefined);
	m.isPlatformAdmin.mockResolvedValue(false);
	m.isProjectSoftDeleted.mockResolvedValue(false);
	m.list.mockResolvedValue({ instances: [], total: 0 });
});

describe("reports.instances.list with a project", () => {
	it.each([
		["a project guest who is no member", null, "EDITOR"],
		["a member with no row on the project", "member", undefined],
		["a Viewer with no row on the project", "viewer", undefined],
	])(
		"gives %s nothing, though the project itself let them read",
		async (_label, org, row) => {
			holdsRole(org, row);

			await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(m.list).not.toHaveBeenCalled();
		},
	);

	it.each([
		["a member with a Viewer row", "member", "VIEWER"],
		["a Viewer with an Editor row", "viewer", "EDITOR"],
		["an organization Admin with no row", "admin", undefined],
	])("lists the project's reports for %s", async (_label, org, row) => {
		holdsRole(org, row);

		await call();

		expect(m.list).toHaveBeenCalledTimes(1);
	});

	it("keeps asking the project first, so nobody learns of a project they cannot read", async () => {
		m.assertProject.mockRejectedValue(new Error("Project access denied"));

		await expect(call()).rejects.toThrow("Project access denied");
		expect(m.membership).not.toHaveBeenCalled();
		expect(m.list).not.toHaveBeenCalled();
	});

	it("passes the caller's own-reports filter on", async () => {
		holdsRole("member", "EDITOR");

		await call({ ownedByCaller: true });

		expect(m.list).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: PROJECT,
				ownedByCaller: true,
			}),
		);
	});

	it("says a report can be generated only for its owner while their role allows it", async () => {
		holdsRole("member", "EDITOR");
		m.list.mockResolvedValue({
			instances: [
				report({ id: "own", userId: context.user.id }),
				report({ id: "other" }),
			],
			total: 2,
		});

		const { instances } = await call();

		expect(
			instances.map(({ id, canGenerate }) => [id, canGenerate]),
		).toEqual([
			["own", true],
			["other", false],
		]);
	});

	it("says an owner with a Viewer row cannot generate their report", async () => {
		holdsRole("member", "VIEWER");
		m.list.mockResolvedValue({
			instances: [report({ id: "own", userId: context.user.id })],
			total: 1,
		});

		const { instances } = await call();

		expect(instances[0].canGenerate).toBe(false);
	});
});
