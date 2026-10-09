/**
 * An organization account's sign-in (Fizzy #2770): refreshed under its own
 * lock, read and written only within its organization, and marked
 * NEEDS_RECONNECT only there when OpenAI rejects its refresh token.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Account = {
	id: string;
	organizationId: string;
	clientId: string;
	encryptedAccessToken: string;
	encryptedRefreshToken: string;
	accessTokenExpiresAt: Date;
	earliestRefreshAt: Date | null;
	scopes: string[];
	status: "ACTIVE" | "NEEDS_RECONNECT";
	tier?: string;
	subscriptionActiveUntil?: Date | null;
	encryptedIdToken?: string | null;
};

const store = vi.hoisted(() => ({
	account: null as Account | null,
	lockKeys: [] as string[],
	reads: [] as unknown[],
	writes: [] as unknown[],
}));

vi.mock("@repo/utils", () => ({
	encryptApiKey: (value: string) => `encrypted:${value}`,
	decryptApiKey: (value: string) => {
		if (!value.startsWith("encrypted:")) {
			throw new Error("Invalid encrypted value");
		}
		return value.slice("encrypted:".length);
	},
}));

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const matches = (where: {
	id: string;
	organizationId: string;
	status?: Account["status"];
}) =>
	store.account !== null &&
	store.account.id === where.id &&
	store.account.organizationId === where.organizationId &&
	(where.status === undefined || store.account.status === where.status);

const notifyNeedsReconnect = vi.hoisted(() => vi.fn(async () => undefined));

const tx = vi.hoisted(() => ({
	chatGptPlanOrgAccount: {
		findFirst: async ({
			where,
		}: {
			where: { id: string; organizationId: string };
		}) => {
			store.reads.push(where);
			return matches(where) ? { ...(store.account as Account) } : null;
		},
		updateMany: async ({
			where,
			data,
		}: {
			where: { id: string; organizationId: string };
			data: Partial<Account>;
		}) => {
			store.writes.push(where);
			if (!matches(where)) {
				return { count: 0 };
			}
			store.account = { ...(store.account as Account), ...data };
			return { count: 1 };
		},
	},
}));

vi.mock("@repo/database/prisma/client", () => ({ db: tx }));

vi.mock("@repo/database/prisma/queries/lib/refresh-lock", () => ({
	chatGptPlanLockKey: (userId: string) => `chatgpt-plan:${userId}`,
	withRefreshLock: async <T>(
		key: string,
		fn: (t: typeof tx, assertBudget: () => void) => Promise<T>,
	): Promise<T> => {
		store.lockKeys.push(key);
		return fn(tx, () => {});
	},
}));

vi.mock("@repo/database", () => ({
	notifyChatGptPlanOrgAccountNeedsReconnect: notifyNeedsReconnect,
	getChatGptPlanOrgAccount: async (params: {
		organizationId: string;
		accountId: string;
	}) =>
		tx.chatGptPlanOrgAccount.findFirst({
			where: {
				id: params.accountId,
				organizationId: params.organizationId,
			},
		}),
}));

import { logger } from "@repo/logs";
import { getChatGptPlanSourceAccessToken } from "../lib/chatgpt-plan/plan-credentials";

const part = (value: unknown) =>
	Buffer.from(JSON.stringify(value)).toString("base64url");
const idTokenWith = (claims: Record<string, unknown>) =>
	`${part({ alg: "RS256" })}.${part({
		email: "owner@example.com",
		"https://api.openai.com/auth": claims,
	})}.sig`;

const NOW = Date.parse("2026-10-07T12:00:00Z");
const ref = {
	kind: "org",
	organizationId: "org_a",
	accountId: "acc_1",
} as const;

function account(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc_1",
		organizationId: "org_a",
		clientId: "oaiapp_1",
		encryptedAccessToken: "encrypted:old-access",
		encryptedRefreshToken: "encrypted:old-refresh",
		accessTokenExpiresAt: new Date(NOW + 30_000),
		earliestRefreshAt: null,
		scopes: ["openid", "chatgpt.tokens.use.direct"],
		status: "ACTIVE",
		...overrides,
	};
}

function tokenResponse(status: number, body: object): typeof fetch {
	return vi.fn<typeof fetch>(
		async () =>
			new Response(JSON.stringify(body), {
				status,
				headers: { "content-type": "application/json" },
			}),
	);
}

beforeEach(() => {
	store.account = account();
	store.lockKeys = [];
	store.reads = [];
	store.writes = [];
	notifyNeedsReconnect.mockClear();
	vi.mocked(logger.info).mockClear();
});

describe("organization account sign-in", () => {
	it("refreshes under the account's own lock and stores the rotated token in its organization", async () => {
		const fetchImpl = tokenResponse(200, {
			access_token: "new-access",
			refresh_token: "new-refresh",
			expires_in: 3600,
			token_type: "Bearer",
		});

		const token = await getChatGptPlanSourceAccessToken(ref, {
			fetchImpl,
			now: () => NOW,
		});
		expect(token.accessToken).toBe("new-access");
		expect(store.lockKeys).toEqual(["chatgpt-plan-org:acc_1"]);
		expect(store.account?.encryptedRefreshToken).toBe(
			"encrypted:new-refresh",
		);
		expect(store.writes).toEqual([
			{ id: "acc_1", organizationId: "org_a" },
		]);
	});

	// Fizzy #2770 G7: every refresh reads the subscription claims afresh.
	it("stores the tier and paid-until date the refreshed ID token reports", async () => {
		const part = (value: unknown) =>
			Buffer.from(JSON.stringify(value)).toString("base64url");
		const idToken = `${part({ alg: "RS256" })}.${part({
			"https://api.openai.com/auth": {
				chatgpt_plan_type: "pro",
				chatgpt_subscription_active_until: "2026-11-08T00:00:00Z",
			},
		})}.sig`;
		const fetchImpl = tokenResponse(200, {
			access_token: "new-access",
			refresh_token: "new-refresh",
			id_token: idToken,
			expires_in: 3600,
			token_type: "Bearer",
		});

		await getChatGptPlanSourceAccessToken(ref, {
			fetchImpl,
			now: () => NOW,
		});
		expect(store.account).toMatchObject({
			tier: "PRO",
			subscriptionActiveUntil: new Date("2026-11-08T00:00:00Z"),
		});
	});

	it("keeps an admin-set tier and a known date through a token that does not say", async () => {
		store.account = {
			...account(),
			tier: "TEAM",
			subscriptionActiveUntil: new Date("2026-12-01T00:00:00Z"),
		} as typeof store.account;
		const part = (value: unknown) =>
			Buffer.from(JSON.stringify(value)).toString("base64url");
		const fetchImpl = tokenResponse(200, {
			access_token: "new-access",
			refresh_token: "new-refresh",
			id_token: `${part({ alg: "RS256" })}.${part({
				"https://api.openai.com/auth": { chatgpt_plan_type: "mystery" },
			})}.sig`,
			expires_in: 3600,
			token_type: "Bearer",
		});
		await getChatGptPlanSourceAccessToken(ref, {
			fetchImpl,
			now: () => NOW,
		});
		expect(store.account).toMatchObject({
			tier: "TEAM",
			subscriptionActiveUntil: new Date("2026-12-01T00:00:00Z"),
		});
	});

	it("leaves the tier alone when the refresh brings no ID token", async () => {
		store.account = { ...account(), tier: "PLUS" } as typeof store.account;
		const fetchImpl = tokenResponse(200, {
			access_token: "new-access",
			refresh_token: "new-refresh",
			expires_in: 3600,
			token_type: "Bearer",
		});
		await getChatGptPlanSourceAccessToken(ref, {
			fetchImpl,
			now: () => NOW,
		});
		expect(store.account).toMatchObject({ tier: "PLUS" });
	});

	// Fizzy #2770 G7: OpenAI's refresh response need not carry an ID token;
	// the one stored at sign-in still says what the plan is.
	describe("a refresh whose response does not say the plan", () => {
		const noIdToken = () =>
			tokenResponse(200, {
				access_token: "new-access",
				refresh_token: "new-refresh",
				expires_in: 3600,
				token_type: "Bearer",
			});

		it("fills an unknown tier and paid-until date from the stored ID token", async () => {
			store.account = account({
				tier: "UNKNOWN",
				subscriptionActiveUntil: null,
				encryptedIdToken: `encrypted:${idTokenWith({
					chatgpt_plan_type: "plus",
					chatgpt_subscription_active_until: "2026-11-08T00:00:00Z",
				})}`,
			});
			await getChatGptPlanSourceAccessToken(ref, {
				fetchImpl: noIdToken(),
				now: () => NOW,
			});
			expect(store.account).toMatchObject({
				tier: "PLUS",
				subscriptionActiveUntil: new Date("2026-11-08T00:00:00Z"),
			});
		});

		it("keeps a known tier and fills only the missing date", async () => {
			store.account = account({
				tier: "TEAM",
				subscriptionActiveUntil: null,
				encryptedIdToken: `encrypted:${idTokenWith({
					chatgpt_plan_type: "plus",
					chatgpt_subscription_active_until: "2026-11-08T00:00:00Z",
				})}`,
			});
			await getChatGptPlanSourceAccessToken(ref, {
				fetchImpl: noIdToken(),
				now: () => NOW,
			});
			expect(store.account).toMatchObject({
				tier: "TEAM",
				subscriptionActiveUntil: new Date("2026-11-08T00:00:00Z"),
			});
		});

		it("fills from the stored token when the new ID token has no claims", async () => {
			store.account = account({
				tier: "UNKNOWN",
				subscriptionActiveUntil: null,
				encryptedIdToken: `encrypted:${idTokenWith({
					chatgpt_plan_type: "plus",
				})}`,
			});
			await getChatGptPlanSourceAccessToken(ref, {
				fetchImpl: tokenResponse(200, {
					access_token: "new-access",
					id_token: `${part({ alg: "RS256" })}.${part({ sub: "x" })}.sig`,
					expires_in: 3600,
					token_type: "Bearer",
				}),
				now: () => NOW,
			});
			expect(store.account?.tier).toBe("PLUS");
		});

		it("stays UNKNOWN, and still refreshes, when the stored token has no claims", async () => {
			store.account = account({
				tier: "UNKNOWN",
				subscriptionActiveUntil: null,
				encryptedIdToken: `encrypted:${part({ alg: "RS256" })}.${part({ sub: "x" })}.sig`,
			});
			const token = await getChatGptPlanSourceAccessToken(ref, {
				fetchImpl: noIdToken(),
				now: () => NOW,
			});
			expect(token.accessToken).toBe("new-access");
			expect(store.account).toMatchObject({
				tier: "UNKNOWN",
				subscriptionActiveUntil: null,
			});
		});

		it("still refreshes when the stored token cannot be decrypted", async () => {
			store.account = account({
				tier: "UNKNOWN",
				subscriptionActiveUntil: null,
				encryptedIdToken: "not-a-ciphertext",
			});
			const token = await getChatGptPlanSourceAccessToken(ref, {
				fetchImpl: noIdToken(),
				now: () => NOW,
			});
			expect(token.accessToken).toBe("new-access");
			expect(store.account?.tier).toBe("UNKNOWN");
		});
	});

	it("logs what the refreshed ID token held, never a token or an address", async () => {
		const idToken = idTokenWith({
			chatgpt_plan_type: "plus",
			chatgpt_subscription_active_until: "2026-11-08T00:00:00Z",
		});
		await getChatGptPlanSourceAccessToken(ref, {
			fetchImpl: tokenResponse(200, {
				access_token: "new-access",
				refresh_token: "new-refresh",
				id_token: idToken,
				expires_in: 3600,
				token_type: "Bearer",
			}),
			now: () => NOW,
		});
		expect(logger.info).toHaveBeenCalledWith(
			"[chatgpt-plan] ID token subscription claims",
			{
				event: "refresh",
				sourceKind: "org",
				organizationId: "org_a",
				planAccountId: "acc_1",
				idTokenPresent: true,
				emailPresent: true,
				authClaimPresent: true,
				authClaimKeys: [
					"chatgpt_plan_type",
					"chatgpt_subscription_active_until",
				],
				planTypeValue: "plus",
				untilPresent: true,
			},
		);
		const logged = JSON.stringify(vi.mocked(logger.info).mock.calls);
		for (const secret of [
			idToken,
			idToken.split(".")[1] as string,
			"new-access",
			"new-refresh",
			"old-refresh",
			"owner@example.com",
		]) {
			expect(logged).not.toContain(secret);
		}
	});

	it("logs a refresh that brought no ID token", async () => {
		await getChatGptPlanSourceAccessToken(ref, {
			fetchImpl: tokenResponse(200, {
				access_token: "new-access",
				expires_in: 3600,
				token_type: "Bearer",
			}),
			now: () => NOW,
		});
		expect(logger.info).toHaveBeenCalledWith(
			"[chatgpt-plan] ID token subscription claims",
			expect.objectContaining({
				event: "refresh",
				idTokenPresent: false,
				emailPresent: false,
				authClaimPresent: false,
				authClaimKeys: [],
				planTypeValue: null,
				untilPresent: false,
			}),
		);
	});

	it("finds nothing when asked under another organization", async () => {
		await expect(
			getChatGptPlanSourceAccessToken(
				{ ...ref, organizationId: "org_b" },
				{ now: () => NOW },
			),
		).rejects.toMatchObject({ code: "not_connected" });
	});

	it("marks only this organization's account NEEDS_RECONNECT on invalid_grant", async () => {
		const fetchImpl = tokenResponse(400, { error: "invalid_grant" });

		await expect(
			getChatGptPlanSourceAccessToken(ref, { fetchImpl, now: () => NOW }),
		).rejects.toMatchObject({ reauthRequired: true });
		expect(store.account?.status).toBe("NEEDS_RECONNECT");
		expect(store.writes.at(-1)).toEqual({
			id: "acc_1",
			organizationId: "org_a",
			status: "ACTIVE",
		});
	});

	// Fizzy #2770 D4: the flip itself tells the organization's owners and
	// admins — once, until a new sign-in makes the account ACTIVE again.
	it("tells the organization once per flip to NEEDS_RECONNECT", async () => {
		const deps = {
			fetchImpl: tokenResponse(400, { error: "invalid_grant" }),
			now: () => NOW,
		};
		await expect(
			getChatGptPlanSourceAccessToken(ref, deps),
		).rejects.toThrow();
		expect(notifyNeedsReconnect).toHaveBeenCalledTimes(1);
		expect(notifyNeedsReconnect).toHaveBeenCalledWith({
			organizationId: "org_a",
			accountId: "acc_1",
		});

		// Already waiting for a reconnect: a later failure is not announced.
		store.account = account({
			status: "NEEDS_RECONNECT",
			accessTokenExpiresAt: new Date(NOW - 1000),
		});
		await expect(
			getChatGptPlanSourceAccessToken(ref, deps),
		).rejects.toThrow();
		expect(notifyNeedsReconnect).toHaveBeenCalledTimes(1);

		// Reconnected (ACTIVE again), then signed out again: a fresh flip.
		store.account = account({ accessTokenExpiresAt: new Date(NOW - 1000) });
		await expect(
			getChatGptPlanSourceAccessToken(ref, deps),
		).rejects.toThrow();
		expect(notifyNeedsReconnect).toHaveBeenCalledTimes(2);
	});
});
