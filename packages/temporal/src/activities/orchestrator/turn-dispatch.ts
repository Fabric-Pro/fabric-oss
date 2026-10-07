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
 *
 * Where the gates are applied: `runWithTurnDispatch` installs both as the
 * ambient dispatch guard (`@repo/utils/dispatch-guard`). The activity
 * interceptor (`lib/turn-dispatch-interceptor.ts`) does that for every
 * activity whose first argument carries a `turnScope`, and every model the
 * `@repo/ai` factory returns consults that guard before each physical
 * request, so model and embedding calls inside such an activity are covered
 * without per-call-site work. `guardTurnModel` / `guardTurnImageModel` remain
 * for models built outside the factory (the image activity's gateway models)
 * and for code running outside the guard.
 */

import { checkConversationTurnDispatchable } from "@repo/database";
import { logger } from "@repo/logs";
import {
	type DispatchGuard,
	getDispatchGuard,
	isDispatchGuardedModel,
	runWithDispatchGuard,
} from "@repo/utils/dispatch-guard";
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
 *
 * A model from the `@repo/ai` factory already makes the same check through
 * the ambient dispatch guard when `runWithTurnDispatch` is active for this
 * turn (the activity interceptor sets it). That case is decided per request:
 * this wrapper then leaves the check to the factory's middleware, so the
 * turn record is read once per request, not twice. A model built outside the
 * factory is checked here through that same guard, and takes its abort
 * signal, so a refusal of any request under the guard also aborts this one.
 * With no guard for this turn it checks the turn record directly, as before.
 *
 * The check runs in `transformParams`, which the SDK calls once per physical
 * `doGenerate`/`doStream` (ai v7 `wrapLanguageModel`), before the request.
 */
export function guardTurnModel(
	model: LanguageModel,
	turnScope: TurnScope | undefined,
): { model: LanguageModel } {
	if (!turnScope) {
		return { model };
	}
	const resolved = typeof model === "string" ? resolveModelId(model) : model;
	const checkedByFactory = isDispatchGuardedModel(resolved);
	return {
		model: wrapLanguageModel({
			model: resolved,
			middleware: {
				transformParams: ({ params }) =>
					checkTurnRequest(params, turnScope, checkedByFactory),
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
			transformParams: ({ params }) =>
				checkTurnRequest(params, turnScope, false),
		},
	});
}

/**
 * The per-request check behind `guardTurnModel` / `guardTurnImageModel`.
 * Inside this turn's guard it goes through the guard (so a refusal aborts
 * the guard's other requests) and attaches the guard's abort signal, unless
 * the factory's middleware already does both; outside it, it reads the turn
 * record directly.
 */
async function checkTurnRequest<P extends { abortSignal?: AbortSignal }>(
	params: P,
	turnScope: TurnScope,
	checkedByFactory: boolean,
): Promise<P> {
	const guard = activeTurnGuard(turnScope);
	if (!guard) {
		await assertTurnDispatchable(turnScope);
		return params;
	}
	if (checkedByFactory) {
		return params;
	}
	await guard.assertDispatchable();
	const signal = guard.abortSignal();
	if (!signal || signal === params.abortSignal) {
		return params;
	}
	return {
		...params,
		abortSignal: params.abortSignal
			? AbortSignal.any([params.abortSignal, signal])
			: signal,
	};
}

/**
 * The identity of a turn scope, as the dispatch guard's `key`. All four
 * fields: the turn check compares every one of them with the record.
 */
export function turnScopeKey(turnScope: TurnScope): string {
	return JSON.stringify([
		turnScope.turnId,
		turnScope.executionId,
		turnScope.userId,
		turnScope.organizationId,
	]);
}

/** The ambient dispatch guard when it is the one for `turnScope`. */
function activeTurnGuard(turnScope: TurnScope): DispatchGuard | undefined {
	const guard = getDispatchGuard();
	return guard?.key === turnScopeKey(turnScope) ? guard : undefined;
}

/**
 * Each turn guard's stop controller. Aborted, with the stop as its reason,
 * the first time anything under the guard sees the turn stop: a refused
 * dispatch, or a stop a catch hands to `rethrowIfTurnStopped`.
 */
const turnGuardStops = new WeakMap<DispatchGuard, AbortController>();

/** The stop controller of the active turn guard, if any. */
function activeTurnStopController(): AbortController | undefined {
	const guard = getDispatchGuard();
	return guard ? turnGuardStops.get(guard) : undefined;
}

/** The stop `error` carries: a dispatch refusal or a cancellation. */
function turnStopIn(error: unknown): Error | null {
	return (
		findTurnNotDispatchable(error) ??
		(error instanceof CancelledFailure ? error : null)
	);
}

/**
 * Runs `fn` with the turn's two gates installed as the ambient dispatch
 * guard: every model or embedding request a `@repo/ai` factory model makes
 * inside `fn` first passes `assertTurnDispatchable(turnScope)` and carries the
 * activity's cancellation signal, and catches that consult the guard
 * (`rethrowIfDispatchStopped`) rethrow a stop. Without a scope `fn` runs
 * unchanged, so a run with no turn keeps its behaviour.
 *
 * The guard also has its own stop controller, merged into the abort signal
 * it hands every request. The first refused dispatch under the guard (or the
 * first stop a catch reports through `rethrowIfTurnStopped`) aborts it with
 * the stop as the reason, so the requests already in flight beside the
 * refused one — the other half of a parallel fan-out, the SDK's parallel
 * `embedMany` sub-requests — are aborted too instead of outliving the turn.
 * Activity cancellation alone does not cover this: a refused dispatch fails
 * the activity, it does not cancel it. After that, every further check under
 * the guard refuses without reading the turn record, and every error a catch
 * hands to `rethrowIfTurnStopped` leaves as that stop.
 *
 * The activity interceptor calls this for an activity whose first argument
 * carries `turnScope`; an activity that receives its scope elsewhere (a
 * positional activity's trailing options) calls it itself.
 */
export function runWithTurnDispatch<T>(
	turnScope: TurnScope | undefined,
	fn: () => T,
): T {
	if (!turnScope) {
		return fn();
	}
	const stopController = new AbortController();
	let requestSignal: AbortSignal | undefined;
	const guard: DispatchGuard = {
		key: turnScopeKey(turnScope),
		assertDispatchable: async () => {
			if (stopController.signal.aborted) {
				throw stopController.signal.reason;
			}
			try {
				await assertTurnDispatchable(turnScope);
			} catch (error) {
				const stop = turnStopIn(error);
				if (stop && !stopController.signal.aborted) {
					stopController.abort(stop);
				}
				throw error;
			}
		},
		abortSignal: () => {
			// One combined signal per guard: the activity's cancellation and
			// the guard's own stop.
			requestSignal ??= activityAbortSignal(stopController.signal);
			return requestSignal;
		},
		rethrowIfStopped: rethrowIfTurnStopped,
	};
	turnGuardStops.set(guard, stopController);
	return runWithDispatchGuard(guard, fn);
}

/**
 * Runs `fn` with this turn's dispatch guard, which it is handed: the one
 * already active (the activity interceptor's) when there is one for this
 * turn, else a new one installed for `fn`. For code that must apply the
 * guard to requests no model factory sees, such as an HTTP search: pass
 * `guard.assertDispatchable` as the per-request check and `guard.abortSignal()`
 * as the request signal, so a refusal anywhere under the guard aborts them.
 */
export function withTurnDispatchGuard<T>(
	turnScope: TurnScope,
	fn: (guard: DispatchGuard) => T,
): T {
	const active = activeTurnGuard(turnScope);
	if (active) {
		return fn(active);
	}
	return runWithTurnDispatch(turnScope, () =>
		fn(getDispatchGuard() as DispatchGuard),
	);
}

/**
 * Throws when the work must stop: the activity was cancelled, or the active
 * turn guard has seen the stop. For code that got a result back after a
 * stop it did not see as an error (a partial result whose aborted parts were
 * recorded as failures), so the result is not used.
 */
export function throwIfTurnStopped(): void {
	throwIfActivityCancelled();
	const stopController = activeTurnStopController();
	if (stopController?.signal.aborted) {
		throw stopController.signal.reason;
	}
}

/**
 * `Promise.all` for a fan-out of provider requests. Inside a dispatch guard
 * (a chat turn) it waits for EVERY promise to settle before rejecting, so no
 * sibling request is still running when the activity (and its heartbeat
 * ticker) finishes, and rejects with the first stop among the failures, else
 * the first failure in input order, so a stop is never hidden behind an
 * ordinary error. With no guard active it IS `Promise.all`: the earliest
 * rejection, reported at once, so a run with no turn behaves as before.
 */
export async function settleAll<T>(
	promises: readonly Promise<T>[],
): Promise<T[]> {
	if (!getDispatchGuard()) {
		return Promise.all(promises);
	}
	const results = await Promise.allSettled(promises);
	const failures = results.filter(
		(result): result is PromiseRejectedResult =>
			result.status === "rejected",
	);
	if (failures.length > 0) {
		const stop = failures.find((failure) => turnStopIn(failure.reason));
		throw (stop ?? failures[0]).reason;
	}
	return results.map((result) => (result as PromiseFulfilledResult<T>).value);
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
	// Inside a turn guard that has already seen the stop, every failure is
	// that stop: a sibling request aborted by the guard fails with whatever
	// the provider or the SDK makes of the abort, which need not carry it.
	const stopController = activeTurnStopController();
	if (stopController?.signal.aborted) {
		throw stopController.signal.reason;
	}
	const refusal = findTurnNotDispatchable(error);
	if (refusal) {
		// Abort the guard's other requests in flight: the turn is over.
		stopController?.abort(refusal);
		// The refusal itself, unwrapped from any SDK retry error, so
		// Temporal records the non-retryable TurnNotDispatchable failure.
		throw refusal;
	}
	if (error instanceof CancelledFailure) {
		stopController?.abort(error);
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

/** Heartbeat interval for a turn-scoped activity waiting on a request. */
const TURN_HEARTBEAT_INTERVAL_MS = 5_000;

/**
 * Starts the heartbeat ticker for a turn-scoped activity, so a Stop reaches
 * a request in flight (cancellation is delivered only in a heartbeat
 * response); a no-op without a scope, so a run with no turn heartbeats as
 * before. Returns the function that stops it.
 *
 * Heartbeats carry no details: use it only in an activity that does not keep
 * resumable state in its heartbeat details, which a detail-less beat would
 * overwrite.
 */
export function startTurnHeartbeat(
	turnScope: TurnScope | undefined,
): () => void {
	return turnScope
		? startHeartbeatTicker(TURN_HEARTBEAT_INTERVAL_MS)
		: () => undefined;
}
