import { ORPCError } from "@orpc/client";

/**
 * Answers a version allocation that lost the race on every attempt
 * (`InstructionVersionContentionError`) as a CONFLICT the caller can simply
 * retry, with `data.reason: "VERSION_CONTENTION"`. Used as a `.catch` handler,
 * so any other error passes through unchanged.
 *
 * Matched by name, not `instanceof`: it is the thrown class's contract, and
 * it keeps this module free of a runtime import from the database package.
 */
export function versionContentionAsConflict(error: unknown): never {
	if (
		error instanceof Error &&
		error.name === "InstructionVersionContentionError"
	) {
		throw new ORPCError("CONFLICT", {
			message:
				"Several versions were started on this project at the same moment. Try again.",
			data: { reason: "VERSION_CONTENTION" },
		});
	}
	throw error;
}
