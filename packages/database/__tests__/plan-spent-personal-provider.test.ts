/**
 * The personal key a member opted to use while their ChatGPT plans are spent
 * (Fizzy #3085). The user table is faked with an in-memory store that
 * evaluates the real `where` and `orderBy`, so these pin behaviour rather
 * than the exact shape of the query.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const { userRows } = vi.hoisted(() => ({
	userRows: [] as Record<string, unknown>[],
}));

function matches(row: Row, where: Row): boolean {
	return Object.entries(where).every(([key, condition]) => {
		if (
			condition !== null &&
			typeof condition === "object" &&
			"not" in (condition as Row)
		) {
			return row[key] !== (condition as Row).not;
		}
		return row[key] === condition;
	});
}

function compare(
	a: Row,
	b: Row,
	orderBy: Array<Record<string, "asc" | "desc">>,
): number {
	for (const order of orderBy) {
		const [key, direction] = Object.entries(order)[0];
		const left =
			a[key] instanceof Date ? (a[key] as Date).getTime() : a[key];
		const right =
			b[key] instanceof Date ? (b[key] as Date).getTime() : b[key];
		if (left === right) {
			continue;
		}
		const sign = direction === "desc" ? -1 : 1;
		return (left as number) > (right as number) ? sign : -sign;
	}
	return 0;
}

vi.mock("../prisma/client", () => ({
	db: {
		userCloudProviderConfig: {
			findMany: vi.fn(
				async ({
					where,
					orderBy,
				}: {
					where: Row;
					orderBy: Array<Record<string, "asc" | "desc">>;
				}) =>
					userRows
						.filter((row) => matches(row, where))
						.sort((a, b) => compare(a, b, orderBy)),
			),
		},
	},
}));

vi.mock("@repo/config", () => ({
	config: { ai: { enableGateway: false, gatewayApiKey: null } },
}));

vi.mock("@repo/utils", () => ({
	encryptApiKey: vi.fn((key: string) => `encrypted:${key}`),
}));

import { getPlanSpentPersonalProviderConfig } from "../prisma/queries/ai-gateway";

const USER = "user-1";

function row(overrides: Row): Row {
	return {
		id: "row",
		userId: USER,
		provider: "OPENAI_DIRECT",
		enabled: true,
		isDefault: false,
		purpose: "ALL",
		useWhenPlanSpent: true,
		encryptedApiKey: "encrypted:key",
		clientId: null,
		encryptedClientSecret: null,
		config: {},
		updatedAt: new Date("2026-10-01T00:00:00Z"),
		...overrides,
	};
}

describe("getPlanSpentPersonalProviderConfig", () => {
	beforeEach(() => {
		userRows.length = 0;
	});

	it("resolves the member's opted-in key as a personal source", async () => {
		userRows.push(row({ id: "mine" }));

		await expect(
			getPlanSpentPersonalProviderConfig({ userId: USER }),
		).resolves.toMatchObject({
			configId: "mine",
			provider: "OPENAI_DIRECT",
			source: "user",
		});
	});

	it("ignores a key the member did not opt in", async () => {
		userRows.push(row({ useWhenPlanSpent: false }));

		await expect(
			getPlanSpentPersonalProviderConfig({ userId: USER }),
		).resolves.toBeNull();
	});

	it("never resolves an EMBEDDINGS_ONLY key, even one still flagged", async () => {
		userRows.push(row({ purpose: "EMBEDDINGS_ONLY" }));

		await expect(
			getPlanSpentPersonalProviderConfig({ userId: USER }),
		).resolves.toBeNull();
	});

	it("never resolves another member's key", async () => {
		userRows.push(row({ id: "theirs", userId: "user-2" }));

		await expect(
			getPlanSpentPersonalProviderConfig({ userId: USER }),
		).resolves.toBeNull();
	});

	it("skips a disabled key", async () => {
		userRows.push(row({ enabled: false }));

		await expect(
			getPlanSpentPersonalProviderConfig({ userId: USER }),
		).resolves.toBeNull();
	});

	it("prefers the Default key over a more recently updated one", async () => {
		userRows.push(
			row({
				id: "recent",
				provider: "ANTHROPIC_DIRECT",
				updatedAt: new Date("2026-10-10T00:00:00Z"),
			}),
			row({ id: "default", isDefault: true }),
		);

		await expect(
			getPlanSpentPersonalProviderConfig({ userId: USER }),
		).resolves.toMatchObject({ configId: "default" });
	});

	it("without a Default, takes the most recently updated key", async () => {
		userRows.push(
			row({ id: "older" }),
			row({
				id: "newer",
				provider: "ANTHROPIC_DIRECT",
				updatedAt: new Date("2026-10-10T00:00:00Z"),
			}),
		);

		await expect(
			getPlanSpentPersonalProviderConfig({ userId: USER }),
		).resolves.toMatchObject({ configId: "newer" });
	});

	it("pins the row a model was resolved on, under the same rules", async () => {
		userRows.push(
			row({ id: "default", isDefault: true }),
			row({ id: "other", provider: "ANTHROPIC_DIRECT" }),
			row({ id: "opted-out", useWhenPlanSpent: false }),
		);

		await expect(
			getPlanSpentPersonalProviderConfig({
				userId: USER,
				configId: "other",
			}),
		).resolves.toMatchObject({ configId: "other" });
		await expect(
			getPlanSpentPersonalProviderConfig({
				userId: USER,
				configId: "opted-out",
			}),
		).resolves.toBeNull();
		await expect(
			getPlanSpentPersonalProviderConfig({
				userId: "user-2",
				configId: "default",
			}),
		).resolves.toBeNull();
	});

	it("skips a row with no usable credential for the next one", async () => {
		userRows.push(
			row({ id: "empty", isDefault: true, encryptedApiKey: null }),
			row({ id: "usable", provider: "ANTHROPIC_DIRECT" }),
		);

		await expect(
			getPlanSpentPersonalProviderConfig({ userId: USER }),
		).resolves.toMatchObject({ configId: "usable" });
	});
});
