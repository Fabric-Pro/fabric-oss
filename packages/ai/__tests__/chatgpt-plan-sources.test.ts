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
	windowResetsAt: null as Date | null,
	windowCalls: [] as unknown[],
	window: {
		windowStart: null as Date | null,
		inputTokens: 0,
		weightedInputTokens: 0,
	},
	answeredWrites: 0,
	observations: [] as unknown[],
	/** The account's budget before a refusal teaches it anything. */
	budget: 2_000_000,
	refusalAccuracy: [] as unknown[],
	/** Postgres answers that the source has another sign-in now. */
	signInReplaced: false,
	failWrites: false,
	/** Holds the next state read until the test lets it finish. */
	holdRead: undefined as Promise<void> | undefined,
	/** Holds the next refusal write before it lands. */
	holdWrite: undefined as Promise<void> | undefined,
	/** Holds the next recovery clear before it lands. */
	holdAnswered: undefined as Promise<void> | undefined,
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
		const found = ids
			.map((id) => db.rows.get(`${kind}:${id}`))
			.filter((row) => row !== undefined);
		if (db.holdRead) {
			const hold = db.holdRead;
			db.holdRead = undefined;
			await hold;
			return found;
		}
		return ids
			.map((id) => db.rows.get(`${kind}:${id}`))
			.filter((row) => row !== undefined);
	},
	recordChatGptPlanSourceExhausted: async (input: StateRow) => {
		if (db.holdWrite) {
			const hold = db.holdWrite;
			db.holdWrite = undefined;
			await hold;
		}
		if (db.failWrites) {
			throw new Error("database down");
		}
		if (db.signInReplaced) {
			return false;
		}
		db.rows.set(`${input.sourceKind}:${input.sourceId}`, input);
		return true;
	},
	markChatGptPlanSourceAnswered: async (key: {
		sourceKind: string;
		sourceId: string;
	}) => {
		if (db.holdAnswered) {
			const hold = db.holdAnswered;
			db.holdAnswered = undefined;
			await hold;
		}
		db.answeredWrites += 1;
		const id = `${key.sourceKind}:${key.sourceId}`;
		const row = db.rows.get(id);
		if (row) {
			db.rows.set(id, {
				...row,
				openUntil: null,
				resetAt: row.consecutiveUnknownResets > 0 ? null : row.resetAt,
				consecutiveUnknownResets: 0,
			});
		}
		return true;
	},
	getChatGptPlanOrgAccountWindows: async (params: {
		accountIds: string[];
	}) => {
		db.windowCalls.push(params);
		return new Map(
			params.accountIds.map((id) => [
				id,
				{ resetsAt: db.windowResetsAt, ...db.window },
			]),
		);
	},
	recordChatGptPlanBudgetObservation: async (input: unknown) => {
		db.observations.push(input);
		return true;
	},
	getChatGptPlanWindowCalibrations: async (_kind: string, ids: string[]) =>
		new Map(
			ids.map((id) => [id, { budget: db.budget, calibrated: false }]),
		),
	recordChatGptPlanRefusalAccuracy: async (input: unknown) => {
		db.refusalAccuracy.push(input);
	},
	chatGptPlanReportedUsage: () => null,
}));

import {
	__resetChatGptPlanBreaker,
	chatGptPlanExhaustedError,
	chatGptPlanSourceExhaustedError,
	invalidateChatGptPlanSourceExhaustion,
	noteChatGptPlanSourceAnswered,
	recordChatGptPlanSourceExhausted,
	recordReportedChatGptPlanSourceExhausted,
} from "../lib/chatgpt-plan/exhaustion-breaker";
import {
	exchangedPlanSourceKey,
	parseExchangedPlanSource,
} from "../lib/chatgpt-plan/plan-source-key";
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
// The sign-in whose call each refusal or recovery describes.
const SIGN_IN = "0123456789abcdef";
const spent = (resetAt: Date | null = null) =>
	new SubscriptionPlanExhaustedError("limit", resetAt);

beforeEach(() => {
	__resetChatGptPlanBreaker();
	db.rows.clear();
	db.failReads = false;
	db.windowResetsAt = null;
	db.windowCalls = [];
	db.window = { windowStart: null, inputTokens: 0, weightedInputTokens: 0 };
	db.answeredWrites = 0;
	db.observations = [];
	db.budget = 2_000_000;
	db.refusalAccuracy = [];
	db.signInReplaced = false;
	db.failWrites = false;
	db.holdRead = undefined;
	db.holdWrite = undefined;
	db.holdAnswered = undefined;
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

	it("hands an agent the source's key with the sign-in's fingerprint, and reads both back (Fizzy #3037)", () => {
		const handed = exchangedPlanSourceKey(
			planSourceKey(account),
			"0123456789abcdef",
		);
		expect(handed).toBe("org:acc_1.0123456789abcdef");
		expect(parseExchangedPlanSource(handed)).toEqual({
			kind: "org",
			id: "acc_1",
			key: "org:acc_1",
			credentialFingerprint: "0123456789abcdef",
		});
		expect(parseExchangedPlanSource("user:user_1")).toEqual({
			kind: "user",
			id: "user_1",
			key: "user:user_1",
			credentialFingerprint: null,
		});
		for (const malformed of [
			"user:user_1.",
			"user:user_1.0123",
			"user:user_1.0123456789ABCDEF",
			"user:a.b.0123456789abcdef",
			"api:x",
		]) {
			expect(parseExchangedPlanSource(malformed)).toBeNull();
		}
	});
});

describe("shared breaker", () => {
	it("is seen by another process after this one's cache is gone", async () => {
		const resetAt = new Date(NOW + 60 * MINUTE);
		await recordChatGptPlanSourceExhausted(
			account,
			SIGN_IN,
			spent(resetAt),
			NOW,
		);
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
		await recordChatGptPlanSourceExhausted(user, SIGN_IN, spent(), NOW);
		expect(
			chatGptPlanExhaustedError("user_1", NOW + 14 * MINUTE),
		).not.toBeNull();
		expect(
			chatGptPlanExhaustedError("user_1", NOW + 15 * MINUTE),
		).toBeNull();
		expect(db.windowCalls).toEqual([]);
	});

	it("estimates an organization account's reset from its anchored window", async () => {
		db.windowResetsAt = new Date(NOW + 60 * MINUTE);
		await recordChatGptPlanSourceExhausted(account, SIGN_IN, spent(), NOW);

		const row = db.rows.get("ORG:acc_1");
		expect(row?.openUntil?.getTime()).toBe(NOW + 60 * MINUTE);
		expect(row?.resetAt?.getTime()).toBe(NOW + 60 * MINUTE);
		expect(db.windowCalls[0]).toEqual({
			organizationId: "org_a",
			accountIds: ["acc_1"],
			now: new Date(NOW),
		});
	});

	it("backs off 30m, 1h, 2h, 4h, then caps at 5h after refusals in a row", async () => {
		const pauses: number[] = [];
		let now = NOW;
		for (let refusal = 0; refusal < 6; refusal++) {
			await recordChatGptPlanSourceExhausted(
				account,
				SIGN_IN,
				spent(),
				now,
			);
			const openUntil =
				db.rows.get("ORG:acc_1")?.openUntil?.getTime() ?? 0;
			pauses.push((openUntil - now) / MINUTE);
			now = openUntil;
		}
		expect(pauses).toEqual([30, 60, 120, 240, 300, 300]);
	});

	it("trusts the ledger only for the first refusal in a row", async () => {
		db.windowResetsAt = new Date(NOW + 60 * MINUTE);
		await recordChatGptPlanSourceExhausted(account, SIGN_IN, spent(), NOW);
		await recordChatGptPlanSourceExhausted(
			account,
			SIGN_IN,
			spent(),
			NOW + 60 * MINUTE,
		);
		const row = db.rows.get("ORG:acc_1");
		expect(row?.consecutiveUnknownResets).toBe(2);
		expect(row?.openUntil?.getTime()).toBe(NOW + 120 * MINUTE);
	});

	it("starts over from the shortest pause once the source answers again", async () => {
		await recordChatGptPlanSourceExhausted(account, SIGN_IN, spent(), NOW);
		await noteChatGptPlanSourceAnswered(account, SIGN_IN);
		expect(db.rows.get("ORG:acc_1")?.openUntil).toBeNull();
		await expect(
			chatGptPlanSourceExhaustedError(account, NOW + MINUTE),
		).resolves.toBeNull();

		await recordChatGptPlanSourceExhausted(account, SIGN_IN, spent(), NOW);
		expect(db.rows.get("ORG:acc_1")?.consecutiveUnknownResets).toBe(1);
	});

	it("keeps OpenAI's reset once the source answers again, as the next window's anchor (G9)", async () => {
		const resetAt = new Date(NOW + 90 * MINUTE);
		await recordChatGptPlanSourceExhausted(
			account,
			SIGN_IN,
			spent(resetAt),
			NOW,
		);
		await noteChatGptPlanSourceAnswered(account, SIGN_IN);
		expect(db.rows.get("ORG:acc_1")).toMatchObject({
			openUntil: null,
			resetAt,
		});

		// Fabric's own estimate is no anchor: it goes with the refusal count.
		const other: PlanSourceRef = { ...account, accountId: "acc_2" };
		db.windowResetsAt = new Date(NOW + 60 * MINUTE);
		await recordChatGptPlanSourceExhausted(other, SIGN_IN, spent(), NOW);
		expect(db.rows.get("ORG:acc_2")).toMatchObject({
			resetAt: db.windowResetsAt,
			consecutiveUnknownResets: 1,
		});
		await noteChatGptPlanSourceAnswered(other, SIGN_IN);
		expect(db.rows.get("ORG:acc_2")).toMatchObject({
			openUntil: null,
			resetAt: null,
			consecutiveUnknownResets: 0,
		});
	});

	it("writes nothing for a kept reset once its refusal is cleared", async () => {
		await recordChatGptPlanSourceExhausted(
			account,
			SIGN_IN,
			spent(new Date(NOW + 90 * MINUTE)),
			NOW,
		);
		await noteChatGptPlanSourceAnswered(account, SIGN_IN);
		expect(db.answeredWrites).toBe(1);

		// Another process reads the cleared row: nothing left to clear.
		__resetChatGptPlanBreaker();
		await chatGptPlanSourceExhaustedError(account, NOW + 100 * MINUTE);
		await noteChatGptPlanSourceAnswered(account, SIGN_IN);
		expect(db.answeredWrites).toBe(1);
	});

	it("resets the refusal count when OpenAI names the reset", async () => {
		await recordChatGptPlanSourceExhausted(account, SIGN_IN, spent(), NOW);
		await recordChatGptPlanSourceExhausted(
			account,
			SIGN_IN,
			spent(new Date(NOW + 90 * MINUTE)),
			NOW,
		);
		expect(db.rows.get("ORG:acc_1")?.consecutiveUnknownResets).toBe(0);
	});
});

// Fizzy #3037: what this process remembers follows what Postgres accepted.
describe("breaker writes bound to a sign-in", () => {
	it("passes the refused call's sign-in to Postgres", async () => {
		await recordChatGptPlanSourceExhausted(account, SIGN_IN, spent(), NOW);
		expect(db.rows.get("ORG:acc_1")).toMatchObject({
			credentialFingerprint: SIGN_IN,
		});
	});

	it("keeps no closed state for a refusal Postgres dropped as another sign-in's", async () => {
		db.signInReplaced = true;
		db.window = {
			windowStart: new Date(NOW - 60 * MINUTE),
			inputTokens: 900_000,
			weightedInputTokens: 900_000,
		};
		await recordChatGptPlanSourceExhausted(account, SIGN_IN, spent(), NOW);
		await recordChatGptPlanSourceExhausted(user, SIGN_IN, spent(), NOW);
		expect(chatGptPlanExhaustedError("user_1", NOW)).toBeNull();
		await expect(
			chatGptPlanSourceExhaustedError(account, NOW),
		).resolves.toBeNull();
		expect(db.observations).toEqual([]);
	});

	it("records nothing for a call whose sign-in is unknown", async () => {
		await recordChatGptPlanSourceExhausted(user, undefined, spent(), NOW);
		expect(db.rows.size).toBe(0);
		expect(chatGptPlanExhaustedError("user_1", NOW)).toBeNull();
	});

	it("does not close the source here when Postgres could not check the sign-in", async () => {
		db.failWrites = true;
		await recordChatGptPlanSourceExhausted(user, SIGN_IN, spent(), NOW);
		expect(chatGptPlanExhaustedError("user_1", NOW)).toBeNull();
	});

	it("does not cache a refusal from the replaced sign-in when Postgres fails after the replacement", async () => {
		// The call read sign-in A's token; B replaced it and this process
		// invalidated; then A's refusal arrives and its write fails.
		invalidateChatGptPlanSourceExhaustion(user);
		db.failWrites = true;
		await recordChatGptPlanSourceExhausted(user, SIGN_IN, spent(), NOW);
		expect(chatGptPlanExhaustedError("user_1", NOW)).toBeNull();
		await expect(
			chatGptPlanSourceExhaustedError(user, NOW),
		).resolves.toBeNull();
	});

	it("does not cache a state read that began before the source's sign-in changed", async () => {
		db.rows.set("USER:user_1", {
			sourceKind: "USER",
			sourceId: "user_1",
			openUntil: new Date(NOW + 60 * MINUTE),
			resetAt: null,
			consecutiveUnknownResets: 1,
		});
		let finish!: () => void;
		db.holdRead = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const reading = chatGptPlanSourceExhaustedError(user, NOW);
		await new Promise((resolve) => setTimeout(resolve, 0));
		// The replacement cleared the row, then this process invalidated.
		db.rows.clear();
		invalidateChatGptPlanSourceExhaustion(user);
		finish();
		// The earlier read still answers its own caller.
		await expect(reading).resolves.toBeInstanceOf(
			SubscriptionPlanExhaustedError,
		);
		await expect(
			chatGptPlanSourceExhaustedError(user, NOW + 1),
		).resolves.toBeNull();
	});

	// A read that began before a write of this module's own landed must not
	// cache what it saw before the write.
	const held = () => {
		let release!: () => void;
		const promise = new Promise<void>((resolve) => {
			release = resolve;
		});
		return { promise, release };
	};
	const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

	it("does not cache a spent window read before the recovery's clear landed", async () => {
		await recordChatGptPlanSourceExhausted(user, SIGN_IN, spent(), NOW);
		const clear = held();
		db.holdAnswered = clear.promise;
		const answering = noteChatGptPlanSourceAnswered(user, SIGN_IN);
		await tick();
		// Starts after the recovery dropped the cache, sees the spent row.
		const read = held();
		db.holdRead = read.promise;
		const reading = chatGptPlanSourceExhaustedError(user, NOW);
		await tick();
		clear.release();
		await answering;
		read.release();
		await reading;
		await expect(
			chatGptPlanSourceExhaustedError(user, NOW + 1),
		).resolves.toBeNull();
	});

	it("does not cache an open window read before a refusal's write landed", async () => {
		const write = held();
		db.holdWrite = write.promise;
		const recording = recordChatGptPlanSourceExhausted(
			user,
			SIGN_IN,
			spent(),
			NOW,
		);
		await tick();
		// Another call's recovery changed this process's view meanwhile.
		invalidateChatGptPlanSourceExhaustion(user);
		const read = held();
		db.holdRead = read.promise;
		const reading = chatGptPlanSourceExhaustedError(user, NOW);
		await tick();
		write.release();
		await recording;
		read.release();
		await expect(reading).resolves.toBeNull();
		await expect(
			chatGptPlanSourceExhaustedError(user, NOW + 1),
		).resolves.toBeInstanceOf(SubscriptionPlanExhaustedError);
	});

	// A read that finished, and cached, before a write landed is retired by
	// the write's generation bump: an entry counts only under the generation
	// it was stored under.
	it("does not keep a spent window cached by a read that finished before the recovery's clear landed", async () => {
		await recordChatGptPlanSourceExhausted(user, SIGN_IN, spent(), NOW);
		const clear = held();
		db.holdAnswered = clear.promise;
		const answering = noteChatGptPlanSourceAnswered(user, SIGN_IN);
		await tick();
		// Runs to completion while the clear is still pending: caches spent.
		await expect(
			chatGptPlanSourceExhaustedError(user, NOW),
		).resolves.toBeInstanceOf(SubscriptionPlanExhaustedError);
		clear.release();
		await answering;
		await expect(
			chatGptPlanSourceExhaustedError(user, NOW + 1),
		).resolves.toBeNull();
		expect(chatGptPlanExhaustedError("user_1", NOW + 1)).toBeNull();
	});

	it("does not keep an open window cached by a read that finished before a refusal's write landed", async () => {
		const write = held();
		db.holdWrite = write.promise;
		const recording = recordChatGptPlanSourceExhausted(
			user,
			SIGN_IN,
			spent(),
			NOW,
		);
		await tick();
		// Another call's recovery changed this process's view meanwhile.
		invalidateChatGptPlanSourceExhaustion(user);
		// Runs to completion while the write is still pending: caches open.
		await expect(
			chatGptPlanSourceExhaustedError(user, NOW),
		).resolves.toBeNull();
		write.release();
		await recording;
		// The refusal is not cached (the source changed while it was
		// recorded); the next check reads it back from Postgres.
		await expect(
			chatGptPlanSourceExhaustedError(user, NOW + 1),
		).resolves.toBeInstanceOf(SubscriptionPlanExhaustedError);
	});
});

describe("window budget calibration (Fizzy #2770 D6)", () => {
	it("records what a shared account's open window had used when it was refused", async () => {
		const windowStart = new Date(NOW - 3 * 60 * MINUTE);
		// Astra-heavy: the budget's unit is the weighted figure (G8).
		db.window = {
			windowStart,
			inputTokens: 1_150_000,
			weightedInputTokens: 2_300_000,
		};

		await recordChatGptPlanSourceExhausted(account, SIGN_IN, spent(), NOW);

		expect(db.observations).toEqual([
			{
				source: account,
				windowStart,
				inputTokens: 2_300_000,
				observedAt: new Date(NOW),
				credentialFingerprint: SIGN_IN,
			},
		]);
	});

	it("records what the estimate said at the refusal, against the budget before it, uncapped", async () => {
		const windowStart = new Date(NOW - 3 * 60 * MINUTE);
		db.window = {
			windowStart,
			inputTokens: 1_250_000,
			weightedInputTokens: 2_500_000,
		};
		await recordChatGptPlanSourceExhausted(account, SIGN_IN, spent(), NOW);
		expect(db.refusalAccuracy).toEqual([
			{
				sourceKind: "ORG",
				sourceId: "acc_1",
				windowStart,
				budget: 2_000_000,
				estimatePercent: 125,
				refusedAt: new Date(NOW),
			},
		]);
	});

	it("warns when OpenAI refuses well below the estimated budget", async () => {
		const { logger } = await import("@repo/logs");
		db.window = {
			windowStart: new Date(NOW - 60 * MINUTE),
			inputTokens: 600_000,
			weightedInputTokens: 600_000,
		};
		await recordChatGptPlanSourceExhausted(account, SIGN_IN, spent(), NOW);
		expect(db.refusalAccuracy).toEqual([
			expect.objectContaining({ estimatePercent: 30 }),
		]);
		expect(logger.warn).toHaveBeenCalledWith(
			"[chatgpt-plan] OpenAI refused a shared account well below its estimated budget",
			expect.objectContaining({ estimatePercent: 30 }),
		);
	});

	it("never observes a member's own plan, which is also used outside Fabric", async () => {
		db.window = {
			windowStart: new Date(NOW - 60 * MINUTE),
			inputTokens: 400_000,
			weightedInputTokens: 400_000,
		};
		await recordChatGptPlanSourceExhausted(user, SIGN_IN, spent(), NOW);
		expect(db.observations).toEqual([]);
	});

	it("learns nothing from a refusal that resets after this window — the weekly cap", async () => {
		const windowStart = new Date(NOW - 3 * 60 * MINUTE);
		db.window = {
			windowStart,
			inputTokens: 150_000,
			weightedInputTokens: 150_000,
		};
		db.windowResetsAt = new Date(windowStart.getTime() + 5 * 60 * MINUTE);

		await recordChatGptPlanSourceExhausted(
			account,
			SIGN_IN,
			spent(new Date(NOW + 4 * 24 * 60 * MINUTE)),
			NOW,
		);
		expect(db.observations).toEqual([]);

		// A reset within ten minutes of the window's own is this window.
		await recordChatGptPlanSourceExhausted(
			account,
			SIGN_IN,
			spent(new Date(db.windowResetsAt.getTime() + 5 * MINUTE)),
			NOW,
		);
		expect(db.observations).toHaveLength(1);
	});

	it("learns nothing from a refusal another service reported", async () => {
		db.window = {
			windowStart: new Date(NOW - 60 * MINUTE),
			inputTokens: 900_000,
			weightedInputTokens: 900_000,
		};
		await recordReportedChatGptPlanSourceExhausted(
			account,
			spent(),
			SIGN_IN,
		);
		expect(db.observations).toEqual([]);
	});

	it("records nothing when Fabric's calls show no open window", async () => {
		await recordChatGptPlanSourceExhausted(account, SIGN_IN, spent(), NOW);
		expect(db.observations).toEqual([]);
	});
});
