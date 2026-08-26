/**
 * Records the caller's "last active" timestamp on every authenticated
 * oRPC call from a browser session — NOT every authenticated
 * API call: the public v1 API (`requireApiKey`, a separate Hono tree) and
 * the REST routes under `apps/web/app/api/**` call `getSession` directly
 * and never pass through `protectedProcedure`, so neither is touched by
 * this middleware.
 *
 * Skips impersonated sessions: an admin impersonating a user must never
 * record activity for the impersonated account — it would silently
 * corrupt the exact metric this middleware exists to produce (the org
 * User Activity dashboard), with no way to tell it apart from real
 * activity afterwards. Mirrors the impersonation guard in
 * `packages/auth/auth.ts` (`session.create.after`), which skips invite
 * reconciliation for the same reason.
 *
 * Also skips {@link PASSIVE_POLL_PATHS} — see that constant for why.
 *
 * Deliberately fire-and-forget: `touchLastSeen` is throttled and
 * swallows its own errors, and this middleware additionally refuses to
 * await it — recency is telemetry, it must not add a database round
 * trip to the latency of the call it's attached to, and it must not be
 * able to fail it. The write is scheduled AFTER `await next()` (not
 * before) so it never contends with the handler's own queries for the
 * shared pg pool — scheduling it first would dispatch the UPDATE before
 * the handler issues a single query of its own, queueing ahead of the
 * request it must not slow down. One consequence: a request that throws
 * no longer records activity. That's fine, and arguably more correct —
 * a failed call isn't evidence the user is actively using Fabric either.
 * The write is scheduled via `runInBackground` (wraps Vercel's
 * `waitUntil`) rather than a bare `void promise`: on Vercel a bare `void
 * promise` is not guaranteed to run to completion once the response has
 * been sent, whereas `waitUntil` extends the function's lifetime without
 * adding latency to the request. The `.catch` is belt-and-braces against
 * an unhandled rejection if `touchLastSeen`'s never-throw contract ever
 * regresses.
 */

import { os } from "@orpc/server";
import { touchLastSeen } from "@repo/database";
import { runInBackground } from "../../modules/weave/lib/run-in-background";

/**
 * oRPC procedure paths (dot-joined, matching the `path` array oRPC hands
 * middleware) that are polled automatically by the authenticated app
 * shell — on a timer, on every page, regardless of anything the user
 * actually does. Counting these as "activity" inverts the exact bug this
 * middleware exists to fix: a user who left a tab open (or is on leave
 * with Fabric still open in a background tab) would show "Last active: a
 * few seconds ago" every day, indistinguishable from someone actually
 * using the product.
 *
 * This is a HEURISTIC, not an exhaustive or structurally-enforced
 * classification — it is the set of always-on app-shell polls known at
 * the time this list was last reviewed (Fizzy #1709 final-review pass,
 * 2026-07-23). Extend it whenever a new passive poll is added to the
 * authenticated shell (NavBar, layout-level hooks, etc.); there is no
 * automatic way to detect a new one, so this needs an explicit reviewer
 * eye each time.
 *
 * Path strings verified against the actual router registration —
 * `packages/api/orpc/router.ts` for the top-level key, the module's own
 * `router.ts` for the leaf — not assumed from procedure names:
 *
 *   - "notifications.unreadCount" — `NotificationBell` (rendered in
 *     `NavBar` on every authenticated page) polls this every 30s via
 *     `useNotificationUnreadCount`
 *     (apps/web/modules/saas/notifications/hooks/use-notification-unread-count.ts).
 *     Registered as `notifications: notificationsRouter` +
 *     `unreadCount: unreadCountNotificationsProcedure`.
 *   - "integrationHealth.listActiveIncidents" — the app-shell incident
 *     chip / rail indicator polls this every 60s via `useIncidentSummary`
 *     (apps/web/modules/saas/shared/components/incident-summary.tsx).
 *     Registered as `integrationHealth: integrationHealthRouter` +
 *     `listActiveIncidents: listActiveIncidentsProcedure`.
 *   - "payments.aiUsageLimits.status" — the AI usage limits card polls
 *     this every 30s via `useAiUsageLimitsStatus`
 *     (apps/web/modules/saas/payments/hooks/useAiUsageLimits.ts).
 *     Registered as `payments: paymentsRouter` +
 *     `aiUsageLimits: { status: aiUsageLimits.status, ... }`.
 */
const PASSIVE_POLL_PATHS: ReadonlySet<string> = new Set([
	"notifications.unreadCount",
	"integrationHealth.listActiveIncidents",
	"payments.aiUsageLimits.status",
]);

function isPassivePoll(path: readonly string[]): boolean {
	return PASSIVE_POLL_PATHS.has(path.join("."));
}

export const touchLastSeenMiddleware = os
	.$context<{
		user: { id: string };
		session: { impersonatedBy?: string | null };
	}>()
	.middleware(async ({ context, next, path }) => {
		const result = await next();
		if (!context.session.impersonatedBy && !isPassivePoll(path)) {
			runInBackground(touchLastSeen(context.user.id).catch(() => {}));
		}
		return result;
	});
