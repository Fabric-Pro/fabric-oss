/**
 * Unread-count procedure.
 *
 * The handler must:
 *  - Consult the Redis unread-count cache first; on a hit (cached !== null)
 *    return `{ count: cached }` WITHOUT touching the database.
 *  - On a miss query `db.notification.count` scoped to the caller's
 *    `userId`/`organizationId`, excluding read + archived rows, and excluding
 *    per-incident alert types EXCEPT the weekly digest (matched by dedupe-key
 *    prefix).
 *  - Persist the freshly computed count back into the cache before returning.
 */

import { describe, expect, it, vi } from "vitest";
import {
	INCIDENT_NOTIFICATION_TYPES,
	WEEKLY_DIGEST_DEDUPE_PREFIX,
} from "../incident-notification-types";

const { count, getCachedUnreadCount, setCachedUnreadCount } = vi.hoisted(
	() => ({
		count: vi.fn(),
		getCachedUnreadCount: vi.fn(),
		setCachedUnreadCount: vi.fn(),
	}),
);

vi.mock("@repo/database", () => ({
	db: { notification: { count } },
}));

vi.mock("../../../../lib/notification-cache", () => ({
	getCachedUnreadCount,
	setCachedUnreadCount,
}));

vi.mock("../../../../orpc/procedures", () => {
	// Mirror archive.test.ts: each `.use().route().input().handler()` chain
	// returns the bare handler function so the test can invoke it directly.
	const makeChain = () => {
		const chain: any = {
			use: () => chain,
			route: () => chain,
			input: () => ({
				...chain,
				handler: (h: any) => h,
			}),
			handler: (h: any) => h,
		};
		return chain;
	};
	return {
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => () => undefined,
		resolveOrganizationId: (id: string | null | undefined) => id ?? null,
		get tenantProtectedProcedure() {
			return makeChain();
		},
	};
});

import { unreadCountNotificationsProcedure } from "../../procedures/unread-count";

describe("unreadCount procedure", () => {
	it("returns the cached count without querying the database on a cache hit", async () => {
		count.mockReset();
		getCachedUnreadCount.mockReset();
		setCachedUnreadCount.mockReset();
		getCachedUnreadCount.mockResolvedValue(7);

		const result = await (unreadCountNotificationsProcedure as any)({
			input: { organizationId: null },
			context: { user: { id: "u1" }, session: {} },
		});

		expect(getCachedUnreadCount).toHaveBeenCalledWith("u1", null);
		expect(result).toEqual({ count: 7 });
		expect(count).not.toHaveBeenCalled();
		expect(setCachedUnreadCount).not.toHaveBeenCalled();
	});

	it("counts unread, non-archived, non-incident notifications on a cache miss and primes the cache", async () => {
		count.mockReset();
		getCachedUnreadCount.mockReset();
		setCachedUnreadCount.mockReset();
		getCachedUnreadCount.mockResolvedValue(null);
		count.mockResolvedValue(3);

		const result = await (unreadCountNotificationsProcedure as any)({
			input: { organizationId: "org-a" },
			context: { user: { id: "u1" }, session: {} },
		});

		expect(count).toHaveBeenCalledTimes(1);
		const where = count.mock.calls[0][0].where;
		expect(where.userId).toBe("u1");
		expect(where.organizationId).toBe("org-a");
		expect(where.readAt).toBeNull();
		expect(where.archivedAt).toBeNull();
		// Incident-exclusion OR: drop incident types, but keep the weekly digest.
		expect(where.OR).toEqual([
			{ type: { notIn: INCIDENT_NOTIFICATION_TYPES } },
			{ dedupeKey: { startsWith: WEEKLY_DIGEST_DEDUPE_PREFIX } },
		]);

		expect(result).toEqual({ count: 3 });
		expect(setCachedUnreadCount).toHaveBeenCalledWith("u1", "org-a", 3);
	});
});
