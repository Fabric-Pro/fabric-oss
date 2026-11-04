import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	flag: vi.fn(),
	membership: vi.fn(),
	projectPermission: vi.fn(),
	list: vi.fn(),
	instance: vi.fn(),
	admit: vi.fn(),
	receipt: vi.fn(),
	start: vi.fn(),
}));

vi.mock("@repo/database", async () => ({
	...(await import(
		"../../../../../database/prisma/queries/lib/report-evidence"
	)),
	isFeatureEnabled: m.flag,
	isPlatformAdmin: async () => false,
	getOrganizationMembership: m.membership,
	listTemplateInstances: m.list,
	getTemplateInstance: m.instance,
	admitTemplateInstanceExecution: m.admit,
	updateTemplateInstanceExecution: m.receipt,
	reportExecutionAdmissionId: (value: string) => `id-${value.length}`,
}));
vi.mock("../../../../orpc/procedures", () => ({
	userHasProjectPermission: m.projectPermission,
}));
vi.mock("../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: async () => null,
}));
vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({
		workflow: { start: m.start, getHandle: () => ({ describe: vi.fn() }) },
	}),
}));
vi.mock("../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: (value: unknown) => value,
}));

import {
	generateReportForAgent,
	listProjectReportsForAgent,
} from "../report-agent-commands";

const actor = {
	userId: "example-owner",
	organizationId: "example-org",
	planEligible: true,
};
const reachable = async () => true;

function report(overrides: Record<string, unknown> = {}) {
	return {
		id: "report-1",
		name: "Weekly status",
		description: null,
		userId: "example-owner",
		organizationId: "example-org",
		projectId: "project-1",
		isActive: true,
		connections: {},
		parameterDefaults: null,
		fabricConfig: null,
		lastRunAt: null,
		executions: [],
		template: {
			name: "Status",
			definition: {},
			connections: {},
			parameters: {
				required: ["team"],
				properties: { team: { type: "string" } },
			},
		},
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	m.flag.mockResolvedValue(true);
	m.membership.mockResolvedValue({ role: "member" });
	m.projectPermission.mockResolvedValue(true);
	m.instance.mockResolvedValue(report());
	m.admit.mockImplementation(async (value) => ({
		...value,
		status: "PENDING",
	}));
	m.start.mockResolvedValue({ firstExecutionRunId: "run-1" });
	m.receipt.mockResolvedValue({});
});

describe("generateReportForAgent", () => {
	it("starts the owner's ready report through the Generate button's admission", async () => {
		const result = await generateReportForAgent(
			actor,
			{ instanceId: "report-1", parameters: { team: "Example" } },
			reachable,
		);

		expect(result.startConfirmed).toBe(true);
		expect(m.admit.mock.calls[0][0]).toMatchObject({
			instanceId: "report-1",
			organizationId: "example-org",
			parameters: { team: "Example" },
		});
		expect(m.start).toHaveBeenCalledTimes(1);
	});

	it.each([
		[true, "a person started it"],
		[false, "a key or token started it"],
	])("starts the run with planEligible %s when %s", async (planEligible) => {
		await generateReportForAgent(
			{ ...actor, planEligible },
			{ instanceId: "report-1", parameters: { team: "Example" } },
			reachable,
		);

		expect(m.start).toHaveBeenCalledWith(
			"templateInstanceExecutionWorkflow",
			expect.objectContaining({
				args: [expect.objectContaining({ planEligible })],
			}),
		);
	});

	it("says how to send parameters when they are invalid", async () => {
		await expect(
			generateReportForAgent(
				actor,
				{
					instanceId: "report-1",
					parameters: { team: "x".repeat(33_000) },
				},
				reachable,
			),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringContaining("an omitted parameter keeps"),
		});
		expect(m.admit).not.toHaveBeenCalled();
	});

	it("refuses a report whose required parameter has no value before spending credits", async () => {
		await expect(
			generateReportForAgent(
				actor,
				{ instanceId: "report-1" },
				reachable,
			),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(m.admit).not.toHaveBeenCalled();
	});

	it("refuses anyone but the owner, because a report runs on the owner's connections", async () => {
		m.instance.mockResolvedValue(report({ userId: "example-editor" }));

		await expect(
			generateReportForAgent(
				actor,
				{ instanceId: "report-1", parameters: { team: "Example" } },
				reachable,
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.admit).not.toHaveBeenCalled();
	});

	it("refuses an organization role without report execution", async () => {
		m.membership.mockResolvedValue({ role: "viewer" });

		await expect(
			generateReportForAgent(
				actor,
				{ instanceId: "report-1", parameters: { team: "Example" } },
				reachable,
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.instance).not.toHaveBeenCalled();
	});

	it("refuses while the report suite is off for the organization", async () => {
		m.flag.mockResolvedValue(false);

		await expect(
			generateReportForAgent(
				actor,
				{ instanceId: "report-1", parameters: { team: "Example" } },
				reachable,
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.instance).not.toHaveBeenCalled();
	});

	it("refuses a report in a project the session may not reach", async () => {
		await expect(
			generateReportForAgent(
				actor,
				{ instanceId: "report-1", parameters: { team: "Example" } },
				async (projectId) => projectId !== "project-1",
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.admit).not.toHaveBeenCalled();
	});
});

describe("listProjectReportsForAgent", () => {
	it("says which reports the caller can generate and why not", async () => {
		m.list.mockResolvedValue({
			instances: [
				report({ parameterDefaults: { team: "Example" } }),
				report({ id: "report-2", userId: "example-editor" }),
			],
			total: 2,
		});

		const result = await listProjectReportsForAgent(actor, {
			projectId: "project-1",
			limit: 500,
		});

		expect(m.list.mock.calls[0][0]).toMatchObject({
			projectId: "project-1",
			organizationId: "example-org",
			limit: 50,
		});
		expect(result.reports.map((r) => [r.id, r.canGenerate])).toEqual([
			["report-1", true],
			["report-2", false],
		]);
		expect(result.reports[1].generateBlockedReason).toContain("owner");
	});

	it("refuses a project the caller may not read", async () => {
		m.projectPermission.mockResolvedValue(false);

		await expect(
			listProjectReportsForAgent(actor, { projectId: "project-1" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.list).not.toHaveBeenCalled();
	});
});
