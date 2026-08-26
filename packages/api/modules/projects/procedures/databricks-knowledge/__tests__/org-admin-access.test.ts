/**
 * Regression: org admins/owners WITHOUT a ProjectMember row must be able to
 * manage the project's Databricks knowledge binding.
 *
 * `requireProjectPermission` is the sole authorization gate for these
 * procedures — it resolves effective permissions including org admins/owners
 * who have no explicit ProjectMember row (path C of its resolution order).
 * An earlier revision re-checked with the legacy `hasProjectAccess` helper
 * inside the handlers, which does NOT recognize that org-role path and
 * denied exactly those admins.
 *
 * These tests invoke the handlers directly (the middleware is stubbed, as an
 * admitted caller) with `hasProjectAccess` mocked to REJECT everyone — if any
 * handler still consulted it, the calls below would throw FORBIDDEN.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	hasProjectAccessMock,
	getBindingMock,
	saveBindingMock,
	deleteBindingMock,
	projectFindUniqueMock,
	recordAuditMock,
} = vi.hoisted(() => ({
	hasProjectAccessMock: vi.fn(),
	getBindingMock: vi.fn(),
	saveBindingMock: vi.fn(),
	deleteBindingMock: vi.fn(),
	projectFindUniqueMock: vi.fn(),
	recordAuditMock: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	hasProjectAccess: hasProjectAccessMock,
	getProjectDatabricksKnowledgeBinding: getBindingMock,
	saveProjectDatabricksKnowledgeBinding: saveBindingMock,
	deleteProjectDatabricksKnowledgeBinding: deleteBindingMock,
	InvalidDatabricksKnowledgeIntegrationError: class extends Error {},
	db: { project: { findUnique: projectFindUniqueMock } },
}));

vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: recordAuditMock,
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => ({ _handler: fn }),
	});
	return {
		tenantProtectedProcedure: chainable,
		requireProjectPermission: () => () => ({}),
		Permissions: {
			PROJECT_READ: "project:read",
			PROJECT_SETTINGS_EDIT: "project:settings:edit",
		} as const,
	};
});

vi.mock("@orpc/client", () => ({
	ORPCError: class extends Error {
		readonly code: string;
		constructor(code: string, opts?: { message?: string }) {
			super(opts?.message ?? code);
			this.code = code;
		}
	},
}));

/**
 * An org ADMIN acting via their org role: they passed the (stubbed)
 * permission middleware, but they own no ProjectMember row — which is why
 * hasProjectAccess below is pinned to reject them.
 */
const orgAdminCtx = {
	user: {
		id: "org-admin-1",
		email: "admin@example.com",
		name: "Org Admin",
	},
	headers: new Headers(),
	session: { id: "session-1" },
};

type CapturedHandler = (args: {
	input: Record<string, unknown>;
	context: typeof orgAdminCtx;
}) => Promise<unknown>;

beforeEach(() => {
	vi.clearAllMocks();
	// The legacy helper would say NO for this caller (no ProjectMember row).
	// Nothing may consult it anymore.
	hasProjectAccessMock.mockResolvedValue(false);
	projectFindUniqueMock.mockResolvedValue({ organizationId: "org-1" });
});

describe("org admin without a ProjectMember row", () => {
	it("can GET the binding", async () => {
		getBindingMock.mockResolvedValue({
			id: "bind_1",
			integrationId: "int_1",
		});
		const mod = await import("../get-databricks-knowledge");
		const handler = (
			mod.getProjectDatabricksKnowledgeProcedure as unknown as {
				_handler: CapturedHandler;
			}
		)._handler;

		await expect(
			handler({
				input: { projectId: "proj_1", organizationId: "org-1" },
				context: orgAdminCtx,
			}),
		).resolves.toEqual({
			binding: { id: "bind_1", integrationId: "int_1" },
		});
		expect(hasProjectAccessMock).not.toHaveBeenCalled();
	});

	it("can SAVE the binding", async () => {
		saveBindingMock.mockResolvedValue({ id: "bind_1" });
		const mod = await import("../save-databricks-knowledge");
		const handler = (
			mod.saveProjectDatabricksKnowledgeProcedure as unknown as {
				_handler: CapturedHandler;
			}
		)._handler;

		await expect(
			handler({
				input: {
					projectId: "proj_1",
					organizationId: "org-1",
					integrationId: "int_1",
					schema: "cat.schema",
					indexes: ["cat.schema.idx_a"],
				},
				context: orgAdminCtx,
			}),
		).resolves.toEqual({ binding: { id: "bind_1" } });
		expect(hasProjectAccessMock).not.toHaveBeenCalled();
		expect(saveBindingMock).toHaveBeenCalledWith({
			projectId: "proj_1",
			integrationId: "int_1",
			schema: "cat.schema",
			indexNames: ["cat.schema.idx_a"],
			createdBy: "org-admin-1",
		});
		expect(recordAuditMock).toHaveBeenCalledWith(
			orgAdminCtx,
			expect.objectContaining({
				action: "project.databricks_knowledge.connected",
			}),
		);
	});

	it("can DELETE the binding", async () => {
		deleteBindingMock.mockResolvedValue({
			id: "bind_1",
			integrationId: "int_1",
		});
		const mod = await import("../delete-databricks-knowledge");
		const handler = (
			mod.deleteProjectDatabricksKnowledgeProcedure as unknown as {
				_handler: CapturedHandler;
			}
		)._handler;

		await expect(
			handler({
				input: { projectId: "proj_1", organizationId: "org-1" },
				context: orgAdminCtx,
			}),
		).resolves.toEqual({ deleted: true });
		expect(hasProjectAccessMock).not.toHaveBeenCalled();
		expect(recordAuditMock).toHaveBeenCalledWith(
			orgAdminCtx,
			expect.objectContaining({
				action: "project.databricks_knowledge.disconnected",
			}),
		);
	});
});
