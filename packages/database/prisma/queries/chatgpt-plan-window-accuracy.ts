/**
 * How accurate Fabric's window estimate is (Fizzy #2770): what it said when
 * OpenAI refused a shared account, how high it climbed in windows that reset
 * without a refusal, and how far it sat from the usage OpenAI reported. The
 * same pass teaches the budget its lower bounds: a window that reset unrefused
 * past the budget shows the real allowance is at least that.
 *
 * Keyed by source with no `organizationId`, like the calibration rows.
 * Callers pass only accounts they already resolved under an organization.
 *
 * Every write goes through the credential fence with no fingerprint: under
 * the account's lock, and only while the account exists. Without it a write
 * that lands after a disconnect would leave a row behind for the daily sweep
 * in `chatgpt-plan-source-sweep.ts` to remove.
 */

import { db } from "../client";
import {
	CHATGPT_PLAN_WINDOW_MS,
	type ChatGptPlanWindowCall,
	chatGptPlanWindowPercentUncapped,
	closedChatGptPlanWindows,
	getChatGptPlanWindowCalibrations,
} from "./chatgpt-plan-window";
import { withChatGptPlanCredentialFence } from "./lib/chatgpt-plan-credential-fence";

/** How far back a settling pass looks for windows that have reset. */
const SETTLE_LOOKBACK_MS = 24 * 60 * 60_000;
/** How far past a window's estimated reset a refusal may fall and be its own. */
const REFUSAL_MATCH_TOLERANCE_MS = 10 * 60_000;
/** How far back the accuracy summary reads. */
const SUMMARY_LOOKBACK_MS = 30 * 24 * 60 * 60_000;
const SUMMARY_REFUSALS = 5;

interface AccuracyKey {
	sourceKind: "ORG";
	sourceId: string;
	windowStart: Date;
}

function keyOf(key: AccuracyKey) {
	return {
		sourceKind_sourceId_windowStart: {
			sourceKind: key.sourceKind,
			sourceId: key.sourceId,
			windowStart: key.windowStart,
		},
	};
}

/**
 * What the estimate said, uncapped, when OpenAI refused the window that
 * opened at `windowStart`, against the budget in force before this refusal
 * taught it anything. The first refusal in a window counts.
 */
export async function recordChatGptPlanRefusalAccuracy(
	input: AccuracyKey & {
		budget: number;
		estimatePercent: number;
		refusedAt: Date;
	},
): Promise<void> {
	const refusal = {
		refusedAt: input.refusedAt,
		refusalEstimatePercent: input.estimatePercent,
	};
	await withChatGptPlanCredentialFence(input, null, async (tx) => {
		const existing = await tx.chatGptPlanWindowAccuracy.findUnique({
			where: keyOf(input),
			select: { refusedAt: true },
		});
		if (existing?.refusedAt) {
			return;
		}
		await tx.chatGptPlanWindowAccuracy.upsert({
			where: keyOf(input),
			create: {
				sourceKind: input.sourceKind,
				sourceId: input.sourceId,
				windowStart: input.windowStart,
				budget: Math.round(input.budget),
				...refusal,
			},
			update: refusal,
		});
	});
}

/**
 * One estimate-vs-reported pair for the window that opened at
 * `windowStart`: the latest pair is kept, and the largest gap seen in it.
 * Returns this pair's gap in percentage points, also when the account is
 * gone and nothing was recorded.
 */
export async function recordChatGptPlanReportedAccuracy(
	input: AccuracyKey & {
		budget: number;
		estimatePercent: number;
		reportedPercent: number;
		reportedAt: Date;
	},
): Promise<number> {
	const drift = Math.abs(input.estimatePercent - input.reportedPercent);
	await withChatGptPlanCredentialFence(input, null, async (tx) => {
		const existing = await tx.chatGptPlanWindowAccuracy.findUnique({
			where: keyOf(input),
			select: { maxDriftPoints: true },
		});
		const pair = {
			reportedPercent: input.reportedPercent,
			estimatePercentAtReport: input.estimatePercent,
			reportedAt: input.reportedAt,
			maxDriftPoints: Math.max(existing?.maxDriftPoints ?? 0, drift),
		};
		await tx.chatGptPlanWindowAccuracy.upsert({
			where: keyOf(input),
			create: {
				sourceKind: input.sourceKind,
				sourceId: input.sourceId,
				windowStart: input.windowStart,
				budget: Math.round(input.budget),
				...pair,
			},
			update: pair,
		});
	});
	return drift;
}

/** A window a settling pass closed the books on. */
export interface ChatGptPlanSettledWindow {
	windowStart: Date;
	/** The estimate when it reset, uncapped. */
	peakEstimatePercent: number;
	weightedInputTokens: number;
	budget: number;
	refused: boolean;
	/** It reset unrefused past the budget, which now counts as a lower bound. */
	lowerBound: boolean;
}

/**
 * Closes the books on a shared account's windows that reset in the last day
 * and were not settled yet: each records its peak estimate, and one that
 * reset unrefused past the budget becomes a lower-bound observation, which
 * raises the budget (bounded) without calibrating it. Returns the windows it
 * settled, for the caller to log.
 */
export async function settleChatGptPlanAccountWindows(params: {
	organizationId: string;
	accountId: string;
	now?: Date;
}): Promise<ChatGptPlanSettledWindow[]> {
	const now = params.now ?? new Date();
	const since = new Date(now.getTime() - SETTLE_LOOKBACK_MS);
	const calls: ChatGptPlanWindowCall[] = await db.aiUsageLog.findMany({
		where: {
			organizationId: params.organizationId,
			provider: "OPENAI_CHATGPT_PLAN",
			providerConfigId: params.accountId,
			createdAt: { gte: since, lte: now },
		},
		select: {
			createdAt: true,
			inputTokens: true,
			cachedInputTokens: true,
			outputTokens: true,
			jobType: true,
			featureKey: true,
			providerModelId: true,
		},
	});
	const closed = closedChatGptPlanWindows(calls, now, since);
	if (closed.length === 0) {
		return [];
	}
	const source = { sourceKind: "ORG" as const, sourceId: params.accountId };
	const [rows, refusals, calibrations] = await Promise.all([
		db.chatGptPlanWindowAccuracy.findMany({
			where: { ...source, windowStart: { gte: since } },
			select: { windowStart: true, refusedAt: true, settledAt: true },
		}),
		db.chatGptPlanBudgetObservation.findMany({
			where: { ...source, lowerBound: false, observedAt: { gte: since } },
			select: { observedAt: true },
		}),
		getChatGptPlanWindowCalibrations("ORG", [params.accountId]),
	]);
	const budget = calibrations.get(params.accountId)?.budget ?? 0;
	const settled = new Set(
		rows
			.filter((row) => row.settledAt !== null)
			.map((row) => row.windowStart.getTime()),
	);
	const refusalTimes = [
		...rows.flatMap((row) => (row.refusedAt ? [row.refusedAt] : [])),
		...refusals.map((row) => row.observedAt),
	];
	const outcomes: ChatGptPlanSettledWindow[] = [];
	const writes: Array<{
		windowStart: Date;
		refusedAt: Date | null;
		peakEstimatePercent: number;
		lowerBound: boolean;
		weightedInputTokens: number;
		resetsAt: Date;
	}> = [];
	for (const window of closed) {
		if (settled.has(window.windowStart.getTime())) {
			continue;
		}
		const refusedAt =
			refusalTimes.find(
				(at) =>
					at.getTime() >= window.windowStart.getTime() &&
					at.getTime() <=
						window.windowStart.getTime() +
							CHATGPT_PLAN_WINDOW_MS +
							REFUSAL_MATCH_TOLERANCE_MS,
			) ?? null;
		const peakEstimatePercent = chatGptPlanWindowPercentUncapped(
			window.weightedInputTokens,
			budget,
		);
		const lowerBound =
			refusedAt === null &&
			budget > 0 &&
			window.weightedInputTokens > budget;
		writes.push({
			windowStart: window.windowStart,
			refusedAt,
			peakEstimatePercent,
			lowerBound,
			weightedInputTokens: window.weightedInputTokens,
			resetsAt: window.resetsAt,
		});
		outcomes.push({
			windowStart: window.windowStart,
			peakEstimatePercent,
			weightedInputTokens: window.weightedInputTokens,
			budget,
			refused: refusedAt !== null,
			lowerBound,
		});
	}
	if (writes.length === 0) {
		return [];
	}
	// One fenced transaction for the pass: an account deleted meanwhile
	// settles nothing, and the caller logs nothing for it.
	const written = await withChatGptPlanCredentialFence(
		source,
		null,
		async (tx) => {
			for (const write of writes) {
				const books = {
					peakEstimatePercent: write.peakEstimatePercent,
					settledAt: now,
				};
				await tx.chatGptPlanWindowAccuracy.upsert({
					where: keyOf({ ...source, windowStart: write.windowStart }),
					create: {
						...source,
						windowStart: write.windowStart,
						budget: Math.round(budget),
						refusedAt: write.refusedAt,
						...books,
					},
					update: books,
				});
				if (write.lowerBound) {
					await tx.chatGptPlanBudgetObservation.createMany({
						data: [
							{
								...source,
								windowStart: write.windowStart,
								inputTokens: Math.round(
									write.weightedInputTokens,
								),
								observedAt: write.resetsAt,
								lowerBound: true,
							},
						],
						skipDuplicates: true,
					});
				}
			}
		},
	);
	return written ? outcomes : [];
}

/** How the estimate fared for one account over the last month. */
export interface ChatGptPlanAccuracySummary {
	/** The estimate at the latest refusals, newest first, uncapped. */
	refusalEstimatePercents: number[];
	/** Windows that reset unrefused after the estimate passed 100%. */
	windowsOverBudgetWithoutRefusal: number;
	/** Windows settled in the period. */
	settledWindows: number;
	/** The latest estimate-vs-reported pair, if OpenAI ever reported usage. */
	latestReported: {
		estimatePercent: number;
		reportedPercent: number;
		at: Date;
	} | null;
	/** The largest gap to OpenAI's report in the period, in points. */
	maxDriftPoints: number | null;
}

/** Each account's accuracy summary, keyed by account id; every id is present. */
export async function getChatGptPlanAccuracySummaries(
	sourceIds: string[],
	now = new Date(),
): Promise<Map<string, ChatGptPlanAccuracySummary>> {
	if (sourceIds.length === 0) {
		return new Map();
	}
	const rows = await db.chatGptPlanWindowAccuracy.findMany({
		where: {
			sourceKind: "ORG",
			sourceId: { in: sourceIds },
			windowStart: { gte: new Date(now.getTime() - SUMMARY_LOOKBACK_MS) },
		},
		orderBy: { windowStart: "desc" },
	});
	return new Map(
		sourceIds.map((id): [string, ChatGptPlanAccuracySummary] => {
			const mine = rows.filter((row) => row.sourceId === id);
			const reported = mine
				.filter((row) => row.reportedAt !== null)
				.sort(
					(a, b) =>
						(b.reportedAt?.getTime() ?? 0) -
						(a.reportedAt?.getTime() ?? 0),
				);
			const latest = reported[0];
			const drifts = mine.flatMap((row) =>
				row.maxDriftPoints === null ? [] : [row.maxDriftPoints],
			);
			return [
				id,
				{
					refusalEstimatePercents: mine
						.filter(
							(row) =>
								row.refusedAt !== null &&
								row.refusalEstimatePercent !== null,
						)
						.sort(
							(a, b) =>
								(b.refusedAt?.getTime() ?? 0) -
								(a.refusedAt?.getTime() ?? 0),
						)
						.slice(0, SUMMARY_REFUSALS)
						.map((row) => row.refusalEstimatePercent ?? 0),
					windowsOverBudgetWithoutRefusal: mine.filter(
						(row) =>
							row.settledAt !== null &&
							row.refusedAt === null &&
							(row.peakEstimatePercent ?? 0) > 100,
					).length,
					settledWindows: mine.filter((row) => row.settledAt !== null)
						.length,
					latestReported:
						latest?.reportedAt &&
						latest.reportedPercent !== null &&
						latest.estimatePercentAtReport !== null
							? {
									estimatePercent:
										latest.estimatePercentAtReport,
									reportedPercent: latest.reportedPercent,
									at: latest.reportedAt,
								}
							: null,
					maxDriftPoints:
						drifts.length > 0 ? Math.max(...drifts) : null,
				},
			];
		}),
	);
}
