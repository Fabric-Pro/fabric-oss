/**
 * Agent-template instance create/update — attached workspaces are bound to the
 * instance's tenant.
 *
 * The workspace ids an instance stores are trusted at execution time: the
 * agentic loop's data-source tools query `workspace_<id>` directly with no
 * tenancy recheck. So the attach-time check must refuse a workspace hosted by
 * a different organization even when the caller can open it (a member of both
 * organizations), not only a workspace the caller cannot open at all.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockCreateAgentTemplateInstance,
	mockGetAgentTemplate,
	mockGetAgentTemplateInstance,
	mockGetWorkspaceAccessContext,
	mockUpdateAgentTemplateInstance,
	mockVerifyOrganizationMembership,
} = vi.hoisted(() => ({
	mockCreateAgentTemplateInstance: vi.fn(),
	mockGetAgentTemplate: vi.fn(),
	mockGetAgentTemplateInstance: vi.fn(),
	mockGetWorkspaceAccessContext: vi.fn(),
	mockUpdateAgentTemplateInstance: vi.fn(),
	mockVerifyOrganizationMembership: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	archiveInstanceVersion: vi.fn(),
	createAgentTemplateInstance: (...a: unknown[]) =>
		mockCreateAgentTemplateInstance(...a),
	getAgentTemplate: (...a: unknown[]) => mockGetAgentTemplate(...a),
	getAgentTemplateInstance: (...a: unknown[]) =>
		mockGetAgentTemplateInstance(...a),
	getWorkspaceAccessContext: (...a: unknown[]) =>
		mockGetWorkspaceAccessContext(...a),
	initializeMemoryFromTemplate: vi.fn().mockResolvedValue(undefined),
	restoreInstanceVersion: vi.fn(),
	updateAgentTemplateInstance: (...a: unknown[]) =>
		mockUpdateAgentTemplateInstance(...a),
	writeMemoryFile: vi.fn(),
}));

vi.mock("@repo/database/prisma/client", () => ({ db: {} }));

vi.mock("../../../lib/validate-connections", async (importOriginal) => {
	const real =
		await importOriginal<
			typeof import("../../../lib/validate-connections")
		>();
	return {
		...real,
		validateAllConnections: vi
			.fn()
			.mockResolvedValue({ valid: true, errors: [] }),
	};
});

vi.mock("../../../../agent-deployments/lib/sync-triggers", () => ({
	syncDeploymentTriggers: vi.fn(),
}));

vi.mock("../../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: (...a: unknown[]) =>
		mockVerifyOrganizationMembership(...a),
}));

// Chainable oRPC procedure stub; each built procedure exposes its handler.
vi.mock("../../../../../orpc/procedures", () => {
	function makeChainable() {
		const c: Record<string, unknown> = {};
		Object.assign(c, {
			use: () => c,
			route: () => c,
			input: () => c,
			handler: (fn: (...args: unknown[]) => unknown) => ({
				_handler: fn,
			}),
		});
		return c;
	}
	return {
		get tenantProtectedProcedure() {
			return makeChainable();
		},
		Permissions: { AGENT_TEMPLATE_MANAGE: "AGENT_TEMPLATE_MANAGE" },
		requirePermission: () => (c: unknown) => c,
		resolveOrganizationId: (input: string | null | undefined) =>
			input ?? null,
	};
});

import { createInstanceProcedure } from "../create";
import { updateInstanceProcedure } from "../update";

type Handler = (args: {
	input: Record<string, unknown>;
	context: { user: { id: string }; session: unknown };
}) => Promise<unknown>;

const createHandler = (
	createInstanceProcedure as unknown as { _handler: Handler }
)._handler;
const updateHandler = (
	updateInstanceProcedure as unknown as { _handler: Handler }
)._handler;

const USER_ID = "user-1";
const ORG_A = "org-a";
const ORG_B = "org-b";
const context = { user: { id: USER_ID }, session: {} };

const createInput = (workspaceIds: string[]) => ({
	organizationId: ORG_A,
	templateId: "template-1",
	name: "Agent",
	description: "An agent",
	customInstructions: { role: "Helper" },
	workspaceIds,
	executionMode: "single_turn",
	maxIterations: 10,
});

beforeEach(() => {
	vi.clearAllMocks();
	mockVerifyOrganizationMembership.mockResolvedValue({ id: "member-1" });
	mockGetAgentTemplate.mockResolvedValue({
		id: "template-1",
		scope: "SYSTEM",
		organizationId: null,
		userId: null,
	});
	mockCreateAgentTemplateInstance.mockResolvedValue({ id: "instance-1" });
	mockGetAgentTemplateInstance.mockResolvedValue({
		id: "instance-1",
		userId: USER_ID,
		organizationId: ORG_A,
	});
	mockUpdateAgentTemplateInstance.mockResolvedValue({ id: "instance-1" });
});

describe("createInstanceProcedure — workspace tenant binding", () => {
	it("refuses a workspace hosted by a different organization the caller can open, and persists nothing", async () => {
		mockGetWorkspaceAccessContext.mockResolvedValue({
			organizationId: ORG_B,
		});

		await expect(
			createHandler({ input: createInput(["ws-b"]), context }),
		).rejects.toThrow("You don't have access to workspace ws-b");
		expect(mockGetWorkspaceAccessContext).toHaveBeenCalledWith(
			"ws-b",
			USER_ID,
		);
		expect(mockCreateAgentTemplateInstance).not.toHaveBeenCalled();
	});

	it("refuses a workspace the caller cannot open", async () => {
		mockGetWorkspaceAccessContext.mockResolvedValue(null);

		await expect(
			createHandler({ input: createInput(["ws-x"]), context }),
		).rejects.toThrow("You don't have access to workspace ws-x");
		expect(mockCreateAgentTemplateInstance).not.toHaveBeenCalled();
	});

	it("refuses a personal workspace on an organization instance", async () => {
		mockGetWorkspaceAccessContext.mockResolvedValue({
			organizationId: null,
		});

		await expect(
			createHandler({ input: createInput(["ws-p"]), context }),
		).rejects.toThrow("You don't have access to workspace ws-p");
		expect(mockCreateAgentTemplateInstance).not.toHaveBeenCalled();
	});

	it("accepts a workspace hosted by the instance's organization", async () => {
		mockGetWorkspaceAccessContext.mockResolvedValue({
			organizationId: ORG_A,
		});

		await createHandler({ input: createInput(["ws-a"]), context });
		expect(mockCreateAgentTemplateInstance).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: ORG_A,
				workspaceIds: ["ws-a"],
			}),
		);
	});
});

describe("updateInstanceProcedure — workspace tenant binding", () => {
	it("refuses a workspace hosted by a different organization the caller can open, and persists nothing", async () => {
		mockGetWorkspaceAccessContext.mockResolvedValue({
			organizationId: ORG_B,
		});

		await expect(
			updateHandler({
				input: {
					id: "instance-1",
					workspaceIds: ["ws-b"],
					createNewVersion: false,
				},
				context,
			}),
		).rejects.toThrow("You don't have access to workspace ws-b");
		expect(mockGetWorkspaceAccessContext).toHaveBeenCalledWith(
			"ws-b",
			USER_ID,
		);
		expect(mockUpdateAgentTemplateInstance).not.toHaveBeenCalled();
	});

	it("refuses an organization workspace on a personal instance", async () => {
		mockGetAgentTemplateInstance.mockResolvedValue({
			id: "instance-1",
			userId: USER_ID,
			organizationId: null,
		});
		mockGetWorkspaceAccessContext.mockResolvedValue({
			organizationId: ORG_A,
		});

		await expect(
			updateHandler({
				input: {
					id: "instance-1",
					workspaceIds: ["ws-a"],
					createNewVersion: false,
				},
				context,
			}),
		).rejects.toThrow("You don't have access to workspace ws-a");
		expect(mockUpdateAgentTemplateInstance).not.toHaveBeenCalled();
	});

	it("accepts a workspace hosted by the instance's organization", async () => {
		mockGetWorkspaceAccessContext.mockResolvedValue({
			organizationId: ORG_A,
		});

		await updateHandler({
			input: {
				id: "instance-1",
				workspaceIds: ["ws-a"],
				createNewVersion: false,
			},
			context,
		});
		expect(mockUpdateAgentTemplateInstance).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "instance-1",
				organizationId: ORG_A,
				workspaceIds: ["ws-a"],
			}),
		);
	});
});
