/**
 * Output-encoding + redirect-safety helpers for the GitHub OAuth callback page
 * (SOC 2 CC6.1). The callback reflects provider-supplied values
 * (`error_description`, `returnUrl`) into an HTML page with an inline
 * `<script>`, so every dynamic value must be escaped for its context and the
 * redirect target constrained to a same-origin path.
 */

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
 * absolute URLs, protocol-relative "//host", AND backslash variants "/\host"
 * / "/\/host" — browsers normalize "\" to "/", so those resolve to a foreign
 * origin just like "//host" (open-redirect / JS injection). Falls back to the
 * integrations settings page.
 */
export function sanitizeReturnUrl(returnUrl: unknown): string {
	const fallback = "/app/settings/integrations";
	if (typeof returnUrl !== "string") {
		return fallback;
	}
	// Require a single leading "/" NOT followed by "/" or "\".
	if (!returnUrl.startsWith("/") || /^\/[/\\]/.test(returnUrl)) {
		return fallback;
	}
	return returnUrl;
}
