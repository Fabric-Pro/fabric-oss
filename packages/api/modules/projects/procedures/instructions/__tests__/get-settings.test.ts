/**
 * Tests for `getSettingsProcedure` — reads a project's coding-instructions
 * ignore-glob override plus the built-in default globs (`DEFAULT_IGNORE_GLOBS`
 * from `@repo/instructions`, not mocked here) and its resolved source of
 * truth.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	handlers: {} as Record<string, (...a: unknown[]) => unknown>,
	getProjectInstructionSettings: vi.fn(),
	resolveEffectiveProjectPermissions: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getProjectInstructionSettings: (...a: unknown[]) =>
		m.getProjectInstructionSettings(...a),
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
			m.handlers.getSettings = fn;
			return fn;
		},
	};
	return {
		tenantProtectedProcedure: builder,
		requireProjectPermission: () => ({}),
		Permissions: { INSTRUCTION_READ: "instruction:read" },
	};
});

import "../get-settings";

const ctx = {
	user: { id: "user_1" },
	session: { activeOrganizationId: "org_1" },
};
const baseInput = { projectId: "proj_1" };

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
	m.getProjectInstructionSettings.mockResolvedValue({
		ignoreGlobs: ["dist/**"],
		sourceOfTruth: "UPLOAD",
	});
});

describe("projects.instructions.getSettings", () => {
	it("returns the project override, the built-in defaults, and the source of truth", async () => {
		const result = await m.handlers.getSettings!({
			input: baseInput,
			context: ctx,
		});
		expect(result).toEqual({
			ignoreGlobs: ["dist/**"],
			defaultIgnoreGlobs: [
				"**/node_modules/**",
				"**/.playwright-mcp/**",
				"**/tasks/**",
				"**/metrics/**",
				"retro.md",
				"**/*.jsonl",
				".claude/settings.local.json",
				"**/.DS_Store",
			],
			sourceOfTruth: "UPLOAD",
		});
		expect(m.getProjectInstructionSettings).toHaveBeenCalledWith(
			"proj_1",
			"org_1",
		);
	});

	it("throws FORBIDDEN when the organization cannot be resolved", async () => {
		m.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: [],
			source: "owner",
			organizationId: null,
		});
		await expect(
			m.handlers.getSettings!({ input: baseInput, context: ctx }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.getProjectInstructionSettings).not.toHaveBeenCalled();
	});
});
