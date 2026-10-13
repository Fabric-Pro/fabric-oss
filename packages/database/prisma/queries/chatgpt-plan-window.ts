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
import type {
	ChatGptPlanSourceState,
	ChatGptPlanTier,
} from "../generated/client";
import { withChatGptPlanCredentialFence } from "./lib/chatgpt-plan-credential-fence";

export const CHATGPT_PLAN_WINDOW_MS = 5 * 60 * 60_000;

/**
 * How far back the window chain starts: two windows. A call preceded by five
 * quiet hours always opens a window, so the chain is exact as soon as such a
 * gap falls inside the lookback. Only an account used without a five-hour
 * pause for the whole ten hours is approximated — its chain starts at the
 * oldest call in the lookback, which may sit mid-window — unless OpenAI
 * reported a reset it can chain from instead.
 */
const WINDOW_LOOKBACK_MS = 2 * CHATGPT_PLAN_WINDOW_MS;

/**
 * How far back a reset OpenAI reported may widen the lookback (Fizzy #2770
 * G9): a known boundary makes the chain after it exact, so it is worth
 * reading a little further to reach one.
 */
const ANCHORED_LOOKBACK_MS = 24 * 60 * 60_000;

/** How far a refusal's reset may sit past a five-hour window and still be its reset. */
const ANCHOR_RESET_TOLERANCE_MS = 10 * 60_000;

/**
 * What one uncached input token of a model costs of the window, relative to
 * Sol (Fizzy #2770 G8): budgets, calibration and every share of a window are
 * in these Sol-equivalent tokens. Keyed by model family; anything else
 * weighs 1.
 *
 * Staging evidence (2026-10-08): ChatGPT showed a window 86% used after 885k
 * uncached input from Fabric, 63% of it on Astra and the rest on Sol and
 * Luna, while 853k uncached on Sol alone left it far from spent. Against the
 * 2M Sol budget that puts Astra near 2.5x Sol, and the window refused that
 * day at 956k of an Astra-heavy mix — about 1.9M weighted, close to the
 * budget. Luna has no measurement yet; OpenAI lists it as the efficient
 * model, so it is set below Sol.
 */
export const CHATGPT_PLAN_MODEL_WEIGHTS: Record<string, number> = {
	astra: 2.5,
	sol: 1,
	terra: 1,
	luna: 0.5,
};

/** A plan model's weight in the window: by family ("sol" in `gpt-6.1-sol`), else 1. */
export function chatGptPlanModelWeight(
	model: string | null | undefined,
): number {
	const family = model
		?.toLowerCase()
		.split(/[^a-z0-9.]+/)
		.find((part) => Object.hasOwn(CHATGPT_PLAN_MODEL_WEIGHTS, part));
	return family ? CHATGPT_PLAN_MODEL_WEIGHTS[family] : 1;
}

/**
 * Default Fabric-only allowance of one Plus window, in Sol-equivalent
 * uncached input tokens. Staging evidence (2026-10-08): one shared account
 * served 1.12M input tokens (267k of them cached) on Sol inside a single
 * window without being refused, and ChatGPT then showed the weekly allowance
 * only 22% used. The earlier 750k guess read that window as spent. Read it
 * through {@link getChatGptPlanWindowBudget}, which per-account calibration
 * extends.
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
/** Observations before this were recorded in raw, unweighted tokens. */
const WEIGHTED_CALIBRATION_SINCE = new Date("2026-10-10T00:00:00Z");
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

/** A shared account's window budget, and whether a refusal measured it. */
export interface ChatGptPlanWindowCalibration {
	/** Sol-equivalent uncached input tokens per window. */
	budget: number;
	/**
	 * At least one real refusal in the calibration period set it. A budget
	 * only raised by windows that reset unrefused is not calibrated: nothing
	 * yet showed where the top is (Fizzy #2770).
	 */
	calibrated: boolean;
}

/** One calibration observation. */
export interface ChatGptPlanBudgetSample {
	inputTokens: number;
	observedAt: Date;
	lowerBound: boolean;
}

/**
 * A budget from a source's observations, newest first: the median of its
 * latest refusals (else the tier's default), raised to the largest window
 * that reset unrefused since the latest refusal — the real allowance is at
 * least that. A refusal after such a window supersedes it. Bounded either way.
 */
export function chatGptPlanBudgetFromSamples(
	tierBudget: number,
	samples: ChatGptPlanBudgetSample[],
	bounds: { min: number; max: number } = {
		min: CHATGPT_PLAN_MIN_CALIBRATED_BUDGET,
		max: CHATGPT_PLAN_MAX_CALIBRATED_BUDGET,
	},
): ChatGptPlanWindowCalibration {
	const refusals = samples.filter((sample) => !sample.lowerBound);
	const newestRefusal = refusals[0]?.observedAt.getTime() ?? null;
	const lowerBounds = samples.filter(
		(sample) =>
			sample.lowerBound &&
			(newestRefusal === null ||
				sample.observedAt.getTime() > newestRefusal),
	);
	const base =
		calibratedChatGptPlanBudget(
			refusals.map((sample) => sample.inputTokens),
			bounds,
		) ?? tierBudget;
	const floor = Math.min(
		bounds.max,
		Math.max(0, ...lowerBounds.map((sample) => sample.inputTokens)),
	);
	return { budget: Math.max(base, floor), calibrated: refusals.length > 0 };
}

/** Observations before this, or older than the calibration age, say nothing. */
function calibrationSince(now = Date.now()): Date {
	return new Date(
		Math.max(
			now - CALIBRATION_MAX_AGE_MS,
			WEIGHTED_CALIBRATION_SINCE.getTime(),
		),
	);
}

/**
 * Each shared account's allowance per window and whether a refusal
 * calibrated it, keyed by source id; every requested id is present.
 */
export async function getChatGptPlanWindowCalibrations(
	sourceKind: "ORG",
	sourceIds: string[],
): Promise<Map<string, ChatGptPlanWindowCalibration>> {
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
	const rows = await db.chatGptPlanBudgetObservation.findMany({
		where: {
			sourceKind,
			sourceId: { in: sourceIds },
			windowStart: { gte: calibrationSince() },
		},
		orderBy: { observedAt: "desc" },
		select: {
			sourceId: true,
			inputTokens: true,
			observedAt: true,
			lowerBound: true,
		},
	});
	return new Map(
		sourceIds.map((id): [string, ChatGptPlanWindowCalibration] => {
			const tier = tierOf.get(id) ?? "UNKNOWN";
			const tierBudget = chatGptPlanTierWindowBudget(tier);
			// Pro has no five-hour window to learn; a refusal there is the
			// weekly limit, never a smaller window.
			if (tier === "PRO") {
				return [id, { budget: tierBudget, calibrated: false }];
			}
			// Free learns within its own small allowance — the general floor
			// alone sits above it — but never below a tenth of it, so a
			// refusal caused by use outside Fabric cannot collapse the budget.
			return [
				id,
				chatGptPlanBudgetFromSamples(
					tierBudget,
					rows.filter((row) => row.sourceId === id),
					tier === "FREE"
						? {
								min: CHATGPT_PLAN_FREE_WINDOW_INPUT_TOKENS / 10,
								max: CHATGPT_PLAN_FREE_WINDOW_INPUT_TOKENS,
							}
						: undefined,
				),
			];
		}),
	);
}

/**
 * Each shared account's allowance per window, in Sol-equivalent uncached
 * input tokens: see {@link getChatGptPlanWindowCalibrations}. Keyed by
 * source id; every requested id is present.
 */
export async function getChatGptPlanWindowBudgets(
	sourceKind: "ORG",
	sourceIds: string[],
): Promise<Map<string, number>> {
	const calibrations = await getChatGptPlanWindowCalibrations(
		sourceKind,
		sourceIds,
	);
	return new Map(
		[...calibrations].map(([id, calibration]) => [id, calibration.budget]),
	);
}

/**
 * The plan's allowance per window, in Sol-equivalent uncached input tokens. A member's own
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
 * Records what a shared account had used of its window, weighted, when
 * OpenAI refused it. The first refusal in a window counts; later ones in the same window
 * are ignored (a refused account keeps being refused until it resets).
 * Skipped when the account's sign-in changed since the refused call read its
 * token (Fizzy #3037); true when it ran.
 */
export function recordChatGptPlanBudgetObservation(params: {
	source: Extract<ChatGptPlanWindowSource, { kind: "org" }>;
	windowStart: Date;
	inputTokens: number;
	observedAt: Date;
	/** The sign-in whose call was refused. */
	credentialFingerprint: string;
}): Promise<boolean> {
	return withChatGptPlanCredentialFence(
		{ sourceKind: "ORG", sourceId: params.source.accountId },
		params.credentialFingerprint,
		(tx) =>
			tx.chatGptPlanBudgetObservation.createMany({
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
			}),
	);
}

/**
 * The latest refusal Fabric recorded for each source, keyed by source id. A
 * lower bound (a window that reset unrefused) is no refusal.
 */
export async function getChatGptPlanLastObservations(
	sourceKind: "ORG",
	sourceIds: string[],
): Promise<Map<string, Date>> {
	if (sourceIds.length === 0) {
		return new Map();
	}
	const rows = await db.chatGptPlanBudgetObservation.groupBy({
		by: ["sourceId"],
		where: { sourceKind, sourceId: { in: sourceIds }, lowerBound: false },
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
	/** The plan model that answered; weights the call (Fizzy #2770 G8). */
	providerModelId?: string | null;
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
	/** Uncached input tokens, as the calls reported them. */
	inputTokens: number;
	/** Uncached input weighted by model: what the budget is measured in. */
	weightedInputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	/** The latest call in the lookback, whether or not its window is still open. */
	lastRequestAt: Date | null;
	/** The window's largest consumers, largest first, at most three. */
	topConsumers: ChatGptPlanWindowConsumer[];
	/** Weighted uncached input of each member's own (non-background) calls. */
	weightedInputTokensByUser: Record<string, number>;
}

const MAX_CONSUMERS = 3;

function emptyWindow(lastRequestAt: Date | null): ChatGptPlanWindow {
	return {
		windowStart: null,
		resetsAt: null,
		requests: 0,
		inputTokens: 0,
		weightedInputTokens: 0,
		cachedInputTokens: 0,
		outputTokens: 0,
		lastRequestAt,
		topConsumers: [],
		weightedInputTokensByUser: {},
	};
}

function uncached(call: ChatGptPlanWindowCall): number {
	return Math.max(0, call.inputTokens - call.cachedInputTokens);
}

function weighted(call: ChatGptPlanWindowCall): number {
	return uncached(call) * chatGptPlanModelWeight(call.providerModelId);
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
			totals[call.userId] = (totals[call.userId] ?? 0) + weighted(call);
		}
	}
	return totals;
}

/** What a source's breaker last stored about its spent window. */
export type ChatGptPlanWindowResetState = Pick<
	ChatGptPlanSourceState,
	"resetAt" | "lastExhaustedAt" | "consecutiveUnknownResets"
>;

/**
 * The five-hour reset OpenAI last reported for a source, as a known window
 * boundary (Fizzy #2770 G9): an account used without a five-hour pause has
 * no gap to anchor its chain on, and its estimate drifts from OpenAI's
 * window. Null when the reset was Fabric's own estimate, was the weekly
 * limit's, or lies beyond the widened lookback.
 */
export function chatGptPlanKnownWindowReset(
	state: ChatGptPlanWindowResetState | null | undefined,
	now: Date,
): Date | null {
	if (
		!state?.resetAt ||
		!state.lastExhaustedAt ||
		state.consecutiveUnknownResets > 0
	) {
		return null;
	}
	const reset = state.resetAt.getTime();
	if (
		reset - state.lastExhaustedAt.getTime() >
			CHATGPT_PLAN_WINDOW_MS + ANCHOR_RESET_TOLERANCE_MS ||
		now.getTime() - reset > ANCHORED_LOOKBACK_MS
	) {
		return null;
	}
	return state.resetAt;
}

function windowOf(
	inWindow: ChatGptPlanWindowCall[],
	start: number,
	lastRequestAt: Date | null,
): ChatGptPlanWindow {
	const inputTokens = inWindow.reduce((sum, call) => sum + uncached(call), 0);
	return {
		windowStart: new Date(start),
		resetsAt: new Date(start + CHATGPT_PLAN_WINDOW_MS),
		requests: inWindow.length,
		inputTokens,
		weightedInputTokens: inWindow.reduce(
			(sum, call) => sum + weighted(call),
			0,
		),
		cachedInputTokens: inWindow.reduce(
			(sum, call) =>
				sum + Math.min(call.cachedInputTokens, call.inputTokens),
			0,
		),
		outputTokens: inWindow.reduce(
			(sum, call) => sum + call.outputTokens,
			0,
		),
		lastRequestAt,
		topConsumers: consumersOf(inWindow, inputTokens),
		weightedInputTokensByUser: byUser(inWindow),
	};
}

/**
 * The window open at `now` among `calls`, chaining windows from the oldest:
 * each window starts with the first call at or after the previous one's
 * reset. A known reset (see {@link chatGptPlanKnownWindowReset}) is such a
 * boundary: the chain restarts at it, and before it the window is the one it
 * closes. An empty window when the latest one has reset.
 */
export function computeChatGptPlanWindow(
	calls: ChatGptPlanWindowCall[],
	now: Date,
	knownResetAt: Date | null = null,
): ChatGptPlanWindow {
	const sorted = calls
		.filter((call) => call.createdAt.getTime() <= now.getTime())
		.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
	const lastRequestAt = sorted.at(-1)?.createdAt ?? null;
	const knownReset = knownResetAt?.getTime() ?? null;
	if (knownReset !== null && knownReset > now.getTime()) {
		const start = knownReset - CHATGPT_PLAN_WINDOW_MS;
		return windowOf(
			sorted.filter((call) => call.createdAt.getTime() >= start),
			start,
			lastRequestAt,
		);
	}
	const chain =
		knownReset === null
			? sorted
			: sorted.filter((call) => call.createdAt.getTime() >= knownReset);
	if (chain.length === 0) {
		return emptyWindow(lastRequestAt);
	}
	let start = chain[0].createdAt.getTime();
	let firstIndex = 0;
	chain.forEach((call, index) => {
		if (call.createdAt.getTime() >= start + CHATGPT_PLAN_WINDOW_MS) {
			start = call.createdAt.getTime();
			firstIndex = index;
		}
	});
	if (now.getTime() >= start + CHATGPT_PLAN_WINDOW_MS) {
		return emptyWindow(lastRequestAt);
	}
	return windowOf(chain.slice(firstIndex), start, lastRequestAt);
}

const CALL_SELECT = {
	createdAt: true,
	inputTokens: true,
	cachedInputTokens: true,
	outputTokens: true,
	jobType: true,
	featureKey: true,
	providerModelId: true,
	userId: true,
} as const;

const RESET_STATE_SELECT = {
	sourceId: true,
	resetAt: true,
	lastExhaustedAt: true,
	consecutiveUnknownResets: true,
} as const;

/** The lookback's start: two windows back, or a known reset before that. */
function lookbackStart(now: Date, knownResetAt: Date | null): number {
	const lookback = now.getTime() - WINDOW_LOOKBACK_MS;
	return knownResetAt ? Math.min(lookback, knownResetAt.getTime()) : lookback;
}

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
	const states = await db.chatGptPlanSourceState.findMany({
		where: { sourceKind: "ORG", sourceId: { in: params.accountIds } },
		select: RESET_STATE_SELECT,
	});
	const knownResets = new Map(
		states.map((state) => [
			state.sourceId,
			chatGptPlanKnownWindowReset(state, now),
		]),
	);
	const since = new Map(
		params.accountIds.map((accountId) => [
			accountId,
			lookbackStart(now, knownResets.get(accountId) ?? null),
		]),
	);
	const rows = await db.aiUsageLog.findMany({
		where: {
			organizationId: params.organizationId,
			provider: "OPENAI_CHATGPT_PLAN",
			providerConfigId: { in: params.accountIds },
			createdAt: { gte: new Date(Math.min(...since.values())) },
		},
		select: { ...CALL_SELECT, providerConfigId: true },
	});
	return new Map(
		params.accountIds.map((accountId) => [
			accountId,
			computeChatGptPlanWindow(
				rows.filter(
					(row) =>
						row.providerConfigId === accountId &&
						row.createdAt.getTime() >=
							(since.get(accountId) ?? now.getTime()),
				),
				now,
				knownResets.get(accountId) ?? null,
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
	const state = await db.chatGptPlanSourceState.findUnique({
		where: {
			sourceKind_sourceId: {
				sourceKind: "USER",
				sourceId: params.userId,
			},
		},
		select: RESET_STATE_SELECT,
	});
	const knownResetAt = chatGptPlanKnownWindowReset(state, now);
	const rows = await db.aiUsageLog.findMany({
		where: {
			userId: params.userId,
			provider: "OPENAI_CHATGPT_PLAN",
			providerConfigId: null,
			createdAt: { gte: new Date(lookbackStart(now, knownResetAt)) },
		},
		select: CALL_SELECT,
	});
	return computeChatGptPlanWindow(rows, now, knownResetAt);
}

/** The share of the budget a window has used, 0–100. */
export function chatGptPlanWindowPercent(
	window: ChatGptPlanWindow,
	budget: number,
): number {
	return budget > 0
		? Math.min(100, Math.round((window.weightedInputTokens / budget) * 100))
		: 0;
}

/**
 * {@link chatGptPlanWindowPercent} without the cap at 100, unrounded: how far
 * past its budget the estimate went is what accuracy tracking measures.
 */
export function chatGptPlanWindowPercentUncapped(
	weightedInputTokens: number,
	budget: number,
): number {
	return budget > 0 ? (weightedInputTokens / budget) * 100 : 0;
}

/** A window that has reset, as the chain of calls shows it. */
export interface ChatGptPlanClosedWindow {
	windowStart: Date;
	resetsAt: Date;
	weightedInputTokens: number;
}

/**
 * The windows among `calls` that have reset by `now`, chained like
 * {@link computeChatGptPlanWindow}. Only windows whose start is exact are
 * returned: one opened after five quiet hours (counting from `lookbackStart`
 * for the first), or chained from such a window. An account in continuous
 * use has none — its chain starts mid-window and every later start inherits
 * that guess, which would overstate a window and teach a false lower bound.
 */
export function closedChatGptPlanWindows(
	calls: ChatGptPlanWindowCall[],
	now: Date,
	lookbackStart: Date,
): ChatGptPlanClosedWindow[] {
	const sorted = calls
		.filter(
			(call) =>
				call.createdAt.getTime() >= lookbackStart.getTime() &&
				call.createdAt.getTime() <= now.getTime(),
		)
		.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
	const windows: Array<ChatGptPlanClosedWindow & { exact: boolean }> = [];
	let lastCallAt: number | null = null;
	for (const call of sorted) {
		const at = call.createdAt.getTime();
		const current = windows.at(-1);
		if (current && at < current.resetsAt.getTime()) {
			current.weightedInputTokens += weighted(call);
			lastCallAt = at;
			continue;
		}
		// A start is exact after five quiet hours, or when it chains from an
		// exact window; one chained from a guessed start inherits the guess.
		const afterQuietGap =
			lastCallAt === null
				? at >= lookbackStart.getTime() + CHATGPT_PLAN_WINDOW_MS
				: at - lastCallAt >= CHATGPT_PLAN_WINDOW_MS;
		windows.push({
			windowStart: new Date(at),
			resetsAt: new Date(at + CHATGPT_PLAN_WINDOW_MS),
			weightedInputTokens: weighted(call),
			exact: afterQuietGap || (current?.exact ?? false),
		});
		lastCallAt = at;
	}
	return windows
		.filter(
			(window) =>
				window.exact && window.resetsAt.getTime() <= now.getTime(),
		)
		.map(({ exact: _exact, ...window }) => window);
}
