import { AsyncLocalStorage } from "node:async_hooks";
import { type PlanSourceRef, planSourceKey } from "./sources";

/**
 * Which sign-in each plan source's call actually used (Fizzy #3037). A plan
 * model reads its access token inside the provider request, out of sight of
 * the middleware that records the outcome; the token read notes the sign-in
 * here, per source, so the breaker can bind the refusal or recovery it writes
 * to that sign-in and drop it once the source has been replaced.
 */
export type PlanCredentialsUsed = Map<string, string>;

const used = new AsyncLocalStorage<PlanCredentialsUsed>();

/**
 * Runs `work`, noting the sign-in of every plan token it reads into the
 * enclosing call's notes when there are some, else into fresh ones; returns
 * those notes with the result, so a call nested in a rotation shares them.
 */
export function capturePlanCredentials<T>(
	work: () => PromiseLike<T>,
	notes: PlanCredentialsUsed = used.getStore() ?? new Map(),
): { notes: PlanCredentialsUsed; result: Promise<T> } {
	return {
		notes,
		result: used.run(notes, async () => await work()),
	};
}

/** Notes that the current call reads `source`'s token from this sign-in. */
export function notePlanCredentialUsed(
	source: PlanSourceRef,
	credentialFingerprint: string,
): void {
	used.getStore()?.set(planSourceKey(source), credentialFingerprint);
}

/** The sign-in a call last read `source`'s token from, when it read one. */
export function planCredentialUsed(
	notes: PlanCredentialsUsed,
	source: PlanSourceRef,
): string | undefined {
	return notes.get(planSourceKey(source));
}
