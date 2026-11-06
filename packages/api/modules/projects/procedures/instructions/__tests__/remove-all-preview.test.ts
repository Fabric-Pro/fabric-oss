/**
 * Tests for `removeAllInstructionsPreviewProcedure`: what removing every
 * coding-instructions version would do now, for the confirmation.
 *
 * The builder stub is `remove-all.test.ts`'s: `.use()` records each
 * middleware and `.handler()` runs them ahead of the real handler.
 * Visibility-before-permission on the REAL chain is pinned in
 * `core-visibility.test.ts`.
 *
 * What this pins:
 *  - INSTRUCTION_DELETE is the permission (the preview counts rows History
 *    hides from readers), and a denial reads nothing;
 *  - the read is in the project's hosting organization, never the
 *    caller-supplied `organizationId`;
 *  - each refusal is named by the same `data.reason` a refused `removeAll`
 *    carries, so the confirmation and the refusal agree;
 *  - a project the organization does not hold is NOT_FOUND.
 */

import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	handlers: {} as Record<string, (...a: unknown[]) => unknown>,
	previewRemoveAllProjectInstructions: vi.fn(),
	resolveEffectiveProjectPermissions: vi.fn(),
	permissionMiddleware: vi.fn(),
	requestedPermission: undefined as string | undefined,
}));

vi.mock("../../../../../orpc/middleware/project-visibility", () => ({
	PROJECT_NOT_FOUND_MESSAGE: "Project not found",
	projectNotFoundUnlessVisible: async () => undefined,
}));
vi.mock("@repo/database", () => ({
	previewRemoveAllProjectInstructions: (...a: unknown[]) =>
		m.previewRemoveAllProjectInstructions(...a),
}));
vi.mock("../../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: (...a: unknown[]) =>
		m.resolveEffectiveProjectPermissions(...a),
}));
vi.mock("../../../../../orpc/procedures", () => {
	const middlewares: Array<(args: unknown) => unknown> = [];
	const b = {
		use: (mw: (args: unknown) => unknown) => {
			middlewares.push(mw);
			return b;
		},
		route: () => b,
		input: () => b,
		handler: (fn: (...a: unknown[]) => unknown) => {
			const composed = async (args: unknown) => {
				for (const mw of middlewares) {
					await mw(args);
				}
				return fn(args as never);
			};
			m.handlers.preview = composed;
			return composed;
		},
	};
	return {
		tenantProtectedProcedure: b,
		requireProjectPermission: (permission: string) => {
			m.requestedPermission = permission;
			return (args: unknown) => m.permissionMiddleware(args);
		},
		Permissions: {
			INSTRUCTION_READ: "instruction:read",
			INSTRUCTION_DELETE: "instruction:delete",
		},
	};
});

import "../remove-all-preview";

const ctx = { user: { id: "u" }, session: { activeOrganizationId: "org_1" } };

function run(overrides: Record<string, unknown> = {}) {
	return m.handlers.preview!({
		input: { projectId: "p", ...overrides },
		context: ctx,
	});
}

beforeEach(() => {
	m.previewRemoveAllProjectInstructions.mockReset();
	m.resolveEffectiveProjectPermissions.mockReset();
	m.permissionMiddleware.mockReset();
	m.permissionMiddleware.mockResolvedValue(undefined);
	m.resolveEffectiveProjectPermissions.mockResolvedValue({
		permissions: [],
		source: "project",
		organizationId: "org_1",
	});
	m.previewRemoveAllProjectInstructions.mockResolvedValue({
		snapshotCount: 4,
		publishedVersion: 3,
		blockedBy: null,
	});
});

describe("projects.instructions.removeAllPreview", () => {
	it("declares INSTRUCTION_DELETE, the permission of the removal it describes", () => {
		expect(m.requestedPermission).toBe("instruction:delete");
	});

	it("reads nothing when the permission middleware denies", async () => {
		m.permissionMiddleware.mockRejectedValueOnce(
			new ORPCError("FORBIDDEN", { message: "Missing permission" }),
		);

		await expect(run()).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.previewRemoveAllProjectInstructions).not.toHaveBeenCalled();
	});

	it("answers the count and the published version from the hosting organization", async () => {
		await expect(run({ organizationId: "org_other" })).resolves.toEqual({
			snapshotCount: 4,
			publishedVersion: 3,
			blockedBy: null,
		});
		expect(m.previewRemoveAllProjectInstructions).toHaveBeenCalledWith(
			"p",
			"org_1",
		);
	});

	it.each([
		["repository_mode", "REPOSITORY_MODE"],
		["migration_open", "MIGRATION_OPEN"],
		["active", "SNAPSHOT_ACTIVE"],
		["pull_request_unresolved", "PULL_REQUEST_UNRESOLVED"],
		["proposal_pending", "PROPOSAL_PENDING"],
	])(
		"names the %s refusal as removeAll's CONFLICT reason %s",
		async (blockedBy, reason) => {
			m.previewRemoveAllProjectInstructions.mockResolvedValue({
				snapshotCount: 2,
				publishedVersion: null,
				blockedBy,
			});

			await expect(run()).resolves.toMatchObject({ blockedBy: reason });
		},
	);

	it("answers NOT_FOUND when the organization does not hold the project", async () => {
		m.previewRemoveAllProjectInstructions.mockResolvedValue(null);

		await expect(run()).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});
