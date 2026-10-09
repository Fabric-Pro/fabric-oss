/**
 * A ChatGPT plan's current five-hour usage window, as far as Fabric's own
 * calls show it (Fizzy #2770 F1/F2). The single computation behind the usage
 * meters, the shared-account picker and every reset estimate.
 *
 * OpenAI's Plus window is ANCHORED, not sliding: it opens with the first
 * request after the previous window ended and resets five hours after that
 * start, whatever happens in between (ChatGPT shows "Resets in Xh"). Summing
 * "the last five hours" therefore misreads both ends: a burst that ended
 * hours ago still counts as a full window long after it reset, and the oldest
 * call in the last five hours is not the window's start once windows chain.
 *
 * Only Fabric's calls are visible: anything else spending the same ChatGPT
 * account opens or fills windows this cannot see.
 */

import { db } from "../client";
import type { ChatGptPlanTier } from "../generated/client";

export const CHATGPT_PLAN_WINDOW_MS = 5 * 60 * 60_000;

/**
 * How far back the window chain starts: two windows. A call preceded by five
 * quiet hours always opens a window, so the chain is exact as soon as such a
 * gap falls inside the lookback. Only an account used without a five-hour
 * pause for the whole ten hours is approximated — its chain starts at the
 * oldest call in the lookback, which may sit mid-window.
 */
const WINDOW_LOOKBACK_MS = 2 * CHATGPT_PLAN_WINDOW_MS;

/**
 * Default Fabric-only allowance of one Plus window, in uncached input tokens.
 * Staging evidence (2026-10-08): one shared account served 1.12M input tokens
 * (267k of them cached) inside a single window without being refused, and
 * ChatGPT then showed the weekly allowance only 22% used. The earlier 750k
 * guess read that window as spent. Read it through
 * {@link getChatGptPlanWindowBudget}, which per-account calibration extends.
 */
export const CHATGPT_PLAN_DEFAULT_WINDOW_INPUT_TOKENS = 2_000_000;

/** Whose plan: an organization's shared account, or a member's own plan. */
export type ChatGptPlanWindowSource =
	| { kind: "org"; organizationId: string; accountId: string }
	| { kind: "user"; userId: string };

/**
 * Pro has no five-hour window, only a weekly limit (Fizzy #2770 G7): its
 * budget is set out of reach, so the picker's headroom never holds it back
 * and the meter says "weekly limit only".
 */
export const CHATGPT_PLAN_NO_WINDOW_INPUT_TOKENS = 1_000_000_000;
/** Free ChatGPT's very small allowance. */
export const CHATGPT_PLAN_FREE_WINDOW_INPUT_TOKENS = 100_000;

/** A plan's window budget by tier, before calibration. */
export function chatGptPlanTierWindowBudget(tier: ChatGptPlanTier): number {
	switch (tier) {
		case "PRO":
			return CHATGPT_PLAN_NO_WINDOW_INPUT_TOKENS;
		case "FREE":
			return CHATGPT_PLAN_FREE_WINDOW_INPUT_TOKENS;
		default:
			// Plus, Team and an unknown tier: the Plus default.
			return CHATGPT_PLAN_DEFAULT_WINDOW_INPUT_TOKENS;
	}
}

/**
 * Calibration (Fizzy #2770 D6): a source's budget is the median of what it had
 * used of its window at its latest refusals, bounded so one odd window —
 * something outside Fabric spending the account, say — cannot make it absurd.
 */
const CALIBRATION_OBSERVATIONS = 5;
/** Older refusals say little about today's allowance. */
const CALIBRATION_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
export const CHATGPT_PLAN_MIN_CALIBRATED_BUDGET = 250_000;
export const CHATGPT_PLAN_MAX_CALIBRATED_BUDGET = 20_000_000;

/** The calibrated budget from observations, newest first; null with none. */
export function calibratedChatGptPlanBudget(
	observations: number[],
	bounds: { min: number; max: number } = {
		min: CHATGPT_PLAN_MIN_CALIBRATED_BUDGET,
		max: CHATGPT_PLAN_MAX_CALIBRATED_BUDGET,
	},
): number | null {
	const latest = observations.slice(0, CALIBRATION_OBSERVATIONS);
	if (latest.length === 0) {
		return null;
	}
	const sorted = [...latest].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	const median =
		sorted.length % 2 === 1
			? sorted[middle]
			: Math.round((sorted[middle - 1] + sorted[middle]) / 2);
	return Math.min(bounds.max, Math.max(bounds.min, median));
}

/**
 * Each shared account's allowance per window, in uncached input tokens:
 * calibrated once it has been refused at least once, the default until then. Keyed by
 * source id; every requested id is present.
 */
export async function getChatGptPlanWindowBudgets(
	sourceKind: "ORG",
	sourceIds: string[],
): Promise<Map<string, number>> {
	if (sourceIds.length === 0) {
		return new Map();
	}
	const accounts = await db.chatGptPlanOrgAccount.findMany({
		where: { id: { in: sourceIds } },
		select: { id: true, tier: true },
	});
	const tierOf = new Map(
		accounts.map((account) => [account.id, account.tier]),
	);
	const budgets = new Map(
		sourceIds.map((id) => [
			id,
			chatGptPlanTierWindowBudget(tierOf.get(id) ?? "UNKNOWN"),
		]),
	);
	const rows = await db.chatGptPlanBudgetObservation.findMany({
		where: {
			sourceKind,
			sourceId: { in: sourceIds },
			windowStart: { gte: new Date(Date.now() - CALIBRATION_MAX_AGE_MS) },
		},
		orderBy: { windowStart: "desc" },
		select: { sourceId: true, inputTokens: true },
	});
	for (const id of sourceIds) {
		const tier = tierOf.get(id) ?? "UNKNOWN";
		// Pro has no five-hour window to learn; a refusal there is the weekly
		// limit, never a smaller window.
		if (tier === "PRO") {
			continue;
		}
		// Free learns within its own small allowance — the general floor
		// alone sits above it — but never below a tenth of it, so a refusal
		// caused by use outside Fabric cannot collapse the budget.
		const calibrated = calibratedChatGptPlanBudget(
			rows
				.filter((row) => row.sourceId === id)
				.map((row) => row.inputTokens),
			tier === "FREE"
				? {
						min: CHATGPT_PLAN_FREE_WINDOW_INPUT_TOKENS / 10,
						max: CHATGPT_PLAN_FREE_WINDOW_INPUT_TOKENS,
					}
				: undefined,
		);
		if (calibrated !== null) {
			budgets.set(id, calibrated);
		}
	}
	return budgets;
}

/**
 * The plan's allowance per window, in uncached input tokens. A member's own
 * plan is never calibrated — it is also used outside Fabric — so its tier
 * alone decides.
 */
export async function getChatGptPlanWindowBudget(
	source: ChatGptPlanWindowSource,
): Promise<number> {
	if (source.kind !== "org") {
		const credential = await db.chatGptPlanCredential.findUnique({
			where: { userId: source.userId },
			select: { tier: true },
		});
		return chatGptPlanTierWindowBudget(credential?.tier ?? "UNKNOWN");
	}
	const budgets = await getChatGptPlanWindowBudgets("ORG", [
		source.accountId,
	]);
	return (
		budgets.get(source.accountId) ??
		CHATGPT_PLAN_DEFAULT_WINDOW_INPUT_TOKENS
	);
}

/**
 * Records what a shared account had used of its window when OpenAI refused
 * it. The first refusal in a window counts; later ones in the same window
 * are ignored (a refused account keeps being refused until it resets).
 */
export async function recordChatGptPlanBudgetObservation(params: {
	source: Extract<ChatGptPlanWindowSource, { kind: "org" }>;
	windowStart: Date;
	inputTokens: number;
	observedAt: Date;
}): Promise<void> {
	await db.chatGptPlanBudgetObservation.createMany({
		data: [
			{
				sourceKind: "ORG",
				sourceId: params.source.accountId,
				windowStart: params.windowStart,
				inputTokens: Math.round(params.inputTokens),
				observedAt: params.observedAt,
			},
		],
		skipDuplicates: true,
	});
}

/** The latest refusal Fabric recorded for each source, keyed by source id. */
export async function getChatGptPlanLastObservations(
	sourceKind: "ORG",
	sourceIds: string[],
): Promise<Map<string, Date>> {
	if (sourceIds.length === 0) {
		return new Map();
	}
	const rows = await db.chatGptPlanBudgetObservation.groupBy({
		by: ["sourceId"],
		where: { sourceKind, sourceId: { in: sourceIds } },
		_max: { observedAt: true },
	});
	return new Map(
		rows.flatMap((row) =>
			row._max.observedAt ? [[row.sourceId, row._max.observedAt]] : [],
		),
	);
}

/** One model call, as the window computation reads it. */
export interface ChatGptPlanWindowCall {
	createdAt: Date;
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	jobType: string | null;
	featureKey: string | null;
	/** Whose call it was; read for a shared account's fair share. */
	userId?: string | null;
}

/** Who spent the window: a background job type, an interactive feature, or neither. */
export interface ChatGptPlanWindowConsumer {
	kind: "job" | "feature" | "other";
	/** The job type or feature key; null for `other`. */
	key: string | null;
	requests: number;
	inputTokens: number;
	/** Share of the window's uncached input tokens, 0–100. */
	percent: number;
}

export interface ChatGptPlanWindow {
	/** Null when no window is open now. */
	windowStart: Date | null;
	resetsAt: Date | null;
	requests: number;
	/** Uncached input tokens: what the allowance is measured in. */
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	/** The latest call in the lookback, whether or not its window is still open. */
	lastRequestAt: Date | null;
	/** The window's largest consumers, largest first, at most three. */
	topConsumers: ChatGptPlanWindowConsumer[];
	/** Uncached input tokens of each member's own (non-background) calls. */
	inputTokensByUser: Record<string, number>;
}

const MAX_CONSUMERS = 3;

function emptyWindow(lastRequestAt: Date | null): ChatGptPlanWindow {
	return {
		windowStart: null,
		resetsAt: null,
		requests: 0,
		inputTokens: 0,
		cachedInputTokens: 0,
		outputTokens: 0,
		lastRequestAt,
		topConsumers: [],
		inputTokensByUser: {},
	};
}

function uncached(call: ChatGptPlanWindowCall): number {
	return Math.max(0, call.inputTokens - call.cachedInputTokens);
}

function consumersOf(
	calls: ChatGptPlanWindowCall[],
	total: number,
): ChatGptPlanWindowConsumer[] {
	const groups = new Map<string, ChatGptPlanWindowConsumer>();
	for (const call of calls) {
		const kind = call.jobType
			? "job"
			: call.featureKey
				? "feature"
				: "other";
		const key = call.jobType ?? call.featureKey ?? null;
		const id = `${kind}:${key ?? ""}`;
		const group = groups.get(id) ?? {
			kind,
			key,
			requests: 0,
			inputTokens: 0,
			percent: 0,
		};
		group.requests += 1;
		group.inputTokens += uncached(call);
		groups.set(id, group);
	}
	const requests = calls.length;
	return [...groups.values()]
		.map((group) => ({
			...group,
			percent: Math.round(
				total > 0
					? (group.inputTokens / total) * 100
					: (group.requests / requests) * 100,
			),
		}))
		.sort(
			(a, b) => b.inputTokens - a.inputTokens || b.requests - a.requests,
		)
		.slice(0, MAX_CONSUMERS);
}

/** A member's own work: background jobs run under a member's id but are not theirs. */
function byUser(calls: ChatGptPlanWindowCall[]): Record<string, number> {
	const totals: Record<string, number> = {};
	for (const call of calls) {
		if (call.userId && !call.jobType) {
			totals[call.userId] = (totals[call.userId] ?? 0) + uncached(call);
		}
	}
	return totals;
}

/**
 * The window open at `now` among `calls`, chaining windows from the oldest:
 * each window starts with the first call at or after the previous one's
 * reset. An empty window when the latest one has reset.
 */
export function computeChatGptPlanWindow(
	calls: ChatGptPlanWindowCall[],
	now: Date,
): ChatGptPlanWindow {
	const sorted = calls
		.filter((call) => call.createdAt.getTime() <= now.getTime())
		.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
	const last = sorted.at(-1);
	if (!last) {
		return emptyWindow(null);
	}
	let start = sorted[0].createdAt.getTime();
	let firstIndex = 0;
	sorted.forEach((call, index) => {
		if (call.createdAt.getTime() >= start + CHATGPT_PLAN_WINDOW_MS) {
			start = call.createdAt.getTime();
			firstIndex = index;
		}
	});
	const resetsAt = start + CHATGPT_PLAN_WINDOW_MS;
	if (now.getTime() >= resetsAt) {
		return emptyWindow(last.createdAt);
	}
	const inWindow = sorted.slice(firstIndex);
	const inputTokens = inWindow.reduce((sum, call) => sum + uncached(call), 0);
	return {
		windowStart: new Date(start),
		resetsAt: new Date(resetsAt),
		requests: inWindow.length,
		inputTokens,
		cachedInputTokens: inWindow.reduce(
			(sum, call) =>
				sum + Math.min(call.cachedInputTokens, call.inputTokens),
			0,
		),
		outputTokens: inWindow.reduce(
			(sum, call) => sum + call.outputTokens,
			0,
		),
		lastRequestAt: last.createdAt,
		topConsumers: consumersOf(inWindow, inputTokens),
		inputTokensByUser: byUser(inWindow),
	};
}

const CALL_SELECT = {
	createdAt: true,
	inputTokens: true,
	cachedInputTokens: true,
	outputTokens: true,
	jobType: true,
	featureKey: true,
	userId: true,
} as const;

/**
 * The current window of each of an organization's shared accounts, keyed by
 * account id. An account's calls carry its id in `providerConfigId`.
 */
export async function getChatGptPlanOrgAccountWindows(params: {
	organizationId: string;
	accountIds: string[];
	now?: Date;
}): Promise<Map<string, ChatGptPlanWindow>> {
	const now = params.now ?? new Date();
	if (params.accountIds.length === 0) {
		return new Map();
	}
	const rows = await db.aiUsageLog.findMany({
		where: {
			organizationId: params.organizationId,
			provider: "OPENAI_CHATGPT_PLAN",
			providerConfigId: { in: params.accountIds },
			createdAt: { gte: new Date(now.getTime() - WINDOW_LOOKBACK_MS) },
		},
		select: { ...CALL_SELECT, providerConfigId: true },
	});
	return new Map(
		params.accountIds.map((accountId) => [
			accountId,
			computeChatGptPlanWindow(
				rows.filter((row) => row.providerConfigId === accountId),
				now,
			),
		]),
	);
}

/**
 * The current window of a member's own plan. Their own plan's calls are the
 * ones with no `providerConfigId`; it is one plan across organizations.
 */
export async function getChatGptPlanUserWindow(params: {
	userId: string;
	now?: Date;
}): Promise<ChatGptPlanWindow> {
	const now = params.now ?? new Date();
	const rows = await db.aiUsageLog.findMany({
		where: {
			userId: params.userId,
			provider: "OPENAI_CHATGPT_PLAN",
			providerConfigId: null,
			createdAt: { gte: new Date(now.getTime() - WINDOW_LOOKBACK_MS) },
		},
		select: CALL_SELECT,
	});
	return computeChatGptPlanWindow(rows, now);
}

/** The share of the budget a window has used, 0–100. */
export function chatGptPlanWindowPercent(
	window: ChatGptPlanWindow,
	budget: number,
): number {
	return budget > 0
		? Math.min(100, Math.round((window.inputTokens / budget) * 100))
		: 0;
}
