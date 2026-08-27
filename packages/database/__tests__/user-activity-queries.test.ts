/**
 * Mocked-db tests for the User Activity query functions.
 * The Prisma client is mocked; these tests pin the WHERE-clause shapes
 * (tenant clamp, action filter, range filter) and the row assembly.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	memberFindMany: vi.fn(),
	memberFindUnique: vi.fn(),
	auditGroupBy: vi.fn(),
	auditFindMany: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		member: {
			findMany: mocks.memberFindMany,
			findUnique: mocks.memberFindUnique,
		},
		auditLog: {
			groupBy: mocks.auditGroupBy,
			findMany: mocks.auditFindMany,
		},
	},
}));

import {
	getMemberLoginHistory,
	listMemberActivity,
} from "../prisma/queries/user-activity";

const NOW = new Date("2026-07-02T15:30:00.000Z");

function makeMember(
	userId: string,
	email: string,
	role = "member",
	lastSeenAt: Date | null = null,
) {
	return {
		role,
		user: {
			id: userId,
			name: `User ${userId}`,
			email,
			image: null,
			lastSeenAt,
		},
	};
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("listMemberActivity", () => {
	it("clamps the member query to the organization and maps rows", async () => {
		mocks.memberFindMany.mockResolvedValue([
			makeMember("u1", "u1@example.com"),
			makeMember("u2", "u2@example.com"),
		]);
		// First groupBy call = last logins (_max), second = counts (_count).
		mocks.auditGroupBy.mockImplementation(async (args: any) =>
			args._max
				? [
						{
							userId: "u1",
							_max: {
								createdAt: new Date("2026-07-01T08:00:00.000Z"),
							},
						},
					]
				: [{ userId: "u1", _count: { _all: 3 } }],
		);

		const result = await listMemberActivity({
			organizationId: "org-1",
			rangeDays: 30,
			sortDir: "desc",
			limit: 25,
			offset: 0,
			now: NOW,
		});

		expect(mocks.memberFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ organizationId: "org-1" }),
			}),
		);
		// Both audit queries filter by member userIds + login action —
		// never by organizationId (auth rows carry organizationId = null).
		for (const call of mocks.auditGroupBy.mock.calls) {
			expect(call[0].where.userId).toEqual({ in: ["u1", "u2"] });
			expect(call[0].where.action).toBe("auth.login.success");
			expect(call[0].where.organizationId).toBeUndefined();
		}
		expect(result.total).toBe(2);
		expect(result.items[0]).toEqual({
			userId: "u1",
			name: "User u1",
			email: "u1@example.com",
			image: null,
			role: "member",
			lastSeenAt: null,
			lastLoginAt: new Date("2026-07-01T08:00:00.000Z"),
			loginCountInRange: 3,
		});
		// u2 never logged in → null lastLogin, zero count, sorted last (desc).
		expect(result.items[1].lastLoginAt).toBeNull();
		expect(result.items[1].loginCountInRange).toBe(0);
	});

	it("applies the range filter to the count query only", async () => {
		mocks.memberFindMany.mockResolvedValue([
			makeMember("u1", "u1@example.com"),
		]);
		mocks.auditGroupBy.mockResolvedValue([]);

		await listMemberActivity({
			organizationId: "org-1",
			rangeDays: 7,
			sortDir: "desc",
			limit: 25,
			offset: 0,
			now: NOW,
		});

		const [lastLoginCall, countCall] = mocks.auditGroupBy.mock.calls;
		expect(lastLoginCall[0].where.createdAt).toBeUndefined();
		expect(countCall[0].where.createdAt).toEqual({
			gte: new Date("2026-06-26T00:00:00.000Z"),
		});
	});

	it("applies a case-insensitive name/email search inside the tenant clamp", async () => {
		mocks.memberFindMany.mockResolvedValue([]);
		await listMemberActivity({
			organizationId: "org-1",
			rangeDays: 30,
			sortDir: "desc",
			query: "ada",
			limit: 25,
			offset: 0,
			now: NOW,
		});
		const where = mocks.memberFindMany.mock.calls[0][0].where;
		expect(where.organizationId).toBe("org-1");
		expect(where.OR).toEqual([
			{ user: { name: { contains: "ada", mode: "insensitive" } } },
			{ user: { email: { contains: "ada", mode: "insensitive" } } },
		]);
	});

	it("paginates in-memory with offset/limit", async () => {
		mocks.memberFindMany.mockResolvedValue([
			makeMember("u1", "a@example.com"),
			makeMember("u2", "b@example.com"),
			makeMember("u3", "c@example.com"),
		]);
		mocks.auditGroupBy.mockResolvedValue([]);

		const result = await listMemberActivity({
			organizationId: "org-1",
			rangeDays: 30,
			sortDir: "desc",
			limit: 2,
			offset: 2,
			now: NOW,
		});
		expect(result.total).toBe(3);
		expect(result.items).toHaveLength(1);
		expect(result.items[0].email).toBe("c@example.com");
	});

	it("returns empty for an org with no members without querying audit_log", async () => {
		mocks.memberFindMany.mockResolvedValue([]);
		const result = await listMemberActivity({
			organizationId: "org-1",
			rangeDays: 30,
			sortDir: "desc",
			limit: 25,
			offset: 0,
			now: NOW,
		});
		expect(result).toEqual({ items: [], total: 0 });
		expect(mocks.auditGroupBy).not.toHaveBeenCalled();
	});

	it("returns lastSeenAt from the member's user row", async () => {
		const seen = new Date("2026-07-23T09:00:00.000Z");
		mocks.memberFindMany.mockResolvedValue([
			{
				role: "admin",
				user: {
					id: "u1",
					name: "User u1",
					email: "u1@example.com",
					image: null,
					lastSeenAt: seen,
				},
			},
		]);
		mocks.auditGroupBy.mockResolvedValue([]);

		const result = await listMemberActivity({
			organizationId: "org-1",
			rangeDays: 30,
			sortDir: "desc",
			limit: 25,
			offset: 0,
			now: NOW,
		});

		expect(result.items[0].lastSeenAt).toEqual(seen);
		// The login metric is kept, not replaced.
		expect(result.items[0].lastLoginAt).toBeNull();
	});

	it("orders the member list by lastSeenAt, not lastLoginAt", async () => {
		mocks.memberFindMany.mockResolvedValue([
			{
				role: "member",
				user: {
					id: "u1",
					name: "Stale login, active now",
					email: "active@example.com",
					image: null,
					lastSeenAt: new Date("2026-07-23T09:00:00.000Z"),
				},
			},
			{
				role: "member",
				user: {
					id: "u2",
					name: "Recent login, gone since",
					email: "dormant@example.com",
					image: null,
					lastSeenAt: new Date("2026-05-01T09:00:00.000Z"),
				},
			},
		]);
		// u2 logged in most recently; u1 has been active most recently.
		mocks.auditGroupBy.mockImplementation(async (args: any) =>
			args._max
				? [
						{
							userId: "u2",
							_max: {
								createdAt: new Date("2026-07-20T00:00:00.000Z"),
							},
						},
					]
				: [],
		);

		const result = await listMemberActivity({
			organizationId: "org-1",
			rangeDays: 30,
			sortDir: "desc",
			limit: 25,
			offset: 0,
			now: NOW,
		});

		expect(result.items.map((i) => i.email)).toEqual([
			"active@example.com",
			"dormant@example.com",
		]);
	});
});

describe("getMemberLoginHistory", () => {
	it("returns null when the target user is not an org member", async () => {
		mocks.memberFindUnique.mockResolvedValue(null);
		const result = await getMemberLoginHistory({
			organizationId: "org-1",
			userId: "intruder",
			rangeDays: 30,
			now: NOW,
		});
		expect(result).toBeNull();
		expect(mocks.auditFindMany).not.toHaveBeenCalled();
	});

	it("buckets logins and returns recent events for a member", async () => {
		mocks.memberFindUnique.mockResolvedValue(
			makeMember("u1", "u1@example.com", "admin"),
		);
		mocks.auditFindMany.mockImplementation(async (args: any) =>
			args.take === 20
				? [
						{
							action: "auth.login.success",
							createdAt: new Date("2026-07-02T08:00:00.000Z"),
							ipAddress: "10.0.0.1",
							userAgent: "Mozilla/5.0",
						},
						{
							action: "auth.logout",
							createdAt: new Date("2026-07-01T17:00:00.000Z"),
							ipAddress: "10.0.0.1",
							userAgent: "Mozilla/5.0",
						},
					]
				: [
						{ createdAt: new Date("2026-07-02T08:00:00.000Z") },
						{ createdAt: new Date("2026-07-01T09:00:00.000Z") },
					],
		);

		const result = await getMemberLoginHistory({
			organizationId: "org-1",
			userId: "u1",
			rangeDays: 7,
			now: NOW,
		});

		expect(mocks.memberFindUnique).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					organizationId_userId: {
						organizationId: "org-1",
						userId: "u1",
					},
				},
			}),
		);
		expect(result?.role).toBe("admin");
		expect(result?.totalLoginsInRange).toBe(2);
		expect(result?.buckets).toHaveLength(7);
		expect(result?.buckets.find((b) => b.day === "2026-07-02")?.count).toBe(
			1,
		);
		expect(result?.recentEvents).toHaveLength(2);
		expect(result?.recentEvents[0].ipAddress).toBe("10.0.0.1");
		expect(result?.recentEvents[1].action).toBe("auth.logout");
	});
});
