import { Context } from "@temporalio/activity";
import type {
	ActivityExecuteInput,
	ActivityInboundCallsInterceptor,
	Next,
} from "@temporalio/worker";
import { chatReplayProducerActivities } from "./chat-replay-producers";
import {
	executionReplayUnavailable,
	flushExecutionEvents,
	markExecutionReplayUnavailable,
} from "./execution-output-drain";

/** The result flag is recorded in Temporal history even when the journal is down. */
export class ChatReplayActivityInboundInterceptor
	implements ActivityInboundCallsInterceptor
{
	async execute(
		input: ActivityExecuteInput,
		next: Next<ActivityInboundCallsInterceptor, "execute">,
	): Promise<unknown> {
		const context = Context.current();
		let result: unknown;
		let failure: unknown;
		let failed = false;
		try {
			result = await next(input);
		} catch (error) {
			failure = error;
			failed = true;
		}
		const timer = setInterval(() => context.heartbeat(), 10_000);
		try {
			await flushExecutionEvents();
		} catch {
			// Output draining must not replace an existing activity failure.
			if (!failed) {
				markExecutionReplayUnavailable(context);
			}
		} finally {
			clearInterval(timer);
		}
		if (failed) {
			throw failure;
		}
		if (
			context.info.workflowExecution?.workflowId.startsWith("orch-") &&
			(chatReplayProducerActivities.has(context.info.activityType) ||
				executionReplayUnavailable(context)) &&
			result !== null &&
			typeof result === "object" &&
			!Array.isArray(result)
		) {
			return {
				...result,
				__fabricChatReplayUnavailable:
					executionReplayUnavailable(context),
			};
		}
		return result;
	}
}
