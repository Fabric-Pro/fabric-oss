/**
 * Tests for searchMembersProcedure
 *
 * Covers:
 * - Fuzzy search by name (case-insensitive)
 * - Fuzzy search by email
 * - Tenant isolation via verifyOrganizationMembership
 * - Empty results in personal context (no organizationId)
 * - Result limit (max 10)
 * - FORBIDDEN when user is not an org member
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mockVerifyOrganizationMembership, mockMemberFindMany } =
	vi.hoisted(() => ({
		handlers: {} as Record<string, (...args: unknown[]) => unknown>,
		mockVerifyOrganizationMembership: vi.fn(),
		mockMemberFindMany: vi.fn(),
	}));

vi.mock("@repo/database", () => ({
	db: {
		member: {
			findMany: (...args: unknown[]) => mockMemberFindMany(...args),
		},
	},
	AI_PROVIDER_METADATA: {},
	GATEWAY_PROVIDERS: [],
	DB_GATEWAY_PROVIDERS: [],
}));

vi.mock("../../lib/membership", () => ({
	verifyOrganizationMembership: (...args: unknown[]) =>
		mockVerifyOrganizationMembership(...args),
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
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.searchMembers = fn;
			return {
				_handler: fn,
				_input: (chainable as { _input?: unknown })._input,
			};
		},
	});

	return {
		tenantProtectedProcedure: chainable,
		requirePermission: vi.fn(() => ({})),
		requireProjectPermission: vi.fn(() => ({})),
		Permissions: new Proxy(
			{},
			{ get: (_, prop: string) => prop.toLowerCase() },
		),
	};
});

// Register the handler.
import "../search-members";

const ctx = {
	user: { id: "user-1" },
	session: { id: "session-1", activeOrganizationId: null },
};

function makeMember(
	userId: string,
	name: string,
	email: string,
	role: string,
	image?: string,
) {
	return {
		user: { id: userId, name, email, image: image || null },
		role,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("searchMembersProcedure — fuzzy search", () => {
	it("returns members matching name (case-insensitive)", async () => {
		mockVerifyOrganizationMembership.mockResolvedValue({
			organization: { id: "org-1" },
			role: "member",
		});
		mockMemberFindMany.mockResolvedValue([
			makeMember("u2", "Alice Smith", "alice@example.com", "member"),
			makeMember("u3", "Bob Jones", "bob@example.com", "admin"),
		]);

		const result = (await handlers.searchMembers({
			input: { organizationId: "org-1", query: "alice" },
			context: ctx,
		})) as { members: Array<{ name: string }> };

		expect(result.members).toHaveLength(2);
		expect(mockMemberFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					organizationId: "org-1",
					OR: expect.arrayContaining([
						expect.objectContaining({
							user: {
								name: {
									contains: "alice",
									mode: "insensitive",
								},
							},
						}),
					]),
				}),
			}),
		);
	});

	it("returns members matching email", async () => {
		mockVerifyOrganizationMembership.mockResolvedValue({
			organization: { id: "org-1" },
			role: "member",
		});
		mockMemberFindMany.mockResolvedValue([
			makeMember("u2", "Alice", "alice.smith@example.com", "member"),
		]);

		const result = (await handlers.searchMembers({
			input: { organizationId: "org-1", query: "alice.smith" },
			context: ctx,
		})) as { members: Array<{ email: string }> };

		expect(result.members).toHaveLength(1);
		expect(result.members[0].email).toBe("alice.smith@example.com");
	});

	it("limits results to 10 members", async () => {
		mockVerifyOrganizationMembership.mockResolvedValue({
			organization: { id: "org-1" },
			role: "member",
		});
		mockMemberFindMany.mockResolvedValue([]);

		await handlers.searchMembers({
			input: { organizationId: "org-1", query: "test" },
			context: ctx,
		});

		expect(mockMemberFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				take: 10,
			}),
		);
	});

	it("maps avatarUrl from user.image", async () => {
		mockVerifyOrganizationMembership.mockResolvedValue({
			organization: { id: "org-1" },
			role: "member",
		});
		mockMemberFindMany.mockResolvedValue([
			makeMember(
				"u2",
				"Alice",
				"alice@example.com",
				"member",
				"https://example.com/avatar.png",
			),
		]);

		const result = (await handlers.searchMembers({
			input: { organizationId: "org-1", query: "alice" },
			context: ctx,
		})) as { members: Array<{ avatarUrl: string | null }> };

		expect(result.members[0].avatarUrl).toBe(
			"https://example.com/avatar.png",
		);
	});
});

describe("searchMembersProcedure — tenant isolation", () => {
	it("returns empty array in personal context (no organizationId)", async () => {
		const result = (await handlers.searchMembers({
			input: { organizationId: null, query: "alice" },
			context: ctx,
		})) as { members: unknown[] };

		expect(result.members).toEqual([]);
		expect(mockVerifyOrganizationMembership).not.toHaveBeenCalled();
		expect(mockMemberFindMany).not.toHaveBeenCalled();
	});

	it("throws FORBIDDEN when user is not an org member", async () => {
		mockVerifyOrganizationMembership.mockResolvedValue(null);

		await expect(
			handlers.searchMembers({
				input: { organizationId: "org-1", query: "alice" },
				context: ctx,
			}),
		).rejects.toThrow(/not a member/i);

		expect(mockMemberFindMany).not.toHaveBeenCalled();
	});

	it("passes organizationId to verifyOrganizationMembership", async () => {
		mockVerifyOrganizationMembership.mockResolvedValue({
			organization: { id: "org-1" },
			role: "member",
		});
		mockMemberFindMany.mockResolvedValue([]);

		await handlers.searchMembers({
			input: { organizationId: "org-1", query: "test" },
			context: ctx,
		});

		expect(mockVerifyOrganizationMembership).toHaveBeenCalledWith(
			"org-1",
			"user-1",
		);
	});
});

describe("searchMembersProcedure — empty results", () => {
	it("returns empty array when no members match", async () => {
		mockVerifyOrganizationMembership.mockResolvedValue({
			organization: { id: "org-1" },
			role: "member",
		});
		mockMemberFindMany.mockResolvedValue([]);

		const result = (await handlers.searchMembers({
			input: { organizationId: "org-1", query: "nonexistent" },
			context: ctx,
		})) as { members: unknown[] };

		expect(result.members).toEqual([]);
	});
});
