/** Why an AI provider failed a request, as the person is told it. */
export type ProviderFailureCause =
	| "authentication"
	| "rate_limit"
	| "model_not_found"
	| "invalid_request"
	| "unavailable"
	| "unknown";

export const PROVIDER_FAILURE_MESSAGES: Record<ProviderFailureCause, string> = {
	authentication:
		"The AI provider rejected the request (authentication). Check the provider settings.",
	rate_limit:
		"The AI provider is limiting requests right now (rate limit). Try again in a moment.",
	model_not_found:
		"The AI provider does not offer the selected model. Check the provider settings.",
	invalid_request:
		"The AI provider rejected the request (invalid request). Try again, or check the provider settings.",
	unavailable:
		"The AI provider is not responding right now. Try again in a moment.",
	unknown:
		"The AI provider could not complete the request. Try again, or check the provider settings.",
};

/** Why a provider failed a request, from what its error text says. */
export function providerFailureCauseFromText(
	text: string,
): ProviderFailureCause {
	if (
		/\b(401|403)\b|unauthori[sz]ed|forbidden|invalid[_ ](x-)?api[_ -]key|incorrect api key|authentication/i.test(
			text,
		)
	) {
		return "authentication";
	}
	if (/\b429\b|rate.?limit|too many requests/i.test(text)) {
		return "rate_limit";
	}
	if (/model.{0,40}(not found|does not exist|not supported)/i.test(text)) {
		return "model_not_found";
	}
	if (
		/\b(5\d\d|408)\b|timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|unavailable|overloaded|fetch failed/i.test(
			text,
		)
	) {
		return "unavailable";
	}
	if (/\b400\b|bad request|invalid request/i.test(text)) {
		return "invalid_request";
	}
	return "unknown";
}

/**
 * The shared message for a failure known only by its text, when that text
 * reads as a provider failure: a cause it names, or the provider's URL or a
 * key fragment in it. Null otherwise, for an engine whose failures are not
 * all the provider's, so its own wording stays.
 */
export function providerFailureMessageFromText(text: string): string | null {
	const cause = providerFailureCauseFromText(text);
	if (cause !== "unknown") {
		return PROVIDER_FAILURE_MESSAGES[cause];
	}
	return /https?:\/\/|\bsk-|\*{4}/.test(text)
		? PROVIDER_FAILURE_MESSAGES.unknown
		: null;
}
