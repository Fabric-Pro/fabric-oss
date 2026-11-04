import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	list: vi.fn(),
	instance: vi.fn(),
	authorize: vi.fn(),
	start: vi.fn(),
	describe: vi.fn(),
	receipt: vi.fn(),
}));
vi.mock("@repo/database", async () => ({
	...(await import(
		"../../../../../database/prisma/queries/lib/report-evidence"
	)),
	listPendingReportExecutionStarts: m.list,
	getTemplateInstance: m.instance,
	canExecuteReportInstance: m.authorize,
	updateTemplateInstanceExecution: m.receipt,
}));
vi.mock("@temporalio/client", () => ({
	WorkflowExecutionAlreadyStartedError: class extends Error {},
}));
vi.mock("../../../client", () => ({
	getTemporalClient: async () => ({
		workflow: {
			start: m.start,
			getHandle: () => ({ describe: m.describe }),
		},
	}),
}));

import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { buildReportExecutionSnapshot } from "../../../../../database/prisma/queries/lib/report-evidence";
import { reconcileReportStarts } from "../reconcile-report-starts";

const instance = {
	template: { definition: {} },
	connections: {},
	id: "report-1",
	isActive: true,
	status: "ACTIVE",
	scheduleMode: "CUSTOM",
};
const snapshot = buildReportExecutionSnapshot({
	instance,
	organizationId: "org-1",
	userId: "user-1",
	occurrenceAt: new Date("2026-11-02T00:00:00Z"),
	origin: "manual",
});
const execution = {
	id: "execution-1",
	instanceId: "report-1",
	userId: "user-1",
	organizationId: "org-1",
	workflowId: "template-instance-stable",
	parameters: { __fabricReportExecution: snapshot },
};
beforeEach(() => {
	vi.clearAllMocks();
	m.list.mockResolvedValue([execution]);
	m.instance.mockResolvedValue(instance);
	m.authorize.mockResolvedValue(true);
	m.start.mockResolvedValue({ firstExecutionRunId: "run-1" });
	m.describe.mockResolvedValue({ runId: "run-1" });
});
describe("pending report start reconciliation", () => {
	it("starts the pinned manual intent using background identity and no personal plan eligibility", async () => {
		await reconcileReportStarts(10);
		expect(m.start).toHaveBeenCalledWith(
			"templateInstanceExecutionWorkflow",
			expect.objectContaining({
				workflowId: execution.workflowId,
				args: [
					expect.objectContaining({
						reportingProtocol: 1,
						planEligible: false,
						organizationId: "org-1",
					}),
				],
			}),
		);
		expect(m.start.mock.calls[0][1].args[0]).not.toHaveProperty("jobType");
		expect(m.receipt).toHaveBeenCalledWith({
			id: "execution-1",
			runId: "run-1",
		});
	});
	it("repairs a lost receipt from a workflow that already started", async () => {
		m.start.mockRejectedValue(
			new WorkflowExecutionAlreadyStartedError(
				"Already started",
				"workflow-1",
				"templateInstanceExecutionWorkflow",
			),
		);
		await reconcileReportStarts(10);
		expect(m.describe).toHaveBeenCalledOnce();
		expect(m.receipt).toHaveBeenCalledWith({
			id: "execution-1",
			runId: "run-1",
		});
	});
	it("leaves the intent pending when the service cannot confirm a start", async () => {
		m.start.mockRejectedValue(new Error("unavailable"));
		await reconcileReportStarts(10);
		expect(m.receipt).not.toHaveBeenCalled();
	});
	it("does not retry with a revoked actor or a forged/null-tenant snapshot", async () => {
		m.authorize.mockResolvedValue(false);
		await reconcileReportStarts(10);
		expect(m.start).not.toHaveBeenCalled();
		m.list.mockResolvedValue([
			{ ...execution, organizationId: null },
			{ ...execution, parameters: { __fabricReportExecution: {} } },
		]);
		await reconcileReportStarts(10);
		expect(m.start).not.toHaveBeenCalled();
	});
});

it("retains scheduled attribution only for a scheduled origin", async () => {
	m.list.mockResolvedValue([
		{
			...execution,
			parameters: {
				__fabricReportExecution: { ...snapshot, origin: "scheduled" },
			},
		},
	]);
	await reconcileReportStarts(10);
	expect(m.start.mock.calls[0][1].args[0]).toMatchObject({
		jobType: "scheduled-report",
		planEligible: false,
	});
});
