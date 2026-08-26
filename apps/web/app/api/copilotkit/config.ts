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

export const AI_TOKEN_TTL_SECONDS = COPILOTKIT_MAX_DURATION_SECONDS + 100; // token must outlive the longest run this route allows
