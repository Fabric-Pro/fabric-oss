/**
 * Unread-count procedure.
 *
 * The handler must:
 *  - Cache only the resolved organization's unread component.
 *  - Query the caller's null-organization weekly digest component live on
 *    both cache hits and misses, so digest writes and reads need no cross-org
 *    cache invalidation.
 *  - Exclude read, archived, and per-incident alert rows from both components.
 *  - Persist only the freshly computed organization count in the cache.
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
		resolveOrganizationIdForCaller: async (
			id: string | null | undefined,
			session: { activeOrganizationId?: string },
		) =>
			(id === undefined ? session.activeOrganizationId : id) ?? undefined,
		get tenantProtectedProcedure() {
			return makeChain();
		},
	};
});

import { unreadCountNotificationsProcedure } from "../../procedures/unread-count";

describe("unreadCount procedure", () => {
	it("adds the live global digest count to the cached organization count", async () => {
		count.mockReset();
		getCachedUnreadCount.mockReset();
		setCachedUnreadCount.mockReset();
		getCachedUnreadCount.mockResolvedValue(7);
		count.mockResolvedValue(2);

		const result = await (unreadCountNotificationsProcedure as any)({
			input: { organizationId: "example-org" },
			context: {
				user: { id: "u1" },
				session: { activeOrganizationId: "example-org" },
			},
		});

		expect(getCachedUnreadCount).toHaveBeenCalledWith("u1", "example-org");
		expect(result).toEqual({ count: 9 });
		expect(count).toHaveBeenCalledWith({
			where: {
				userId: "u1",
				OR: [
					{
						organizationId: "example-org",
						type: { notIn: INCIDENT_NOTIFICATION_TYPES },
					},
					{
						organizationId: "example-org",
						dedupeKey: {
							startsWith: WEEKLY_DIGEST_DEDUPE_PREFIX,
						},
					},
					{
						organizationId: null,
						dedupeKey: {
							startsWith: WEEKLY_DIGEST_DEDUPE_PREFIX,
						},
					},
				],
				organizationId: null,
				readAt: null,
				archivedAt: null,
			},
		});
		expect(setCachedUnreadCount).not.toHaveBeenCalled();
	});

	it("caches the organization count and adds the live global digest count on a cache miss", async () => {
		count.mockReset();
		getCachedUnreadCount.mockReset();
		setCachedUnreadCount.mockReset();
		getCachedUnreadCount.mockResolvedValue(null);
		count.mockResolvedValueOnce(3).mockResolvedValueOnce(2);

		const result = await (unreadCountNotificationsProcedure as any)({
			input: { organizationId: "org-a" },
			context: {
				user: { id: "u1" },
				session: { activeOrganizationId: "example-org" },
			},
		});

		expect(count).toHaveBeenCalledTimes(2);
		const where = count.mock.calls[0][0].where;
		expect(where.userId).toBe("u1");
		expect(where.organizationId).toBe("org-a");
		expect(where.readAt).toBeNull();
		expect(where.archivedAt).toBeNull();
		// Incident-exclusion OR: drop incident types, but keep the weekly digest.
		expect(where.OR).toEqual([
			{
				organizationId: "org-a",
				type: { notIn: INCIDENT_NOTIFICATION_TYPES },
			},
			{
				organizationId: "org-a",
				dedupeKey: { startsWith: WEEKLY_DIGEST_DEDUPE_PREFIX },
			},
			{
				organizationId: null,
				dedupeKey: { startsWith: WEEKLY_DIGEST_DEDUPE_PREFIX },
			},
		]);
		expect(count.mock.calls[1][0].where).toEqual({
			...where,
			organizationId: null,
		});

		expect(result).toEqual({ count: 5 });
		expect(setCachedUnreadCount).toHaveBeenCalledWith("u1", "org-a", 3);
	});
});
