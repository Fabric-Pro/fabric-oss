import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	admit: vi.fn(),
	instance: vi.fn(),
	authorize: vi.fn(),
	receipt: vi.fn(),
	advance: vi.fn(),
	next: vi.fn(),
	start: vi.fn(),
	describe: vi.fn(),
}));
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));
vi.mock("@temporalio/client", () => ({
	WorkflowExecutionAlreadyStartedError: class extends Error {},
}));
vi.mock("@repo/database", async () => {
	const evidence = await import(
		"../../../../../database/prisma/queries/lib/report-evidence"
	);
	return {
		...evidence,
		admitTemplateInstanceExecution: m.admit,
		getTemplateInstance: m.instance,
		canExecuteReportInstance: m.authorize,
		updateTemplateInstanceExecution: m.receipt,
		claimAndAdvanceScheduledInstance: m.advance,
		computeNextRunAt: m.next,
		reportExecutionAdmissionId: (id: string) => `admitted-${id}`,
	};
});
vi.mock("../../../client", () => ({
	getTemporalClient: async () => ({
		workflow: {
			start: m.start,
			getHandle: () => ({ describe: m.describe }),
		},
	}),
}));

import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { dispatchScheduledReportActivity } from "../dispatch-scheduled-report";

const row = {
	id: "instance-1",
	userId: "user-1",
	organizationId: "org-1",
	nextRunAt: "2026-06-24T09:00:00.000Z",
	schedule: { frequency: "daily" } as never,
};
const workflowId = `scheduled-report-${row.id}-${Date.parse(row.nextRunAt)}`;
const instance = {
	...row,
	nextRunAt: new Date(row.nextRunAt),
	isActive: true,
	status: "ACTIVE",
	scheduleMode: "CUSTOM",
	name: "Delivery",
	templateId: "template-1",
	connections: {},
	template: {},
};
beforeEach(() => {
	vi.clearAllMocks();
	m.instance.mockResolvedValue(instance);
	m.authorize.mockResolvedValue(true);
	m.admit.mockImplementation(async (value) => ({
		...value,
		id: "execution-1",
	}));
	m.start.mockResolvedValue({ firstExecutionRunId: "run-1" });
	m.describe.mockResolvedValue({ runId: "run-1" });
	m.next.mockReturnValue(new Date("2026-06-25T09:00:00Z"));
	m.receipt.mockResolvedValue({});
});
describe("durable scheduled report admission", () => {
	it("retains the existing occurrence key, pins tenant/evidence, and advances only after receipt", async () => {
		await dispatchScheduledReportActivity(row);
		expect(m.admit).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: "org-1",
				workflowId,
				parameters: {
					__fabricReportExecution: expect.objectContaining({
						occurrenceAt: row.nextRunAt,
						origin: "scheduled",
						organizationId: "org-1",
					}),
				},
			}),
		);
		expect(m.start).toHaveBeenCalledWith(
			"templateInstanceExecutionWorkflow",
			expect.objectContaining({
				workflowId,
				workflowIdReusePolicy: "REJECT_DUPLICATE",
				workflowIdConflictPolicy: "FAIL",
				args: [
					expect.objectContaining({
						executionId: "execution-1",
						organizationId: "org-1",
						reportingProtocol: 1,
						jobType: "scheduled-report",
					}),
				],
			}),
		);
		expect(m.advance).toHaveBeenCalledWith(
			row.id,
			new Date(row.nextRunAt),
			new Date("2026-06-25T09:00:00Z"),
		);
		expect(m.receipt.mock.invocationCallOrder[0]).toBeLessThan(
			m.advance.mock.invocationCallOrder[0],
		);
	});
	it("repairs AlreadyStarted receipts, including a closed execution, without another ID", async () => {
		m.start.mockRejectedValue(
			new WorkflowExecutionAlreadyStartedError(
				"Already started",
				"workflow-1",
				"templateInstanceExecutionWorkflow",
			),
		);
		await dispatchScheduledReportActivity(row);
		expect(m.describe).toHaveBeenCalledOnce();
		expect(m.receipt).toHaveBeenCalledWith({
			id: "execution-1",
			workflowId,
			runId: "run-1",
		});
		expect(m.advance).toHaveBeenCalledOnce();
	});
	it("does not advance or mark FAILED on an uncertain start", async () => {
		m.start.mockRejectedValue(new Error("transport timeout"));
		await expect(dispatchScheduledReportActivity(row)).rejects.toThrow(
			"timeout",
		);
		expect(m.advance).not.toHaveBeenCalled();
		expect(m.receipt).not.toHaveBeenCalled();
	});
	it("does not advance or mark FAILED if the receipt write fails after start", async () => {
		m.receipt.mockRejectedValue(new Error("database unavailable"));
		await expect(dispatchScheduledReportActivity(row)).rejects.toThrow(
			"database",
		);
		expect(m.advance).not.toHaveBeenCalled();
		expect(m.receipt.mock.calls[0][0]).not.toHaveProperty("status");
	});
	it.each(["OFF", "ARCHIVED", "inactive", "stale", "revoked"])(
		"does not admit a %s instance selected by a stale sweep",
		async (state) => {
			m.instance.mockResolvedValue({
				...instance,
				...(state === "OFF"
					? { scheduleMode: "OFF" }
					: state === "ARCHIVED"
						? { status: "ARCHIVED" }
						: state === "inactive"
							? { isActive: false }
							: state === "stale"
								? {
										nextRunAt: new Date(
											"2026-07-01T00:00:00Z",
										),
									}
								: {}),
			});
			if (state === "revoked") {
				m.authorize.mockResolvedValue(false);
			}
			await dispatchScheduledReportActivity(row);
			expect(m.admit).not.toHaveBeenCalled();
			expect(m.start).not.toHaveBeenCalled();
		},
	);
	it("rejects a null organization rather than executing in personal scope", async () => {
		await dispatchScheduledReportActivity({ ...row, organizationId: null });
		expect(m.instance).not.toHaveBeenCalled();
		expect(m.admit).not.toHaveBeenCalled();
	});
	it("rechecks the original admitted audience after configuration edits", async () => {
		m.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
		await dispatchScheduledReportActivity(row);
		expect(m.admit).toHaveBeenCalledOnce();
		expect(m.start).not.toHaveBeenCalled();
	});
});

it("preserves an already-admitted legacy occurrence across deployment without inventing a snapshot", async () => {
	m.admit.mockResolvedValue({ id: "legacy-execution-1", parameters: null });
	await dispatchScheduledReportActivity(row);
	const args = m.start.mock.calls[0][1];
	expect(args.workflowId).toBe(workflowId);
	expect(args.args[0].executionId).toBe("legacy-execution-1");
	expect(args.args[0]).not.toHaveProperty("reportingProtocol");
});
