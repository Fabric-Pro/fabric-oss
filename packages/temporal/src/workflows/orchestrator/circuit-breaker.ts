/**
 * Circuit Breaker for Agent Failures
 *
 * Pure deterministic functions — no I/O, no Temporal imports.
 * Safe to call from workflow code during Temporal replay.
 *
 * State machine:
 *   CLOSED  → normal operation, failures accumulate
 *   OPEN    → agent known-broken, calls skipped; caller must schedule cooldown
 *   HALF_OPEN → one probe allowed after cooldown; failure re-opens, success closes
 */

// ---- Types ------------------------------------------------------------------

/** Circuit state for a single agent within a workflow execution */
export interface CircuitBreakerState {
	state: "CLOSED" | "OPEN" | "HALF_OPEN";
	consecutiveFailures: number;
	/** Workflow time (ms) at which the circuit was opened — set by caller via currentTimeMs() */
	openedAt?: number;
}

// ---- Thresholds (from centralized config) ------------------------------------

// NOTE: We inline the values here rather than importing from orchestrator-config.ts
// because this file must remain free of workflow-level imports for determinism.
// The values are kept in sync with CIRCUIT_BREAKER in orchestrator-config.ts.

/** Number of consecutive failures required to open the circuit */
const FAILURE_THRESHOLD = 3;

/**
 * Number of failures tolerated in HALF_OPEN state before the circuit is
 * re-opened. Typically 1 — the first probe failure re-opens immediately.
 */
const HALF_OPEN_MAX_FAILURES = 1;

// ---- Pure helper functions --------------------------------------------------

/**
 * Returns the current circuit state for the given agent.
 * If no state has been recorded yet, returns the default CLOSED state.
 */
export function getCircuitState(
	breakers: Record<string, CircuitBreakerState>,
	agentId: string,
): CircuitBreakerState {
	return breakers[agentId] ?? { state: "CLOSED", consecutiveFailures: 0 };
}

/**
 * Returns true if the circuit is OPEN (agent is known-broken and calls
 * should be skipped without attempting delegation).
 */
export function isCircuitOpen(
	breakers: Record<string, CircuitBreakerState>,
	agentId: string,
): boolean {
	return getCircuitState(breakers, agentId).state === "OPEN";
}

/**
 * Records a successful agent call.
 * - CLOSED: resets the consecutive failure counter.
 * - HALF_OPEN: closes the circuit (probe succeeded, agent recovered).
 *
 * Returns a new breakers map — does not mutate the input.
 */
export function recordSuccess(
	breakers: Record<string, CircuitBreakerState>,
	agentId: string,
): Record<string, CircuitBreakerState> {
	return {
		...breakers,
		[agentId]: { state: "CLOSED", consecutiveFailures: 0 },
	};
}

/**
 * Records a failed agent call.
 * - CLOSED: increments failure counter; opens the circuit when FAILURE_THRESHOLD is reached.
 * - HALF_OPEN: any failure immediately re-opens the circuit.
 * - OPEN: no-op (caller should have checked isCircuitOpen before calling).
 *
 * @param nowMs  Pass `workflow.currentTimeMs()` from workflow code so the
 *               timestamp is deterministic during Temporal replay.
 *
 * Returns a new breakers map — does not mutate the input.
 */
export function recordFailure(
	breakers: Record<string, CircuitBreakerState>,
	agentId: string,
	nowMs: number,
): Record<string, CircuitBreakerState> {
	const s = getCircuitState(breakers, agentId);
	const newFailures = s.consecutiveFailures + 1;

	const shouldOpen =
		s.state === "HALF_OPEN"
			? newFailures >= HALF_OPEN_MAX_FAILURES
			: newFailures >= FAILURE_THRESHOLD;

	if (shouldOpen) {
		return {
			...breakers,
			[agentId]: {
				state: "OPEN",
				consecutiveFailures: newFailures,
				openedAt: nowMs,
			},
		};
	}

	return {
		...breakers,
		[agentId]: { ...s, consecutiveFailures: newFailures },
	};
}

/**
 * Transitions the circuit from OPEN → HALF_OPEN after a cooldown period.
 * The caller (workflow code) is responsible for sleeping the cooldown duration
 * before calling this function.
 *
 * Returns a new breakers map — does not mutate the input.
 */
export function transitionToHalfOpen(
	breakers: Record<string, CircuitBreakerState>,
	agentId: string,
): Record<string, CircuitBreakerState> {
	return {
		...breakers,
		[agentId]: { state: "HALF_OPEN", consecutiveFailures: 0 },
	};
}
