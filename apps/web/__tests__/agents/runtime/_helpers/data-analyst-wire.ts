import { type BaseEvent, EventType } from "@ag-ui/client";

export const CHART_ARGS = {
	chartType: "bar",
	data: [{ category: "Example", value: 12 }],
	config: { xAxis: "category", yAxis: "value", title: "Example chart" },
};
export const DATA_ANALYST_WIRE: BaseEvent[] = [
	{
		type: EventType.RUN_STARTED,
		threadId: "remote-thread",
		runId: "remote-run",
		metadata: { internal: "private-state" },
	},
	{
		type: EventType.TEXT_MESSAGE_START,
		messageId: "answer",
		role: "assistant",
	},
	{
		type: EventType.TEXT_MESSAGE_CONTENT,
		messageId: "answer",
		delta: "Here is the chart. ",
		metadata: { token: "private-state" },
	},
	{
		type: EventType.TOOL_CALL_START,
		toolCallId: "chart-call",
		toolCallName: "create_chart",
	},
	{
		type: EventType.TOOL_CALL_ARGS,
		toolCallId: "chart-call",
		delta: JSON.stringify(CHART_ARGS),
	},
	{ type: EventType.TOOL_CALL_END, toolCallId: "chart-call" },
	{
		type: EventType.STATE_SNAPSHOT,
		snapshot: {
			messages: [
				{
					lc: 1,
					type: "constructor",
					id: ["langchain_core", "messages", "ToolMessage"],
					kwargs: {
						tool_call_id: "chart-call",
						content: JSON.stringify({ success: true }),
					},
				},
			],
			mcpTools: "private-state",
			error: "private-state",
			artifacts: [{ id: "other-tenant-chart", type: "chart" }],
			reasoningByTurn: "private-state",
		},
	},
	{
		type: EventType.TEXT_MESSAGE_CONTENT,
		messageId: "answer",
		delta: "Done.",
	},
	{ type: EventType.TEXT_MESSAGE_END, messageId: "answer" },
	{
		type: EventType.RUN_FINISHED,
		threadId: "remote-thread",
		runId: "remote-run",
	},
];
