/**
 * A ChatGPT plan's usage as OpenAI itself reports it (Fizzy #2770), in the
 * rate-limit headers Codex reads from the same plan backend
 * (`x-codex-primary-used-percent` and its siblings). Where a recent report
 * exists it is the truth, and Fabric's own estimate
 * (`chatgpt-plan-window.ts`) is the fallback.
 *
 * Stored on `ChatGptPlanSourceState`, keyed by source with no
 * `organizationId`, like the rest of that row: callers pass only sources they
 * already resolved.
 */

import type { ChatGptPlanSourceState } from "../generated/client";
import type { ChatGptPlanSourceKey } from "./chatgpt-plan-source-state";
import { withChatGptPlanCredentialFence } from "./lib/chatgpt-plan-credential-fence";

/** One limit window as reported: percent used, its length, when it resets. */
export interface ChatGptPlanReportedLimit {
	usedPercent: number;
	windowMinutes: number | null;
	resetsAt: Date | null;
}

/** Both limits one reply reported; either may be missing. */
export interface ChatGptPlanReportedLimits {
	primary: ChatGptPlanReportedLimit | null;
	secondary: ChatGptPlanReportedLimit | null;
}

/** A report this old no longer describes the window. */
export const CHATGPT_PLAN_REPORTED_FRESH_MS = 15 * 60_000;

/**
 * The longest limit window still read as the short ("5h") one: Codex lists
 * the short window as primary and the weekly one as secondary, but a plan
 * with no five-hour window (Pro) may report only the weekly one, so the
 * length decides, not the position.
 */
const SHORT_WINDOW_MAX_MINUTES = 12 * 60;

type ReportedColumns = Pick<
	ChatGptPlanSourceState,
	| "reportedPrimaryUsedPercent"
	| "reportedPrimaryWindowMinutes"
	| "reportedPrimaryResetAt"
	| "reportedSecondaryUsedPercent"
	| "reportedSecondaryWindowMinutes"
	| "reportedSecondaryResetAt"
	| "reportedAt"
>;

/** What OpenAI last reported for a source, sorted into its two limits. */
export interface ChatGptPlanReportedUsage {
	/** The short ("5h") window. */
	window: ChatGptPlanReportedLimit | null;
	/** The weekly limit. */
	weekly: ChatGptPlanReportedLimit | null;
	observedAt: Date;
	/**
	 * The short window's report still holds: it is under
	 * {@link CHATGPT_PLAN_REPORTED_FRESH_MS} old and the window has not reset
	 * since. Only then may it stand in for the estimate.
	 */
	windowFresh: boolean;
}

function limitOf(
	usedPercent: number | null,
	windowMinutes: number | null,
	resetsAt: Date | null,
): ChatGptPlanReportedLimit | null {
	return usedPercent === null
		? null
		: { usedPercent, windowMinutes, resetsAt };
}

/** Whether a limit is the short window: by its length, else by its position. */
function isShortWindow(
	limit: ChatGptPlanReportedLimit,
	positionIsShort: boolean,
): boolean {
	return limit.windowMinutes === null
		? positionIsShort
		: limit.windowMinutes <= SHORT_WINDOW_MAX_MINUTES;
}

/** Two reported limits sorted into the short window and the weekly one. */
export function sortChatGptPlanReportedLimits(
	limits: ChatGptPlanReportedLimits,
): {
	window: ChatGptPlanReportedLimit | null;
	weekly: ChatGptPlanReportedLimit | null;
} {
	const positioned = [
		{ limit: limits.primary, positionIsShort: true },
		{ limit: limits.secondary, positionIsShort: false },
	];
	return {
		window:
			positioned.find(
				({ limit, positionIsShort }) =>
					limit && isShortWindow(limit, positionIsShort),
			)?.limit ?? null,
		weekly:
			positioned.find(
				({ limit, positionIsShort }) =>
					limit && !isShortWindow(limit, positionIsShort),
			)?.limit ?? null,
	};
}

/** A source's stored report, sorted and judged for freshness; null with none. */
export function chatGptPlanReportedUsage(
	state: Partial<ReportedColumns> | null | undefined,
	now: Date,
): ChatGptPlanReportedUsage | null {
	if (!state?.reportedAt) {
		return null;
	}
	const { window, weekly } = sortChatGptPlanReportedLimits({
		primary: limitOf(
			state.reportedPrimaryUsedPercent ?? null,
			state.reportedPrimaryWindowMinutes ?? null,
			state.reportedPrimaryResetAt ?? null,
		),
		secondary: limitOf(
			state.reportedSecondaryUsedPercent ?? null,
			state.reportedSecondaryWindowMinutes ?? null,
			state.reportedSecondaryResetAt ?? null,
		),
	});
	const windowFresh =
		window !== null &&
		now.getTime() - state.reportedAt.getTime() <
			CHATGPT_PLAN_REPORTED_FRESH_MS &&
		(window.resetsAt === null || window.resetsAt.getTime() > now.getTime());
	return { window, weekly, observedAt: state.reportedAt, windowFresh };
}

/**
 * Stores what a reply reported, unless the source's sign-in changed since
 * the call read its token (Fizzy #3037). True when it was stored. Creating
 * the row touches no breaker field: a report is not a refusal.
 */
export function recordChatGptPlanReportedUsage(
	input: ChatGptPlanSourceKey & {
		limits: ChatGptPlanReportedLimits;
		observedAt: Date;
		credentialFingerprint: string;
	},
): Promise<boolean> {
	const { sourceKind, sourceId, limits, observedAt } = input;
	const data = {
		reportedPrimaryUsedPercent: limits.primary?.usedPercent ?? null,
		reportedPrimaryWindowMinutes: limits.primary?.windowMinutes ?? null,
		reportedPrimaryResetAt: limits.primary?.resetsAt ?? null,
		reportedSecondaryUsedPercent: limits.secondary?.usedPercent ?? null,
		reportedSecondaryWindowMinutes: limits.secondary?.windowMinutes ?? null,
		reportedSecondaryResetAt: limits.secondary?.resetsAt ?? null,
		reportedAt: observedAt,
	};
	return withChatGptPlanCredentialFence(
		{ sourceKind, sourceId },
		input.credentialFingerprint,
		(tx) =>
			tx.chatGptPlanSourceState.upsert({
				where: { sourceKind_sourceId: { sourceKind, sourceId } },
				create: { sourceKind, sourceId, ...data },
				update: data,
			}),
	);
}
