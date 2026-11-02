import { type AGUIEvent, EventType, type RunAgentInput } from "@ag-ui/client";
import type { A2ATask } from "@repo/agent-core/a2a";
import { isFeatureEnabled } from "@repo/database";
import {
	CUGA_CHAT_EVENT,
	CUGA_GENERALIST_AGENT_ID,
	type CugaChatProps,
	cugaChatPropsSchema,
} from "@saas/agents/lib/cuga-runtime-protocol";
import { z } from "zod";
import {
	type A2ARelayAdmission,
	type A2ATaskReply,
	admitA2ARelay,
	readA2ATaskReply,
	resolveA2ARelayAIConfig,
	sendA2ARelayMessage,
} from "../../../../app/api/agents/a2a/send/a2a-send-turn";
import {
	type InProcessAdmission,
	InProcessEngine,
	type InProcessRun,
	type RequestReplyMessage,
	requestReplyConversation,
} from "./in-process-engine";

/**
 * The CUGA generalist chat on the agent runtime (`cuga-runtime-protocol.ts`):
 * the relay `POST /api/agents/a2a/send` runs (`a2a-send-turn.ts`), with the
 * reply as runtime events. Served only while `COPILOTKIT_CUGA_CHAT` is on for
 * the caller's organization, and only for an ACTIVE SYSTEM agent whose
 * endpoint passes the guard, to a member of the organization; all are checked
 * before the model is resolved or an AI token issued. Nothing is saved: the
 * chat keeps the agent's conversation id and sends it back.
 */

/**
 * The longest the engine waits for the agent: two full relay attempts (2 ×
 * the route's 120 s client timeout) plus the first 1 s retry backoff,
 * rounded up. A third attempt would outlive the runtime route's maxDuration
 * (300 s), and the platform would then cut the response instead of the run
 * ending with an error.
 */
export const CUGA_RELAY_DEADLINE_MS = 250000;

interface CugaTurn {
	agentUrl: string;
	question: string;
	history: RequestReplyMessage[];
	contextId: string | null;
}

type RelayRefusalReason = Extract<A2ARelayAdmission, { ok: false }>["reason"];

/** The run's code for a refusal the relay answers with its HTTP status. */
function relayRefusalCode(reason: RelayRefusalReason): string {
	switch (reason) {
		case "agent-not-found":
			return "NOT_FOUND";
		case "endpoint-refused":
			return "AGENT_ENDPOINT_REFUSED";
		case "not-a-member":
			return "FORBIDDEN";
		default: {
			const unreachable: never = reason;
			return unreachable;
		}
	}
}

export class CugaGeneralistEngine extends InProcessEngine<
	CugaChatProps,
	CugaTurn
> {
	readonly agentId = CUGA_GENERALIST_AGENT_ID;
	protected readonly propsSchema = cugaChatPropsSchema;

	protected async admit({
		input,
		props,
	}: {
		input: RunAgentInput;
		props: CugaChatProps;
	}): Promise<InProcessAdmission<CugaTurn>> {
		if (
			!(await isFeatureEnabled(
				"COPILOTKIT_CUGA_CHAT",
				this.caller.organizationId,
			))
		) {
			return {
				ok: false,
				code: "FEATURE_DISABLED",
				message:
					"The CUGA chat is not enabled on the agent runtime for this organization.",
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
		// The organization is always named here, so membership is always
		// checked: a project guest's tie, which the endpoint accepts, is not
		// enough, as the route refuses one.
		const admission = await admitA2ARelay({
			userId: this.caller.userId,
			agentId: props.agentId,
			organizationId: this.caller.organizationId,
		});
		if (!admission.ok) {
			return {
				ok: false,
				code: relayRefusalCode(admission.reason),
				message: admission.error,
			};
		}
		return {
			ok: true,
			turn: {
				agentUrl: admission.agentUrl,
				...conversation,
				contextId: props.contextId ?? null,
			},
		};
	}

	protected async *turn(
		{ agentUrl, question, history, contextId }: CugaTurn,
		{ runId, signal }: InProcessRun,
	): AsyncIterable<AGUIEvent> {
		const deadline = AbortSignal.timeout(CUGA_RELAY_DEADLINE_MS);
		// Here, not in `admit`: a usage limit ends the run with its limits,
		// which only a thrown error carries.
		const ai = await resolveA2ARelayAIConfig({
			userId: this.caller.userId,
			organizationId: this.caller.organizationId,
			impersonated: Boolean(this.caller.audit.session?.impersonatedBy),
		});
		if (!ai.ok) {
			throw ai.limit;
		}
		let task: A2ATask;
		try {
			task = await sendA2ARelayMessage({
				agentUrl,
				content: question,
				metadata: undefined,
				history,
				contextId,
				tenant: {
					userId: this.caller.userId,
					organizationId: this.caller.organizationId,
				},
				aiConfig: ai.aiConfig,
				signal: AbortSignal.any([signal, deadline]),
			});
		} catch (error) {
			// Stopped, or the client went away: the run ends with no answer.
			// The deadline, or any other failure, ends it as a failure whose
			// detail (which can name the agent's URL) stays in the server log.
			if (signal.aborted) {
				return;
			}
			throw error;
		}
		if (signal.aborted) {
			return;
		}
		yield* cugaReplyEvents(readA2ATaskReply(task, contextId), runId);
	}
}

/** The tool calls an agent reports in its artifacts, as the chat reads them. */
const relayToolCallsSchema = z.array(
	z.object({
		name: z.string().min(1),
		args: z.unknown().optional(),
		result: z.unknown().optional(),
	}),
);

/**
 * The relay's reply as runtime events: the conversation id, the reasoning,
 * one assistant message (always, as the route always answers) with the
 * agent's tool calls, then the artifacts.
 */
function cugaReplyEvents(reply: A2ATaskReply, runId: string): AGUIEvent[] {
	const events: AGUIEvent[] = [
		{
			type: EventType.CUSTOM,
			name: CUGA_CHAT_EVENT.context,
			value: { contextId: reply.contextId ?? null },
		},
	];
	if (reply.reasoning) {
		const reasoningId = `${runId}:reasoning`;
		events.push(
			{ type: EventType.REASONING_START, messageId: reasoningId },
			{
				type: EventType.REASONING_MESSAGE_START,
				messageId: reasoningId,
				role: "reasoning",
			},
			{
				type: EventType.REASONING_MESSAGE_CONTENT,
				messageId: reasoningId,
				delta: reply.reasoning,
			},
			{ type: EventType.REASONING_MESSAGE_END, messageId: reasoningId },
			{ type: EventType.REASONING_END, messageId: reasoningId },
		);
	}
	const messageId = `${runId}:answer`;
	events.push({
		type: EventType.TEXT_MESSAGE_START,
		messageId,
		role: "assistant",
	});
	if (reply.response) {
		events.push({
			type: EventType.TEXT_MESSAGE_CONTENT,
			messageId,
			delta: reply.response,
		});
	}
	const toolCalls = relayToolCallsSchema.safeParse(reply.toolCalls);
	if (!toolCalls.success) {
		console.warn(
			"[Agent Runtime] cuga-generalist dropped malformed tool calls",
			toolCalls.error.issues,
		);
	}
	for (const [index, toolCall] of (toolCalls.data ?? []).entries()) {
		const toolCallId = `${runId}:tool:${index}`;
		events.push(
			{
				type: EventType.TOOL_CALL_START,
				toolCallId,
				toolCallName: toolCall.name,
				parentMessageId: messageId,
			},
			{
				type: EventType.TOOL_CALL_ARGS,
				toolCallId,
				delta: JSON.stringify(toolCall.args ?? {}),
			},
			{ type: EventType.TOOL_CALL_END, toolCallId },
			{
				type: EventType.TOOL_CALL_RESULT,
				messageId: `${toolCallId}:result`,
				toolCallId,
				role: "tool",
				content: JSON.stringify(toolCall.result ?? null),
			},
		);
	}
	events.push({ type: EventType.TEXT_MESSAGE_END, messageId });
	if (reply.artifacts?.length) {
		events.push({
			type: EventType.CUSTOM,
			name: CUGA_CHAT_EVENT.artifacts,
			value: { artifacts: reply.artifacts },
		});
	}
	return events;
}
