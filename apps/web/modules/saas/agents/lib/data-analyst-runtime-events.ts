import { type AGUIEvent, EventType } from "@ag-ui/client";
import {
	type AiUsageLimitExceededPayload,
	isAiUsageLimitExceededPayload,
} from "@saas/payments/lib/ai-usage-limit-toast";
import {
	type AiErrorToastCopy,
	describeAiError,
	isChatGptPlanSpentCode,
} from "@saas/shared/lib/ai-error-message";
import { z } from "zod";
import type { ToolCallItem } from "../components/FabricChat/shared/types";
import {
	DATA_ANALYST_EVENT,
	type DataAnalystChart,
	dataAnalystChartEventSchema,
} from "./data-analyst-runtime-protocol";
import { settleUnfinishedToolCalls } from "./direct-chat-turns";

export interface DataAnalystTurn {
	text: string;
	toolCalls: ToolCallItem[];
	argsText: Record<string, string>;
	charts: Record<string, DataAnalystChart>;
	status: "running" | "finished" | "failed" | "stopped";
	error: string | null;
	planSpent: AiErrorToastCopy | null;
	usageLimit: AiUsageLimitExceededPayload | null;
}
export const EMPTY_DATA_ANALYST_TURN: DataAnalystTurn = {
	text: "",
	toolCalls: [],
	argsText: {},
	charts: {},
	status: "running",
	error: null,
	planSpent: null,
	usageLimit: null,
};
const errorMetadataSchema = z.object({
	fabric: z
		.object({ status: z.number().optional(), data: z.unknown().optional() })
		.passthrough()
		.optional(),
});
const failedToolResultSchema = z.object({ success: z.literal(false) });

export function endDataAnalystTurn(
	turn: DataAnalystTurn,
	status: "failed" | "stopped" | "finished",
	error: string | null,
): DataAnalystTurn {
	return {
		...turn,
		status,
		error,
		toolCalls: settleUnfinishedToolCalls(turn.toolCalls) ?? [],
	};
}

function toolArgs(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return {};
	}
}

export function applyDataAnalystEvent(
	turn: DataAnalystTurn,
	event: AGUIEvent,
): DataAnalystTurn {
	switch (event.type) {
		case EventType.TEXT_MESSAGE_CONTENT:
			return { ...turn, text: turn.text + event.delta };
		case EventType.TOOL_CALL_START:
			return {
				...turn,
				toolCalls: [
					...turn.toolCalls,
					{
						id: event.toolCallId,
						name: event.toolCallName,
						args: {},
						status: "running",
					},
				],
			};
		case EventType.TOOL_CALL_ARGS:
			return {
				...turn,
				argsText: {
					...turn.argsText,
					[event.toolCallId]:
						(turn.argsText[event.toolCallId] ?? "") + event.delta,
				},
			};
		case EventType.TOOL_CALL_END:
			return {
				...turn,
				toolCalls: turn.toolCalls.map((call) =>
					call.id === event.toolCallId
						? {
								...call,
								args: toolArgs(turn.argsText[call.id] ?? ""),
							}
						: call,
				),
			};
		case EventType.TOOL_CALL_RESULT:
			return {
				...turn,
				toolCalls: turn.toolCalls.map((call) =>
					call.id === event.toolCallId
						? {
								...call,
								status:
									typeof event.content === "string" &&
									failedToolResultSchema.safeParse(
										toolArgs(event.content),
									).success
										? "error"
										: "complete",
								result: turn.charts[call.id] ?? event.content,
							}
						: call,
				),
			};
		case EventType.CUSTOM: {
			if (event.name !== DATA_ANALYST_EVENT.chart) {
				return turn;
			}
			const value = dataAnalystChartEventSchema.safeParse(event.value);
			if (!value.success) {
				return turn;
			}
			const { toolCallId, chart } = value.data;
			return {
				...turn,
				charts: { ...turn.charts, [toolCallId]: chart },
				toolCalls: turn.toolCalls.map((call) =>
					call.id === toolCallId ? { ...call, result: chart } : call,
				),
			};
		}
		case EventType.RUN_ERROR: {
			const metadata = errorMetadataSchema.safeParse(
				event.metadata ?? {},
			);
			const fabric = metadata.success ? metadata.data.fabric : undefined;
			const planSpent =
				fabric?.status !== undefined &&
				isChatGptPlanSpentCode(event.code)
					? describeAiError(fabric.status, {
							...fabric,
							code: event.code,
						})
					: null;
			return {
				...endDataAnalystTurn(
					turn,
					"failed",
					planSpent?.description ?? event.message,
				),
				planSpent,
				usageLimit: isAiUsageLimitExceededPayload(fabric?.data)
					? fabric.data
					: null,
			};
		}
		case EventType.RUN_FINISHED:
			return endDataAnalystTurn(turn, "finished", null);
		case EventType.TEXT_MESSAGE_START:
		case EventType.TEXT_MESSAGE_END:
		case EventType.TEXT_MESSAGE_CHUNK:
		case EventType.TOOL_CALL_CHUNK:
		case EventType.STATE_SNAPSHOT:
		case EventType.STATE_DELTA:
		case EventType.MESSAGES_SNAPSHOT:
		case EventType.ACTIVITY_SNAPSHOT:
		case EventType.ACTIVITY_DELTA:
		case EventType.RAW:
		case EventType.RUN_STARTED:
		case EventType.STEP_STARTED:
		case EventType.STEP_FINISHED:
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
			return turn;
		default: {
			const exhaustive: never = event;
			return exhaustive;
		}
	}
}
