import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks, applied } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	// Which middleware the procedure declares. The handler body cannot assert
	// this — authorization happens before it runs — so without recording the
	// `.use()` chain, deleting a guard would leave every test green.
	const applied: string[] = [];
	const mocks = {
		hasProjectAccess: vi.fn(),
		getOpenDecisionsForStories: vi.fn(),
	};
	return { handlers, mocks, applied };
});

vi.mock("@repo/database", () => ({
	hasProjectAccess: mocks.hasProjectAccess,
	getOpenDecisionsForStories: mocks.getOpenDecisionsForStories,
}));

vi.mock("../../../../../orpc/procedures", () => {
	const importedHandlerKeys = ["openDecisions"];
	let cursor = 0;
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: (mw: unknown) => {
			applied.push(String((mw as { _guard?: string })?._guard ?? mw));
			return chainable;
		},
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			const key = importedHandlerKeys[cursor++] ?? `proc-${cursor}`;
			handlers[key] = fn;
			return { _handler: fn };
		},
	});
	return {
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: (p: string) => ({
			_guard: `requireProjectPermission:${p}`,
		}),
		requireInputOrgPermission: (p: string) => ({
			_guard: `requireInputOrgPermission:${p}`,
		}),
		resolveOrganizationId: (organizationId: string | null) =>
			organizationId,
	};
});

await import("../open-decisions");

const ctx = { user: { id: "u-1" }, session: {} };

beforeEach(() => {
	vi.clearAllMocks();
	mocks.hasProjectAccess.mockResolvedValue(true);
	mocks.getOpenDecisionsForStories.mockResolvedValue({
		counts: {},
		questions: {},
	});
});

describe("open-decisions", () => {
	it("returns counts and questions from the query", async () => {
		mocks.getOpenDecisionsForStories.mockResolvedValue({
			counts: { "story-1": 3 },
			questions: {
				"story-1": [
					{ id: "q1", summary: "Which provider?", content: null },
				],
			},
		});

		const result = await handlers.openDecisions({
			input: {
				projectId: "p-1",
				organizationId: null,
				storyIds: ["story-1"],
			},
			context: ctx,
		});

		expect(result).toEqual({
			counts: { "story-1": 3 },
			questions: {
				"story-1": [
					{ id: "q1", summary: "Which provider?", content: null },
				],
			},
		});
	});

	it("asks for a bounded number of questions per story", async () => {
		// The count feeds the ranking and must be exact; the questions are only
		// for display, so they are capped. Asserting the cap is passed keeps the
		// two from being conflated later.
		await handlers.openDecisions({
			input: {
				projectId: "p-1",
				organizationId: null,
				storyIds: ["story-1"],
			},
			context: ctx,
		});

		const args = mocks.getOpenDecisionsForStories.mock.calls[0][0];
		expect(args.maxPerStory).toBeGreaterThan(0);
		expect(args.maxPerStory).toBeLessThanOrEqual(5);
	});

	it("validates membership of the organization named in the input", async () => {
		// `resolveOrganizationId` returns the caller's `organizationId`
		// verbatim and `hasProjectAccess` ignores its org argument, so without
		// this middleware the target tenant is whatever the client asks for —
		// a caller could pair their own project with someone else's org id.
		expect(applied).toContain("requireInputOrgPermission:STORY_READ");
	});

	it("scopes the query to the authorized project, not just the tenant", async () => {
		// The tenant filter only narrows to the organization, and org
		// membership is not project access. Without the projectId reaching the
		// query, a caller authorized for one project could pass another
		// project's story ids and read its open questions.
		await handlers.openDecisions({
			input: {
				projectId: "p-1",
				organizationId: "org-1",
				storyIds: ["s1"],
			},
			context: ctx,
		});

		expect(mocks.getOpenDecisionsForStories).toHaveBeenCalledWith(
			expect.objectContaining({ projectId: "p-1" }),
		);
	});

	it("throws FORBIDDEN when the caller has no access to the project", async () => {
		mocks.hasProjectAccess.mockResolvedValue(false);

		await expect(
			handlers.openDecisions({
				input: {
					projectId: "p-1",
					organizationId: null,
					storyIds: ["story-1"],
				},
				context: ctx,
			}),
		).rejects.toThrow();
		expect(mocks.getOpenDecisionsForStories).not.toHaveBeenCalled();
	});

	it("passes the tenant filter through for the org context", async () => {
		await handlers.openDecisions({
			input: {
				projectId: "p-1",
				organizationId: "org-1",
				storyIds: ["s1", "s2"],
			},
			context: ctx,
		});

		expect(mocks.getOpenDecisionsForStories).toHaveBeenCalledWith(
			expect.objectContaining({
				tenantFilter: { organizationId: "org-1", userId: "u-1" },
				userStoryIds: ["s1", "s2"],
			}),
		);
	});

	it("pins the personal context to a null organization", async () => {
		await handlers.openDecisions({
			input: {
				projectId: "p-1",
				organizationId: null,
				storyIds: ["s1"],
			},
			context: ctx,
		});

		expect(mocks.getOpenDecisionsForStories).toHaveBeenCalledWith(
			expect.objectContaining({
				tenantFilter: { organizationId: null, userId: "u-1" },
			}),
		);
	});
});
