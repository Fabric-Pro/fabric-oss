/**
 * notifyChatGptPlanOrgAccountNeedsReconnect (Fizzy #2770 D4): one in-app row
 * per owner/admin of the account's organization, plus whoever connected it,
 * deduped per account and recipient; never throws.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { findFirst, findMany, create } = vi.hoisted(() => ({
	findFirst: vi.fn(),
	findMany: vi.fn(),
	create: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		chatGptPlanOrgAccount: { findFirst },
		member: { findMany },
		notification: { create },
	},
	NotificationCategory: { SYSTEM: "SYSTEM" },
	NotificationType: {
		CHATGPT_PLAN_ACCOUNT_NEEDS_RECONNECT:
			"CHATGPT_PLAN_ACCOUNT_NEEDS_RECONNECT",
	},
}));

import { notifyChatGptPlanOrgAccountNeedsReconnect } from "../prisma/queries/chatgpt-plan-org-account-notifications";

const input = { organizationId: "org-1", accountId: "acc-1" };

beforeEach(() => {
	vi.clearAllMocks();
	findFirst.mockResolvedValue({
		label: "Design team",
		email: "plans@example.com",
		connectedByUserId: "member-2",
	});
	findMany.mockResolvedValue([
		{ userId: "owner-1", role: "owner" },
		{ userId: "admin-1", role: "admin" },
		{ userId: "member-1", role: "member" },
		{ userId: "member-2", role: "member" },
	]);
	create.mockResolvedValue({});
});

describe("notifyChatGptPlanOrgAccountNeedsReconnect", () => {
	it("writes one row to each owner, admin and the connector, in this organization", async () => {
		await notifyChatGptPlanOrgAccountNeedsReconnect(input);

		expect(findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "acc-1", organizationId: "org-1" },
			}),
		);
		const rows = create.mock.calls.map((call) => call[0].data);
		expect(rows.map((row) => row.userId).sort()).toEqual([
			"admin-1",
			"member-2",
			"owner-1",
		]);
		expect(rows[0]).toMatchObject({
			organizationId: "org-1",
			type: "CHATGPT_PLAN_ACCOUNT_NEEDS_RECONNECT",
			category: "SYSTEM",
			link: "settings/ai-providers",
			payload: {
				accountId: "acc-1",
				accountName: "Design team (plans@example.com)",
			},
		});
		expect(rows.map((row) => row.dedupeKey).sort()).toEqual([
			"chatgptPlanAccountReconnect:acc-1:admin-1",
			"chatgptPlanAccountReconnect:acc-1:member-2",
			"chatgptPlanAccountReconnect:acc-1:owner-1",
		]);
	});

	it("leaves an unread row for the same account standing, and never throws", async () => {
		create.mockRejectedValueOnce(
			Object.assign(new Error("dup"), { code: "P2002" }),
		);
		create.mockRejectedValueOnce(new Error("db down"));
		await expect(
			notifyChatGptPlanOrgAccountNeedsReconnect(input),
		).resolves.toBeUndefined();
		expect(create).toHaveBeenCalledTimes(3);

		findMany.mockRejectedValueOnce(new Error("db down"));
		await expect(
			notifyChatGptPlanOrgAccountNeedsReconnect(input),
		).resolves.toBeUndefined();
	});

	it("writes nothing for an account that is gone", async () => {
		findFirst.mockResolvedValue(null);
		await notifyChatGptPlanOrgAccountNeedsReconnect(input);
		expect(create).not.toHaveBeenCalled();
	});
});
