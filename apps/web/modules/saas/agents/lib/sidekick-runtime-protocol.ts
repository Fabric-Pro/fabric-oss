import { contentToText, type Message, type ToolCall } from "@ag-ui/client";
import type { UIMessage } from "ai";
import { z } from "zod";

/**
 * The Agent Builder Sidekick over the agent runtime: what the
 * `agent-builder-sidekick` engine (`modules/saas/agents/runtime/sidekick-engine.ts`)
 * and the panel (`sidekick/useSidekickChat.ts`) agree on.
 *
 * - The run's messages are the conversation so far, tool calls and their
 *   results included; the last is the person's new message.
 * - `forwardedProps` names the agent being edited and carries the form as
 *   it is now (`sidekickRunPropsSchema`).
 * - The reply streams as AG-UI text and tool-call events; there is no side
 *   payload, so no CUSTOM event.
 * - An assistant message's id names the model step that wrote it
 *   (`stepMessageId`), which is how the reply's steps are rebuilt.
 * - Nothing is saved: the thread lives as long as the panel.
 */

export const SIDEKICK_AGENT_ID = "agent-builder-sidekick";

/**
 * The id of a run's `n`th assistant message, written in model step `step`.
 * A step can write several messages (text after a tool call opens a new
 * one), and the AG-UI client puts each tool result right after the message
 * holding its call, so only the ids tell one step's messages from the next
 * step's.
 */
export function stepMessageId(runId: string, step: number, n: number): string {
	return `${runId}:s${step}:m${n}`;
}

/**
 * The metadata of a tool result whose tool threw. The engine sets it on the
 * TOOL_CALL_RESULT, the AG-UI client copies it onto the tool message, and
 * `sidekickUiMessages` reads the call back as failed (`output-error`), as
 * `useChat` held it, so the next turn sends the model an error result.
 */
export const TOOL_ERROR_METADATA = { toolError: true } as const;

/** The step a `stepMessageId` names; any other id is a step of its own. */
function stepOf(messageId: string): string {
	return /^(.*:s\d+):m\d+$/.exec(messageId)?.[1] ?? messageId;
}

export const sidekickRunPropsSchema = z.object({
	agentId: z.string().min(1).max(200),
	// Discriminates server-side authz: "registered" looks up RegisteredAgent;
	// "instance" looks up AgentTemplateInstance; "new" skips lookup entirely.
	// Defaults to "registered" for backward compat with the builder page.
	entityType: z.enum(["registered", "instance", "new"]).default("registered"),
	formSnapshot: z.record(z.string(), z.unknown()),
});
export type SidekickRunProps = z.infer<typeof sidekickRunPropsSchema>;

type UIMessagePart = UIMessage["parts"][number];

/**
 * A run's AG-UI conversation as the AI SDK messages `useChat` holds for the
 * Sidekick's route: the one mapping both the engine (the model's history)
 * and the panel (rendering, form auto-apply) read.
 *
 * Each run of consecutive assistant and tool messages is one assistant
 * message, as `useChat` builds one per reply. A `step-start` part opens
 * each model step the message ids name (`stepMessageId`), as the route's
 * stream opens one per step, since `convertToModelMessages` splits
 * assistant blocks only there. A tool call carries its result as a string
 * `output` once its tool message arrived (as `errorText` when the message
 * has `TOOL_ERROR_METADATA`), and is `input-available` until then. System,
 * developer, reasoning and activity messages are left out.
 */
export function sidekickUiMessages(messages: readonly Message[]): UIMessage[] {
	const results = new Map<string, ToolResult>();
	for (const message of messages) {
		if (message.role === "tool") {
			results.set(message.toolCallId, {
				text: contentToText(message.content),
				failed:
					message.metadata?.toolError ===
					TOOL_ERROR_METADATA.toolError,
			});
		}
	}
	const uiMessages: UIMessage[] = [];
	let reply: UIMessage | null = null;
	let step: string | null = null;
	for (const message of messages) {
		switch (message.role) {
			case "user":
				reply = null;
				uiMessages.push({
					id: message.id,
					role: "user",
					parts: [
						{ type: "text", text: contentToText(message.content) },
					],
				});
				break;
			case "assistant": {
				if (!reply) {
					reply = { id: message.id, role: "assistant", parts: [] };
					uiMessages.push(reply);
					step = null;
				}
				const messageStep = stepOf(message.id);
				if (messageStep !== step) {
					reply.parts.push({ type: "step-start" });
					step = messageStep;
				}
				if (message.content) {
					reply.parts.push({ type: "text", text: message.content });
				}
				for (const call of message.toolCalls ?? []) {
					reply.parts.push(toolPart(call, results.get(call.id)));
				}
				break;
			}
			case "tool":
				break;
			case "system":
			case "developer":
			case "reasoning":
			case "activity":
				break;
			default: {
				const unreachable: never = message;
				throw new Error(
					`Unknown message ${JSON.stringify(unreachable)}`,
				);
			}
		}
	}
	return uiMessages;
}

interface ToolResult {
	text: string;
	/** The tool threw; `text` is the error the model is told. */
	failed: boolean;
}

function toolPart(
	call: ToolCall,
	result: ToolResult | undefined,
): UIMessagePart {
	const type: `tool-${string}` = `tool-${call.function.name}`;
	const input = parseArguments(call.function.arguments);
	if (!result) {
		return { type, toolCallId: call.id, state: "input-available", input };
	}
	return result.failed
		? {
				type,
				toolCallId: call.id,
				state: "output-error",
				input,
				errorText: result.text,
			}
		: {
				type,
				toolCallId: call.id,
				state: "output-available",
				input,
				output: result.text,
			};
}

/** A tool call's arguments as the model sent them; the raw text when they are not JSON (client history is untrusted). */
function parseArguments(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}
