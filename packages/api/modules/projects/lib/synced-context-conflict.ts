/**
 * The sentence a synced-context CONFLICT carries, for its two kinds. Shared by
 * the oRPC procedure and the v1 route so the two cannot word the rule apart,
 * and kept apart from `upsert-synced-context.ts` so the v1 route can use it
 * without loading the Temporal client and the realtime emitter at module load.
 */
import type { UpsertSyncedContextResult } from "./upsert-synced-context";

export function syncedContextConflictMessage(
	result: Extract<UpsertSyncedContextResult, { status: "conflict" }>,
): string {
	if (result.current === null) {
		return "This file was deleted on the server since the version you are replacing, so nothing was written. Push again without expectedContentHash to recreate it, which answers duplicate instead if that content already exists elsewhere in the project.";
	}
	return "This file was changed on the server since the version you are replacing, so nothing was written. Read the stored version, merge, and push again with its contentHash as expectedContentHash.";
}
