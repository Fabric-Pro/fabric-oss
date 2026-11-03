import { type AGUIEvent, type BaseEvent, EventType } from "@ag-ui/client";
import { EventSchemas } from "@ag-ui/core/schemas";
import { createChartArtifact } from "@repo/agent-tools";
import { answerModelInfoSchema } from "@repo/ai/lib/answer-model-info";
import { z } from "zod";
import {
	DATA_ANALYST_EVENT,
	dataAnalystChartArgsSchema,
} from "../lib/data-analyst-runtime-protocol";

const TOOL_RESULT_PREVIEW_CHARS = 4000;
const toolResultSchema = z.object({
	tool_call_id: z.string(),
	content: z.string(),
});
const snapshotToolMessageSchema = z.union([
	z
		.object({
			lc: z.literal(1),
			type: z.literal("constructor"),
			id: z.array(z.string()).refine((id) => id.at(-1) === "ToolMessage"),
			kwargs: toolResultSchema,
		})
		.transform(({ kwargs }) => kwargs),
	toolResultSchema.extend({ type: z.literal("tool") }),
]);
const snapshotSchema = z.object({ messages: z.array(z.unknown()).optional() });
const modelSnapshotSchema = z.object({
	answerModel: answerModelInfoSchema.nullable(),
});
const successfulToolSchema = z.object({ success: z.literal(true) });

class DataAnalystAgentError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DataAnalystAgentError";
	}
}

interface ToolCall {
	name: string;
	args: string;
	open: boolean;
	answered: boolean;
}

export class DataAnalystEventTranslator {
	private readonly openMessages = new Set<string>();
	private readonly toolCalls = new Map<string, ToolCall>();
	private ended = false;

	get finished(): boolean {
		return this.ended;
	}

	translate(raw: BaseEvent): AGUIEvent[] {
		if (this.ended) {
			return [];
		}
		const parsed = EventSchemas.safeParse(raw);
		if (!parsed.success) {
			return [];
		}
		// Typed as the client's event union rather than the schema's inferred
		// type: TypeScript 5.9, which `next build` type-checks with, does not
		// narrow the inferred union to `never` in the exhaustive default below.
		const event: AGUIEvent = parsed.data;
		switch (event.type) {
			case EventType.RUN_STARTED:
				return [];
			case EventType.RUN_FINISHED:
				this.ended = true;
				return this.close();
			case EventType.RUN_ERROR:
				throw new DataAnalystAgentError(event.message);
			case EventType.TEXT_MESSAGE_START:
				if (this.openMessages.has(event.messageId)) {
					return [];
				}
				this.openMessages.add(event.messageId);
				return [
					{
						type: event.type,
						messageId: event.messageId,
						role: "assistant",
					},
				];
			case EventType.TEXT_MESSAGE_CONTENT:
				return this.openMessages.has(event.messageId)
					? [
							{
								type: event.type,
								messageId: event.messageId,
								delta: event.delta,
							},
						]
					: [];
			case EventType.TEXT_MESSAGE_END:
				return this.openMessages.delete(event.messageId)
					? [{ type: event.type, messageId: event.messageId }]
					: [];
			case EventType.TOOL_CALL_START:
				if (this.toolCalls.has(event.toolCallId)) {
					return [];
				}
				this.toolCalls.set(event.toolCallId, {
					name: event.toolCallName,
					args: "",
					open: true,
					answered: false,
				});
				return [
					{
						type: event.type,
						toolCallId: event.toolCallId,
						toolCallName: event.toolCallName,
					},
				];
			case EventType.TOOL_CALL_ARGS: {
				const call = this.toolCalls.get(event.toolCallId);
				if (!call?.open) {
					return [];
				}
				call.args += event.delta;
				return [
					{
						type: event.type,
						toolCallId: event.toolCallId,
						delta: event.delta,
					},
				];
			}
			case EventType.TOOL_CALL_END: {
				const call = this.toolCalls.get(event.toolCallId);
				if (!call?.open) {
					return [];
				}
				call.open = false;
				return [{ type: event.type, toolCallId: event.toolCallId }];
			}
			case EventType.STATE_SNAPSHOT:
				return [
					...this.results(event.snapshot),
					...this.model(event.snapshot),
				];
			case EventType.TOOL_CALL_RESULT:
				return this.results({
					messages: [
						{
							type: "tool",
							tool_call_id: event.toolCallId,
							content: event.content,
						},
					],
				});
			case EventType.STEP_STARTED:
			case EventType.STEP_FINISHED:
			case EventType.MESSAGES_SNAPSHOT:
			case EventType.STATE_DELTA:
			case EventType.TEXT_MESSAGE_CHUNK:
			case EventType.TOOL_CALL_CHUNK:
			case EventType.ACTIVITY_SNAPSHOT:
			case EventType.ACTIVITY_DELTA:
			case EventType.RAW:
			case EventType.CUSTOM:
			case EventType.REASONING_START:
			case EventType.REASONING_MESSAGE_START:
			case EventType.REASONING_MESSAGE_CONTENT:
			case EventType.REASONING_MESSAGE_END:
			case EventType.REASONING_MESSAGE_CHUNK:
			case EventType.REASONING_END:
			case EventType.REASONING_ENCRYPTED_VALUE:
			case EventType.SUBAGENT_STARTED:
			case EventType.SUBAGENT_FINISHED:
			case EventType.SUBAGENT_ERROR:
				return [];
			default: {
				const exhaustive: never = event;
				return exhaustive;
			}
		}
	}

	close(): AGUIEvent[] {
		const events: AGUIEvent[] = [];
		for (const [toolCallId, call] of this.toolCalls) {
			if (call.open) {
				events.push({ type: EventType.TOOL_CALL_END, toolCallId });
				call.open = false;
			}
		}
		for (const messageId of this.openMessages) {
			events.push({ type: EventType.TEXT_MESSAGE_END, messageId });
		}
		this.openMessages.clear();
		return events;
	}

	private model(snapshot: unknown): AGUIEvent[] {
		const parsed = modelSnapshotSchema.safeParse(snapshot);
		return parsed.success
			? [
					{
						type: EventType.CUSTOM,
						name: DATA_ANALYST_EVENT.model,
						value: parsed.data.answerModel,
					},
				]
			: [];
	}

	private results(snapshot: unknown): AGUIEvent[] {
		const state = snapshotSchema.safeParse(snapshot);
		if (!state.success) {
			return [];
		}
		const events: AGUIEvent[] = [];
		for (const message of state.data.messages ?? []) {
			const result = snapshotToolMessageSchema.safeParse(message);
			if (!result.success) {
				continue;
			}
			const { tool_call_id: toolCallId, content } = result.data;
			const call = this.toolCalls.get(toolCallId);
			if (!call || call.open || call.answered) {
				continue;
			}
			call.answered = true;
			events.push({
				type: EventType.TOOL_CALL_RESULT,
				messageId: `${toolCallId}:result`,
				toolCallId,
				role: "tool",
				content:
					content.length > TOOL_RESULT_PREVIEW_CHARS
						? `${content.slice(0, TOOL_RESULT_PREVIEW_CHARS)}…`
						: content,
			});
			if (call.name !== "create_chart") {
				continue;
			}
			try {
				const success = successfulToolSchema.safeParse(
					JSON.parse(content),
				);
				const args = dataAnalystChartArgsSchema.safeParse(
					JSON.parse(call.args),
				);
				if (success.success && args.success) {
					events.push({
						type: EventType.CUSTOM,
						name: DATA_ANALYST_EVENT.chart,
						value: {
							toolCallId,
							chart: createChartArtifact(args.data),
						},
					});
				}
			} catch {}
		}
		return events;
	}
}
