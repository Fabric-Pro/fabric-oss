/**
 * HTTP outcomes to sanitized adapter errors (Fizzy #2563 spec §10, §11).
 *
 * The classification (code, cause, retry hint) comes from the status and the
 * rate-limit headers alone; no body ever changes it. A refused `open` is the
 * one exception to "a body is never read", for diagnosis only: without the
 * provider's reason a refusal ("the pull request could not be opened") cannot
 * be acted on. What is read then, and kept on the error:
 *
 * - the provider's own error message from the JSON body: GitHub `message`
 *   plus each `errors[]` entry's `message`, or its `field` and `code`; GitLab
 *   `message` (a string, a list, or field to messages); Azure DevOps `message`;
 * - GitHub's `X-Accepted-GitHub-Permissions` header on a 403 or 404, which
 *   names permissions, not credentials.
 *
 * Both are scrubbed of the token and credential-shaped text, collapsed to one
 * line and bounded. The raw body, any other header and anything request-side
 * are never kept.
 */
import type { InstructionPullRequestFailureCode } from "@repo/database";
import { scrubAndTrim } from "@repo/utils/scrub-secrets";
import { type Cause, InstructionPullRequestError } from "./types";

/** Which adapter call failed: the same cause means different things to each. */
export type AdapterOperation = "lookup" | "open" | "close" | "merge";

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
	// Internal only: `merge` turns every error into a REFUSED result by cause.
	merge: {
		auth: { code: "AUTHENTICATION_FAILED", retryable: false },
		permission: { code: "PROVIDER_TEMPORARY", retryable: false },
		rate_limit: { code: "PROVIDER_RATE_LIMITED", retryable: true },
		not_found: { code: "PROVIDER_TEMPORARY", retryable: false },
		conflict: { code: "PROVIDER_TEMPORARY", retryable: false },
		transient: { code: "PROVIDER_TEMPORARY", retryable: true },
		unknown: { code: "PROVIDER_TEMPORARY", retryable: false },
	},
};

/** What a refused `open` said, already sanitized (see the module comment). */
export type RefusalDiagnostic = {
	providerStatus: number;
	providerMessage?: string;
	requiredPermissions?: string;
};

export function adapterError(
	operation: AdapterOperation,
	cause: Cause,
	extra: {
		retryAfterSeconds?: number;
		duplicate?: true;
	} & Partial<RefusalDiagnostic> = {},
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

/** A non-2xx response as an adapter error; `extra` never changes the classification. */
export function statusError(
	operation: AdapterOperation,
	status: number,
	headers: Headers,
	extra: { duplicate?: true } & Partial<RefusalDiagnostic> = {},
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

/** Longest provider message kept on an error. */
const MAX_PROVIDER_MESSAGE_CHARS = 300;
/** Longest accepted-permissions header kept on an error. */
const MAX_PERMISSIONS_CHARS = 120;

/** Reads a provider's error message out of a parsed JSON body. */
export type RefusalMessageReader = (body: unknown) => string | undefined;

const isObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

const text = (v: unknown): string | undefined =>
	typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;

/** GitHub: `message`, then each `errors[]` entry's `message` or `field: code`. */
export const githubRefusalMessage: RefusalMessageReader = (body) => {
	if (!isObject(body)) {
		return undefined;
	}
	const details = (Array.isArray(body.errors) ? body.errors : [])
		.map((entry) => {
			if (!isObject(entry)) {
				return text(entry);
			}
			const message = text(entry.message);
			if (message) {
				return message;
			}
			const field = text(entry.field);
			const code = text(entry.code);
			return field && code ? `${field}: ${code}` : (code ?? field);
		})
		.filter((d): d is string => d !== undefined);
	const message = text(body.message);
	if (details.length === 0) {
		return message;
	}
	return message ? `${message} — ${details.join("; ")}` : details.join("; ");
};

/** GitLab: `message`, which is a string, a list of strings, or field to messages. */
export const gitlabRefusalMessage: RefusalMessageReader = (body) => {
	if (!isObject(body)) {
		return undefined;
	}
	const flat = (v: unknown): string[] =>
		Array.isArray(v)
			? v.map(text).filter((s): s is string => s !== undefined)
			: [text(v)].filter((s): s is string => s !== undefined);
	const { message } = body;
	if (isObject(message)) {
		const parts = Object.entries(message).flatMap(([field, value]) =>
			flat(value).map((m) => `${field}: ${m}`),
		);
		return parts.length > 0 ? parts.join("; ") : undefined;
	}
	const parts = flat(message);
	return parts.length > 0 ? parts.join("; ") : undefined;
};

/** Azure DevOps: `message`. */
export const azureDevOpsRefusalMessage: RefusalMessageReader = (body) =>
	isObject(body) ? text(body.message) : undefined;

/**
 * The sanitized diagnostic of a refused `open`, from its status, headers and
 * body text. `secrets` are the values the request carried (the token).
 */
export function refusalDiagnostic(input: {
	status: number;
	headers: Headers;
	text: string;
	read: RefusalMessageReader;
	secrets: readonly string[];
}): RefusalDiagnostic {
	let parsed: unknown;
	try {
		parsed = JSON.parse(input.text);
	} catch {
		parsed = undefined;
	}
	const raw = input.read(parsed);
	const providerMessage =
		raw === undefined
			? undefined
			: scrubAndTrim(raw, input.secrets, MAX_PROVIDER_MESSAGE_CHARS) ||
				undefined;
	const header =
		input.status === 403 || input.status === 404
			? input.headers.get("x-accepted-github-permissions")
			: null;
	const requiredPermissions =
		header === null
			? undefined
			: scrubAndTrim(header, input.secrets, MAX_PERMISSIONS_CHARS) ||
				undefined;
	return {
		providerStatus: input.status,
		...(providerMessage ? { providerMessage } : {}),
		...(requiredPermissions ? { requiredPermissions } : {}),
	};
}
