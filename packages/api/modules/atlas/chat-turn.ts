import { ORPCError } from "@orpc/client";
import { AIProviderNotConfiguredError } from "@repo/ai";
import { AtlasService } from "@repo/atlas";
import type { AtlasContext } from "@repo/atlas/types";
import { mapAtlasError } from "./lib";

/**
 * One Atlas chat turn, as both of its doors run it: the `atlas.chat` /
 * `atlas.systemChat` procedures and the agent runtime's `atlas-chat` engine.
 */

/**
 * `atlas.chat`'s oRPC path, for the audit rows a door outside oRPC writes for
 * the procedure it serves.
 */
export const ATLAS_CHAT_PROCEDURE_PATH = ["atlas", "chat"] as const;

export type AtlasChatTurnInput = Parameters<AtlasService["chat"]>[0];

/** The one terminal note a finished turn carries. */
export type AtlasChatTurnNote = "persist-failed" | "interrupted";

/** A failed chat as the procedures answer it. */
export function rethrowAtlasChatError(error: unknown): never {
	// Same mapping as `generateTasksProcedure`: PRECONDITION_FAILED carrying
	// the resolver's own message. The hand-written copy this replaces named
	// "Settings → AI Models", a different page from the one that actually
	// fixes it, and BAD_REQUEST reads as "your input was wrong" for a
	// condition the caller's input had no part in.
	if (error instanceof AIProviderNotConfiguredError) {
		throw new ORPCError("PRECONDITION_FAILED", { message: error.message });
	}
	mapAtlasError(error);
}

/** Start the single-repository chat for `ctx`; a refusal is the procedure's. */
export async function startAtlasChat(
	ctx: AtlasContext,
	input: AtlasChatTurnInput,
) {
	try {
		return await new AtlasService(ctx).chat(input);
	} catch (error) {
		rethrowAtlasChatError(error);
	}
}

/**
 * The conversation a turn writes to must be the caller's or SHARED, in this
 * project and tenant: the check `chat()` makes once it has resolved the
 * repository and its analysis, for a door that must know before the turn
 * starts.
 */
export async function assertAtlasChatConversation(
	ctx: AtlasContext,
	input: { conversationId: string; projectId: string },
): Promise<void> {
	try {
		await new AtlasService(ctx).getConversation(input);
	} catch (error) {
		rethrowAtlasChatError(error);
	}
}

/** A lost write outranks an interruption. */
export function atlasChatTurnNote(outcome: {
	persisted: boolean;
	interrupted: boolean;
}): AtlasChatTurnNote | null {
	if (!outcome.persisted) {
		return "persist-failed";
	}
	return outcome.interrupted ? "interrupted" : null;
}
