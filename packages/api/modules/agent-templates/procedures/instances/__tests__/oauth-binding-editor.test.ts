/**
 * Agent-template instance update by an authorized editor who is not the
 * owner. The editor UI re-sends every OAuth selection as an `"oauth"` marker
 * on each save, including a name-only edit, so validation must accept a
 * marker for a provider already bound on the instance (the update keeps that
 * binding) and require the editor's OWN connection only for a newly selected
 * provider — never a teammate's.
 *
 * Runs the real `validateAllConnections` against an in-memory
 * WorkflowIntegration store.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createWorkflowIntegrationStore,
	type StoredRow,
} from "../../../../integrations/__tests__/procedures/workflow-integration-store";

const store = vi.hoisted(() => ({
	current: null as null | ReturnType<
		typeof import("../../../../integrations/__tests__/procedures/workflow-integration-store").createWorkflowIntegrationStore
	>,
}));

const {
	mockGetAgentTemplateInstance,
	mockGetBoundOAuthProviderTypes,
	mockUpdateAgentTemplateInstance,
	mockVerifyOrganizationMembership,
} = vi.hoisted(() => ({
	mockGetAgentTemplateInstance: vi.fn(),
	mockGetBoundOAuthProviderTypes: vi.fn(),
	mockUpdateAgentTemplateInstance: vi.fn(),
	mockVerifyOrganizationMembership: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		get workflowIntegration() {
			if (!store.current) {
				throw new Error("store not seeded");
			}
			return store.current.delegate;
		},
	},
	archiveInstanceVersion: vi.fn(),
	getAgentTemplateInstance: (...a: unknown[]) =>
		mockGetAgentTemplateInstance(...a),
	getBoundOAuthProviderTypes: (...a: unknown[]) =>
		mockGetBoundOAuthProviderTypes(...a),
	getWorkflowIntegrationByIdInTenant: vi.fn(),
	getWorkspaceAccessContext: vi.fn(),
	restoreInstanceVersion: vi.fn(),
	updateAgentTemplateInstance: (...a: unknown[]) =>
		mockUpdateAgentTemplateInstance(...a),
}));

vi.mock("@repo/database/prisma/client", () => ({ db: {} }));

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
	};
});

import { updateInstanceProcedure } from "../update";

type Handler = (args: {
	input: Record<string, unknown>;
	context: { user: { id: string }; session: unknown };
}) => Promise<unknown>;

const updateHandler = (
	updateInstanceProcedure as unknown as { _handler: Handler }
)._handler;

const connection = (
	id: string,
	userId: string,
	provider: string,
): StoredRow => ({
	id,
	userId,
	organizationId: "org-example",
	provider,
	name: provider,
	isActive: true,
	credentials: "{}",
});

// Owner (user-1) is connected to Notion and Drive; the editor (user-2) is
// connected to nothing unless a test adds a row.
const ownerNotion = connection("wi-notion-owner", "user-1", "NOTION");
const ownerDrive = connection("wi-drive-owner", "user-1", "GOOGLE_DRIVE");

function seed(rows: StoredRow[]) {
	store.current = createWorkflowIntegrationStore();
	store.current.rows.push(...rows);
}

function editAsEditor(knowledgeConnections: Record<string, string>) {
	return updateHandler({
		input: {
			id: "instance-1",
			name: "Renamed agent",
			knowledgeConnections,
			createNewVersion: false,
		},
		context: { user: { id: "user-2" }, session: {} },
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mockVerifyOrganizationMembership.mockResolvedValue({ id: "member-2" });
	mockGetAgentTemplateInstance.mockResolvedValue({
		id: "instance-1",
		userId: "user-1",
		organizationId: "org-example",
	});
	// The instance already binds the owner's Notion connection.
	mockGetBoundOAuthProviderTypes.mockResolvedValue(new Set(["NOTION"]));
	mockUpdateAgentTemplateInstance.mockResolvedValue({ id: "instance-1" });
});

describe("agent instance update by another editor: OAuth bindings", () => {
	it("a metadata-only edit saves even though the editor has no Notion connection", async () => {
		seed([ownerNotion]);

		await expect(editAsEditor({ NOTION: "oauth" })).resolves.toEqual({
			instance: { id: "instance-1" },
		});
		expect(mockUpdateAgentTemplateInstance).toHaveBeenCalledWith(
			expect.objectContaining({
				knowledgeConnections: { NOTION: "oauth" },
			}),
		);
	});

	it("newly adding a provider still requires the editor's own connection", async () => {
		seed([ownerNotion, ownerDrive]);

		await expect(
			editAsEditor({ NOTION: "oauth", GOOGLE_DRIVE: "oauth" }),
		).rejects.toThrow(
			/OAuth connection for GOOGLE_DRIVE is not established/,
		);
		expect(mockUpdateAgentTemplateInstance).not.toHaveBeenCalled();
	});

	it("newly adding a provider succeeds with the editor's own connection", async () => {
		seed([
			ownerNotion,
			ownerDrive,
			connection("wi-drive-editor", "user-2", "GOOGLE_DRIVE"),
		]);

		await expect(
			editAsEditor({ NOTION: "oauth", GOOGLE_DRIVE: "oauth" }),
		).resolves.toEqual({ instance: { id: "instance-1" } });
	});
});
