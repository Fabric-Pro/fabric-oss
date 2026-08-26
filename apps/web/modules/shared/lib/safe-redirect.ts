/**
 * Same-origin relative-path validator for post-verification redirects.
 *
 * The email-verification flow chains two redirects (ConfirmEmailForm →
 * EmailVerificationRedirect → final destination), each reading a URL param
 * crafted by the email link. Without consistent validation an attacker can
 * craft `/auth/confirm-email?callbackURL=/auth/email-verified%3FredirectTo%3Dhttps://evil.com`
 * — the outer callbackURL passes a "relative path" check while the inner
 * redirectTo is an external URL. Apply this helper at every hop.
 *
 * Accepts: paths that start with a single `/` followed by a non-`/`, non-`\`
 * character, AND that still resolve to their own origin once a URL parser has
 * had them. Rejects protocol-relative URLs (`//evil.com`), backslash variants
 * (`/\evil.com`), anything that doesn't start with `/`, and anything carrying
 * an ASCII control character.
 *
 * The control-character rule is not defensive tidying — it closes a real
 * bypass. WHATWG URL parsing STRIPS ASCII tab, newline and carriage return
 * from a URL before interpreting the rest, so `"/\t/evil.example"` parses
 * exactly as `"//evil.example"` does: a protocol-relative URL pointing at
 * another host. Every prefix check below passes it, because the second
 * character really is a tab and not a slash. Anything that then hands the
 * value to `router.replace()`, `location.assign()` or an `href` navigates
 * off-origin.
 *
 * Resolving against a base is the backstop for that whole class of trick: it
 * is what the consumer's own navigation will do, so it is the one check that
 * cannot be out-argued by a parsing quirk. The base is a fixed opaque origin
 * rather than `window.location`, so the helper behaves identically on the
 * server — these components render in both places, and the only question
 * being asked is whether the value ESCAPES its base, which does not depend on
 * which base it is.
 *
 * Returns the caller's own string on success rather than the parser's
 * normalized form, so accepted values pass through byte-for-byte.
 */

/**
 * True when `value` contains an ASCII C0 control character or DEL.
 *
 * Tab (09), LF (0A) and CR (0D) are the three the URL parser removes outright;
 * the rest are rejected alongside them rather than reasoned about
 * individually. Written as a code-point scan rather than a regex because a
 * character class of literal control characters is itself a lint hazard, and
 * the intent reads more plainly this way.
 */
function hasControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code < 0x20 || code === 0x7f) {
			return true;
		}
	}
	return false;
}

/**
 * Any absolute origin works; the comparison only asks whether `raw` escaped
 * it. `.invalid` is reserved by RFC 2606, so this can never collide with a
 * real deployment origin.
 */
const RESOLUTION_BASE = "https://relative.invalid";

export function safeRelativePath(raw: string | null): string | null {
	if (!raw) {
		return null;
	}
	if (hasControlCharacter(raw)) {
		return null;
	}
	if (!raw.startsWith("/")) {
		return null;
	}
	if (raw.startsWith("//") || raw.startsWith("/\\")) {
		return null;
	}
	let resolved: URL;
	try {
		resolved = new URL(raw, RESOLUTION_BASE);
	} catch {
		return null;
	}
	if (resolved.origin !== RESOLUTION_BASE) {
		return null;
	}
	return raw;
}
