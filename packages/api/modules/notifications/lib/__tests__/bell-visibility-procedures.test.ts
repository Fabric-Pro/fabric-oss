import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	INCIDENT_NOTIFICATION_TYPES,
	WEEKLY_DIGEST_DEDUPE_PREFIX,
} from "../incident-notification-types";

const mocks = vi.hoisted(() => ({
	notificationFindMany: vi.fn(),
	notificationUpdateMany: vi.fn(),
	userFindMany: vi.fn(),
	organizationFindMany: vi.fn(),
	projectFindMany: vi.fn(),
	invalidateUnreadCount: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		notification: {
			findMany: mocks.notificationFindMany,
			updateMany: mocks.notificationUpdateMany,
		},
		user: { findMany: mocks.userFindMany },
		organization: { findMany: mocks.organizationFindMany },
		project: { findMany: mocks.projectFindMany },
	},
	NotificationCategory: new Proxy({}, { get: (_target, key) => String(key) }),
	NotificationType: new Proxy({}, { get: (_target, key) => String(key) }),
}));

vi.mock("../../lib/access-filter", () => ({
	filterByCurrentAccess: async (rows: unknown[]) => rows,
}));

vi.mock("../../../../lib/notification-cache", () => ({
	invalidateUnreadCount: mocks.invalidateUnreadCount,
}));

vi.mock("../../../../orpc/procedures", () => {
	const makeChain = () => {
		const chain = {
			use: () => chain,
			route: () => chain,
			input: () => chain,
			handler: (handler: unknown) => handler,
		};
		return chain;
	};
	return {
		Permissions: new Proxy({}, { get: (_target, key) => String(key) }),
		requirePermission: () => () => undefined,
		resolveOrganizationIdForCaller: async (
			input: string | null | undefined,
			session: { activeOrganizationId?: string | null },
		) =>
			(input === undefined ? session.activeOrganizationId : input) ??
			undefined,
		get tenantProtectedProcedure() {
			return makeChain();
		},
	};
});

import { archiveNotificationsProcedure } from "../../procedures/archive";
import { listNotificationsProcedure } from "../../procedures/list";
import { markAllReadNotificationsProcedure } from "../../procedures/mark-all-read";
import { restoreNotificationsProcedure } from "../../procedures/restore";

const context = {
	user: { id: "example-user" },
	session: { activeOrganizationId: "example-org" },
};

const visibleWhere = {
	userId: "example-user",
	OR: [
		{
			organizationId: "example-org",
			type: { notIn: INCIDENT_NOTIFICATION_TYPES },
		},
		{
			organizationId: "example-org",
			dedupeKey: { startsWith: WEEKLY_DIGEST_DEDUPE_PREFIX },
		},
		{
			organizationId: null,
			dedupeKey: { startsWith: WEEKLY_DIGEST_DEDUPE_PREFIX },
		},
	],
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.notificationFindMany.mockResolvedValue([]);
	mocks.notificationUpdateMany.mockResolvedValue({ count: 0 });
	mocks.userFindMany.mockResolvedValue([]);
	mocks.organizationFindMany.mockResolvedValue([]);
	mocks.projectFindMany.mockResolvedValue([]);
});

describe("bell visibility shared by notification procedures", () => {
	it("lists own organization rows and own global digest rows only", async () => {
		await (listNotificationsProcedure as any)({
			input: {
				organizationId: "example-org",
				status: "all",
				limit: 20,
			},
			context,
		});

		expect(mocks.notificationFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining(visibleWhere),
			}),
		);
	});

	it("archives only ids in the same bell-visible set", async () => {
		await (archiveNotificationsProcedure as any)({
			input: { organizationId: "example-org", ids: ["notification-1"] },
			context,
		});

		expect(mocks.notificationUpdateMany).toHaveBeenCalledWith({
			where: {
				...visibleWhere,
				id: { in: ["notification-1"] },
				archivedAt: null,
			},
			data: { archivedAt: expect.any(Date) },
		});
	});

	it("restores only ids in the same bell-visible set", async () => {
		await (restoreNotificationsProcedure as any)({
			input: { organizationId: "example-org", ids: ["notification-1"] },
			context,
		});

		expect(mocks.notificationUpdateMany).toHaveBeenCalledWith({
			where: {
				...visibleWhere,
				id: { in: ["notification-1"] },
				archivedAt: { not: null },
			},
			data: { archivedAt: null },
		});
	});

	it("marks every unread row in the same bell-visible set as read", async () => {
		await (markAllReadNotificationsProcedure as any)({
			input: { organizationId: "example-org" },
			context,
		});

		expect(mocks.notificationUpdateMany).toHaveBeenCalledWith({
			where: {
				...visibleWhere,
				readAt: null,
				archivedAt: null,
			},
			data: { readAt: expect.any(Date) },
		});
	});
});
