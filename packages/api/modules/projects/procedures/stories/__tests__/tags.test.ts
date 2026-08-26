import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks } = vi.hoisted(() => {
	const handlers: Record<string, (...a: unknown[]) => unknown> = {};
	const mocks = {
		userStoryFindFirst: vi.fn(),
		userStoryUpdate: vi.fn(),
		storyTagCount: vi.fn(),
		storyTagCreate: vi.fn(),
		storyTagFindFirst: vi.fn(),
		storyTagDelete: vi.fn(),
		storyTagFindMany: vi.fn(),
		transaction: vi.fn(),
		queryRaw: vi.fn(),
		resolveEffective: vi.fn(),
	};
	return { handlers, mocks };
});

class FakeKnownRequestError extends Error {
	code: string;
	constructor(code: string) {
		super(code);
		this.code = code;
	}
}

vi.mock("@repo/database", () => ({
	db: {
		userStory: {
			findFirst: mocks.userStoryFindFirst,
			update: mocks.userStoryUpdate,
		},
		storyTag: {
			count: mocks.storyTagCount,
			create: mocks.storyTagCreate,
			findFirst: mocks.storyTagFindFirst,
			delete: mocks.storyTagDelete,
			findMany: mocks.storyTagFindMany,
		},
		$transaction: mocks.transaction,
	},
	Prisma: { PrismaClientKnownRequestError: FakeKnownRequestError },
}));

vi.mock("../../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: mocks.resolveEffective,
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...a: unknown[]) => unknown) => {
			if (!handlers.add) {
				handlers.add = fn;
			} else if (!handlers.remove) {
				handlers.remove = fn;
			} else {
				handlers.list = fn;
			}
			return { _handler: fn };
		},
	};
	return {
		tenantProtectedProcedure: chainable,
		// Real values (NOT a key-name proxy): tags.remove calls the REAL
		// hasPermission(perms, Permissions.STORY_DELETE), so this must resolve to
		// the actual "story:delete" string the resolveEffective fixtures use.
		Permissions: {
			STORY_READ: "story:read",
			STORY_UPDATE: "story:update",
			STORY_DELETE: "story:delete",
		},
		requireProjectPermission: () => (c: unknown) => c,
		resolveOrganizationId: (o: string | null) => o,
	};
});

await import("../tags");

const ctx = { user: { id: "user-1" }, session: {} };

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		(m as ReturnType<typeof vi.fn>).mockReset();
	}
	// default: story belongs to project
	mocks.userStoryFindFirst.mockResolvedValue({ id: "story-1" });
	// default: the FOR UPDATE row-lock query resolves to the locked story row
	mocks.queryRaw.mockResolvedValue([{ id: "story-1" }]);
	// default: $transaction runs the callback with a tx that proxies to db mocks
	mocks.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
		fn({
			$queryRaw: mocks.queryRaw,
			userStory: { update: mocks.userStoryUpdate },
			storyTag: {
				count: mocks.storyTagCount,
				create: mocks.storyTagCreate,
				delete: mocks.storyTagDelete,
			},
		}),
	);
});

describe("tags.add", () => {
	const baseInput = {
		projectId: "project-1",
		storyId: "story-1",
		organizationId: null,
		value: "API Gateway",
	};

	it("creates a normalized tag", async () => {
		mocks.storyTagCount.mockResolvedValue(3);
		mocks.storyTagCreate.mockResolvedValue({
			id: "tag-1",
			value: "api gateway",
			createdById: "user-1",
			createdAt: new Date(),
		});

		const result = await handlers.add({ input: baseInput, context: ctx });

		expect(mocks.storyTagCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					storyId: "story-1",
					value: "api gateway",
					createdById: "user-1",
				}),
			}),
		);
		expect((result as { tag: { value: string } }).tag.value).toBe(
			"api gateway",
		);
	});

	it("404s when the story is not in the gated project (IDOR guard)", async () => {
		mocks.userStoryFindFirst.mockResolvedValue(null);
		await expect(
			handlers.add({ input: baseInput, context: ctx }),
		).rejects.toBeInstanceOf(ORPCError);
		expect(mocks.storyTagCreate).not.toHaveBeenCalled();
	});

	it("rejects the 21st tag", async () => {
		mocks.storyTagCount.mockResolvedValue(20);
		await expect(
			handlers.add({ input: baseInput, context: ctx }),
		).rejects.toBeInstanceOf(ORPCError);
		expect(mocks.storyTagCreate).not.toHaveBeenCalled();
	});

	it("maps a P2002 unique violation to CONFLICT", async () => {
		mocks.storyTagCount.mockResolvedValue(1);
		mocks.storyTagCreate.mockRejectedValue(
			new FakeKnownRequestError("P2002"),
		);
		await expect(
			handlers.add({ input: baseInput, context: ctx }),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});
});

describe("tags.remove", () => {
	const baseInput = {
		projectId: "project-1",
		storyId: "story-1",
		organizationId: null,
		tagId: "tag-1",
	};

	it("404s when the tag's story is not in the gated project (IDOR guard)", async () => {
		mocks.storyTagFindFirst.mockResolvedValue(null);
		await expect(
			handlers.remove({ input: baseInput, context: ctx }),
		).rejects.toBeInstanceOf(ORPCError);
		expect(mocks.storyTagDelete).not.toHaveBeenCalled();
	});

	it("lets the tag creator remove their own tag", async () => {
		mocks.storyTagFindFirst.mockResolvedValue({
			id: "tag-1",
			createdById: "user-1",
		});
		// caller is an EDITOR (no STORY_DELETE) — but they are the creator
		mocks.resolveEffective.mockResolvedValue({
			permissions: [],
			source: "project-member",
			organizationId: "org-1",
		});

		const result = await handlers.remove({
			input: baseInput,
			context: ctx,
		});
		expect(mocks.storyTagDelete).toHaveBeenCalledWith({
			where: { id: "tag-1" },
		});
		expect(result).toEqual({ removed: true });
	});

	it("forbids a non-creator without STORY_DELETE", async () => {
		mocks.storyTagFindFirst.mockResolvedValue({
			id: "tag-1",
			createdById: "someone-else",
		});
		mocks.resolveEffective.mockResolvedValue({
			permissions: [], // no STORY_DELETE
			source: "project-member",
			organizationId: "org-1",
		});
		await expect(
			handlers.remove({ input: baseInput, context: ctx }),
		).rejects.toBeInstanceOf(ORPCError);
		expect(mocks.storyTagDelete).not.toHaveBeenCalled();
	});

	it("lets an effective-STORY_DELETE holder remove anyone's tag (incl. orphaned)", async () => {
		mocks.storyTagFindFirst.mockResolvedValue({
			id: "tag-1",
			createdById: null, // orphaned
		});
		mocks.resolveEffective.mockResolvedValue({
			permissions: ["story:delete"],
			source: "project-member",
			organizationId: "org-1",
		});
		const result = await handlers.remove({
			input: baseInput,
			context: ctx,
		});
		expect(mocks.storyTagDelete).toHaveBeenCalledWith({
			where: { id: "tag-1" },
		});
		expect(result).toEqual({ removed: true });
	});
});

describe("tags.list", () => {
	const baseInput = { projectId: "project-1", organizationId: null };

	it("returns distinct non-hidden tag values for the project", async () => {
		mocks.storyTagFindMany.mockResolvedValue([
			{ value: "api" },
			{ value: "billing" },
		]);
		const result = await handlers.list({ input: baseInput, context: ctx });
		// scoped to project + excludes CLOSED stories + distinct
		expect(mocks.storyTagFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					story: {
						projectId: "project-1",
						draftingStage: { not: "CLOSED" },
					},
				},
				distinct: ["value"],
			}),
		);
		expect((result as { tags: string[] }).tags).toEqual(["api", "billing"]);
	});
});
