/**
 * Advisor turn dispatch guard and activity-cancellation plumbing.
 *
 * Every provider request an orchestrator activity makes for a chat turn
 * passes through two gates:
 *
 *   1. `assertTurnDispatchable(turnScope)` — read immediately before EVERY
 *      physical request: `guardTurnModel` installs it as model middleware,
 *      so it also runs before each retry the AI SDK makes on its own (a
 *      check around the SDK call would let those through). It asks the
 *      durable turn record whether the turn may still
 *      make model requests: the turn must exist, match the execution, user
 *      and organization the workflow carries, and be ACTIVE. Once a Stop is
 *      recorded (even one Temporal never received), every check that reads
 *      the record afterwards refuses, so no new request starts. Denial
 *      throws a NON-RETRYABLE `TurnNotDispatchable` failure, so Temporal
 *      does not retry the activity into the same "no".
 *   2. `activityAbortSignal()` — the activity's Temporal cancellation signal,
 *      passed as the request's abort signal, so a cancel delivered to a
 *      running activity aborts the request in flight.
 *
 * What this does NOT guarantee: the check and the request are not atomic,
 * and no lock is held across the provider call. A check whose read saw
 * ACTIVE just before the Stop committed still lets its request start: at
 * most one such request per in-flight call, because the call's next attempt
 * or step is checked again and refused. That request is not left to run: the
 * workflow's cancel reaches the activity on its next heartbeat and gate 2
 * aborts it. The heartbeat ticker runs every five seconds and the
 * orchestrator worker flushes heartbeats at least once a second, so that is
 * about five seconds (measured in
 * `__tests__/orchestrator-turn-cancellation-workflow.test.ts`). If Temporal
 * cannot deliver the cancel at all, that one request runs to completion and
 * no further request follows it.
 *
 * A run without a turn scope (started before turns existed, or by a
 * non-chat starter such as story automations or project setup) skips the
 * first gate: it has no turn to consult.
 */

import { checkConversationTurnDispatchable } from "@repo/database";
import { logger } from "@repo/logs";
import { Context } from "@temporalio/activity";
import { ApplicationFailure, CancelledFailure } from "@temporalio/common";
import {
	gateway,
	type LanguageModel,
	wrapImageModel,
	wrapLanguageModel,
} from "ai";
import type { OrchestratorTurnScope } from "../../workflows/orchestrator/types";

/** The turn an activity is working for, as the workflow carries it. */
export type TurnScope = OrchestratorTurnScope;

/** `ApplicationFailure.type` of a refused dispatch. */
export const TURN_NOT_DISPATCHABLE = "TurnNotDispatchable";

export type TurnNotDispatchableReason =
	| "cancelled"
	| "scope_mismatch"
	| "terminal";

/**
 * Throws `TurnNotDispatchable` unless the turn may make another provider
 * request. Also throws the activity's cancellation when it was already
 * cancelled, so a request is never started by a cancelled activity.
 */
export async function assertTurnDispatchable(
	turnScope: TurnScope | undefined,
): Promise<void> {
	throwIfActivityCancelled();
	if (!turnScope) {
		return;
	}
	const verdict = await checkConversationTurnDispatchable(turnScope);
	if (verdict.ok) {
		return;
	}
	const logDetails = {
		reason: verdict.reason,
		turnId: turnScope.turnId,
		executionId: turnScope.executionId,
		organizationId: turnScope.organizationId,
	};
	if (verdict.reason === "scope_mismatch") {
		// A workflow carrying a turn it does not own is a bug or tampering,
		// never a normal stop.
		logger.error(
			"[TurnDispatch] Turn scope does not match its record; refusing the request",
			logDetails,
		);
	} else {
		logger.info(
			"[TurnDispatch] Turn may not dispatch; refusing",
			logDetails,
		);
	}
	throw ApplicationFailure.create({
		type: TURN_NOT_DISPATCHABLE,
		message: `Turn ${turnScope.turnId} may not make another model request (${verdict.reason})`,
		nonRetryable: true,
		details: [{ reason: verdict.reason }],
	});
}

/** True when `error` is the dispatch refusal above (unwrapped). */
export function isTurnNotDispatchable(error: unknown): boolean {
	return findTurnNotDispatchable(error) !== null;
}

/**
 * The dispatch refusal inside `error`, wherever the AI SDK put it: thrown
 * as is, as a `cause`, or inside a `RetryError` (`lastError` / `errors`)
 * when the refusal came on an SDK retry. Null when there is none.
 */
export function findTurnNotDispatchable(
	error: unknown,
	depth = 0,
): ApplicationFailure | null {
	if (!error || typeof error !== "object" || depth > 5) {
		return null;
	}
	if (
		error instanceof ApplicationFailure &&
		error.type === TURN_NOT_DISPATCHABLE
	) {
		return error;
	}
	const candidate = error as {
		cause?: unknown;
		lastError?: unknown;
		errors?: unknown;
	};
	const nested: unknown[] = [
		candidate.lastError,
		candidate.cause,
		...(Array.isArray(candidate.errors) ? candidate.errors : []),
	];
	for (const inner of nested) {
		const found = findTurnNotDispatchable(inner, depth + 1);
		if (found) {
			return found;
		}
	}
	return null;
}

/**
 * The model a turn's provider requests go through. With a turn scope, the
 * returned model checks the turn record before EVERY physical
 * `doGenerate`/`doStream`: the first call, each retry the AI SDK makes
 * internally, and each further step of a multi-step call (a tool step
 * followed by the next model request), so no request starts after a check
 * has seen the recorded Stop. A request whose check passed just before the
 * Stop committed is aborted by the activity's cancellation instead (see the
 * header: the check is not atomic with the send). Without one (legacy, non-chat
 * runs) the model is returned unchanged with the SDK's usual behaviour.
 *
 * A model given as a bare id is first resolved to a model object the way
 * the SDK itself resolves one (the global default provider, else the
 * gateway), so there is no unguarded path.
 */
export function guardTurnModel(
	model: LanguageModel,
	turnScope: TurnScope | undefined,
): { model: LanguageModel } {
	if (!turnScope) {
		return { model };
	}
	const resolved = typeof model === "string" ? resolveModelId(model) : model;
	return {
		model: wrapLanguageModel({
			model: resolved,
			middleware: {
				wrapGenerate: async ({ doGenerate }) => {
					await assertTurnDispatchable(turnScope);
					return doGenerate();
				},
				wrapStream: async ({ doStream }) => {
					await assertTurnDispatchable(turnScope);
					return doStream();
				},
			},
		}),
	};
}

/**
 * The image-model counterpart of `guardTurnModel`: the turn record is checked
 * before every physical image request, the SDK's own retries included.
 */
export function guardTurnImageModel(
	model: Parameters<typeof wrapImageModel>[0]["model"],
	turnScope: TurnScope,
): ReturnType<typeof wrapImageModel> {
	return wrapImageModel({
		model,
		middleware: {
			wrapGenerate: async ({ doGenerate }) => {
				await assertTurnDispatchable(turnScope);
				return doGenerate();
			},
		},
	});
}

/** Same resolution as the SDK's own for a string model id. */
function resolveModelId(
	modelId: string,
): Parameters<typeof wrapLanguageModel>[0]["model"] {
	const provider =
		(
			globalThis as {
				AI_SDK_DEFAULT_PROVIDER?: {
					languageModel: (
						id: string,
					) => Parameters<typeof wrapLanguageModel>[0]["model"];
				};
			}
		).AI_SDK_DEFAULT_PROVIDER ?? gateway;
	return provider.languageModel(modelId);
}

/**
 * The running activity's cancellation signal, or undefined outside an
 * activity (unit tests calling an activity function directly).
 */
export function activityCancellationSignal(): AbortSignal | undefined {
	try {
		return Context.current().cancellationSignal;
	} catch {
		return undefined;
	}
}

/**
 * The abort signal for a provider request: the activity's cancellation,
 * merged with any signal the caller already had (a deadline).
 */
export function activityAbortSignal(
	...extra: Array<AbortSignal | undefined>
): AbortSignal | undefined {
	const signals = [activityCancellationSignal(), ...extra].filter(
		(signal): signal is AbortSignal => signal !== undefined,
	);
	if (signals.length === 0) {
		return undefined;
	}
	if (signals.length === 1) {
		return signals[0];
	}
	return AbortSignal.any(signals);
}

/**
 * Throws the activity's cancellation if it has been cancelled. Thrown as a
 * `CancelledFailure` (the SDK's own abort reason when it has one), which is
 * what makes the worker report the activity CANCELLED rather than FAILED.
 */
export function throwIfActivityCancelled(): void {
	const signal = activityCancellationSignal();
	if (!signal?.aborted) {
		return;
	}
	throw signal.reason instanceof CancelledFailure
		? signal.reason
		: new CancelledFailure("Activity cancelled");
}

/**
 * For a catch block that would otherwise turn an error into a fallback
 * result: rethrow when the error is a stop (the activity was cancelled, or
 * the turn refused dispatch), so neither is converted into an answer.
 */
export function rethrowIfTurnStopped(error: unknown): void {
	throwIfActivityCancelled();
	const refusal = findTurnNotDispatchable(error);
	if (refusal) {
		// The refusal itself, unwrapped from any SDK retry error, so
		// Temporal records the non-retryable TurnNotDispatchable failure.
		throw refusal;
	}
	if (error instanceof CancelledFailure) {
		throw error;
	}
}

/**
 * Heartbeats every `intervalMs` until stopped, so a cancel is delivered to
 * the activity (Temporal hands cancellation to an activity only in the
 * response to a heartbeat) while it waits on a provider. No-op outside an
 * activity.
 */
export function startHeartbeatTicker(
	intervalMs: number,
	details?: unknown,
): () => void {
	let context: Context;
	try {
		context = Context.current();
	} catch {
		return () => undefined;
	}
	context.heartbeat(details);
	const timer = setInterval(() => {
		try {
			context.heartbeat(details);
		} catch {
			// The activity is finishing; nothing to keep alive.
		}
	}, intervalMs);
	return () => clearInterval(timer);
}
