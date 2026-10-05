/**
 * Why the last request had no usable sign-in, kept where the command boundary
 * can read it.
 *
 * The SDK turns anything its `fetch` throws into a generic network error, so a
 * sign-in that could not be used would arrive at the boundary as "fetch
 * failed". `createOAuthFetch` records the real reason here before it throws,
 * and the boundary asks. One request at a time per process, which is all this
 * CLI ever does.
 */

export type AuthFailure =
	| { kind: "expired"; origin: string; project?: string }
	| { kind: "wrong-deployment"; origin: string };

let last: AuthFailure | null = null;

export function recordAuthFailure(failure: AuthFailure): void {
	last = failure;
}

/** The failure recorded since the last call, if any; asking clears it. */
export function takeAuthFailure(): AuthFailure | null {
	const failure = last;
	last = null;
	return failure;
}
