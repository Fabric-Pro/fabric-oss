/**
 * Tests for `updateSettingsProcedure` — updates the project's
 * coding-instructions ignore-glob override and records
 * `project.instructions.settings_updated`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const m = vi.hoisted(() => ({
	handlers: {} as Record<string, (...a: unknown[]) => unknown>,
	/** The procedure's input schema, captured from the builder. */
	input: { current: null as unknown },
	updateProjectInstructionSettings: vi.fn(),
	resolveEffectiveProjectPermissions: vi.fn(),
	recordAuditFromRequest: vi.fn(),
	assertNoOpenMigration: vi.fn(),
	canUpdateProjectInstructions: vi.fn(),
	/** What the settings writer throws, under the project lock, for an open move. */
	MigrationOpenError: class MigrationOpenError extends Error {
		pointer = {
			v: 1,
			state: "PROPOSING",
			branchId: null,
			snapshotId: null,
			syncId: "sync_1",
			pullRequestUrl: null,
			startedAt: "2026-10-03T10:00:00.000Z",
			userId: "user_2",
		};
	},
}));

// The pre-check is mocked; `withMigrationFreeze`, which answers the writer's
// own refusal under the project lock, is the real one.
vi.mock("../migration-freeze", async (importOriginal) => ({
	...(await importOriginal<typeof import("../migration-freeze")>()),
	assertNoOpenMigration: (...a: unknown[]) => m.assertNoOpenMigration(...a),
}));
vi.mock("@repo/database", () => ({
	updateProjectInstructionSettings: (...a: unknown[]) =>
		m.updateProjectInstructionSettings(...a),
	canUpdateProjectInstructions: (...a: unknown[]) =>
		m.canUpdateProjectInstructions(...a),
	MAX_REQUIRED_INSTRUCTION_APPROVALS: 10,
	MAX_INSTRUCTION_APPROVERS: 50,
	// The rule itself is unit-tested beside it in `@repo/database`.
	minimumInstructionApprovers: (required: number) =>
		required > 1 ? required + 1 : required,
	InstructionMigrationOpenError: m.MigrationOpenError,
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
		input: (schema: unknown) => {
			m.input.current = schema;
			return builder;
		},
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
	m.assertNoOpenMigration.mockResolvedValue(undefined);
	m.canUpdateProjectInstructions.mockResolvedValue(true);
});

/** Parses `reviewPolicy` through the procedure's own input schema. */
function parseReviewPolicy(reviewPolicy: unknown) {
	const schema = m.input.current;
	if (!(schema instanceof z.ZodType)) {
		throw new Error("The procedure's input schema was not captured");
	}
	return schema.safeParse({ projectId: "proj_1", reviewPolicy });
}

describe("the review policy input", () => {
	it("needs one more listed approver than required above one, so a listed approver's own proposal can still pass", () => {
		expect(
			parseReviewPolicy({
				requiredApprovals: 2,
				approverUserIds: ["lead_1", "lead_2"],
			}).success,
		).toBe(false);
		expect(
			parseReviewPolicy({
				requiredApprovals: 2,
				approverUserIds: ["lead_1", "lead_2", "lead_3"],
			}).success,
		).toBe(true);
	});

	it("needs exactly one listed approver for one required approval", () => {
		expect(
			parseReviewPolicy({
				requiredApprovals: 1,
				approverUserIds: ["lead_1"],
			}).success,
		).toBe(true);
	});

	it("counts duplicates once", () => {
		expect(
			parseReviewPolicy({
				requiredApprovals: 2,
				approverUserIds: ["lead_1", "lead_2", "lead_1"],
			}).success,
		).toBe(false);
	});

	it("accepts any requirement without a list", () => {
		expect(parseReviewPolicy({ requiredApprovals: 3 })).toMatchObject({
			success: true,
			data: {
				reviewPolicy: { requiredApprovals: 3, approverUserIds: null },
			},
		});
	});
});

describe("projects.instructions.updateSettings review policy", () => {
	it("saves a review policy alone, without the move pre-check or touching the ignore rules", async () => {
		await m.handlers.updateSettings!({
			input: {
				projectId: "proj_1",
				reviewPolicy: {
					requiredApprovals: 2,
					approverUserIds: ["lead_1", "lead_2", "lead_3"],
				},
			},
			context: ctx,
		});

		expect(m.assertNoOpenMigration).not.toHaveBeenCalled();
		expect(m.updateProjectInstructionSettings).toHaveBeenCalledWith(
			"proj_1",
			"org_1",
			{
				reviewPolicy: {
					requiredApprovals: 2,
					approverUserIds: ["lead_1", "lead_2", "lead_3"],
				},
			},
		);
		expect(m.canUpdateProjectInstructions).toHaveBeenCalledWith(
			"proj_1",
			"lead_1",
		);
		expect(m.recordAuditFromRequest).toHaveBeenCalledWith(
			ctx,
			expect.objectContaining({
				action: "project.instructions.settings_updated",
				metadata: { requiredApprovals: 2, approverCount: 3 },
			}),
		);
	});

	it("refuses an approver who cannot review proposals, and writes nothing", async () => {
		m.canUpdateProjectInstructions.mockImplementation(
			async (_projectId: string, userId: string) => userId !== "viewer_1",
		);

		await expect(
			m.handlers.updateSettings!({
				input: {
					projectId: "proj_1",
					reviewPolicy: {
						requiredApprovals: 1,
						approverUserIds: ["lead_1", "viewer_1"],
					},
				},
				context: ctx,
			}),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			data: { reason: "APPROVER_NOT_ELIGIBLE", userIds: ["viewer_1"] },
		});
		expect(m.updateProjectInstructionSettings).not.toHaveBeenCalled();
		expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("refuses a request that changes nothing", async () => {
		await expect(
			m.handlers.updateSettings!({
				input: { projectId: "proj_1" },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});
});

describe("projects.instructions.updateSettings", () => {
	it("is refused while a move into the repository is open: new rules would re-plan what it carries (Fizzy #2878 §9)", async () => {
		m.assertNoOpenMigration.mockRejectedValue(
			Object.assign(new Error("MIGRATION_OPEN"), { code: "CONFLICT" }),
		);

		await expect(
			m.handlers.updateSettings!({
				input: { projectId: "proj_1", ignoreGlobs: ["dist/**"] },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });

		expect(m.assertNoOpenMigration).toHaveBeenCalledWith({
			projectId: "proj_1",
			organizationId: "org_1",
		});
		expect(m.updateProjectInstructionSettings).not.toHaveBeenCalled();
		expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("answers MIGRATION_OPEN when the writer refuses under the project lock after the pre-check passed: a move started in between", async () => {
		m.updateProjectInstructionSettings.mockRejectedValue(
			new m.MigrationOpenError("a move is open"),
		);

		await expect(
			m.handlers.updateSettings!({
				input: { projectId: "proj_1", ignoreGlobs: ["dist/**"] },
				context: ctx,
			}),
		).rejects.toMatchObject({
			code: "CONFLICT",
			data: {
				reason: "MIGRATION_OPEN",
				state: "PROPOSING",
				pullRequest: null,
			},
		});

		expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("does not mistake another failure of the write for the move", async () => {
		m.updateProjectInstructionSettings.mockRejectedValue(
			new Error("the database is unreachable"),
		);

		await expect(
			m.handlers.updateSettings!({
				input: { projectId: "proj_1", ignoreGlobs: ["dist/**"] },
				context: ctx,
			}),
		).rejects.toThrow("the database is unreachable");
	});

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
