/**
 * Lazy account backfill for a list (e.g. project members' GitHub logins):
 * reads the stored token of each credential that names no account and
 * records it (`account.ts`). Best effort, bounded, one organization.
 */

import { readCredentialSecret } from "@repo/database";
import { needsAccountBackfill, recordMissingAccount } from "./account";
import { getCredentialAdapter } from "./resolve";

/** Credentials one backfill call reads at most. */
export const MAX_ACCOUNT_BACKFILLS = 50;

function tokenOf(secret: Record<string, unknown>): string | null {
	const token = secret.accessToken ?? secret.token;
	return typeof token === "string" && token.length > 0 ? token : null;
}

/**
 * Backfills the accounts of up to `MAX_ACCOUNT_BACKFILLS` credentials of one
 * organization. Rows of another organization are never read: every read
 * names `organizationId`. Answers the logins recorded, by credential id.
 */
export async function backfillCredentialAccounts(input: {
	organizationId: string;
	credentialIds: readonly string[];
}): Promise<Map<string, string>> {
	const ids = [...new Set(input.credentialIds)].slice(
		0,
		MAX_ACCOUNT_BACKFILLS,
	);
	const recorded = new Map<string, string>();
	await Promise.all(
		ids.map(async (id) => {
			try {
				const stored = await readCredentialSecret({
					id,
					organizationId: input.organizationId,
				});
				if (
					!stored?.secret ||
					!needsAccountBackfill(stored.credential)
				) {
					return;
				}
				const token = tokenOf(stored.secret);
				if (!token) {
					return;
				}
				const readAccount = getCredentialAdapter(
					stored.credential.provider,
				)?.readAccount;
				if (!readAccount) {
					return;
				}
				const login = await recordMissingAccount({
					credential: stored.credential,
					token,
					readAccount,
				});
				if (login) {
					recorded.set(id, login);
				}
			} catch {
				// Best effort: the row stays as it was and is tried next time.
			}
		}),
	);
	return recorded;
}
