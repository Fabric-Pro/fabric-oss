/**
 * Redaction of request URLs before they reach span attributes.
 *
 * `@opentelemetry/instrumentation-undici` up to 0.35.0 (GHSA-hgpx-52j8-8gq2)
 * copies every outgoing `fetch()` URL verbatim into `url.full` and
 * `url.query`, so presigned-URL signatures (`sig`, `X-Amz-Signature`, …) and
 * URL credentials are exported to the tracing backend. The fixed 0.35.1
 * needs the OpenTelemetry 3.x SDK, so until that migration the undici
 * instrumentation's `startSpanHook` overwrites those attributes with the
 * values below.
 *
 * Allowlist shape: every query value is replaced, whatever its key, and a key
 * survives only when it is made of plain unreserved characters. Userinfo and
 * the fragment are always dropped. Anything that does not parse becomes a
 * fixed placeholder rather than passing through.
 */

export const REDACTED = "REDACTED";
export const UNPARSEABLE_URL = "REDACTED_UNPARSEABLE_URL";

// Plain key characters only; anything else (percent-encoding, `+`, `=`) could
// smuggle a value inside the key, so such a key is replaced too.
const SAFE_QUERY_KEY = /^[A-Za-z0-9._~[\]-]{1,128}$/;

/**
 * Redact a URL search string (`?a=1&b=2`, or `a=1&b=2`). Returns `""` for an
 * empty query and keeps the leading `?` when the input has one.
 */
export function redactQuery(search: string): string {
	const hasMark = search.startsWith("?");
	const raw = hasMark ? search.slice(1) : search;
	const parts: string[] = [];
	for (const part of raw.split("&")) {
		if (part === "") {
			continue;
		}
		const separator = part.indexOf("=");
		if (separator === -1) {
			// A bare token has no key; treat the whole token as a value.
			parts.push(REDACTED);
			continue;
		}
		const key = part.slice(0, separator);
		parts.push(`${SAFE_QUERY_KEY.test(key) ? key : REDACTED}=${REDACTED}`);
	}
	const redacted = parts.join("&");
	return hasMark && redacted !== "" ? `?${redacted}` : redacted;
}

/** Redact query values, userinfo and fragment from an absolute URL. */
export function redactUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return UNPARSEABLE_URL;
	}
	url.username = "";
	url.password = "";
	url.hash = "";
	const search = url.search;
	// Assigning `search` re-encodes it; build the string instead so the
	// redacted keys stay exactly as sent.
	url.search = "";
	return url.toString() + redactQuery(search);
}

/** The subset of undici's request object the hook reads. */
interface UndiciRequestLike {
	origin?: unknown;
	path?: unknown;
}

/**
 * `startSpanHook` for `@opentelemetry/instrumentation-undici`. 0.33.0 builds
 * the URL as `new URL(request.path, request.origin)` and applies these
 * attributes over its own before starting the span.
 */
export function undiciRedactedUrlAttributes(
	request: UndiciRequestLike,
): Record<string, string> {
	let url: URL;
	try {
		url = new URL(String(request.path), String(request.origin));
	} catch {
		return { "url.full": UNPARSEABLE_URL, "url.query": UNPARSEABLE_URL };
	}
	return {
		"url.full": redactUrl(url.toString()),
		"url.query": redactQuery(url.search),
	};
}
