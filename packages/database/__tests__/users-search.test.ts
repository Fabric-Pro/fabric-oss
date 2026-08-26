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

import { countUsers, getUsers } from "../prisma/queries/users";

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
