/**
 * Who may create, list and revoke an organization API key (Fizzy #2380).
 *
 * These procedures had no tests. They also had the wrong gates: creation
 * borrowed `ORG_UPDATE` and deletion borrowed `ORG_DELETE` — the permission for
 * deleting the *organization*, granted to owners alone — while the settings page
 * offered admins a delete button the API would refuse. The dedicated
 * `ORG_API_KEYS_*` permissions existed the whole time and were enforced nowhere.
 *
 * What is pinned here is the part the permission middleware cannot express: the
 * handler's own membership check must ask for membership and not for a role
 * (the role question belongs to the middleware, and asking it twice was what
 * made relaxing one gate insufficient), and revocation must narrow a non-owner
 * to keys they created themselves. That narrowing is what makes it safe to let
 * a member revoke at all.
 *
 * The middleware itself is mocked out, as in the sibling procedure tests — what
 * `requirePermission` does with a permission is `@repo/permissions`' business,
 * and it has its own tests.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	handlers,
	mockRequireOrgMembership,
	mockCreateKey,
	mockDeleteKey,
	mockListKeys,
	mockFindFirst,
} = vi.hoisted(() => ({
	handlers: {} as Record<string, (...args: never[]) => unknown>,
	mockRequireOrgMembership: vi.fn(),
	mockCreateKey: vi.fn(),
	mockDeleteKey: vi.fn(),
	mockListKeys: vi.fn(),
	mockFindFirst: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: { organizationApiKey: { findFirst: mockFindFirst } },
	createOrganizationApiKey: mockCreateKey,
	deleteOrganizationApiKey: mockDeleteKey,
	listOrganizationApiKeys: mockListKeys,
}));

vi.mock("../../../lib/membership", () => ({
	requireOrgMembership: (...args: unknown[]) =>
		mockRequireOrgMembership(...args),
}));

vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: vi.fn(),
}));

vi.mock("../../../../../orpc/procedures", () => {
	function chainableFor(name: string) {
		const chainable: Record<string, unknown> = {};
		Object.assign(chainable, {
			use: () => chainable,
			route: () => chainable,
			input: () => chainable,
			output: () => chainable,
			handler: (fn: (...args: never[]) => unknown) => {
				handlers[name] = fn;
				return { _handler: fn };
			},
		});
		return chainable;
	}

	// Each import registers its handler under the next name in this list, in
	// import order below.
	const names = ["create", "list", "delete"];
	let cursor = 0;
	const root: Record<string, unknown> = {};
	Object.assign(root, {
		use: () => root,
		route: () => root,
		input: () => root,
		output: () => root,
		handler: () => ({}),
	});

	return {
		get tenantProtectedProcedure() {
			return chainableFor(names[cursor++] ?? `extra-${cursor}`);
		},
		requirePermission: vi.fn(() => ({})),
		resolveOrganizationId: (input: string | null) => input,
		Permissions: new Proxy(
			{},
			{ get: (_, prop: string) => prop.toLowerCase() },
		),
	};
});

import "../create";
import "../list";
import "../delete";

const context = {
	user: { id: "user-1" },
	session: { id: "session-1", activeOrganizationId: "org-1" },
	headers: new Headers(),
};

beforeEach(() => {
	vi.clearAllMocks();
	mockCreateKey.mockResolvedValue({
		id: "key-1",
		name: "Claude Code",
		keyPrefix: "org_abcd1234",
		scopes: ["mcp:read", "mcp:write"],
		expiresAt: null,
		createdAt: new Date("2026-01-01T00:00:00Z"),
	});
	mockDeleteKey.mockResolvedValue({ count: 1 });
	mockListKeys.mockResolvedValue([]);
	mockFindFirst.mockResolvedValue({ name: "Claude Code", scopes: [] });
});

describe("creating a key", () => {
	// The regression this ticket exists for: a member could not mint a key at
	// all, and the workaround was promotion to admin — which grants vastly more
	// than the key ever would.
	it("asks for membership, not for a role", async () => {
		mockRequireOrgMembership.mockResolvedValue({ role: "member" });

		await handlers.create({
			context,
			input: {
				organizationId: "org-1",
				name: "Claude Code",
				scopes: ["mcp:read"],
			},
		} as never);

		expect(mockRequireOrgMembership).toHaveBeenCalledWith(
			"user-1",
			"org-1",
		);
		// No third argument. A role list here was the second of two gates, and
		// it would have kept refusing members after the middleware relaxed.
		expect(mockRequireOrgMembership.mock.calls[0]).toHaveLength(2);
		expect(mockCreateKey).toHaveBeenCalled();
	});

	it("refuses someone who is not a member of the organization", async () => {
		mockRequireOrgMembership.mockResolvedValue(null);

		await expect(
			handlers.create({
				context,
				input: {
					organizationId: "org-1",
					name: "Claude Code",
					scopes: ["mcp:read"],
				},
			} as never),
		).rejects.toThrow(/member of this organization/i);

		expect(mockCreateKey).not.toHaveBeenCalled();
	});
});

describe("revoking a key", () => {
	it("lets an owner revoke any key in the organization", async () => {
		mockRequireOrgMembership.mockResolvedValue({ role: "owner" });

		await handlers.delete({
			context,
			input: { organizationId: "org-1", id: "key-1" },
		} as never);

		// `undefined` as the creator filter means "any key".
		expect(mockDeleteKey).toHaveBeenCalledWith("key-1", "org-1", undefined);
	});

	// The narrowing that makes member revocation safe: you may retire a
	// credential, and the one you may retire is your own.
	it("narrows a member to keys they created themselves", async () => {
		mockRequireOrgMembership.mockResolvedValue({ role: "member" });

		await handlers.delete({
			context,
			input: { organizationId: "org-1", id: "key-1" },
		} as never);

		expect(mockDeleteKey).toHaveBeenCalledWith("key-1", "org-1", "user-1");
	});

	// Admins are narrowed too — ownership, not adminship, is what widens this.
	it("narrows an admin the same way", async () => {
		mockRequireOrgMembership.mockResolvedValue({ role: "admin" });

		await handlers.delete({
			context,
			input: { organizationId: "org-1", id: "key-1" },
		} as never);

		expect(mockDeleteKey).toHaveBeenCalledWith("key-1", "org-1", "user-1");
	});
});

describe("listing keys", () => {
	it("shows an owner every key in the organization", async () => {
		mockRequireOrgMembership.mockResolvedValue({ role: "owner" });

		await handlers.list({
			context,
			input: { organizationId: "org-1", includeInactive: false },
		} as never);

		expect(mockListKeys).toHaveBeenCalledWith(
			expect.objectContaining({ createdByUserId: undefined }),
		);
	});

	it("shows everyone else only their own", async () => {
		mockRequireOrgMembership.mockResolvedValue({ role: "member" });

		await handlers.list({
			context,
			input: { organizationId: "org-1", includeInactive: false },
		} as never);

		expect(mockListKeys).toHaveBeenCalledWith(
			expect.objectContaining({ createdByUserId: "user-1" }),
		);
	});
});
