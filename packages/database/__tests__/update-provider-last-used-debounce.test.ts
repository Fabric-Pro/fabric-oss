/** Unit tests for the provider last-used autocommit write and debounce predicate. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { executeRaw, orgUpdateMany, userUpdateMany, transaction } = vi.hoisted(
	() => ({
		executeRaw: vi.fn(),
		orgUpdateMany: vi.fn(),
		userUpdateMany: vi.fn(),
		transaction: vi.fn(),
	}),
);

vi.mock("../prisma/client", () => ({
	db: {
		$executeRaw: executeRaw,
		$transaction: transaction,
		cloudProviderConfig: { updateMany: orgUpdateMany },
		userCloudProviderConfig: { updateMany: userUpdateMany },
	},
}));

import { updateProviderLastUsed } from "../prisma/queries/ai-gateway";

const NOW = new Date("2026-09-02T12:00:00.000Z");
const CUTOFF = new Date("2026-09-02T11:59:00.000Z");

beforeEach(() => {
	vi.resetAllMocks();
	executeRaw.mockResolvedValue(1);
	orgUpdateMany.mockResolvedValue({ count: 1 });
	userUpdateMany.mockResolvedValue({ count: 1 });
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("updateProviderLastUsed — autocommit debounce", () => {
	it.each([
		["organization", "cloud_provider_config"],
		["user", "user_cloud_provider_config"],
	] as const)(
		"%s source: binds now, id and cutoff in one conditional autocommit statement",
		async (source, table) => {
			await updateProviderLastUsed({ configId: "cfg-1", source });

			expect(orgUpdateMany).not.toHaveBeenCalled();
			expect(userUpdateMany).not.toHaveBeenCalled();
			expect(transaction).not.toHaveBeenCalled();
			expect(executeRaw).toHaveBeenCalledTimes(1);
			const [strings, ...parameters] = executeRaw.mock.calls[0];
			expect(strings.raw).toBeDefined();
			expect(strings.join("?").replace(/\s+/g, " ").trim()).toBe(
				`UPDATE "${table}" SET "lastUsedAt" = ? WHERE "id" = ? AND ("lastUsedAt" IS NULL OR "lastUsedAt" < ?)`,
			);
			expect(parameters).toEqual([NOW, "cfg-1", CUTOFF]);
		},
	);

	it.each(["organization", "user"] as const)(
		"%s source: returns 0 when no row passes the debounce predicate",
		async (source) => {
			executeRaw.mockResolvedValue(0);
			await expect(
				updateProviderLastUsed({ configId: "cfg-1", source }),
			).resolves.toBe(0);
		},
	);

	it.each(["organization", "user"] as const)(
		"%s source: returns 1 when the row is updated",
		async (source) => {
			await expect(
				updateProviderLastUsed({ configId: "cfg-1", source }),
			).resolves.toBe(1);
		},
	);
});
