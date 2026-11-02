import { expect, it, vi } from "vitest";

vi.mock("../../../lib/project-organization", () => ({
	resolveProjectOrganizationId: async (organizationId: string) =>
		organizationId,
}));
const state = vi.hoisted(() => ({
	access: vi.fn(),
	board: vi.fn(),
	search: vi.fn(),
	handlers: [] as Array<(arg: any) => Promise<unknown>>,
	schemas: [] as any[],
	used: [] as unknown[],
}));
vi.mock("@repo/database", () => ({
	hasProjectAccess: state.access,
	getStoriesForBoard: state.board,
	searchStoryDescriptions: state.search,
}));
vi.mock("../../../../../orpc/procedures", () => {
	const chain: any = {
		use: (permission: unknown) => {
			state.used.push(permission);
			return chain;
		},
		route: () => chain,
		input: (schema: any) => {
			state.schemas.push(schema);
			return chain;
		},
		handler: (handler: any) => {
			state.handlers.push(handler);
			return handler;
		},
	};
	return {
		tenantProtectedProcedure: chain,
		requireProjectPermission: (permission: unknown) => permission,
		Permissions: { STORY_READ: "read" },
		resolveOrganizationId: (id: string) => id,
	};
});
await import("../board-stories");
await import("../search-descriptions");
for (const index of [0, 1]) {
	it(`rejects inaccessible project for procedure ${index}`, async () => {
		state.access.mockResolvedValue(false);
		await expect(
			state.handlers[index]({
				input: {
					projectId: "example-project",
					organizationId: "example-org",
					needles: ["text"],
				},
				context: { user: { id: "example-user" }, session: {} },
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(state.access).toHaveBeenLastCalledWith(
			"example-project",
			"example-user",
			"example-org",
		);
		expect(state.board).not.toHaveBeenCalled();
		expect(state.search).not.toHaveBeenCalled();
	});
}
it("enforces needle bounds and lowercase", () => {
	const schema = state.schemas[1];
	for (const needles of [
		[],
		[""],
		["x".repeat(2001)],
		Array(65).fill("a"),
		["UPPER"],
		[1],
		"a",
	]) {
		expect(
			schema.safeParse({ projectId: "example-project", needles }).success,
		).toBe(false);
	}
	expect(
		schema.safeParse({
			projectId: "example-project",
			needles: Array(64).fill("x".repeat(2000)),
		}).success,
	).toBe(true);
});

it("returns lean flags after access and strips internal labels", async () => {
	state.access.mockResolvedValue(true);
	state.board.mockResolvedValue({
		statuses: [],
		stories: [
			{
				id: "example-story",
				labels: ["internal"],
				hasDescription: true,
				hasAcceptanceCriteria: false,
			},
		],
	});
	expect(
		await state.handlers[0]({
			input: {
				projectId: "example-project",
				organizationId: "example-org",
			},
			context: { user: { id: "example-user" }, session: {} },
		}),
	).toEqual({
		statuses: [],
		stories: [
			{
				id: "example-story",
				hasDescription: true,
				hasAcceptanceCriteria: false,
			},
		],
	});
});
it("returns description matches after access", async () => {
	state.access.mockResolvedValue(true);
	state.search.mockResolvedValue([
		{ id: "example-story", needles: ["text"] },
	]);
	expect(
		await state.handlers[1]({
			input: {
				projectId: "example-project",
				organizationId: "example-org",
				needles: ["text"],
			},
			context: { user: { id: "example-user" }, session: {} },
		}),
	).toEqual({ matches: [{ id: "example-story", needles: ["text"] }] });
	expect(state.search).toHaveBeenLastCalledWith("example-project", ["text"]);
});

it("attaches STORY_READ permission to both tenant procedures", () => {
	expect(state.used).toEqual(["read", "read"]);
});
