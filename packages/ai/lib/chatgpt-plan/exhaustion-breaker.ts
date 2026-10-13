import { SubscriptionPlanExhaustedError } from "@repo/agent-types/chatgpt-plan-fetch";
import {
	type ChatGptPlanReportedUsage,
	type ChatGptPlanSourceState,
	chatGptPlanReportedUsage,
	getChatGptPlanOrgAccountWindows,
	getChatGptPlanSourceStates,
	getChatGptPlanWindowCalibrations,
	markChatGptPlanSourceAnswered,
	recordChatGptPlanBudgetObservation,
	recordChatGptPlanRefusalAccuracy,
	recordChatGptPlanSourceExhausted as storeChatGptPlanSourceExhausted,
} from "@repo/database";
import { logger } from "@repo/logs";
import {
	type PlanSourceRef,
	planSourceKey,
	planSourceLogFields,
	planSourceStateKey,
} from "./sources";

/**
 * Memory of a spent ChatGPT plan window, per plan source (Fizzy #2939,
 * #2770), so the calls that follow fail at once instead of each asking
 * OpenAI for the same refusal.
 *
 * The truth lives in Postgres (`ChatGptPlanSourceState`), shared by every web
 * and worker process: one refusal anywhere stops them all. Each write names
 * the sign-in whose call it describes, and is dropped once the source has
 * another (Fizzy #3037). This module keeps a short read-through cache of it,
 * and the synchronous {@link chatGptPlanExhaustedError} answers from that
 * cache alone. A database
 * fault reads as "not spent", on a read or a write: the call is tried, and
 * OpenAI's own refusal is the ground truth either way.
 */

// When OpenAI gives no reset time for a member's own plan, how long to stop
// asking before trying again. Short: the member may also be watching.
const UNKNOWN_RESET_PAUSE_MS = 15 * 60_000;

// An organization account is shared by background work that can wait, so it
// backs off further: 30 minutes, doubling per refusal in a row, up to the
// length of a whole Plus window.
const ORG_FIRST_UNKNOWN_PAUSE_MS = 30 * 60_000;
const PLAN_WINDOW_MS = 5 * 60 * 60_000;

const STATE_CACHE_MS = 30_000;

// A refusal while the estimate said less than this percent is logged.
const CHATGPT_PLAN_EARLY_REFUSAL_WARN_PERCENT = 70;

// How far past Fabric's estimate of the window's reset OpenAI's reset may
// fall and still be this window's.
const WINDOW_RESET_TOLERANCE_MS = 10 * 60_000;

interface CachedState {
	openUntil: number | null;
	resetAt: Date | null;
	consecutiveUnknownResets: number;
	/** Whether a refusal is recorded, so a recovered source knows to clear it. */
	stored: boolean;
	fetchedAt: number;
	/** The source's generation when this entry was stored. */
	generation: number;
	/** The row as read, for the usage OpenAI last reported; null when not read. */
	row?: ChatGptPlanSourceState | null;
}

const cache = new Map<string, CachedState>();
// Bumped whenever this process's view of a source changes: a new sign-in, a
// recorded refusal, a recovery. Every entry is stamped with the generation it
// was stored under and {@link currentEntry} ignores any other, so a bump
// invalidates whatever was cached before it, including an entry a read stored
// moments earlier (Fizzy #3037).
const generations = new Map<string, number>();

function generationOf(key: string): number {
	return generations.get(key) ?? 0;
}

function bumpGeneration(key: string): void {
	generations.set(key, generationOf(key) + 1);
}

/**
 * The cached state, only if it was stored under the source's current
 * generation; every read of {@link cache} goes through here.
 */
function currentEntry(key: string): CachedState | undefined {
	const entry = cache.get(key);
	return entry?.generation === generationOf(key) ? entry : undefined;
}

/**
 * The sentence every surface shows — chat, toasts and the document's stored
 * failure — so it names the reset as a clock time, which stays true however
 * late it is read.
 */
export function chatGptPlanExhaustedMessage(resetAt: Date | null): string {
	if (!resetAt) {
		return "Your ChatGPT plan has no usage left in this window. Wait for it to reset, then try again.";
	}
	const at = resetAt.toISOString().slice(0, 16).replace("T", " ");
	return `Your ChatGPT plan has no usage left in this window. It resets at ${at} UTC.`;
}

function errorWhileOpen(
	state: CachedState | undefined,
	now: number,
): SubscriptionPlanExhaustedError | null {
	if (!state?.openUntil || now >= state.openUntil) {
		return null;
	}
	return new SubscriptionPlanExhaustedError(
		chatGptPlanExhaustedMessage(state.resetAt),
		state.resetAt,
	);
}

async function readState(
	ref: PlanSourceRef,
	now: number,
): Promise<CachedState | undefined> {
	const key = planSourceKey(ref);
	const cached = currentEntry(key);
	if (cached && now - cached.fetchedAt < STATE_CACHE_MS) {
		return cached;
	}
	const { sourceKind, sourceId } = planSourceStateKey(ref);
	const generation = generationOf(key);
	try {
		const [row] = await getChatGptPlanSourceStates(sourceKind, [sourceId]);
		const state: CachedState = {
			openUntil: row?.openUntil?.getTime() ?? null,
			resetAt: row?.resetAt ?? null,
			consecutiveUnknownResets: row?.consecutiveUnknownResets ?? 0,
			stored:
				row !== undefined &&
				(row.openUntil !== null || row.consecutiveUnknownResets > 0),
			fetchedAt: now,
			generation,
			row: row ?? null,
		};
		// Kept only if nothing changed the source while it was read.
		if (generationOf(key) === generation) {
			cache.set(key, state);
		}
		return state;
	} catch (error) {
		logger.warn("[chatgpt-plan] Reading the plan's window state failed", {
			...planSourceLogFields(ref),
			error: error instanceof Error ? error.message : String(error),
		});
		return currentEntry(key);
	}
}

/**
 * The error to fail fast with while this source's window is known to be
 * spent, by any process; null otherwise.
 */
export async function chatGptPlanSourceExhaustedError(
	ref: PlanSourceRef,
	now = Date.now(),
): Promise<SubscriptionPlanExhaustedError | null> {
	return errorWhileOpen(await readState(ref, now), now);
}

/**
 * The usage OpenAI last reported for this source, from the same cached read
 * as {@link chatGptPlanSourceExhaustedError}; null when none was stored.
 */
export async function chatGptPlanSourceReportedUsage(
	ref: PlanSourceRef,
	now = Date.now(),
): Promise<ChatGptPlanReportedUsage | null> {
	return chatGptPlanReportedUsage(
		(await readState(ref, now))?.row,
		new Date(now),
	);
}

/**
 * {@link chatGptPlanSourceExhaustedError} for a member's own plan, from this
 * process's cache alone — for a caller that already saw the refusal and only
 * needs its typed error back.
 */
export function chatGptPlanExhaustedError(
	userId: string,
	now = Date.now(),
): SubscriptionPlanExhaustedError | null {
	return errorWhileOpen(
		currentEntry(planSourceKey({ kind: "user", userId })),
		now,
	);
}

/**
 * How long a source stays closed after a refusal with no reset time. An
 * organization account's first such refusal trusts Fabric's own ledger — the
 * reset of the anchored window its calls show — and every refusal in a row
 * after that backs off instead, since the ledger misses whatever else spends
 * the account.
 */
async function unknownResetPause(
	ref: PlanSourceRef,
	previousUnknownResets: number,
	now: number,
): Promise<{ openUntil: number; resetAt: Date | null }> {
	if (ref.kind === "user") {
		return { openUntil: now + UNKNOWN_RESET_PAUSE_MS, resetAt: null };
	}
	if (previousUnknownResets === 0) {
		const windows = await getChatGptPlanOrgAccountWindows({
			organizationId: ref.organizationId,
			accountIds: [ref.accountId],
			now: new Date(now),
		}).catch(() => null);
		const estimate =
			windows?.get(ref.accountId)?.resetsAt?.getTime() ?? null;
		if (estimate !== null && estimate > now) {
			return { openUntil: estimate, resetAt: new Date(estimate) };
		}
	}
	const pause = Math.min(
		ORG_FIRST_UNKNOWN_PAUSE_MS * 2 ** previousUnknownResets,
		PLAN_WINDOW_MS,
	);
	return { openUntil: now + pause, resetAt: null };
}

/**
 * Closes the source until its window resets: in Postgres for every process,
 * then in this one. `credentialFingerprint` is the sign-in whose call was
 * refused (Fizzy #3037); a refusal from a sign-in the source no longer has is
 * dropped, in Postgres and here, and so is one whose sign-in is unknown. A
 * failed write is logged, never thrown — the caller is already reporting the
 * refusal itself — and closes nothing, here either: without Postgres nothing
 * shows the sign-in is still the source's.
 */
export function recordChatGptPlanSourceExhausted(
	ref: PlanSourceRef,
	credentialFingerprint: string | undefined,
	error: SubscriptionPlanExhaustedError,
	now = Date.now(),
): Promise<void> {
	if (credentialFingerprint === undefined) {
		logger.warn(
			"[chatgpt-plan] Not recording a refusal from an unknown sign-in",
			planSourceLogFields(ref),
		);
		return Promise.resolve();
	}
	return recordExhausted(ref, error, {
		now,
		observeBudget: true,
		credentialFingerprint,
	});
}

/**
 * {@link recordChatGptPlanSourceExhausted} for a refusal another service
 * reported (an agent's): it closes the source the same way, but teaches no
 * budget — the reporter's call never went through this window's ledger. A
 * null `credentialFingerprint` is a reporter that does not say which sign-in
 * it used; the source's current sign-in, if any, is closed.
 */
export function recordReportedChatGptPlanSourceExhausted(
	ref: PlanSourceRef,
	error: SubscriptionPlanExhaustedError,
	credentialFingerprint: string | null,
): Promise<void> {
	return recordExhausted(ref, error, {
		now: Date.now(),
		observeBudget: false,
		credentialFingerprint,
	});
}

async function recordExhausted(
	ref: PlanSourceRef,
	error: SubscriptionPlanExhaustedError,
	{
		now,
		observeBudget,
		credentialFingerprint,
	}: {
		now: number;
		observeBudget: boolean;
		credentialFingerprint: string | null;
	},
): Promise<void> {
	const key = planSourceKey(ref);
	const generation = generationOf(key);
	const previous = currentEntry(key)?.consecutiveUnknownResets ?? 0;
	const previousRow = currentEntry(key)?.row;
	const pause = error.resetAt
		? { openUntil: error.resetAt.getTime(), resetAt: error.resetAt }
		: await unknownResetPause(ref, previous, now);
	const consecutiveUnknownResets = error.resetAt ? 0 : previous + 1;
	let recorded: boolean;
	try {
		recorded = await storeChatGptPlanSourceExhausted({
			...planSourceStateKey(ref),
			openUntil: new Date(pause.openUntil),
			resetAt: pause.resetAt,
			consecutiveUnknownResets,
			exhaustedAt: new Date(now),
			credentialFingerprint,
		});
	} catch (writeError) {
		// Nothing proved the sign-in is still the source's, so nothing is
		// cached: the next call is tried, and OpenAI refuses it again if the
		// window is still spent. The write may still have landed, so a read
		// that began before it must not be cached either.
		bumpGeneration(key);
		logger.warn("[chatgpt-plan] Recording a spent plan window failed", {
			...planSourceLogFields(ref),
			error:
				writeError instanceof Error
					? writeError.message
					: String(writeError),
		});
		return;
	}
	if (!recorded) {
		logger.info(
			"[chatgpt-plan] Dropped a refusal from a replaced sign-in",
			planSourceLogFields(ref),
		);
		return;
	}
	// The write landed: the bump retires anything cached before it. This
	// refusal is cached, unless the source changed here since it began: that
	// change may be a sign-in replacement that cleared or fenced the row, so
	// the next read asks Postgres instead.
	const unchanged = generationOf(key) === generation;
	bumpGeneration(key);
	if (unchanged) {
		cache.set(key, {
			...pause,
			consecutiveUnknownResets,
			stored: true,
			fetchedAt: now,
			generation: generationOf(key),
			row: previousRow,
		});
	}
	if (observeBudget && credentialFingerprint !== null) {
		await observeWindowBudget(ref, error, now, credentialFingerprint);
	}
}

/**
 * Calibration (Fizzy #2770 D6): what a shared account's open window had used
 * when OpenAI refused it is one observation of its real budget. Organization
 * accounts only: a member's own plan is also used outside Fabric, so Fabric's
 * share of its window says little about the allowance. Best effort, like the
 * state write above.
 */
async function observeWindowBudget(
	ref: PlanSourceRef,
	error: SubscriptionPlanExhaustedError,
	now: number,
	credentialFingerprint: string,
): Promise<void> {
	if (ref.kind !== "org") {
		return;
	}
	try {
		const at = new Date(now);
		const window = (
			await getChatGptPlanOrgAccountWindows({
				organizationId: ref.organizationId,
				accountIds: [ref.accountId],
				now: at,
			})
		).get(ref.accountId);
		// Only a five-hour-window refusal measures the window. One that
		// resets well after this window would (the weekly cap) says nothing
		// about it, and would teach a budget far too small.
		if (
			error.resetAt &&
			window?.resetsAt &&
			error.resetAt.getTime() >
				window.resetsAt.getTime() + WINDOW_RESET_TOLERANCE_MS
		) {
			return;
		}
		// Read before this refusal teaches the budget anything.
		const budgetBefore = await budgetBeforeRefusal(ref);
		if (window?.windowStart && window.weightedInputTokens > 0) {
			await recordChatGptPlanBudgetObservation({
				source: ref,
				windowStart: window.windowStart,
				inputTokens: window.weightedInputTokens,
				observedAt: at,
				credentialFingerprint,
			});
		}
		await recordRefusalAccuracy(ref, {
			at,
			windowStart: window?.windowStart ?? at,
			weightedInputTokens: window?.weightedInputTokens ?? 0,
			budget: budgetBefore,
		});
	} catch (error) {
		logger.warn(
			"[chatgpt-plan] Recording a window budget observation failed",
			{
				...planSourceLogFields(ref),
				error: error instanceof Error ? error.message : String(error),
			},
		);
	}
}

/** The account's budget as it stands; null when it cannot be read. */
async function budgetBeforeRefusal(
	ref: Extract<PlanSourceRef, { kind: "org" }>,
): Promise<number | null> {
	try {
		const calibrations = await getChatGptPlanWindowCalibrations("ORG", [
			ref.accountId,
		]);
		return calibrations.get(ref.accountId)?.budget ?? null;
	} catch {
		return null;
	}
}

/**
 * Accuracy (Fizzy #2770): what the estimate said, uncapped, when OpenAI
 * refused — logged when it was well short of the budget. Best effort, apart
 * from the calibration it follows.
 */
async function recordRefusalAccuracy(
	ref: Extract<PlanSourceRef, { kind: "org" }>,
	refusal: {
		at: Date;
		windowStart: Date;
		weightedInputTokens: number;
		budget: number | null;
	},
): Promise<void> {
	const { budget } = refusal;
	if (budget === null || budget <= 0) {
		return;
	}
	const estimatePercent = (refusal.weightedInputTokens / budget) * 100;
	if (estimatePercent < CHATGPT_PLAN_EARLY_REFUSAL_WARN_PERCENT) {
		logger.warn(
			"[chatgpt-plan] OpenAI refused a shared account well below its estimated budget",
			{
				...planSourceLogFields(ref),
				estimatePercent: Math.round(estimatePercent),
				budget,
			},
		);
	}
	try {
		await recordChatGptPlanRefusalAccuracy({
			sourceKind: "ORG",
			sourceId: ref.accountId,
			windowStart: refusal.windowStart,
			budget,
			estimatePercent,
			refusedAt: refusal.at,
		});
	} catch (error) {
		logger.warn("[chatgpt-plan] Recording a refusal's accuracy failed", {
			...planSourceLogFields(ref),
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/** {@link recordChatGptPlanSourceExhausted} for a member's own plan. */
export function recordChatGptPlanExhausted(
	userId: string,
	credentialFingerprint: string | undefined,
	error: SubscriptionPlanExhaustedError,
	now = Date.now(),
): Promise<void> {
	return recordChatGptPlanSourceExhausted(
		{ kind: "user", userId },
		credentialFingerprint,
		error,
		now,
	);
}

/**
 * The source answered: forget the spent window and the refusal count, so the
 * next unknown reset starts from the shortest pause again. OpenAI's reset is
 * kept as the next window's anchor. Free when nothing was recorded, which is
 * every call but the first after a window resets. Postgres is cleared only
 * while the source still has the sign-in that answered (Fizzy #3037).
 */
export async function noteChatGptPlanSourceAnswered(
	ref: PlanSourceRef,
	credentialFingerprint: string | undefined,
): Promise<void> {
	const key = planSourceKey(ref);
	if (currentEntry(key)?.stored !== true) {
		return;
	}
	invalidateChatGptPlanSourceExhaustion(ref);
	if (credentialFingerprint === undefined) {
		return;
	}
	let cleared = true;
	try {
		cleared = await markChatGptPlanSourceAnswered(
			planSourceStateKey(ref),
			credentialFingerprint,
		);
	} catch {
		// It may still have landed.
	}
	if (cleared) {
		// Retires the spent row a read cached before the clear landed.
		bumpGeneration(key);
	}
}

export function __resetChatGptPlanBreaker(): void {
	cache.clear();
	generations.clear();
}

/** Reload this source's durable state on its next read. */
export function invalidateChatGptPlanSourceExhaustion(
	source: PlanSourceRef,
): void {
	const key = planSourceKey(source);
	bumpGeneration(key);
	// The bump already retires the entry; deleting it frees it now, since a
	// disconnected source may never be read again.
	cache.delete(key);
}
