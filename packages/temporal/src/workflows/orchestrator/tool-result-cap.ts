import { TOOL_RESULTS } from "./orchestrator-config";

export const TOOL_RESULT_CAP_PATCH = "orch-tool-result-cap-v2";

/** Select the allowance without changing the cap used by pre-marker histories. */
export function toolResultCap(
	toolName: string,
	callToolMode: boolean,
	patchedCap: boolean,
): number {
	if (callToolMode && toolName === "get_tool_schema") {
		return Number.MAX_SAFE_INTEGER;
	}
	if (toolName === "load_skill" || toolName === "read_skill_file") {
		return 64_000;
	}
	return patchedCap ? 32_000 : TOOL_RESULTS.maxChars;
}

/** Select the body page allowance from the tool-result cap decision. */
export function pagedBodyMaxLength(patchedCap: boolean): number {
	return patchedCap ? 24_000 : TOOL_RESULTS.pagedBodyMaxLength;
}
