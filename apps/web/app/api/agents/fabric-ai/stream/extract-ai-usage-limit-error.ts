import { AiUsageLimitExceededError } from "@repo/payments";

/**
 * Subset of `AiUsageLimitExceededError` that the route's SSE consumer
 * (`useDirectStream` → `showAiUsageLimitToast`) actually reads. Mirrors
 * the public payload shape; lets us return an "extracted" payload from
 * the helper even when the original class instance has been lost across
 * a Temporal worker boundary (where only the message string and `name`
 * survive serialisation).
 */
export interface ExtractedAiUsageLimitPayload {
	limitId: string;
	dimension: "TOKENS" | "SPEND_USD";
	window: "HOURLY" | "DAILY" | "WEEKLY" | "MONTHLY";
	used: bigint;
	max: bigint;
	manageLimitsUrl: string;
	message: string;
}

/**
 * Stable message format emitted by the chokepoint
 * (`assertWithinAiUsageLimits` in `packages/payments/src/lib/ai-usage-limits.ts`):
 *   `AI usage limit exceeded: ${id} (${dim}, ${window}) — used ${used} of ${max}`
 * The message string survives EVERY serialisation path Temporal exposes
 * (ApplicationFailure / ActivityFailure / WorkflowFailedError) because
 * the field is a plain string on the JSON envelope. When the class
 * instance and the `name`/`limitId` duck-type both fail to match (e.g.
 * the error reached us through Temporal's worker boundary and got
 * re-wrapped without preserving custom fields), the regex extracts the
 * structured payload from the message as a final fallback.
 */
const LIMIT_ERROR_MESSAGE_RE =
	/AI usage limit exceeded:\s+([\w-]+)\s+\((TOKENS|SPEND_USD),\s+(HOURLY|DAILY|WEEKLY|MONTHLY)\)\s+—\s+used\s+(\d+)\s+of\s+(\d+)/;

function parseLimitErrorFromMessage(
	message: unknown,
): Omit<ExtractedAiUsageLimitPayload, "manageLimitsUrl"> | null {
	if (typeof message !== "string") {
		return null;
	}
	const m = LIMIT_ERROR_MESSAGE_RE.exec(message);
	if (!m) {
		return null;
	}
	const [, limitId, dimension, window, usedStr, maxStr] = m;
	try {
		return {
			limitId,
			dimension: dimension as "TOKENS" | "SPEND_USD",
			window: window as "HOURLY" | "DAILY" | "WEEKLY" | "MONTHLY",
			used: BigInt(usedStr),
			max: BigInt(maxStr),
			message,
		};
	} catch {
		// `BigInt()` only throws on malformed numerics — the regex captures
		// `\d+` so this is defensive against future format changes.
		return null;
	}
}

/**
 * Walk a (possibly Temporal-wrapped) error chain looking for an
 * `AiUsageLimitExceededError`. Temporal can wrap thrown errors in its
 * own envelope types (ApplicationFailure, ActivityFailure) which may
 * nest the original error under `cause`, `errors[]`, or wrap a fresh
 * envelope with the message preserved but the class instance dropped.
 * We try, in order:
 *
 *   1. `instanceof AiUsageLimitExceededError` — works when the error
 *      survived intact (e.g. caught from an in-process call).
 *   2. Duck-type `name === "AiUsageLimitExceededError" + limitId is string` —
 *      works when JSON round-trip dropped the prototype chain but kept
 *      the structured fields.
 *   3. Message regex match against {@link LIMIT_ERROR_MESSAGE_RE} —
 *      works when Temporal wrapped the original error in an envelope
 *      that DROPPED the custom fields but preserved the message string.
 *      `manageLimitsUrl` is unknown in this branch, so it falls back to
 *      the empty string; the toast helper gracefully omits the action
 *      button when the URL is empty.
 *
 * The walk follows `cause` and `errors[]` (AggregateError-style) up to
 * a small depth so we don't run unbounded on cyclic chains.
 */
export function extractAiUsageLimitExceededError(
	error: unknown,
): ExtractedAiUsageLimitPayload | null {
	const visited = new Set<unknown>();
	const queue: unknown[] = [error];
	let steps = 0;
	while (queue.length > 0 && steps < 16) {
		steps += 1;
		const current = queue.shift();
		if (current === null || current === undefined) {
			continue;
		}
		if (typeof current === "object" || typeof current === "function") {
			if (visited.has(current)) {
				continue;
			}
			visited.add(current);
		}

		if (current instanceof AiUsageLimitExceededError) {
			return {
				limitId: current.limitId,
				dimension: current.dimension as "TOKENS" | "SPEND_USD",
				window: current.window as
					| "HOURLY"
					| "DAILY"
					| "WEEKLY"
					| "MONTHLY",
				used: current.used,
				max: current.max,
				manageLimitsUrl: current.manageLimitsUrl,
				message: current.message,
			};
		}

		if (
			typeof current === "object" &&
			(current as { name?: unknown }).name ===
				"AiUsageLimitExceededError" &&
			typeof (current as { limitId?: unknown }).limitId === "string"
		) {
			const e = current as unknown as AiUsageLimitExceededError;
			return {
				limitId: e.limitId,
				dimension: e.dimension as "TOKENS" | "SPEND_USD",
				window: e.window as "HOURLY" | "DAILY" | "WEEKLY" | "MONTHLY",
				used:
					typeof e.used === "bigint"
						? e.used
						: BigInt(String(e.used)),
				max: typeof e.max === "bigint" ? e.max : BigInt(String(e.max)),
				manageLimitsUrl: e.manageLimitsUrl ?? "",
				message: e.message,
			};
		}

		// Message regex fallback — works across Temporal serialisation
		// paths that drop the class instance but preserve the message.
		const messageMatch = parseLimitErrorFromMessage(
			(current as { message?: unknown } | null)?.message,
		);
		if (messageMatch) {
			return {
				...messageMatch,
				// `manageLimitsUrl` is not in the message; the toast
				// helper handles an empty URL by omitting the action
				// button. Graceful degradation — the toast title +
				// description still surface.
				manageLimitsUrl: "",
			};
		}

		// Enqueue children: standard `cause` AND `errors[]` (Aggregate-
		// Error / Temporal `ActivityFailure.cause` shapes both appear
		// in our observed paths).
		const cause = (current as { cause?: unknown } | null)?.cause;
		if (cause !== undefined && cause !== null) {
			queue.push(cause);
		}
		const errors = (current as { errors?: unknown } | null)?.errors;
		if (Array.isArray(errors)) {
			for (const child of errors) {
				queue.push(child);
			}
		}
	}
	return null;
}
