vi.mock("../prisma/queries/projects/projects", () => ({
	hasProjectAccess: m.projectRead,
	canEditProject: m.projectWrite,
}));

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	find: vi.fn(),
	canRead: vi.fn(),
	project: vi.fn(),
	projectRead: vi.fn(),
	projectWrite: vi.fn(),
}));
vi.mock("../prisma/client", () => ({
	db: {
		templateInstanceExecution: { findFirst: m.find },
		project: { findFirst: m.project },
	},
}));
vi.mock("../prisma/queries/lib/report-access", () => ({
	canAccessReportInstance: m.canRead,
}));

import { db } from "../prisma/client";
import {
	canReadReportDerivedFrame,
	canWriteReportDerivedFrame,
} from "../prisma/queries/report-frame-access";

const file = {
	sourceRunType: "REPORT_EXECUTION",
	sourceRunId: "example-execution",
	organizationId: "example-org",
	userId: "example-owner",
};
const actor = { userId: "example-owner", organizationId: "example-org" };
beforeEach(() => vi.resetAllMocks());
describe("report-derived Frame authority", () => {
	it("keeps normal authored Frames independent from report permissions", async () => {
		expect(
			await canReadReportDerivedFrame(
				{ ...file, sourceRunType: "workflow" },
				{},
			),
		).toBe(true);
		expect(m.find).not.toHaveBeenCalled();
	});
	it.each([{ userId: "example-owner", organizationId: "example-other" }, {}])(
		"fails closed before loading a report for a mismatched actor %j",
		async (bad) => {
			expect(await canReadReportDerivedFrame(file, bad)).toBe(false);
			expect(m.find).not.toHaveBeenCalled();
		},
	);
	it("does not let a Frame creator shortcut current or admitted report access", async () => {
		const execution = {
			instance: {
				fabricConfig: { reporting: { projectId: "example-current" } },
			},
			parameters: {
				__fabricReportExecution: {
					config: { projectId: "example-admitted" },
				},
			},
		};
		m.find.mockResolvedValue(execution);
		m.canRead.mockResolvedValue(false);
		expect(await canReadReportDerivedFrame(file, actor)).toBe(false);
		expect(m.canRead).toHaveBeenCalledWith(
			execution.instance,
			actor,
			execution.parameters,
			false,
			db,
		);
		m.canRead.mockResolvedValue(true);
		expect(await canReadReportDerivedFrame(file, actor)).toBe(true);
	});
	it("fails closed after the original execution is removed", async () => {
		m.find.mockResolvedValue(null);
		expect(await canReadReportDerivedFrame(file, actor)).toBe(false);
	});
});

it("allows an authorized report teammate within the execution tenant", async () => {
	const execution = {
		instance: { userId: "example-owner", organizationId: "example-org" },
		parameters: {
			__fabricReportExecution: {
				config: { projectId: "example-admitted" },
			},
		},
	};
	m.find.mockResolvedValue(execution);
	m.canRead.mockResolvedValue(true);
	const teammate = {
		userId: "example-teammate",
		organizationId: "example-org",
	};
	expect(await canReadReportDerivedFrame(file, teammate)).toBe(true);
	expect(m.find).toHaveBeenCalledWith({
		where: {
			id: "example-execution",
			organizationId: "example-org",
		},
		include: { instance: true },
	});
	expect(m.canRead).toHaveBeenCalledWith(
		execution.instance,
		teammate,
		execution.parameters,
		false,
		db,
	);
	m.canRead.mockResolvedValue(false);
	expect(await canReadReportDerivedFrame(file, teammate)).toBe(false);
});

it("requires current report/project writes even for the original Frame creator", async () => {
	const execution = {
		instance: { userId: "example-owner", organizationId: "example-org" },
		parameters: {},
	};
	m.find.mockResolvedValue(execution);
	m.canRead.mockResolvedValue(false);
	expect(await canWriteReportDerivedFrame(file, actor)).toBe(false);
	expect(m.canRead).toHaveBeenCalledWith(
		execution.instance,
		actor,
		execution.parameters,
		true,
		db,
	);
	m.canRead.mockResolvedValue(true);
	expect(await canWriteReportDerivedFrame(file, actor)).toBe(true);
	expect(
		await canWriteReportDerivedFrame(file, {
			userId: "example-teammate",
			organizationId: "example-org",
		}),
	).toBe(false);
});

it("retains a report Frame's independent current project restriction", async () => {
	m.find.mockResolvedValue({ instance: {}, parameters: {} });
	m.canRead.mockResolvedValue(true);
	m.project.mockResolvedValue({ id: "example-frame-project" });
	m.projectRead.mockResolvedValue(false);
	expect(
		await canReadReportDerivedFrame(
			{ ...file, projectId: "example-frame-project" },
			actor,
		),
	).toBe(false);
	m.projectRead.mockResolvedValue(true);
	expect(
		await canReadReportDerivedFrame(
			{ ...file, projectId: "example-frame-project" },
			actor,
		),
	).toBe(true);
	m.projectWrite.mockResolvedValue(false);
	expect(
		await canWriteReportDerivedFrame(
			{ ...file, projectId: "example-frame-project" },
			actor,
		),
	).toBe(false);
	m.project.mockResolvedValue(null);
	expect(
		await canReadReportDerivedFrame(
			{ ...file, projectId: "example-frame-project" },
			actor,
		),
	).toBe(false);
});

it("uses the held transaction for report authority instead of a new connection", async () => {
	const tx = {
		project: { findFirst: vi.fn() },
		templateInstanceExecution: {
			findFirst: vi
				.fn()
				.mockResolvedValue({ instance: {}, parameters: {} }),
		},
	};
	m.canRead.mockResolvedValue(true);
	await canReadReportDerivedFrame(
		file,
		actor,
		tx as unknown as Parameters<typeof canReadReportDerivedFrame>[2],
	);
	expect(m.find).not.toHaveBeenCalled();
	expect(m.canRead).toHaveBeenCalledWith({}, actor, {}, false, tx);
});
