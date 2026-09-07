import { ORPCError } from "@orpc/server";

/**
 * The "nothing to scan" error, told apart from "nothing linked" (Fizzy #2355).
 *
 * Since pausing exists, a monitor can have every conversation on screen and
 * still nothing to do. Reusing the old "link one first" message there would tell
 * someone their three visible channels are not linked — indistinguishable, to
 * them, from having lost them.
 *
 * Always throws.
 */
export function throwNoActiveContextSources(params: {
	/** How many linked rows are paused. Zero means genuinely nothing linked. */
	pausedCount: number;
	/** Singular, capitalised: "Teams chat", "Slack channel". */
	noun: string;
	/** What was being attempted: "enabling the monitor". */
	action: string;
}): never {
	if (params.pausedCount > 0) {
		throw new ORPCError("BAD_REQUEST", {
			message: `Every linked ${params.noun.toLowerCase()} is paused, so there is nothing to scan. Resume at least one before ${params.action}.`,
		});
	}

	throw new ORPCError("BAD_REQUEST", {
		message: `At least one ${params.noun} must be linked before ${params.action}`,
	});
}
