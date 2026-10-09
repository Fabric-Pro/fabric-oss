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

const tiers = vi.hoisted(() => ({
	accounts: vi.fn(async (_args: unknown) => [] as unknown[]),
	credential: vi.fn(async (_args: unknown) => null as unknown),
}));

vi.mock("../prisma/client", () => ({
	db: {
		aiUsageLog: { findMany },
		chatGptPlanBudgetObservation: observations,
		chatGptPlanOrgAccount: { findMany: tiers.accounts },
		chatGptPlanCredential: { findUnique: tiers.credential },
	},
}));

import {
	CHATGPT_PLAN_DEFAULT_WINDOW_INPUT_TOKENS,
	CHATGPT_PLAN_FREE_WINDOW_INPUT_TOKENS,
	CHATGPT_PLAN_MAX_CALIBRATED_BUDGET,
	CHATGPT_PLAN_MIN_CALIBRATED_BUDGET,
	CHATGPT_PLAN_NO_WINDOW_INPUT_TOKENS,
	type ChatGptPlanWindowCall,
	calibratedChatGptPlanBudget,
	chatGptPlanWindowPercent,
	computeChatGptPlanWindow,
	getChatGptPlanOrgAccountWindows,
	getChatGptPlanUserWindow,
	getChatGptPlanWindowBudget,
	getChatGptPlanWindowBudgets,
	recordChatGptPlanBudgetObservation,
} from "../prisma/queries/chatgpt-plan-window";

const at = (iso: string) => new Date(`2026-10-08T${iso}Z`);

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
		expect(window.inputTokensByUser).toEqual({
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
			{ sourceId: "acc_1", inputTokens: 1_100_000 },
			{ sourceId: "acc_1", inputTokens: 1_300_000 },
			{ sourceId: "acc_1", inputTokens: 1_200_000 },
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
			orderBy: { windowStart: "desc" },
		});
	});

	it("keeps the first observation of a window", async () => {
		await recordChatGptPlanBudgetObservation({
			source: {
				kind: "org",
				organizationId: "org_a",
				accountId: "acc_1",
			},
			windowStart: at("01:00:00"),
			inputTokens: 1_234_567.4,
			observedAt: at("03:00:00"),
		});
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
			{ sourceId: "acc-plus", inputTokens: 1_400_000 },
			{ sourceId: "acc-free", inputTokens: 60_000 },
			{ sourceId: "acc-pro", inputTokens: 300_000 },
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

		observations.findMany.mockResolvedValue([
			{ sourceId: "acc-free", inputTokens: 900_000 },
		]);
		const capped = await getChatGptPlanWindowBudgets("ORG", ["acc-free"]);
		expect(capped.get("acc-free")).toBe(
			CHATGPT_PLAN_FREE_WINDOW_INPUT_TOKENS,
		);

		// One refusal caused by use outside Fabric cannot collapse it.
		observations.findMany.mockResolvedValue([
			{ sourceId: "acc-free", inputTokens: 1_000 },
		]);
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
