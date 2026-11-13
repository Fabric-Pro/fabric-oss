/**
 * The instance procedures admitted on membership alone, with the real role rules
 * behind them: `archive`, `delete`, `restore` and `testConnections`.
 */

import {
	resolveOrgPermissions,
	resolveProjectPermissions,
} from "@repo/permissions";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	handlers: [] as Array<(args: unknown) => Promise<unknown>>,
	instance: vi.fn(),
	isPlatformAdmin: vi.fn(),
	membership: vi.fn(),
	access: vi.fn(),
	hasProjectAccess: vi.fn(),
	isProjectSoftDeleted: vi.fn(),
	checker: vi.fn(),
	archive: vi.fn(),
	remove: vi.fn(),
	restore: vi.fn(),
	probe: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getTemplateInstance: m.instance,
	isPlatformAdmin: m.isPlatformAdmin,
	getOrganizationMembership: m.membership,
	hasProjectAccess: m.hasProjectAccess,
	isProjectSoftDeleted: m.isProjectSoftDeleted,
	canAccessReportInstance: m.checker,
	archiveReportInstanceVersion: m.archive,
	deleteTemplateInstance: m.remove,
	restoreReportInstanceVersion: m.restore,
}));
vi.mock("../../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: m.access,
}));
vi.mock("../../../lib/report-connection-test", () => ({
	probeReportConnections: m.probe,
}));
vi.mock("../../../../../orpc/procedures", () => {
	const chain: Record<string, unknown> = {};
	Object.assign(chain, {
		use: () => chain,
		meta: () => chain,
		input: () => chain,
		output: () => chain,
		handler: (fn: (args: unknown) => Promise<unknown>) => {
			m.handlers.push(fn);
			return {};
		},
	});
	return {
		tenantProtectedProcedure: chain,
		// The real values: the handlers ask the real role tables for them.
		Permissions: {
			REPORT_READ: "report:read",
			REPORT_UPDATE: "report:update",
			REPORT_DELETE: "report:delete",
			REPORT_EXECUTE: "report:execute",
		},
		requireInputOrgPermission: () => () => chain,
		resolveOrganizationId: () => "example-org",
	};
});

import "../archive";
import "../delete";
import "../restore";
import "../test-connections";

const [archive, remove, restore, testConnections] = m.handlers;

const context = {
	user: { id: "example-caller", role: "user" },
	session: {},
};
const someoneElsesReport = {
	id: "example-report",
	userId: "example-owner",
	organizationId: "example-org",
	projectId: "example-project",
	status: "ACTIVE",
	connections: {},
	template: { definition: {}, connections: {} },
};

function holdsRole(orgRole: string | null, projectRole?: string) {
	m.membership.mockResolvedValue(orgRole ? { role: orgRole } : null);
	m.hasProjectAccess.mockResolvedValue(projectRole !== undefined);
	m.access.mockResolvedValue(
		projectRole
			? {
					permissions: resolveProjectPermissions(projectRole),
					source: "project-member",
					organizationId: "example-org",
					organizationDeleted: false,
				}
			: orgRole
				? {
						permissions: resolveOrgPermissions(orgRole),
						source: "org",
						organizationId: "example-org",
						organizationDeleted: false,
					}
				: null,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	m.instance.mockResolvedValue(someoneElsesReport);
	m.isPlatformAdmin.mockResolvedValue(false);
	m.isProjectSoftDeleted.mockResolvedValue(false);
	m.checker.mockResolvedValue(true);
	m.archive.mockResolvedValue({ id: "example-report" });
	m.restore.mockResolvedValue({ id: "example-report" });
	m.remove.mockResolvedValue(undefined);
	m.probe.mockResolvedValue({ diagnostics: [] });
});

describe("archive and delete", () => {
	const call = (handler: (args: unknown) => Promise<unknown>) =>
		handler({ input: { id: "example-report" }, context });

	it.each([
		["an organization Viewer", "viewer", undefined],
		["a Viewer with an Editor project row", "viewer", "EDITOR"],
		["an organization Member, who holds no delete", "member", undefined],
		["a project guest who is no member", null, "EDITOR"],
	])("refuses %s before reading the report", async (_label, org, project) => {
		holdsRole(org, project);

		await expect(call(archive)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(call(remove)).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.instance).not.toHaveBeenCalled();
		expect(m.archive).not.toHaveBeenCalled();
		expect(m.remove).not.toHaveBeenCalled();
	});

	it("lets an organization Admin with no project row", async () => {
		holdsRole("admin");

		await call(archive);
		await call(remove);

		expect(m.archive).toHaveBeenCalledTimes(1);
		expect(m.remove).toHaveBeenCalledTimes(1);
	});

	it("lets a system admin who is a member, whatever the organization role", async () => {
		holdsRole("viewer");
		m.isPlatformAdmin.mockResolvedValue(true);

		await call(archive);
		await call(remove);

		expect(m.archive).toHaveBeenCalledTimes(1);
		expect(m.remove).toHaveBeenCalledTimes(1);
	});

	it("refuses a system admin who is not a member", async () => {
		holdsRole(null);
		m.isPlatformAdmin.mockResolvedValue(true);

		await expect(call(archive)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(call(remove)).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});

describe("restore", () => {
	const call = () => restore({ input: { id: "example-report" }, context });

	beforeEach(() => {
		m.instance.mockResolvedValue({
			...someoneElsesReport,
			status: "ARCHIVED",
		});
	});

	it("refuses a Viewer, with or without an Editor project row", async () => {
		holdsRole("viewer", "EDITOR");
		await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
		holdsRole("viewer");
		await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.restore).not.toHaveBeenCalled();
	});

	it("lets a system admin who is a member", async () => {
		holdsRole("viewer");
		m.isPlatformAdmin.mockResolvedValue(true);

		await call();

		expect(m.restore).toHaveBeenCalledTimes(1);
	});
});

describe("testConnections", () => {
	const call = () =>
		testConnections({ input: { instanceId: "example-report" }, context });

	it("refuses someone who only reads the report", async () => {
		holdsRole("member", "VIEWER");

		await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.probe).not.toHaveBeenCalled();
	});

	it("refuses a Viewer whatever their project row, since the role holds no execute", async () => {
		holdsRole("viewer", "EDITOR");

		await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.instance).not.toHaveBeenCalled();
		expect(m.probe).not.toHaveBeenCalled();
	});

	it("tests for someone who may edit the report", async () => {
		holdsRole("member", "EDITOR");

		await call();

		expect(m.probe).toHaveBeenCalledTimes(1);
	});

	it("refuses a member with no row on the project, who cannot open its reports", async () => {
		holdsRole("member");

		await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.probe).not.toHaveBeenCalled();
	});

	it("refuses the report's owner once a Viewer row leaves them reading it and no more", async () => {
		holdsRole("member", "VIEWER");
		m.instance.mockResolvedValue({
			...someoneElsesReport,
			userId: context.user.id,
		});

		await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.probe).not.toHaveBeenCalled();
	});

	it("tests for the report's owner while their project role lets them generate it", async () => {
		holdsRole("member", "EDITOR");
		m.instance.mockResolvedValue({
			...someoneElsesReport,
			userId: context.user.id,
		});

		await call();

		expect(m.probe).toHaveBeenCalledTimes(1);
	});

	it("tests for a system admin who is a member", async () => {
		holdsRole("viewer");
		m.isPlatformAdmin.mockResolvedValue(true);

		await call();

		expect(m.probe).toHaveBeenCalledTimes(1);
	});
});
