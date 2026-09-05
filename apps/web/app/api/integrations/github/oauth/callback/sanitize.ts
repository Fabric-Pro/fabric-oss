/**
 * Output-encoding + redirect-safety helpers for the GitHub OAuth callback page
 * (SOC 2 CC6.1). The callback reflects provider-supplied values
 * (`error_description`, `returnUrl`) into an HTML page with an inline
 * `<script>`, so every dynamic value must be escaped for its context and the
 * redirect target constrained to a same-origin path. The two generic OAuth
 * callback routes (`/api/integrations/oauth/callback` and
 * `/api/integrations/[provider]/oauth/callback`) share these helpers.
 */

import { safeRelativePath } from "@shared/lib/safe-redirect";

/** Escape a value for safe interpolation into HTML text/attribute context. */
export function htmlEscape(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/**
 * Encode a value as a JS string literal for safe embedding inside an inline
 * `<script>`. JSON.stringify handles quoting/escaping; additionally escape "<"
 * so a "</script>" sequence in the data cannot break out of the script element.
 */
export function jsString(value: string): string {
	return JSON.stringify(value).replace(/</g, "\\u003c");
}

/**
 * The post-OAuth redirect target must be a SAME-ORIGIN relative path. Reject
 * absolute URLs, protocol-relative "//host", backslash variants "/\host" /
 * "/\/host" (browsers normalize "\" to "/"), and anything carrying an ASCII
 * control character — the URL parser strips tab/LF/CR before interpreting
 * the rest, so "/\t/host" resolves exactly like "//host". Falls back to the
 * integrations settings page.
 *
 * Delegates to the shared `safeRelativePath` so every post-redirect check in
 * the app applies one rule; this wrapper only adds the fallback. Every caller
 * of the OAuth `start` procedures therefore sends `pathname + search + hash`,
 * never `window.location.href` — an absolute URL is rejected here even when
 * it is same-origin (Fizzy #2370).
 */
export function sanitizeReturnUrl(returnUrl: unknown): string {
	const fallback = "/app/settings/integrations";
	if (typeof returnUrl !== "string") {
		return fallback;
	}
	return safeRelativePath(returnUrl) ?? fallback;
}

/**
 * Append `query` (already-encoded `k=v&k2=v2`) to a path, keeping any `#fragment`
 * at the end where the browser expects it. The callback pages append
 * `oauth=…&provider=…` to the sanitized return path; when that path carries a
 * fragment (`/app/projects/1?tab=x#repos`), appending after it would bury the
 * parameters inside the fragment and the landing page's return banner would
 * never see them.
 */
export function appendQuery(path: string, query: string): string {
	const hashIndex = path.indexOf("#");
	const base = hashIndex === -1 ? path : path.slice(0, hashIndex);
	const fragment = hashIndex === -1 ? "" : path.slice(hashIndex);
	return `${base}${base.includes("?") ? "&" : "?"}${query}${fragment}`;
}
