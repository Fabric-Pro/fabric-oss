import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	find: vi.fn(),
	scope: vi.fn(),
	prior: vi.fn(),
	admit: vi.fn(),
	quota: vi.fn(),
	dispatch: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: { agentTemplateInstance: { findFirst: h.find } },
	getAgentTemplateInstanceForExecution: h.scope,
	findAgentExecutionAdmission: h.prior,
	admitAgentDeploymentExecution: h.admit,
	checkExecutionQuota: h.quota,
	normalizeAgentExecutionRequest: (request: unknown) => ({
		value: request,
		hash: "a".repeat(64),
	}),
	validateAgentExecutionRequestKey: vi.fn(),
	AgentExecutionAdmissionError: class extends Error {},
	createAgentDeployment: vi.fn(),
	updateDeploymentStatus: vi.fn(),
	Prisma: {},
}));
vi.mock("../../../agent-deployments/lib/dispatch-execution", () => ({
	dispatchAdmittedAgentExecution: h.dispatch,
}));
vi.mock("../../../../lib/correlation-id", () => ({
	getCorrelationIdFromContext: () => "example-correlation",
}));

import type { ExternalApiContext } from "../../types";
import { executeAgent } from "../execute-agent";

const ctx: ExternalApiContext = {
	userId: "example-user",
	organizationId: "example-org",
	keyType: "organization",
	keyId: "example-key",
	keyPrefix: "example",
	scopes: ["agents:execute"],
};
const row = {
	id: "example-execution",
	executionId: "example-channel",
	deploymentId: "example-deployment",
	userId: ctx.userId,
	organizationId: ctx.organizationId,
	workflowId: "example-workflow",
	runId: "example-run",
	status: "PENDING",
	output: null,
};
const call = () =>
	executeAgent(
		"example-instance",
		{ input: { message: "Example" }, idempotencyKey: "example-request" },
		ctx,
	);
beforeEach(() => {
	vi.clearAllMocks();
	h.find.mockResolvedValue({
		id: "example-instance",
		name: "Example",
		executionMode: "single_turn",
		deployment: {
			id: row.deploymentId,
			status: "ACTIVE",
			userId: ctx.userId,
			organizationId: ctx.organizationId,
		},
	});
	h.scope.mockResolvedValue({
		instance: { customInstructions: {} },
		projectId: "example-project",
	});
	h.prior.mockResolvedValue(null);
	h.quota.mockResolvedValue({ allowed: true });
	h.admit.mockResolvedValue({ execution: row, reused: false });
	h.dispatch.mockResolvedValue({ execution: row, confirmed: true });
});
describe("real saved-agent execution entry point", () => {
	it.each([
		["identity_mismatch", "does not match this request"],
		["legacy_start_unconfirmed", "cannot confirm this older execution"],
		["missing_admission", "no recoverable admission snapshot"],
	])(
		"explains %s without inviting an unsafe replacement",
		async (reason, message) => {
			h.dispatch.mockResolvedValue({
				execution: row,
				confirmed: false,
				recoverable: false,
				reason,
			});
			expect(await call()).toMatchObject({
				status: 503,
				error: {
					code: "ADMISSION_UNRESOLVED",
					message: expect.stringContaining(message),
					data: { retryable: false, executionId: row.id },
				},
			});
		},
	);
	it("adopts a durable receipt before dispatch and returns actual pending status", async () => {
		expect(await call()).toMatchObject({
			status: 202,
			data: {
				executionId: row.id,
				status: "PENDING",
				admissionStatus: "CONFIRMED",
				idempotent: false,
			},
		});
		const admittedAt = h.admit.mock.invocationCallOrder[0];
		const dispatchedAt = h.dispatch.mock.invocationCallOrder[0];
		if (admittedAt === undefined || dispatchedAt === undefined) {
			throw new Error("Admission and dispatch must both run");
		}
		expect(admittedAt).toBeLessThan(dispatchedAt);
		expect(h.admit).toHaveBeenCalledWith(
			expect.objectContaining({
				dispatch: expect.objectContaining({
					projectId: "example-project",
				}),
				correlationId: "example-correlation",
			}),
		);
	});
	it("reattaches an existing request even when the current quota is spent", async () => {
		h.prior.mockResolvedValue(row);
		h.quota.mockResolvedValue({ allowed: false });
		expect(await call()).toMatchObject({
			status: 200,
			data: { idempotent: true },
		});
		expect(h.quota).not.toHaveBeenCalled();
		expect(h.admit).not.toHaveBeenCalled();
	});
	it("returns an actionable same-key unresolved receipt rather than declaring failed work", async () => {
		h.dispatch.mockResolvedValue({
			execution: { ...row, runId: null },
			confirmed: false,
		});
		expect(await call()).toMatchObject({
			status: 503,
			error: {
				code: "ADMISSION_UNRESOLVED",
				data: {
					executionId: row.id,
					workflowId: row.workflowId,
					retryable: true,
				},
			},
		});
	});
	it("does not mark an unknown outcome retryable when no request key was supplied", async () => {
		h.dispatch.mockResolvedValue({ execution: row, confirmed: false });
		expect(
			await executeAgent("example-instance", { input: {} }, ctx),
		).toMatchObject({ status: 503, error: { data: { retryable: false } } });
	});
	it("rechecks object permission before any quota/admission", async () => {
		h.scope.mockResolvedValue(null);
		expect(await call()).toMatchObject({ status: 404 });
		expect(h.quota).not.toHaveBeenCalled();
		expect(h.admit).not.toHaveBeenCalled();
	});
	it("does not expose a recovered output after permission revocation at dispatch", async () => {
		h.prior.mockResolvedValue({
			...row,
			status: "COMPLETED",
			output: "Private",
		});
		h.dispatch.mockResolvedValue({
			execution: row,
			confirmed: false,
			revoked: true,
		});
		expect(await call()).toMatchObject({ status: 404 });
	});
	it("recovers an identical concurrent winner before returning spent-quota refusal", async () => {
		h.prior.mockResolvedValueOnce(null).mockResolvedValueOnce(row);
		h.quota.mockResolvedValue({ allowed: false });
		expect(await call()).toMatchObject({
			status: 200,
			data: { executionId: row.id, idempotent: true },
		});
		expect(h.admit).not.toHaveBeenCalled();
	});

	it("does not admit new work to a paused deployment", async () => {
		h.find.mockResolvedValue({
			id: "example-instance",
			name: "Example",
			deployment: {
				id: row.deploymentId,
				userId: ctx.userId,
				organizationId: ctx.organizationId,
				status: "PAUSED",
			},
		});
		expect(await call()).toMatchObject({ status: 409 });
		expect(h.admit).not.toHaveBeenCalled();
	});
});
