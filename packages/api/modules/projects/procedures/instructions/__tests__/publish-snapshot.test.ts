import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	handlers: {} as Record<string, (...a: unknown[]) => unknown>,
	publishInstructionSnapshot: vi.fn(),
	resolveEffectiveProjectPermissions: vi.fn(),
	recordAuditFromRequest: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	publishInstructionSnapshot: (...a: unknown[]) =>
		m.publishInstructionSnapshot(...a),
}));
vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: (...a: unknown[]) => m.recordAuditFromRequest(...a),
}));
vi.mock("../../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: (...a: unknown[]) =>
		m.resolveEffectiveProjectPermissions(...a),
}));
vi.mock("../../../../../orpc/procedures", () => {
	const b = {
		use: () => b,
		route: () => b,
		input: () => b,
		handler: (fn: (...a: unknown[]) => unknown) => {
			m.handlers.publish = fn;
			return fn;
		},
	};
	return {
		tenantProtectedProcedure: b,
		requireProjectPermission: () => ({}),
		Permissions: { INSTRUCTION_UPDATE: "instruction:update" },
	};
});
import "../publish-snapshot";
const ctx = { user: { id: "u" }, session: { activeOrganizationId: "org_1" } };
beforeEach(() => {
	m.publishInstructionSnapshot.mockReset();
	m.recordAuditFromRequest.mockReset();
	m.resolveEffectiveProjectPermissions.mockResolvedValue({
		permissions: [],
		source: "org",
		organizationId: "org_1",
	});
});

describe("projects.instructions.publish", () => {
	it("publishes and audits the call that moved the pointer", async () => {
		m.publishInstructionSnapshot.mockResolvedValue({
			published: true,
			changed: true,
		});
		await expect(
			m.handlers.publish!({
				input: { projectId: "p", snapshotId: "s" },
				context: ctx,
			}),
		).resolves.toEqual({ published: true });
		expect(m.recordAuditFromRequest).toHaveBeenCalledWith(
			ctx,
			expect.objectContaining({
				action: "project.instructions.published",
			}),
		);
	});

	// M1: the query reports `published: true` for the idempotent case too, so
	// auditing on `published` recorded a second publication for one pointer
	// transition — which is exactly what a lost response plus a client retry
	// produces. The Temporal activity already gated on `changed`.
	it("records no audit for a repeat publish of the snapshot that is already the pointer", async () => {
		m.publishInstructionSnapshot.mockResolvedValue({
			published: true,
			changed: false,
		});

		await expect(
			m.handlers.publish!({
				input: { projectId: "p", snapshotId: "s" },
				context: ctx,
			}),
		).resolves.toEqual({ published: true });
		expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
	});
	it("maps an older snapshot to CONFLICT and does not audit", async () => {
		m.publishInstructionSnapshot.mockResolvedValue({
			published: false,
			reason: "older_than_current",
		});
		await expect(
			m.handlers.publish!({
				input: { projectId: "p", snapshotId: "s" },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
	});
	it("maps a missing snapshot to NOT_FOUND and does not audit", async () => {
		m.publishInstructionSnapshot.mockResolvedValue({
			published: false,
			reason: "not_found",
		});
		await expect(
			m.handlers.publish!({
				input: { projectId: "p", snapshotId: "s" },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
	});
	it("throws FORBIDDEN and never calls publishInstructionSnapshot when the organization cannot be resolved", async () => {
		m.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: [],
			source: "owner",
			organizationId: null,
		});
		await expect(
			m.handlers.publish!({
				input: { projectId: "p", snapshotId: "s" },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.publishInstructionSnapshot).not.toHaveBeenCalled();
		expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
	});
});
