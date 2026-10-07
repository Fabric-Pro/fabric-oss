/**
 * ChatGPT plan pooling queries (Fizzy #2770). The Prisma client is mocked;
 * these pin that every read and write by account id also filters on the
 * organization, that one ChatGPT account never serves two organizations, and
 * that the pool ledger reads only the organization's own plan rows.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "../prisma/generated/client";

const mocks = vi.hoisted(() => ({
	accountFindUnique: vi.fn(),
	accountFindFirst: vi.fn(),
	accountFindMany: vi.fn(),
	accountCreate: vi.fn(),
	accountUpdateMany: vi.fn(),
	accountDeleteMany: vi.fn(),
	stateDeleteMany: vi.fn(),
	policyFindUnique: vi.fn(),
	policyUpsert: vi.fn(),
	usageGroupBy: vi.fn(),
}));

vi.mock("../prisma/client", () => {
	const db = {
		chatGptPlanOrgAccount: {
			findUnique: mocks.accountFindUnique,
			findFirst: mocks.accountFindFirst,
			findMany: mocks.accountFindMany,
			create: mocks.accountCreate,
			updateMany: mocks.accountUpdateMany,
			deleteMany: mocks.accountDeleteMany,
		},
		chatGptPlanSourceState: { deleteMany: mocks.stateDeleteMany },
		chatGptPlanOrgPolicy: {
			findUnique: mocks.policyFindUnique,
			upsert: mocks.policyUpsert,
		},
		aiUsageLog: { groupBy: mocks.usageGroupBy },
		$transaction: (fn: (tx: unknown) => unknown) => fn(db),
	};
	return { db };
});

import {
	ChatGptPlanSubjectBoundElsewhereError,
	DEFAULT_CHATGPT_PLAN_ORG_POLICY,
	deleteChatGptPlanOrgAccount,
	getChatGptPlanOrgAccount,
	getChatGptPlanOrgPolicy,
	getChatGptPlanPoolUsageSince,
	updateChatGptPlanOrgAccount,
	upsertChatGptPlanOrgAccount,
} from "../prisma/queries/chatgpt-plan-org-accounts";

const write = {
	organizationId: "org_a",
	connectedByUserId: "u_admin",
	label: "Shared plan",
	email: "shared@example.com",
	subject: "sub_1",
	clientId: "client",
	hostId: "host",
	encryptedAccessToken: "enc-a",
	encryptedRefreshToken: "enc-r",
	encryptedIdToken: null,
	accessTokenExpiresAt: new Date("2026-10-07T12:00:00Z"),
	earliestRefreshAt: null,
	scopes: ["s"],
};

beforeEach(() => {
	vi.clearAllMocks();
});

describe("upsertChatGptPlanOrgAccount", () => {
	it("creates a new account in the caller's organization", async () => {
		mocks.accountFindUnique.mockResolvedValue(null);
		mocks.accountCreate.mockResolvedValue({ id: "acc_1" });

		await expect(upsertChatGptPlanOrgAccount(write)).resolves.toEqual({
			id: "acc_1",
			created: true,
		});
		expect(mocks.accountCreate.mock.calls[0][0].data).toMatchObject({
			organizationId: "org_a",
			subject: "sub_1",
			status: "ACTIVE",
		});
	});

	it("reconnects the same organization's account by subject, keeping its label", async () => {
		mocks.accountFindUnique.mockResolvedValue({
			id: "acc_1",
			organizationId: "org_a",
		});
		mocks.accountUpdateMany.mockResolvedValue({ count: 1 });

		await expect(upsertChatGptPlanOrgAccount(write)).resolves.toEqual({
			id: "acc_1",
			created: false,
		});
		const call = mocks.accountUpdateMany.mock.calls[0][0];
		expect(call.where).toEqual({ id: "acc_1", organizationId: "org_a" });
		expect(call.data).not.toHaveProperty("label");
		expect(call.data.status).toBe("ACTIVE");
	});

	it("refuses an account another organization already connected", async () => {
		mocks.accountFindUnique.mockResolvedValue({
			id: "acc_9",
			organizationId: "org_b",
		});

		await expect(upsertChatGptPlanOrgAccount(write)).rejects.toBeInstanceOf(
			ChatGptPlanSubjectBoundElsewhereError,
		);
		expect(mocks.accountCreate).not.toHaveBeenCalled();
		expect(mocks.accountUpdateMany).not.toHaveBeenCalled();
	});

	it("maps a lost race on the unique subject to the same refusal", async () => {
		mocks.accountFindUnique.mockResolvedValue(null);
		mocks.accountCreate.mockRejectedValue(
			new Prisma.PrismaClientKnownRequestError("Unique constraint", {
				code: "P2002",
				clientVersion: "test",
			}),
		);

		await expect(upsertChatGptPlanOrgAccount(write)).rejects.toBeInstanceOf(
			ChatGptPlanSubjectBoundElsewhereError,
		);
	});
});

describe("organization filter on reads and writes by account id", () => {
	it("reads an account only within the organization", async () => {
		mocks.accountFindFirst.mockResolvedValue(null);
		await expect(
			getChatGptPlanOrgAccount({
				organizationId: "org_b",
				accountId: "acc_1",
			}),
		).resolves.toBeNull();
		expect(mocks.accountFindFirst).toHaveBeenCalledWith({
			where: { id: "acc_1", organizationId: "org_b" },
		});
	});

	it("does not update another organization's account", async () => {
		mocks.accountFindFirst.mockResolvedValue(null);

		await expect(
			updateChatGptPlanOrgAccount({
				organizationId: "org_b",
				accountId: "acc_1",
				patch: { enabled: false },
			}),
		).resolves.toBeNull();
		expect(mocks.accountUpdateMany).not.toHaveBeenCalled();
	});

	it("updates with the organization in the where clause", async () => {
		const summary = { id: "acc_1", enabled: true };
		mocks.accountFindFirst
			.mockResolvedValueOnce(summary)
			.mockResolvedValueOnce({ ...summary, enabled: false });
		mocks.accountUpdateMany.mockResolvedValue({ count: 1 });

		const result = await updateChatGptPlanOrgAccount({
			organizationId: "org_a",
			accountId: "acc_1",
			patch: { enabled: false },
		});
		expect(result?.after.enabled).toBe(false);
		expect(mocks.accountUpdateMany).toHaveBeenCalledWith({
			where: { id: "acc_1", organizationId: "org_a" },
			data: { enabled: false },
		});
	});

	it("deletes the account and its breaker row, and only within the organization", async () => {
		mocks.accountDeleteMany.mockResolvedValue({ count: 1 });

		await expect(
			deleteChatGptPlanOrgAccount({
				organizationId: "org_a",
				accountId: "acc_1",
			}),
		).resolves.toBe(true);
		expect(mocks.accountDeleteMany).toHaveBeenCalledWith({
			where: { id: "acc_1", organizationId: "org_a" },
		});
		expect(mocks.stateDeleteMany).toHaveBeenCalledWith({
			where: { sourceKind: "ORG", sourceId: "acc_1" },
		});
	});

	it("leaves the breaker row alone when the account is not this organization's", async () => {
		mocks.accountDeleteMany.mockResolvedValue({ count: 0 });

		await expect(
			deleteChatGptPlanOrgAccount({
				organizationId: "org_b",
				accountId: "acc_1",
			}),
		).resolves.toBe(false);
		expect(mocks.stateDeleteMany).not.toHaveBeenCalled();
	});
});

describe("getChatGptPlanOrgPolicy", () => {
	it("answers pooling off and nothing acknowledged when there is no row", async () => {
		mocks.policyFindUnique.mockResolvedValue(null);
		await expect(getChatGptPlanOrgPolicy("org_a")).resolves.toEqual(
			DEFAULT_CHATGPT_PLAN_ORG_POLICY,
		);
		expect(DEFAULT_CHATGPT_PLAN_ORG_POLICY).toMatchObject({
			poolingEnabled: false,
			apiFallbackInteractive: "ASK",
			apiFallbackBackground: "NEVER",
			termsAcknowledgedAt: null,
		});
	});
});

describe("getChatGptPlanPoolUsageSince", () => {
	it("groups the organization's plan rows by account", async () => {
		mocks.usageGroupBy.mockResolvedValue([
			{
				providerConfigId: "acc_1",
				_count: { _all: 3 },
				_sum: { inputTokens: 300, outputTokens: 30 },
			},
		]);
		const since = new Date("2026-10-07T07:00:00Z");

		const usage = await getChatGptPlanPoolUsageSince({
			organizationId: "org_a",
			accountIds: ["acc_1", "acc_2"],
			since,
		});
		expect(usage.get("acc_1")).toEqual({
			requests: 3,
			inputTokens: 300,
			outputTokens: 30,
		});
		expect(usage.has("acc_2")).toBe(false);
		expect(mocks.usageGroupBy.mock.calls[0][0].where).toEqual({
			organizationId: "org_a",
			createdAt: { gte: since },
			provider: "OPENAI_CHATGPT_PLAN",
			providerConfigId: { in: ["acc_1", "acc_2"] },
		});
	});

	it("does not query for an empty pool", async () => {
		const usage = await getChatGptPlanPoolUsageSince({
			organizationId: "org_a",
			accountIds: [],
			since: new Date(),
		});
		expect(usage.size).toBe(0);
		expect(mocks.usageGroupBy).not.toHaveBeenCalled();
	});
});
