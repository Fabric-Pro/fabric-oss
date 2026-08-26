/**
 * subscribe / unsubscribe / get-status procedures.
 *
 * The handlers must:
 *  - upsert (idempotent subscribe) scoped to the caller + subject;
 *  - deleteMany (idempotent unsubscribe) scoped by userId so a member can only
 *    remove their OWN row;
 *  - resolve the tenant scope via resolveOrganizationId on subscribe;
 *  - report the current subscription state on get-status.
 *
 * Mocks the db + the oRPC procedure chain so each handler is a plain function.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { upsert, deleteMany, findUnique, docFindFirst, storyFindFirst } =
	vi.hoisted(() => ({
		upsert: vi.fn(),
		deleteMany: vi.fn(),
		findUnique: vi.fn(),
		docFindFirst: vi.fn(),
		storyFindFirst: vi.fn(),
	}));

vi.mock("@repo/database", () => ({
	db: {
		subscription: { upsert, deleteMany, findUnique },
		projectDocument: { findFirst: docFindFirst },
		userStory: { findFirst: storyFindFirst },
	},
}));

vi.mock("@repo/database/prisma/zod", () => ({
	SubscriptionSubjectTypeSchema: {},
}));

vi.mock("../../../../orpc/procedures", () => {
	const makeChain = () => {
		const chain: any = {
			use: () => chain,
			route: () => chain,
			input: () => chain,
			output: () => chain,
			handler: (h: any) => h,
		};
		return chain;
	};
	return {
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: () => () => undefined,
		resolveOrganizationId: (orgId: string | null | undefined) =>
			orgId ?? null,
		get tenantProtectedProcedure() {
			return makeChain();
		},
	};
});

import { getSubscriptionStatusProcedure } from "../get-status";
import { subscribeProcedure } from "../subscribe";
import { unsubscribeProcedure } from "../unsubscribe";

const ctx = {
	context: { user: { id: "u1" }, session: {} },
} as const;

beforeEach(() => {
	vi.clearAllMocks();
	// Default: subject exists in the named project (linkage guard passes).
	docFindFirst.mockResolvedValue({ id: "doc-1" });
	storyFindFirst.mockResolvedValue({ id: "story-1" });
});

describe("subscribeProcedure", () => {
	it("upserts the caller's subscription and returns subscribed:true", async () => {
		upsert.mockResolvedValue({ id: "sub-1" });

		const result = await (subscribeProcedure as any)({
			...ctx,
			input: {
				projectId: "p1",
				subjectType: "FEATURE",
				subjectId: "story-1",
				organizationId: "org-A",
			},
		});

		expect(result).toEqual({ subscribed: true });
		const arg = upsert.mock.calls[0][0];
		expect(arg.where.userId_subjectType_subjectId).toEqual({
			userId: "u1",
			subjectType: "FEATURE",
			subjectId: "story-1",
		});
		expect(arg.create).toMatchObject({
			userId: "u1",
			organizationId: "org-A",
			subjectType: "FEATURE",
			subjectId: "story-1",
		});
	});

	it("stores null organizationId for personal context", async () => {
		upsert.mockResolvedValue({ id: "sub-2" });

		await (subscribeProcedure as any)({
			...ctx,
			input: {
				projectId: "p1",
				subjectType: "DOCUMENT",
				subjectId: "doc-1",
				organizationId: null,
			},
		});

		expect(upsert.mock.calls[0][0].create.organizationId).toBeNull();
	});

	it("rejects a subject that does not belong to the project (no orphan write)", async () => {
		storyFindFirst.mockResolvedValue(null); // subject not in this project

		await expect(
			(subscribeProcedure as any)({
				...ctx,
				input: {
					projectId: "p1",
					subjectType: "FEATURE",
					subjectId: "story-in-other-project",
					organizationId: "org-A",
				},
			}),
		).rejects.toThrow();
		expect(storyFindFirst.mock.calls[0][0].where).toEqual({
			id: "story-in-other-project",
			projectId: "p1",
		});
		expect(upsert).not.toHaveBeenCalled();
	});
});

describe("unsubscribeProcedure", () => {
	it("deletes only the caller's own row and returns subscribed:false", async () => {
		deleteMany.mockResolvedValue({ count: 1 });

		const result = await (unsubscribeProcedure as any)({
			...ctx,
			input: {
				projectId: "p1",
				subjectType: "FEATURE",
				subjectId: "story-1",
				organizationId: "org-A",
			},
		});

		expect(result).toEqual({ subscribed: false, removed: 1 });
		expect(deleteMany.mock.calls[0][0].where).toEqual({
			userId: "u1",
			subjectType: "FEATURE",
			subjectId: "story-1",
		});
	});

	it("is idempotent (no row → removed:0)", async () => {
		deleteMany.mockResolvedValue({ count: 0 });

		const result = await (unsubscribeProcedure as any)({
			...ctx,
			input: {
				projectId: "p1",
				subjectType: "FEATURE",
				subjectId: "story-x",
			},
		});

		expect(result).toEqual({ subscribed: false, removed: 0 });
	});
});

describe("getSubscriptionStatusProcedure", () => {
	it("returns subscribed:true when a row exists", async () => {
		findUnique.mockResolvedValue({ id: "sub-1" });

		const result = await (getSubscriptionStatusProcedure as any)({
			...ctx,
			input: {
				projectId: "p1",
				subjectType: "FEATURE",
				subjectId: "story-1",
			},
		});

		expect(result).toEqual({ subscribed: true });
	});

	it("returns subscribed:false when no row exists", async () => {
		findUnique.mockResolvedValue(null);

		const result = await (getSubscriptionStatusProcedure as any)({
			...ctx,
			input: {
				projectId: "p1",
				subjectType: "DOCUMENT",
				subjectId: "doc-1",
			},
		});

		expect(result).toEqual({ subscribed: false });
	});
});
