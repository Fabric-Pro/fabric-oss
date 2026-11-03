import type { AnswerModelInfo } from "@repo/ai/lib/answer-model-info";
import type { AiUsageLimitExceededPayload } from "@saas/payments/lib/ai-usage-limit-toast";
import type { AiErrorToastCopy } from "@saas/shared/lib/ai-error-message";
import type { ToolCallItem } from "../components/FabricChat/shared/types";
import type { DataAnalystChart } from "./data-analyst-runtime-protocol";
import { settleUnfinishedToolCalls } from "./direct-chat-turns";

export interface DataAnalystTurn {
	model?: AnswerModelInfo;
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
