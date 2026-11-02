import { runtimeCustomEventName } from "@saas/agents/lib/runtime-custom-events";
import { z } from "zod";

/**
 * A library's Chat with Documents over the agent runtime: what the
 * `library-chat` engine (`modules/saas/agents/runtime/library-chat-engine.ts`)
 * and the dialog (`LibraryDocumentChatDialog`) agree on.
 *
 * - The run's messages are the conversation so far; the last is the question.
 * - `forwardedProps` names the library (`libraryChatPropsSchema`).
 * - The sources the answer draws on arrive first, as CUSTOM
 *   `fabric.library-chat.sources`; the answer then streams as one assistant
 *   text message.
 * - Nothing is saved: the thread lives as long as the dialog.
 */

export const LIBRARY_CHAT_AGENT_ID = "library-chat";

export const libraryChatPropsSchema = z.object({
	workspaceId: z.string().min(1).max(200),
});
export type LibraryChatProps = z.infer<typeof libraryChatPropsSchema>;

/** One document passage an answer draws on, as the source card shows it. */
const librarySourceSchema = z.object({
	filename: z.string(),
	pageNumber: z.number().optional(),
	chunkIndex: z.number(),
	score: z.number(),
	content: z.string(),
});
export type LibrarySource = z.infer<typeof librarySourceSchema>;

export const LIBRARY_CHAT_EVENT = {
	sources: runtimeCustomEventName(LIBRARY_CHAT_AGENT_ID, "sources"),
} as const;

/** The value of `LIBRARY_CHAT_EVENT.sources`. */
export const librarySourcesEventSchema = z.object({
	sources: z.array(librarySourceSchema),
});
