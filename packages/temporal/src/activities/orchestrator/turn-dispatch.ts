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
 *
 * Token ledger. When the scope carries the budget contract
 * (`budgetContractVersion: 1`, sent under the `orch-turn-budget-v1` marker),
 * the guard also carries the turn's ledger (`guard.budget`): every factory
 * model reserves each physical request against the turn's durable allowance
 * immediately before sending it and settles the reported usage after
 * (`@repo/ai` turn-budget-middleware.ts; the ledger itself is
 * `reserveConversationTurnAttempt` in @repo/database). A turn row admitted
 * without the contract answers "unledgered" and nothing is reserved. A
 * request that does not fit fails with a NON-RETRYABLE `TurnBudgetExhausted`
 * failure. It travels like a stop — the guard aborts its sibling requests
 * and every catch that consults `rethrowIfTurnStopped` (or the guard's
 * `rethrowIfStopped`) rethrows it — but it is not a cancellation: the
 * workflow answers it with its budget exit. Token-billed gateway image
 * models opt into the same middleware. Direct Gemini image generation,
 * A2A submissions, non-streaming Fabric AI patterns, Perplexity integration
 * requests and Databricks managed-embedding queries use `dispatchBudgetSend`.
 * Other raw sends do not gain accounting from the stop guard alone.
 */

import {
	type ConversationTurnLedgerSnapshot,
	checkConversationTurnDispatchable,
	conversationTurnRoom,
	getConversationTurnLedgerSnapshot,
	reserveConversationTurnAttempt,
	settleConversationTurnAttempt,
} from "@repo/database";
import { logger } from "@repo/logs";
import {
	type DispatchBudget,
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
import {
	ORCHESTRATOR_TURN_BUDGET_CONTRACT_VERSION,
	type OrchestratorBudgetAttemptKind,
	type OrchestratorTurnScope,
	type TurnLedgerSnapshot,
} from "../../workflows/orchestrator/types";

/** The turn an activity is working for, as the workflow carries it. */
export type TurnScope = OrchestratorTurnScope;

/** `ApplicationFailure.type` of a refused dispatch. */
export const TURN_NOT_DISPATCHABLE = "TurnNotDispatchable";

/**
 * `ApplicationFailure.type` of a request the turn's token ledger refused
 * because it does not fit what is left of the allowance. Non-retryable, and
 * distinct from `TurnNotDispatchable`: the turn is not stopped, it has used
 * its allowance.
 */
export const TURN_BUDGET_EXHAUSTED = "TurnBudgetExhausted";

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
	throw turnNotDispatchableFailure(turnScope, verdict.reason);
}

/** Logs a refused dispatch and builds its non-retryable failure. */
function turnNotDispatchableFailure(
	turnScope: TurnScope,
	reason: TurnNotDispatchableReason,
): ApplicationFailure {
	const verdict = { reason };
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
	return ApplicationFailure.create({
		type: TURN_NOT_DISPATCHABLE,
		message: `Turn ${turnScope.turnId} may not make another model request (${verdict.reason})`,
		nonRetryable: true,
		details: [{ reason: verdict.reason }],
	});
}

/** True when `error` is (or wraps) the ledger's budget refusal. */
export function isTurnBudgetExhausted(error: unknown): boolean {
	return findTurnBudgetExhausted(error) !== null;
}

/**
 * The budget refusal inside `error`, wherever the AI SDK put it (as is, a
 * `cause`, or inside a `RetryError`). Null when there is none.
 */
export function findTurnBudgetExhausted(
	error: unknown,
): ApplicationFailure | null {
	return findApplicationFailure(error, TURN_BUDGET_EXHAUSTED, 0);
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
	return findApplicationFailure(error, TURN_NOT_DISPATCHABLE, depth);
}

function findApplicationFailure(
	error: unknown,
	type: string,
	depth: number,
): ApplicationFailure | null {
	if (!error || typeof error !== "object" || depth > 5) {
		return null;
	}
	if (error instanceof ApplicationFailure && error.type === type) {
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
		const found = findApplicationFailure(inner, type, depth + 1);
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
 * The identity of a turn scope, as the dispatch guard's `key`. Every field
 * the turn check and the ledger compare with the record, and the budget
 * contract, so a guard for the same turn with a different contract is not
 * mistaken for this one.
 */
export function turnScopeKey(turnScope: TurnScope): string {
	return JSON.stringify([
		turnScope.turnId,
		turnScope.executionId,
		turnScope.userId,
		turnScope.organizationId,
		turnScope.generation,
		turnScope.budgetContractVersion,
	]);
}

/** The ambient dispatch guard when it is the one for `turnScope`. */
function activeTurnGuard(turnScope: TurnScope): DispatchGuard | undefined {
	const guard = getDispatchGuard();
	return guard?.key === turnScopeKey(turnScope) ? guard : undefined;
}

/**
 * What a turn guard has seen. `controller` is aborted, with the first stop
 * as its reason, the moment anything under the guard sees one — a refused
 * dispatch, a budget refusal, or a stop a catch hands to
 * `rethrowIfTurnStopped` — so every request still in flight under the guard
 * is aborted too. Each kind of stop is also kept in its own slot, so the
 * outcome applies the precedence (`turnStopToThrow`) whatever order the
 * stops arrived in.
 */
interface TurnGuardState {
	controller: AbortController;
	/** The activity's cancellation signal, as the guard was installed. */
	activitySignal: AbortSignal | undefined;
	cancellation?: CancelledFailure;
	refusal?: ApplicationFailure;
	budget?: ApplicationFailure;
}

const turnGuardStates = new WeakMap<DispatchGuard, TurnGuardState>();

/** The state of the active turn guard, if any. */
function activeTurnGuardState(): TurnGuardState | undefined {
	const guard = getDispatchGuard();
	return guard ? turnGuardStates.get(guard) : undefined;
}

/**
 * Latches the stop `error` carries, if any, on `state` (and aborts the
 * guard's requests). An ordinary error latches nothing.
 */
function latchTurnStop(state: TurnGuardState, error: unknown): void {
	const refusal = findTurnNotDispatchable(error);
	const cancellation = error instanceof CancelledFailure ? error : null;
	const budget =
		refusal || cancellation ? null : findTurnBudgetExhausted(error);
	const stop = refusal ?? cancellation ?? budget;
	if (!stop) {
		return;
	}
	if (refusal) {
		state.refusal ??= refusal;
	} else if (cancellation) {
		state.cancellation ??= cancellation;
	} else if (budget) {
		state.budget ??= budget;
	}
	if (!state.controller.signal.aborted) {
		state.controller.abort(stop);
	}
}

/**
 * THE outcome rule of a turn-scoped activity, used by every completion
 * branch of `runWithTurnDispatch` (a normal return and a thrown error) and
 * by every in-body stop check: the stop to throw, or null when the work's
 * own completion stands. Precedence:
 *
 *   1. cancellation — the activity's cancellation signal fired, or a
 *      cancellation was latched or thrown;
 *   2. dispatch refusal — the turn record refused a request (the turn was
 *      stopped, has ended, or the scope does not match), latched or thrown;
 *   3. budget refusal — the ledger refused a request for the allowance,
 *      latched or thrown.
 *
 * `thrown` is the error the work ended with, when it threw; a latched stop
 * outranks it whichever order they came in, so a helper that turned a stop
 * into a value or into an ordinary error still leaves as that stop.
 */
function turnStopToThrow(
	state: TurnGuardState,
	thrown?: unknown,
): Error | null {
	const activitySignal = state.activitySignal ?? activityCancellationSignal();
	const cancellation = activitySignal?.aborted
		? cancellationOf(activitySignal)
		: (state.cancellation ??
			(thrown instanceof CancelledFailure ? thrown : null));
	if (cancellation) {
		return cancellation;
	}
	const refusal = state.refusal ?? findTurnNotDispatchable(thrown);
	if (refusal) {
		return refusal;
	}
	return state.budget ?? findTurnBudgetExhausted(thrown);
}

/** The `CancelledFailure` an aborted activity signal stands for. */
function cancellationOf(signal: AbortSignal): CancelledFailure {
	return signal.reason instanceof CancelledFailure
		? signal.reason
		: new CancelledFailure("Activity cancelled");
}

/**
 * The stop `error` carries: a dispatch refusal, a cancellation, or a budget
 * refusal (which ends the activity's requests the same way, though the
 * workflow does not treat it as a cancellation).
 */
function turnStopIn(error: unknown): Error | null {
	return (
		findTurnNotDispatchable(error) ??
		(error instanceof CancelledFailure ? error : null) ??
		findTurnBudgetExhausted(error)
	);
}

/** Diagnostic attribution of the running activity, when there is one. */
function activityAttribution(): {
	workflowId?: string;
	runId?: string;
	activityId?: string;
	activityAttempt?: number;
} {
	try {
		const info = Context.current().info;
		return {
			workflowId: info.workflowExecution?.workflowId,
			runId: info.workflowExecution?.runId,
			activityId: info.activityId,
			activityAttempt: info.attempt,
		};
	} catch {
		return {};
	}
}

/** True when the scope carries the budget contract this code speaks. */
export function speaksBudgetContract(turnScope: TurnScope): boolean {
	return (
		turnScope.budgetContractVersion ===
		ORCHESTRATOR_TURN_BUDGET_CONTRACT_VERSION
	);
}

function snapshotForWorkflow(
	snapshot: ConversationTurnLedgerSnapshot,
): TurnLedgerSnapshot {
	return {
		allowance: snapshot.allowance,
		finalizationReserve: snapshot.finalizationReserve,
		measured: snapshot.measured,
		outstanding: snapshot.outstanding,
		enforcement: snapshot.enforcement,
	};
}

/**
 * The NON-RETRYABLE `TurnBudgetExhausted` failure for a request of `kind`
 * that does not fit what is left of the turn's allowance. Its details carry
 * the request kind, the room and what the request needed, and the ledger
 * reading the workflow records the stop from (`ledgerSnapshotFromRefusal`,
 * `refusedFinalization` in workflows/orchestrator/turn-budget.ts).
 */
export function turnBudgetExhaustedFailure(
	turnScope: TurnScope,
	refusal: {
		kind: OrchestratorBudgetAttemptKind | "AUXILIARY";
		room: number;
		needed: number;
		snapshot: ConversationTurnLedgerSnapshot;
	},
): ApplicationFailure {
	return ApplicationFailure.create({
		type: TURN_BUDGET_EXHAUSTED,
		message: `Turn ${turnScope.turnId} has used its token allowance (${refusal.kind} request needs ${refusal.needed}, ${refusal.room} left)`,
		nonRetryable: true,
		details: [
			{
				kind: refusal.kind,
				room: refusal.room,
				needed: refusal.needed,
				snapshot: snapshotForWorkflow(refusal.snapshot),
			},
		],
	});
}

/**
 * The turn's ledger as the guard's `budget`. A denial aborts the guard's
 * other requests (through `stop`) and is thrown: a `TurnNotDispatchable`
 * when the turn may not dispatch at all, a `TurnBudgetExhausted` when the
 * request does not fit.
 */
function turnLedgerBudget(
	turnScope: TurnScope,
	attemptKind: OrchestratorBudgetAttemptKind | undefined,
	stop: (error: Error) => never,
): DispatchBudget {
	const settle = async (
		attemptId: string,
		settlement: Parameters<
			typeof settleConversationTurnAttempt
		>[0]["settlement"],
	) => {
		const result = await settleConversationTurnAttempt({
			scope: turnScope,
			attemptId,
			settlement,
		});
		if (result.outcome === "not_found") {
			logger.error("[TurnDispatch] Ledger attempt not found to settle", {
				turnId: turnScope.turnId,
				attemptId,
			});
		}
	};
	return {
		attemptKind: attemptKind ?? "AUXILIARY",
		reserve: async (request) => {
			// Only a language request takes the activity's kind: an embedding,
			// a typed decision or external remote work is auxiliary work.
			const kind =
				request.modality === "language"
					? (attemptKind ?? "AUXILIARY")
					: "AUXILIARY";
			const result = await reserveConversationTurnAttempt({
				scope: turnScope,
				kind,
				inputEstimate: request.inputEstimate,
				requestedOutputTokens: request.requestedOutputTokens,
				minOutputTokens: request.minOutputTokens,
				enforced: request.enforcesOutputCap,
				attribution: {
					...activityAttribution(),
					modelId: request.modelId,
				},
			});
			switch (result.outcome) {
				case "unledgered":
					return null;
				case "reserved":
					return {
						attemptId: result.attemptId,
						outputCap: result.outputCap,
					};
				case "denied":
					return stop(
						turnNotDispatchableFailure(turnScope, result.reason),
					);
				case "exhausted": {
					logger.info("[TurnDispatch] Turn token allowance used", {
						turnId: turnScope.turnId,
						executionId: turnScope.executionId,
						kind,
						room: result.room,
						needed: result.needed,
					});
					return stop(
						turnBudgetExhaustedFailure(turnScope, {
							kind,
							room: result.room,
							needed: result.needed,
							snapshot: result.snapshot,
						}),
					);
				}
			}
		},
		settle: (attemptId, usage) =>
			settle(attemptId, { status: "SETTLED", ...usage }),
		markUnknown: (attemptId) => settle(attemptId, { status: "UNKNOWN" }),
		release: (attemptId) => settle(attemptId, { status: "RELEASED" }),
	};
}

/**
 * The turn's ledger totals after this activity's requests settled, for the
 * workflow (progress, warnings and its record of the stop). Undefined for a
 * scope without the budget contract or a turn without a ledger, and when the
 * read fails (the ledger, not this reading, admits requests).
 */
export async function readTurnLedgerSnapshot(
	turnScope: TurnScope | undefined,
): Promise<TurnLedgerSnapshot | undefined> {
	if (!turnScope || !speaksBudgetContract(turnScope)) {
		return undefined;
	}
	try {
		const snapshot = await getConversationTurnLedgerSnapshot(turnScope);
		return snapshot ? snapshotForWorkflow(snapshot) : undefined;
	} catch (error) {
		logger.warn("[TurnDispatch] Could not read the turn's ledger", {
			turnId: turnScope.turnId,
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

/**
 * The room a FINALIZATION reservation would find right now
 * (`allowance − measured − outstanding`, computed by the ledger's own
 * `conversationTurnRoom`), with the reading it came from. Advisory: the
 * finalization synthesis sizes its request to it, and the reservation made
 * when the request is sent stays the authority, so a request that a
 * concurrent charge squeezed out is refused there as any other. Undefined
 * for a scope without the budget contract, a turn without a ledger, and
 * when the read fails.
 */
export async function readTurnFinalizationRoom(
	turnScope: TurnScope | undefined,
): Promise<
	{ room: number; snapshot: ConversationTurnLedgerSnapshot } | undefined
> {
	if (!turnScope || !speaksBudgetContract(turnScope)) {
		return undefined;
	}
	try {
		const snapshot = await getConversationTurnLedgerSnapshot(turnScope);
		return snapshot
			? {
					room: Math.max(
						conversationTurnRoom(snapshot, "FINALIZATION"),
						0,
					),
					snapshot,
				}
			: undefined;
	} catch (error) {
		logger.warn("[TurnDispatch] Could not read the turn's ledger", {
			turnId: turnScope.turnId,
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
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
	options: {
		/**
		 * How this activity's model requests count against a ledgered turn's
		 * allowance, from the workflow-set activity input; AUXILIARY when
		 * absent. Embeddings and typed decisions are always AUXILIARY.
		 */
		attemptKind?: OrchestratorBudgetAttemptKind;
	} = {},
): T {
	if (!turnScope) {
		return fn();
	}
	const state: TurnGuardState = {
		controller: new AbortController(),
		activitySignal: activityCancellationSignal(),
	};
	let requestSignal: AbortSignal | undefined;
	/** Latches `error` and throws the stop the precedence picks. */
	const stop = (error: Error): never => {
		latchTurnStop(state, error);
		throw turnStopToThrow(state) ?? error;
	};
	const throwIfStopped = () => {
		const latched = turnStopToThrow(state);
		if (latched) {
			throw latched;
		}
	};
	const guard: DispatchGuard = {
		key: turnScopeKey(turnScope),
		assertDispatchable: async () => {
			throwIfStopped();
			try {
				await assertTurnDispatchable(turnScope);
			} catch (error) {
				latchTurnStop(state, error);
				throw turnStopToThrow(state) ?? error;
			}
		},
		abortSignal: () => {
			// One combined signal per guard: the activity's cancellation and
			// the guard's own stop.
			requestSignal ??= activityAbortSignal(state.controller.signal);
			return requestSignal;
		},
		rethrowIfStopped: rethrowIfTurnStopped,
		throwIfStopped,
		...(speaksBudgetContract(turnScope)
			? {
					budget: turnLedgerBudget(
						turnScope,
						options.attemptKind,
						stop,
					),
				}
			: {}),
	};
	turnGuardStates.set(guard, state);
	return completeTurnDispatch(state, () => runWithDispatchGuard(guard, fn));
}

/**
 * Ends the guarded work through `turnStopToThrow`, on both of its completion
 * branches: a normal return (sync or resolved) and a thrown error (sync or
 * rejected) each give way to a stop the precedence picks, else stand as
 * they are. So a helper deep in the activity that turned a stop into a
 * value or into an ordinary error — a catch that never consulted
 * `rethrowIfTurnStopped` — still fails the activity with that stop (the
 * budget exit for a budget refusal), and a delivered cancellation is
 * reported as a cancellation whatever the work made of the stops before it.
 * This is the last line, not the mechanism: work that mutates anything
 * checks `throwIfTurnStopped()` immediately before each write. Applies to
 * everything `runWithTurnDispatch` runs: every activity the interceptor
 * wraps and every positional activity that calls it itself.
 */
function completeTurnDispatch<T>(state: TurnGuardState, run: () => T): T {
	let result: T;
	try {
		result = run();
	} catch (error) {
		throw turnStopToThrow(state, error) ?? error;
	}
	if (!result || typeof (result as { then?: unknown }).then !== "function") {
		const latched = turnStopToThrow(state);
		if (latched) {
			throw latched;
		}
		return result;
	}
	return (result as unknown as Promise<unknown>).then(
		(value) => {
			const latched = turnStopToThrow(state);
			if (latched) {
				throw latched;
			}
			return value;
		},
		(error: unknown) => {
			throw turnStopToThrow(state, error) ?? error;
		},
	) as unknown as T;
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
 * turn guard has latched a stop (a dispatch refusal, a cancellation, or a
 * budget refusal), picking among them by the same precedence as the
 * activity's outcome (`turnStopToThrow`). For code that got a result back
 * after a stop it did not see as an error (a partial result whose aborted
 * parts were recorded as failures), so the result is not used — and,
 * through `throwIfDispatchStopped` (`@repo/utils/dispatch-guard`), for code
 * about to write anything, immediately before the write. Outside a turn
 * guard it only checks the activity's cancellation.
 */
export function throwIfTurnStopped(): void {
	const state = activeTurnGuardState();
	if (!state) {
		throwIfActivityCancelled();
		return;
	}
	const latched = turnStopToThrow(state);
	if (latched) {
		throw latched;
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
 * result: rethrow when the error is a stop (a cancellation, a dispatch
 * refusal or a budget refusal) or the active turn guard has latched one, so
 * none is converted into an answer. The stop thrown is the one the
 * precedence picks (`turnStopToThrow`).
 */
export function rethrowIfTurnStopped(error: unknown): void {
	const state = activeTurnGuardState();
	if (!state) {
		throwIfActivityCancelled();
		const stop = turnStopIn(error);
		if (stop) {
			// Unwrapped from any SDK retry error, so Temporal records the
			// non-retryable failure itself.
			throw stop;
		}
		return;
	}
	// Latch the stop this error carries (aborting the guard's other
	// requests: the turn's work is over), then throw whichever latched stop
	// the precedence picks. Inside a guard that has seen a stop, every
	// failure is that stop: a sibling request aborted by the guard fails
	// with whatever the provider or the SDK makes of the abort, which need
	// not carry it.
	latchTurnStop(state, error);
	const latched = turnStopToThrow(state);
	if (latched) {
		throw latched;
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
