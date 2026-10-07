/**
 * Advisor turn dispatch guard for Temporal activities.
 *
 * Registered once on the worker, this activity-inbound interceptor reads
 * `turnScope` off the activity's first argument and runs the activity inside
 * `runWithTurnDispatch(turnScope, ...)`. Every model and embedding request
 * the activity then makes through the `@repo/ai` factory, however deep in
 * `@repo/ai` or `@repo/rag` it starts, checks the turn record before each
 * physical request and is aborted by the activity's cancellation (see
 * `activities/orchestrator/turn-dispatch.ts`), including calls added later.
 *
 * The workflow sends `turnScope` only for a chat turn (behind the
 * `orch-turn-cancellation-v1` patch), so every other activity runs exactly as
 * before. An activity whose scope is not in its first argument (a positional
 * activity) calls `runWithTurnDispatch` itself.
 *
 * Modeled on {@link ProjectContextActivityInboundInterceptor}. Activities run
 * in normal Node context, so `node:async_hooks` is safe here; workflow code
 * must never import this file.
 */

import type {
	ActivityExecuteInput,
	ActivityInboundCallsInterceptor,
	Next as ActivityNext,
} from "@temporalio/worker";
import {
	runWithTurnDispatch,
	type TurnScope,
} from "../activities/orchestrator/turn-dispatch";

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

/**
 * The turn scope on the activity's first object argument, when it has the
 * shape the workflow sends. `organizationId` may be empty: the workflow sends
 * an empty one for a turn with no organization so every check fails closed,
 * and that must still be checked rather than skipped.
 */
export function extractTurnScope(
	input: Pick<ActivityExecuteInput, "args">,
): TurnScope | undefined {
	const first = input.args?.[0];
	if (!first || typeof first !== "object" || !("turnScope" in first)) {
		return undefined;
	}
	const scope = (first as { turnScope?: unknown }).turnScope;
	if (!scope || typeof scope !== "object") {
		return undefined;
	}
	const candidate = scope as Partial<Record<keyof TurnScope, unknown>>;
	if (
		!isNonEmptyString(candidate.turnId) ||
		!isNonEmptyString(candidate.executionId) ||
		!isNonEmptyString(candidate.userId) ||
		typeof candidate.organizationId !== "string"
	) {
		return undefined;
	}
	return {
		turnId: candidate.turnId,
		executionId: candidate.executionId,
		userId: candidate.userId,
		organizationId: candidate.organizationId,
	};
}

export class TurnDispatchActivityInboundInterceptor
	implements ActivityInboundCallsInterceptor
{
	async execute(
		input: ActivityExecuteInput,
		next: ActivityNext<ActivityInboundCallsInterceptor, "execute">,
	): Promise<unknown> {
		const turnScope = extractTurnScope(input);
		if (!turnScope) {
			return next(input);
		}
		return runWithTurnDispatch(turnScope, () => next(input));
	}
}
