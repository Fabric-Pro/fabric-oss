/**
 * Handler-direct tests for admin.users.list:
 * the search query must reach getUsers AND the returned total
 * must be the filtered count, not the table count.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getUsers: vi.fn(),
	countUsers: vi.fn(),
}));

// `importActual` lets the procedures' transitive dependencies keep
// working. We only override the symbols we drive directly.
vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		getUsers: mocks.getUsers,
		countUsers: mocks.countUsers,
	};
});

// `protectedProcedure` imports lazily from `@repo/payments` only on the
// catch path of the AI-usage-limit error mapper, but the procedures
// module re-exports its types eagerly. Stub the whole package so module
// load doesn't blow up.
vi.mock("@repo/payments", () => ({
	AiUsageLimitExceededError: class {},
}));

import { listUsers } from "../list-users";

beforeEach(() => {
	vi.clearAllMocks();
});

describe("admin.users.list", () => {
	it("passes the query through and returns the filtered total", async () => {
		mocks.getUsers.mockResolvedValue([{ id: "u1" }]);
		mocks.countUsers.mockResolvedValue(1);

		const result = await listUsers["~orpc"].handler({
			input: { query: "avery", limit: 10, offset: 0 },
			context: {},
			errors: {},
		} as never);

		expect(mocks.getUsers).toHaveBeenCalledWith({
			limit: 10,
			offset: 0,
			query: "avery",
		});
		expect(mocks.countUsers).toHaveBeenCalledWith({ query: "avery" });
		expect(result).toEqual({ users: [{ id: "u1" }], total: 1 });
	});

	it("returns the unfiltered total when no query is given", async () => {
		mocks.getUsers.mockResolvedValue([]);
		mocks.countUsers.mockResolvedValue(63);

		const result = await listUsers["~orpc"].handler({
			input: { limit: 10, offset: 0 },
			context: {},
			errors: {},
		} as never);

		expect(mocks.countUsers).toHaveBeenCalledWith({ query: undefined });
		expect(result).toEqual({ users: [], total: 63 });
	});
});
