/**
 * Mocked-db tests for admin user search.
 * Pins the WHERE-clause shape: name OR email, case-insensitive,
 * and the filter-aware count.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	userFindMany: vi.fn(),
	userCount: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		user: {
			findMany: mocks.userFindMany,
			count: mocks.userCount,
		},
	},
}));

import { countUsers, getUsers, getUsersByIds } from "../prisma/queries/users";

const SEARCH_WHERE = {
	OR: [
		{ name: { contains: "avery", mode: "insensitive" } },
		{ email: { contains: "avery", mode: "insensitive" } },
	],
};

beforeEach(() => {
	vi.clearAllMocks();
});

describe("getUsers", () => {
	it("matches name OR email, case-insensitively", async () => {
		mocks.userFindMany.mockResolvedValue([]);
		await getUsers({ limit: 10, offset: 0, query: "avery" });
		expect(mocks.userFindMany).toHaveBeenCalledWith({
			where: SEARCH_WHERE,
			take: 10,
			skip: 0,
		});
	});

	it("omits the where clause when no query is given", async () => {
		mocks.userFindMany.mockResolvedValue([]);
		await getUsers({ limit: 10, offset: 20 });
		expect(mocks.userFindMany).toHaveBeenCalledWith({
			where: undefined,
			take: 10,
			skip: 20,
		});
	});
});

describe("countUsers", () => {
	it("applies the same search filter as getUsers", async () => {
		mocks.userCount.mockResolvedValue(1);
		await expect(countUsers({ query: "avery" })).resolves.toBe(1);
		expect(mocks.userCount).toHaveBeenCalledWith({ where: SEARCH_WHERE });
	});

	it("counts all users when no query is given", async () => {
		mocks.userCount.mockResolvedValue(63);
		await expect(countUsers({})).resolves.toBe(63);
		expect(mocks.userCount).toHaveBeenCalledWith({ where: undefined });
	});
});

// Added for the reviewer branch-owner aggregate read (Fizzy #2738 spec §10):
// a batch name lookup for ids a tenant-scoped query already resolved, never
// a search surface of its own.
describe("getUsersByIds", () => {
	it("looks up exactly the given ids and keys the result by id", async () => {
		mocks.userFindMany.mockResolvedValue([
			{ id: "user_1", name: "Case Worker" },
			{ id: "user_2", name: "Other Member" },
		]);

		const result = await getUsersByIds(["user_1", "user_2"]);

		expect(mocks.userFindMany).toHaveBeenCalledWith({
			where: { id: { in: ["user_1", "user_2"] } },
			select: { id: true, name: true },
		});
		expect(result.get("user_1")).toEqual({
			id: "user_1",
			name: "Case Worker",
		});
		expect(result.get("user_2")).toEqual({
			id: "user_2",
			name: "Other Member",
		});
	});

	it("returns an empty map for an empty id list, without querying", async () => {
		const result = await getUsersByIds([]);

		expect(result.size).toBe(0);
		expect(mocks.userFindMany).not.toHaveBeenCalled();
	});

	it("omits an id nothing came back for", async () => {
		mocks.userFindMany.mockResolvedValue([
			{ id: "user_1", name: "Case Worker" },
		]);

		const result = await getUsersByIds(["user_1", "user_deleted"]);

		expect(result.has("user_deleted")).toBe(false);
		expect(result.get("user_1")?.name).toBe("Case Worker");
	});
});
