/**
 * Tests for `updateSettingsProcedure` — updates the project's
 * coding-instructions ignore-glob override and records
 * `project.instructions.settings_updated`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	handlers: {} as Record<string, (...a: unknown[]) => unknown>,
	updateProjectInstructionSettings: vi.fn(),
	resolveEffectiveProjectPermissions: vi.fn(),
	recordAuditFromRequest: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	updateProjectInstructionSettings: (...a: unknown[]) =>
		m.updateProjectInstructionSettings(...a),
}));
vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: (...a: unknown[]) => m.recordAuditFromRequest(...a),
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
			m.handlers.updateSettings = fn;
			return fn;
		},
	};
	return {
		tenantProtectedProcedure: builder,
		requireProjectPermission: () => ({}),
		Permissions: { INSTRUCTION_UPDATE: "instruction:update" },
	};
});

import "../update-settings";

const ctx = {
	user: { id: "user_1" },
	session: { activeOrganizationId: "org_1" },
};

beforeEach(() => {
	for (const fn of Object.values(m)) {
		if (typeof fn === "function") {
			(fn as ReturnType<typeof vi.fn>).mockReset?.();
		}
	}
	m.resolveEffectiveProjectPermissions.mockResolvedValue({
		permissions: [],
		source: "org",
		organizationId: "org_1",
	});
	m.updateProjectInstructionSettings.mockResolvedValue(undefined);
});

describe("projects.instructions.updateSettings", () => {
	it("updates the ignore globs and records the audit action", async () => {
		const result = await m.handlers.updateSettings!({
			input: {
				projectId: "proj_1",
				ignoreGlobs: ["dist/**", "build/**"],
			},
			context: ctx,
		});

		expect(m.updateProjectInstructionSettings).toHaveBeenCalledWith(
			"proj_1",
			"org_1",
			{ ignoreGlobs: ["dist/**", "build/**"] },
		);
		expect(m.recordAuditFromRequest).toHaveBeenCalledWith(
			ctx,
			expect.objectContaining({
				action: "project.instructions.settings_updated",
				category: "project",
				organizationId: "org_1",
				projectId: "proj_1",
				metadata: { ignoreGlobCount: 2 },
			}),
		);
		expect(result).toEqual({ ok: true });
	});

	it("accepts null to clear the override back to defaults", async () => {
		await m.handlers.updateSettings!({
			input: { projectId: "proj_1", ignoreGlobs: null },
			context: ctx,
		});
		expect(m.updateProjectInstructionSettings).toHaveBeenCalledWith(
			"proj_1",
			"org_1",
			{ ignoreGlobs: null },
		);
		expect(m.recordAuditFromRequest).toHaveBeenCalledWith(
			ctx,
			expect.objectContaining({ metadata: { ignoreGlobCount: 0 } }),
		);
	});

	it("throws FORBIDDEN when the organization cannot be resolved", async () => {
		m.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: [],
			source: "owner",
			organizationId: null,
		});
		await expect(
			m.handlers.updateSettings!({
				input: { projectId: "proj_1", ignoreGlobs: null },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.updateProjectInstructionSettings).not.toHaveBeenCalled();
	});
});
