/**
 * Procedure-level tests for `scan.grouping.reattach` — the manual override that
 * moves a grouping theme's `StoryTag` onto a chosen ticket so future runs dedup
 * there. `@repo/database` is mocked (no Prisma); the `orpc/procedures` chainable
 * is stubbed so `.handler(fn)` hands back `{ _handler: fn }`, mirroring
 * `grouping-procedures.test.ts`.
 */
import { ORPCError } from "@orpc/client";
import { Permissions } from "@repo/permissions";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockHasProjectAccess,
	mockUserStoryFindFirst,
	mockStoryTagFindMany,
	mockStoryTagDeleteMany,
	mockStoryTagCreate,
} = vi.hoisted(() => ({
	mockHasProjectAccess: vi.fn(),
	mockUserStoryFindFirst: vi.fn(),
	mockStoryTagFindMany: vi.fn(),
	mockStoryTagDeleteMany: vi.fn(),
	mockStoryTagCreate: vi.fn(),
}));

vi.mock("@repo/database", async () => {
	const actual =
		await vi.importActual<typeof import("@repo/database")>(
			"@repo/database",
		);
	const tx = {
		storyTag: {
			findMany: (...a: unknown[]) => mockStoryTagFindMany(...a),
			deleteMany: (...a: unknown[]) => mockStoryTagDeleteMany(...a),
			create: (...a: unknown[]) => mockStoryTagCreate(...a),
		},
	};
	return {
		...actual,
		hasProjectAccess: (...a: unknown[]) => mockHasProjectAccess(...a),
		db: {
			userStory: {
				findFirst: (...a: unknown[]) => mockUserStoryFindFirst(...a),
			},
			// Callback-form transaction: run the body against the tx stub.
			$transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
		},
	};
});

const { mockRequireProjectPermissionArg } = vi.hoisted(() => ({
	mockRequireProjectPermissionArg: vi.fn(),
}));
async function proceduresMockFactory() {
	const actual =
		await vi.importActual<typeof import("@repo/permissions")>(
			"@repo/permissions",
		);
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: unknown) => ({ _handler: fn }),
	});
	return {
		tenantProtectedProcedure: chainable,
		Permissions: actual.Permissions,
		requireProjectPermission: (permission: string) => {
			mockRequireProjectPermissionArg(permission);
			return (c: unknown) => c;
		},
	};
}
vi.mock("../../../../../orpc/procedures", proceduresMockFactory);
vi.mock("../../../../orpc/procedures", proceduresMockFactory);

type Handler = (args: {
	input: Record<string, unknown>;
	context: { user: { id: string } };
}) => Promise<{
	reattached: boolean;
	targetIdentifier: string;
	vacatedStoryIds: string[];
	alreadyOwned: boolean;
}>;

const ctx = { user: { id: "user-1" } };

async function loadHandler(): Promise<Handler> {
	const mod = (await import("../reattach-grouping")) as Record<
		string,
		{ _handler: Handler }
	>;
	return mod.reattachGroupingProcedure._handler;
}

const baseInput = {
	projectId: "proj-1",
	organizationId: null,
	themeKey: "theme-accessibility-wcag-2-1-aa-1-4-3-abc123",
	targetStoryId: "story-target",
};

beforeEach(() => {
	vi.clearAllMocks();
	vi.resetModules();
	mockHasProjectAccess.mockResolvedValue(true);
	mockUserStoryFindFirst.mockResolvedValue({
		id: "story-target",
		identifier: "42",
	});
	mockStoryTagFindMany.mockResolvedValue([]);
	mockStoryTagDeleteMany.mockResolvedValue({ count: 0 });
	mockStoryTagCreate.mockResolvedValue({ id: "tag-new" });
});

describe("reattachGroupingProcedure", () => {
	it("declares PROJECT_UPDATE", async () => {
		await loadHandler();
		expect(mockRequireProjectPermissionArg).toHaveBeenCalledWith(
			Permissions.PROJECT_UPDATE,
		);
	});

	it("moves the theme tag off the source ticket and onto the target", async () => {
		// Theme currently owned by a different (duplicate) ticket.
		mockStoryTagFindMany.mockResolvedValue([
			{ id: "tag-src", storyId: "story-source" },
		]);
		const handler = await loadHandler();

		const result = await handler({ input: baseInput, context: ctx });

		// Stale tag on the source is removed…
		expect(mockStoryTagDeleteMany).toHaveBeenCalledWith({
			where: { id: { in: ["tag-src"] } },
		});
		// …and the theme is (re)created on the target.
		expect(mockStoryTagCreate).toHaveBeenCalledWith({
			data: {
				storyId: "story-target",
				value: baseInput.themeKey,
				createdById: "user-1",
			},
		});
		expect(result).toMatchObject({
			reattached: true,
			targetIdentifier: "42",
			vacatedStoryIds: ["story-source"],
			alreadyOwned: false,
		});
	});

	it("is idempotent when the target already owns the theme (no redundant create)", async () => {
		mockStoryTagFindMany.mockResolvedValue([
			{ id: "tag-existing", storyId: "story-target" },
		]);
		const handler = await loadHandler();

		const result = await handler({ input: baseInput, context: ctx });

		expect(mockStoryTagCreate).not.toHaveBeenCalled();
		expect(mockStoryTagDeleteMany).not.toHaveBeenCalled();
		expect(result).toMatchObject({ reattached: true, alreadyOwned: true });
	});

	it("rejects a target ticket that isn't in the project (IDOR guard)", async () => {
		mockUserStoryFindFirst.mockResolvedValue(null);
		const handler = await loadHandler();

		await expect(
			handler({ input: baseInput, context: ctx }),
		).rejects.toThrow(ORPCError);
		expect(mockStoryTagDeleteMany).not.toHaveBeenCalled();
		expect(mockStoryTagCreate).not.toHaveBeenCalled();
	});

	it("rejects when the caller lacks project access", async () => {
		mockHasProjectAccess.mockResolvedValue(false);
		const handler = await loadHandler();

		await expect(
			handler({ input: baseInput, context: ctx }),
		).rejects.toThrow(ORPCError);
		expect(mockUserStoryFindFirst).not.toHaveBeenCalled();
	});
});
