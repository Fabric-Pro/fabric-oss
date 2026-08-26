/**
 * The single writer behind `resolveGitLabSource`'s `markRefreshFailure`.
 *
 * Every caller that passes a `refresh` closure must also pass one of these.
 * A caller that forgets it degrades to REST on a dead grant but persists
 * NOTHING, so the very next request refreshes the same dead token again —
 * the retry storm reported in issue #2795. Four call sites had drifted into
 * two byte-identical inline copies and two silent omissions, which is why
 * this lives in one place now.
 *
 * What it writes, and why the split matters:
 *
 *   - `lastRefreshFailedAt` / `lastRefreshError` / `refreshFailureCount` are
 *     recorded on EVERY failure. They are diagnostics ONLY — this writer
 *     updates the MCPConfig row directly and never calls
 *     `recordRefreshFailure`, so no threshold is evaluated here and repeated
 *     transient failures never escalate to `needsReauth` on their own.
 *     Losing that telemetry would hide a recurring problem.
 *
 *   - `needsReauth` is set ONLY when `reauthRequired` is true, i.e. the
 *     provider positively rejected the grant (`GitLabReauthRequiredError`,
 *     raised for `invalid_grant` / `invalid_token`). That column is a
 *     circuit breaker and it is ENFORCED downstream — a flagged config is
 *     refused at MCP client creation, filtered out of tool discovery and
 *     blocked from refreshing — and nothing but a fresh OAuth grant
 *     performed by the USER clears it. Flipping it on a transient network
 *     blip therefore hard-blocks a working integration until the user
 *     manually reconnects. On a real revocation it is what surfaces the
 *     Settings reconnect banner instead of degrading to REST forever with
 *     no prompt.
 *
 * The key is omitted entirely (rather than written as `false`) on the
 * transient path so a later diagnostic write can't clear a flag an earlier
 * real revocation set.
 *
 * The `needsReauth` write is additionally CONDITIONAL on the row still
 * holding the refresh token the rejection was about — see
 * `expectedRefreshToken` below. The callback's argument type enforces that
 * pairing: `reauthRequired` may only be set alongside a non-null ciphertext,
 * so a condemnation with no row version to bind to does not typecheck. The
 * runtime branch for one survives anyway, for untyped callers and the same
 * reason `recordRefreshFailure` keeps its own: dropping the strike would fail
 * open into the retry storm.
 *
 * EVERY write here is a conditional `updateMany` gated on `needsReauth:
 * false`, condemning and diagnostics-only alike. Omitting the column keeps a
 * write from CLEARING the flag; the predicate keeps it from landing on a row
 * some better-evidenced failure condemned between our evidence and our write,
 * where it would inflate the counter and overwrite the diagnostics of the
 * failure that actually tripped the breaker — the two things triage reads. A
 * zero match is therefore the expected outcome of that race, not an error.
 * `recordRefreshFailure` in `@repo/database` follows the same rule for the
 * generic providers.
 */

import type { ResolveGitLabSourceOpts } from "./source";

/** The callback shape `resolveGitLabSource` expects. */
export type GitLabRefreshFailureWriter =
	ResolveGitLabSourceOpts["markRefreshFailure"];

/**
 * Narrow accessor over the MCPConfig row. Production call sites pass the
 * Prisma client (`db as never`) — the same convention the neighbouring
 * resolver arguments use.
 */
export interface GitLabRefreshFailureDb {
	mCPConfig: {
		/**
		 * The only accessor exposed, deliberately: `update` cannot express the
		 * `needsReauth: false` guard every write here needs, and a row that
		 * fails the guard must be left alone rather than written to anyway.
		 * `needsReauth` is required in the predicate for the same reason —
		 * an unguarded write should not typecheck.
		 */
		updateMany: (args: {
			where: {
				id: string;
				needsReauth: boolean;
				encryptedRefreshToken?: string;
			};
			data: Record<string, unknown>;
		}) => Promise<{ count: number }>;
	};
}

/** Maximum characters of provider error text persisted to the row. */
const MAX_RECORDED_ERROR_LENGTH = 500;

export function createGitLabRefreshFailureWriter(
	db: GitLabRefreshFailureDb,
): GitLabRefreshFailureWriter {
	return async ({
		mcpConfigId,
		error,
		reauthRequired,
		expectedRefreshToken,
	}) => {
		const diagnostics = {
			lastRefreshFailedAt: new Date(),
			// Truncate to avoid blowing up the column on multi-KB stack
			// traces / verbose provider errors.
			lastRefreshError: error.slice(0, MAX_RECORDED_ERROR_LENGTH),
			refreshFailureCount: { increment: 1 },
		};

		if (reauthRequired && expectedRefreshToken) {
			// Optimistic concurrency: condemn only while the row still holds
			// the refresh token GitLab rejected. GitLab rotates on every
			// exchange, so a parallel refresh can persist a live replacement
			// between the classification upstream and this write — an
			// unconditional update would then hard-block a working credential
			// on evidence about a token that no longer exists.
			//
			// The version token is the CIPHERTEXT. Upstream rotation checks
			// compare DECRYPTED values because `encryptApiKey` is
			// non-deterministic and re-encrypting the same plaintext would
			// look like a rotation; here the question is only "is this still
			// the row version I read", which the stored ciphertext answers
			// exactly. A no-op re-encrypt therefore blocks the condemnation —
			// the fail-safe direction.
			//
			// `needsReauth: false` guards the same write on the other axis: a
			// row already condemned carries the diagnostics of the failure
			// that tripped it, and re-condemning would replace them with a
			// later racer's while double-counting the strike.
			const condemned = await db.mCPConfig.updateMany({
				where: {
					id: mcpConfigId,
					encryptedRefreshToken: expectedRefreshToken,
					needsReauth: false,
				},
				data: { ...diagnostics, needsReauth: true },
			});
			if (condemned.count > 0) {
				return;
			}
			// Zero matches means the row moved on under us — it rotated its
			// refresh token, or a concurrent failure condemned it first. The
			// diagnostics-only write tells the two apart: gated on the breaker
			// alone, it lands for a rotation and declines for a condemnation.
			const recorded = await db.mCPConfig.updateMany({
				where: { id: mcpConfigId, needsReauth: false },
				data: diagnostics,
			});
			if (recorded.count > 0) {
				// A rotation. Losing telemetry is worse than recording it
				// against a rotated row, and `needsReauth` stays absent (not
				// `false`) so this can't clear a flag some better-evidenced
				// failure set. `console.error` because most log shippers drop
				// warn-level by default.
				console.error(
					"[gitlab-source] refresh rejection would have condemned a config whose refresh token has since been rotated — recording the failure only",
					{ mcpConfigId },
				);
			}
			// The other branch — condemned by a better-evidenced failure — is
			// the guard working as intended, so it is not logged as a failure.
			return;
		}

		if (reauthRequired) {
			// A rejection with no version token to bind to. No longer
			// reachable through the typed signature — `reauthRequired` must
			// travel with the `expectedRefreshToken` it is bound to — and the
			// `@ts-expect-error` in `refresh-failure-writer.test.ts` fails the
			// build if that constraint is ever relaxed. Kept for untyped
			// callers, because dropping the strike would fail open into the
			// retry storm this whole path exists to stop. Still gated on the
			// breaker, because a row condemned under us is already behind it —
			// declining costs nothing and preserves the diagnostics of the
			// failure that tripped it.
			await db.mCPConfig.updateMany({
				where: { id: mcpConfigId, needsReauth: false },
				data: { ...diagnostics, needsReauth: true },
			});
			return;
		}

		// Diagnostics only, so `needsReauth` is absent rather than `false` —
		// see the header. The predicate is the breaker rather than the token:
		// a transient failure is no evidence about any particular row version,
		// but it must still decline against a row condemned since we read it.
		await db.mCPConfig.updateMany({
			where: { id: mcpConfigId, needsReauth: false },
			data: diagnostics,
		});
	};
}
