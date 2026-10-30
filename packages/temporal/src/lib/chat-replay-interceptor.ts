import { Context } from "@temporalio/activity";
import type {
	ActivityExecuteInput,
	ActivityInboundCallsInterceptor,
	Next,
} from "@temporalio/worker";
import {
	executionReplayUnavailable,
	flushExecutionEvents,
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
		const result = await next(input);
		const timer = setInterval(() => context.heartbeat(), 10_000);
		try {
			await flushExecutionEvents();
		} finally {
			clearInterval(timer);
		}
		if (
			context.info.workflowExecution?.workflowId.startsWith("orch-") &&
			(context.info.attempt > 1 || executionReplayUnavailable(context)) &&
			result !== null &&
			typeof result === "object" &&
			!Array.isArray(result)
		) {
			return { ...result, __fabricChatReplayUnavailable: true };
		}
		return result;
	}
}
