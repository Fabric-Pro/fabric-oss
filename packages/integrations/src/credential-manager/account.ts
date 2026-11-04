/**
 * Fills in the provider account of a credential saved without one: a token
 * saved while the provider could not be reached, or one saved before Fabric
 * read accounts at all (ADR-026).
 *
 * The account is read once with the stored token and recorded with a narrow,
 * generation-fenced write that never touches the secret
 * (`recordCredentialAccountIfGeneration`). Best effort throughout: nothing
 * here ever fails the caller, and a token is never logged.
 */

import {
	type CredentialMetadata,
	recordCredentialAccountIfGeneration,
} from "@repo/database";
import type { CredentialAdapter } from "./resolve";

/** Whether the row should be asked who it acts as. */
export function needsAccountBackfill(
	credential: Pick<
		CredentialMetadata,
		"kind" | "externalAccountLogin" | "status"
	>,
): boolean {
	return (
		credential.kind !== "APP_INSTALLATION" &&
		credential.externalAccountLogin === null &&
		credential.status !== "REVOKED"
	);
}

/**
 * Reads and records the account of one credential, with the token the
 * caller already holds. Answers the login recorded, or null.
 */
export async function recordMissingAccount(input: {
	credential: CredentialMetadata;
	token: string;
	readAccount: NonNullable<CredentialAdapter["readAccount"]>;
}): Promise<string | null> {
	const { credential } = input;
	if (!needsAccountBackfill(credential)) {
		return null;
	}
	try {
		const account = await input.readAccount({
			credential,
			token: input.token,
		});
		if (!account) {
			return null;
		}
		const written = await recordCredentialAccountIfGeneration({
			id: credential.id,
			organizationId: credential.organizationId,
			generation: credential.generation,
			externalAccountId: account.id,
			externalAccountLogin: account.login,
			scopes: account.scopes,
		});
		return written ? account.login : null;
	} catch {
		// Unreachable provider or a lost race: tried again on the next use.
		return null;
	}
}
