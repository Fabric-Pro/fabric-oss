/**
 * Which Orchestrator execution modes run as a server-owned chat turn.
 *
 * Imported by BOTH sides so they cannot drift: the chat starters
 * (`app/api/agents/fabric-ai/orchestrator-temporal/turn-admission.ts`) give
 * a turn — and so key idempotency — only to these modes, and the browser
 * (`hooks/useOrchestratorStream.ts`) re-sends a message's initial request by
 * its key, before `started` has delivered an executionId, only for them. For
 * the planner modes (`save_reuse`, `weave`, which plan up front) the server
 * creates no turn and ignores the key, so a re-send would start a second
 * run; they keep the legacy start, cancel and stream behaviour end to end.
 * The workflow ignores a turnId sent with one of them too.
 *
 * Pure, with no imports, so it is safe in both bundles.
 */
export function executionModeUsesTurns(mode: string | undefined): boolean {
	return mode !== "save_reuse" && mode !== "weave";
}
