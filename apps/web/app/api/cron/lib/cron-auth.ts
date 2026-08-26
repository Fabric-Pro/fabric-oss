/**
 * Auth gate and configuration contract for the Vercel-scheduled cron routes in
 * `apps/web/vercel.json`.
 *
 * `Authorization: Bearer ${CRON_SECRET}` is the only accepted credential.
 * Vercel Cron sends that header automatically once `CRON_SECRET` is configured
 * for the environment, and manual ops invocations can send it too.
 *
 * There is deliberately no fallback for a missing secret. An earlier revision
 * accepted the `vercel-cron` User-Agent whenever `CRON_SECRET` was unset, to
 * keep scheduled work running through that misconfiguration rather than 401ing
 * every tick in silence (issue #2331) — at the cost of leaving both cron routes
 * open to anyone who set the header, since a User-Agent is a client-controlled,
 * spoofable scheduling hint and not authentication. That included
 * `fail-stuck-pm-sync`, which re-enqueues Temporal workflows that write into
 * externally connected project-management tools. Keeping a background job
 * available does not justify an unauthenticated write path (issue #2883).
 *
 * Removing the fallback reinstates the risk it was added for, so the
 * misconfiguration is now caught earlier and louder instead:
 * `describeMissingCronSecret` below is reported at server startup by
 * `apps/web/instrumentation.ts`, before the first scheduled tick, rather than
 * once per rejected request.
 */

/**
 * Matches a character that cannot be carried verbatim in an HTTP header field
 * value, so a secret containing one could never be matched by the header Vercel
 * Cron sends for it. Permits printable ASCII plus the high byte range; rejects
 * the C0 controls, DEL, and anything above U+00FF.
 *
 * Probed against this runtime: `Headers` hard-rejects NUL, LF, CR, and any code
 * point above U+00FF (an emoji or a Cyrillic letter throws outright, since a
 * field value is a byte string). The remaining C0 controls and DEL are accepted
 * locally but forbidden in a field value by HTTP, so an intermediary may strip or
 * mangle them instead of failing cleanly — the silent direction — and they are
 * rejected here too. No realistic secret (base64, hex, alphanumeric) contains any
 * of this, so the strictness costs nothing.
 *
 * The newline case is not theoretical: `openssl rand -base64 64` wraps its
 * output, so pasting one in yields a secret with an interior line break.
 */
const HEADER_UNSAFE = /[^\u0020-\u007e\u0080-\u00ff]/;

/**
 * The usable cron secret, or `null` when this environment has none.
 *
 * A value padded with leading or trailing whitespace is rejected rather than
 * canonicalized; whitespace-only and header-unsafe values are rejected for the
 * same underlying reason. Vercel Cron builds the header as `Bearer ` plus the
 * configured value verbatim, and HTTP strips only the whitespace at the *edges*
 * of the finished header value — interior whitespace survives. So `CRON_SECRET="  padded  "` arrives as
 * `"Bearer   padded"`, which no canonical form of the secret matches: trimming
 * it here would have the gate expect `"Bearer padded"` and reject Vercel's own
 * request, while the startup check reported the deployment healthy. That is the
 * silent-dead-cron state this module exists to prevent, so a padded value is
 * treated as a misconfiguration to report, not a value to repair.
 *
 * Both the gate and the startup diagnostic read the secret through here so the
 * two can never disagree about what "configured" means.
 */
export function readCronSecret(): string | null {
	const raw = process.env.CRON_SECRET;
	if (!raw || raw !== raw.trim() || HEADER_UNSAFE.test(raw)) {
		return null;
	}
	return raw;
}

export function isCronRequestAuthorized(request: Request): boolean {
	const secret = readCronSecret();

	// No usable secret: the routes are closed to everyone, scheduled ticks
	// included. Vercel Cron cannot send a bearer token that does not exist.
	if (!secret) {
		return false;
	}

	return request.headers.get("authorization") === `Bearer ${secret}`;
}

/**
 * Describes a deployment that cannot run its cron schedule because
 * `CRON_SECRET` is missing or unusable, or `null` when there is nothing to
 * report.
 *
 * Scoped to `VERCEL_ENV=production` because Vercel triggers cron jobs against a
 * project's production deployment only — note that this covers a separate
 * staging *project*, whose own production deployment also reports
 * `VERCEL_ENV=production`. Preview deployments are never invoked on a schedule,
 * and non-Vercel targets (the Docker/Azure build) have no cron trigger at all,
 * so a missing secret there closes two endpoints nothing calls rather than
 * breaking a schedule.
 *
 * Returns a message instead of logging so the caller owns the severity, in the
 * shape of `describeEncryptionKeyMisconfiguration` in `@repo/utils`.
 */
export function describeMissingCronSecret(): string | null {
	if (process.env.VERCEL_ENV !== "production") {
		return null;
	}
	if (readCronSecret()) {
		return null;
	}
	return "CRON_SECRET is unset or unusable for this production deployment (a value with surrounding whitespace, a control character, or a character above U+00FF is rejected, because the header Vercel Cron sends for it could never match). Every scheduled tick for the cron routes in apps/web/vercel.json will be rejected with 401 and those jobs will not run. Set CRON_SECRET to a single-line, printable-ASCII value with no surrounding whitespace in this project's production environment.";
}
