import {
	type AGUIEvent,
	contentToText,
	EventType,
	type Message,
} from "@ag-ui/client";
import {
	describeAiError,
	isChatGptPlanSpentCode,
} from "@saas/shared/lib/ai-error-message";
import { z } from "zod";
import type {
	DirectStreamMessage,
	StreamStatus,
} from "../hooks/useDirectStream";
import {
	type ChatGptPlanApiBilling,
	parseChatGptPlanApiBilling,
} from "./chatgpt-plan-api-billing";
import {
	loadedDirectMessages,
	type PersistedDirectMessage,
} from "./direct-chat-history";
import {
	type DirectStreamEvent,
	type DirectStreamInput,
	directStreamEventSchema,
	limitSchema,
} from "./direct-stream-protocol";

/**
 * The agent runtime's AG-UI events for a Direct turn
 * (`modules/saas/agents/runtime/turn-translator.ts`, `direct-turn-follow.ts`)
 * read back as the Direct stream route's events, so one reducer
 * (`applyDirectStreamEvent`) renders both transports.
 *
 * | AG-UI                                         | Direct stream event                     |
 * |-----------------------------------------------|-----------------------------------------|
 * | CUSTOM `fabric.execution`, STATE_SNAPSHOT     | `started`                               |
 * | STATE_DELTA `/progress`                       | `progress`                              |
 * | TEXT_MESSAGE_CONTENT                          | `text`                                  |
 * | REASONING_MESSAGE_CONTENT                     | `reasoning`                             |
 * | CUSTOM `fabric.reasoning-duration`            | `reasoningDuration`                     |
 * | TOOL_CALL_START                               | `tool_start` (pending)                  |
 * | TOOL_CALL_ARGS … TOOL_CALL_END                | `tool_input` (running, the whole args)  |
 * | TOOL_CALL_RESULT                              | `tool_result`                           |
 * | CUSTOM `fabric.sources`                       | `sources`                               |
 * | CUSTOM `fabric.partial-error`                 | `error` with `partial`                  |
 * | CUSTOM `fabric.workflow-confirmation`         | `confirmation_required` (a workflow)    |
 * | RUN_FINISHED success / interrupt (`result`)   | `done`                                  |
 * | RUN_ERROR                                     | `error`                                 |
 *
 * What the stream route carried outside its events, or what only the runtime
 * has, comes back as its own signal: the run's start, the thread snapshot of a
 * connect, the billing header (`fabric.billing`), the approval interrupt, a
 * cancelled run, and the end of the response window (`fabric.reconnect`).
 */
export type RuntimeSignal =
	| { kind: "event"; event: DirectStreamEvent }
	| { kind: "run-started"; runId: string; question: string | null }
	| { kind: "snapshot"; messages: Message[] }
	| { kind: "billing"; apiBilling: ChatGptPlanApiBilling }
	| { kind: "interrupt"; interruptId: string }
	| { kind: "finished" }
	| { kind: "cancelled" }
	| { kind: "failed" }
	| { kind: "reconnect" };

/** The `CUSTOM` event names the runtime's Direct engine emits. */
const FABRIC_EVENT = {
	execution: "fabric.execution",
	billing: "fabric.billing",
	reconnect: "fabric.reconnect",
	reasoningDuration: "fabric.reasoning-duration",
	sources: "fabric.sources",
	partialError: "fabric.partial-error",
	workflowConfirmation: "fabric.workflow-confirmation",
} as const;

const customValueSchema = z.record(z.string(), z.unknown());

/** What a tool call's start told, kept until its result arrives. */
export interface RuntimeToolCall {
	name: string;
	args: string;
	serverName?: string;
	mcpAppResourceUri?: string;
	mcpAppConfigId?: string;
}

const toolMetadataSchema = z.object({
	fabric: z
		.object({
			serverName: z.string().optional(),
			mcpAppResourceUri: z.string().optional(),
			mcpAppConfigId: z.string().optional(),
			status: z.enum(["complete", "error"]).optional(),
			error: z.string().optional(),
		})
		.optional(),
});

const errorMetadataSchema = z.object({
	fabric: z
		.object({
			status: z.number().optional(),
			limit: z.unknown().optional(),
			data: z.unknown().optional(),
		})
		.passthrough()
		.optional(),
});

const progressDeltaSchema = z.array(
	z.object({
		op: z.string(),
		path: z.literal("/progress"),
		value: z.object({
			phase: z.string().optional(),
			message: z.string().optional(),
			progress: z.number().optional(),
			currentActivity: z.string().optional(),
		}),
	}),
);

const executionSchema = z.object({ executionId: z.string() });

const reasoningDurationSchema = z.object({ durationMs: z.number() });

const sourcesValueSchema = z.object({ sources: z.unknown() });

const partialErrorSchema = z.object({
	message: z.string(),
	code: z.string().optional(),
	limit: z.unknown().optional(),
	data: z.unknown().optional(),
});

const resultSchema = z.record(z.string(), z.unknown());

/**
 * The limit an error names, when it is one the chat knows; an unknown one is
 * left off rather than costing the chat the error itself.
 */
function knownLimit(limit: unknown) {
	const parsed = limitSchema.safeParse(limit);
	return parsed.success ? { limit: parsed.data } : {};
}

/** A Direct stream event, when the runtime's payload makes a valid one. */
function directEvent(
	input: DirectStreamInput | Record<string, unknown>,
): RuntimeSignal[] {
	const parsed = directStreamEventSchema.safeParse(input);
	return parsed.success ? [{ kind: "event", event: parsed.data }] : [];
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

function customSignals(name: string, value: unknown): RuntimeSignal[] {
	switch (name) {
		case FABRIC_EVENT.execution: {
			const parsed = executionSchema.safeParse(value);
			return parsed.success
				? directEvent({
						type: "started",
						executionId: parsed.data.executionId,
					})
				: [];
		}
		case FABRIC_EVENT.billing: {
			const apiBilling = parseChatGptPlanApiBilling(value);
			return apiBilling ? [{ kind: "billing", apiBilling }] : [];
		}
		case FABRIC_EVENT.reconnect:
			return [{ kind: "reconnect" }];
		case FABRIC_EVENT.reasoningDuration: {
			const parsed = reasoningDurationSchema.safeParse(value);
			return parsed.success
				? directEvent({
						type: "reasoningDuration",
						durationMs: parsed.data.durationMs,
					})
				: [];
		}
		case FABRIC_EVENT.sources: {
			const parsed = sourcesValueSchema.safeParse(value);
			return parsed.success
				? directEvent({ type: "sources", sources: parsed.data.sources })
				: [];
		}
		case FABRIC_EVENT.partialError: {
			const parsed = partialErrorSchema.safeParse(value);
			if (!parsed.success) {
				return [];
			}
			const { limit, ...partial } = parsed.data;
			return directEvent({
				type: "error",
				...partial,
				...knownLimit(limit),
				partial: true,
			});
		}
		case FABRIC_EVENT.workflowConfirmation: {
			const parsed = customValueSchema.safeParse(value);
			return parsed.success
				? directEvent({ ...parsed.data, type: "confirmation_required" })
				: [];
		}
		default:
			return [];
	}
}

/**
 * The run's error as the stream route reported it. A refusal before the turn
 * started carries the route's HTTP status: a spent ChatGPT plan then reads as
 * the route's refusal did.
 */
function errorSignals(
	event: Extract<AGUIEvent, { type: EventType.RUN_ERROR }>,
): RuntimeSignal[] {
	const metadata = errorMetadataSchema.safeParse(event.metadata ?? {});
	const fabric = metadata.success ? metadata.data.fabric : undefined;
	const message =
		fabric?.status !== undefined && isChatGptPlanSpentCode(event.code)
			? describeAiError(fabric.status, fabric).description
			: event.message;
	return [
		...directEvent({
			type: "error",
			message,
			...(event.code ? { code: event.code } : {}),
			...knownLimit(fabric?.limit),
			...(fabric?.data !== undefined
				? { data: fabric.data }
				: fabric?.status !== undefined
					? { data: fabric }
					: {}),
		}),
		{ kind: "failed" },
	];
}

function finishedSignals(
	event: Extract<AGUIEvent, { type: EventType.RUN_FINISHED }>,
): RuntimeSignal[] {
	const outcome = event.outcome ?? { type: "success" as const };
	switch (outcome.type) {
		case "cancelled":
			return [{ kind: "cancelled" }];
		case "success":
		case "interrupt": {
			const result = resultSchema.safeParse(event.result);
			const interrupt =
				outcome.type === "interrupt"
					? outcome.interrupts[0]
					: undefined;
			return [
				...directEvent({
					...(result.success ? result.data : {}),
					type: "done",
				}),
				...(interrupt
					? [
							{
								kind: "interrupt" as const,
								interruptId: interrupt.id,
							},
						]
					: []),
				{ kind: "finished" },
			];
		}
		default: {
			// A newer runtime's outcome ends the run like a finished one; a new
			// declared outcome fails here at compile time.
			const unhandled: never = outcome;
			console.warn("[DirectRuntime] Unknown run outcome", unhandled);
			return [{ kind: "finished" }];
		}
	}
}

/**
 * Read one runtime event. `tools` carries each tool call's start and streamed
 * arguments across events of the same response.
 */
export function readRuntimeEvent(
	event: AGUIEvent,
	tools: Map<string, RuntimeToolCall>,
): RuntimeSignal[] {
	switch (event.type) {
		case EventType.RUN_STARTED: {
			const question = event.input?.messages.find(
				(message) => message.role === "user",
			);
			return [
				{
					kind: "run-started",
					runId: event.runId,
					question:
						question?.role === "user"
							? contentToText(question.content)
							: null,
				},
			];
		}
		case EventType.MESSAGES_SNAPSHOT:
			return [{ kind: "snapshot", messages: event.messages }];
		case EventType.STATE_SNAPSHOT: {
			const parsed = executionSchema.safeParse(event.snapshot);
			return parsed.success
				? directEvent({
						type: "started",
						executionId: parsed.data.executionId,
					})
				: [];
		}
		case EventType.STATE_DELTA: {
			const parsed = progressDeltaSchema.safeParse(event.delta);
			return parsed.success
				? parsed.data.flatMap((operation) =>
						directEvent({ type: "progress", ...operation.value }),
					)
				: [];
		}
		case EventType.TEXT_MESSAGE_CONTENT:
			return directEvent({ type: "text", content: event.delta });
		case EventType.REASONING_MESSAGE_CONTENT:
			return directEvent({ type: "reasoning", content: event.delta });
		case EventType.TOOL_CALL_START: {
			const metadata = toolMetadataSchema.safeParse(event.metadata ?? {});
			const fabric = metadata.success ? metadata.data.fabric : undefined;
			const toolCall: RuntimeToolCall = {
				name: event.toolCallName,
				args: "",
				serverName: fabric?.serverName,
				mcpAppResourceUri: fabric?.mcpAppResourceUri,
				mcpAppConfigId: fabric?.mcpAppConfigId,
			};
			tools.set(event.toolCallId, toolCall);
			return directEvent({
				type: "tool_start",
				toolCallId: event.toolCallId,
				name: toolCall.name,
				serverName: toolCall.serverName,
				status: "pending",
				mcpAppResourceUri: toolCall.mcpAppResourceUri,
				mcpAppConfigId: toolCall.mcpAppConfigId,
			});
		}
		case EventType.TOOL_CALL_ARGS: {
			const toolCall = tools.get(event.toolCallId);
			if (toolCall) {
				toolCall.args += event.delta;
			}
			return [];
		}
		case EventType.TOOL_CALL_END: {
			const toolCall = tools.get(event.toolCallId);
			if (!toolCall) {
				return [];
			}
			return directEvent({
				type: "tool_input",
				toolCallId: event.toolCallId,
				name: toolCall.name,
				args: toolCall.args ? parseJson(toolCall.args) : {},
				status: "running",
			});
		}
		case EventType.TOOL_CALL_RESULT: {
			const toolCall = tools.get(event.toolCallId);
			const metadata = toolMetadataSchema.safeParse(event.metadata ?? {});
			const fabric = metadata.success ? metadata.data.fabric : undefined;
			return directEvent({
				type: "tool_result",
				toolCallId: event.toolCallId,
				...(toolCall ? { name: toolCall.name } : {}),
				result: parseJson(contentToText(event.content)),
				status: fabric?.status ?? "complete",
				...(fabric?.error ? { error: fabric.error } : {}),
				mcpAppResourceUri: toolCall?.mcpAppResourceUri,
				mcpAppConfigId: toolCall?.mcpAppConfigId,
			});
		}
		case EventType.CUSTOM:
			return customSignals(event.name, event.value);
		case EventType.RUN_FINISHED:
			return finishedSignals(event);
		case EventType.RUN_ERROR:
			return errorSignals(event);
		default:
			return [];
	}
}

const snapshotFabricSchema = z.object({
	fabric: z
		.object({
			timestamp: z.string().optional(),
			metadata: z.record(z.string(), z.unknown()).optional(),
			streamStatus: z
				.enum(["streaming", "completed", "error", "cancelled"])
				.optional(),
			cancelledAt: z.string().optional(),
			reasoningDurationMs: z.number().optional(),
			toolStatus: z
				.record(
					z.string(),
					z.enum(["pending", "running", "success", "error"]),
				)
				.optional(),
		})
		.optional(),
});

const toolArgsSchema = z.record(z.string(), z.unknown());

type SnapshotFabric = NonNullable<
	z.infer<typeof snapshotFabricSchema>["fabric"]
>;

function readSnapshotFabric(metadata: unknown): SnapshotFabric | undefined {
	const parsed = snapshotFabricSchema.safeParse(metadata ?? {});
	return parsed.success ? parsed.data.fabric : undefined;
}

/** The saved fields a snapshot message carries in `metadata.fabric`. */
function snapshotFabric(fabric: SnapshotFabric | undefined): {
	timestamp: string;
	metadata?: Record<string, unknown>;
	streamStatus?: StreamStatus;
	cancelledAt?: string;
	reasoningDurationMs?: number;
} {
	return {
		timestamp: fabric?.timestamp ?? new Date(0).toISOString(),
		...(fabric?.metadata ? { metadata: fabric.metadata } : {}),
		...(fabric?.streamStatus ? { streamStatus: fabric.streamStatus } : {}),
		...(fabric?.cancelledAt ? { cancelledAt: fabric.cancelledAt } : {}),
		...(fabric?.reasoningDurationMs !== undefined
			? { reasoningDurationMs: fabric.reasoningDurationMs }
			: {}),
	};
}

/**
 * A connect's `MESSAGES_SNAPSHOT` as the saved conversation it was read from
 * (`runtime/thread.ts`, `threadSnapshotMessages`): each answer with its tool
 * calls (their results from the tool messages after it) and its reasoning
 * (the reasoning message before it).
 */
export function snapshotToPersistedMessages(
	messages: readonly Message[],
): PersistedDirectMessage[] {
	const results = new Map<string, { content: string; failed: boolean }>();
	const reasoning = new Map<string, string>();
	for (const message of messages) {
		if (message.role === "tool") {
			results.set(message.toolCallId, {
				content: contentToText(message.content),
				failed: message.error !== undefined,
			});
		}
		if (message.role === "reasoning") {
			reasoning.set(
				message.id.replace(/:reasoning$/, ""),
				message.content,
			);
		}
	}
	return messages.flatMap((message): PersistedDirectMessage[] => {
		switch (message.role) {
			case "user":
				return [
					{
						id: message.id,
						role: "user",
						content: contentToText(message.content),
						...snapshotFabric(readSnapshotFabric(message.metadata)),
					},
				];
			case "system":
				return [
					{
						id: message.id,
						role: "system",
						content: message.content,
						...snapshotFabric(readSnapshotFabric(message.metadata)),
					},
				];
			case "assistant": {
				const fabric = readSnapshotFabric(message.metadata);
				const reasoningText = reasoning.get(message.id);
				return [
					{
						id: message.id,
						role: "assistant",
						content: message.content ?? "",
						...snapshotFabric(fabric),
						...(reasoningText ? { reasoningText } : {}),
						toolCalls: message.toolCalls?.map((toolCall) => {
							const result = results.get(toolCall.id);
							const args = toolArgsSchema.safeParse(
								parseJson(toolCall.function.arguments),
							);
							// The saved status; a call saved without one tells
							// only whether its result failed.
							const status =
								fabric?.toolStatus?.[toolCall.id] ??
								(result
									? result.failed
										? ("error" as const)
										: ("success" as const)
									: undefined);
							return {
								id: toolCall.id,
								name: toolCall.function.name,
								args: args.success ? args.data : {},
								...(result ? { result: result.content } : {}),
								...(status ? { status } : {}),
							};
						}),
					},
				];
			}
			case "tool":
			case "reasoning":
			case "developer":
			case "activity":
				return [];
			default: {
				// Left out rather than failing the whole snapshot; a new
				// declared role fails here at compile time.
				const unhandled: never = message;
				console.warn(
					"[DirectRuntime] Skipping a snapshot message",
					unhandled,
				);
				return [];
			}
		}
	});
}

/** A connect's snapshot as the chat shows a reopened conversation. */
export function snapshotDirectMessages(
	messages: readonly Message[],
): DirectStreamMessage[] {
	return loadedDirectMessages(snapshotToPersistedMessages(messages));
}

/**
 * What a reattach that found no running turn shows in place of `shown`:
 * the thread's saved messages when they hold one `shown` lacks (an answer
 * the connect saved for a turn that ended unwatched), else null.
 */
export function savedMessagesToAdopt(
	snapshot: readonly Message[],
	shown: readonly DirectStreamMessage[],
): DirectStreamMessage[] | null {
	const saved = snapshotDirectMessages(snapshot);
	const shownIds = new Set(shown.map((m) => m.id));
	return saved.some((m) => !shownIds.has(m.id)) ? saved : null;
}
