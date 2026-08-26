import {
	extractFrameToolResult,
	type FrameToolResult,
	isFrameToolName,
} from "@saas/frames/lib/frame-result";

export interface FrameToolCallLike {
	name: string;
	result?: unknown;
	status?: string;
}

function isSuccessfulStatus(status?: string) {
	return status === "success" || status === "complete";
}

export function getLatestSuccessfulFrameToolResult(
	toolCalls: readonly FrameToolCallLike[] | null | undefined,
): FrameToolResult | null {
	if (!toolCalls || toolCalls.length === 0) {
		return null;
	}

	for (let index = toolCalls.length - 1; index >= 0; index--) {
		const toolCall = toolCalls[index];
		if (!toolCall || !isSuccessfulStatus(toolCall.status)) {
			continue;
		}
		if (!isFrameToolName(toolCall.name)) {
			continue;
		}
		const frameResult = extractFrameToolResult(toolCall.result);
		if (frameResult) {
			return frameResult;
		}
	}

	return null;
}

export function getLatestSuccessfulFrameFromGroups(
	toolCallGroups: ReadonlyArray<
		readonly FrameToolCallLike[] | null | undefined
	>,
): FrameToolResult | null {
	for (
		let groupIndex = toolCallGroups.length - 1;
		groupIndex >= 0;
		groupIndex--
	) {
		const frameResult = getLatestSuccessfulFrameToolResult(
			toolCallGroups[groupIndex],
		);
		if (frameResult) {
			return frameResult;
		}
	}

	return null;
}
