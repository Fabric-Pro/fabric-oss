/**
 * Tests for resolveActiveMentionsProcedure.
 *
 * Verifies:
 * - Returns only the subset of userIds that are active org/project members.
 * - Short-circuits with empty result for empty input (no DB hit).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mockMemberFindMany, mockProjectMemberFindMany } = vi.hoisted(
	() => ({
		handlers: {} as Record<string, (...args: unknown[]) => unknown>,
		mockMemberFindMany: vi.fn(),
		mockProjectMemberFindMany: vi.fn(),
	}),
);

vi.mock("@repo/database", () => ({
	db: {
		member: {
			findMany: (...args: unknown[]) => mockMemberFindMany(...args),
		},
		projectMember: {
			findMany: (...args: unknown[]) =>
				mockProjectMemberFindMany(...args),
		},
	},
}));

vi.mock("../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: (schema: unknown) => {
			(chainable as { _input?: unknown })._input = schema;
			return chainable;
		},
		output: () => chainable,
		query: (fn: (...args: unknown[]) => unknown) => {
			handlers.resolveActiveMentions = fn;
			return { _handler: fn };
		},
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.resolveActiveMentions = fn;
			return { _handler: fn };
		},
	});
	return {
		tenantProtectedProcedure: chainable,
		resolveOrganizationId: vi.fn(
			(organizationId: string | null | undefined) =>
				organizationId ?? null,
		),
		requirePermission: vi.fn(() => ({})),
		requireProjectPermission: vi.fn(() => ({})),
		Permissions: new Proxy(
			{},
			{ get: (_, prop: string) => prop.toLowerCase() },
		),
	};
});

// Side-effect: register the handler.
import "../resolve-active-mentions";

describe("resolveActiveMentionsProcedure", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns only active org members from the input set", async () => {
		// active_member is an org member
		// removed_member is not in the org
		// other_org_user is not in the org
		const activeMemberId = "user_active";
		const removedMemberId = "user_removed";
		const otherOrgUserId = "user_other_org";

		// org member lookup: only active_member is found
		mockMemberFindMany.mockResolvedValue([{ userId: activeMemberId }]);
		// project member lookup: none found
		mockProjectMemberFindMany.mockResolvedValue([]);

		const result = (await handlers.resolveActiveMentions({
			input: {
				userIds: [activeMemberId, removedMemberId, otherOrgUserId],
				organizationId: "org_1",
				projectId: "proj_1",
			},
		})) as { activeIds: string[] };

		expect(result.activeIds).toEqual([activeMemberId]);
	});

	it("returns empty for empty input without hitting the DB", async () => {
		const result = (await handlers.resolveActiveMentions({
			input: {
				userIds: [],
				organizationId: "org_1",
				projectId: "proj_1",
			},
		})) as { activeIds: string[] };

		expect(result.activeIds).toEqual([]);
		expect(mockMemberFindMany).not.toHaveBeenCalled();
		expect(mockProjectMemberFindMany).not.toHaveBeenCalled();
	});

	it("includes project-only members (no org) in active set", async () => {
		// No org context — only check projectMember table
		const projectOnlyUserId = "user_proj_only";
		const otherUserId = "user_other";

		mockMemberFindMany.mockResolvedValue([]);
		mockProjectMemberFindMany.mockResolvedValue([
			{ userId: projectOnlyUserId },
		]);

		const result = (await handlers.resolveActiveMentions({
			input: {
				userIds: [projectOnlyUserId, otherUserId],
				organizationId: null,
				projectId: "proj_1",
			},
		})) as { activeIds: string[] };

		expect(result.activeIds).toEqual([projectOnlyUserId]);
	});
});
