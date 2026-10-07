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
};

const store = vi.hoisted(() => ({
	account: null as Account | null,
	lockKeys: [] as string[],
	reads: [] as unknown[],
	writes: [] as unknown[],
}));

vi.mock("@repo/utils", () => ({
	encryptApiKey: (value: string) => `encrypted:${value}`,
	decryptApiKey: (value: string) => value.slice("encrypted:".length),
}));

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const matches = (where: { id: string; organizationId: string }) =>
	store.account !== null &&
	store.account.id === where.id &&
	store.account.organizationId === where.organizationId;

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

import { getChatGptPlanSourceAccessToken } from "../lib/chatgpt-plan/plan-credentials";

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
		});
	});
});
