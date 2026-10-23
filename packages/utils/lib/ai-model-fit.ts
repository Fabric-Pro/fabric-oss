// Combined input + output USD per 1M tokens at which a model is priced well
// beyond what Simple tasks need.
export const SIMPLE_TASK_COST_THRESHOLD = 10;

export type AiModelFit =
	| {
			kind: "quality";
			reason: "not-suitable" | "no-tool-calling" | "basic-tier";
	  }
	| { kind: "cost"; reason: "expensive-for-simple" };

/** Advisory only. Missing/empty suitability means unrated. Precedence:
 * missing tools, unsuitable task, basic tier, then excess cost. An unrated
 * model gets no cost note either. */
export function getAiModelFit({
	taskType,
	suitableForTasks,
	capabilities,
	qualityTier,
	inputCostPer1M,
	outputCostPer1M,
}: {
	taskType: string;
	suitableForTasks?: readonly string[];
	capabilities?: readonly string[];
	qualityTier?: string;
	inputCostPer1M?: number | null;
	outputCostPer1M?: number | null;
}): AiModelFit | null {
	if (
		![
			"COMPLEX",
			"REASONING",
			"TOOL_CALLING",
			"CHAT",
			"EVAL",
			"SIMPLE",
		].includes(taskType) ||
		!suitableForTasks?.length
	) {
		return null;
	}
	if (
		taskType === "TOOL_CALLING" &&
		capabilities &&
		!capabilities.includes("TOOL_CALLING")
	) {
		return { kind: "quality", reason: "no-tool-calling" };
	}
	if (!suitableForTasks.includes(taskType)) {
		return { kind: "quality", reason: "not-suitable" };
	}
	if (
		["COMPLEX", "REASONING", "EVAL"].includes(taskType) &&
		qualityTier === "BASIC"
	) {
		return { kind: "quality", reason: "basic-tier" };
	}
	if (
		taskType === "SIMPLE" &&
		inputCostPer1M != null &&
		outputCostPer1M != null &&
		inputCostPer1M + outputCostPer1M >= SIMPLE_TASK_COST_THRESHOLD
	) {
		return { kind: "cost", reason: "expensive-for-simple" };
	}
	return null;
}
