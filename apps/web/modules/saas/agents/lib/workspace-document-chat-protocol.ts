import { runtimeCustomEventName } from "@saas/agents/lib/runtime-custom-events";
import { z } from "zod";

/**
 * Workspace Chat with Documents over the agent runtime: what the
 * `library-chat` engine (`modules/saas/agents/runtime/library-chat-engine.ts`)
 * and `WorkspaceDocumentChatDialog` agree on.
 *
 * - The run's messages are the conversation so far; the last is the question.
 * - `forwardedProps` names the workspace (`libraryChatPropsSchema`).
 * - The sources the answer draws on arrive first, as CUSTOM
 *   `fabric.library-chat.sources`; the answer then streams as one assistant
 *   text message.
 * - A generated answer's served identity arrives as CUSTOM
 *   `fabric.library-chat.model` after its text ends.
 * - For an organization's workspace the exchange is saved to the person's
 *   document conversation, as the route saves it, and the run's question is
 *   answered with that saved history, not the messages it sent; CUSTOM
 *   `fabric.library-chat.history` says whether the save worked. A personal
 *   workspace saves nothing: the thread lives as long as the dialog.
 */

export const LIBRARY_CHAT_AGENT_ID = "library-chat";

export const libraryChatPropsSchema = z.object({
	workspaceId: z.string().min(1).max(200),
});
export type LibraryChatProps = z.infer<typeof libraryChatPropsSchema>;

/** One document passage an answer draws on, as the source card shows it. */
const workspaceDocumentSourceSchema = z.object({
	filename: z.string(),
	pageNumber: z.number().optional(),
	chunkIndex: z.number(),
	score: z.number(),
	content: z.string(),
});
export type WorkspaceDocumentSource = z.infer<
	typeof workspaceDocumentSourceSchema
>;

export const LIBRARY_CHAT_EVENT = {
	sources: runtimeCustomEventName(LIBRARY_CHAT_AGENT_ID, "sources"),
	model: runtimeCustomEventName(LIBRARY_CHAT_AGENT_ID, "model"),
	history: runtimeCustomEventName(LIBRARY_CHAT_AGENT_ID, "history"),
} as const;

/** The value of `LIBRARY_CHAT_EVENT.history`. */
export const libraryHistoryEventSchema = z.object({ persisted: z.boolean() });

/** The value of `LIBRARY_CHAT_EVENT.sources`. */
export const librarySourcesEventSchema = z.object({
	sources: z.array(workspaceDocumentSourceSchema),
});
