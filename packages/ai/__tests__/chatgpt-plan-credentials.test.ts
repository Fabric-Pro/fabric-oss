/**
 * ChatGPT plan credential service (Fizzy #2939): the refresh decision, one
 * refresh for concurrent callers (the second re-reads under the lock and
 * finds the rotated token), invalid_grant → NEEDS_RECONNECT, and
 * disconnect = revoke + delete.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = {
	userId: string;
	clientId: string;
	encryptedAccessToken: string;
	encryptedRefreshToken: string;
	encryptedIdToken: string | null;
	accessTokenExpiresAt: Date;
	earliestRefreshAt: Date | null;
	scopes: string[];
	status: "ACTIVE" | "NEEDS_RECONNECT";
};

const store = vi.hoisted(() => ({ row: null as Row | null }));

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

const tx = vi.hoisted(() => ({
	chatGptPlanCredential: {
		findUnique: async () => (store.row ? { ...store.row } : null),
		update: async ({ data }: { data: Partial<Row> }) => {
			store.row = { ...(store.row as Row), ...data };
			return { ...store.row };
		},
		updateMany: async ({ data }: { data: Partial<Row> }) => {
			if (store.row) {
				store.row = { ...store.row, ...data };
			}
			return { count: store.row ? 1 : 0 };
		},
	},
}));

vi.mock("@repo/database/prisma/client", () => ({ db: tx }));

vi.mock("@repo/database/prisma/queries/lib/refresh-lock", () => {
	// A real per-key mutex, so a second caller waits for the first and then
	// re-reads, exactly the ordering the advisory lock gives across processes.
	const tails = new Map<string, Promise<unknown>>();
	return {
		chatGptPlanLockKey: (userId: string) => `chatgpt-plan:${userId}`,
		withRefreshLock: async <T>(
			key: string,
			fn: (t: typeof tx, assertBudget: () => void) => Promise<T>,
		): Promise<T> => {
			const previous = tails.get(key) ?? Promise.resolve();
			const run = previous.then(() => fn(tx, () => {}));
			tails.set(
				key,
				run.catch(() => {}),
			);
			return run;
		},
	};
});

const deleteSpy = vi.hoisted(() => vi.fn());

vi.mock("@repo/database", () => ({
	getChatGptPlanCredential: async () => (store.row ? { ...store.row } : null),
	upsertChatGptPlanCredential: vi.fn(),
	deleteChatGptPlanCredential: async (userId: string) => {
		deleteSpy(userId);
		const had = store.row !== null;
		store.row = null;
		return had;
	},
}));

import { upsertChatGptPlanCredential } from "@repo/database";
import {
	chatGptPlanNeedsRefresh,
	disconnectChatGptPlan,
	getChatGptPlanAccessToken,
	refreshChatGptPlanAfterUnauthorized,
	storeChatGptPlanCredential,
} from "../lib/chatgpt-plan/plan-credentials";

const NOW = Date.parse("2026-10-06T12:00:00Z");

function row(overrides: Partial<Row> = {}): Row {
	return {
		userId: "user_1",
		clientId: "oaiapp_1",
		encryptedAccessToken: "encrypted:old-access",
		encryptedRefreshToken: "encrypted:old-refresh",
		encryptedIdToken: null,
		accessTokenExpiresAt: new Date(NOW + 30_000),
		earliestRefreshAt: null,
		scopes: ["openid", "chatgpt.tokens.use.direct"],
		status: "ACTIVE",
		...overrides,
	};
}

function tokenResponse(): Response {
	return new Response(
		JSON.stringify({
			access_token: "new-access",
			refresh_token: "new-refresh",
			token_type: "Bearer",
			expires_in: 3600,
		}),
		{ status: 200 },
	);
}

beforeEach(() => {
	store.row = null;
	deleteSpy.mockClear();
});

describe("chatGptPlanNeedsRefresh", () => {
	it("keeps a token with plenty of life", () => {
		expect(
			chatGptPlanNeedsRefresh(
				{
					accessTokenExpiresAt: new Date(NOW + 30 * 60_000),
					earliestRefreshAt: null,
				},
				NOW,
			),
		).toBe(false);
	});

	it("waits for earliest_refresh_at inside the five-minute margin", () => {
		expect(
			chatGptPlanNeedsRefresh(
				{
					accessTokenExpiresAt: new Date(NOW + 4 * 60_000),
					earliestRefreshAt: new Date(NOW + 60_000),
				},
				NOW,
			),
		).toBe(false);
	});

	it("refreshes inside the margin once earliest_refresh_at has passed", () => {
		expect(
			chatGptPlanNeedsRefresh(
				{
					accessTokenExpiresAt: new Date(NOW + 4 * 60_000),
					earliestRefreshAt: new Date(NOW - 1),
				},
				NOW,
			),
		).toBe(true);
	});

	it("ignores earliest_refresh_at when the token is about to lapse", () => {
		expect(
			chatGptPlanNeedsRefresh(
				{
					accessTokenExpiresAt: new Date(NOW + 30_000),
					earliestRefreshAt: new Date(NOW + 10 * 60_000),
				},
				NOW,
			),
		).toBe(true);
	});
});

describe("getChatGptPlanAccessToken", () => {
	it("returns the stored token without a refresh when it is fresh", async () => {
		store.row = row({ accessTokenExpiresAt: new Date(NOW + 60 * 60_000) });
		const fetchImpl = vi.fn<typeof fetch>();
		const token = await getChatGptPlanAccessToken("user_1", {
			fetchImpl,
			now: () => NOW,
		});
		expect(token.accessToken).toBe("old-access");
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("refreshes once when two callers race on an expiring token", async () => {
		store.row = row();
		const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
			const form = new URLSearchParams(String(init?.body));
			expect(form.get("refresh_token")).toBe("old-refresh");
			expect(form.get("resource")).toBe("https://api.openai.com/v1");
			await new Promise((resolve) => setTimeout(resolve, 20));
			return tokenResponse();
		});
		const deps = { fetchImpl, now: () => NOW };
		const [first, second] = await Promise.all([
			getChatGptPlanAccessToken("user_1", deps),
			// A different single-flight key, so only the lock and the re-read
			// inside it can stop a second exchange.
			refreshChatGptPlanAfterUnauthorized("user_1", "old-access", deps),
		]);
		expect(first.accessToken).toBe("new-access");
		expect(second.accessToken).toBe("new-access");
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(store.row?.encryptedRefreshToken).toBe("encrypted:new-refresh");
	});

	it("marks the credential NEEDS_RECONNECT on invalid_grant and then fails fast", async () => {
		store.row = row();
		const fetchImpl = vi.fn<typeof fetch>(
			async () =>
				new Response(JSON.stringify({ error: "invalid_grant" }), {
					status: 400,
				}),
		);
		await expect(
			getChatGptPlanAccessToken("user_1", { fetchImpl, now: () => NOW }),
		).rejects.toMatchObject({
			code: "invalid_grant",
			reauthRequired: true,
		});
		expect(store.row?.status).toBe("NEEDS_RECONNECT");

		await expect(
			getChatGptPlanAccessToken("user_1", { fetchImpl, now: () => NOW }),
		).rejects.toMatchObject({ code: "needs_reconnect" });
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("keeps the current token through a transient refresh failure while it is valid", async () => {
		store.row = row();
		const fetchImpl = vi.fn<typeof fetch>(
			async () => new Response("upstream down", { status: 503 }),
		);
		const token = await getChatGptPlanAccessToken("user_1", {
			fetchImpl,
			now: () => NOW,
		});
		expect(token.accessToken).toBe("old-access");
		expect(store.row?.status).toBe("ACTIVE");
	});

	it("refuses a user with no credential", async () => {
		await expect(getChatGptPlanAccessToken("user_1")).rejects.toMatchObject(
			{
				code: "not_connected",
			},
		);
	});
});

describe("disconnectChatGptPlan", () => {
	it("revokes the refresh token and deletes the row", async () => {
		store.row = row();
		const fetchImpl = vi.fn<typeof fetch>(
			async () => new Response("{}", { status: 200 }),
		);
		await expect(
			disconnectChatGptPlan("user_1", { fetchImpl }),
		).resolves.toBe(true);
		const [url, init] = fetchImpl.mock.calls[0] ?? [];
		expect(String(url)).toBe(
			"https://auth.openai.com/api/accounts/oauth/revoke",
		);
		expect(new URLSearchParams(String(init?.body)).get("token")).toBe(
			"old-refresh",
		);
		expect(deleteSpy).toHaveBeenCalledWith("user_1");
		expect(store.row).toBeNull();
	});

	it("still deletes the row when the revoke fails", async () => {
		store.row = row();
		const fetchImpl = vi.fn<typeof fetch>(
			async () => new Response("{}", { status: 500 }),
		);
		await disconnectChatGptPlan("user_1", { fetchImpl });
		expect(store.row).toBeNull();
	});
});

// Fizzy #2770 G7: the sign-in's subscription claims are stored at connect.
describe("storeChatGptPlanCredential", () => {
	it("stores the tier and paid-until date the ID token reports", async () => {
		const part = (value: unknown) =>
			Buffer.from(JSON.stringify(value)).toString("base64url");
		await storeChatGptPlanCredential({
			userId: "user_1",
			email: "member@example.com",
			subject: "sub-1",
			clientId: "client-1",
			hostId: "host-1",
			scopes: ["openid"],
			tokens: {
				access_token: "access",
				refresh_token: "refresh",
				id_token: `${part({ alg: "RS256" })}.${part({
					"https://api.openai.com/auth": {
						chatgpt_plan_type: "free",
						chatgpt_subscription_active_until: null,
					},
				})}.sig`,
				expires_in: 3600,
				token_type: "Bearer",
			},
		});
		const written = vi.mocked(upsertChatGptPlanCredential).mock
			.calls[0]?.[0] as Record<string, unknown>;
		expect(written.tier).toBe("FREE");
		// The token did not say: nothing written, nothing overwritten.
		expect(written).not.toHaveProperty("subscriptionActiveUntil");
	});

	it("logs what the ID token held, never a token, the subject or an address", async () => {
		const { logger } = await import("@repo/logs");
		vi.mocked(logger.info).mockClear();
		const part = (value: unknown) =>
			Buffer.from(JSON.stringify(value)).toString("base64url");
		const payload = part({
			email: "member@example.com",
			"https://api.openai.com/auth": { chatgpt_plan_type: "plus" },
		});
		await storeChatGptPlanCredential({
			userId: "user_1",
			email: "member@example.com",
			subject: "sub-secret-1",
			clientId: "client-1",
			hostId: "host-1",
			scopes: ["openid"],
			tokens: {
				access_token: "access-secret-1",
				refresh_token: "refresh-secret-1",
				id_token: `${part({ alg: "RS256" })}.${payload}.sig`,
				expires_in: 3600,
				token_type: "Bearer",
			},
		});
		expect(logger.info).toHaveBeenCalledWith(
			"[chatgpt-plan] ID token subscription claims",
			{
				event: "connect",
				sourceKind: "user",
				userId: "user_1",
				idTokenPresent: true,
				emailPresent: true,
				authClaimPresent: true,
				authClaimKeys: ["chatgpt_plan_type"],
				planTypeValue: "plus",
				untilPresent: false,
			},
		);
		const logged = JSON.stringify(vi.mocked(logger.info).mock.calls);
		for (const secret of [
			payload,
			"access-secret-1",
			"refresh-secret-1",
			"sub-secret-1",
			"member@example.com",
		]) {
			expect(logged).not.toContain(secret);
		}
	});
});
