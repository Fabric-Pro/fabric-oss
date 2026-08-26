/**
 * Redact credentials from a third-party response body before it is stored,
 * logged, shown to a user, or sent to a model.
 *
 * A provider's error body is not ours and is not trustworthy. A self-managed
 * GitLab, a corporate proxy or a misconfigured gateway will happily echo the
 * request's own `PRIVATE-TOKEN` / `Authorization` header back inside a verbose
 * error page, and that page is the most useful thing we can quote to a user —
 * so we do quote it, scrubbed.
 *
 * This lives in `@repo/utils` because both directions need it and they sit in
 * different packages: the results-FETCH path (`@repo/temporal`) and the
 * pipeline-TRIGGER path (`@repo/integrations`). It was previously implemented
 * only on the fetch side, which is precisely how the trigger side came to quote
 * unredacted bodies into a message rendered in the browser.
 *
 * Pure string work, no Node built-ins, so it is safe to reach from a client
 * bundle as well.
 */

/** Longest quoted body we keep. Long enough to diagnose, short enough to read. */
export const MAX_SCRUBBED_BODY_CHARS = 300;

/**
 * Replace known secrets and credential-shaped patterns with `[REDACTED]`.
 *
 * `secrets` are the literal values we sent — the token actually used for the
 * call. They are replaced longest-first so a token that contains a shorter one
 * as a substring cannot leave a fragment behind. Values under 6 characters are
 * skipped: they match too much ordinary prose to be worth redacting, and a
 * secret that short is not a secret.
 *
 * The pattern rules catch what the literals cannot — a credential the provider
 * invented, rotated, or reflected in a different encoding.
 */
export function scrubSecrets(
	body: string,
	secrets: readonly string[] = [],
): string {
	let scrubbed = body;
	for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
		if (secret.length >= 6) {
			scrubbed = scrubbed.replaceAll(secret, "[REDACTED]");
		}
	}
	return (
		scrubbed
			.replace(
				/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,
				"$1 [REDACTED]",
			)
			.replace(
				/((?:private-token|authorization|x-api-key|api-key)\s*[:=]\s*["']?)[^"',}\s]+/gi,
				"$1[REDACTED]",
			)
			.replace(
				/(["']?(?:access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret|secret|pat)["']?\s*[:=]\s*["'])[^"']+/gi,
				"$1[REDACTED]",
			)
			// URL userinfo — `postgresql://user:password@host`. None of the rules
			// above match it, because the credential is positional rather than
			// named. This is the single most likely secret to appear in a test
			// failure: a connection error prints the whole DSN, and a Prisma /
			// node-postgres / redis / mongo exception all do exactly that.
			//
			// Only the PASSWORD is replaced. The scheme, user and host are what
			// make the error diagnosable, and none of them is the secret.
			.replace(
				/([a-z][a-z0-9+.\-]*:\/\/[^\s/:@]+:)[^\s/@]+(@)/gi,
				"$1[REDACTED]$2",
			)
	);
}

/**
 * {@link scrubSecrets}, then collapse whitespace and cap the length.
 *
 * Scrubbing happens BEFORE truncation deliberately: truncating first can cut a
 * credential in half and leave the first half in the output, which reads as
 * redacted and is not.
 */
export function scrubAndTrim(
	body: string,
	secrets: readonly string[] = [],
	maxChars: number = MAX_SCRUBBED_BODY_CHARS,
): string {
	const collapsed = scrubSecrets(body, secrets).replace(/\s+/g, " ").trim();
	return collapsed.length > maxChars
		? `${collapsed.slice(0, maxChars)}…`
		: collapsed;
}
