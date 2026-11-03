import type { AtlasChatTurnNote } from "@repo/api/modules/atlas/chat-turn";
import { atlasChatInputSchema } from "@repo/atlas/schemas";
import { runtimeCustomEventName } from "@saas/agents/lib/runtime-custom-events";
import type { z } from "zod";

/**
 * The Atlas tab's codebase chat over the agent runtime: what the `atlas-chat`
 * engine (`modules/saas/agents/runtime/atlas-chat-engine.ts`) and the chat
 * panel (`AtlasChatPanel`) agree on.
 *
 * - The run's thread id is the AtlasConversation's id; both turns are saved
 *   to that conversation.
 * - The run's messages are the conversation so far; the last is the question.
 * - `forwardedProps` carries the rest of the `atlas.chat` input
 *   (`atlasChatPropsSchema`); the organization is the runtime request's.
 * - The answer arrives as one assistant text message, followed by its explicit
 *   served-model CUSTOM event when known, then at most one CUSTOM
 *   note (`ATLAS_CHAT_EVENT`) with value `{}`: the turn could not be saved, or
 *   the reply was cut short.
 */

export const ATLAS_CHAT_AGENT_ID = "atlas-chat";

/**
 * The `atlas.chat` input minus what the runtime carries itself (the thread is
 * the conversation, the header the organization, the run's messages the
 * messages), validated as the procedure validates it.
 */
export const atlasChatPropsSchema = atlasChatInputSchema.pick({
	projectId: true,
	repositoryIntegrationId: true,
	mode: true,
	focusNodeKey: true,
});
export type AtlasChatProps = z.infer<typeof atlasChatPropsSchema>;

export const ATLAS_CHAT_EVENT = {
	model: runtimeCustomEventName(ATLAS_CHAT_AGENT_ID, "model"),
	"persist-failed": runtimeCustomEventName(
		ATLAS_CHAT_AGENT_ID,
		"persist-failed",
	),
	interrupted: runtimeCustomEventName(ATLAS_CHAT_AGENT_ID, "interrupted"),
} as const satisfies Record<AtlasChatTurnNote | "model", string>;

/** The note a CUSTOM event carries, or null for any other event name. */
export function atlasChatNoteOfEvent(name: string): AtlasChatTurnNote | null {
	if (name === ATLAS_CHAT_EVENT["persist-failed"]) {
		return "persist-failed";
	}
	if (name === ATLAS_CHAT_EVENT.interrupted) {
		return "interrupted";
	}
	return null;
}
