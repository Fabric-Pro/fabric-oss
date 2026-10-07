/**
 * Which Orchestrator execution modes run as a server-owned chat turn.
 *
 * Imported by BOTH sides so they cannot drift: the chat starters
 * (`app/api/agents/fabric-ai/orchestrator-temporal/turn-admission.ts`) give
 * a turn — and so key idempotency — only to these modes, and the browser
 * (`hooks/useOrchestratorStream.ts`) re-sends a message's initial request by
 * its key, before `started` has delivered an executionId, only for them.
 *
 * Every mode but `weave` runs as a turn, the Planner (`save_reuse`)
 * included. Weave is started from its own surface with no conversation and
 * stopped by its own signal; if a chat starter receives it, the server
 * creates no turn and ignores the key, so a re-send would start a second
 * run, and it keeps the legacy start, cancel and stream behaviour end to end.
 * The workflow ignores a turnId sent with a Weave run too.
 *
 * Pure, with no imports, so it is safe in both bundles.
 */
export function executionModeUsesTurns(mode: string | undefined): boolean {
	return mode !== "weave";
}
