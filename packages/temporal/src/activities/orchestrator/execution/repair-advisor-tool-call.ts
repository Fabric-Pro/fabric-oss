import { NoSuchToolError, type ToolCallRepairFunction, type ToolSet } from "ai";
import {
	META_TOOL_NAMES,
	objectArguments,
} from "../../../workflows/orchestrator/advisor-call-tool";

/** SDK reparses this envelope against the offered call_tool schema. */
export function repairAdvisorToolCall(input: {
	admitted: readonly string[];
	suppressed: readonly string[];
	forced: boolean;
}): ToolCallRepairFunction<ToolSet> {
	const admitted = new Set(input.admitted);
	const suppressed = new Set(input.suppressed);
	return async ({ toolCall, tools, error }) => {
		if (
			input.forced ||
			!NoSuchToolError.isInstance(error) ||
			!Object.hasOwn(tools, "call_tool") ||
			!admitted.has(toolCall.toolName) ||
			suppressed.has(toolCall.toolName) ||
			META_TOOL_NAMES.has(toolCall.toolName)
		) {
			return null;
		}
		const args = objectArguments(toolCall.input);
		if (!args) {
			return null;
		}
		return {
			...toolCall,
			toolName: "call_tool",
			input: JSON.stringify({ name: toolCall.toolName, arguments: args }),
		};
	};
}
