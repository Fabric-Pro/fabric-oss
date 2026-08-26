/**
 * Builds the link that actually goes out in a verification email.
 *
 * Better Auth hands our `sendVerificationEmail` /
 * `sendChangeEmailConfirmation` callbacks a URL pointing straight at its own
 * API route (`${baseURL}/verify-email?token=…&callbackURL=…`). We rewrite it
 * to the app's `/auth/confirm-email` page instead, so a human sees a real page
 * — and, critically, so the token is only spent when they click Confirm rather
 * than when a mail scanner prefetches the link.
 *
 * Extracted from `auth.ts` (rather than left inline next to the Better Auth
 * options) so the URL shapes below are unit-testable without booting Better
 * Auth, matching `./audit-events.ts` and `./two-factor-challenge.ts`. Both
 * functions are pure: the app origin and the default landing path are passed
 * in rather than read from config.
 *
 * The destination survives two nested hops, each re-validated by
 * `safeRelativePath` on the way out (see
 * apps/web/modules/saas/auth/lib/safe-redirect.ts):
 *
 *   /auth/confirm-email?token=…&callbackURL=
 *       /auth/email-verified?redirectTo=
 *           /organization-invitation/<id>
 */

/**
 * The `callbackURL` carried by a confirm-email link: the post-verification
 * landing page, with the caller's final destination nested inside it.
 *
 * Returns a RELATIVE path, and that is load-bearing rather than cosmetic. The
 * only reader of this value is `ConfirmEmailForm`, which runs it through
 * `safeRelativePath()` — a helper that rejects anything not starting with a
 * single `/`. Returning an absolute URL here therefore made the whole param
 * evaluate to `null` at that hop, silently dropping every nested destination
 * (invitation deep links included) and landing verified users on the generic
 * post-login page instead. Nothing downstream wants the absolute form: this
 * value never reaches Better Auth, because `ConfirmEmailForm` calls
 * `verifyEmail({ query: { token } })` without a `callbackURL`, so it is never
 * origin-checked and never becomes an HTTP `Location`.
 *
 * `appUrl` is still required — `new URL()` needs a base to resolve against —
 * it just does not survive into the result.
 */
function buildEmailVerificationCallbackUrl(
	redirectTo: string,
	{ appUrl }: { appUrl: string },
): string {
	const callbackUrl = new URL("/auth/email-verified", appUrl);
	callbackUrl.searchParams.set("redirectTo", redirectTo);
	return `${callbackUrl.pathname}${callbackUrl.search}${callbackUrl.hash}`;
}

export interface EmailVerificationCallbackOptions {
	/** Absolute origin the app is served from (Better Auth's `baseURL`). */
	appUrl: string;
	/** Where a verified user lands when the link carries no destination. */
	defaultRedirect: string;
}

/**
 * Rewrite one of Better Auth's `/verify-email` API links into a link to the
 * app's confirm-email page, preserving whatever destination the original
 * carried.
 *
 * A `callbackURL` of `"/"` is treated as "no destination given": Better Auth
 * substitutes that literal itself when a caller passes none
 * (`sendVerificationEmailFn` in `dist/api/routes/email-verification.mjs`), so
 * it cannot be told apart from an explicit request for the site root.
 */
export function withEmailVerificationCallback(
	url: string,
	{ appUrl, defaultRedirect }: EmailVerificationCallbackOptions,
): string {
	const verificationUrl = new URL(url);
	const currentCallback =
		verificationUrl.searchParams.get("callbackURL") || defaultRedirect;
	const normalizedRedirect =
		currentCallback === "/" ? defaultRedirect : currentCallback;

	verificationUrl.pathname = "/auth/confirm-email";
	verificationUrl.searchParams.set(
		"callbackURL",
		buildEmailVerificationCallbackUrl(normalizedRedirect, { appUrl }),
	);

	return verificationUrl.toString();
}
