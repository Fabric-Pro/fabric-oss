import { Prisma } from "@repo/database";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	instance: vi.fn(),
	scope: vi.fn(),
	deployment: vi.fn(),
	create: vi.fn(),
	update: vi.fn(),
	currentMember: vi.fn(),
	prior: vi.fn(),
	quota: vi.fn(),
	admit: vi.fn(),
	dispatch: vi.fn(),
}));
vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/database")>()),
	db: {
		agentTemplateInstance: { findFirst: mocks.instance },
		agentDeployment: { findFirst: mocks.deployment },
	},
	getAgentTemplateInstanceForExecution: mocks.scope,
	createAgentDeployment: mocks.create,
	updateDeploymentStatus: mocks.update,
	isDeploymentOwnerCurrentMember: mocks.currentMember,
	findAgentExecutionAdmission: mocks.prior,
	checkExecutionQuota: mocks.quota,
	admitAgentDeploymentExecution: mocks.admit,
}));
vi.mock("../../../agent-deployments/lib/dispatch-execution", () => ({
	dispatchAdmittedAgentExecution: mocks.dispatch,
}));

import type { ExternalApiContext } from "../../types";
import { executeAgent, getOrCreateDeployment } from "../execute-agent";

const instanceId = "example-instance";
const name = "Example Agent";
const organizationId = "example-org";
const userId = "example-user";
const actor: ExternalApiContext = {
	keyType: "organization",
	keyId: "example-key",
	keyPrefix: "example",
	userId,
	organizationId,
	scopes: ["agents:execute"],
};
const deployment = {
	id: "example-deployment",
	userId,
	organizationId,
	status: "ACTIVE",
};
const selectedInstance = {
	id: instanceId,
	name,
	executionMode: "single_turn",
	goal: null,
	maxIterations: null,
	deployment,
};
const body = { input: {} };
const where = { organizationId, isApiExposed: true, status: "ACTIVE" };

beforeEach(() => {
	vi.resetAllMocks();
	mocks.instance.mockResolvedValue(selectedInstance);
	mocks.scope.mockResolvedValue({
		instance: { userId, customInstructions: {} },
		projectId: undefined,
	});
	mocks.deployment.mockResolvedValue(null);
	mocks.currentMember.mockResolvedValue(true);
	mocks.prior.mockResolvedValue(null);
});

it("returns the existing deployment without creating or activating it", async () => {
	mocks.deployment.mockResolvedValue(deployment);
	await expect(
		getOrCreateDeployment(instanceId, name, actor),
	).resolves.toEqual(deployment);
	expect(mocks.deployment).toHaveBeenCalledExactlyOnceWith({
		where: { instanceId },
		select: { id: true, userId: true, organizationId: true, status: true },
	});
	expect(mocks.create).not.toHaveBeenCalled();
	expect(mocks.update).not.toHaveBeenCalled();
});

it("creates the missing deployment under the calling owner and activates it", async () => {
	mocks.create.mockResolvedValue({ ...deployment, status: "DRAFT" });
	await expect(
		getOrCreateDeployment(instanceId, name, actor),
	).resolves.toEqual(deployment);
	expect(mocks.create).toHaveBeenCalledExactlyOnceWith({
		instanceId,
		userId,
		organizationId,
		name,
		slug: expect.stringMatching(/^api-instance-\d+$/),
	});
	expect(mocks.update).toHaveBeenCalledExactlyOnceWith(
		deployment.id,
		"ACTIVE",
		{ deployedAt: expect.any(Date) },
	);
});

const duplicate = () =>
	new Prisma.PrismaClientKnownRequestError("Duplicate deployment", {
		code: "P2002",
		clientVersion: "example",
	});

it("reuses a concurrent deployment after a unique constraint conflict", async () => {
	mocks.deployment
		.mockResolvedValueOnce(null)
		.mockResolvedValueOnce(deployment);
	mocks.create.mockRejectedValue(duplicate());
	await expect(
		getOrCreateDeployment(instanceId, name, actor),
	).resolves.toEqual(deployment);
	expect(mocks.deployment).toHaveBeenCalledTimes(2);
	expect(mocks.update).not.toHaveBeenCalled();
});

it("propagates a unique conflict if no concurrent deployment is found", async () => {
	const error = duplicate();
	mocks.create.mockRejectedValue(error);
	await expect(getOrCreateDeployment(instanceId, name, actor)).rejects.toBe(
		error,
	);
	expect(mocks.deployment).toHaveBeenCalledTimes(2);
	expect(mocks.update).not.toHaveBeenCalled();
});

it("propagates other create errors without looking for a concurrent deployment", async () => {
	const error = new Prisma.PrismaClientKnownRequestError(
		"Missing reference",
		{ code: "P2003", clientVersion: "example" },
	);
	mocks.create.mockRejectedValue(error);
	await expect(getOrCreateDeployment(instanceId, name, actor)).rejects.toBe(
		error,
	);
	expect(mocks.deployment).toHaveBeenCalledOnce();
	expect(mocks.update).not.toHaveBeenCalled();
});

it("limits both instance identifiers to exposed agents in the key's organization", async () => {
	mocks.instance.mockResolvedValue(null);
	await expect(executeAgent(instanceId, body, actor)).resolves.toEqual({
		error: "Agent not found",
		status: 404,
	});
	expect(mocks.instance.mock.calls.map(([query]) => query.where)).toEqual([
		{ sId: instanceId, ...where },
		{ id: instanceId, ...where },
	]);
	expect(mocks.scope).not.toHaveBeenCalled();
	expect(mocks.admit).not.toHaveBeenCalled();
});

it("rejects an invalid request key before looking up an agent", async () => {
	await expect(
		executeAgent(instanceId, { ...body, idempotencyKey: " " }, actor),
	).resolves.toMatchObject({
		status: 400,
		error: { code: "INVALID_EXECUTION_REQUEST" },
	});
	expect(mocks.instance).not.toHaveBeenCalled();
	expect(mocks.admit).not.toHaveBeenCalled();
});

it("refuses a deployment from a different organization before admission", async () => {
	mocks.instance.mockResolvedValue({
		...selectedInstance,
		deployment: { ...deployment, organizationId: "other-org" },
	});
	await expect(executeAgent(instanceId, body, actor)).resolves.toEqual({
		error: "This deployment must be executed by its owner",
		status: 403,
	});
	expect(mocks.currentMember).not.toHaveBeenCalled();
	expect(mocks.admit).not.toHaveBeenCalled();
});

it("refuses a raced deployment owned by someone else even after checking the instance owner", async () => {
	mocks.instance.mockResolvedValue({ ...selectedInstance, deployment: null });
	mocks.deployment.mockResolvedValue({ ...deployment, userId: "other-user" });
	await expect(executeAgent(instanceId, body, actor)).resolves.toEqual({
		error: "This deployment must be executed by its owner",
		status: 403,
	});
	expect(mocks.currentMember).not.toHaveBeenCalled();
	expect(mocks.admit).not.toHaveBeenCalled();
});

it("reports spent quota after rechecking for a concurrent receipt", async () => {
	mocks.quota.mockResolvedValue({
		allowed: false,
		reason: "Example quota exhausted",
	});
	await expect(executeAgent(instanceId, body, actor)).resolves.toEqual({
		error: "Example quota exhausted",
		status: 429,
	});
	expect(mocks.quota).toHaveBeenCalledExactlyOnceWith(
		deployment.id,
		userId,
		organizationId,
	);
	expect(mocks.prior).toHaveBeenCalledTimes(2);
	expect(mocks.admit).not.toHaveBeenCalled();
	expect(mocks.dispatch).not.toHaveBeenCalled();
});

it("adopts and serializes a completed goal-oriented execution", async () => {
	mocks.instance.mockResolvedValueOnce(null).mockResolvedValueOnce({
		...selectedInstance,
		executionMode: "goal_oriented",
		goal: null,
		maxIterations: null,
	});
	mocks.quota.mockResolvedValue({ allowed: true });
	const row = {
		id: "example-execution",
		deploymentId: deployment.id,
		status: "COMPLETED",
		output: { answer: "Example" },
		executionId: "example-channel",
		workflowId: "example-workflow",
		runId: "example-run",
	};
	mocks.admit.mockResolvedValue({ execution: row, reused: false });
	mocks.dispatch.mockResolvedValue({ execution: row, confirmed: true });
	expect(
		await executeAgent(instanceId, body, { ...actor, keyType: "oauth" }),
	).toMatchObject({
		status: 202,
		data: {
			executionId: row.id,
			status: "COMPLETED",
			output: row.output,
			idempotent: false,
		},
	});
	expect(mocks.scope).toHaveBeenCalledExactlyOnceWith({
		instanceId,
		userId,
		organizationId,
	});
	expect(mocks.admit).toHaveBeenCalledExactlyOnceWith(
		expect.objectContaining({
			actor: { type: "agent", userId },
			dispatch: {
				instanceId,
				workflowType: "nativeGoalOrientedAgentWorkflow",
				goal: "Complete the requested task",
				maxIterations: 10,
			},
		}),
	);
	expect(mocks.dispatch).toHaveBeenCalledExactlyOnceWith(row, {
		allowStart: true,
	});
});
