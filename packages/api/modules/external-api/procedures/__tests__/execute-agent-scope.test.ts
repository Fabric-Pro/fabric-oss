import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	find: vi.fn(),
	scope: vi.fn(),
	quota: vi.fn(),
	transaction: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: {
		agentTemplateInstance: { findFirst: h.find },
		$transaction: h.transaction,
	},
	getAgentTemplateInstanceForExecution: h.scope,
	checkExecutionQuota: h.quota,
	createAgentDeployment: vi.fn(),
	updateDeploymentStatus: vi.fn(),
	Prisma: {},
	normalizeAgentExecutionRequest: (request: unknown) => ({
		value: request,
		hash: "a".repeat(64),
	}),
	validateAgentExecutionRequestKey: vi.fn(),
	AgentExecutionAdmissionError: class extends Error {},
	admitAgentDeploymentExecution: vi.fn(),
	findAgentExecutionAdmission: vi.fn(),
}));
vi.mock("@repo/temporal", () => ({ getTemporalClient: vi.fn() }));

import type { ExternalApiContext } from "../../types";
import { executeAgent } from "../execute-agent";

const actor: ExternalApiContext = {
	keyType: "organization",
	keyId: "example-key",
	keyPrefix: "example",
	userId: "example-caller",
	organizationId: "example-org",
	scopes: ["agents:execute"],
};
beforeEach(() => {
	vi.clearAllMocks();
	h.find.mockResolvedValue({
		id: "example-instance",
		name: "Example",
		deployment: {
			id: "example-deployment",
			userId: "example-caller",
			organizationId: actor.organizationId,
		},
	});
	h.scope.mockResolvedValue({
		instance: { customInstructions: {} },
		projectId: "example-project",
	});
});
describe("external instance execution uses the credential creator's current scope", () => {
	it("denies revoked project access before deployment/quota/workflow side effects", async () => {
		h.scope.mockResolvedValue(null);
		expect(
			await executeAgent("example-instance", { input: {} }, actor),
		).toMatchObject({ status: 404 });
		expect(h.quota).not.toHaveBeenCalled();
		expect(h.transaction).not.toHaveBeenCalled();
	});
	it("refuses to borrow a deployment owner's credentials", async () => {
		h.find.mockResolvedValue({
			id: "example-instance",
			deployment: {
				id: "example-deployment",
				userId: "example-owner",
				organizationId: actor.organizationId,
			},
		});
		expect(
			await executeAgent("example-instance", { input: {} }, actor),
		).toMatchObject({ status: 403 });
		expect(h.quota).not.toHaveBeenCalled();
	});
	it("does not activate unavailable Harness definitions", async () => {
		h.scope.mockResolvedValue({
			instance: {
				customInstructions: {
					portableImplementation: { kind: "harness_finite" },
				},
			},
		});
		expect(
			await executeAgent("example-instance", { input: {} }, actor),
		).toMatchObject({ status: 409 });
		expect(h.quota).not.toHaveBeenCalled();
	});
	it("does not let a project-bound credential reach another agent project", async () => {
		expect(
			await executeAgent(
				"example-instance",
				{ input: {} },
				{ ...actor, boundProjectId: "example-other" },
			),
		).toMatchObject({ status: 404 });
	});
	it("requires an organization", async () => {
		expect(
			await executeAgent(
				"example-instance",
				{ input: {} },
				{ ...actor, organizationId: undefined },
			),
		).toMatchObject({ status: 403 });
		expect(h.find).not.toHaveBeenCalled();
	});
	it("does not let the first caller claim an undeployed agent owned by another member", async () => {
		h.find.mockResolvedValue({ id: "example-instance", deployment: null });
		h.scope.mockResolvedValue({
			instance: { customInstructions: {}, userId: "example-author" },
		});
		expect(
			await executeAgent("example-instance", { input: {} }, actor),
		).toMatchObject({ status: 403 });
		expect(h.quota).not.toHaveBeenCalled();
		expect(h.transaction).not.toHaveBeenCalled();
	});
});
