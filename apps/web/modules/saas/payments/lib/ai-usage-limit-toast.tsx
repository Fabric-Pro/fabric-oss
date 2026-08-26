"use client";

import { useTranslations } from "next-intl";
import { useCallback, type ReactNode } from "react";
import { toast } from "sonner";

/**
 * Shared destructive-toast helper for the `AI_USAGE_LIMIT_EXCEEDED` error
 * code. A single render function called by every AI surface (Nexus chat,
 * Loom direct chat, Loom orchestrator, document AI, Excalidraw, etc.) so
 * the user sees identical copy and identical "Manage limits" deep-link
 * behaviour everywhere a HARD AI usage limit blocks a call.
 *
 * Layout: editorial 3-row card — title row, description row, footer row
 * with a "Resets in X" countdown and a "Manage limits →" link. The
 * footer is composed inside the `description` slot of the destructive
 * sonner toast so the toast remains a single shaped element (Sonner
 * lays the description out below the title with the destructive icon
 * to the left, keeping the layout responsive and not cropped on narrow
 * viewports). The countdown is computed at toast-fire time only — toasts
 * auto-dismiss after 8 seconds, so a static label is correct and avoids
 * threading a per-second tick through a transient surface.
 */

/**
 * Minimal translator surface used by this helper. Compatible with both the
 * `useTranslations` return value (next-intl) and `createTranslator(..)`
 * (use-intl/core), which is what the brief recommends — see
 * `packages/mail/src/util/templates.ts` for the same pattern in mail
 * templates. Kept narrow on purpose: anything that can resolve a key with
 * optional ICU vars to a string satisfies it.
 */
export type AiUsageLimitTranslator = (
	key: string,
	vars?: Record<string, string | number>,
) => string;

/**
 * Wire-shape of the `AiUsageLimitExceededError` payload as it arrives at the
 * client. Mirrors `AiUsageLimitExceededError` (`packages/payments/src/lib/
 * ai-usage-limits.ts`) with two differences:
 * 1. `used` and `max` are `string | bigint` because BigInt round-trips
 * through JSON (oRPC error envelope, SSE event payload) as a string.
 * The helper does not currently render `used`/`max`, but accepting both
 * keeps the contract honest for future copy that does.
 * 2. Lacks the `Error` prototype chain — by the time the payload reaches
 * here it has been destructured into a plain object on the wire, so
 * `instanceof AiUsageLimitExceededError` would always be `false`.
 */
export interface AiUsageLimitExceededPayload {
	limitId: string;
	dimension: "TOKENS" | "SPEND_USD";
	window: "HOURLY" | "DAILY" | "WEEKLY" | "MONTHLY";
	used: string | bigint;
	max: string | bigint;
	manageLimitsUrl: string;
}

/**
 * Type guard so callers in catch blocks (which receive `unknown`) can narrow
 * an arbitrary error/event payload to the shape this helper accepts. Cheap
 * to call — pure shape check, no allocation.
 * Used by 's error mappers to decide whether to delegate to this
 * helper or fall through to a generic error handler.
 */
export function isAiUsageLimitExceededPayload(
	value: unknown,
): value is AiUsageLimitExceededPayload {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const p = value as Partial<AiUsageLimitExceededPayload>;
	return (
		typeof p.limitId === "string" &&
		(p.dimension === "TOKENS" || p.dimension === "SPEND_USD") &&
		(p.window === "HOURLY" ||
			p.window === "DAILY" ||
			p.window === "WEEKLY" ||
			p.window === "MONTHLY") &&
		typeof p.manageLimitsUrl === "string" &&
		(typeof p.used === "string" || typeof p.used === "bigint") &&
		(typeof p.max === "string" || typeof p.max === "bigint")
	);
}

/** i18n bucket prefix kept in one place so the keys are easy to grep. */
const I18N_BUCKET = "settings.aiUsage.limits.toast";

/**
 * Compute the next reset instant for a usage window, in UTC. Used to
 * render a "Resets in X" countdown in the destructive toast.
 * The chokepoint server-side recomputes window boundaries from the
 * tenant's calendar TZ, but the toast is a transient surface and the
 * rest of the AI-usage UI labels windows as "(UTC)", so a UTC boundary
 * is consistent and avoids threading the tenant TZ through the SSE/oRPC
 * error envelopes. The boundary is always in the future relative to
 * `now` — see `formatNextResetCountdown` for the human-readable label.
 */
function computeNextResetInstant(
	window: AiUsageLimitExceededPayload["window"],
	now: Date = new Date(),
): Date {
	switch (window) {
		case "HOURLY": {
			// Next top of hour (UTC).
			const next = new Date(now);
			next.setUTCMinutes(0, 0, 0);
			next.setUTCHours(next.getUTCHours() + 1);
			return next;
		}
		case "DAILY": {
			// Next midnight UTC.
			const next = new Date(now);
			next.setUTCHours(0, 0, 0, 0);
			next.setUTCDate(next.getUTCDate() + 1);
			return next;
		}
		case "WEEKLY": {
			// Next ISO Monday 00:00 UTC. Sunday=0 in JS, so the offset to
			// the next Monday is `(8 - day) % 7 || 7` — always ≥ 1 so the
			// boundary is strictly in the future.
			const next = new Date(now);
			next.setUTCHours(0, 0, 0, 0);
			const day = next.getUTCDay();
			const offset = (8 - day) % 7 || 7;
			next.setUTCDate(next.getUTCDate() + offset);
			return next;
		}
		case "MONTHLY": {
			// 1st of next month, 00:00 UTC.
			const next = new Date(now);
			next.setUTCHours(0, 0, 0, 0);
			next.setUTCDate(1);
			next.setUTCMonth(next.getUTCMonth() + 1);
			return next;
		}
	}
}

/**
 * Format a "Resets in 2d 4h" / "Resets in 5h 23m" / "Resets in 12m"
 * label. Mirrors the format ladder of {@link
 * apps/web/modules/saas/payments/components/AiUsageLimitsCard.tsx}
 * `formatTimeUntilReset` so the toast countdown reads identically to
 * the usage page countdown.
 */
function formatNextResetCountdown(
	nextResetIso: string,
	now: Date,
	t: AiUsageLimitTranslator,
): string | null {
	const endMs = Date.parse(nextResetIso);
	if (!Number.isFinite(endMs)) {
		return null;
	}
	const remainingMs = endMs - now.getTime();
	if (remainingMs <= 0) {
		return null;
	}

	const totalMinutes = Math.floor(remainingMs / 60_000);
	if (totalMinutes < 1) {
		return t(`${I18N_BUCKET}.resetsShortly`);
	}
	const days = Math.floor(totalMinutes / (24 * 60));
	const hoursAfterDays = Math.floor((totalMinutes % (24 * 60)) / 60);
	const hoursTotal = Math.floor(totalMinutes / 60);
	const minutesAfterHours = totalMinutes % 60;

	if (days >= 1) {
		return t(`${I18N_BUCKET}.resetsInDaysHours`, {
			d: days,
			h: hoursAfterDays,
		});
	}
	if (hoursTotal >= 1) {
		return t(`${I18N_BUCKET}.resetsInHoursMinutes`, {
			h: hoursTotal,
			m: minutesAfterHours,
		});
	}
	return t(`${I18N_BUCKET}.resetsInMinutes`, { m: totalMinutes });
}

/**
 * Render the destructive AI-usage-limit toast.
 * Pass a translator (`useTranslations` from a hook, `createTranslator(..)`
 * from non-component code, or any function with the
 * {@link AiUsageLimitTranslator} signature). Component callers should
 * prefer {@link useShowAiUsageLimitToast}, which closes over the translator
 * for them.
 * Behaviour:
 * - Destructive variant via `toast.error` (the project Toaster maps `.error`
 * to the `--destructive` token; see `apps/web/modules/ui/components/toast.tsx`).
 * - 8s duration (vs the 5s default) so the user has time to read and click.
 * - Description renders as a 2-row block (body + footer). Footer has a
 * "Resets in X" countdown computed once at toast-fire time (UTC
 * boundary — toasts auto-dismiss in 8s so a static value is correct)
 * and a "Manage limits →" link button that navigates via
 * `window.location.assign(manageLimitsUrl)`. Full-page navigation is
 * intentional — sonner action callbacks can fire from contexts (SSE
 * consumer, oRPC interceptor) that do not have access to the Next
 * router.
 * - Defensive: if `manageLimitsUrl` is empty/whitespace the footer link
 * is omitted (the toast still shows). Prevents a no-op button under
 * exotic SSE/serialisation paths.
 * - Responsive: the description is laid out in a flex column with a
 * gap, the footer wraps if the viewport is too narrow for the
 * countdown + link to share a single row. No max-width is forced
 * here — sonner clamps the toast to ~360px on mobile and ~440px on
 * desktop via the toast-options classNames in
 * `apps/web/modules/ui/components/toast.tsx`.
 * - Deduped: `id = ai-usage-limit-${limitId}` so back-to-back blocked
 * calls against the same limit collapse into a single visible toast
 * per sonner's id-dedup semantics. v1 acceptable
 * ("toast might fire repeatedly… that's acceptable for v1").
 */
export function showAiUsageLimitToast(
	payload: AiUsageLimitExceededPayload,
	t: AiUsageLimitTranslator,
): void {
	const dimensionKey =
		payload.dimension === "SPEND_USD" ? "blockedSpend" : "blockedTokens";

	const windowLabel = t(
		`${I18N_BUCKET}.window.${payload.window.toLowerCase()}`,
	);

	const description = t(`${I18N_BUCKET}.${dimensionKey}`, {
		window: windowLabel,
	});

	const title = t(`${I18N_BUCKET}.blockedTitle`);
	const actionLabel = t(`${I18N_BUCKET}.blockedAction`);
	const ariaLabel = t(`${I18N_BUCKET}.blockedActionAriaLabel`);

	const manageUrl = payload.manageLimitsUrl?.trim() ?? "";

	const nextResetAt = computeNextResetInstant(payload.window).toISOString();
	const resetLabel = formatNextResetCountdown(nextResetAt, new Date(), t);

	const descriptionNode: ReactNode = (
		<span className="flex flex-col gap-2">
			<span className="block leading-snug">{description}</span>
			{(resetLabel || manageUrl) && (
				<span className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 pt-0.5">
					{resetLabel ? (
						<span className="text-[11px] text-muted-foreground/85">
							{resetLabel}
						</span>
					) : (
						<span aria-hidden />
					)}
					{manageUrl ? (
						<button
							type="button"
							aria-label={ariaLabel}
							className="rounded-sm text-[11px] font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring whitespace-nowrap"
							onClick={() => {
								if (typeof window !== "undefined") {
									window.location.assign(manageUrl);
								}
							}}
						>
							{actionLabel}
						</button>
					) : null}
				</span>
			)}
		</span>
	);

	toast.error(title, {
		id: `ai-usage-limit-${payload.limitId}`,
		description: descriptionNode,
		duration: 8000,
	});
}

/**
 * React hook wrapper around {@link showAiUsageLimitToast}. Use this from
 * component code so you don't have to thread the translator manually.
 * Returned callback is stable across renders for the lifetime of the
 * component (memoised against the translator identity).
 */
export function useShowAiUsageLimitToast(): (
	payload: AiUsageLimitExceededPayload,
) => void {
	const t = useTranslations();
	return useCallback(
		(payload: AiUsageLimitExceededPayload) => {
			showAiUsageLimitToast(payload, t as AiUsageLimitTranslator);
		},
		[t],
	);
}
