/**
 * `projects.backlog.history.audit.list` routes the history filters to the
 * audit query (Fizzy #2304): "Status changed" asks for the PM status sync's
 * moves too, and the AI bucket — which selects `system` actors — leaves them
 * out. `listAuditLog` is mocked; the `filter` it receives is the contract.
 *
 * Run with: corepack pnpm --filter @repo/api exec vitest run modules/projects/procedures/backlog/__tests__/history-audit-list.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mocks = {
		listAuditLog: vi.fn(),
		projectFindUnique: vi.fn(),
		userFindMany: vi.fn(),
		sessionFindMany: vi.fn(),
		storyFindMany: vi.fn(),
	};
	return { handlers, mocks };
});

vi.mock("@repo/database", () => ({
	listAuditLog: mocks.listAuditLog,
	db: {
		project: { findUnique: mocks.projectFindUnique },
		user: { findMany: mocks.userFindMany },
		backlogUpdateSession: { findMany: mocks.sessionFindMany },
		userStory: { findMany: mocks.storyFindMany },
	},
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.list = fn;
			return { _handler: fn };
		},
	});
	return {
		tenantProtectedProcedure: chainable,
		Permissions: { PROJECT_READ: "project:read" },
		requireProjectPermission: () => (c: unknown) => c,
	};
});

await import("../history-audit-list");

const ctx = { user: { id: "user-1" }, session: {} };

/** The `filter` the procedure hands `listAuditLog` for one request. */
async function filterFor(
	input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	mocks.listAuditLog.mockClear();
	await handlers.list({
		input: { projectId: "project-1", organizationId: "org-1", ...input },
		context: ctx,
	});
	expect(mocks.listAuditLog).toHaveBeenCalledTimes(1);
	return mocks.listAuditLog.mock.calls[0][0].filter;
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.projectFindUnique.mockResolvedValue({ organizationId: "org-1" });
	mocks.listAuditLog.mockResolvedValue({ items: [], nextCursor: null });
	mocks.userFindMany.mockResolvedValue([]);
	mocks.sessionFindMany.mockResolvedValue([]);
	mocks.storyFindMany.mockResolvedValue([]);
});

describe("history audit list — the action filter reaches listAuditLog (Fizzy #2304)", () => {
	it("'Status changed' asks for the PM status sync's moves too", async () => {
		// Positive control: another filter asks for its own action only.
		expect((await filterFor({ action: "created" })).actions).toEqual([
			"story.created",
		]);

		expect(await filterFor({ action: "status_changed" })).toEqual({
			projectId: "project-1",
			actions: ["story.status_changed", "story.pm_status_synced"],
		});
	});

	it("the AI bucket, which selects system actors, leaves the synced moves out", async () => {
		// Positive control: for every actor the synced move is asked for.
		expect(
			(await filterFor({ action: "status_changed", actor: "all" }))
				.actions,
		).toContain("story.pm_status_synced");

		expect(
			await filterFor({ action: "status_changed", actor: "ai" }),
		).toEqual({
			projectId: "project-1",
			actions: ["story.status_changed"],
			actorTypes: ["agent", "system"],
		});
		expect((await filterFor({ actor: "ai" })).actions).not.toContain(
			"story.pm_status_synced",
		);
	});

	it("'All actions' asks for the whole history action set", async () => {
		expect((await filterFor({ action: "all" })).actions).toEqual([
			"story.created",
			"story.updated",
			"story.status_changed",
			"story.pm_status_synced",
			"story.deleted",
		]);
	});
});
