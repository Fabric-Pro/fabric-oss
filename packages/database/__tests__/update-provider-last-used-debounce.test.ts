/**
 * Unit tests for `updateProviderLastUsed`'s one-minute debounce.
 *
 * Prod measured this as the single most expensive statement in the app
 * (54,102 calls / 14 days, 3.8ms mean, 17% of app DB time) because every AI
 * model call updated a 3-row table and concurrent calls serialized on the row
 * lock. The fix swaps the unconditional `update` for a conditional
 * `updateMany` (id + "never touched or touched before the debounce cutoff")
 * so a call inside the window takes no row lock at all.
 *
 * Run with: pnpm --filter @repo/database test __tests__/update-provider-last-used-debounce.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { orgUpdateMany, userUpdateMany } = vi.hoisted(() => ({
	orgUpdateMany: vi.fn(),
	userUpdateMany: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		cloudProviderConfig: { updateMany: orgUpdateMany },
		userCloudProviderConfig: { updateMany: userUpdateMany },
	},
}));

import { updateProviderLastUsed } from "../prisma/queries/ai-gateway";

const NOW = new Date("2026-09-02T12:00:00.000Z");
const CUTOFF = new Date(NOW.getTime() - 60_000);

beforeEach(() => {
	orgUpdateMany.mockReset();
	userUpdateMany.mockReset();
	orgUpdateMany.mockResolvedValue({ count: 1 });
	userUpdateMany.mockResolvedValue({ count: 1 });
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("updateProviderLastUsed — debounce", () => {
	it("organization source: updateMany with id + null-or-older-than-cutoff guard and lastUsedAt = now", async () => {
		await updateProviderLastUsed({
			configId: "cfg-org-1",
			source: "organization",
		});

		expect(orgUpdateMany).toHaveBeenCalledWith({
			where: {
				id: "cfg-org-1",
				OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: CUTOFF } }],
			},
			data: { lastUsedAt: NOW },
		});
		expect(userUpdateMany).not.toHaveBeenCalled();
	});

	it("user source: updateMany with id + null-or-older-than-cutoff guard and lastUsedAt = now", async () => {
		await updateProviderLastUsed({
			configId: "cfg-user-1",
			source: "user",
		});

		expect(userUpdateMany).toHaveBeenCalledWith({
			where: {
				id: "cfg-user-1",
				OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: CUTOFF } }],
			},
			data: { lastUsedAt: NOW },
		});
		expect(orgUpdateMany).not.toHaveBeenCalled();
	});

	it("returns the affected row count from updateMany (0 when the row was touched inside the debounce window)", async () => {
		orgUpdateMany.mockResolvedValue({ count: 0 });
		const n = await updateProviderLastUsed({
			configId: "cfg-org-1",
			source: "organization",
		});
		expect(n).toBe(0);
	});

	it("returns 1 when the row was actually updated", async () => {
		userUpdateMany.mockResolvedValue({ count: 1 });
		const n = await updateProviderLastUsed({
			configId: "cfg-user-1",
			source: "user",
		});
		expect(n).toBe(1);
	});
});
