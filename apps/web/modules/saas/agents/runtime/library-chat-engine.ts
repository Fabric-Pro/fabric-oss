import { type AGUIEvent, EventType, type RunAgentInput } from "@ag-ui/client";
import { streamText } from "@repo/ai";
import {
	appendWorkspaceDocumentChat,
	getEffectiveRagSettings,
	getWorkspaceDocumentChat,
	isFeatureEnabled,
} from "@repo/database";
import {
	LIBRARY_CHAT_AGENT_ID,
	LIBRARY_CHAT_EVENT,
	type LibraryChatProps,
	libraryChatPropsSchema,
} from "@saas/agents/lib/workspace-document-chat-protocol";
import {
	checkWorkspaceChatAccess,
	EMPTY_WORKSPACE_CHAT_ANSWER,
	prepareWorkspaceChatTurn,
	type WorkspaceChatWorkspace,
} from "../../../../app/api/workspaces/chat/workspace-chat-turn";
import {
	type InProcessAdmission,
	InProcessEngine,
	type InProcessRun,
	type RequestReplyMessage,
	requestReplyConversation,
} from "./in-process-engine";

/**
 * A library's Chat with Documents on the agent runtime
 * (`library-chat-runtime-protocol.ts`): the turn the dialog's route answers
 * in one JSON reply (`workspace-chat-turn.ts`), streamed. Served only while
 * `COPILOTKIT_LIBRARY_CHAT` is on for the caller's organization, and only
 * for a workspace `hasWorkspaceAccess` lets the caller read; both are
 * checked before any model call. Retrieval uses the workspace's search
 * settings, and an organization's workspace keeps the person's document
 * conversation, both as on the route.
 */

export { LIBRARY_CHAT_AGENT_ID };

interface LibraryChatTurn {
	workspace: WorkspaceChatWorkspace;
	question: string;
	history: RequestReplyMessage[];
}

export class LibraryChatEngine extends InProcessEngine<
	LibraryChatProps,
	LibraryChatTurn
> {
	readonly agentId = LIBRARY_CHAT_AGENT_ID;
	protected readonly propsSchema = libraryChatPropsSchema;

	protected async admit({
		input,
		props,
	}: {
		input: RunAgentInput;
		props: LibraryChatProps;
	}): Promise<InProcessAdmission<LibraryChatTurn>> {
		if (
			!(await isFeatureEnabled(
				"COPILOTKIT_LIBRARY_CHAT",
				this.caller.organizationId,
			))
		) {
			return {
				ok: false,
				code: "FEATURE_DISABLED",
				message:
					"The library chat is not enabled on the agent runtime for this organization.",
			};
		}
		const conversation = requestReplyConversation(input.messages);
		if (!conversation) {
			return {
				ok: false,
				code: "NO_MESSAGE",
				message: "A run needs a new user message.",
			};
		}
		const access = await checkWorkspaceChatAccess(
			this.caller.userId,
			props.workspaceId,
		);
		if (!access.ok) {
			return {
				ok: false,
				code: access.status === 403 ? "FORBIDDEN" : "NOT_FOUND",
				message: access.error,
			};
		}
		return {
			ok: true,
			turn: { workspace: access.workspace, ...conversation },
		};
	}

	protected async *turn(
		{ workspace, question, history }: LibraryChatTurn,
		{ runId, signal }: InProcessRun,
	): AsyncIterable<AGUIEvent> {
		// An organization's workspace keeps the person's document
		// conversation, as the route does: its saved history answers the
		// question, and the exchange is added to it.
		const actor = workspace.organizationId
			? {
					workspaceId: workspace.id,
					userId: this.caller.userId,
					organizationId: workspace.organizationId,
				}
			: null;
		const [saved, ragSettings] = await Promise.all([
			actor ? getWorkspaceDocumentChat(actor) : Promise.resolve(null),
			getEffectiveRagSettings(workspace.id),
		]);
		const prepared = await prepareWorkspaceChatTurn({
			userId: this.caller.userId,
			workspace,
			message: question,
			history: saved ? saved.messages.slice(-20) : history,
			ragSettings,
		});
		yield {
			type: EventType.CUSTOM,
			name: LIBRARY_CHAT_EVENT.sources,
			value: { sources: prepared.sources },
		};
		// Stopped, or the client went away, before the model was asked: no
		// model call, so nothing to bill for the answer.
		if (signal.aborted) {
			return;
		}
		const messageId = `${runId}:answer`;
		yield {
			type: EventType.TEXT_MESSAGE_START,
			messageId,
			role: "assistant",
		};
		// A failed request ends the stream with an error part, not a throw.
		let streamError: unknown;
		const generationStart = Date.now();
		const result = streamText({
			model: prepared.model,
			instructions: prepared.instructions,
			messages: prepared.messages,
			onError: ({ error }) => {
				streamError ??= error;
			},
		});
		let answered = false;
		let answer = "";
		try {
			for await (const delta of result.textStream) {
				answer += delta;
				// After a stop or a closed response the browser is sent
				// nothing more, but the request already made runs to its end
				// and is billed.
				if (delta && !signal.aborted) {
					answered = true;
					yield {
						type: EventType.TEXT_MESSAGE_CONTENT,
						messageId,
						delta,
					};
				}
			}
		} catch (error) {
			streamError ??= error;
		}
		if (!streamError && !answered && !signal.aborted) {
			yield {
				type: EventType.TEXT_MESSAGE_CONTENT,
				messageId,
				delta: EMPTY_WORKSPACE_CHAT_ANSWER,
			};
		}
		yield { type: EventType.TEXT_MESSAGE_END, messageId };
		if (streamError) {
			throw streamError;
		}
		prepared.recordAnswer(await result.usage, Date.now() - generationStart);
		if (answered && !signal.aborted) {
			yield {
				type: EventType.CUSTOM,
				name: LIBRARY_CHAT_EVENT.model,
				value: prepared.getAnswerModel(),
			};
		}
		// A stopped question is not kept, as the dialog drops it.
		if (actor && !signal.aborted) {
			yield {
				type: EventType.CUSTOM,
				name: LIBRARY_CHAT_EVENT.history,
				value: {
					persisted: await saveExchange({
						...actor,
						question,
						answer: answer || EMPTY_WORKSPACE_CHAT_ANSWER,
						sources: prepared.sources,
					}),
				},
			};
		}
	}
}

/**
 * Add the exchange to the person's document conversation, as the route
 * does. A workspace the person lost access to meanwhile fails the run; any
 * other failure keeps the answer and says the history was not saved.
 */
async function saveExchange(
	exchange: Parameters<typeof appendWorkspaceDocumentChat>[0],
): Promise<boolean> {
	try {
		await appendWorkspaceDocumentChat(exchange);
		return true;
	} catch (error) {
		if (
			error instanceof Error &&
			error.name === "WorkspaceDocumentChatAccessError"
		) {
			throw error;
		}
		console.error(
			"[Agent Runtime] Could not persist document chat history",
		);
		return false;
	}
}
