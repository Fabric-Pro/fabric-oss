import { ORPCError } from "@orpc/client";
import { isFeatureEnabled } from "@repo/database";

/**
 * Feature gate. Living Documents auto-refresh is OFF unless the registry flag
 * `LIVING_DOCS_REFRESH` resolves ON — an admin override row first, then
 * `FABRIC_FEATURE_LIVING_DOCS_REFRESH_ROLLOUT`, then the registry default (OFF).
 * That variable is NOT `FABRIC_FEATURE_LIVING_DOCS_REFRESH`, which seeds the
 * separate sweep kill switch and is true in every environment. Every
 * auto-refresh procedure calls this first, so the API behaves as if the routes
 * don't exist when the capability is off.
 *
 * ASYNC ON PURPOSE, and every call site must `await` it (Fizzy #2210). The
 * registry read consults the override table behind a short cache, which a
 * synchronous reader cannot do. A missed `await` yields a Promise — always
 * truthy — so the gate silently opens; `living-docs-refresh-gate-guard.test.ts`
 * scans for that.
 *
 * There is no client twin any more. The masthead control used to gate itself on
 * `NEXT_PUBLIC_FABRIC_FEATURE_LIVING_DOCS_REFRESH`, a build-time variable
 * parsed by a different rule, and when the two disagreed in the direction that
 * shows the control every click failed against routes that answer NOT_FOUND.
 * One reader ends that.
 *
 * Mirrors `assertContextSummarizationEnabled` in shape; the NOT_FOUND throw is
 * deliberate and load-bearing — a FORBIDDEN would advertise that the routes
 * exist.
 */
export async function assertLivingDocsRefreshEnabled(): Promise<void> {
	if (!(await isFeatureEnabled("LIVING_DOCS_REFRESH"))) {
		throw new ORPCError("NOT_FOUND", {
			message: "Living document auto-refresh is not enabled.",
		});
	}
}
