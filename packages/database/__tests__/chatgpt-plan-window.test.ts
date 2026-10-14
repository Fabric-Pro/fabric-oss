/**
 * The anchored ChatGPT plan window (Fizzy #2770 F1/F2).
 *
 * OpenAI's Plus window opens with the first request after the previous one
 * ended and resets five hours after that start. The sliding "last five hours"
 * sum it replaces read a burst that had long since reset as a full window.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { findMany, observations } = vi.hoisted(() => ({
	findMany: vi.fn(),
	observations: {
		findMany: vi.fn(async (_args: unknown) => [] as unknown[]),
		createMany: vi.fn(async (_args: unknown) => ({ count: 1 })),
	},
}));

const sourceStates = vi.hoisted(() => ({
	findMany: vi.fn(async (_args: unknown) => [] as unknown[]),
	findUnique: vi.fn(async (_args: unknown) => null as unknown),
}));

const tiers = vi.hoisted(() => ({
	accounts: vi.fn(async (_args: unknown) => [] as unknown[]),
	credential: vi.fn(async (_args: unknown) => null as unknown),
}));

// The shared account's current sign-in, as the observation's fence reads it.
const signIn = vi.hoisted(() => ({
	current: { id: "acc_1", subject: "subject-1" } as {
		id: string;
		subject: string;
	} | null,
}));

vi.mock("../prisma/client", () => {
	const db = {
		aiUsageLog: { findMany },
		chatGptPlanBudgetObservation: observations,
		chatGptPlanOrgAccount: {
			findMany: tiers.accounts,
			findUnique: async () => signIn.current,
		},
		chatGptPlanCredential: { findUnique: tiers.credential },
		chatGptPlanSourceState: sourceStates,
		$executeRaw: async () => 1,
	};
	return {
		db: {
			...db,
			$transaction: async (work: (tx: typeof db) => unknown) => work(db),
		},
	};
});

import {
	CHATGPT_PLAN_DEFAULT_WINDOW_INPUT_TOKENS,
	CHATGPT_PLAN_FREE_WINDOW_INPUT_TOKENS,
	CHATGPT_PLAN_MAX_CALIBRATED_BUDGET,
	CHATGPT_PLAN_MIN_CALIBRATED_BUDGET,
	CHATGPT_PLAN_NO_WINDOW_INPUT_TOKENS,
	type ChatGptPlanWindowCall,
	calibratedChatGptPlanBudget,
	chatGptPlanKnownWindowReset,
	chatGptPlanModelWeight,
	chatGptPlanWindowPercent,
	computeChatGptPlanWindow,
	getChatGptPlanOrgAccountWindows,
	getChatGptPlanUserWindow,
	getChatGptPlanWindowBudget,
	getChatGptPlanWindowBudgets,
	recordChatGptPlanBudgetObservation,
} from "../prisma/queries/chatgpt-plan-window";
import { chatGptPlanCredentialFingerprint } from "../prisma/queries/lib/chatgpt-plan-credential-fence";

const at = (iso: string) => new Date(`2026-10-08T${iso}Z`);

/** A calibration row recorded at a real refusal. */
const refusal = (sourceId: string, inputTokens: number) => ({
	sourceId,
	inputTokens,
	observedAt: new Date("2026-10-11T00:00:00Z"),
	lowerBound: false,
});

function call(
	createdAt: Date,
	overrides: Partial<ChatGptPlanWindowCall> = {},
): ChatGptPlanWindowCall {
	return {
		createdAt,
		inputTokens: 1_000,
		cachedInputTokens: 0,
		outputTokens: 100,
		jobType: null,
		featureKey: null,
		...overrides,
	};
}

/**
 * The shared account's day on staging (2026-10-08): 234 calls between 01:37Z
 * and 03:33Z, 1.12M input tokens of which 267k cached, almost all of it the
 * Teams channel monitor.
 */
function stagingCalls(): ChatGptPlanWindowCall[] {
	const count = 234;
	const first = at("01:37:00").getTime();
	const span = at("03:33:00").getTime() - first;
	const input = 1_120_000;
	const cached = 267_000;
	return Array.from({ length: count }, (_, index) => {
		const last = index === count - 1;
		return call(
			new Date(first + Math.round((span * index) / (count - 1))),
			{
				inputTokens: last
					? input - Math.floor(input / count) * (count - 1)
					: Math.floor(input / count),
				cachedInputTokens: last
					? cached - Math.floor(cached / count) * (count - 1)
					: Math.floor(cached / count),
				jobType: index % 12 === 0 ? null : "teams-channel-monitor",
				featureKey: index % 12 === 0 ? "advisor" : null,
			},
		);
	});
}

describe("computeChatGptPlanWindow — staging, 2026-10-08", () => {
	it("is closed at 07:08Z: the window opened at 01:37 reset at 06:37", () => {
		const window = computeChatGptPlanWindow(stagingCalls(), at("07:08:00"));

		expect(window.windowStart).toBeNull();
		expect(window.resetsAt).toBeNull();
		expect(window.inputTokens).toBe(0);
		expect(
			chatGptPlanWindowPercent(
				window,
				CHATGPT_PLAN_DEFAULT_WINDOW_INPUT_TOKENS,
			),
		).toBe(0);
		expect(window.lastRequestAt).toEqual(at("03:33:00"));

		// What the sliding sum read at the same moment: most of the burst.
		const slidingSince = at("02:08:00").getTime();
		const sliding = stagingCalls()
			.filter((c) => c.createdAt.getTime() >= slidingSince)
			.reduce((sum, c) => sum + c.inputTokens, 0);
		expect(sliding).toBeGreaterThan(700_000);
	});

	it("while open, anchors at the first call and counts uncached input only", () => {
		const window = computeChatGptPlanWindow(stagingCalls(), at("04:00:00"));

		expect(window.windowStart).toEqual(at("01:37:00"));
		expect(window.resetsAt).toEqual(at("06:37:00"));
		expect(window.requests).toBe(234);
		expect(window.inputTokens).toBe(1_120_000 - 267_000);
		expect(window.cachedInputTokens).toBe(267_000);
		expect(
			chatGptPlanWindowPercent(
				window,
				CHATGPT_PLAN_DEFAULT_WINDOW_INPUT_TOKENS,
			),
		).toBe(43);
		expect(window.topConsumers.map((c) => [c.kind, c.key])).toEqual([
			["job", "teams-channel-monitor"],
			["feature", "advisor"],
		]);
		expect(window.topConsumers[0].percent).toBeGreaterThan(90);
	});
});

describe("computeChatGptPlanWindow — chaining", () => {
	it("opens the next window with the first call after the previous reset", () => {
		const calls = [
			call(at("01:00:00"), { inputTokens: 5_000 }),
			call(at("05:30:00"), { inputTokens: 7_000 }),
			// 06:10 is past 01:00 + 5h: this call opens the second window.
			call(at("06:10:00"), { inputTokens: 11_000 }),
			call(at("09:00:00"), { inputTokens: 13_000 }),
		];

		const window = computeChatGptPlanWindow(calls, at("10:00:00"));

		// The sliding reading would have started at 05:30, the oldest call in
		// the last five hours; the real window started at 06:10.
		expect(window.windowStart).toEqual(at("06:10:00"));
		expect(window.resetsAt).toEqual(at("11:10:00"));
		expect(window.requests).toBe(2);
		expect(window.inputTokens).toBe(24_000);
	});

	it("is closed once the latest window has reset, and open with no calls is never reported", () => {
		expect(computeChatGptPlanWindow([], at("10:00:00"))).toMatchObject({
			windowStart: null,
			lastRequestAt: null,
		});
		const closed = computeChatGptPlanWindow(
			[call(at("01:00:00"))],
			at("06:00:00"),
		);
		expect(closed.windowStart).toBeNull();
		expect(closed.lastRequestAt).toEqual(at("01:00:00"));
	});

	it("never counts more cached input than input", () => {
		const window = computeChatGptPlanWindow(
			[
				call(at("01:00:00"), {
					inputTokens: 100,
					cachedInputTokens: 150,
				}),
			],
			at("02:00:00"),
		);
		expect(window.inputTokens).toBe(0);
		expect(window.cachedInputTokens).toBe(100);
	});
});

describe("window queries", () => {
	beforeEach(() => {
		findMany.mockReset();
	});

	it("reads an organization's accounts by providerConfigId over a two-window lookback", async () => {
		findMany.mockResolvedValue([
			{ ...call(at("06:10:00")), providerConfigId: "acc_1" },
		]);
		const now = at("07:00:00");

		const windows = await getChatGptPlanOrgAccountWindows({
			organizationId: "org_a",
			accountIds: ["acc_1", "acc_2"],
			now,
		});

		expect(windows.get("acc_1")?.windowStart).toEqual(at("06:10:00"));
		expect(windows.get("acc_2")?.windowStart).toBeNull();
		expect(findMany.mock.calls[0][0].where).toEqual({
			organizationId: "org_a",
			provider: "OPENAI_CHATGPT_PLAN",
			providerConfigId: { in: ["acc_1", "acc_2"] },
			createdAt: { gte: new Date(now.getTime() - 10 * 60 * 60_000) },
		});
	});

	it("does not query for an empty pool", async () => {
		const windows = await getChatGptPlanOrgAccountWindows({
			organizationId: "org_a",
			accountIds: [],
		});
		expect(windows.size).toBe(0);
		expect(findMany).not.toHaveBeenCalled();
	});

	it("reads a member's own plan as their calls with no shared account", async () => {
		findMany.mockResolvedValue([]);
		const now = at("07:00:00");

		await getChatGptPlanUserWindow({ userId: "user_1", now });

		expect(findMany.mock.calls[0][0].where).toEqual({
			userId: "user_1",
			provider: "OPENAI_CHATGPT_PLAN",
			providerConfigId: null,
			createdAt: { gte: new Date(now.getTime() - 10 * 60 * 60_000) },
		});
	});

	it("budgets a member's own plan at the default, never calibrated", async () => {
		observations.findMany.mockClear();
		await expect(
			getChatGptPlanWindowBudget({ kind: "user", userId: "user_1" }),
		).resolves.toBe(CHATGPT_PLAN_DEFAULT_WINDOW_INPUT_TOKENS);
		expect(observations.findMany).not.toHaveBeenCalled();
	});

	it("totals each member's own uncached input in a shared account's window, background jobs excluded", () => {
		const window = computeChatGptPlanWindow(
			[
				call(at("01:00:00"), { userId: "user_1", inputTokens: 1_000 }),
				call(at("01:10:00"), {
					userId: "user_1",
					inputTokens: 3_000,
					cachedInputTokens: 1_000,
				}),
				call(at("01:20:00"), { userId: "user_2", inputTokens: 500 }),
				call(at("01:30:00"), { inputTokens: 700 }),
				// Background work under a member's id is not their own work.
				call(at("01:40:00"), {
					userId: "user_1",
					inputTokens: 9_000,
					jobType: "teams-channel-monitor",
				}),
			],
			at("02:00:00"),
		);
		expect(window.weightedInputTokensByUser).toEqual({
			user_1: 3_000,
			user_2: 500,
		});
	});
});

describe("calibrated window budget (Fizzy #2770 D6)", () => {
	beforeEach(() => {
		observations.findMany.mockReset();
		observations.createMany.mockClear();
	});

	it("is the median of the latest five refusals, bounded", () => {
		expect(calibratedChatGptPlanBudget([])).toBeNull();
		expect(calibratedChatGptPlanBudget([1_200_000])).toBe(1_200_000);
		expect(
			calibratedChatGptPlanBudget([
				1_000_000, 3_000_000, 1_400_000, 1_200_000, 900_000, 50_000_000,
			]),
		).toBe(1_200_000);
		expect(calibratedChatGptPlanBudget([1_000_000, 2_000_000])).toBe(
			1_500_000,
		);
		expect(calibratedChatGptPlanBudget([10])).toBe(
			CHATGPT_PLAN_MIN_CALIBRATED_BUDGET,
		);
		expect(calibratedChatGptPlanBudget([90_000_000])).toBe(
			CHATGPT_PLAN_MAX_CALIBRATED_BUDGET,
		);
	});

	it("replaces the default only for sources with observations", async () => {
		observations.findMany.mockResolvedValue([
			refusal("acc_1", 1_100_000),
			refusal("acc_1", 1_300_000),
			refusal("acc_1", 1_200_000),
		]);
		const budgets = await getChatGptPlanWindowBudgets("ORG", [
			"acc_1",
			"acc_2",
		]);
		expect(budgets.get("acc_1")).toBe(1_200_000);
		expect(budgets.get("acc_2")).toBe(
			CHATGPT_PLAN_DEFAULT_WINDOW_INPUT_TOKENS,
		);
		expect(observations.findMany.mock.calls[0][0]).toMatchObject({
			where: {
				sourceKind: "ORG",
				sourceId: { in: ["acc_1", "acc_2"] },
				windowStart: { gte: expect.any(Date) },
			},
			orderBy: { observedAt: "desc" },
		});
	});

	const observation = (credentialFingerprint: string) => ({
		source: {
			kind: "org" as const,
			organizationId: "org_a",
			accountId: "acc_1",
		},
		windowStart: at("01:00:00"),
		inputTokens: 1_234_567.4,
		observedAt: at("03:00:00"),
		credentialFingerprint,
	});
	const sameSignIn = () =>
		chatGptPlanCredentialFingerprint({
			id: "acc_1",
			subject: "subject-1",
		});

	it("keeps the first observation of a window", async () => {
		signIn.current = { id: "acc_1", subject: "subject-1" };
		await expect(
			recordChatGptPlanBudgetObservation(observation(sameSignIn())),
		).resolves.toBe(true);
		expect(observations.createMany).toHaveBeenCalledWith({
			data: [
				{
					sourceKind: "ORG",
					sourceId: "acc_1",
					windowStart: at("01:00:00"),
					inputTokens: 1_234_567,
					observedAt: at("03:00:00"),
				},
			],
			skipDuplicates: true,
		});
	});

	// Fizzy #3037: a refusal the previous sign-in met teaches the new one
	// nothing, and nothing is left under a deleted account.
	it.each([
		[
			"reconnected under another subject",
			{ id: "acc_1", subject: "subject-2" },
		],
		["deleted", null],
	])("records nothing once the account was %s", async (_, current) => {
		observations.createMany.mockClear();
		signIn.current = current;
		await expect(
			recordChatGptPlanBudgetObservation(observation(sameSignIn())),
		).resolves.toBe(false);
		expect(observations.createMany).not.toHaveBeenCalled();
	});
});

// Fizzy #2770 G7: the tier the sign-in reports sets the window budget.
describe("window budget by tier", () => {
	beforeEach(() => {
		observations.findMany.mockReset();
		observations.findMany.mockResolvedValue([]);
		tiers.accounts.mockReset();
		tiers.credential.mockReset();
	});

	it("gives Plus and unknown the default, Free a small budget, Pro no five-hour window", async () => {
		tiers.accounts.mockResolvedValue([
			{ id: "acc-plus", tier: "PLUS" },
			{ id: "acc-free", tier: "FREE" },
			{ id: "acc-pro", tier: "PRO" },
			{ id: "acc-team", tier: "TEAM" },
		]);
		const budgets = await getChatGptPlanWindowBudgets("ORG", [
			"acc-plus",
			"acc-free",
			"acc-pro",
			"acc-team",
			"acc-unknown",
		]);
		expect(Object.fromEntries(budgets)).toEqual({
			"acc-plus": CHATGPT_PLAN_DEFAULT_WINDOW_INPUT_TOKENS,
			"acc-free": CHATGPT_PLAN_FREE_WINDOW_INPUT_TOKENS,
			"acc-pro": CHATGPT_PLAN_NO_WINDOW_INPUT_TOKENS,
			"acc-team": CHATGPT_PLAN_DEFAULT_WINDOW_INPUT_TOKENS,
			"acc-unknown": CHATGPT_PLAN_DEFAULT_WINDOW_INPUT_TOKENS,
		});
	});

	it("lets calibration win over the tier, within the tier's sense", async () => {
		tiers.accounts.mockResolvedValue([
			{ id: "acc-plus", tier: "PLUS" },
			{ id: "acc-free", tier: "FREE" },
			{ id: "acc-pro", tier: "PRO" },
		]);
		observations.findMany.mockResolvedValue([
			refusal("acc-plus", 1_400_000),
			refusal("acc-free", 60_000),
			refusal("acc-pro", 300_000),
		]);
		const budgets = await getChatGptPlanWindowBudgets("ORG", [
			"acc-plus",
			"acc-free",
			"acc-pro",
		]);
		expect(budgets.get("acc-plus")).toBe(1_400_000);
		// Free learns within its own allowance: not lifted to the 250k floor.
		expect(budgets.get("acc-free")).toBe(60_000);
		// Pro has no five-hour window to calibrate.
		expect(budgets.get("acc-pro")).toBe(
			CHATGPT_PLAN_NO_WINDOW_INPUT_TOKENS,
		);

		observations.findMany.mockResolvedValue([refusal("acc-free", 900_000)]);
		const capped = await getChatGptPlanWindowBudgets("ORG", ["acc-free"]);
		expect(capped.get("acc-free")).toBe(
			CHATGPT_PLAN_FREE_WINDOW_INPUT_TOKENS,
		);

		// One refusal caused by use outside Fabric cannot collapse it.
		observations.findMany.mockResolvedValue([refusal("acc-free", 1_000)]);
		const floored = await getChatGptPlanWindowBudgets("ORG", ["acc-free"]);
		expect(floored.get("acc-free")).toBe(
			CHATGPT_PLAN_FREE_WINDOW_INPUT_TOKENS / 10,
		);
	});

	it("reads a member's own plan's tier", async () => {
		tiers.credential.mockResolvedValue({ tier: "FREE" });
		await expect(
			getChatGptPlanWindowBudget({ kind: "user", userId: "user_1" }),
		).resolves.toBe(CHATGPT_PLAN_FREE_WINDOW_INPUT_TOKENS);
	});
});

// Fizzy #2770 G8: the budget is in Sol-equivalent tokens, weighted by model.
describe("model-weighted window", () => {
	/** A window's uncached input split across models, one call per model. */
	function mix(
		start: Date,
		uncachedByModel: Record<string, number>,
	): ChatGptPlanWindowCall[] {
		return Object.entries(uncachedByModel).map(([model, tokens], index) =>
			call(new Date(start.getTime() + index * 60_000), {
				inputTokens: tokens,
				providerModelId: model,
			}),
		);
	}

	it("weighs a model by its family: Astra over Sol over Luna, anything else 1", () => {
		expect(chatGptPlanModelWeight("gpt-6-astra")).toBe(2.5);
		expect(chatGptPlanModelWeight("gpt-6.1-sol")).toBe(1);
		expect(chatGptPlanModelWeight("gpt-5.6-sol")).toBe(1);
		expect(chatGptPlanModelWeight("gpt-6-luna")).toBe(0.5);
		expect(chatGptPlanModelWeight("gpt-6-astra-2026-09-30")).toBe(2.5);
		expect(chatGptPlanModelWeight("gpt-7-nova")).toBe(1);
		expect(chatGptPlanModelWeight(null)).toBe(1);
	});

	it("reads the 2026-10-08 Astra-heavy window as ChatGPT did: 86% after 885k uncached", () => {
		const window = computeChatGptPlanWindow(
			mix(at("12:00:00"), {
				"gpt-6-astra": 557_550,
				"gpt-6.1-sol": 327_450,
			}),
			at("14:00:00"),
		);

		expect(window.inputTokens).toBe(885_000);
		expect(
			chatGptPlanWindowPercent(
				window,
				CHATGPT_PLAN_DEFAULT_WINDOW_INPUT_TOKENS,
			),
		).toBe(86);
	});

	it("keeps the Sol-only window that was never refused well short of spent", () => {
		const window = computeChatGptPlanWindow(
			mix(at("01:37:00"), { "gpt-6.1-sol": 853_000 }),
			at("04:00:00"),
		);
		expect(
			chatGptPlanWindowPercent(
				window,
				CHATGPT_PLAN_DEFAULT_WINDOW_INPUT_TOKENS,
			),
		).toBe(43);
	});

	it("weighs each member's fair share by the models they used", () => {
		const window = computeChatGptPlanWindow(
			[
				call(at("01:00:00"), {
					userId: "user_1",
					providerModelId: "gpt-6-astra",
				}),
				call(at("01:10:00"), {
					userId: "user_2",
					providerModelId: "gpt-6-luna",
				}),
			],
			at("02:00:00"),
		);
		expect(window.weightedInputTokensByUser).toEqual({
			user_1: 2_500,
			user_2: 500,
		});
	});

	it("calibrates only from refusals recorded in weighted tokens", async () => {
		observations.findMany.mockClear();
		await getChatGptPlanWindowBudgets("ORG", ["acc_1"]);
		const where = observations.findMany.mock.calls[0][0] as {
			where: { windowStart: { gte: Date } };
		};
		expect(where.where.windowStart.gte.getTime()).toBeGreaterThanOrEqual(
			new Date("2026-10-10T00:00:00Z").getTime(),
		);
	});
});

// Fizzy #2770 G9: a reset OpenAI reported anchors the window chain.
describe("windows anchored on a known reset", () => {
	/** An account used every half hour since 08:00: never a five-hour gap. */
	function continuous(until: Date): ChatGptPlanWindowCall[] {
		const calls: ChatGptPlanWindowCall[] = [];
		for (
			let time = at("08:00:00").getTime();
			time <= until.getTime();
			time += 30 * 60_000
		) {
			calls.push(call(new Date(time)));
		}
		return calls;
	}
	const reset = at("17:50:09");
	const refused = { resetAt: reset, lastExhaustedAt: at("16:48:00") };

	it("chains from the reset instead of drifting with the lookback", () => {
		const now = at("20:45:00");
		const lookback = continuous(now).filter(
			(c) => c.createdAt.getTime() >= now.getTime() - 10 * 60 * 60_000,
		);

		// From the oldest call in the lookback the chain reads 16:00–21:00.
		expect(computeChatGptPlanWindow(lookback, now).resetsAt).toEqual(
			at("21:00:00"),
		);
		const anchored = computeChatGptPlanWindow(lookback, now, reset);
		expect(anchored.windowStart).toEqual(at("18:00:00"));
		expect(anchored.resetsAt).toEqual(at("23:00:00"));
		expect(anchored.requests).toBe(6);
	});

	it("before the reset, is the window the reset closes", () => {
		const now = at("17:00:00");
		const window = computeChatGptPlanWindow(continuous(now), now, reset);
		expect(window.windowStart).toEqual(at("12:50:09"));
		expect(window.resetsAt).toEqual(reset);
		// 13:00 through 17:00.
		expect(window.requests).toBe(9);
	});

	it("trusts only a five-hour reset OpenAI reported, within a day", () => {
		const now = at("20:45:00");
		expect(
			chatGptPlanKnownWindowReset(
				{ ...refused, consecutiveUnknownResets: 0 },
				now,
			),
		).toEqual(reset);
		// Fabric's own estimate.
		expect(
			chatGptPlanKnownWindowReset(
				{ ...refused, consecutiveUnknownResets: 1 },
				now,
			),
		).toBeNull();
		// The weekly limit's reset.
		expect(
			chatGptPlanKnownWindowReset(
				{
					resetAt: new Date(reset.getTime() + 4 * 24 * 60 * 60_000),
					lastExhaustedAt: at("16:48:00"),
					consecutiveUnknownResets: 0,
				},
				now,
			),
		).toBeNull();
		expect(
			chatGptPlanKnownWindowReset(
				{ ...refused, consecutiveUnknownResets: 0 },
				new Date(reset.getTime() + 25 * 60 * 60_000),
			),
		).toBeNull();
		expect(chatGptPlanKnownWindowReset(null, now)).toBeNull();
	});

	it("widens an anchored account's lookback to its reset, and only that account's", async () => {
		const now = new Date(reset.getTime() + 14 * 60 * 60_000);
		sourceStates.findMany.mockResolvedValueOnce([
			{ sourceId: "acc_1", ...refused, consecutiveUnknownResets: 0 },
		]);
		findMany.mockResolvedValueOnce([
			{ ...call(at("18:00:00")), providerConfigId: "acc_1" },
			{ ...call(at("18:00:00")), providerConfigId: "acc_2" },
		]);

		const windows = await getChatGptPlanOrgAccountWindows({
			organizationId: "org_a",
			accountIds: ["acc_1", "acc_2"],
			now,
		});

		expect(sourceStates.findMany.mock.calls.at(-1)?.[0]).toMatchObject({
			where: { sourceKind: "ORG", sourceId: { in: ["acc_1", "acc_2"] } },
		});
		expect(findMany.mock.calls.at(-1)?.[0].where.createdAt).toEqual({
			gte: reset,
		});
		expect(windows.get("acc_1")?.lastRequestAt).toEqual(at("18:00:00"));
		expect(windows.get("acc_2")?.lastRequestAt).toBeNull();
	});

	it("anchors a member's own plan on its own reset", async () => {
		const now = at("17:00:00");
		sourceStates.findUnique.mockResolvedValueOnce({
			...refused,
			consecutiveUnknownResets: 0,
		});
		findMany.mockResolvedValueOnce(continuous(now));

		const window = await getChatGptPlanUserWindow({
			userId: "user_1",
			now,
		});

		expect(sourceStates.findUnique.mock.calls.at(-1)?.[0]).toMatchObject({
			where: {
				sourceKind_sourceId: { sourceKind: "USER", sourceId: "user_1" },
			},
		});
		expect(window.resetsAt).toEqual(reset);
	});
});
