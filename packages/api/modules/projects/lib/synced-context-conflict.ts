/**
 * The sentence a synced-context CONFLICT carries, for each kind. Shared by the
 * oRPC procedures and the v1 routes so the surfaces cannot word the rule
 * apart, and kept apart from `upsert-synced-context.ts` so the v1 route can
 * use it without loading the Temporal client and the realtime emitter at
 * module load.
 */
import type { UpsertSyncedContextResult } from "./upsert-synced-context";

export function syncedContextConflictMessage(
	result: Extract<UpsertSyncedContextResult, { status: "conflict" }>,
): string {
	if (result.moveNotApplied?.reason === "source-changed") {
		return `The file at ${result.moveNotApplied.movedFromSourcePath} was changed on the server since the version you are moving, so nothing was written and it was not moved. Read the stored version, and push again naming its contentHash as expectedContentHash.`;
	}
	if (result.current === null) {
		return "This file was deleted on the server since the version you are replacing, so nothing was written. Push again without expectedContentHash to recreate it, which answers duplicate instead if that content already exists elsewhere in the project.";
	}
	return "This file was changed on the server since the version you are replacing, so nothing was written. Read the stored version, merge, and push again with its contentHash as expectedContentHash.";
}

/**
 * The sentence a synced-file DELETE conflict carries (Fizzy #2636): the path
 * holds another version than the one named, so nothing was deleted.
 */
export function syncedContextDeleteConflictMessage(): string {
	return "This file was changed on the server since the version you are deleting, so nothing was deleted. Read the stored version; to delete it anyway, send its contentHash as expectedContentHash.";
}
