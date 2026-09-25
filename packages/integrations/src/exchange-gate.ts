/**
 * A caller's pre-exchange gate (Fizzy #2563).
 *
 * A token exchange spends a single-use refresh token, so once its request is
 * sent it is never abandoned: its result is persisted even when the caller
 * has meanwhile run out of time. A caller with a deadline therefore decides
 * whether an exchange may START, and the latest honest point to decide is
 * under the provider's lock, immediately before the request: the pre-read,
 * the pool admission, the lock wait and the in-lock re-read have all been
 * spent by then. `beforeExchange` is that decision. It refuses by throwing,
 * and what it throws reaches the caller unchanged through every credential
 * helper, never read as a refresh failure or a platform fault. A path that
 * sends nothing (a PAT, a still-fresh token, a winner's refresh found by the
 * re-read) never consults it.
 */
export type BeforeExchange = () => void;

/** What a gate threw; an object (as an `Error` is) so identity survives each layer. */
const refusals = new WeakSet<object>();

/**
 * Consults `gate`, if any, immediately before an exchange. A refusal is
 * remembered so every helper above can rethrow it as is.
 */
export function runExchangeGate(gate: BeforeExchange | undefined): void {
	if (!gate) {
		return;
	}
	try {
		gate();
	} catch (error) {
		if (typeof error === "object" && error !== null) {
			refusals.add(error);
		}
		throw error;
	}
}

/** True when `error` is what a pre-exchange gate threw to refuse an exchange. */
export function isExchangeRefusal(error: unknown): boolean {
	return typeof error === "object" && error !== null && refusals.has(error);
}
