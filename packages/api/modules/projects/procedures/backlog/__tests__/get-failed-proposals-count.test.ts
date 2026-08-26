/**
 * Unit tests for `getFailedProposalsCountProcedure` (Review-inbox "Failed"
 * count / banner).
 *
 * The procedure mirrors the working `countPendingProposalsProcedure`: the
 * `requireProjectPermission(PROJECT_UPDATE)` middleware is the tenant guard, and
 * the count is delegated to `countPendingBacklogProposals(projectId, ["FAILED"])`.
 * It intentionally does NOT re-do a `project.findFirst({ organizationId, userId })`
 * lookup — that pattern 404'd for org-shared projects the caller didn't create
 * (the identical bug fixed for the Backlog count in #1867).
 *
 * Covered surfaces:
 *   - Happy path: returns the count for status FAILED.
 *   - Zero-count path.
 *   - Delegates to countPendingBacklogProposals with the project id + ["FAILED"].
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
	const importedHandlerKeys = ["getFailedCount"];
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
		Permissions: { PROJECT_UPDATE: "project:update" },
		requireProjectPermission: () => (c: unknown) => c,
	};
});

await import("../get-failed-proposals-count");

const ctx = { user: { id: "user-1" }, session: {} };

beforeEach(() => {
	mocks.countPendingBacklogProposals.mockReset();
});

describe("getFailedProposalsCountProcedure", () => {
	it("returns the FAILED count (happy path)", async () => {
		mocks.countPendingBacklogProposals.mockResolvedValue(3);

		const result = (await handlers.getFailedCount({
			input: { projectId: "project-1", organizationId: "org-1" },
			context: ctx,
		})) as { count: number };

		expect(result.count).toBe(3);
	});

	it("returns 0 when there are no FAILED rows", async () => {
		mocks.countPendingBacklogProposals.mockResolvedValue(0);

		const result = (await handlers.getFailedCount({
			input: { projectId: "project-1", organizationId: null },
			context: ctx,
		})) as { count: number };

		expect(result.count).toBe(0);
	});

	it("delegates to countPendingBacklogProposals with the project id and FAILED status", async () => {
		mocks.countPendingBacklogProposals.mockResolvedValue(2);

		await handlers.getFailedCount({
			input: { projectId: "project-1", organizationId: "org-1" },
			context: ctx,
		});

		expect(mocks.countPendingBacklogProposals).toHaveBeenCalledWith(
			"project-1",
			["FAILED"],
		);
	});
});
