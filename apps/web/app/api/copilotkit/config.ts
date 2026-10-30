/**
 * CopilotKit route timing constants.
 *
 * Incident: a staging "Update Full Spec" run's Databricks model call ran
 * 5m45s — past the AI token's old 300s TTL — so every internal Fabric API
 * call the run made after that point 401'd (tools soft-degraded, usage
 * logging silently dropped rows). The AI token must outlive the longest run
 * this route allows, not just the "typical" call.
 *
 * `route.ts`'s `export const maxDuration` must stay a static numeric literal
 * — Next.js route segment config is statically analyzed and cannot import a
 * value — so keep that literal in sync with COPILOTKIT_MAX_DURATION_SECONDS
 * by hand. `copilotkit-token-ttl-drift.test.ts` enforces this via a regex
 * over the route.ts source.
 */
export const COPILOTKIT_MAX_DURATION_SECONDS = 800;

/**
 * The token must outlive the longest run this route allows. A durable run
 * (`durable-runs.ts`) uses this same token on the worker, so its activity's
 * timeout is derived from this value (`AGUI_RUN_TOKEN_TTL_SECONDS` in
 * `@repo/temporal/agui-run-stream`); `durable-runs.test.ts` holds them equal.
 */
export const AI_TOKEN_TTL_SECONDS = COPILOTKIT_MAX_DURATION_SECONDS + 100;

/**
 * How long one response tails a durable run (`durable-runs.ts`). The v1
 * client does not reconnect when a run's stream ends without a terminal
 * event, so the window covers a whole run: the route's `maxDuration` less a
 * minute for authentication, model resolution and the workflow start before
 * the first event, so the response always ends on its own terms. A run that
 * outlives it keeps running on the worker, and the next mount's `connect`
 * reattaches to it.
 */
export const COPILOTKIT_RUN_STREAM_WINDOW_MS =
	(COPILOTKIT_MAX_DURATION_SECONDS - 60) * 1000;
