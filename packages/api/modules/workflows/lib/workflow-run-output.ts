/**
 * Reading what a workflow run left behind. Pure, so the MCP tools can use it
 * without loading the engine. The run's frame id is
 * `findPublishedFrameId` in `@repo/temporal/workflow-run-output`.
 */

import type { WorkflowExecution } from "@repo/database";
import { findPublishedFrameId } from "@repo/temporal/workflow-run-output";

const MAX_OUTPUT_SUMMARY_CHARS = 2_000;

/** The output, cut to a size a chat can carry. */
function summarizeRunOutput(output: unknown): unknown {
	if (output === null || output === undefined) {
		return null;
	}
	const serialized = JSON.stringify(output);
	return serialized.length <= MAX_OUTPUT_SUMMARY_CHARS
		? output
		: `${serialized.slice(0, MAX_OUTPUT_SUMMARY_CHARS)}…`;
}

export interface WorkflowRunSummary {
	id: string;
	status: WorkflowExecution["status"];
	startedAt: Date;
	completedAt: Date | null;
	durationMs: number | null;
	error: string | null;
	/** The frame a run published, when one of its steps did. */
	frameId: string | null;
	output: unknown;
}

/** One execution as a chat can carry it: bounded output and the frame it published. */
export function toRunSummary(
	execution: Pick<
		WorkflowExecution,
		| "id"
		| "status"
		| "startedAt"
		| "completedAt"
		| "duration"
		| "error"
		| "output"
	>,
): WorkflowRunSummary {
	return {
		id: execution.id,
		status: execution.status,
		startedAt: execution.startedAt,
		completedAt: execution.completedAt,
		durationMs: execution.duration,
		error: execution.error,
		frameId: findPublishedFrameId(execution.output),
		output: summarizeRunOutput(execution.output),
	};
}
