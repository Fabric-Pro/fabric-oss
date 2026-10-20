import { ORPCError } from "@orpc/client";

/**
 * What to tell the person when saving a workflow failed.
 *
 * The server refuses an edit that cannot be saved with a `BAD_REQUEST` whose
 * message is written for them (a schedule that fires too often for an agent
 * task, a server or capability the agent may not use), so that message is
 * shown. Any other failure is not theirs to read: it may carry internals, and
 * the toast says only that the save failed.
 */
export function describeSaveFailure(error: unknown): string | undefined {
	if (!(error instanceof ORPCError) || error.code !== "BAD_REQUEST") {
		return undefined;
	}
	const message = error.message.trim();
	return message.length > 0 ? message : undefined;
}
