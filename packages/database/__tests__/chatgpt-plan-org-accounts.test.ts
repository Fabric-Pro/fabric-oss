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
	servedDeleteMany: vi.fn(),
	observationDeleteMany: vi.fn(),
	policyFindUnique: vi.fn(),
	policyUpsert: vi.fn(),
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
		chatGptPlanServedModel: { deleteMany: mocks.servedDeleteMany },
		chatGptPlanBudgetObservation: {
			deleteMany: mocks.observationDeleteMany,
		},
		chatGptPlanOrgPolicy: {
			findUnique: mocks.policyFindUnique,
			upsert: mocks.policyUpsert,
		},
		$transaction: (fn: (tx: unknown) => unknown) => fn(db),
	};
	return { db };
});

import {
	__resetChatGptPlanOrgPolicyCache,
	acknowledgeChatGptPlanOrgTerms,
	ChatGptPlanSubjectBoundElsewhereError,
	DEFAULT_CHATGPT_PLAN_ORG_POLICY,
	deleteChatGptPlanOrgAccount,
	getCachedChatGptPlanOrgPolicy,
	getChatGptPlanOrgAccount,
	getChatGptPlanOrgPolicy,
	updateChatGptPlanOrgAccount,
	updateChatGptPlanOrgPolicy,
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
		mocks.accountFindFirst.mockResolvedValue(null);
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

	it("reconnects the same organization's account, keeping its label", async () => {
		mocks.accountFindFirst.mockResolvedValue({
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
		// A fresh client registration brings a new sub; the row takes it.
		expect(call.data.subject).toBe("sub_1");
	});

	it("refuses an account another organization already connected", async () => {
		mocks.accountFindFirst.mockResolvedValue({
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
		mocks.accountFindFirst.mockResolvedValue(null);
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

	// Fizzy #2770: OpenAI's sub differs per client registration, so the same
	// ChatGPT account is found by its email as well.
	it("finds the same account by sub or by email, case-insensitively", async () => {
		mocks.accountFindFirst.mockResolvedValue(null);
		mocks.accountCreate.mockResolvedValue({ id: "acc_1" });
		await upsertChatGptPlanOrgAccount({
			...write,
			email: " Shared@Example.com ",
		});
		expect(mocks.accountFindFirst.mock.calls[0][0].where).toEqual({
			OR: [
				{ subject: "sub_1" },
				{
					email: {
						equals: "shared@example.com",
						mode: "insensitive",
					},
				},
			],
		});
	});

	it("refuses an account another organization has under a different sub", async () => {
		mocks.accountFindFirst.mockResolvedValue({
			id: "acc_9",
			organizationId: "org_b",
		});
		await expect(
			upsertChatGptPlanOrgAccount({ ...write, subject: "sub_fresh" }),
		).rejects.toBeInstanceOf(ChatGptPlanSubjectBoundElsewhereError);
		expect(mocks.accountCreate).not.toHaveBeenCalled();
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

	it("deletes the account, its breaker row, served models and calibration, and only within the organization", async () => {
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
		expect(mocks.servedDeleteMany).toHaveBeenCalledWith({
			where: { sourceKind: "ORG", sourceId: "acc_1" },
		});
		expect(mocks.observationDeleteMany).toHaveBeenCalledWith({
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
		expect(mocks.servedDeleteMany).not.toHaveBeenCalled();
		expect(mocks.observationDeleteMany).not.toHaveBeenCalled();
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

// Fizzy #2770: every plan-served call reads the policy, so the call path
// reuses it for 30 s; a change made in this process applies at once.
describe("getCachedChatGptPlanOrgPolicy", () => {
	const T0 = Date.parse("2026-10-08T12:00:00Z");
	const policy = (fallbackModel: string) => ({
		...DEFAULT_CHATGPT_PLAN_ORG_POLICY,
		fallbackModel,
	});

	beforeEach(() => {
		__resetChatGptPlanOrgPolicyCache();
		mocks.policyFindUnique.mockReset();
		mocks.policyUpsert.mockReset();
	});

	it("reuses an organization's policy for 30 s, per organization", async () => {
		mocks.policyFindUnique.mockResolvedValue(policy("gpt-6-astra"));
		await getCachedChatGptPlanOrgPolicy("org_a", T0);
		await getCachedChatGptPlanOrgPolicy("org_a", T0 + 29_000);
		expect(mocks.policyFindUnique).toHaveBeenCalledTimes(1);
		await getCachedChatGptPlanOrgPolicy("org_b", T0);
		await getCachedChatGptPlanOrgPolicy("org_a", T0 + 31_000);
		expect(mocks.policyFindUnique).toHaveBeenCalledTimes(3);
	});

	it("reads it again at once after this process changes it or accepts the terms", async () => {
		mocks.policyFindUnique.mockResolvedValue(policy("gpt-6-astra"));
		await getCachedChatGptPlanOrgPolicy("org_a");
		mocks.policyUpsert.mockResolvedValue(policy("gpt-5.6-terra"));
		await updateChatGptPlanOrgPolicy({
			organizationId: "org_a",
			patch: { fallbackModel: "gpt-5.6-terra" },
		});
		mocks.policyFindUnique.mockResolvedValue(policy("gpt-5.6-terra"));
		await expect(
			getCachedChatGptPlanOrgPolicy("org_a"),
		).resolves.toMatchObject({ fallbackModel: "gpt-5.6-terra" });

		await acknowledgeChatGptPlanOrgTerms({
			organizationId: "org_a",
			userId: "u_owner",
		});
		const reads = mocks.policyFindUnique.mock.calls.length;
		await getCachedChatGptPlanOrgPolicy("org_a");
		expect(mocks.policyFindUnique).toHaveBeenCalledTimes(reads + 1);
	});
});
