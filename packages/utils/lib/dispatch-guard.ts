/**
 * Ambient dispatch guard for model and embedding requests.
 *
 * A caller that must be able to stop work in flight (an Advisor chat turn the
 * user pressed Stop on) installs a guard around the code doing that work.
 * Every model `getAIModelWithMetadata` / `getAIEmbeddingModelWithMetadata`
 * in `@repo/ai` returns reads the guard at REQUEST time, before each physical
 * provider request it makes, so a model or embedding call made with such a
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
}

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

/** The active guard, or undefined outside guarded code. */
export function getDispatchGuard(): DispatchGuard | undefined {
	return dispatchGuardStorage.getStore();
}

/** Runs `fn` with `guard` active for every request it makes. */
export function runWithDispatchGuard<T>(guard: DispatchGuard, fn: () => T): T {
	return dispatchGuardStorage.run(guard, fn);
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
 * For code that sends a provider request itself (a raw `fetch`, a provider
 * SDK model built outside the `@repo/ai` factory): call it immediately before
 * EVERY physical request, each retry or poll attempt included, and send the
 * request with the signal it returns.
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
