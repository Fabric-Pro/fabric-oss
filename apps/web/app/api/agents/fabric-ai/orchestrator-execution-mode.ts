import type { ExecutionMode } from "@repo/temporal";

/**
 * Shared by the two Orchestrator start routes (`orchestrator-temporal/route.ts`
 * and `orchestrator-temporal/stream/route.ts`), which parse their bodies by
 * hand and used to cast `executionMode` straight into the workflow input.
 *
 * Kept as a local table typed against `ExecutionMode` rather than read from
 * `EXECUTION_MODE_CONFIGS`: `satisfies` fails type-check the moment the union
 * gains or loses a mode, and the routes stay free of a runtime import the route
 * test harnesses would each have to mock.
 */
const EXECUTION_MODES = {
	fast: true,
	balanced: true,
	accurate: true,
	save_reuse: true,
	iterative: true,
	weave: true,
} as const satisfies Record<ExecutionMode, true>;

/**
 * Reasoning-mode names some clients still send in this field (the multi-agent
 * stream's "go deep" capability sends `deep`). The workflow never recognised
 * them and ran `balanced`, so that is what they keep running: mapping them to
 * their deeper presets would change cost and duration for those callers, and
 * that is a product decision, not a validation fix.
 */
const LEGACY_REASONING_NAMES = new Set(["lite", "deep", "planner"]);

export const EXECUTION_MODE_NAMES = Object.keys(
	EXECUTION_MODES,
) as ExecutionMode[];

/**
 * The execution mode a request asked for, or `null` when the value is not one
 * the workflow knows. An omitted field is the route's to default.
 */
export function parseExecutionMode(value: unknown): ExecutionMode | null {
	if (typeof value !== "string") {
		return null;
	}
	if (Object.hasOwn(EXECUTION_MODES, value)) {
		return value as ExecutionMode;
	}
	if (LEGACY_REASONING_NAMES.has(value)) {
		return "balanced";
	}
	return null;
}
