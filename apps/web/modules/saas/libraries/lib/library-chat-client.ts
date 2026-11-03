import { EventType } from "@ag-ui/client";
import {
	type AnswerModelInfo,
	answerModelInfoSchema,
} from "@repo/ai/lib/answer-model-info";
import { collectRequestReplyRun } from "@saas/agents/lib/request-reply-outcome";
import {
	LIBRARY_CHAT_AGENT_ID,
	LIBRARY_CHAT_EVENT,
	type LibrarySource,
	librarySourcesEventSchema,
} from "./library-chat-runtime-protocol";

/**
 * One question to a library's Chat with Documents, over either transport
 * (`useRuntimeChatTransport("COPILOTKIT_LIBRARY_CHAT")` picks): the route
 * answers in one reply, the agent runtime streams the answer after its
 * sources. Both resolve with the whole answer and reject with the message
 * the dialog shows (a runtime run's failure as a `RequestReplyRunError`
 * carrying a usage limit's payload, or an `AbortError` once the dialog let
 * go of the question).
 * The runtime question is only ever ended by aborting its request, never by
 * the runtime's `stop`: the engine takes a closed response as the stop.
 */

export interface LibraryChatQuestion {
	workspaceId: string;
	message: string;
	history: ReadonlyArray<{ role: "user" | "assistant"; content: string }>;
}

export interface LibraryChatAnswer {
	response: string;
	sources?: LibrarySource[];
	model?: AnswerModelInfo;
}

const NO_ANSWER = "I couldn't find relevant information in the documents.";

/** `POST /api/workspaces/chat`: the whole answer at once. */
export async function askLibraryRoute(
	question: LibraryChatQuestion & {
		organizationId?: string | null;
		signal: AbortSignal;
	},
): Promise<LibraryChatAnswer> {
	const response = await fetch("/api/workspaces/chat", {
		method: "POST",
		signal: question.signal,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			workspaceId: question.workspaceId,
			organizationId: question.organizationId,
			message: question.message,
			history: question.history,
		}),
	});

	if (!response.ok) {
		const errorData = await response.json();
		throw new Error(errorData.error || "Failed to get response");
	}

	const data = await response.json();
	return {
		response: data.response || NO_ANSWER,
		sources: data.sources,
		model: answerModelInfoSchema.safeParse(data.model).data,
	};
}

/**
 * The agent runtime's `library-chat` agent: `onSources` once the passages
 * are found, `onText` with the answer so far as it streams.
 */
export async function askLibraryRuntime(
	question: LibraryChatQuestion & {
		threadId: string;
		/** The organization on screen, which the runtime request runs in. */
		organizationId: string | undefined;
		signal: AbortSignal;
		onSources: (sources: LibrarySource[]) => void;
		onText: (text: string) => void;
	},
): Promise<LibraryChatAnswer> {
	const reply: {
		text: string;
		sources?: LibrarySource[];
		model?: AnswerModelInfo;
	} = { text: "" };
	await collectRequestReplyRun({
		agentId: LIBRARY_CHAT_AGENT_ID,
		threadId: question.threadId,
		messages: [
			...question.history,
			{ role: "user", content: question.message },
		],
		forwardedProps: { workspaceId: question.workspaceId },
		organizationId: question.organizationId,
		signal: question.signal,
		onEvent: (event) => {
			if (
				event.type === EventType.CUSTOM &&
				event.name === LIBRARY_CHAT_EVENT.sources
			) {
				const parsed = librarySourcesEventSchema.safeParse(event.value);
				if (parsed.success && parsed.data.sources.length > 0) {
					reply.sources = parsed.data.sources;
					question.onSources(parsed.data.sources);
				}
			} else if (
				event.type === EventType.CUSTOM &&
				event.name === LIBRARY_CHAT_EVENT.model
			) {
				const parsed = answerModelInfoSchema.safeParse(event.value);
				if (parsed.success) {
					reply.model = parsed.data;
				}
			} else if (event.type === EventType.TEXT_MESSAGE_CONTENT) {
				reply.text += event.delta;
				question.onText(reply.text);
			}
		},
	});
	return {
		response: reply.text || NO_ANSWER,
		sources: reply.sources,
		model: reply.model,
	};
}
