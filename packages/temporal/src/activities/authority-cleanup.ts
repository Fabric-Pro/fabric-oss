/**
 * Authority Session Cleanup Activity
 *
 * Expires authority sessions and grants that have passed their TTL.
 * Called periodically by the authorityCleanupWorkflow.
 */

import { expireAuthoritySessions } from "@repo/database";

/**
 * Expire all authority sessions and grants that have passed their expiresAt.
 * Returns counts of expired items for logging.
 */
export async function expireAuthoritySessionsActivity(): Promise<{
	expiredSessions: number;
	expiredGrants: number;
}> {
	console.log("[AuthorityCleanup] Running authority expiration...");

	const result = await expireAuthoritySessions();

	if (result.expiredSessions > 0 || result.expiredGrants > 0) {
		console.log(
			`[AuthorityCleanup] Expired ${result.expiredSessions} sessions, ${result.expiredGrants} grants`,
		);
	}

	return result;
}
