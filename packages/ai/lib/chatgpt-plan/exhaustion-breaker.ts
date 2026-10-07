import { SubscriptionPlanExhaustedError } from "@repo/agent-types/chatgpt-plan-fetch";
import {
	clearChatGptPlanSourceState,
	getChatGptPlanOrgAccountFirstUseSince,
	getChatGptPlanSourceStates,
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
 * and worker process: one refusal anywhere stops them all. This module keeps
 * a short read-through cache of it, and the synchronous
 * {@link chatGptPlanExhaustedError} answers from that cache alone. A database
 * fault reads as "not spent": the call is tried, and OpenAI's own refusal is
 * the ground truth either way.
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

interface CachedState {
	openUntil: number | null;
	resetAt: Date | null;
	consecutiveUnknownResets: number;
	/** Whether a row exists, so a recovered source knows to clear it. */
	stored: boolean;
	fetchedAt: number;
}

const cache = new Map<string, CachedState>();

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
	const cached = cache.get(key);
	if (cached && now - cached.fetchedAt < STATE_CACHE_MS) {
		return cached;
	}
	const { sourceKind, sourceId } = planSourceStateKey(ref);
	try {
		const [row] = await getChatGptPlanSourceStates(sourceKind, [sourceId]);
		const state: CachedState = {
			openUntil: row?.openUntil?.getTime() ?? null,
			resetAt: row?.resetAt ?? null,
			consecutiveUnknownResets: row?.consecutiveUnknownResets ?? 0,
			stored: row !== undefined,
			fetchedAt: now,
		};
		cache.set(key, state);
		return state;
	} catch (error) {
		logger.warn("[chatgpt-plan] Reading the plan's window state failed", {
			...planSourceLogFields(ref),
			error: error instanceof Error ? error.message : String(error),
		});
		return cached;
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
 * {@link chatGptPlanSourceExhaustedError} for a member's own plan, from this
 * process's cache alone — for a caller that already saw the refusal and only
 * needs its typed error back.
 */
export function chatGptPlanExhaustedError(
	userId: string,
	now = Date.now(),
): SubscriptionPlanExhaustedError | null {
	return errorWhileOpen(
		cache.get(planSourceKey({ kind: "user", userId })),
		now,
	);
}

/**
 * How long a source stays closed after a refusal with no reset time. An
 * organization account's first such refusal trusts Fabric's own ledger — the
 * window started with its oldest call in the last five hours — and every
 * refusal in a row after that backs off instead, since the ledger misses
 * whatever else spends the account.
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
		const firstUse = await getChatGptPlanOrgAccountFirstUseSince({
			organizationId: ref.organizationId,
			accountId: ref.accountId,
			since: new Date(now - PLAN_WINDOW_MS),
		}).catch(() => null);
		const estimate = firstUse ? firstUse.getTime() + PLAN_WINDOW_MS : null;
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
 * Closes the source until its window resets: in this process at once, then
 * for every process through Postgres. A failed write is logged, never thrown —
 * the caller is already reporting the refusal itself.
 */
export async function recordChatGptPlanSourceExhausted(
	ref: PlanSourceRef,
	error: SubscriptionPlanExhaustedError,
	now = Date.now(),
): Promise<void> {
	const key = planSourceKey(ref);
	const previous = cache.get(key)?.consecutiveUnknownResets ?? 0;
	const pause = error.resetAt
		? { openUntil: error.resetAt.getTime(), resetAt: error.resetAt }
		: await unknownResetPause(ref, previous, now);
	const consecutiveUnknownResets = error.resetAt ? 0 : previous + 1;
	cache.set(key, {
		...pause,
		consecutiveUnknownResets,
		stored: true,
		fetchedAt: now,
	});
	try {
		await storeChatGptPlanSourceExhausted({
			...planSourceStateKey(ref),
			openUntil: new Date(pause.openUntil),
			resetAt: pause.resetAt,
			consecutiveUnknownResets,
			exhaustedAt: new Date(now),
		});
	} catch (writeError) {
		logger.warn("[chatgpt-plan] Recording a spent plan window failed", {
			...planSourceLogFields(ref),
			error:
				writeError instanceof Error
					? writeError.message
					: String(writeError),
		});
	}
}

/** {@link recordChatGptPlanSourceExhausted} for a member's own plan. */
export function recordChatGptPlanExhausted(
	userId: string,
	error: SubscriptionPlanExhaustedError,
	now = Date.now(),
): Promise<void> {
	return recordChatGptPlanSourceExhausted(
		{ kind: "user", userId },
		error,
		now,
	);
}

/**
 * The source answered: forget any spent window and the refusal count, so the
 * next unknown reset starts from the shortest pause again. Free when nothing
 * was recorded, which is every call but the first after a window resets.
 */
export async function noteChatGptPlanSourceAnswered(
	ref: PlanSourceRef,
): Promise<void> {
	const key = planSourceKey(ref);
	if (cache.get(key)?.stored !== true) {
		return;
	}
	cache.delete(key);
	try {
		await clearChatGptPlanSourceState(planSourceStateKey(ref));
	} catch {}
}

export function __resetChatGptPlanBreaker(): void {
	cache.clear();
}
