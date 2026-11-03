import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	find: vi.fn(),
	legacy: vi.fn(),
	create: vi.fn(),
	attach: vi.fn(),
	audit: vi.fn(),
	deployment: vi.fn(),
	quota: vi.fn(),
	reserve: vi.fn(),
	counts: vi.fn(),
}));
vi.mock("../prisma/client", () => ({
	db: {
		$transaction: async (run: (tx: unknown) => unknown) =>
			run({
				agentDeployment: { findFirst: h.deployment, update: h.counts },
				organizationDeploymentQuota: {
					findUnique: h.quota,
					updateMany: h.reserve,
				},
				agentDeploymentExecution: { create: h.create },
			}),
		agentDeploymentExecution: {
			findUnique: h.find,
			findFirst: h.legacy,
			create: h.create,
			updateMany: h.attach,
		},
	},
}));
vi.mock("../prisma/queries/audit-log", () => ({ recordAuditTx: h.audit }));

import {
	admitAgentDeploymentExecution,
	agentExecutionAdmissionId,
	attachAgentExecutionReceipt,
	normalizeAgentExecutionRequest,
	readAgentExecutionAdmission,
} from "../prisma/queries/agent-deployments/admission";

const input = {
	organizationId: "example-org",
	userId: "example-user",
	deploymentId: "example-deployment",
	idempotencyKey: "example-request",
	request: normalizeAgentExecutionRequest({
		input: { message: "Example" },
		priority: 5,
	}),
	dispatch: {
		instanceId: "example-instance",
		workflowType: "nativeDeploymentExecutionWorkflow" as const,
	},
};
beforeEach(() => {
	vi.clearAllMocks();
	h.deployment.mockResolvedValue({ id: "example-deployment" });
	h.quota.mockResolvedValue({
		dailyExecutionLimit: 1000,
		monthlyExecutionLimit: 20000,
	});
	h.reserve.mockResolvedValue({ count: 1 });
	h.find.mockResolvedValue(null);
	h.legacy.mockResolvedValue(null);
	h.create.mockImplementation(async ({ data }) => ({ ...data, runId: null }));
});
describe("durable execution admission contract", () => {
	it("pins one workflow identity before dispatch without storing a raw request key", async () => {
		const result = await admitAgentDeploymentExecution(input);
		expect(result.execution.workflowId).toBe(
			`deployment-exec-${agentExecutionAdmissionId(input, input.idempotencyKey)}`,
		);
		expect(JSON.stringify(result.execution.metadata)).not.toContain(
			input.idempotencyKey,
		);
		expect(readAgentExecutionAdmission(result.execution)?.dispatch).toEqual(
			input.dispatch,
		);
		expect(
			readAgentExecutionAdmission(result.execution)?.receiptOwner,
		).toBe("workflow");
		expect(h.audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				action: "org.agent_execution.admitted",
				metadata: expect.not.objectContaining({
					input: expect.anything(),
				}),
			}),
		);
	});
	it("normalizes object key order while preserving array order", () => {
		expect(
			normalizeAgentExecutionRequest({
				input: { a: 1, b: [2, 3] },
				priority: 5,
			}).hash,
		).toBe(
			normalizeAgentExecutionRequest({
				input: { b: [2, 3], a: 1 },
				priority: 5,
			}).hash,
		);
		expect(
			normalizeAgentExecutionRequest({
				input: { a: [1, 2] },
				priority: 5,
			}).hash,
		).not.toBe(
			normalizeAgentExecutionRequest({
				input: { a: [2, 1] },
				priority: 5,
			}).hash,
		);
	});
	it("scopes a repeated key to the actor, organization and deployment", () => {
		const key = agentExecutionAdmissionId(input, "same");
		for (const scope of [
			{ userId: "example-other" },
			{ organizationId: "example-other" },
			{ deploymentId: "example-other" },
		]) {
			expect(
				agentExecutionAdmissionId({ ...input, ...scope }, "same"),
			).not.toBe(key);
		}
	});
	it("returns an identical receipt without another insert", async () => {
		const first = await admitAgentDeploymentExecution(input);
		h.find.mockResolvedValue(first.execution);
		const again = await admitAgentDeploymentExecution(input);
		expect(again).toMatchObject({
			reused: true,
			execution: { id: first.execution.id },
		});
		expect(h.create).toHaveBeenCalledOnce();
	});
	it("rejects changed input on the same request key", async () => {
		const first = await admitAgentDeploymentExecution(input);
		h.find.mockResolvedValue(first.execution);
		await expect(
			admitAgentDeploymentExecution({
				...input,
				request: normalizeAgentExecutionRequest({
					input: { message: "Changed" },
					priority: 5,
				}),
			}),
		).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
	});
	it("reattaches the concurrent unique-key winner", async () => {
		const first = await admitAgentDeploymentExecution(input);
		h.find
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(first.execution);
		h.create.mockRejectedValueOnce({ code: "P2002" });
		expect(await admitAgentDeploymentExecution(input)).toMatchObject({
			reused: true,
			execution: { id: first.execution.id },
		});
	});
	it.each([
		undefined,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		{ bad: undefined },
		{ big: "x".repeat(70000) },
	])(
		"rejects non-JSON or oversized input before persistence",
		async (bad) => {
			expect(() =>
				normalizeAgentExecutionRequest({ input: { bad }, priority: 5 }),
			).toThrow();
			expect(h.create).not.toHaveBeenCalled();
		},
	);
	it("refuses malformed stored dispatch metadata", () => {
		expect(
			readAgentExecutionAdmission({
				metadata: {
					fabricAdmission: {
						version: 1,
						requestHash: "a".repeat(64),
						dispatch: {
							instanceId: "example",
							workflowType: "goalOrientedAgentWorkflow",
						},
						imageRefs: [],
					},
				},
			}),
		).toBeNull();
	});
	it("attaches a receipt without resetting a fast worker's status", async () => {
		h.legacy.mockResolvedValue({
			id: "example",
			runId: "example-run",
			status: "COMPLETED",
		});
		await attachAgentExecutionReceipt({
			id: "example",
			userId: "example-user",
			organizationId: "example-org",
			workflowId: "example-workflow",
			runId: "example-run",
		});
		expect(h.attach.mock.calls[0][0].data).toEqual({
			runId: "example-run",
		});
	});
	it("refuses a foreign deployment relation before execution or audit writes", async () => {
		h.deployment.mockResolvedValue(null);
		await expect(
			admitAgentDeploymentExecution(input),
		).rejects.toMatchObject({ code: "INVALID_EXECUTION_REQUEST" });
		expect(h.create).not.toHaveBeenCalled();
		expect(h.audit).not.toHaveBeenCalled();
	});
	it("rejects an empty organization even without a caller key", async () => {
		await expect(
			admitAgentDeploymentExecution({
				...input,
				organizationId: "",
				idempotencyKey: undefined,
			}),
		).rejects.toThrow("organization");
		expect(h.create).not.toHaveBeenCalled();
	});
	it("reserves execution count only for a new intent and does not charge receipt retries", async () => {
		const first = await admitAgentDeploymentExecution(input);
		h.find.mockResolvedValue(first.execution);
		await admitAgentDeploymentExecution(input);
		expect(h.reserve).toHaveBeenCalledOnce();
		expect(h.counts).toHaveBeenCalledOnce();
		expect(
			readAgentExecutionAdmission(first.execution)
				?.executionCountReserved,
		).toBe(true);
	});
	it("refuses exhausted quota within admission before audit or dispatch", async () => {
		h.reserve.mockResolvedValue({ count: 0 });
		await expect(
			admitAgentDeploymentExecution(input),
		).rejects.toMatchObject({ code: "EXECUTION_QUOTA_EXCEEDED" });
		expect(h.audit).not.toHaveBeenCalled();
	});
});
