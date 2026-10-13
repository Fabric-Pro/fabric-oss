/**
 * Plan usage accuracy (Fizzy #2770): OpenAI's reported usage is trusted only
 * while fresh; a window that resets unrefused past the budget raises it
 * without calibrating it; and the estimate's accuracy is kept per window.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const store = vi.hoisted(() => ({
	calls: [] as Row[],
	accuracy: [] as Row[],
	observations: [] as Row[],
	tier: "PLUS",
	/** Whether the shared account still exists, as the fence reads it. */
	accountExists: true,
	/** Each fence's lock, sign-in read and write, in order. */
	steps: [] as string[],
}));

vi.mock("../prisma/client", () => {
	const keyMatches = (row: Row, where: Row) => {
		const key = (where.sourceKind_sourceId_windowStart ?? where) as Row;
		return (
			row.sourceKind === key.sourceKind &&
			row.sourceId === key.sourceId &&
			(row.windowStart as Date).getTime() ===
				(key.windowStart as Date).getTime()
		);
	};
	const db: Record<string, unknown> = {
		aiUsageLog: { findMany: async () => store.calls },
		chatGptPlanOrgAccount: {
			findMany: async () => [{ id: "acc_1", tier: store.tier }],
		},
		chatGptPlanBudgetObservation: {
			findMany: async ({ where }: { where: Row }) =>
				store.observations
					.filter(
						(row) =>
							where.lowerBound === undefined ||
							row.lowerBound === where.lowerBound,
					)
					.sort(
						(a, b) =>
							(b.observedAt as Date).getTime() -
							(a.observedAt as Date).getTime(),
					),
			createMany: async ({ data }: { data: Row[] }) => {
				for (const row of data) {
					if (!store.observations.some((o) => keyMatches(o, row))) {
						store.observations.push(row);
					}
				}
				return { count: data.length };
			},
		},
		chatGptPlanWindowAccuracy: {
			findMany: async () => store.accuracy,
			findUnique: async ({ where }: { where: Row }) =>
				store.accuracy.find((row) => keyMatches(row, where)) ?? null,
			upsert: async ({
				where,
				create,
				update,
			}: {
				where: Row;
				create: Row;
				update: Row;
			}) => {
				const row = store.accuracy.find((r) => keyMatches(r, where));
				if (row) {
					Object.assign(row, update);
					return row;
				}
				// Unset nullable columns read back as null, as from Postgres.
				const created = {
					refusedAt: null,
					refusalEstimatePercent: null,
					peakEstimatePercent: null,
					settledAt: null,
					reportedPercent: null,
					estimatePercentAtReport: null,
					reportedAt: null,
					maxDriftPoints: null,
					...create,
				};
				store.accuracy.push(created);
				return created;
			},
		},
	};
	// The credential fence: an advisory lock, then the account read, then
	// the write, all on the transaction client.
	const tx: Record<string, unknown> = {
		...db,
		$executeRaw: async () => {
			store.steps.push("lock");
			return 1;
		},
		chatGptPlanOrgAccount: {
			findUnique: async ({ where }: { where: Row }) => {
				if (where.id !== "acc_1") {
					throw new Error("the fence reads only the shared account");
				}
				store.steps.push("read account");
				return store.accountExists
					? { id: "acc_1", subject: "s" }
					: null;
			},
		},
	};
	const trace = (name: string, delegate: Record<string, unknown>) =>
		Object.fromEntries(
			Object.entries(delegate).map(([method, fn]) => [
				method,
				async (args: unknown) => {
					if (/^(upsert|createMany)$/.test(method)) {
						store.steps.push(`${name}.${method}`);
					}
					return (fn as (args: unknown) => unknown)(args);
				},
			]),
		);
	tx.chatGptPlanWindowAccuracy = trace(
		"accuracy",
		db.chatGptPlanWindowAccuracy as Record<string, unknown>,
	);
	tx.chatGptPlanBudgetObservation = trace(
		"observation",
		db.chatGptPlanBudgetObservation as Record<string, unknown>,
	);
	db.$transaction = async (work: (client: typeof tx) => unknown) => work(tx);
	return { db };
});

import {
	CHATGPT_PLAN_REPORTED_FRESH_MS,
	chatGptPlanReportedUsage,
} from "../prisma/queries/chatgpt-plan-reported-usage";
import {
	CHATGPT_PLAN_DEFAULT_WINDOW_INPUT_TOKENS,
	CHATGPT_PLAN_MAX_CALIBRATED_BUDGET,
	chatGptPlanBudgetFromSamples,
	closedChatGptPlanWindows,
	getChatGptPlanWindowCalibrations,
} from "../prisma/queries/chatgpt-plan-window";
import {
	getChatGptPlanAccuracySummaries,
	recordChatGptPlanRefusalAccuracy,
	recordChatGptPlanReportedAccuracy,
	settleChatGptPlanAccountWindows,
} from "../prisma/queries/chatgpt-plan-window-accuracy";

const HOUR = 60 * 60_000;
const NOW = new Date("2026-10-12T20:00:00Z");
const ago = (hours: number) => new Date(NOW.getTime() - hours * HOUR);

const call = (createdAt: Date, inputTokens: number) => ({
	createdAt,
	inputTokens,
	cachedInputTokens: 0,
	outputTokens: 0,
	jobType: null,
	featureKey: null,
	providerModelId: "gpt-6.1-sol",
});

beforeEach(() => {
	store.calls = [];
	store.accuracy = [];
	store.observations = [];
	store.tier = "PLUS";
	store.accountExists = true;
	store.steps = [];
});

describe("two-way calibration", () => {
	const sample = (
		inputTokens: number,
		hoursAgo: number,
		lowerBound: boolean,
	) => ({
		inputTokens,
		observedAt: ago(hoursAgo),
		lowerBound,
	});

	it("raises an uncalibrated budget to a window that reset unrefused past it, still uncalibrated", () => {
		expect(
			chatGptPlanBudgetFromSamples(2_000_000, [
				sample(2_600_000, 1, true),
			]),
		).toEqual({ budget: 2_600_000, calibrated: false });
	});

	it("is calibrated only by a refusal, and a lower bound after it raises it", () => {
		expect(
			chatGptPlanBudgetFromSamples(2_000_000, [
				sample(1_900_000, 2, true),
				sample(1_500_000, 5, false),
			]),
		).toEqual({ budget: 1_900_000, calibrated: true });
	});

	it("lets a later refusal supersede an earlier lower bound", () => {
		expect(
			chatGptPlanBudgetFromSamples(2_000_000, [
				sample(1_500_000, 1, false),
				sample(3_000_000, 5, true),
			]),
		).toEqual({ budget: 1_500_000, calibrated: true });
	});

	it("never raises past the calibration bound", () => {
		expect(
			chatGptPlanBudgetFromSamples(2_000_000, [
				sample(90_000_000, 1, true),
			]).budget,
		).toBe(CHATGPT_PLAN_MAX_CALIBRATED_BUDGET);
	});

	it("reports calibration per account from stored observations", async () => {
		store.observations = [
			{
				sourceId: "acc_1",
				inputTokens: 2_400_000,
				observedAt: ago(1),
				lowerBound: true,
			},
		];
		const calibration = (
			await getChatGptPlanWindowCalibrations("ORG", ["acc_1"])
		).get("acc_1");
		expect(calibration).toEqual({ budget: 2_400_000, calibrated: false });
	});
});

describe("closedChatGptPlanWindows", () => {
	it("returns only windows that reset and whose start is exact", () => {
		const since = ago(24);
		const windows = closedChatGptPlanWindows(
			[
				// Within five hours of the lookback start: its window may have
				// opened before it, so it is not trusted.
				call(ago(23), 100),
				// Opens a window after a quiet gap: exact.
				call(ago(12), 1_000),
				call(ago(10), 2_000),
				// The open window: not closed yet.
				call(ago(1), 5),
			],
			NOW,
			since,
		);
		expect(windows).toEqual([
			{
				windowStart: ago(12),
				resetsAt: ago(7),
				weightedInputTokens: 3_000,
			},
		]);
	});
});

describe("closedChatGptPlanWindows — continuous use", () => {
	it("trusts no window of an account never quiet for five hours", () => {
		const hourly = Array.from({ length: 24 }, (_, i) =>
			call(ago(24 - i), 100_000),
		);
		expect(closedChatGptPlanWindows(hourly, NOW, ago(24))).toEqual([]);
	});

	it("trusts the chain again from the first five-hour gap", () => {
		const calls = [
			// Continuous from the lookback start: guessed starts.
			...Array.from({ length: 6 }, (_, i) => call(ago(24 - i), 1)),
			// Five quiet hours, then an exact window and one chained from it.
			call(ago(13), 10),
			call(ago(8), 20),
		];
		expect(
			closedChatGptPlanWindows(calls, NOW, ago(24)).map(
				(window) => window.windowStart,
			),
		).toEqual([ago(13), ago(8)]);
	});
});

describe("chatGptPlanReportedUsage", () => {
	const state = (overrides: Row = {}) => ({
		reportedPrimaryUsedPercent: 42,
		reportedPrimaryWindowMinutes: 300,
		reportedPrimaryResetAt: new Date(NOW.getTime() + 2 * HOUR),
		reportedSecondaryUsedPercent: 10,
		reportedSecondaryWindowMinutes: 10_080,
		reportedSecondaryResetAt: null,
		reportedAt: new Date(NOW.getTime() - 60_000),
		...overrides,
	});

	it("is fresh while recent and before the window resets", () => {
		expect(chatGptPlanReportedUsage(state(), NOW)).toMatchObject({
			window: { usedPercent: 42 },
			weekly: { usedPercent: 10 },
			windowFresh: true,
		});
	});

	it("goes stale with age, and once the reported window has reset", () => {
		expect(
			chatGptPlanReportedUsage(
				state({
					reportedAt: new Date(
						NOW.getTime() - CHATGPT_PLAN_REPORTED_FRESH_MS - 1,
					),
				}),
				NOW,
			)?.windowFresh,
		).toBe(false);
		expect(
			chatGptPlanReportedUsage(
				state({ reportedPrimaryResetAt: new Date(NOW.getTime() - 1) }),
				NOW,
			)?.windowFresh,
		).toBe(false);
	});

	it("sorts by window length: a weekly-only primary is no five-hour window", () => {
		const usage = chatGptPlanReportedUsage(
			state({
				reportedPrimaryWindowMinutes: 10_080,
				reportedSecondaryUsedPercent: null,
			}),
			NOW,
		);
		expect(usage?.window).toBeNull();
		expect(usage?.weekly?.usedPercent).toBe(42);
		expect(usage?.windowFresh).toBe(false);
	});

	it("is null before any report", () => {
		expect(chatGptPlanReportedUsage({ reportedAt: null }, NOW)).toBeNull();
	});
});

describe("settleChatGptPlanAccountWindows", () => {
	const settle = () =>
		settleChatGptPlanAccountWindows({
			organizationId: "org_a",
			accountId: "acc_1",
			now: NOW,
		});

	it("records an unrefused window's peak and, past the budget, a lower bound", async () => {
		store.calls = [call(ago(12), 1_500_000), call(ago(10), 1_500_000)];
		const settled = await settle();
		expect(settled).toEqual([
			expect.objectContaining({
				peakEstimatePercent: 150,
				refused: false,
				lowerBound: true,
			}),
		]);
		expect(store.accuracy).toEqual([
			expect.objectContaining({
				windowStart: ago(12),
				budget: CHATGPT_PLAN_DEFAULT_WINDOW_INPUT_TOKENS,
				peakEstimatePercent: 150,
				refusedAt: null,
				settledAt: NOW,
			}),
		]);
		expect(store.observations).toEqual([
			expect.objectContaining({
				windowStart: ago(12),
				inputTokens: 3_000_000,
				lowerBound: true,
			}),
		]);
		// Settled once.
		await expect(settle()).resolves.toEqual([]);
	});

	it("learns no lower bound from a window OpenAI refused", async () => {
		store.calls = [call(ago(12), 3_000_000)];
		await recordChatGptPlanRefusalAccuracy({
			sourceKind: "ORG",
			sourceId: "acc_1",
			windowStart: ago(12.5),
			budget: 2_000_000,
			estimatePercent: 150,
			refusedAt: ago(11),
		});
		const settled = await settle();
		expect(settled).toEqual([
			expect.objectContaining({ refused: true, lowerBound: false }),
		]);
		expect(store.observations).toEqual([]);
	});

	it("records nothing below the budget but the peak", async () => {
		store.calls = [call(ago(12), 500_000)];
		await settle();
		expect(store.observations).toEqual([]);
		expect(store.accuracy[0]).toMatchObject({ peakEstimatePercent: 25 });
	});
});

describe("accuracy summary", () => {
	it("reports refusal estimates, unrefused overshoots and the gap to OpenAI's report", async () => {
		await recordChatGptPlanRefusalAccuracy({
			sourceKind: "ORG",
			sourceId: "acc_1",
			windowStart: ago(30),
			budget: 2_000_000,
			estimatePercent: 64.4,
			refusedAt: ago(28),
		});
		// The first refusal in a window counts.
		await recordChatGptPlanRefusalAccuracy({
			sourceKind: "ORG",
			sourceId: "acc_1",
			windowStart: ago(30),
			budget: 2_000_000,
			estimatePercent: 99,
			refusedAt: ago(27),
		});
		store.calls = [call(ago(12), 2_800_000)];
		await settleChatGptPlanAccountWindows({
			organizationId: "org_a",
			accountId: "acc_1",
			now: NOW,
		});
		await recordChatGptPlanReportedAccuracy({
			sourceKind: "ORG",
			sourceId: "acc_1",
			windowStart: ago(2),
			budget: 2_000_000,
			estimatePercent: 20,
			reportedPercent: 50,
			reportedAt: ago(1),
		});
		await expect(
			recordChatGptPlanReportedAccuracy({
				sourceKind: "ORG",
				sourceId: "acc_1",
				windowStart: ago(2),
				budget: 2_000_000,
				estimatePercent: 30,
				reportedPercent: 40,
				reportedAt: ago(0.5),
			}),
		).resolves.toBe(10);
		const summary = (
			await getChatGptPlanAccuracySummaries(["acc_1"], NOW)
		).get("acc_1");
		expect(summary).toEqual({
			refusalEstimatePercents: [64.4],
			windowsOverBudgetWithoutRefusal: 1,
			settledWindows: 1,
			latestReported: {
				estimatePercent: 30,
				reportedPercent: 40,
				at: ago(0.5),
			},
			maxDriftPoints: 30,
		});
	});
});

describe("writes only while the shared account exists", () => {
	const key = {
		sourceKind: "ORG" as const,
		sourceId: "acc_1",
		windowStart: ago(2),
	};

	it("writes each record under the account's lock, after reading it", async () => {
		store.calls = [call(ago(12), 3_000_000)];
		await recordChatGptPlanRefusalAccuracy({
			...key,
			budget: 2_000_000,
			estimatePercent: 90,
			refusedAt: ago(1),
		});
		await recordChatGptPlanReportedAccuracy({
			...key,
			budget: 2_000_000,
			estimatePercent: 20,
			reportedPercent: 30,
			reportedAt: ago(1),
		});
		await settleChatGptPlanAccountWindows({
			organizationId: "org_a",
			accountId: "acc_1",
			now: NOW,
		});
		expect(store.steps).toEqual([
			"lock",
			"read account",
			"accuracy.upsert",
			"lock",
			"read account",
			"accuracy.upsert",
			"lock",
			"read account",
			"accuracy.upsert",
			"observation.createMany",
		]);
	});

	it("records nothing for an account deleted meanwhile, and keeps each return", async () => {
		store.accountExists = false;
		store.calls = [call(ago(12), 3_000_000)];
		await expect(
			recordChatGptPlanRefusalAccuracy({
				...key,
				budget: 2_000_000,
				estimatePercent: 90,
				refusedAt: ago(1),
			}),
		).resolves.toBeUndefined();
		await expect(
			recordChatGptPlanReportedAccuracy({
				...key,
				budget: 2_000_000,
				estimatePercent: 20,
				reportedPercent: 30,
				reportedAt: ago(1),
			}),
		).resolves.toBe(10);
		await expect(
			settleChatGptPlanAccountWindows({
				organizationId: "org_a",
				accountId: "acc_1",
				now: NOW,
			}),
		).resolves.toEqual([]);
		expect(store.accuracy).toEqual([]);
		expect(store.observations).toEqual([]);
		expect(store.steps.filter((step) => step.includes("."))).toEqual([]);
	});
});
