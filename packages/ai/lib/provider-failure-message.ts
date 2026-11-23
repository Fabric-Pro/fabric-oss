import {
	PROVIDER_FAILURE_MESSAGES,
	type ProviderFailureCause,
	providerFailureCauseFromText,
} from "@repo/utils/provider-failure-text";
import {
	describeModelCallError,
	isPermanentProviderFailure,
} from "./usage-logging-middleware";

function statusCodeOf(error: unknown): number | undefined {
	let current: unknown = error;
	for (let depth = 0; depth < 8 && current; depth++) {
		const { statusCode } = describeModelCallError(current);
		if (statusCode !== undefined) {
			return statusCode;
		}
		current =
			typeof current === "object" && "cause" in current
				? current.cause
				: undefined;
	}
	return undefined;
}

function causeFromStatus(statusCode: number): ProviderFailureCause | null {
	if (statusCode === 401 || statusCode === 403) {
		return "authentication";
	}
	if (statusCode === 429) {
		return "rate_limit";
	}
	if (statusCode === 404) {
		return "model_not_found";
	}
	if (statusCode === 408 || statusCode >= 500) {
		return "unavailable";
	}
	if (statusCode >= 400) {
		return "invalid_request";
	}
	return null;
}

/** `content_filter`, `content_policy_violation`, `ResponsibleAIPolicyViolation`, `cyber_policy`, … */
const REFUSAL_CODE = /content_filter|policy/i;

const REFUSAL_TEXT =
	/content[_ ]?(filter|management)|ResponsibleAIPolicyViolation|content[_ ]policy|safety (system|filter)|flagged as (potentially )?violating|usage polic(y|ies)/i;

/**
 * Whether a failed call is the model (or its provider's safety system)
 * declining the request, not a failure: a content-policy code, or text
 * naming one, on the error or a cause it wraps. A provider rejects such a
 * request with an HTTP 400, so only the code or text tells it apart from
 * an invalid one.
 */
export function isModelRefusal(error: unknown): boolean {
	let current: unknown = error;
	for (let depth = 0; depth < 8 && current; depth++) {
		const { message, details } = describeModelCallError(current);
		const code = details?.code;
		if (
			(typeof code === "string" && REFUSAL_CODE.test(code)) ||
			REFUSAL_TEXT.test(message)
		) {
			return true;
		}
		current =
			typeof current === "object" && "cause" in current
				? current.cause
				: undefined;
	}
	return false;
}

/**
 * Whether an error is a model provider's answer to a call: it (or a cause
 * it wraps) carries the provider's HTTP status, or is a credential failure.
 * An error raised by Fabric's own code is not.
 */
export function isProviderCallFailure(error: unknown): boolean {
	return (
		isPermanentProviderFailure(error) || statusCodeOf(error) !== undefined
	);
}

/**
 * Why a provider failed a request: the HTTP status the error (or a cause it
 * wraps) carries, else what its text says.
 */
export function classifyProviderFailure(error: unknown): ProviderFailureCause {
	if (isPermanentProviderFailure(error)) {
		return "authentication";
	}
	const statusCode = statusCodeOf(error);
	const fromStatus =
		statusCode === undefined ? null : causeFromStatus(statusCode);
	if (fromStatus) {
		return fromStatus;
	}
	const text =
		error instanceof Error
			? error.message
			: typeof error === "string"
				? error
				: "";
	return providerFailureCauseFromText(text);
}

/**
 * The one message every chat engine shows for a provider failure: the cause
 * in plain words and what to do, never the provider's own text, which can
 * carry its URL or a fragment of the key it was sent. Not for a Fabric
 * usage-limit refusal, which has its own message.
 */
export function providerFailureMessage(error: unknown): string {
	return PROVIDER_FAILURE_MESSAGES[classifyProviderFailure(error)];
}

export { providerFailureMessageFromText } from "@repo/utils/provider-failure-text";
