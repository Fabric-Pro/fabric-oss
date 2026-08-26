/**
 * Tests for executeSkillProcedure
 *
 * Covers:
 * - Happy path: SYSTEM skill execution (visible to all)
 * - ORG skill execution with membership verification
 * - USER skill execution (owner only)
 * - useCount increment on every execution
 * - NOT_FOUND for missing skill
 * - NOT_FOUND for cross-tenant access (wrong org, wrong user)
 * - FORBIDDEN when organization membership check fails
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	handlers,
	uses,
	mockGetSkillById,
	mockIncrementSkillUseCount,
	mockVerifyOrganizationMembership,
} = vi.hoisted(() => ({
	handlers: {} as Record<string, (...args: unknown[]) => unknown>,
	uses: [] as unknown[],
	mockGetSkillById: vi.fn(),
	mockIncrementSkillUseCount: vi.fn(),
	mockVerifyOrganizationMembership: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getSkillById: (...args: unknown[]) => mockGetSkillById(...args),
	incrementSkillUseCount: (...args: unknown[]) =>
		mockIncrementSkillUseCount(...args),
	AI_PROVIDER_METADATA: {},
	GATEWAY_PROVIDERS: [],
	DB_GATEWAY_PROVIDERS: [],
}));

vi.mock("../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: (...args: unknown[]) =>
		mockVerifyOrganizationMembership(...args),
}));

vi.mock("../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: (...args: unknown[]) => {
			uses.push(...args);
			return chainable;
		},
		route: () => chainable,
		input: (schema: unknown) => {
			(chainable as { _input?: unknown })._input = schema;
			return chainable;
		},
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.executeSkill = fn;
			return {
				_handler: fn,
				_input: (chainable as { _input?: unknown })._input,
			};
		},
	});

	const Permissions = new Proxy({}, { get: (_t, p) => String(p) });

	return {
		tenantProtectedProcedure: chainable,
		Permissions,
		requirePermission: (perm: string) => {
			uses.push({ requirePermission: perm });
			return (c: unknown) => c;
		},
		resolveOrganizationId: vi.fn(
			(organizationId: string | null | undefined) =>
				organizationId ?? null,
		),
	};
});

// Register the handler.
import "../execute";

const ctx = {
	user: { id: "user-1" },
	session: { id: "session-1", activeOrganizationId: null },
};

const orgCtx = {
	user: { id: "user-1" },
	session: { id: "session-1", activeOrganizationId: "org-1" },
};

function makeSkill(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		id: "skill-1",
		name: "Test Skill",
		slug: "test-skill",
		description: "A test skill",
		content: "Skill content here",
		scope: "SYSTEM",
		userId: null,
		organizationId: null,
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

describe("executeSkillProcedure — happy paths", () => {
	it("executes a SYSTEM skill and returns content", async () => {
		mockGetSkillById.mockResolvedValue(makeSkill({ scope: "SYSTEM" }));
		mockIncrementSkillUseCount.mockResolvedValue(undefined);

		const result = (await handlers.executeSkill({
			input: { id: "skill-1", organizationId: null },
			context: ctx,
		})) as { id: string; name: string; content: string };

		expect(mockGetSkillById).toHaveBeenCalledWith("skill-1", {
			userId: "user-1",
			organizationId: undefined,
		});
		expect(mockIncrementSkillUseCount).toHaveBeenCalledWith("skill-1");
		expect(result.id).toBe("skill-1");
		expect(result.name).toBe("Test Skill");
		expect(result.content).toBe("Skill content here");
	});

	it("executes an ORG skill when user is a member", async () => {
		mockGetSkillById.mockResolvedValue(
			makeSkill({ scope: "ORGANIZATION", organizationId: "org-1" }),
		);
		mockIncrementSkillUseCount.mockResolvedValue(undefined);
		mockVerifyOrganizationMembership.mockResolvedValue({
			organization: { id: "org-1" },
			role: "member",
		});

		const result = (await handlers.executeSkill({
			input: { id: "skill-1", organizationId: "org-1" },
			context: orgCtx,
		})) as { id: string; name: string };

		expect(result.id).toBe("skill-1");
		expect(mockVerifyOrganizationMembership).toHaveBeenCalledWith(
			"org-1",
			"user-1",
		);
		expect(mockIncrementSkillUseCount).toHaveBeenCalledWith("skill-1");
	});

	it("executes a USER skill when user is the owner", async () => {
		mockGetSkillById.mockResolvedValue(
			makeSkill({ scope: "USER", userId: "user-1" }),
		);
		mockIncrementSkillUseCount.mockResolvedValue(undefined);

		const result = (await handlers.executeSkill({
			input: { id: "skill-1", organizationId: null },
			context: ctx,
		})) as { id: string; name: string };

		expect(result.id).toBe("skill-1");
		expect(mockIncrementSkillUseCount).toHaveBeenCalledWith("skill-1");
	});
});

// ---------------------------------------------------------------------------
// Tenant isolation / authorization
// ---------------------------------------------------------------------------

describe("executeSkillProcedure — tenant isolation", () => {
	it("throws NOT_FOUND when skill does not exist", async () => {
		mockGetSkillById.mockResolvedValue(null);

		await expect(
			handlers.executeSkill({
				input: { id: "missing-skill", organizationId: null },
				context: ctx,
			}),
		).rejects.toThrow(/not found/i);

		expect(mockIncrementSkillUseCount).not.toHaveBeenCalled();
	});

	it("throws NOT_FOUND for ORG skill when user is NOT a member", async () => {
		mockGetSkillById.mockResolvedValue(
			makeSkill({ scope: "ORGANIZATION", organizationId: "org-1" }),
		);
		mockVerifyOrganizationMembership.mockResolvedValue(null);

		await expect(
			handlers.executeSkill({
				input: { id: "skill-1", organizationId: "org-1" },
				context: orgCtx,
			}),
		).rejects.toThrow(/not found/i);

		expect(mockIncrementSkillUseCount).not.toHaveBeenCalled();
	});

	it("throws NOT_FOUND for USER skill owned by another user", async () => {
		mockGetSkillById.mockResolvedValue(
			makeSkill({ scope: "USER", userId: "user-2" }),
		);

		await expect(
			handlers.executeSkill({
				input: { id: "skill-1", organizationId: null },
				context: ctx,
			}),
		).rejects.toThrow(/not found/i);

		expect(mockIncrementSkillUseCount).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Side effects
// ---------------------------------------------------------------------------

describe("executeSkillProcedure — useCount increment", () => {
	it("increments useCount for every successful execution", async () => {
		mockGetSkillById.mockResolvedValue(makeSkill({ scope: "SYSTEM" }));
		mockIncrementSkillUseCount.mockResolvedValue(undefined);

		await handlers.executeSkill({
			input: { id: "skill-1", organizationId: null },
			context: ctx,
		});

		expect(mockIncrementSkillUseCount).toHaveBeenCalledTimes(1);
		expect(mockIncrementSkillUseCount).toHaveBeenCalledWith("skill-1");
	});

	it("does NOT increment useCount when skill is not found", async () => {
		mockGetSkillById.mockResolvedValue(null);

		try {
			await handlers.executeSkill({
				input: { id: "missing", organizationId: null },
				context: ctx,
			});
		} catch {
			// expected
		}

		expect(mockIncrementSkillUseCount).not.toHaveBeenCalled();
	});

	it("does NOT increment useCount when authorization fails", async () => {
		mockGetSkillById.mockResolvedValue(
			makeSkill({ scope: "USER", userId: "user-2" }),
		);

		try {
			await handlers.executeSkill({
				input: { id: "skill-1", organizationId: null },
				context: ctx,
			});
		} catch {
			// expected
		}

		expect(mockIncrementSkillUseCount).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Permission middleware
// ---------------------------------------------------------------------------

describe("executeSkillProcedure — permission wiring", () => {
	it("requires the SKILL_READ permission", () => {
		const found = uses.some(
			(u) =>
				typeof u === "object" &&
				u !== null &&
				(u as { requirePermission?: string }).requirePermission ===
					"SKILL_READ",
		);
		expect(found).toBe(true);
	});
});
