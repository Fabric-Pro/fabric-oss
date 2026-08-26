/**
 * The sensitive-key denylist, shared by every redactor in the codebase.
 *
 * This list lives in `@repo/utils` — the lowest layer — precisely so there is
 * ONE of it. It was originally private to the audit-log redactor; the
 * bug-analysis log redactor (Fizzy #1234) needs the same denylist for the
 * structured `properties` bag on a log entry, and two copies of a security
 * list drift.
 *
 * Match is on the KEY, lowercased, by SUBSTRING. A non-sensitive key whose
 * VALUE looks like a secret is preserved — value-shaped redaction is a
 * separate concern and lives in `./log-redaction` for free-text log content.
 */

/**
 * Substrings that mark a key's value as sensitive. Any key CONTAINING one of
 * these (case-insensitive) has its value redacted.
 *
 * Adding an entry requires no migration — every redactor runs at write time.
 */
export const SENSITIVE_KEY_SUBSTRINGS = [
	"password",
	"passwd",
	"pass",
	"token",
	"accesstoken",
	"refreshtoken",
	"idtoken",
	"bearer",
	"apikey",
	"api_key",
	"secret",
	"clientsecret",
	"cookie",
	"authorization",
	"pin",
	"cvv",
	"ssn",
	// Closes the denylist gaps called out in the SOC 2 code audit (CC7.2).
	// `credential`/`signature` are broad on purpose — over-redacting a
	// non-secret `credentialId` or `emailSignature` in audit METADATA is the
	// safe failure mode. `private` is scoped to key material (`privateKey`,
	// `private_key`) rather than the bare word so ordinary `isPrivate` flags
	// stay legible in the trail. `otp` covers TOTP/HOTP/OTP seeds.
	"credential",
	"privatekey",
	"private_key",
	"otp",
	"salt",
	"signature",
	// A Teams/Zoom join URL is a meeting capability URL, not merely a
	// pointer — anyone holding it can join. #1899's personal-meetings
	// procedures are already hardcoded into the audit-error middleware's
	// ALWAYS_SKIP_PATHS so their rows never land at all, but this belt-
	// and-braces entry protects any OTHER procedure that ever takes a
	// `joinUrl` from writing it into audit metadata unredacted.
	"joinurl",
] as const;

/** The literal every redactor substitutes for a redacted value. */
export const REDACTED = "[REDACTED]" as const;

/** True when a key's value must be redacted. Case-insensitive substring match. */
export function keyIsSensitive(key: string): boolean {
	const lower = key.toLowerCase();
	for (const needle of SENSITIVE_KEY_SUBSTRINGS) {
		if (lower.includes(needle)) {
			return true;
		}
	}
	return false;
}
