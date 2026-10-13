/**
 * Turn-budget middleware for the models the factory returns.
 *
 * When the ambient dispatch guard (`@repo/utils/dispatch-guard`) carries a
 * token ledger (`guard.budget`, an Advisor chat turn admitted with a budget
 * contract), every physical request a factory model makes is reserved
 * against the turn's allowance immediately before it is sent and settled
 * from the provider's reported usage after: language requests, embedding
 * requests and typed decisions (`wrapDecisionModelWithTurnBudget`). With no
 * guard, or a guard with no ledger, the model is a pure pass-through.
 *
 * The ChatGPT plan adapter carries this middleware on each physical model
 * it sends through (the plan's own model, its fallback model, and every
 * account it rotates to), not around the rotating model as a whole, so each
 * of those sends is its own attempt (dynamic-model-selector.ts).
 *
 * Why `wrapGenerate`/`wrapStream` and not `transformParams`: the reservation
 * and its settlement must share one request-local handle. Here the attempt
 * id lives in the closure of the call that sends the request, so concurrent
 * requests never share or swap reservations, and each physical call — each
 * SDK step and each SDK retry, which all come back through these methods —
 * reserves afresh.
 *
 * Placement (dynamic-model-selector.ts): inside the dispatch guard and the
 * HARD usage-limit check, outside the usage logger. A refusal that happens
 * before dispatch (the guard's own check, a usage limit) therefore runs
 * before any reservation and leaves none behind.
 *
 * The request lifecycle, per attempt:
 *
 *   reserve      the ledger checks the turn (status, identity, generation)
 *                and the room left, then records the reservation; a denial
 *                is thrown as the ledger's own error and nothing is sent.
 *   size         when a request sizer is active for this guard
 *                (`runWithDispatchRequestSizer`, the Advisor's finalization
 *                synthesis) and the guard's ledger counts its language
 *                requests as FINALIZATION (`DispatchBudget.attemptKind`;
 *                never for an embedding or a decision), it decides this send's prompt and output
 *                allowance just before the reservation, on every physical
 *                send — so a resend through another physical model (the
 *                ChatGPT plan's fallback model or another account) is sized
 *                to the room left at that moment, like the first send. The
 *                allowance it validated is what is reserved as the
 *                requested output. Its refusal is thrown before anything is
 *                reserved.
 *   cap          a model that honours `maxOutputTokens` is sent with the
 *                cap the ledger granted (`min(requested, room − input)`);
 *                one that does not (`enforcesOutputCap: false`, the ChatGPT
 *                plan adapter strips the cap) is sent as asked, reserving
 *                the output the caller asked for, and its attempt is
 *                recorded MEASURED_ONLY.
 *   abort check  an abort signal already fired before the send releases the
 *                reservation: the send boundary was positively not crossed.
 *   settle       only complete usage (input and output totals both
 *                reported) settles the attempt to what it used, which may
 *                exceed the reservation. Anything else after the send — an
 *                error, an abort, missing or partial usage, a stream that
 *                closes without `finish`, a consumer that cancels — marks it
 *                UNKNOWN, and its reservation stays charged. A stream's
 *                `finish` is held until its settlement is written, or for at
 *                most `settlementTimeoutMs`. An `error` chunk followed by a
 *                `finish` with full usage settles from the `finish`.
 *   timeout      a settlement still in flight at `settlementTimeoutMs` is
 *                left to finish on its own: the `finish` is forwarded and
 *                the attempt stays RESERVED (charged at its reservation)
 *                until the write lands. A late settlement carrying complete
 *                usage is correct accounting whenever it commits, so nothing
 *                races it. A settlement write that fails leaves the attempt
 *                RESERVED too.
 *
 * Each attempt gets exactly one terminal transition call — release, settle
 * or unknown — and nothing else writes to it, so no two transitions ever
 * compete for one attempt. The ledger's own transitions are atomic and
 * idempotent besides (a second one changes nothing).
 *
 * A consumer that abandons a stream without cancelling it, or a process that
 * dies mid-request, leaves the attempt RESERVED, which the ledger keeps
 * charged exactly like UNKNOWN. A ledger write that fails is logged; it never
 * fails the request. While a settlement is in flight the ledger's totals are
 * conservatively high (the attempt counts at its reservation, not its usage).
 */

import { logger } from "@repo/logs";
import {
	type DispatchBudget,
	getDispatchGuard,
	getDispatchRequestSizer,
} from "@repo/utils/dispatch-guard";
import type {
	EmbeddingModel,
	EmbeddingModelMiddleware,
	LanguageModel,
	LanguageModelMiddleware,
} from "ai";
import { wrapEmbeddingModel, wrapLanguageModel } from "ai";
import {
	decisionOutputAllowance,
	estimateDecisionRequestInputTokens,
	estimateEmbeddingRequestInputTokens,
	estimateLanguageRequestInputTokens,
	TURN_BUDGET_ESTIMATE,
} from "./turn-budget-estimate";
import type { DecisionModelInstance } from "./usage-logging-middleware";

export interface TurnBudgetModelOptions {
	/**
	 * Whether the model sends `maxOutputTokens` to the provider. An explicit
	 * capability of the model the factory built, never inferred from a name.
	 */
	enforcesOutputCap: boolean;
	/**
	 * The output the caller asked for, when the request this middleware sees
	 * no longer carries it: the ChatGPT plan adapter strips `maxOutputTokens`
	 * before the physical models it wraps here. Unset, the request's own
	 * `maxOutputTokens` (or the default) is reserved.
	 */
	requestedOutputTokens?: number;
}

/** A finite, non-negative count from either usage shape, or null. */
function totalOf(value: unknown): number | null {
	const count =
		typeof value === "number"
			? value
			: typeof value === "object" && value !== null
				? (value as { total?: unknown }).total
				: undefined;
	return typeof count === "number" && Number.isFinite(count) && count >= 0
		? count
		: null;
}

/**
 * The usage to settle from, or null when it is not complete. Complete means
 * both totals are reported: the input total (which counts cache reads and
 * writes once — `LanguageModelV4Usage.inputTokens.total`) and the output
 * total (which includes reasoning). Partial usage never settles: a missing
 * count would read as zero and refund tokens that were spent.
 */
export function completeLanguageUsage(
	usage: unknown,
): { inputTokens: number; outputTokens: number } | null {
	const record = (usage ?? {}) as Record<string, unknown>;
	const inputTokens = totalOf(record.inputTokens);
	const outputTokens = totalOf(record.outputTokens);
	return inputTokens === null || outputTokens === null
		? null
		: { inputTokens, outputTokens };
}

function logLedgerWriteFailure(
	transition: string,
	attemptId: string,
	error: unknown,
): void {
	logger.warn("[TurnBudget] Ledger write failed; the attempt stays charged", {
		transition,
		attemptId,
		error: error instanceof Error ? error.message : String(error),
	});
}

/** Runs a ledger transition; a failure is logged, never thrown. */
async function transition(
	name: string,
	attemptId: string,
	write: () => Promise<void>,
): Promise<void> {
	try {
		await write();
	} catch (error) {
		logLedgerWriteFailure(name, attemptId, error);
	}
}

/** Resolves "timeout" after `settlementTimeoutMs`, unless cleared. */
function settlementTimer(): {
	expired: Promise<"timeout">;
	clear: () => void;
} {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<"timeout">((resolve) => {
		timer = setTimeout(
			() => resolve("timeout"),
			TURN_BUDGET_ESTIMATE.settlementTimeoutMs,
		);
	});
	return { expired, clear: () => clearTimeout(timer) };
}

/**
 * The attempt's one terminal transition after the send: SETTLED from
 * complete usage, else UNKNOWN. Waited for at most `settlementTimeoutMs`.
 *
 * On a timeout the write is left in flight and nothing else is written: the
 * attempt stays RESERVED, charged at its reservation, until the write lands
 * (a SETTLED write that lands late reconciles to the authoritative usage,
 * which is correct whenever it commits). A failed write is logged and leaves
 * the attempt RESERVED. Either way the charge never drops below what the
 * attempt is known to have used, and no second transition competes with
 * this one.
 */
async function finishAttempt(
	budget: DispatchBudget,
	attemptId: string,
	usage: { inputTokens: number; outputTokens: number } | null,
): Promise<void> {
	const name = usage ? "settle" : "unknown";
	const writing = (
		usage ? budget.settle(attemptId, usage) : budget.markUnknown(attemptId)
	).then(
		() => "written" as const,
		(error: unknown) => ({ failed: error }),
	);
	const timer = settlementTimer();
	try {
		const outcome = await Promise.race([writing, timer.expired]);
		if (outcome === "timeout") {
			logger.warn(
				"[TurnBudget] Ledger write still in flight at the timeout; the attempt stays charged until it lands",
				{ transition: name, attemptId },
			);
		} else if (outcome !== "written") {
			logLedgerWriteFailure(name, attemptId, outcome.failed);
		}
	} finally {
		timer.clear();
	}
}

function abortReason(signal: AbortSignal): unknown {
	return signal.reason ?? new DOMException("Aborted", "AbortError");
}

/** The active guard's ledger, if any. */
function activeBudget(): DispatchBudget | undefined {
	return getDispatchGuard()?.budget;
}

function modelIdOf(model: unknown): string | undefined {
	const id = (model as { modelId?: unknown } | null)?.modelId;
	return typeof id === "string" ? id : undefined;
}

/**
 * The request as the request sizer bound to the active guard
 * (`runWithDispatchRequestSizer`) sizes it for this physical send, with the output allowance to reserve; the
 * request unchanged when no sizer is active or it keeps the request as built.
 * A sizer's refusal is thrown from here, before anything is reserved.
 */
async function sizedRequest<P extends { prompt?: unknown }>(
	params: P,
	budget: DispatchBudget,
): Promise<{ params: P; requestedOutputTokens?: number }> {
	// Only the sizer installed under the active guard (getDispatchRequestSizer
	// checks that), and only when that guard's ledger counts its language
	// requests as FINALIZATION. Embedding and decision models never get here.
	const sizer =
		budget.attemptKind === "FINALIZATION"
			? getDispatchRequestSizer()
			: undefined;
	if (!sizer) {
		return { params };
	}
	const size = await sizer();
	if (!size) {
		return { params };
	}
	return {
		params:
			size.prompt === undefined
				? params
				: { ...params, prompt: size.prompt },
		requestedOutputTokens: size.maxOutputTokens,
	};
}

function createLanguageMiddleware(
	options: TurnBudgetModelOptions,
): LanguageModelMiddleware {
	const reserveFor = async (
		budget: DispatchBudget,
		params: {
			prompt?: unknown;
			tools?: unknown;
			maxOutputTokens?: number;
		},
		model: unknown,
		sizedOutputTokens: number | undefined,
	) =>
		budget.reserve({
			modality: "language",
			inputEstimate: estimateLanguageRequestInputTokens(params),
			requestedOutputTokens:
				sizedOutputTokens ??
				options.requestedOutputTokens ??
				params.maxOutputTokens ??
				TURN_BUDGET_ESTIMATE.defaultRequestedOutputTokens,
			minOutputTokens: TURN_BUDGET_ESTIMATE.minOutputTokens,
			enforcesOutputCap: options.enforcesOutputCap,
			modelId: modelIdOf(model),
		});

	return {
		specificationVersion: "v4",
		wrapGenerate: async ({ doGenerate, params: requested, model }) => {
			const budget = activeBudget();
			if (!budget) {
				return doGenerate();
			}
			const sized = await sizedRequest(requested, budget);
			const params = sized.params;
			const reservation = await reserveFor(
				budget,
				params,
				model,
				sized.requestedOutputTokens,
			);
			if (!reservation) {
				return sized.requestedOutputTokens === undefined
					? doGenerate()
					: model.doGenerate(params);
			}
			const { attemptId } = reservation;
			const sendParams =
				reservation.outputCap === null
					? params
					: { ...params, maxOutputTokens: reservation.outputCap };
			if (sendParams.abortSignal?.aborted) {
				await transition("release", attemptId, () =>
					budget.release(attemptId),
				);
				throw abortReason(sendParams.abortSignal);
			}
			let result: Awaited<ReturnType<typeof model.doGenerate>>;
			try {
				result = await model.doGenerate(sendParams);
			} catch (error) {
				await transition("unknown", attemptId, () =>
					budget.markUnknown(attemptId),
				);
				throw error;
			}
			const usage = completeLanguageUsage(result.usage);
			await finishAttempt(budget, attemptId, usage);
			return result;
		},
		wrapStream: async ({ doStream, params: requested, model }) => {
			const budget = activeBudget();
			if (!budget) {
				return doStream();
			}
			const sized = await sizedRequest(requested, budget);
			const params = sized.params;
			const reservation = await reserveFor(
				budget,
				params,
				model,
				sized.requestedOutputTokens,
			);
			if (!reservation) {
				return sized.requestedOutputTokens === undefined
					? doStream()
					: model.doStream(params);
			}
			const { attemptId } = reservation;
			const sendParams =
				reservation.outputCap === null
					? params
					: { ...params, maxOutputTokens: reservation.outputCap };
			if (sendParams.abortSignal?.aborted) {
				await transition("release", attemptId, () =>
					budget.release(attemptId),
				);
				throw abortReason(sendParams.abortSignal);
			}
			let result: Awaited<ReturnType<typeof model.doStream>>;
			try {
				result = await model.doStream(sendParams);
			} catch (error) {
				await transition("unknown", attemptId, () =>
					budget.markUnknown(attemptId),
				);
				throw error;
			}

			// One terminal transition per attempt, at the first terminal state.
			let terminal = false;
			const finishWith = async (
				usage: { inputTokens: number; outputTokens: number } | null,
			) => {
				if (terminal) {
					return;
				}
				terminal = true;
				await finishAttempt(budget, attemptId, usage);
			};
			type Part = Record<string, unknown>;
			// Typed by hand rather than as `Transformer`: `cancel` is part of
			// the WHATWG Transformer (Node 21.5+) but missing from TypeScript's
			// lib, and packages compile this source without the DOM lib (see
			// usage-logging-middleware.ts).
			const transformer = {
				async transform(
					chunk: Part,
					controller: TransformStreamDefaultController<Part>,
				) {
					if (chunk?.type === "finish") {
						// Held until the settlement is written, so the caller
						// never sees completion before the ledger does.
						await finishWith(completeLanguageUsage(chunk.usage));
					}
					controller.enqueue(chunk);
				},
				async flush() {
					// Closed without a finish: the request was sent and its
					// usage is unknown.
					await finishWith(null);
				},
				async cancel() {
					// The consumer cancelled, or the source errored (an abort
					// after the send among them).
					await finishWith(null);
				},
			};
			return {
				...result,
				stream: (result.stream as ReadableStream<Part>).pipeThrough(
					new TransformStream<Part, Part>(transformer),
				) as unknown as typeof result.stream,
			};
		},
	};
}

function createEmbeddingMiddleware(): EmbeddingModelMiddleware {
	return {
		specificationVersion: "v4",
		wrapEmbed: async ({ doEmbed, params, model }) => {
			const budget = activeBudget();
			if (!budget) {
				return doEmbed();
			}
			const reservation = await budget.reserve({
				modality: "embedding",
				inputEstimate: estimateEmbeddingRequestInputTokens(
					params.values,
				),
				requestedOutputTokens: 0,
				minOutputTokens: 0,
				enforcesOutputCap: true,
				modelId: modelIdOf(model),
			});
			if (!reservation) {
				return doEmbed();
			}
			const { attemptId } = reservation;
			if (params.abortSignal?.aborted) {
				await transition("release", attemptId, () =>
					budget.release(attemptId),
				);
				throw abortReason(params.abortSignal);
			}
			let result: Awaited<ReturnType<typeof doEmbed>>;
			try {
				result = await doEmbed();
			} catch (error) {
				await transition("unknown", attemptId, () =>
					budget.markUnknown(attemptId),
				);
				throw error;
			}
			const tokens = totalOf(
				(result as { usage?: { tokens?: unknown } }).usage?.tokens,
			);
			await finishAttempt(
				budget,
				attemptId,
				tokens === null
					? null
					: { inputTokens: tokens, outputTokens: 0 },
			);
			return result;
		},
	};
}

/**
 * Wraps a resolved language model so each physical request reserves against
 * the active guard's ledger and settles after (see the file header).
 */
export function wrapModelWithTurnBudget(
	model: LanguageModel,
	options: TurnBudgetModelOptions,
): LanguageModel {
	return wrapLanguageModel({
		model: model as Parameters<typeof wrapLanguageModel>[0]["model"],
		middleware: createLanguageMiddleware(options),
	}) as LanguageModel;
}

/**
 * Typed decision counterpart of {@link wrapModelWithTurnBudget}. Decision
 * models expose `doDecide` directly instead of supporting the SDK's model
 * middleware, so the one network boundary is wrapped (the shape of
 * `wrapEvaluationModelWithUsageLogging`). Each physical `doDecide` — each
 * retry `experimental_decide` makes on its own included — reserves before
 * it is sent and settles after, as an AUXILIARY request (`modality:
 * "decision"`):
 *
 *   - the input is estimated from the state and the questions
 *     (`estimateDecisionRequestInputTokens`);
 *   - the output is the decision's own bound, an allowance per question
 *     (`decisionOutputAllowance`). A decision takes no output cap, so the
 *     request is not capped (`enforcesOutputCap: false`, MEASURED_ONLY), and
 *     a request that cannot get the whole allowance is refused rather than
 *     sent with less (`minOutputTokens` is the allowance);
 *   - complete usage (both totals) settles; an error or abort after the
 *     send marks the attempt UNKNOWN (kept charged); an abort that fired
 *     before the send releases it.
 *
 * With no guard, a guard without a ledger, or a turn without one, the call
 * passes through untouched.
 */
export function wrapDecisionModelWithTurnBudget(
	model: DecisionModelInstance,
): DecisionModelInstance {
	const doDecide = model.doDecide.bind(model);
	return {
		// GatewayDecisionModel exposes `provider` through a prototype getter,
		// so each contract field is copied explicitly rather than spread.
		specificationVersion: model.specificationVersion,
		provider: model.provider,
		modelId: model.modelId,
		supportedQuestionTypes: model.supportedQuestionTypes,
		doDecide: async (callOptions) => {
			const budget = activeBudget();
			if (!budget) {
				return doDecide(callOptions);
			}
			const allowance = decisionOutputAllowance(callOptions.questions);
			const reservation = await budget.reserve({
				modality: "decision",
				inputEstimate: estimateDecisionRequestInputTokens(callOptions),
				requestedOutputTokens: allowance,
				minOutputTokens: allowance,
				enforcesOutputCap: false,
				modelId: model.modelId,
			});
			if (!reservation) {
				return doDecide(callOptions);
			}
			const { attemptId } = reservation;
			if (callOptions.abortSignal?.aborted) {
				await transition("release", attemptId, () =>
					budget.release(attemptId),
				);
				throw abortReason(callOptions.abortSignal);
			}
			let result: Awaited<ReturnType<typeof doDecide>>;
			try {
				result = await doDecide(callOptions);
			} catch (error) {
				await transition("unknown", attemptId, () =>
					budget.markUnknown(attemptId),
				);
				throw error;
			}
			await finishAttempt(
				budget,
				attemptId,
				completeLanguageUsage(result.usage),
			);
			return result;
		},
	};
}

/** Embedding counterpart of {@link wrapModelWithTurnBudget}. */
export function wrapEmbeddingModelWithTurnBudget(
	model: EmbeddingModel,
): EmbeddingModel {
	return wrapEmbeddingModel({
		model: model as Parameters<typeof wrapEmbeddingModel>[0]["model"],
		middleware: createEmbeddingMiddleware(),
	}) as EmbeddingModel;
}
