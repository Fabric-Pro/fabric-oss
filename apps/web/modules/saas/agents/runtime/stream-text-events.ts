import { type AGUIEvent, EventType } from "@ag-ui/client";
import {
	stepMessageId,
	TOOL_ERROR_METADATA,
} from "@saas/agents/lib/sidekick-runtime-protocol";
import type { TextStreamPart, ToolSet } from "ai";

/**
 * An AI SDK `streamText` run's full stream as the AG-UI events of one
 * in-process turn (`InProcessEngine.run` wraps them in RUN_STARTED …
 * RUN_FINISHED): assistant text as text messages, and each tool call with
 * its result.
 *
 * - Message ids name the model step that wrote them (`stepMessageId`); a
 *   tool call hangs off the step's last text message, or a new id when the
 *   step has no text before it.
 * - A tool call is sent whole (START, its full arguments, END), after any
 *   open text message is ended.
 * - Tool results are held until their step finishes and then sent in call
 *   order, so a step's text and calls come before them. A step that fails,
 *   or a stream that throws, still sends the results it holds before the
 *   failure is rethrown: the route sent each one as it arrived, and the form
 *   auto-apply and the next turn's history depend on them.
 * - A tool that throws answers with `toolErrorText(error)`, as the route's
 *   UI message stream did, and its result carries `TOOL_ERROR_METADATA`, so
 *   the history sends the model an error result, not a successful one.
 * - Reasoning, sources, files and raw provider chunks are dropped: the panel
 *   shows text and tool results only.
 */
export async function* streamTextRunEvents<TOOLS extends ToolSet>(
	parts: AsyncIterable<TextStreamPart<TOOLS>>,
	options: { runId: string; toolErrorText: (error: unknown) => string },
): AsyncGenerator<AGUIEvent> {
	let count = 0;
	let step = 0;
	const nextId = () => stepMessageId(options.runId, step, count++);
	let openText: string | null = null;
	let stepParentId: string | null = null;
	/** The step's tool calls, in the order the model made them. */
	let stepCalls: string[] = [];
	let pendingResults: Array<{
		toolCallId: string;
		content: string;
		failed: boolean;
	}> = [];

	function* close(): Generator<AGUIEvent> {
		if (openText) {
			yield { type: EventType.TEXT_MESSAGE_END, messageId: openText };
			openText = null;
		}
	}
	function* flush(): Generator<AGUIEvent> {
		const order = stepCalls;
		const results = pendingResults.sort(
			(a, b) => order.indexOf(a.toolCallId) - order.indexOf(b.toolCallId),
		);
		pendingResults = [];
		for (const { toolCallId, content, failed } of results) {
			yield {
				type: EventType.TOOL_CALL_RESULT,
				messageId: `${toolCallId}:result`,
				toolCallId,
				role: "tool",
				content,
				...(failed ? { metadata: { ...TOOL_ERROR_METADATA } } : {}),
			};
		}
	}

	try {
		for await (const part of parts) {
			switch (part.type) {
				case "text-start": {
					yield* close();
					const messageId = nextId();
					yield {
						type: EventType.TEXT_MESSAGE_START,
						messageId,
						role: "assistant",
					};
					openText = messageId;
					stepParentId = messageId;
					break;
				}
				case "text-delta":
					if (openText && part.text) {
						yield {
							type: EventType.TEXT_MESSAGE_CONTENT,
							messageId: openText,
							delta: part.text,
						};
					}
					break;
				case "text-end":
					yield* close();
					break;
				case "tool-call": {
					yield* close();
					stepParentId ??= nextId();
					stepCalls.push(part.toolCallId);
					yield {
						type: EventType.TOOL_CALL_START,
						toolCallId: part.toolCallId,
						toolCallName: part.toolName,
						parentMessageId: stepParentId,
					};
					yield {
						type: EventType.TOOL_CALL_ARGS,
						toolCallId: part.toolCallId,
						delta: JSON.stringify(part.input ?? {}),
					};
					yield {
						type: EventType.TOOL_CALL_END,
						toolCallId: part.toolCallId,
					};
					break;
				}
				case "tool-result":
					pendingResults.push({
						toolCallId: part.toolCallId,
						content:
							typeof part.output === "string"
								? part.output
								: JSON.stringify(part.output),
						failed: false,
					});
					break;
				case "tool-error":
					pendingResults.push({
						toolCallId: part.toolCallId,
						content: options.toolErrorText(part.error),
						failed: true,
					});
					break;
				case "finish-step":
					yield* close();
					yield* flush();
					step += 1;
					stepParentId = null;
					stepCalls = [];
					break;
				case "error":
					yield* close();
					yield* flush();
					throw part.error;
				case "abort":
				case "finish":
					yield* close();
					yield* flush();
					return;
				case "start":
				case "start-step":
				case "reasoning-start":
				case "reasoning-delta":
				case "reasoning-end":
				case "reasoning-file":
				case "source":
				case "file":
				case "custom":
				case "raw":
				case "tool-input-start":
				case "tool-input-delta":
				case "tool-input-end":
				case "tool-output-denied":
				case "tool-approval-request":
				case "tool-approval-response":
					break;
				default: {
					const unreachable: never = part;
					throw new Error(
						`Unknown stream part ${JSON.stringify(unreachable)}`,
					);
				}
			}
		}
	} catch (error) {
		yield* close();
		yield* flush();
		throw error;
	}
	yield* close();
	yield* flush();
}
