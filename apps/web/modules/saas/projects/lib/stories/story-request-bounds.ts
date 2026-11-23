import { getOrpcCode } from "@saas/projects/components/field-mapping/orpc-error";
import type { DefaultError, UseMutationOptions } from "@tanstack/react-query";

/**
 * How long a review decision's read and save wait for the server. Offline
 * they fail at once (both run in any network state); this bounds a
 * connection that takes the request and never answers.
 */
export const STORY_REQUEST_TIMEOUT_MS = 30_000;

/** Said when the server could not be reached, and only then. */
export const STORY_SERVER_UNREACHABLE_MESSAGE =
	"The server could not be reached. Check your connection and try again.";

class NoAnswerError extends Error {
	constructor(ms: number) {
		super(`No answer within ${ms} ms`);
		this.name = "TimeoutError";
	}
}

/** `promise`'s answer, or a `TimeoutError` once `ms` pass without one. */
export function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new NoAnswerError(ms)), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

/**
 * Whether `error` is a request that got no answer in time. The server can
 * still apply it after the client gave up.
 */
export function isUnanswered(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"name" in error &&
		error.name === "TimeoutError"
	);
}

interface StoryText {
	description?: string | null;
	acceptanceCriteria?: string | null;
}

/**
 * Whether `stored` holds each text field `sent` wrote: a save that got no
 * answer in time was applied after all, and sent again it adds a version.
 */
export function holdsSentText(stored: StoryText, sent: StoryText): boolean {
	return (
		(sent.description === undefined ||
			(stored.description ?? null) === sent.description) &&
		(sent.acceptanceCriteria === undefined ||
			(stored.acceptanceCriteria ?? null) === sent.acceptanceCriteria)
	);
}

/**
 * The options of a save a review decision issues (an accept applying a
 * draft): it runs in any network state and within `STORY_REQUEST_TIMEOUT_MS`,
 * so offline it fails at once instead of reading as applied while it waits.
 * An ordinary save keeps the default mode: offline it pauses, and it goes
 * through once the connection is back.
 */
export function decisionSaveOptions<
	TData = unknown,
	TError = DefaultError,
	TVariables = void,
	TOnMutateResult = unknown,
>(
	options: UseMutationOptions<TData, TError, TVariables, TOnMutateResult>,
): UseMutationOptions<TData, TError, TVariables, TOnMutateResult> {
	const { mutationFn } = options;
	return {
		...options,
		networkMode: "always",
		mutationFn:
			mutationFn &&
			((variables, context) =>
				settleWithin(
					mutationFn(variables, context),
					STORY_REQUEST_TIMEOUT_MS,
				)),
	};
}

// How `fetch` words the TypeError of a request that got no answer: Chromium,
// Firefox, Safari, then the React Native polyfill and Node.
const FETCH_FAILURE_MESSAGES = [
	"Failed to fetch",
	"NetworkError when attempting to fetch resource",
	"Load failed",
	"Network request failed",
	"fetch failed",
];

/**
 * Whether `error` came without an answer from the server: offline, a dropped
 * connection, an aborted request or no answer in time. Every answer the API
 * gives, a proxy's error page included (`rpcErrorResponse`), arrives as an
 * oRPC error with a string `code`, and a refusal such as FORBIDDEN or
 * NOT_FOUND keeps its own message. A TypeError counts only as `fetch` words
 * one, or while the browser reports no network; any other is a fault in the
 * code, not the connection.
 */
export function isServerUnreachable(error: unknown): boolean {
	if (getOrpcCode(error) !== undefined) {
		return false;
	}
	if (error instanceof TypeError) {
		return (
			FETCH_FAILURE_MESSAGES.some((message) =>
				error.message.startsWith(message),
			) ||
			(typeof navigator !== "undefined" && navigator.onLine === false)
		);
	}
	return (
		typeof error === "object" &&
		error !== null &&
		"name" in error &&
		(error.name === "AbortError" || error.name === "TimeoutError")
	);
}
