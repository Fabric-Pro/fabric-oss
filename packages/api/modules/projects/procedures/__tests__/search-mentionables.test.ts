/**
 * Tests for searchMentionablesProcedure.
 *
 * Verifies the candidate set matches hasProjectAccess: project owner ∪
 * accepted (non-expired) ProjectMembers. Filtering, ordering, and access
 * guards.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	handlers,
	mockDocumentFindUnique,
	mockProjectFindUnique,
	mockProjectMemberFindMany,
	mockUserFindMany,
} = vi.hoisted(() => ({
	handlers: {} as Record<string, (...args: unknown[]) => unknown>,
	mockDocumentFindUnique: vi.fn(),
	mockProjectFindUnique: vi.fn(),
	mockProjectMemberFindMany: vi.fn(),
	mockUserFindMany: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		projectDocument: {
			findUnique: (...args: unknown[]) => mockDocumentFindUnique(...args),
		},
		project: {
			findUnique: (...args: unknown[]) => mockProjectFindUnique(...args),
		},
		projectMember: {
			findMany: (...args: unknown[]) =>
				mockProjectMemberFindMany(...args),
		},
		user: {
			findMany: (...args: unknown[]) => mockUserFindMany(...args),
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
			handlers.searchMentionables = fn;
			return { _handler: fn };
		},
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.searchMentionables = fn;
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

vi.mock("@orpc/client", () => ({
	ORPCError: class ORPCError extends Error {
		constructor(
			public code: string,
			opts: { message: string },
		) {
			super(opts.message);
		}
	},
}));

// Side-effect: register the handler.
import "../documents/search-mentionables";

const ctx = { user: { id: "user_caller", email: "caller@example.com" } };

function user(id: string, name: string | null, email: string | null) {
	return { id, name, email, image: null };
}

type UserShape = ReturnType<typeof user>;

/**
 * Configure both projectMember.findMany and user.findMany so callers can
 * specify member records in the same shape as before.
 */
function setMembers(members: Array<{ userId: string; user: UserShape }>) {
	mockProjectMemberFindMany.mockResolvedValue(
		members.map((m) => ({ userId: m.userId })),
	);
	mockUserFindMany.mockResolvedValue(members.map((m) => m.user));
}

beforeEach(() => {
	vi.clearAllMocks();
	mockProjectMemberFindMany.mockResolvedValue([]);
	mockUserFindMany.mockResolvedValue([]);
});

describe("searchMentionablesProcedure", () => {
	it("returns project owner plus accepted, non-expired ProjectMembers", async () => {
		mockDocumentFindUnique.mockResolvedValue({ projectId: "proj_1" });
		mockProjectFindUnique.mockResolvedValue({
			id: "proj_1",
			user: user("user_owner", "Owner Alice", "owner@example.com"),
		});
		setMembers([
			{
				userId: "user_pm",
				user: user("user_pm", "Bob PM", "bob@example.com"),
			},
		]);

		const result = (await handlers.searchMentionables({
			input: { projectId: "proj_1", documentId: "doc_1", query: "" },
			context: ctx,
		})) as { members: Array<{ id: string; name: string | null }> };

		expect(result.members.map((m) => m.id).sort()).toEqual([
			"user_owner",
			"user_pm",
		]);
	});

	it("dedupes when the owner is also a ProjectMember", async () => {
		mockDocumentFindUnique.mockResolvedValue({ projectId: "proj_1" });
		mockProjectFindUnique.mockResolvedValue({
			id: "proj_1",
			user: user("user_owner", "Owner Alice", "owner@example.com"),
		});
		setMembers([
			{
				userId: "user_owner",
				user: user("user_owner", "Owner Alice", "owner@example.com"),
			},
		]);

		const result = (await handlers.searchMentionables({
			input: { projectId: "proj_1", documentId: "doc_1", query: "" },
			context: ctx,
		})) as { members: Array<{ id: string }> };

		expect(result.members.map((m) => m.id)).toEqual(["user_owner"]);
	});

	it("includes an external guest ProjectMember (no org membership)", async () => {
		mockDocumentFindUnique.mockResolvedValue({ projectId: "proj_1" });
		mockProjectFindUnique.mockResolvedValue({
			id: "proj_1",
			user: user("user_owner", "Owner", "owner@example.com"),
		});
		setMembers([
			{
				userId: "user_guest",
				user: user("user_guest", "Guest Greta", "greta@external.com"),
			},
		]);

		const result = (await handlers.searchMentionables({
			input: { projectId: "proj_1", documentId: "doc_1", query: "" },
			context: ctx,
		})) as { members: Array<{ id: string }> };

		expect(result.members.map((m) => m.id)).toContain("user_guest");
	});

	it("filters case-insensitively by name substring", async () => {
		mockDocumentFindUnique.mockResolvedValue({ projectId: "proj_1" });
		mockProjectFindUnique.mockResolvedValue({
			id: "proj_1",
			user: user("user_a", "Alice Anderson", "a@example.com"),
		});
		setMembers([
			{
				userId: "user_b",
				user: user("user_b", "Bob Builder", "b@example.com"),
			},
		]);

		const result = (await handlers.searchMentionables({
			input: { projectId: "proj_1", documentId: "doc_1", query: "ali" },
			context: ctx,
		})) as { members: Array<{ id: string }> };

		expect(result.members.map((m) => m.id)).toEqual(["user_a"]);
	});

	it("filters case-insensitively by email substring", async () => {
		mockDocumentFindUnique.mockResolvedValue({ projectId: "proj_1" });
		mockProjectFindUnique.mockResolvedValue({
			id: "proj_1",
			user: user("user_a", "Alice", "alice@acme.com"),
		});
		setMembers([
			{
				userId: "user_b",
				user: user("user_b", "Bob", "bob@other.com"),
			},
		]);

		const result = (await handlers.searchMentionables({
			input: { projectId: "proj_1", documentId: "doc_1", query: "ACME" },
			context: ctx,
		})) as { members: Array<{ id: string }> };

		expect(result.members.map((m) => m.id)).toEqual(["user_a"]);
	});

	it("sorts results by name ascending with null-name users last", async () => {
		mockDocumentFindUnique.mockResolvedValue({ projectId: "proj_1" });
		mockProjectFindUnique.mockResolvedValue({
			id: "proj_1",
			user: user("user_z", "Zelda", "z@example.com"),
		});
		setMembers([
			{
				userId: "user_a",
				user: user("user_a", "Alice", "a@example.com"),
			},
			{
				userId: "user_n",
				user: user("user_n", null, "n@example.com"),
			},
		]);

		const result = (await handlers.searchMentionables({
			input: { projectId: "proj_1", documentId: "doc_1", query: "" },
			context: ctx,
		})) as { members: Array<{ id: string }> };

		expect(result.members.map((m) => m.id)).toEqual([
			"user_a",
			"user_z",
			"user_n",
		]);
	});

	it("caps results at 10", async () => {
		mockDocumentFindUnique.mockResolvedValue({ projectId: "proj_1" });
		mockProjectFindUnique.mockResolvedValue({
			id: "proj_1",
			user: user("user_owner", "Owner", "owner@example.com"),
		});
		const many = Array.from({ length: 20 }, (_, i) => ({
			userId: `user_${i}`,
			user: user(
				`user_${i}`,
				`User ${String(i).padStart(2, "0")}`,
				`u${i}@example.com`,
			),
		}));
		setMembers(many);

		const result = (await handlers.searchMentionables({
			input: { projectId: "proj_1", documentId: "doc_1", query: "" },
			context: ctx,
		})) as { members: unknown[] };

		expect(result.members).toHaveLength(10);
	});

	it("returns 404 when the document belongs to a different project", async () => {
		// Caller has read access to `proj_1` (decorator passes), but the
		// supplied documentId belongs to `proj_other`. Treat as not found
		// so the caller cannot enumerate mentionables for unrelated docs.
		mockDocumentFindUnique.mockResolvedValue({ projectId: "proj_other" });

		await expect(
			handlers.searchMentionables({
				input: { projectId: "proj_1", documentId: "doc_1", query: "" },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("returns 404 when the document does not exist", async () => {
		mockDocumentFindUnique.mockResolvedValue(null);

		await expect(
			handlers.searchMentionables({
				input: {
					projectId: "proj_1",
					documentId: "doc_missing",
					query: "",
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("silently drops a ProjectMember whose User row is missing", async () => {
		mockDocumentFindUnique.mockResolvedValue({ projectId: "proj_1" });
		mockProjectFindUnique.mockResolvedValue({
			id: "proj_1",
			user: user("user_owner", "Owner", "owner@example.com"),
		});
		// Two ProjectMembers, but only one has a corresponding User row
		// (simulates an orphaned userId — schema-invariant violation that
		// the procedure handles by omission rather than throwing).
		mockProjectMemberFindMany.mockResolvedValue([
			{ userId: "user_present" },
			{ userId: "user_orphaned" },
		]);
		mockUserFindMany.mockResolvedValue([
			user("user_present", "Present Pat", "pat@example.com"),
		]);

		const result = (await handlers.searchMentionables({
			input: { projectId: "proj_1", documentId: "doc_1", query: "" },
			context: ctx,
		})) as { members: Array<{ id: string }> };

		expect(result.members.map((m) => m.id).sort()).toEqual([
			"user_owner",
			"user_present",
		]);
	});

	it("excludes expired ProjectMember entries", async () => {
		mockDocumentFindUnique.mockResolvedValue({ projectId: "proj_1" });
		mockProjectFindUnique.mockResolvedValue({
			id: "proj_1",
			user: user("user_owner", "Owner", "owner@example.com"),
		});
		mockProjectMemberFindMany.mockResolvedValue([]);

		await handlers.searchMentionables({
			input: { projectId: "proj_1", documentId: "doc_1", query: "" },
			context: ctx,
		});

		const callArgs = mockProjectMemberFindMany.mock.calls[0]?.[0] as {
			where: {
				projectId: string;
				acceptedAt: { not: null };
				OR: Array<unknown>;
			};
		};
		expect(callArgs.where.projectId).toBe("proj_1");
		expect(callArgs.where.acceptedAt).toEqual({ not: null });
		expect(callArgs.where.OR).toEqual([
			{ expiresAt: null },
			{ expiresAt: { gt: expect.any(Date) } },
		]);
	});

	it("excludes org members who are not project members", async () => {
		mockDocumentFindUnique.mockResolvedValue({ projectId: "proj_1" });
		mockProjectFindUnique.mockResolvedValue({
			id: "proj_1",
			user: user("user_owner", "Owner", "owner@example.com"),
		});
		// Project has no ProjectMember rows — an org member without a
		// ProjectMember row must not appear in suggestions, because they
		// also fail hasProjectAccess for the document.
		setMembers([]);

		const result = (await handlers.searchMentionables({
			input: { projectId: "proj_1", documentId: "doc_1", query: "" },
			context: ctx,
		})) as { members: Array<{ id: string }> };

		expect(result.members.map((m) => m.id)).toEqual(["user_owner"]);
		// The handler must never query the org Member table — verified by
		// construction (the test mocks expose only projectMember/user/etc.),
		// but explicitly assert it never hits a member-like lookup.
		expect(mockProjectMemberFindMany).toHaveBeenCalledTimes(1);
		expect(mockUserFindMany).not.toHaveBeenCalled();
	});
});
