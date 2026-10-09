/**
 * A row that does not know its tier or paid-until date yet takes them from
 * the ID token stored at sign-in (Fizzy #2770 G7): persisted once, never over
 * a value the row already has, and never failing the read that asked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = {
	id: string;
	organizationId?: string;
	userId?: string;
	tier: string;
	subscriptionActiveUntil: Date | null;
	encryptedIdToken: string | null;
};

const store = vi.hoisted(() => ({
	rows: [] as Row[],
	reads: [] as unknown[],
	writes: [] as Array<{ where: unknown; data: unknown }>,
	failReads: false,
	inFlight: 0,
	maxInFlight: 0,
}));

vi.mock("@repo/utils", () => ({
	decryptApiKey: (value: string) => {
		if (!value.startsWith("encrypted:")) {
			throw new Error("bad ciphertext");
		}
		return value.slice("encrypted:".length);
	},
}));

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@repo/database/prisma/queries/lib/refresh-lock", () => ({
	chatGptPlanLockKey: (userId: string) => `chatgpt-plan:${userId}`,
}));

vi.mock("@repo/database/prisma/client", () => {
	const matches = (row: Row, where: Record<string, unknown>) =>
		Object.entries(where).every(
			([key, value]) => (row as Record<string, unknown>)[key] === value,
		);
	const model = {
		findFirst: async ({ where }: { where: Record<string, unknown> }) => {
			store.reads.push(where);
			store.inFlight++;
			store.maxInFlight = Math.max(store.maxInFlight, store.inFlight);
			await new Promise((resolve) => setTimeout(resolve, 0));
			store.inFlight--;
			if (store.failReads) {
				throw new Error("database unavailable");
			}
			const row = store.rows.find((candidate) =>
				matches(candidate, where),
			);
			return row ? { encryptedIdToken: row.encryptedIdToken } : null;
		},
		updateMany: async ({
			where,
			data,
		}: {
			where: Record<string, unknown>;
			data: Partial<Row>;
		}) => {
			store.writes.push({ where, data });
			let count = 0;
			for (const row of store.rows) {
				if (matches(row, where)) {
					Object.assign(row, data);
					count++;
				}
			}
			return { count };
		},
	};
	return {
		db: {
			chatGptPlanOrgAccount: model,
			chatGptPlanCredential: { ...model, findUnique: model.findFirst },
		},
	};
});

import { logger } from "@repo/logs";
import {
	backfillChatGptPlanSubscription,
	backfillChatGptPlanSubscriptions,
	resetChatGptPlanSubscriptionBackfill,
} from "../lib/chatgpt-plan/subscription-backfill";

const part = (value: unknown) =>
	Buffer.from(JSON.stringify(value)).toString("base64url");
const storedToken = (claims?: Record<string, unknown>) =>
	`encrypted:${part({ alg: "RS256" })}.${part({
		email: "owner@example.com",
		...(claims && { "https://api.openai.com/auth": claims }),
	})}.sig`;

const UNTIL = new Date("2026-11-08T00:00:00Z");
const PLUS_TOKEN = storedToken({
	chatgpt_plan_type: "plus",
	chatgpt_subscription_active_until: UNTIL.toISOString(),
});

const orgRef = {
	kind: "org",
	organizationId: "org_a",
	accountId: "acc_1",
} as const;

function orgRow(overrides: Partial<Row> = {}): Row {
	return {
		id: "acc_1",
		organizationId: "org_a",
		tier: "UNKNOWN",
		subscriptionActiveUntil: null,
		encryptedIdToken: PLUS_TOKEN,
		...overrides,
	};
}

const VERSION = new Date("2026-10-08T15:07:00Z");

const publicView = (
	{ tier, subscriptionActiveUntil }: Row,
	updatedAt = VERSION,
) => ({
	id: "acc_1",
	tier: tier as "UNKNOWN",
	subscriptionActiveUntil,
	updatedAt,
});

beforeEach(() => {
	store.rows = [];
	store.reads = [];
	store.writes = [];
	store.failReads = false;
	store.inFlight = 0;
	store.maxInFlight = 0;
	resetChatGptPlanSubscriptionBackfill();
	vi.mocked(logger.info).mockClear();
	vi.mocked(logger.warn).mockClear();
});

describe("backfillChatGptPlanSubscription", () => {
	it("fills an UNKNOWN tier and a missing date from the stored token, and persists them", async () => {
		store.rows = [orgRow()];
		const result = await backfillChatGptPlanSubscription(
			orgRef,
			publicView(orgRow()),
		);
		expect(result).toEqual({
			id: "acc_1",
			tier: "PLUS",
			subscriptionActiveUntil: UNTIL,
			updatedAt: VERSION,
		});
		expect(store.rows[0]).toMatchObject({
			tier: "PLUS",
			subscriptionActiveUntil: UNTIL,
		});
		expect(store.reads).toEqual([{ id: "acc_1", organizationId: "org_a" }]);
		expect(store.writes.map((write) => write.where)).toEqual([
			{ id: "acc_1", organizationId: "org_a", tier: "UNKNOWN" },
			{
				id: "acc_1",
				organizationId: "org_a",
				subscriptionActiveUntil: null,
			},
		]);
	});

	it("leaves a stored token without the claims UNKNOWN, without throwing", async () => {
		store.rows = [orgRow({ encryptedIdToken: storedToken() })];
		const row = publicView(store.rows[0] as Row);
		await expect(
			backfillChatGptPlanSubscription(orgRef, row),
		).resolves.toBe(row);
		expect(store.rows[0]?.tier).toBe("UNKNOWN");
		expect(store.writes).toEqual([]);
	});

	it("queries a row that stays incomplete once per version, not on every read", async () => {
		store.rows = [orgRow({ encryptedIdToken: storedToken() })];
		const row = publicView(store.rows[0] as Row);
		await backfillChatGptPlanSubscription(orgRef, row);
		await backfillChatGptPlanSubscription(orgRef, row);
		await backfillChatGptPlanSubscription(orgRef, { ...row });
		expect(store.reads).toHaveLength(1);
		expect(logger.info).toHaveBeenCalledTimes(1);
	});

	it("does not query again for a Free plan that never has a paid-until date", async () => {
		store.rows = [
			orgRow({
				encryptedIdToken: storedToken({ chatgpt_plan_type: "free" }),
			}),
		];
		await backfillChatGptPlanSubscription(orgRef, publicView(orgRow()));
		const updated = new Date(VERSION.getTime() + 1000);
		const free = {
			...publicView(orgRow(), updated),
			tier: "FREE" as const,
		};
		await backfillChatGptPlanSubscription(orgRef, free);
		await backfillChatGptPlanSubscription(orgRef, free);
		expect(store.reads).toHaveLength(2);
	});

	it("picks up a token stored by a later rotation, which bumps the row's version", async () => {
		store.rows = [orgRow({ encryptedIdToken: storedToken() })];
		await backfillChatGptPlanSubscription(orgRef, publicView(orgRow()));
		store.rows = [orgRow()];
		const rotated = new Date(VERSION.getTime() + 60_000);
		await expect(
			backfillChatGptPlanSubscription(
				orgRef,
				publicView(orgRow(), rotated),
			),
		).resolves.toMatchObject({ tier: "PLUS" });
	});

	it("never overwrites a tier an admin set", async () => {
		store.rows = [orgRow({ tier: "TEAM" })];
		const result = await backfillChatGptPlanSubscription(
			orgRef,
			publicView(store.rows[0] as Row),
		);
		expect(result).toMatchObject({
			tier: "TEAM",
			subscriptionActiveUntil: UNTIL,
		});
		expect(store.rows[0]?.tier).toBe("TEAM");
		expect(store.writes.map((write) => write.data)).toEqual([
			{ subscriptionActiveUntil: UNTIL },
		]);
	});

	it("does not report a value a concurrent write already replaced", async () => {
		store.rows = [orgRow({ tier: "PRO" })];
		const result = await backfillChatGptPlanSubscription(
			orgRef,
			publicView(orgRow()),
		);
		expect(result.tier).toBe("UNKNOWN");
		expect(store.rows[0]?.tier).toBe("PRO");
	});

	it("does not read a row that already knows both", async () => {
		const row = {
			id: "acc_1",
			tier: "PLUS" as const,
			subscriptionActiveUntil: UNTIL,
			updatedAt: VERSION,
		};
		await expect(
			backfillChatGptPlanSubscription(orgRef, row),
		).resolves.toBe(row);
		expect(store.reads).toEqual([]);
	});

	it("reads another organization's account as nothing", async () => {
		store.rows = [orgRow({ organizationId: "org_b" })];
		await backfillChatGptPlanSubscription(orgRef, publicView(orgRow()));
		expect(store.rows[0]?.tier).toBe("UNKNOWN");
		expect(store.writes).toEqual([]);
	});

	it("returns the row as read when the database fails, and retries only after a pause", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			vi.setSystemTime(VERSION);
			store.rows = [orgRow()];
			store.failReads = true;
			const row = publicView(orgRow());
			await expect(
				backfillChatGptPlanSubscription(orgRef, row),
			).resolves.toBe(row);
			expect(logger.warn).toHaveBeenCalledWith(expect.any(String), {
				organizationId: "org_a",
				planAccountId: "acc_1",
			});

			// Still down a minute later: no query, no second warning.
			vi.setSystemTime(VERSION.getTime() + 60_000);
			await backfillChatGptPlanSubscription(orgRef, row);
			expect(store.reads).toHaveLength(1);
			expect(logger.warn).toHaveBeenCalledTimes(1);

			store.failReads = false;
			vi.setSystemTime(VERSION.getTime() + 5 * 60_000 + 1);
			await expect(
				backfillChatGptPlanSubscription(orgRef, row),
			).resolves.toMatchObject({ tier: "PLUS" });
		} finally {
			vi.useRealTimers();
		}
	});

	it("returns the row as read when the stored token cannot be decrypted", async () => {
		store.rows = [orgRow({ encryptedIdToken: "garbage" })];
		const row = publicView(orgRow());
		await expect(
			backfillChatGptPlanSubscription(orgRef, row),
		).resolves.toBe(row);
	});

	it("fills a member's own credential by its user id", async () => {
		store.rows = [
			{
				id: "cred_1",
				userId: "user_1",
				tier: "UNKNOWN",
				subscriptionActiveUntil: null,
				encryptedIdToken: storedToken({ chatgpt_plan_type: "free" }),
			},
		];
		const result = await backfillChatGptPlanSubscription(
			{ kind: "user", userId: "user_1" },
			{
				tier: "UNKNOWN" as const,
				subscriptionActiveUntil: null,
				updatedAt: VERSION,
			},
		);
		expect(result.tier).toBe("FREE");
		expect(store.writes[0]?.where).toEqual({
			userId: "user_1",
			tier: "UNKNOWN",
		});
	});

	it("logs what the stored token held, never the token or an address", async () => {
		store.rows = [orgRow()];
		await backfillChatGptPlanSubscription(orgRef, publicView(orgRow()));
		expect(logger.info).toHaveBeenCalledWith(
			"[chatgpt-plan] ID token subscription claims",
			{
				event: "backfill",
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
		const raw = PLUS_TOKEN.slice("encrypted:".length);
		expect(logged).not.toContain(raw.split(".")[1] as string);
		expect(logged).not.toContain("owner@example.com");
	});
});

describe("backfillChatGptPlanSubscriptions", () => {
	it("fills each row under its own source, in order", async () => {
		store.rows = [
			orgRow(),
			orgRow({
				id: "acc_2",
				encryptedIdToken: storedToken({ chatgpt_plan_type: "pro" }),
			}),
		];
		const result = await backfillChatGptPlanSubscriptions(
			[
				{
					id: "acc_1",
					tier: "UNKNOWN" as const,
					subscriptionActiveUntil: null,
					updatedAt: VERSION,
				},
				{
					id: "acc_2",
					tier: "UNKNOWN" as const,
					subscriptionActiveUntil: null,
					updatedAt: VERSION,
				},
			],
			(row) => ({
				kind: "org",
				organizationId: "org_a",
				accountId: row.id,
			}),
		);
		expect(result.map((row) => row.tier)).toEqual(["PLUS", "PRO"]);
	});

	it("reads at most five rows at a time", async () => {
		store.rows = Array.from({ length: 12 }, (_, i) =>
			orgRow({ id: `acc_${i}` }),
		);
		const result = await backfillChatGptPlanSubscriptions(
			store.rows.map((row) => ({ ...publicView(row), id: row.id })),
			(row) => ({
				kind: "org",
				organizationId: "org_a",
				accountId: row.id,
			}),
		);
		expect(store.maxInFlight).toBe(5);
		expect(result.map((row) => [row.id, row.tier])).toEqual(
			store.rows.map((row) => [row.id, "PLUS"]),
		);
	});
});
