/**
 * HTTP outcomes to sanitized adapter errors (Fizzy #2563 spec §10, §11). Only
 * the status and a few headers are read here; a body never is.
 */
import type { InstructionPullRequestFailureCode } from "@repo/database";
import { type Cause, InstructionPullRequestError } from "./types";

/** Which adapter call failed: the same cause means different things to each. */
export type AdapterOperation = "lookup" | "open" | "close";

/** Lookups and closes: 20 s. `open`: 60 s (spec §10, Global Constraints). */
export const LOOKUP_TIMEOUT_MS = 20_000;
export const OPEN_TIMEOUT_MS = 60_000;
/** `findOperation` gives up as INCONCLUSIVE past this many pages. */
export const MAX_PAGES = 10;

/**
 * The code per (operation, cause). A lookup's failure is retried by the
 * sweeper. An `open` that may have reached the provider (transient, unknown)
 * is CREATE_OUTCOME_UNKNOWN; one the provider definitively refused is
 * PR_CREATION_REFUSED, which only a human retry re-issues (spec §6.1 step 7).
 */
const CODES: Record<
	AdapterOperation,
	Record<
		Cause,
		{ code: InstructionPullRequestFailureCode; retryable: boolean }
	>
> = {
	lookup: {
		auth: { code: "AUTHENTICATION_FAILED", retryable: true },
		permission: { code: "REPOSITORY_UNAVAILABLE", retryable: true },
		rate_limit: { code: "PROVIDER_RATE_LIMITED", retryable: true },
		not_found: { code: "REPOSITORY_UNAVAILABLE", retryable: true },
		conflict: { code: "LOOKUP_INCONCLUSIVE", retryable: true },
		transient: { code: "PROVIDER_TEMPORARY", retryable: true },
		unknown: { code: "LOOKUP_INCONCLUSIVE", retryable: true },
	},
	open: {
		auth: { code: "AUTHENTICATION_FAILED", retryable: true },
		permission: { code: "PR_CREATION_REFUSED", retryable: false },
		rate_limit: { code: "PROVIDER_RATE_LIMITED", retryable: true },
		not_found: { code: "PR_CREATION_REFUSED", retryable: false },
		conflict: { code: "PR_CREATION_REFUSED", retryable: false },
		transient: { code: "CREATE_OUTCOME_UNKNOWN", retryable: true },
		unknown: { code: "CREATE_OUTCOME_UNKNOWN", retryable: true },
	},
	close: {
		auth: { code: "AUTHENTICATION_FAILED", retryable: true },
		permission: { code: "CLOSE_REFUSED", retryable: true },
		rate_limit: { code: "PROVIDER_RATE_LIMITED", retryable: true },
		not_found: { code: "CLOSE_REFUSED", retryable: true },
		conflict: { code: "CLOSE_REFUSED", retryable: true },
		transient: { code: "PROVIDER_TEMPORARY", retryable: true },
		unknown: { code: "PROVIDER_TEMPORARY", retryable: true },
	},
};

export function adapterError(
	operation: AdapterOperation,
	cause: Cause,
	extra: { retryAfterSeconds?: number; duplicate?: true } = {},
): InstructionPullRequestError {
	const { code, retryable } = CODES[operation][cause];
	return new InstructionPullRequestError({
		code,
		retryable,
		cause,
		...extra,
	});
}

/**
 * Seconds until the provider accepts requests again: `Retry-After` (seconds
 * or an HTTP date), else a reset epoch (`x-ratelimit-reset` on GitHub,
 * `ratelimit-reset` on GitLab). Undefined when none is usable.
 */
export function retryAfterSecondsOf(
	headers: Headers,
	now: number = Date.now(),
): number | undefined {
	const retryAfter = headers.get("retry-after");
	if (retryAfter !== null) {
		const seconds = Number(retryAfter);
		if (Number.isFinite(seconds) && seconds >= 0) {
			return Math.max(1, Math.ceil(seconds));
		}
		const at = Date.parse(retryAfter);
		if (!Number.isNaN(at)) {
			return Math.max(1, Math.ceil((at - now) / 1000));
		}
	}
	const reset =
		headers.get("x-ratelimit-reset") ?? headers.get("ratelimit-reset");
	if (reset !== null) {
		const epoch = Number(reset);
		if (Number.isFinite(epoch) && epoch > 0) {
			return Math.max(1, Math.ceil(epoch - now / 1000));
		}
	}
	return undefined;
}

/** The cause a non-2xx status reports. */
export function causeOfStatus(status: number, headers: Headers): Cause {
	if (status === 401) {
		return "auth";
	}
	if (status === 429) {
		return "rate_limit";
	}
	if (status === 403) {
		return headers.get("x-ratelimit-remaining") === "0" ||
			headers.get("retry-after") !== null
			? "rate_limit"
			: "permission";
	}
	if (status === 404) {
		return "not_found";
	}
	if (status === 409 || status === 422) {
		return "conflict";
	}
	if (status === 408 || status >= 500) {
		return "transient";
	}
	return "unknown";
}

/** A non-2xx response as an adapter error, without reading its body. */
export function statusError(
	operation: AdapterOperation,
	status: number,
	headers: Headers,
	extra: { duplicate?: true } = {},
): InstructionPullRequestError {
	const cause = causeOfStatus(status, headers);
	return adapterError(operation, cause, {
		...(cause === "rate_limit"
			? { retryAfterSeconds: retryAfterSecondsOf(headers) }
			: {}),
		...extra,
	});
}

/**
 * What a list page says about the next one. Only a provider's own end
 * condition is `end`; a continuation the adapter cannot follow (malformed,
 * on another origin or path, out of order, or a paging scheme it does not
 * use) is `inconclusive`, because an incomplete search reported as ABSENT
 * would let recovery create a second pull request (spec §10).
 */
export type Continuation =
	| { kind: "end" }
	| { kind: "next"; next: string }
	| { kind: "inconclusive" };
