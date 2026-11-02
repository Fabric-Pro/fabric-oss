import type {
	ActivityInput,
	Next,
	WorkflowExecuteInput,
	WorkflowInboundCallsInterceptor,
	WorkflowInterceptors,
	WorkflowOutboundCallsInterceptor,
} from "@temporalio/workflow";
import { defineQuery, setHandler, workflowInfo } from "@temporalio/workflow";
import { chatReplayProducerActivities } from "../lib/chat-replay-producers";

/** Integrity state rebuilt from recorded activity outcomes without adding workflow commands. */
export const interceptors = (): WorkflowInterceptors => {
	let unavailable = false;
	const enabled = () =>
		workflowInfo().workflowType === "orchestratorExecutionWorkflow";
	return {
		inbound: [
			{
				execute(
					input: WorkflowExecuteInput,
					next: Next<WorkflowInboundCallsInterceptor, "execute">,
				) {
					if (enabled()) {
						setHandler(defineQuery("chatReplayStatus"), () => ({
							version: 1,
							unavailable,
						}));
					}
					return next(input);
				},
			},
		],
		outbound: [
			{
				async scheduleActivity(
					input: ActivityInput,
					next: Next<
						WorkflowOutboundCallsInterceptor,
						"scheduleActivity"
					>,
				) {
					try {
						const result: unknown = await next(input);
						if (
							enabled() &&
							result !== null &&
							typeof result === "object" &&
							"__fabricChatReplayUnavailable" in result
						) {
							const {
								__fabricChatReplayUnavailable: failed,
								...value
							} = result;
							if (failed === true) {
								unavailable = true;
							}
							return value;
						}
						if (
							enabled() &&
							chatReplayProducerActivities.has(input.activityType)
						) {
							unavailable = true;
						}
						return result;
					} catch (error) {
						if (
							enabled() &&
							chatReplayProducerActivities.has(input.activityType)
						) {
							unavailable = true;
						}
						throw error;
					}
				},
			},
		],
	};
};
