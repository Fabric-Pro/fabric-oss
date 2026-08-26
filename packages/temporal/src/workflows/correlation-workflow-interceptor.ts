/**
 * Workflow-side correlation propagation. Runs in the workflow sandbox —
 * NEVER import `node:async_hooks` or other Node-only modules here.
 *
 * Two cooperating interceptors:
 *   • Inbound (`execute`) — captures the workflow execution's start
 *     headers into a workflow-scope cache. This is the only way to read
 *     workflow headers from within a workflow body; `workflowInfo()`
 *     does NOT expose them.
 *   • Outbound (`scheduleActivity` / `startChildWorkflowExecution` /
 *     `continueAsNew`) — forwards the cached header onto every outbound
 *     call so the activity / child workflow sees the same correlation.
 *
 * One registration in the worker covers every current AND every future
 * workflow with zero per-workflow code changes. Mirrors the pattern used
 * by `@temporalio/interceptors-opentelemetry` for W3C trace context.
 */

import type { Headers as TemporalHeaders } from "@temporalio/common";
import type {
	ActivityInput,
	ContinueAsNewInput,
	Next,
	StartChildWorkflowExecutionInput,
	WorkflowExecuteInput,
	WorkflowInboundCallsInterceptor,
	WorkflowInterceptors,
	WorkflowOutboundCallsInterceptor,
} from "@temporalio/workflow";

export const TEMPORAL_CORRELATION_HEADER = "x-correlation-id";

class CorrelationWorkflowInboundInterceptor
	implements WorkflowInboundCallsInterceptor
{
	/**
	 * Captured at execute() time, read by the outbound interceptor. One
	 * instance per workflow execution (the worker constructs interceptors
	 * per-workflow), so this is implicitly workflow-scoped.
	 */
	public headerPatch: TemporalHeaders | undefined;

	async execute(
		input: WorkflowExecuteInput,
		next: Next<WorkflowInboundCallsInterceptor, "execute">,
	): Promise<unknown> {
		const payload = input.headers?.[TEMPORAL_CORRELATION_HEADER];
		if (payload) {
			this.headerPatch = { [TEMPORAL_CORRELATION_HEADER]: payload };
		}
		return next(input);
	}
}

class CorrelationWorkflowOutboundInterceptor
	implements WorkflowOutboundCallsInterceptor
{
	constructor(private inbound: CorrelationWorkflowInboundInterceptor) {}

	scheduleActivity(
		input: ActivityInput,
		next: Next<WorkflowOutboundCallsInterceptor, "scheduleActivity">,
	) {
		const patch = this.inbound.headerPatch;
		if (!patch) {
			return next(input);
		}
		return next({
			...input,
			headers: { ...(input.headers ?? {}), ...patch },
		});
	}

	startChildWorkflowExecution(
		input: StartChildWorkflowExecutionInput,
		next: Next<
			WorkflowOutboundCallsInterceptor,
			"startChildWorkflowExecution"
		>,
	) {
		const patch = this.inbound.headerPatch;
		if (!patch) {
			return next(input);
		}
		return next({
			...input,
			headers: { ...(input.headers ?? {}), ...patch },
		});
	}

	continueAsNew(
		input: ContinueAsNewInput,
		next: Next<WorkflowOutboundCallsInterceptor, "continueAsNew">,
	) {
		const patch = this.inbound.headerPatch;
		if (!patch) {
			return next(input);
		}
		return next({
			...input,
			headers: { ...(input.headers ?? {}), ...patch },
		});
	}
}

/**
 * Factory exported under the name `interceptors` so the worker can
 * register it via `interceptors.workflowModules: [require.resolve(...)]`.
 * One instance pair per workflow execution; the shared `inbound` ref
 * provides the workflow-scoped storage for the captured header.
 */
export const interceptors = (): WorkflowInterceptors => {
	const inbound = new CorrelationWorkflowInboundInterceptor();
	return {
		inbound: [inbound],
		outbound: [new CorrelationWorkflowOutboundInterceptor(inbound)],
	};
};
