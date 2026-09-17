/**
 * Tests for `getPublishedSnapshotProcedure`.
 *
 * `getPublishedInstructionSnapshot(projectId)` is UNSCOPED — the published
 * pointer lives on the `Project` row, keyed only by its id — so the handler's
 * own `organizationId` comparison is the tenant boundary (R11).
 *
 * The invited-guest case is spec §6.5's UI/MCP parity requirement, and its
 * MCP half lives in
 * `apps/web/__tests__/modules/saas/mcp/platform-tools-instructions.test.ts`
 * ("agrees with the oRPC getPublished handler for the same guest on the same
 * project"). The two surfaces cannot import each other, so the shared fixture
 * values — project `proj_parity`, host org `org_host`, guest `guest_parity`,
 * snapshot `snap_parity` v4 — are the contract between the two files. Both
 * must serve the snapshot to a guest whose own organization is not the
 * project's host organization.
 *
 * `resolveEffectiveProjectPermissions` is stubbed the way it answers for that
 * guest: the handler asks the project which organization hosts it, so the
 * answer is `org_host` and not the guest's own organization — whatever the
 * client sent as `organizationId` and whatever their session's active
 * organization is.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	handlers: {} as Record<string, (...a: unknown[]) => unknown>,
	getPublishedInstructionSnapshot: vi.fn(),
	resolveEffectiveProjectPermissions: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getPublishedInstructionSnapshot: (...a: unknown[]) =>
		m.getPublishedInstructionSnapshot(...a),
}));
vi.mock("../../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: (...a: unknown[]) =>
		m.resolveEffectiveProjectPermissions(...a),
}));
vi.mock("../../../../../orpc/procedures", () => {
	const builder = {
		use: () => builder,
		route: () => builder,
		input: () => builder,
		handler: (fn: (...a: unknown[]) => unknown) => {
			m.handlers.getPublished = fn;
			return fn;
		},
	};
	return {
		tenantProtectedProcedure: builder,
		requireProjectPermission: () => ({}),
		Permissions: { INSTRUCTION_READ: "instruction:read" },
	};
});

import "../get-published";

const PARITY_SNAPSHOT = {
	id: "snap_parity",
	version: 4,
	status: "READY",
	digest: "digest_parity",
	fileCount: 2,
	projectId: "proj_parity",
	organizationId: "org_host",
};

beforeEach(() => {
	m.getPublishedInstructionSnapshot.mockReset();
	m.resolveEffectiveProjectPermissions.mockReset();
});

describe("projects.instructions.getPublished", () => {
	it("serves an invited guest whose own organization is not the project's host organization", async () => {
		// What the middleware produces for a project-scoped guest.
		m.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: [],
			source: "org",
			organizationId: "org_host",
		});
		m.getPublishedInstructionSnapshot.mockResolvedValue(PARITY_SNAPSHOT);

		const result = await m.handlers.getPublished!({
			input: { projectId: "proj_parity" },
			context: {
				user: { id: "guest_parity" },
				session: { activeOrganizationId: null },
			},
		});

		expect(result).toEqual(PARITY_SNAPSHOT);
	});

	it("404s a snapshot belonging to a different organization, exactly like nothing published", async () => {
		m.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: [],
			source: "org",
			organizationId: "org_host",
		});
		m.getPublishedInstructionSnapshot.mockResolvedValue({
			...PARITY_SNAPSHOT,
			organizationId: "org_other",
		});

		await expect(
			m.handlers.getPublished!({
				input: { projectId: "proj_parity" },
				context: {
					user: { id: "guest_parity" },
					session: { activeOrganizationId: null },
				},
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("404s when nothing is published", async () => {
		m.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: [],
			source: "org",
			organizationId: "org_host",
		});
		m.getPublishedInstructionSnapshot.mockResolvedValue(null);

		await expect(
			m.handlers.getPublished!({
				input: { projectId: "proj_parity" },
				context: {
					user: { id: "guest_parity" },
					session: { activeOrganizationId: null },
				},
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("throws FORBIDDEN when no organization can be resolved", async () => {
		m.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: [],
			source: "owner",
			organizationId: null,
		});

		await expect(
			m.handlers.getPublished!({
				input: { projectId: "proj_parity" },
				context: {
					user: { id: "guest_parity" },
					session: { activeOrganizationId: null },
				},
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.getPublishedInstructionSnapshot).not.toHaveBeenCalled();
	});
});
