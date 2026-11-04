import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	member: vi.fn(),
	project: vi.fn(),
	read: vi.fn(),
	write: vi.fn(),
}));
vi.mock("../prisma/client", () => ({
	db: { member: { findUnique: m.member }, project: { findFirst: m.project } },
}));
vi.mock("../prisma/queries/projects/projects", () => ({
	hasProjectAccess: m.read,
	canEditProject: m.write,
}));

import {
	canAccessReportInstance,
	canExecuteReportInstance,
	createReportAccessChecker,
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
	m.member.mockResolvedValue({ role: "owner" });
	m.project.mockResolvedValue({ id: "project-1" });
	m.read.mockResolvedValue(true);
	m.write.mockResolvedValue(true);
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
		expect(await canExecuteReportInstance(instance, caller)).toBe(false);
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
