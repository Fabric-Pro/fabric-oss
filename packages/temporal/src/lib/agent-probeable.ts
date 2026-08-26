/**
 * Agent health-probe eligibility (shared)
 *
 * The agent health monitor (and the manual "Check health" procedure) only make
 * sense for agents that expose an external HTTP `/health` endpoint. Two classes
 * of agent do NOT:
 *
 *  - `FABRIC_NATIVE` agents — the canonical workspace assistant runs in-process
 *    inside the Next.js app; there is no separate service to probe.
 *  - Inline agents (e.g. Sidekick) registered with an empty `deploymentUrl`.
 *
 * Probing these only ever yields a false ERROR (a `localhost` fetch failure or
 * an empty-URL parse error). They are excluded from probing so they keep their
 * real status instead of being marked ERROR.
 *
 * Pure function — safe to call from workflow or activity code.
 */
export function isProbeableAgent<
	T extends { framework: string; deploymentUrl: string | null },
>(agent: T): agent is T & { deploymentUrl: string } {
	if (agent.framework === "FABRIC_NATIVE") {
		return false;
	}
	return !!agent.deploymentUrl?.trim();
}
