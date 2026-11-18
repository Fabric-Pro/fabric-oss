import {
	getBlockedOutboundReason,
	getUnsafeUrlReason,
	PINNED_FETCH_ANY_CONTENT_TYPE,
	PINNED_FETCH_DEFAULT_MAX_REDIRECTS,
	safeFetchOutbound,
	safeFetchOutboundPinned,
	UnsafeOutboundUrlError,
	withoutCrossOriginCredentials,
} from "@repo/utils/url-security";

const PROVIDER_GET_TIMEOUT_MS = 120_000;

export class StepRedirectRefusedError extends Error {}

export class StepDestinationNotAllowedError extends Error {
	constructor(message = "Request blocked: destination is not allowed.") {
		super(message);
	}
}

function providerHttpsUrl(input: string, base?: URL): URL {
	const url = URL.parse(input, base);
	if (url?.protocol !== "https:") {
		throw new StepDestinationNotAllowedError(
			"Request blocked: destination is not allowed. Use an https address.",
		);
	}
	return url;
}

function isRedirect(response: Response): boolean {
	return [301, 302, 303, 307, 308].includes(response.status);
}

export async function fetchProviderStepOutbound(
	url: string,
	init: RequestInit,
): Promise<Response> {
	const destination = providerHttpsUrl(url);
	if ((init.method ?? "GET") !== "GET") {
		return fetchStepOutbound(url, init);
	}

	// Validate HTTPS on each hop before letting the pinned guard send it.
	const timeout = AbortSignal.timeout(PROVIDER_GET_TIMEOUT_MS);
	const signal = init.signal
		? AbortSignal.any([init.signal, timeout])
		: timeout;
	let current = destination;
	let headers = init.headers;
	for (let hop = 0; ; hop++) {
		let response: Response;
		try {
			response = await safeFetchOutboundPinned(
				current,
				{ ...init, headers, signal },
				{
					followRedirects: false,
					timeoutMs: PROVIDER_GET_TIMEOUT_MS,
					allowedContentTypes: [PINNED_FETCH_ANY_CONTENT_TYPE],
				},
			);
		} catch (error) {
			if (error instanceof UnsafeOutboundUrlError) {
				// The pinned resolver carries DNS lookup failures as the cause.
				if (error.cause !== undefined) {
					throw error.cause;
				}
				throw new StepDestinationNotAllowedError();
			}
			throw error;
		}
		if (!isRedirect(response)) {
			return response;
		}
		const location = response.headers.get("location");
		if (!location) {
			throw new StepRedirectRefusedError(
				"Request failed: the server responded with a redirect without a Location header.",
			);
		}
		if (hop === PINNED_FETCH_DEFAULT_MAX_REDIRECTS) {
			throw new StepRedirectRefusedError(
				"Request failed: the server returned too many redirects.",
			);
		}
		const next = providerHttpsUrl(location, current);
		if (next.origin !== current.origin) {
			headers = withoutCrossOriginCredentials(headers);
		}
		current = next;
	}
}

export async function fetchStepOutbound(
	url: string,
	init?: RequestInit,
): Promise<Response> {
	if (getUnsafeUrlReason(url)) {
		throw new StepDestinationNotAllowedError();
	}
	let response: Response;
	try {
		// A manual response distinguishes a redirect from a transport failure.
		response = await safeFetchOutbound(url, {
			...init,
			redirect: "manual",
		});
	} catch (error) {
		if (getBlockedOutboundReason(error)) {
			throw new StepDestinationNotAllowedError();
		}
		throw error;
	}
	if (isRedirect(response)) {
		await response.body?.cancel().catch(() => undefined);
		throw new StepRedirectRefusedError(
			"Request failed: the server responded with a redirect, and redirects are not followed.",
		);
	}
	return response;
}
