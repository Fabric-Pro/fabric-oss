import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	find: vi.fn(),
	update: vi.fn(),
	scope: vi.fn(),
	project: vi.fn(),
	deleted: vi.fn(),
	attach: vi.fn(),
	admission: vi.fn(),
	info: {
		workflowType: "nativeDeploymentExecutionWorkflow",
		workflowExecution: {
			workflowId: "example-workflow",
			runId: "example-run",
		},
	},
}));
vi.mock("@repo/database", () => ({
	db: {
		agentDeploymentExecution: { findFirst: m.find, updateMany: m.update },
	},
	getAgentTemplateInstanceForExecution: m.scope,
	getProjectAccessContext: m.project,
	isProjectSoftDeleted: m.deleted,
	attachAgentExecutionReceipt: m.attach,
	readAgentExecutionAdmission: m.admission,
}));
vi.mock("@temporalio/activity", () => ({
	Context: { current: () => ({ info: m.info }) },
	heartbeat: vi.fn(),
}));

import {
	completeNativeAgentExecution,
	registerNativeAgentExecutionReceipt,
} from "../src/activities/agent-execution-native-receipt";

const hash = "a".repeat(64);
const input = () => ({
	nativeAdmission: {
		version: 1 as const,
		executionRowId: "example-row",
		requestHash: hash,
	},
	executionId: "example-execution",
	deploymentId: "example-deployment",
	instanceId: "example-instance",
	userId: "example-user",
	organizationId: "example-org",
	workflowId: "example-workflow",
	runId: "example-run",
	workflowType: "nativeDeploymentExecutionWorkflow",
	admissionMemo: {
		version: 1,
		executionId: "example-row",
		requestHash: hash,
		userId: "example-user",
		organizationId: "example-org",
	},
});
const row = () => ({
	id: "example-row",
	executionId: "example-execution",
	deploymentId: "example-deployment",
	userId: "example-user",
	organizationId: "example-org",
	workflowId: "example-workflow",
	runId: null,
	status: "PENDING",
	output: null,
	deployment: {
		id: "example-deployment",
		userId: "example-user",
		organizationId: "example-org",
		instanceId: "example-instance",
		status: "ACTIVE",
	},
});
const admission = () => ({
	version: 1,
	receiptOwner: "workflow",
	requestHash: hash,
	dispatch: {
		workflowType: "nativeDeploymentExecutionWorkflow",
		instanceId: "example-instance",
		projectId: "example-project",
	},
	imageRefs: [],
});
beforeEach(() => {
	vi.clearAllMocks();
	m.info.workflowType = "nativeDeploymentExecutionWorkflow";
	m.info.workflowExecution.runId = "example-run";
	m.find.mockResolvedValue(row());
	m.admission.mockReturnValue(admission());
	m.scope.mockResolvedValue({
		instance: { customInstructions: {} },
		projectId: "example-project",
	});
	m.project.mockResolvedValue({ organizationId: "example-org" });
	m.deleted.mockResolvedValue(false);
	m.attach.mockResolvedValue(row());
	m.update.mockResolvedValue({ count: 1 });
});
describe("native workflow first-step receipt", () => {
	it("fences every admitted identity and attaches only the actual run, with a pending-only status projection and no output writes", async () => {
		await registerNativeAgentExecutionReceipt(input());
		expect(m.find).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "example-row",
					executionId: "example-execution",
					deploymentId: "example-deployment",
					userId: "example-user",
					organizationId: "example-org",
					workflowId: "example-workflow",
				},
			}),
		);
		expect(m.attach).toHaveBeenCalledWith({
			id: "example-row",
			userId: "example-user",
			organizationId: "example-org",
			workflowId: "example-workflow",
			runId: "example-run",
		});
		expect(m.attach.mock.invocationCallOrder[0]).toBeGreaterThan(
			m.scope.mock.invocationCallOrder[0],
		);
	});
	it("accepts an idempotent registration of the same running run without replacing output", async () => {
		m.find.mockResolvedValue({
			...row(),
			status: "RUNNING",
			runId: "example-run",
			output: { response: "already produced" },
		});
		await registerNativeAgentExecutionReceipt(input());
		expect(m.attach.mock.calls[0][0]).not.toHaveProperty("status");
		expect(m.attach.mock.calls[0][0]).not.toHaveProperty("output");
	});
	it.each(["PAUSED", "TERMINATED"])(
		"handles an already admitted %s deployment before model work",
		async (status) => {
			m.find.mockResolvedValue({
				...row(),
				deployment: { ...row().deployment, status },
			});
			if (status === "TERMINATED") {
				await expect(
					registerNativeAgentExecutionReceipt(input()),
				).rejects.toMatchObject({
					nonRetryable: true,
					type: "NATIVE_AGENT_RECEIPT_REFUSED",
				});
				expect(m.attach).not.toHaveBeenCalled();
			} else {
				await registerNativeAgentExecutionReceipt(input());
				expect(m.attach).toHaveBeenCalledTimes(1);
			}
		},
	);
	it("lets storage failures retry rather than translating them into an agent failure", async () => {
		const storage = new Error("example temporary storage outage");
		m.attach.mockRejectedValue(storage);
		await expect(registerNativeAgentExecutionReceipt(input())).rejects.toBe(
			storage,
		);
	});
	it.each(["memo", "actual-run", "actual-type", "missing-org"])(
		"refuses %s before loading the execution",
		async (kind) => {
			const value = input();
			if (kind === "memo") {
				value.admissionMemo.requestHash = "b".repeat(64);
			}
			if (kind === "actual-run") {
				m.info.workflowExecution.runId = "foreign-run";
			}
			if (kind === "actual-type") {
				m.info.workflowType = "foreignWorkflow";
			}
			if (kind === "missing-org") {
				value.organizationId = "";
			}
			await expect(
				registerNativeAgentExecutionReceipt(value),
			).rejects.toMatchObject({
				type: "NATIVE_AGENT_RECEIPT_REFUSED",
				nonRetryable: true,
			});
			expect(m.find).not.toHaveBeenCalled();
			expect(m.attach).not.toHaveBeenCalled();
		},
	);
	it.each([
		"legacy-owner",
		"deployment",
		"fingerprint",
		"existing-run",
		"terminal",
	])("refuses %s without modifying the row", async (kind) => {
		if (kind === "legacy-owner") {
			m.admission.mockReturnValue({
				...admission(),
				receiptOwner: undefined,
			});
		}
		if (kind === "deployment") {
			m.find.mockResolvedValue({
				...row(),
				deployment: {
					...row().deployment,
					instanceId: "foreign-instance",
				},
			});
		}
		if (kind === "fingerprint") {
			m.admission.mockReturnValue({
				...admission(),
				requestHash: "b".repeat(64),
			});
		}
		if (kind === "existing-run") {
			m.find.mockResolvedValue({ ...row(), runId: "foreign-run" });
		}
		if (kind === "terminal") {
			m.find.mockResolvedValue({
				...row(),
				status: "COMPLETED",
				output: { response: "keep this" },
			});
		}
		await expect(
			registerNativeAgentExecutionReceipt(input()),
		).rejects.toMatchObject({
			type: "NATIVE_AGENT_RECEIPT_REFUSED",
			nonRetryable: true,
		});
		expect(m.attach).not.toHaveBeenCalled();
	});
	it.each([
		"revoked",
		"changed-project",
		"foreign-project",
		"deleted-project",
	])("rechecks %s before attaching", async (kind) => {
		if (kind === "revoked") {
			m.scope.mockResolvedValue(null);
		}
		if (kind === "changed-project") {
			m.scope.mockResolvedValue({
				instance: { customInstructions: {} },
				projectId: "foreign-project",
			});
		}
		if (kind === "foreign-project") {
			m.project.mockResolvedValue({ organizationId: "foreign-org" });
		}
		if (kind === "deleted-project") {
			m.deleted.mockResolvedValue(true);
		}
		await expect(
			registerNativeAgentExecutionReceipt(input()),
		).rejects.toMatchObject({
			type: "NATIVE_AGENT_RECEIPT_REFUSED",
			nonRetryable: true,
		});
		expect(m.attach).not.toHaveBeenCalled();
	});
});

describe("native terminal projection", () => {
	const completion = () => ({
		receipt: input(),
		status: "COMPLETED" as const,
		output: { response: "Recorded result" },
		completedAt: "2026-11-01T00:00:00Z",
		durationMs: 20,
	});
	it("writes only a matching active actual run, without allowance/counter effects", async () => {
		m.find.mockResolvedValue({ ...row(), runId: "example-run" });
		m.update.mockResolvedValue({ count: 1 });
		await completeNativeAgentExecution(completion());
		expect(m.update).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					id: "example-row",
					runId: "example-run",
					organizationId: "example-org",
					status: { in: ["PENDING", "RUNNING"] },
				}),
				data: expect.objectContaining({
					status: "COMPLETED",
					output: { response: "Recorded result" },
					duration: 20,
				}),
			}),
		);
		expect(m.attach).not.toHaveBeenCalled();
	});
	it.each(["revoked", "rebound", "deleted-project", "terminated"])(
		"persists the owned completed outcome after %s without current execution grants",
		async (change) => {
			m.find.mockResolvedValue({
				...row(),
				runId: "example-run",
				deployment: {
					...row().deployment,
					status: change === "terminated" ? "TERMINATED" : "PAUSED",
				},
			});
			m.scope.mockResolvedValue(
				change === "revoked"
					? null
					: {
							instance: {
								customInstructions: {
									implementationMode: "unavailable",
								},
							},
							projectId: "example-rebound-project",
						},
			);
			m.project.mockResolvedValue(null);
			m.deleted.mockResolvedValue(true);
			await completeNativeAgentExecution(completion());
			expect(m.update).toHaveBeenCalledWith(
				expect.objectContaining({
					where: expect.objectContaining({
						organizationId: "example-org",
						runId: "example-run",
					}),
					data: expect.objectContaining({
						output: { response: "Recorded result" },
						status: "COMPLETED",
					}),
				}),
			);
			expect(m.scope).not.toHaveBeenCalled();
			expect(m.project).not.toHaveBeenCalled();
			expect(m.deleted).not.toHaveBeenCalled();
		},
	);
	it("confirms an identical committed terminal result without a second update after lost acknowledgement", async () => {
		m.find.mockResolvedValue({
			...row(),
			runId: "example-run",
			status: "COMPLETED",
			output: { response: "Recorded result" },
			error: null,
		});
		await completeNativeAgentExecution(completion());
		expect(m.update).not.toHaveBeenCalled();
	});
	it("does not regress a cancellation or overwrite different terminal output", async () => {
		for (const value of [
			{ status: "CANCELLED", output: null },
			{ status: "COMPLETED", output: { response: "Keep existing" } },
		]) {
			m.find.mockResolvedValue({
				...row(),
				runId: "example-run",
				...value,
			});
			await expect(
				completeNativeAgentExecution(completion()),
			).rejects.toMatchObject({
				nonRetryable: true,
				type: "NATIVE_AGENT_RECEIPT_REFUSED",
			});
		}
		expect(m.update).not.toHaveBeenCalled();
	});
	it("rethrows transient projection errors for Activity retry rather than entering a model recovery path", async () => {
		m.find.mockResolvedValue({ ...row(), runId: "example-run" });
		const error = new Error("Example storage outage");
		m.update.mockRejectedValue(error);
		await expect(completeNativeAgentExecution(completion())).rejects.toBe(
			error,
		);
	});
});
