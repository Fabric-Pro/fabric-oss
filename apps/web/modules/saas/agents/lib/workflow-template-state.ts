import type { WorkflowTemplateState } from "../hooks/useWorkflowTemplateStream";

/**
 * A Deep Research chat's state before any run, and what the chat derives
 * from its state: defined once for both transports (the stream route's
 * `useWorkflowTemplateStream` and the runtime's `useResearchRuntimeStream`),
 * so the same state shows alike on either.
 */
export const INITIAL_WORKFLOW_TEMPLATE_STATE: WorkflowTemplateState = {
	executionId: null,
	status: "idle",
	phase: "idle",
	message: "",
	complexity: null,
	progress: {
		subAgentsTotal: 0,
		subAgentsCompleted: 0,
		subAgentsFailed: 0,
	},
	iteration: {
		current: 0,
		max: 3,
	},
	subAgentResults: [],
	result: null,
	error: null,
};

/** What the chat shows besides the state itself. */
export function workflowTemplateStreamView(state: WorkflowTemplateState) {
	return {
		isRunning: state.status === "running",
		isComplete:
			state.status === "completed" ||
			state.status === "failed" ||
			state.status === "cancelled",
		hasResults:
			state.result !== null &&
			(state.result.text !== null ||
				state.result.summary !== null ||
				state.result.keyFindings.length > 0 ||
				state.result.structuredReport !== null),
		progress: {
			...state.progress,
			percentage:
				state.progress.subAgentsTotal > 0
					? Math.round(
							(state.progress.subAgentsCompleted /
								state.progress.subAgentsTotal) *
								100,
						)
					: 0,
		},
	};
}
