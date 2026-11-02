import { EventType } from "@ag-ui/client";
import {
	CUGA_CHAT_EVENT,
	CUGA_GENERALIST_AGENT_ID,
	cugaArtifactsEventSchema,
	cugaContextEventSchema,
} from "@saas/agents/lib/cuga-runtime-protocol";
import { collectRequestReplyRun } from "@saas/agents/lib/request-reply-outcome";

/**
 * One message to the CUGA generalist chat's SYSTEM agent, over either
 * transport (`useRuntimeChatTransport("COPILOTKIT_CUGA_CHAT")` picks): the
 * relay route, or the agent runtime's `cuga-generalist` agent. Both resolve
 * with the whole reply and reject with the message the chat shows (a
 * `RequestReplyRunError` carrying a usage limit's payload, or an
 * `AbortError` once the chat let go of the message).
 */

export interface CugaQuestion {
	agentId: string;
	content: string;
	/** The agent's conversation, from the last reply; null on the first send. */
	contextId: string | null;
	history: ReadonlyArray<{ role: "user" | "assistant"; content: string }>;
	signal: AbortSignal;
}

export interface CugaReply {
	response: string;
	contextId: string | null;
	reasoning?: string;
	artifacts?: unknown[];
}

/** `POST /api/agents/a2a/send`: the relay's reply. */
export async function askCugaRoute(
	question: CugaQuestion & { organizationId: string | null },
): Promise<CugaReply> {
	// The relay verifies membership in this organization before selecting
	// its AI model or issuing a token for the registered agent.
	const response = await fetch("/api/agents/a2a/send", {
		method: "POST",
		signal: question.signal,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			agentId: question.agentId,
			message: {
				role: "user",
				content: question.content,
			},
			contextId: question.contextId,
			history: question.history,
			organizationId: question.organizationId,
		}),
	});

	if (!response.ok) {
		const errorData = await response.json();
		throw new Error(errorData.error || "Failed to get response from CUGA");
	}

	const data = await response.json();
	return {
		response: data.response || "",
		contextId: data.contextId ?? null,
		reasoning: data.reasoning,
		artifacts: data.artifacts,
	};
}

/**
 * The agent runtime's `cuga-generalist` agent. Each message runs on its own
 * thread: nothing is saved and the agent's conversation id carries the
 * conversation, so a turn the server still runs after a dropped connection
 * never holds up the next message.
 */
export async function askCugaRuntime(
	question: CugaQuestion & {
		/** The organization on screen, which the runtime request runs in. */
		organizationId: string | undefined;
	},
): Promise<CugaReply> {
	const reply: {
		text: string;
		reasoning: string;
		contextId?: string | null;
		artifacts?: unknown[];
	} = { text: "", reasoning: "" };
	await collectRequestReplyRun({
		agentId: CUGA_GENERALIST_AGENT_ID,
		threadId: crypto.randomUUID(),
		messages: [
			...question.history,
			{ role: "user", content: question.content },
		],
		forwardedProps: {
			agentId: question.agentId,
			contextId: question.contextId,
		},
		organizationId: question.organizationId,
		signal: question.signal,
		onEvent: (event) => {
			if (event.type === EventType.TEXT_MESSAGE_CONTENT) {
				reply.text += event.delta;
			} else if (event.type === EventType.REASONING_MESSAGE_CONTENT) {
				reply.reasoning += event.delta;
			} else if (event.type === EventType.CUSTOM) {
				if (event.name === CUGA_CHAT_EVENT.context) {
					const parsed = cugaContextEventSchema.safeParse(
						event.value,
					);
					if (parsed.success) {
						reply.contextId = parsed.data.contextId;
					}
				} else if (event.name === CUGA_CHAT_EVENT.artifacts) {
					const parsed = cugaArtifactsEventSchema.safeParse(
						event.value,
					);
					if (parsed.success) {
						reply.artifacts = parsed.data.artifacts;
					}
				}
			}
		},
	});
	return {
		response: reply.text,
		contextId: reply.contextId ?? question.contextId,
		reasoning: reply.reasoning || undefined,
		artifacts: reply.artifacts,
	};
}
