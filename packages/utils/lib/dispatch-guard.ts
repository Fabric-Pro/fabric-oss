/**
 * Ambient dispatch guard for model and embedding requests.
 *
 * A caller that must be able to stop work in flight (an Advisor chat turn the
 * user pressed Stop on) installs a guard around the code doing that work.
 * Every model `getAIModelWithMetadata` / `getAIEmbeddingModelWithMetadata` /
 * `getAIDecisionModelWithMetadata` in `@repo/ai` returns reads the guard at
 * REQUEST time, before each physical provider request it makes, so a model or embedding call made with such a
 * model inside the guarded code is checked and abortable by default,
 * including calls added later and calls made deep inside `@repo/rag`, with no
 * argument threaded to them. A model built outside that factory (a provider
 * called directly) does not consult the guard and needs its own check.
 *
 * The guard carries callbacks only. Packages that consult it learn nothing
 * about what a turn is or how it is stored: they ask "may I send?", take the
 * abort signal to attach to the request, and hand back an error to be
 * rethrown when it is a stop, so it is never converted into a fallback
 * result.
 *
 * Uses globalThis to guarantee a single AsyncLocalStorage instance even when
 * the bundler creates multiple copies of this module across package bundles,
 * the same rationale as `correlationStorage` and `projectContextStorage`.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface DispatchGuard {
	/**
	 * Opaque identity of what is being guarded. Lets the owner of an explicit
	 * check skip it when this guard already performs the same one, so a
	 * request is not checked twice.
	 */
	readonly key: string;
	/** Resolves when another provider request may start; throws a stop otherwise. */
	assertDispatchable(): Promise<void>;
	/** Aborts requests in flight when the guarded work is cancelled. */
	abortSignal(): AbortSignal | undefined;
	/**
	 * Throws when `error` is (or wraps) a stop, so a catch block never turns
	 * it into a fallback result. Returns normally for any other error.
	 */
	rethrowIfStopped(error: unknown): void;
	/**
	 * Throws when the guarded work has already seen a stop (or its owner was
	 * cancelled). For code about to make a write: called immediately before
	 * it, so nothing is mutated after the work stopped. Optional: a guard
	 * without it never stops writes.
	 */
	throwIfStopped?(): void;
	/**
	 * The guarded work's token ledger, when it has one: every factory model
	 * reserves each physical request against it before sending and settles
	 * the request's usage after (`@repo/ai`'s turn-budget middleware).
	 * Raw token-billed callers opt in with {@link dispatchBudgetSend};
	 * {@link guardDispatch} alone checks stops without reserving tokens.
	 * Absent for guarded work with no ledger.
	 */
	readonly budget?: DispatchBudget;
}

/** One physical request, as the turn-budget middleware describes it. */
export interface DispatchBudgetRequest {
	/**
	 * What kind of model request it is. An embedding reserves its input only.
	 * Embeddings, decisions (a typed `doDecide`) and external remote work
	 * count as auxiliary work for the ledger; a language request counts as whatever
	 * its activity's work is.
	 */
	modality: "language" | "embedding" | "decision" | "external";
	/** Estimated input tokens (an estimate, never a measured value). */
	inputEstimate: number;
	/** Output tokens the request asks for; 0 for an embedding. */
	requestedOutputTokens: number;
	/** Smallest output cap worth sending; 0 for an embedding. */
	minOutputTokens: number;
	/** False when the model cannot honour an output cap. */
	enforcesOutputCap: boolean;
	/** Diagnostic only. */
	modelId?: string;
}

/** A reservation the ledger granted for one physical request. */
export interface DispatchBudgetReservation {
	attemptId: string;
	/**
	 * The output cap to send the request with, or null when the model cannot
	 * be capped (the request is then sent as asked).
	 */
	outputCap: number | null;
}

/**
 * Callbacks onto a ledger. `reserve` resolves null when the work turns out to
 * have no ledger (the request is then sent unreserved) and throws the
 * ledger's denial otherwise. The other three move one reservation to its
 * final state: settled from complete usage, unknown (kept charged), or
 * released (positively never sent). They resolve once the transition is
 * durable and may reject when it is not; a reservation never transitioned
 * stays charged. The caller makes at most one of these calls per
 * reservation.
 */
export interface DispatchBudget {
	/**
	 * What the ledger counts this guard's language requests as (an
	 * embedding, decision or external request is auxiliary, whatever this says).
	 * Read only to decide whether a request sizer applies: a sizer is
	 * honoured for `"FINALIZATION"` and for nothing else, and a ledger that
	 * leaves this out is never sized.
	 */
	readonly attemptKind?: string;
	reserve(
		request: DispatchBudgetRequest,
	): Promise<DispatchBudgetReservation | null>;
	settle(
		attemptId: string,
		usage: {
			inputTokens: number;
			outputTokens: number;
			cacheReadTokens?: number;
		},
	): Promise<void>;
	markUnknown(attemptId: string): Promise<void>;
	release(attemptId: string): Promise<void>;
}

/**
 * How one physical language request is to be sent, as a request sizer
 * decides it immediately before the request is reserved.
 */
export interface DispatchRequestSize {
	/**
	 * The prompt to send instead of the request's own (a LanguageModelV4
	 * prompt), or undefined to keep the request's own.
	 */
	prompt?: unknown;
	/**
	 * The output allowance the sizer validated against the ledger's room:
	 * the turn-budget middleware reserves it as the requested output, and
	 * sends it as the cap to a model that honours one.
	 */
	maxOutputTokens: number;
}

/**
 * Sizes the next physical language request. Called by the turn-budget
 * middleware on every physical send made inside `runWithDispatchRequestSizer`
 * under the guard that was active when the sizer was installed, when that
 * guard's ledger counts its language requests as FINALIZATION
 * (`DispatchBudget.attemptKind`) — the first send, an SDK retry, and every resend a provider adapter makes
 * through another physical model (the ChatGPT plan's model fallback and
 * account rotation) — just before that send reserves. Resolves null to send
 * the request as built; throws to refuse it before anything is reserved.
 */
export type DispatchRequestSizer = () => Promise<DispatchRequestSize | null>;

const SIZER_STORAGE_KEY = "__fabric_dispatch_request_sizer_storage__" as const;

const STORAGE_KEY = "__fabric_dispatch_guard_storage__" as const;
const GUARDED_MODELS_KEY = "__fabric_dispatch_guarded_models__" as const;

const globals = globalThis as Record<string, unknown>;

const dispatchGuardStorage: AsyncLocalStorage<DispatchGuard> =
	(globals[STORAGE_KEY] as AsyncLocalStorage<DispatchGuard> | undefined) ??
	(() => {
		const storage = new AsyncLocalStorage<DispatchGuard>();
		globals[STORAGE_KEY] = storage;
		return storage;
	})();

const dispatchRequestSizerStorage: AsyncLocalStorage<BoundDispatchRequestSizer> =
	(globals[SIZER_STORAGE_KEY] as
		| AsyncLocalStorage<BoundDispatchRequestSizer>
		| undefined) ??
	(() => {
		const storage = new AsyncLocalStorage<BoundDispatchRequestSizer>();
		globals[SIZER_STORAGE_KEY] = storage;
		return storage;
	})();

/** A sizer with the guard that was active when it was installed. */
interface BoundDispatchRequestSizer {
	readonly owner: DispatchGuard;
	readonly sizer: DispatchRequestSizer;
}

/**
 * Runs `fn` with `sizer` sizing the physical language requests a ledgered
 * factory model makes inside it (see {@link DispatchRequestSizer}). The sizer
 * is bound to the guard active here: `getDispatchRequestSizer` returns it
 * only while that same guard object is the active one, so a nested
 * `runWithDispatchGuard` with another guard, or `runOutsideDispatchGuard`,
 * does not see it, and leaving that scope sees it again. Only the
 * turn-budget middleware reads it, and applies it only to a request whose
 * guard's ledger counts it as FINALIZATION. Throws when no guard is active:
 * a sizer without a guard is a programming error.
 */
export function runWithDispatchRequestSizer<T>(
	sizer: DispatchRequestSizer,
	fn: () => T,
): T {
	const owner = getDispatchGuard();
	if (!owner) {
		throw new Error(
			"runWithDispatchRequestSizer needs an active dispatch guard to bind the sizer to",
		);
	}
	return dispatchRequestSizerStorage.run({ owner, sizer }, fn);
}

/**
 * The request sizer installed under the guard that is active now, or
 * undefined (none installed, a different guard active, or no guard).
 */
export function getDispatchRequestSizer(): DispatchRequestSizer | undefined {
	const bound = dispatchRequestSizerStorage.getStore();
	return bound && bound.owner === getDispatchGuard()
		? bound.sizer
		: undefined;
}

/** The active guard, or undefined outside guarded code. */
export function getDispatchGuard(): DispatchGuard | undefined {
	return dispatchGuardStorage.getStore();
}

/** Runs `fn` with `guard` active for every request it makes. */
export function runWithDispatchGuard<T>(guard: DispatchGuard, fn: () => T): T {
	return dispatchGuardStorage.run(guard, fn);
}

/**
 * Runs `fn` with no guard active. For work shared between callers that
 * carries none of any one caller's content — provisioning a vector-store
 * collection that several callers await through one in-flight promise — so
 * one caller's stop neither refuses that work nor reaches the other callers
 * through it. Nothing inside `fn` consults a guard: no stop check, no merged
 * abort signal, no ledger. The caller's own guard is active again in the
 * code that awaits `fn`'s result.
 */
export function runOutsideDispatchGuard<T>(fn: () => T): T {
	return dispatchGuardStorage.exit(fn);
}

/**
 * For a catch block that would otherwise turn an error into a fallback
 * result: rethrows when the active guard says the error is a stop. A no-op
 * outside guarded code, so callers with no guard keep their behaviour.
 */
export function rethrowIfDispatchStopped(error: unknown): void {
	getDispatchGuard()?.rethrowIfStopped(error);
}

/**
 * For code about to perform a write (a database row, a call to an external
 * service, a workflow start, a lifecycle event): call it IMMEDIATELY before
 * the write, after any catch that may have absorbed a model or embedding
 * failure. For a client Fabric owns, "immediately before" means inside the
 * client, in the same synchronous run as its transport call (the `fetch`,
 * the Qdrant or Redis client method), on every path that sends — a retry,
 * a resend after a token refresh, a fallback — because a check at the
 * client's call site does not cover the awaits inside it.
 *
 * Inside guarded work that has already seen a stop (the turn was stopped or
 * used its token allowance, or the activity was cancelled) it throws that
 * stop, so the write never starts. A no-op outside guarded code,
 * so callers with no guard keep their behaviour.
 */
export function throwIfDispatchStopped(): void {
	getDispatchGuard()?.throwIfStopped?.();
}

/**
 * Checks stops and merges signals only; this does not reserve tokens.
 * Raw token-billed callers use {@link dispatchBudgetSend} for accounting.
 *
 * For code that sends a provider request itself (a raw `fetch`, a provider
 * SDK model built outside the `@repo/ai` factory): call it immediately before
 * EVERY physical request, each retry or poll attempt included, and send the
 * request with the signal it returns. Awaiting it is itself an await, so
 * the send still calls {@link throwIfDispatchStopped} (or
 * {@link dispatchSendSignal}) in the same synchronous run as the request:
 * a stop latched while this resolved is caught there.
 *
 * Inside guarded code it awaits `assertDispatchable()` (so a stopped guard
 * throws its stop and the request is never sent) and returns `signal` merged
 * with the guard's abort signal, so the request and the reading of its body
 * abort when the guarded work is stopped. Outside guarded code it returns
 * `signal` itself, unchanged (the same object, or undefined).
 *
 * A request aborted through the merged signal rejects with the abort's
 * reason: the guard's stop, or the caller's own reason (a timeout). A catch
 * that turns errors into a fallback still calls
 * {@link rethrowIfDispatchStopped} first, so the stop is rethrown and a
 * timeout keeps its usual handling.
 */
export async function guardDispatch(
	signal?: AbortSignal,
): Promise<AbortSignal | undefined> {
	const guard = getDispatchGuard();
	if (!guard) {
		return signal;
	}
	await guard.assertDispatchable();
	return dispatchSendSignal(signal);
}

/**
 * The synchronous half of {@link guardDispatch}, for the transport call
 * itself: the line that calls `fetch` (or a client method that sends).
 * Call it in the same synchronous run as the send, with nothing awaited
 * between the two — on a client's own resend or retry as much as on its
 * first send.
 *
 * Inside guarded work it throws the stop the guard has already seen (as
 * {@link throwIfDispatchStopped} does) and returns `signal` merged with the
 * guard's abort signal. Outside guarded code it returns `signal` unchanged.
 * It reads no durable record: that is `guardDispatch`, which awaits, so a
 * send no earlier check covers awaits `guardDispatch` first and still calls
 * this immediately before sending.
 */
export function dispatchSendSignal(
	signal?: AbortSignal,
): AbortSignal | undefined {
	const guard = getDispatchGuard();
	if (!guard) {
		return signal;
	}
	guard.throwIfStopped?.();
	const guardSignal = guard.abortSignal();
	if (!guardSignal || guardSignal === signal) {
		return signal;
	}
	return signal ? AbortSignal.any([signal, guardSignal]) : guardSignal;
}

const guardedModels: WeakSet<object> =
	(globals[GUARDED_MODELS_KEY] as WeakSet<object> | undefined) ??
	(() => {
		const set = new WeakSet<object>();
		globals[GUARDED_MODELS_KEY] = set;
		return set;
	})();

/**
 * Records that `model` consults the active guard before each of its
 * requests. Set by the model factory on the models it returns.
 */
export function markDispatchGuardedModel<T extends object>(model: T): T {
	guardedModels.add(model);
	return model;
}

/** True when `model` was marked by {@link markDispatchGuardedModel}. */
export function isDispatchGuardedModel(model: unknown): boolean {
	return (
		typeof model === "object" && model !== null && guardedModels.has(model)
	);
}

/** Maximum wait for a raw send's ledger transition; late writes stay in flight. */
const RAW_SEND_SETTLEMENT_TIMEOUT_MS = 10_000;

/**
 * One physical raw request, including consumption/parsing of its response body.
 * This helper rechecks the latched stop, takes the merged signal and invokes
 * `send` in the same synchronous run. Direct transports should start before
 * the callback's first await. SDK header preparation (Gemini) or a safe-fetch
 * DNS check (external A2A) can await internally before opening a connection:
 * those callers still pass the merged signal, so a stop in that window aborts
 * the request. Once the callback has started, such failures end UNKNOWN and
 * keep the charge rather than risk undercharging. Retry loops call this helper
 * inside the loop.
 *
 * A refused reservation never reaches `send`. Once `send` starts, only complete
 * provider usage can replace the charge; failures and incomplete usage mark it
 * UNKNOWN. A stop (or an already aborted signal) before `send` releases it.
 * Each reservation takes one terminal transition. Transition failures/timeouts
 * leave it charged and cannot turn a successful provider call into a retry.
 * No ledger means the ordinary guard check/signal and an otherwise untouched send.
 */
export async function dispatchBudgetSend<T>(options: {
	request: DispatchBudgetRequest;
	signal?: AbortSignal;
	send: (
		signal: AbortSignal | undefined,
		outputCap: number | null,
	) => Promise<{
		result: T;
		usage?: { inputTokens?: number; outputTokens?: number } | null;
	}>;
}): Promise<T> {
	const guard = getDispatchGuard();
	if (guard) {
		await guard.assertDispatchable();
	}
	const budget = guard?.budget;
	const reservation = budget ? await budget.reserve(options.request) : null;
	const finish = async (write: () => Promise<void>) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			// Promise.resolve also catches a synchronous callback failure. The losing
			// write keeps its rejection handler and is not raced by another transition.
			const writing = Promise.resolve()
				.then(write)
				.catch(() => {
					console.warn(
						"[DispatchBudget] Ledger write failed; the attempt stays charged",
					);
				});
			await Promise.race([
				writing,
				new Promise<void>((resolve) => {
					timer = setTimeout(() => {
						console.warn(
							"[DispatchBudget] Ledger write still in flight; the attempt stays charged",
						);
						resolve();
					}, RAW_SEND_SETTLEMENT_TIMEOUT_MS);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	};
	let signal: AbortSignal | undefined;
	try {
		signal = dispatchSendSignal(options.signal);
		if (reservation && signal?.aborted) {
			throw signal.reason ?? new DOMException("Aborted", "AbortError");
		}
	} catch (error) {
		if (budget && reservation) {
			await finish(() => budget.release(reservation.attemptId));
		}
		throw error;
	}
	// No await between dispatchSendSignal above and invocation of the send callback.
	let sent: Awaited<ReturnType<typeof options.send>>;
	try {
		sent = await options.send(signal, reservation?.outputCap ?? null);
	} catch (error) {
		if (budget && reservation) {
			await finish(() => budget.markUnknown(reservation.attemptId));
		}
		throw error;
	}
	if (budget && reservation) {
		const input = sent.usage?.inputTokens;
		const output = sent.usage?.outputTokens;
		const complete =
			typeof input === "number" &&
			Number.isFinite(input) &&
			input >= 0 &&
			typeof output === "number" &&
			Number.isFinite(output) &&
			output >= 0;
		await finish(() =>
			complete
				? budget.settle(reservation.attemptId, {
						inputTokens: input,
						outputTokens: output,
					})
				: budget.markUnknown(reservation.attemptId),
		);
	}
	return sent.result;
}
