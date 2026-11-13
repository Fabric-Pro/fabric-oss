import { initAppInsightsLogs } from "@repo/observability/web-startup";

const WEB_CLOUD_ROLE_NAME = "fabric.web";

/**
 * Starts App Insights log forwarding under the web app's cloud role.
 *
 * Initialising the client costs 0.4-0.8 s of synchronous start-up, so it is
 * not done in `register()`, which also runs in the proxy (middleware)
 * function that never logs. Page functions start it from the root layout's
 * `after()`, once the first response has been sent, so a cold page does not
 * wait for it. The API route starts it from its module, and any function
 * starts it with its first warning or error log (see `instrumentation.ts`),
 * which also covers a page that logs before its `after()` runs. Safe to call
 * repeatedly: the observability package short-circuits once the client exists.
 */
export function startWebAppInsights(): void {
	if (process.env.NEXT_PHASE === "phase-production-build") {
		return;
	}
	initAppInsightsLogs({ cloudRoleName: WEB_CLOUD_ROLE_NAME });
}
