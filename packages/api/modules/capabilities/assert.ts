/**
 * Refusing a capability at the door it is actually entered through (Fizzy #1930).
 *
 * ## Why rendering a disabled button is not gating
 *
 * Every procedure this feature protects is reachable by more than the page that
 * renders it: the OpenAPI handler exposes them to the public API, to coding
 * agents over MCP, and to Fabric's own agent tools. A gate that only greys out
 * a button is a suggestion to one of those callers and invisible to the rest —
 * so the requirement that an unusable source must not be usable by ANY
 * dependent capability would be a claim rather than a fact.
 *
 * This is the fact. It mirrors the run-start readiness check, which already
 * refuses work at the procedure boundary with a structured payload the UI can
 * render, and for the same reason: the check has to sit where the work starts,
 * not where it is offered.
 *
 * ## Why it re-gathers evidence
 *
 * Evidence read when the page loaded is evidence about a moment that has
 * passed. A credential can expire, an index can fail, and a scan can start
 * between the render and the click. The read path and this path therefore
 * answer the same question at different times on purpose, and this one is the
 * answer that binds.
 */

import { ORPCError } from "@orpc/server";
import { isFeatureEnabled } from "@repo/database";
import { gatherCapabilityEvidence } from "./evidence";
import { CAPABILITY_RULES_BY_KEY } from "./registry";
import { resolveGate } from "./resolve";
import type { CapabilityGate } from "./types";

/** The states that stop work. `WARNING` explicitly does not. */
const BLOCKING_STATES = new Set(["HARD_BLOCK", "SOFT_BLOCK", "PROCESSING"]);

export interface AssertCapabilityInput {
	capabilityKey: string;
	projectId: string;
	userId: string;
	organizationId: string | null;
}

/**
 * Throw unless the capability may run right now.
 *
 * The thrown error carries the resolved gate, so a caller that came through the
 * UI renders exactly the same explanation it would have shown had the button
 * been disabled, and a caller that came through the API gets a machine-readable
 * reason rather than a generic refusal.
 *
 * A warning never throws. That is the difference between "this will be worse
 * than it could be" and "this cannot happen", and collapsing the two would make
 * the feature obstructive in precisely the cases it is meant to be helpful.
 */
export async function assertCapabilityAvailable(
	input: AssertCapabilityInput,
): Promise<CapabilityGate | null> {
	// The flag is checked here rather than at each door, so a door added later
	// cannot forget it. Off means genuinely off: no evidence gathered, no
	// refusal thrown, every procedure behaving exactly as it did before this
	// feature existed — which is what makes the flag a rollback lever rather
	// than a half-measure.
	if (!(await isFeatureEnabled("CAPABILITY_GATING"))) {
		return null;
	}

	const rule = CAPABILITY_RULES_BY_KEY.get(input.capabilityKey);
	if (!rule) {
		// A typo in a call site must not silently disable a gate. Failing loudly
		// here is the only thing that catches it — no test exercises a key that
		// nobody wrote.
		throw new Error(
			`No capability rule registered for "${input.capabilityKey}".`,
		);
	}

	const evidence = await gatherCapabilityEvidence({
		projectId: input.projectId,
		userId: input.userId,
		organizationId: input.organizationId,
		// Only the two Atlas capabilities need the status accessor, and it costs
		// a provider round trip. Putting it on every door would make each gated
		// mutation wait on a third party before it was even allowed to begin.
		includeAtlasStatus: input.capabilityKey.startsWith("atlas."),
	});
	const gate = resolveGate(rule, evidence, new Date());

	if (BLOCKING_STATES.has(gate.state)) {
		throw new ORPCError("PRECONDITION_FAILED", {
			message: refusalMessage(gate, rule.label),
			data: { gate },
		});
	}

	return gate;
}

/**
 * The sentence a refused caller sees.
 *
 * It names the missing prerequisite rather than announcing the verdict,
 * because a refusal that does not say what is missing leaves the reader exactly
 * where they started. The requirements are explicit about this for composite
 * gates, and there is no reason for a single-prerequisite gate to be vaguer.
 */
function refusalMessage(gate: CapabilityGate, label: string): string {
	if (gate.state === "PROCESSING") {
		return gate.blockingDependency
			? `${label} is not ready yet — ${gate.blockingDependency} is still running.`
			: `${label} is not ready yet.`;
	}
	return gate.blockingDependency
		? `${label} is not ready yet. It needs ${gate.blockingDependency}.`
		: `${label} is not ready yet.`;
}
