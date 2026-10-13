import {
	type ChatGptPlanReportedLimit,
	type ChatGptPlanReportedLimits,
	chatGptPlanWindowPercentUncapped,
	getChatGptPlanWindowCalibrations,
	recordChatGptPlanReportedAccuracy,
	recordChatGptPlanReportedUsage,
	settleChatGptPlanAccountWindows,
	sortChatGptPlanReportedLimits,
} from "@repo/database";
import { logger } from "@repo/logs";
import {
	type PlanSourceRef,
	planSourceKey,
	planSourceLogFields,
	planSourceStateKey,
} from "./sources";
import { getCachedChatGptPlanOrgAccountWindows } from "./window-cache";

/**
 * The plan's own usage report (Fizzy #2770): the rate-limit headers the
 * ChatGPT plan backend sends Codex on every streamed reply and on a
 * usage-limit 429 — `openai/codex` `codex-rs/codex-api/src/rate_limits.rs`
 * reads `x-codex-{primary,secondary}-{used-percent,window-minutes,reset-at}`
 * (reset-at in epoch seconds). Whether the Responses route Fabric calls sends
 * them too is not documented; when it does not, nothing is stored and every
 * reader keeps Fabric's estimate.
 */

/** A drift this large between the estimate and OpenAI's report is logged. */
const CHATGPT_PLAN_DRIFT_WARN_POINTS = 25;
/** A window that reset unrefused after the estimate passed this is logged. */
const CHATGPT_PLAN_OVERSHOOT_WARN_PERCENT = 130;

/** Between two stored reports from one process, unless the usage moved or a 429. */
const REPORT_WRITE_INTERVAL_MS = 60_000;
const REPORT_WRITE_MIN_CHANGE_POINTS = 5;
/** Between two settling passes over one account, per process. */
const SETTLE_INTERVAL_MS = 10 * 60_000;
/** Between two `chatgpt-plan.usage-headers` lines for one source, per process. */
const DIAGNOSTICS_INTERVAL_MS = 10 * 60_000;

function headerNumber(headers: Headers, name: string): number | null {
	const raw = headers.get(name);
	if (raw === null || raw.trim() === "") {
		return null;
	}
	const value = Number(raw.trim());
	return Number.isFinite(value) ? value : null;
}

function parseLimit(
	headers: Headers,
	prefix: string,
	now: number,
): ChatGptPlanReportedLimit | null {
	const usedPercent = headerNumber(headers, `${prefix}-used-percent`);
	if (usedPercent === null) {
		return null;
	}
	const minutes = headerNumber(headers, `${prefix}-window-minutes`);
	const windowMinutes =
		minutes !== null && Number.isInteger(minutes) ? minutes : null;
	const resetAtSeconds = headerNumber(headers, `${prefix}-reset-at`);
	const resetAfterSeconds = headerNumber(
		headers,
		`${prefix}-reset-after-seconds`,
	);
	const resetsAt =
		resetAtSeconds !== null && resetAtSeconds > 0
			? new Date(resetAtSeconds * 1000)
			: resetAfterSeconds !== null && resetAfterSeconds >= 0
				? new Date(now + resetAfterSeconds * 1000)
				: null;
	// Codex's own rule: a zero percent with no window and no reset says nothing.
	const hasData =
		usedPercent !== 0 ||
		(windowMinutes !== null && windowMinutes !== 0) ||
		resetsAt !== null;
	return hasData ? { usedPercent, windowMinutes, resetsAt } : null;
}

/** The usage a reply's headers report; null when they report none. */
export function parseChatGptPlanRateLimitHeaders(
	headers: Headers,
	now = Date.now(),
): ChatGptPlanReportedLimits | null {
	const primary = parseLimit(headers, "x-codex-primary", now);
	const secondary = parseLimit(headers, "x-codex-secondary", now);
	return primary || secondary ? { primary, secondary } : null;
}

const lastWrites = new Map<string, { at: number; percent: number | null }>();
const lastSettles = new Map<string, number>();
const lastDiagnostics = new Map<string, number>();

/** Whether this report is worth a write: the first, a 429, a move, or a minute on. */
function shouldWrite(
	key: string,
	limits: ChatGptPlanReportedLimits,
	status: number,
	now: number,
): boolean {
	const percent = limits.primary?.usedPercent ?? null;
	const last = lastWrites.get(key);
	const due =
		!last ||
		status === 429 ||
		now - last.at >= REPORT_WRITE_INTERVAL_MS ||
		percent === null ||
		last.percent === null ||
		Math.abs(percent - last.percent) >= REPORT_WRITE_MIN_CHANGE_POINTS;
	if (due) {
		lastWrites.set(key, { at: now, percent });
	}
	return due;
}

/** Why a reply's usage report was not stored. */
type ReportSkipReason =
	| "no-usage-headers"
	| "unknown-sign-in"
	| "throttled"
	| "sign-in-changed"
	| "write-failed";

/**
 * Records the usage a plan reply reported, for every process, and — for a
 * shared account — how far Fabric's estimate sat from it. Best effort and
 * never thrown: a reply that reports nothing, a replaced sign-in or a
 * database fault leaves the estimate in charge.
 */
export async function noteChatGptPlanReportedUsage(
	ref: PlanSourceRef,
	reply: {
		status: number;
		headers: Headers;
		credentialFingerprint: string | undefined;
	},
	now = Date.now(),
): Promise<void> {
	let limits: ChatGptPlanReportedLimits | null = null;
	let skipReason: ReportSkipReason | undefined;
	let persisted = false;
	try {
		limits = parseChatGptPlanRateLimitHeaders(reply.headers, now);
		if (!limits) {
			skipReason = "no-usage-headers";
		} else if (reply.credentialFingerprint === undefined) {
			skipReason = "unknown-sign-in";
		} else if (
			!shouldWrite(planSourceKey(ref), limits, reply.status, now)
		) {
			skipReason = "throttled";
		} else {
			const observedAt = new Date(now);
			const stored = await recordChatGptPlanReportedUsage({
				...planSourceStateKey(ref),
				limits,
				observedAt,
				credentialFingerprint: reply.credentialFingerprint,
			});
			persisted = stored;
			if (!stored) {
				skipReason = "sign-in-changed";
			} else {
				const { window } = sortChatGptPlanReportedLimits(limits);
				// A member's own plan is also spent outside Fabric, so a gap
				// there is not the estimate's error.
				if (ref.kind === "org" && window) {
					await recordDrift(ref, window, observedAt);
				}
			}
		}
	} catch (error) {
		if (!persisted) {
			skipReason ??= "write-failed";
		}
		logger.warn(
			"[chatgpt-plan] Recording the plan's reported usage failed",
			{
				...planSourceLogFields(ref),
				error: error instanceof Error ? error.message : String(error),
			},
		);
	}
	logReportedUsageDiagnostics(
		ref,
		reply,
		{ limits, persisted, skipReason },
		now,
	);
}

/**
 * One line per source every ten minutes, per process, saying what usage
 * headers a plan reply carried and whether the report was stored — enough to
 * tell a route that sends no `x-codex-*` headers from a capture that drops
 * them. Only `x-codex-*` names and parsed numbers are logged, never another
 * header or a token.
 */
function logReportedUsageDiagnostics(
	ref: PlanSourceRef,
	reply: { status: number; headers: Headers },
	outcome: {
		limits: ChatGptPlanReportedLimits | null;
		persisted: boolean;
		skipReason: ReportSkipReason | undefined;
	},
	now: number,
): void {
	const { limits, persisted, skipReason } = outcome;
	const key = planSourceKey(ref);
	const last = lastDiagnostics.get(key);
	if (last !== undefined && now - last < DIAGNOSTICS_INTERVAL_MS) {
		return;
	}
	lastDiagnostics.set(key, now);
	const presentCodexHeaders: string[] = [];
	reply.headers.forEach((_value, name) => {
		if (name.toLowerCase().startsWith("x-codex-")) {
			presentCodexHeaders.push(name.toLowerCase());
		}
	});
	const { sourceKind, sourceId } = planSourceStateKey(ref);
	logger.info("chatgpt-plan.usage-headers", {
		sourceKind,
		sourceId,
		status: reply.status,
		presentCodexHeaders: presentCodexHeaders.sort(),
		parsed: limits
			? {
					primaryPct: limits.primary?.usedPercent ?? null,
					resetAt: limits.primary?.resetsAt?.toISOString() ?? null,
					windowMinutes: limits.primary?.windowMinutes ?? null,
					secondaryPct: limits.secondary?.usedPercent ?? null,
				}
			: null,
		persisted,
		...(skipReason && { skipReason }),
	});
}

async function recordDrift(
	ref: Extract<PlanSourceRef, { kind: "org" }>,
	reported: ChatGptPlanReportedLimit,
	observedAt: Date,
): Promise<void> {
	const [windows, calibrations] = await Promise.all([
		getCachedChatGptPlanOrgAccountWindows(ref.organizationId, [
			ref.accountId,
		]),
		getChatGptPlanWindowCalibrations("ORG", [ref.accountId]),
	]);
	const estimate = windows.get(ref.accountId);
	const budget = calibrations.get(ref.accountId)?.budget ?? 0;
	const windowStart =
		estimate?.windowStart ??
		(reported.resetsAt && reported.windowMinutes
			? new Date(
					reported.resetsAt.getTime() -
						reported.windowMinutes * 60_000,
				)
			: null);
	if (!windowStart || budget <= 0) {
		return;
	}
	const estimatePercent = chatGptPlanWindowPercentUncapped(
		estimate?.weightedInputTokens ?? 0,
		budget,
	);
	const drift = await recordChatGptPlanReportedAccuracy({
		sourceKind: "ORG",
		sourceId: ref.accountId,
		windowStart,
		budget,
		estimatePercent,
		reportedPercent: reported.usedPercent,
		reportedAt: observedAt,
	});
	if (drift > CHATGPT_PLAN_DRIFT_WARN_POINTS) {
		logger.warn(
			"[chatgpt-plan] Window estimate drifts from the usage OpenAI reported",
			{
				...planSourceLogFields(ref),
				estimatePercent: Math.round(estimatePercent),
				reportedPercent: Math.round(reported.usedPercent),
				driftPoints: Math.round(drift),
			},
		);
	}
}

/**
 * Settles a shared account's windows that have reset, at most every ten
 * minutes per process, in the background: records each one's peak estimate,
 * and turns one that reset unrefused past the budget into a lower bound that
 * raises it. Logs a window that reset unrefused far past its budget.
 */
export function settleChatGptPlanWindowsInBackground(
	ref: PlanSourceRef,
	now = Date.now(),
): void {
	if (ref.kind !== "org") {
		return;
	}
	const key = planSourceKey(ref);
	const last = lastSettles.get(key);
	if (last !== undefined && now - last < SETTLE_INTERVAL_MS) {
		return;
	}
	lastSettles.set(key, now);
	// Started on a later tick so nothing it throws reaches the call it follows.
	void Promise.resolve()
		.then(() =>
			settleChatGptPlanAccountWindows({
				organizationId: ref.organizationId,
				accountId: ref.accountId,
				now: new Date(now),
			}),
		)
		.then((settled) => {
			for (const window of settled) {
				if (
					!window.refused &&
					window.peakEstimatePercent >
						CHATGPT_PLAN_OVERSHOOT_WARN_PERCENT
				) {
					logger.warn(
						"[chatgpt-plan] A window reset without a refusal far past its estimated budget",
						{
							...planSourceLogFields(ref),
							windowStart: window.windowStart.toISOString(),
							peakEstimatePercent: Math.round(
								window.peakEstimatePercent,
							),
							raisedBudgetTo: window.lowerBound
								? Math.round(window.weightedInputTokens)
								: null,
						},
					);
				}
			}
		})
		.catch((error: unknown) => {
			logger.warn("[chatgpt-plan] Settling the plan's windows failed", {
				...planSourceLogFields(ref),
				error: error instanceof Error ? error.message : String(error),
			});
		});
}

export function __resetChatGptPlanReportedUsage(): void {
	lastWrites.clear();
	lastSettles.clear();
	lastDiagnostics.clear();
}
