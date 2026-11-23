import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `maturation.restoreQuestion` re-opens a question only on the feature and
 * project the permission check named. A question id from another project of
 * the same organization passes the tenant filter alone, so the write is
 * scoped to the feature and project as well.
 */

const { handlers, mocks } = vi.hoisted(() => ({
	handlers: [] as Array<(...args: unknown[]) => unknown>,
	mocks: {
		hasProjectAccess: vi.fn(),
		setQuestionStatus: vi.fn(),
	},
}));

vi.mock("@repo/database", () => ({
	hasProjectAccess: mocks.hasProjectAccess,
	setQuestionStatus: mocks.setQuestionStatus,
}));

vi.mock("../../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.push(fn);
			return { _handler: fn };
		},
	};
	return {
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: () => (c: unknown) => c,
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? undefined,
	};
});

await import("../restore-question");
const restoreQuestion = handlers[0];

const context = { user: { id: "user-example" }, session: {} };
const input = {
	projectId: "project-example",
	storyId: "story-example",
	organizationId: "org-example",
	questionRootId: "question-example",
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.hasProjectAccess.mockResolvedValue(true);
	mocks.setQuestionStatus.mockResolvedValue(1);
});

describe("restoreQuestion", () => {
	it("re-opens the question inside the feature and project", async () => {
		await expect(restoreQuestion({ input, context })).resolves.toEqual({
			restored: true,
		});
		expect(mocks.setQuestionStatus).toHaveBeenCalledWith({
			tenantFilter: {
				organizationId: "org-example",
				userId: "user-example",
			},
			userStoryId: "story-example",
			projectId: "project-example",
			rootId: "question-example",
			status: "OPEN",
		});
	});

	it("answers NOT_FOUND for a question outside the feature and project", async () => {
		mocks.setQuestionStatus.mockResolvedValue(0);

		await expect(restoreQuestion({ input, context })).rejects.toMatchObject(
			{ code: "NOT_FOUND" },
		);
	});
});
