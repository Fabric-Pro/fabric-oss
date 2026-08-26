/**
 * Unit tests for `getBacklogProposalsCountProcedure` (Roadmap "Backlog (N)"
 * pill count).
 *
 * The procedure mirrors the working `countPendingProposalsProcedure`: the
 * `requireProjectPermission(PROJECT_READ)` middleware is the tenant guard, and
 * the count is delegated to `countPendingBacklogProposals(projectId, ["BACKLOG"])`.
 * It intentionally does NOT re-do a `project.findFirst({ organizationId, userId })`
 * lookup (that pattern 404s for org-shared projects the caller didn't create).
 *
 * Covered surfaces:
 *   - Happy path: returns the count for status BACKLOG.
 *   - Zero-count path.
 *   - Delegates to countPendingBacklogProposals with the project id + ["BACKLOG"].
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mocks = {
		countPendingBacklogProposals: vi.fn(),
	};
	return { handlers, mocks };
});

vi.mock("@repo/database", () => ({
	countPendingBacklogProposals: mocks.countPendingBacklogProposals,
}));

vi.mock("../../../../../orpc/procedures", () => {
	const importedHandlerKeys = ["getBacklogCount"];
	let cursor = 0;
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
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
		Permissions: { PROJECT_READ: "project:read" },
		requireProjectPermission: () => (c: unknown) => c,
	};
});

await import("../get-backlog-proposals-count");

const ctx = { user: { id: "user-1" }, session: {} };

beforeEach(() => {
	mocks.countPendingBacklogProposals.mockReset();
});

describe("getBacklogProposalsCountProcedure", () => {
	it("returns the BACKLOG count (happy path)", async () => {
		mocks.countPendingBacklogProposals.mockResolvedValue(4);

		const result = (await handlers.getBacklogCount({
			input: { projectId: "project-1", organizationId: "org-1" },
			context: ctx,
		})) as { count: number };

		expect(result.count).toBe(4);
	});

	it("returns 0 when there are no BACKLOG rows", async () => {
		mocks.countPendingBacklogProposals.mockResolvedValue(0);

		const result = (await handlers.getBacklogCount({
			input: { projectId: "project-1", organizationId: null },
			context: ctx,
		})) as { count: number };

		expect(result.count).toBe(0);
	});

	it("delegates to countPendingBacklogProposals with the project id and BACKLOG status", async () => {
		mocks.countPendingBacklogProposals.mockResolvedValue(2);

		await handlers.getBacklogCount({
			input: { projectId: "project-1", organizationId: "org-1" },
			context: ctx,
		});

		expect(mocks.countPendingBacklogProposals).toHaveBeenCalledWith(
			"project-1",
			["BACKLOG"],
		);
	});
});
