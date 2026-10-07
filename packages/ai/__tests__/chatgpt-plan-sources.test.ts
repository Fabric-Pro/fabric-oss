/**
 * Plan sources and the shared breaker (Fizzy #2770): a member's own plan
 * keeps its phase-1 lock key, an organization account gets its own, a spent
 * window recorded by one process is seen by another through Postgres, and an
 * organization account with no reset time trusts the ledger once, then backs
 * off from 30 minutes up to a whole five-hour window.
 */

import { SubscriptionPlanExhaustedError } from "@repo/agent-types/chatgpt-plan-fetch";
import { beforeEach, describe, expect, it, vi } from "vitest";

type StateRow = {
	sourceKind: "USER" | "ORG";
	sourceId: string;
	openUntil: Date | null;
	resetAt: Date | null;
	consecutiveUnknownResets: number;
};

const db = vi.hoisted(() => ({
	rows: new Map<string, StateRow>(),
	failReads: false,
	firstUse: null as Date | null,
	firstUseCalls: [] as unknown[],
}));

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@repo/database/prisma/queries/lib/refresh-lock", () => ({
	chatGptPlanLockKey: (userId: string) => `chatgpt-plan:${userId}`,
}));

vi.mock("@repo/database", () => ({
	getChatGptPlanSourceStates: async (kind: string, ids: string[]) => {
		if (db.failReads) {
			throw new Error("database down");
		}
		return ids
			.map((id) => db.rows.get(`${kind}:${id}`))
			.filter((row) => row !== undefined);
	},
	recordChatGptPlanSourceExhausted: async (input: StateRow) => {
		db.rows.set(`${input.sourceKind}:${input.sourceId}`, input);
	},
	clearChatGptPlanSourceState: async (key: {
		sourceKind: string;
		sourceId: string;
	}) => {
		db.rows.delete(`${key.sourceKind}:${key.sourceId}`);
	},
	getChatGptPlanOrgAccountFirstUseSince: async (params: unknown) => {
		db.firstUseCalls.push(params);
		return db.firstUse;
	},
}));

import {
	__resetChatGptPlanBreaker,
	chatGptPlanExhaustedError,
	chatGptPlanSourceExhaustedError,
	noteChatGptPlanSourceAnswered,
	recordChatGptPlanSourceExhausted,
} from "../lib/chatgpt-plan/exhaustion-breaker";
import {
	chatGptPlanSourceLockKey,
	type PlanSourceRef,
	planSourceKey,
} from "../lib/chatgpt-plan/sources";

const NOW = Date.parse("2026-10-07T12:00:00Z");
const MINUTE = 60_000;
const user: PlanSourceRef = { kind: "user", userId: "user_1" };
const account: PlanSourceRef = {
	kind: "org",
	organizationId: "org_a",
	accountId: "acc_1",
};
const spent = (resetAt: Date | null = null) =>
	new SubscriptionPlanExhaustedError("limit", resetAt);

beforeEach(() => {
	__resetChatGptPlanBreaker();
	db.rows.clear();
	db.failReads = false;
	db.firstUse = null;
	db.firstUseCalls = [];
});

describe("plan source keys", () => {
	it("keeps a member's own plan on the phase-1 lock key, byte for byte", () => {
		expect(chatGptPlanSourceLockKey(user)).toBe("chatgpt-plan:user_1");
	});

	it("gives an organization account a lock key no user id can collide with", () => {
		expect(chatGptPlanSourceLockKey(account)).toBe(
			"chatgpt-plan-org:acc_1",
		);
		expect(planSourceKey(account)).toBe("org:acc_1");
		expect(planSourceKey(user)).toBe("user:user_1");
	});
});

describe("shared breaker", () => {
	it("is seen by another process after this one's cache is gone", async () => {
		const resetAt = new Date(NOW + 60 * MINUTE);
		await recordChatGptPlanSourceExhausted(account, spent(resetAt), NOW);
		__resetChatGptPlanBreaker();

		const open = await chatGptPlanSourceExhaustedError(
			account,
			NOW + MINUTE,
		);
		expect(open).toBeInstanceOf(SubscriptionPlanExhaustedError);
		expect(open?.resetAt?.toISOString()).toBe(resetAt.toISOString());
		await expect(
			chatGptPlanSourceExhaustedError(account, resetAt.getTime() + 1),
		).resolves.toBeNull();
	});

	it("reads as not spent when the database cannot be read", async () => {
		db.failReads = true;
		await expect(
			chatGptPlanSourceExhaustedError(account, NOW),
		).resolves.toBeNull();
	});

	it("keeps a member's own plan closed for 15 minutes without a reset time", async () => {
		await recordChatGptPlanSourceExhausted(user, spent(), NOW);
		expect(
			chatGptPlanExhaustedError("user_1", NOW + 14 * MINUTE),
		).not.toBeNull();
		expect(
			chatGptPlanExhaustedError("user_1", NOW + 15 * MINUTE),
		).toBeNull();
		expect(db.firstUseCalls).toEqual([]);
	});

	it("estimates an organization account's reset from its oldest call in the window", async () => {
		db.firstUse = new Date(NOW - 4 * 60 * MINUTE);
		await recordChatGptPlanSourceExhausted(account, spent(), NOW);

		const row = db.rows.get("ORG:acc_1");
		expect(row?.openUntil?.getTime()).toBe(NOW + 60 * MINUTE);
		expect(row?.resetAt?.getTime()).toBe(NOW + 60 * MINUTE);
		expect(db.firstUseCalls[0]).toEqual({
			organizationId: "org_a",
			accountId: "acc_1",
			since: new Date(NOW - 5 * 60 * MINUTE),
		});
	});

	it("backs off 30m, 1h, 2h, 4h, then caps at 5h after refusals in a row", async () => {
		const pauses: number[] = [];
		let now = NOW;
		for (let refusal = 0; refusal < 6; refusal++) {
			await recordChatGptPlanSourceExhausted(account, spent(), now);
			const openUntil =
				db.rows.get("ORG:acc_1")?.openUntil?.getTime() ?? 0;
			pauses.push((openUntil - now) / MINUTE);
			now = openUntil;
		}
		expect(pauses).toEqual([30, 60, 120, 240, 300, 300]);
	});

	it("trusts the ledger only for the first refusal in a row", async () => {
		db.firstUse = new Date(NOW - 4 * 60 * MINUTE);
		await recordChatGptPlanSourceExhausted(account, spent(), NOW);
		await recordChatGptPlanSourceExhausted(
			account,
			spent(),
			NOW + 60 * MINUTE,
		);
		const row = db.rows.get("ORG:acc_1");
		expect(row?.consecutiveUnknownResets).toBe(2);
		expect(row?.openUntil?.getTime()).toBe(NOW + 120 * MINUTE);
	});

	it("starts over from the shortest pause once the source answers again", async () => {
		await recordChatGptPlanSourceExhausted(account, spent(), NOW);
		await noteChatGptPlanSourceAnswered(account);
		expect(db.rows.has("ORG:acc_1")).toBe(false);

		await recordChatGptPlanSourceExhausted(account, spent(), NOW);
		expect(db.rows.get("ORG:acc_1")?.consecutiveUnknownResets).toBe(1);
	});

	it("resets the refusal count when OpenAI names the reset", async () => {
		await recordChatGptPlanSourceExhausted(account, spent(), NOW);
		await recordChatGptPlanSourceExhausted(
			account,
			spent(new Date(NOW + 90 * MINUTE)),
			NOW,
		);
		expect(db.rows.get("ORG:acc_1")?.consecutiveUnknownResets).toBe(0);
	});
});
