import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	member: vi.fn(),
	user: vi.fn(),
	project: vi.fn(),
	read: vi.fn(),
	write: vi.fn(),
}));
vi.mock("../prisma/client", () => ({
	db: {
		member: { findUnique: m.member },
		user: { findUnique: m.user },
		project: { findFirst: m.project },
	},
}));
vi.mock("../prisma/queries/projects/projects", () => ({
	hasProjectAccess: m.read,
	canEditProject: m.write,
}));

import {
	canAccessReportInstance,
	canExecuteReportInstance,
	createReportAccessChecker,
	getReportAdminProjectOrganization,
	readReportProjectBindings,
} from "../prisma/queries/lib/report-access";
import { buildReportExecutionSnapshot } from "../prisma/queries/lib/report-evidence";

const instance = {
	id: "report-1",
	userId: "user-1",
	organizationId: "org-1",
	fabricConfig: {
		reporting: { version: 1, period: "weekly", projectId: "project-1" },
	},
};
const caller = { userId: "user-2", organizationId: "org-1" };
beforeEach(() => {
	vi.clearAllMocks();
	m.member.mockResolvedValue({ role: "member" });
	m.user.mockResolvedValue({ role: "user" });
	m.project.mockResolvedValue({ id: "project-1" });
	m.read.mockResolvedValue(true);
	m.write.mockResolvedValue(true);
});
describe("a system admin", () => {
	beforeEach(() => {
		m.user.mockResolvedValue({ role: "admin" });
		m.read.mockResolvedValue(false);
		m.write.mockResolvedValue(false);
	});

	it("inherits Project Editor on the reports of a live project once a member, whatever the organization role", async () => {
		m.member.mockResolvedValue({ role: "viewer" });

		const read = await createReportAccessChecker(caller);
		const write = await createReportAccessChecker(caller, true);

		expect(await read(instance)).toBe(true);
		expect(await write(instance)).toBe(true);
		expect(
			await canExecuteReportInstance(
				{ ...instance, userId: caller.userId },
				caller,
			),
		).toBe(true);
		expect(m.read).not.toHaveBeenCalled();
		expect(m.write).not.toHaveBeenCalled();
	});

	it("is refused when not a member, because membership is the tenant boundary", async () => {
		m.member.mockResolvedValue(null);

		const read = await createReportAccessChecker(caller);
		const write = await createReportAccessChecker(caller, true);

		expect(await read(instance)).toBe(false);
		expect(await write(instance)).toBe(false);
		expect(
			await canExecuteReportInstance(
				{ ...instance, userId: caller.userId },
				caller,
			),
		).toBe(false);
	});

	it("is refused a project outside the organization", async () => {
		m.member.mockResolvedValue({ role: "viewer" });
		m.project.mockResolvedValue(null);

		const write = await createReportAccessChecker(caller, true);

		expect(await write(instance)).toBe(false);
	});

	it("is named the project's organization only as a member of it", async () => {
		m.project.mockResolvedValue({ organizationId: "org-1" });
		m.member.mockResolvedValue({ role: "viewer" });
		expect(
			await getReportAdminProjectOrganization("project-1", "user-2"),
		).toEqual({ organizationId: "org-1" });

		m.member.mockResolvedValue(null);
		expect(
			await getReportAdminProjectOrganization("project-1", "user-2"),
		).toBeNull();
	});
});
describe("organization-owned project report intersection", () => {
	it("permits another current org member only with actual project access", async () => {
		expect(await canAccessReportInstance(instance, caller)).toBe(true);
		m.read.mockResolvedValue(false);
		expect(await canAccessReportInstance(instance, caller)).toBe(false);
	});
	it("denies a foreign project for a user who belongs to both organizations", async () => {
		m.project.mockResolvedValue(null);
		expect(
			await canAccessReportInstance(instance, {
				userId: "user-1",
				organizationId: "org-1",
			}),
		).toBe(false);
		expect(m.project).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "project-1",
					organizationId: "org-1",
					deletedAt: null,
				},
			}),
		);
		expect(m.read).not.toHaveBeenCalled();
	});
	it("denies same user in another organization and a null tenant before looking up membership", async () => {
		expect(
			await canAccessReportInstance(instance, {
				userId: "user-1",
				organizationId: "org-2",
			}),
		).toBe(false);
		expect(
			await canAccessReportInstance(instance, { userId: "user-1" }),
		).toBe(false);
		expect(m.member).not.toHaveBeenCalled();
	});
	it("does not grant Reports to an invited project guest", async () => {
		m.member.mockResolvedValue(null);
		expect(await canAccessReportInstance(instance, caller)).toBe(false);
		expect(m.read).not.toHaveBeenCalled();
	});
	it("requires project edit access for writes", async () => {
		m.write.mockResolvedValue(false);
		expect(
			await canAccessReportInstance(instance, caller, undefined, true),
		).toBe(false);
		expect(m.write).toHaveBeenCalled();
	});
	it("requires reaching the project for writes, whatever the edit rights say", async () => {
		m.read.mockResolvedValue(false);
		expect(
			await canAccessReportInstance(instance, caller, undefined, true),
		).toBe(false);
	});
	it("lets an organization Viewer write only through edit rights on the report's project", async () => {
		m.member.mockResolvedValue({ role: "viewer" });
		expect(
			await canAccessReportInstance(instance, caller, undefined, true),
		).toBe(true);
		m.write.mockResolvedValue(false);
		expect(
			await canAccessReportInstance(instance, caller, undefined, true),
		).toBe(false);
	});
	it("refuses an organization Viewer writing a report bound to no project", async () => {
		m.member.mockResolvedValue({ role: "viewer" });
		const unbound = {
			userId: caller.userId,
			organizationId: "org-1",
			fabricConfig: null,
		};
		expect(
			await canAccessReportInstance(unbound, caller, undefined, true),
		).toBe(false);
	});
	it("still lets a member write a report bound to no project", async () => {
		m.member.mockResolvedValue({ role: "member" });
		const unbound = {
			userId: caller.userId,
			organizationId: "org-1",
			fabricConfig: null,
		};
		expect(
			await canAccessReportInstance(unbound, caller, undefined, true),
		).toBe(true);
	});
	it("refuses a project guest's write even with project edit rights", async () => {
		m.member.mockResolvedValue(null);
		expect(
			await canAccessReportInstance(instance, caller, undefined, true),
		).toBe(false);
		expect(m.write).not.toHaveBeenCalled();
	});
	it("checks the original snapshot restriction even after the current binding changes", async () => {
		const snapshot = buildReportExecutionSnapshot({
			instance,
			userId: "user-1",
			organizationId: "org-1",
			occurrenceAt: new Date("2026-11-02T00:00:00Z"),
			origin: "scheduled",
		});
		const current = {
			...instance,
			fabricConfig: {
				reporting: {
					...instance.fabricConfig.reporting,
					projectId: "project-2",
				},
			},
		};
		m.read.mockImplementation(async (id) => id === "project-2");
		expect(
			await canAccessReportInstance(current, caller, {
				__fabricReportExecution: snapshot,
			}),
		).toBe(false);
		expect(
			readReportProjectBindings(current.fabricConfig, {
				__fabricReportExecution: snapshot,
			}),
		).toEqual(["project-2", "project-1"]);
	});
	it("denies removed/trashed projects and malformed snapshots", async () => {
		m.project.mockResolvedValue(null);
		expect(await canAccessReportInstance(instance, caller)).toBe(false);
		expect(
			await canAccessReportInstance(instance, caller, {
				__fabricReportExecution: {},
			}),
		).toBe(false);
	});
	it("rechecks background execution permissions instead of inheriting old manual eligibility", async () => {
		m.member.mockResolvedValue({ role: "viewer" });
		expect(
			await canExecuteReportInstance(
				{ ...instance, userId: caller.userId },
				caller,
			),
		).toBe(false);
	});
	it("runs a report for its owner while their project role lets them edit it", async () => {
		const own = { ...instance, userId: caller.userId };
		expect(await canExecuteReportInstance(own, caller)).toBe(true);

		m.write.mockResolvedValue(false);
		expect(await canExecuteReportInstance(own, caller)).toBe(false);
	});
	it("runs a report for nobody but its owner, because a run uses the owner's connections", async () => {
		m.member.mockResolvedValue({ role: "admin" });
		expect(await canExecuteReportInstance(instance, caller)).toBe(false);
	});
});

describe.each(["admin", "owner"])("an organization %s", (role) => {
	beforeEach(() => {
		m.member.mockResolvedValue({ role });
		m.read.mockResolvedValue(false);
		m.write.mockResolvedValue(false);
	});

	it("reads and writes a project's reports with no project row", async () => {
		expect(await canAccessReportInstance(instance, caller)).toBe(true);
		expect(
			await canAccessReportInstance(instance, caller, undefined, true),
		).toBe(true);
	});

	it("writes a project's reports despite a Viewer project row", async () => {
		m.read.mockResolvedValue(true);
		expect(
			await canAccessReportInstance(instance, caller, undefined, true),
		).toBe(true);
	});

	it("inherits nothing on a project in another organization or the trash", async () => {
		m.project.mockResolvedValue(null);
		expect(await canAccessReportInstance(instance, caller)).toBe(false);
		expect(
			await canAccessReportInstance(instance, caller, undefined, true),
		).toBe(false);
		expect(m.project).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "project-1",
					organizationId: "org-1",
					deletedAt: null,
				},
			}),
		);
	});
});

it("leaves an organization member with no project row refused", async () => {
	m.member.mockResolvedValue({ role: "member" });
	m.read.mockResolvedValue(false);
	m.write.mockResolvedValue(false);
	expect(await canAccessReportInstance(instance, caller)).toBe(false);
	expect(
		await canAccessReportInstance(instance, caller, undefined, true),
	).toBe(false);
});

describe("getReportAdminProjectOrganization", () => {
	it("names the organization of a live project its admin or owner administers", async () => {
		m.project.mockResolvedValue({ organizationId: "org-1" });
		m.member.mockResolvedValue({ role: "admin" });
		expect(
			await getReportAdminProjectOrganization("project-1", "user-2"),
		).toEqual({ organizationId: "org-1" });
		expect(m.project).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "project-1", deletedAt: null },
			}),
		);
	});

	it("refuses a member, a non-member, a personal project and a trashed one", async () => {
		m.project.mockResolvedValue({ organizationId: "org-1" });
		m.member.mockResolvedValue({ role: "member" });
		expect(
			await getReportAdminProjectOrganization("project-1", "user-2"),
		).toBeNull();
		m.member.mockResolvedValue(null);
		expect(
			await getReportAdminProjectOrganization("project-1", "user-2"),
		).toBeNull();
		m.project.mockResolvedValue({ organizationId: null });
		expect(
			await getReportAdminProjectOrganization("project-1", "user-2"),
		).toBeNull();
		m.project.mockResolvedValue(null);
		expect(
			await getReportAdminProjectOrganization("project-1", "user-2"),
		).toBeNull();
	});
});

it("reuses role/project checks within a single list request", async () => {
	const canRead = await createReportAccessChecker(caller);
	expect(await canRead(instance)).toBe(true);
	expect(await canRead(instance)).toBe(true);
	expect(m.member).toHaveBeenCalledTimes(1);
	expect(m.project).toHaveBeenCalledTimes(1);
	expect(m.read).toHaveBeenCalledTimes(1);
});
