/**
 * A GitHub token a person pastes into a repository form, saved in the
 * credential manager instead of a legacy token column (ADR-026, spec
 * 2026-11-04 §4.3).
 *
 * The caller has already validated the token against the repository and
 * resolved the actor (`resolveCredentialActor`, which refuses while the
 * credential manager is off). This reads the account the token acts as and
 * either names the caller's own saved token for that account, so no
 * duplicate is created, or saves a new private `PAT` credential.
 */

import { ORPCError } from "@orpc/server";
import {
	type CredentialActor,
	type CredentialMetadata,
	createCredential,
	db,
	findOwnPatCredentialForAccount,
	recordAuditTx,
} from "@repo/database";
import { z } from "zod";
import { credentialAuditMetadata } from "./context";
import { checkGitHubTokenForSave } from "./github-token-check";
import { DEFAULT_PROVIDER_ORIGIN } from "./schemas";

/** What the form sends beside the token when it should be saved. */
export const saveCredentialInputSchema = z.object({
	/** Empty: `GitHub token · <login>`. */
	label: z.string().trim().max(120).optional(),
	/** Save a second credential even when one exists for this account. */
	saveAsNew: z.boolean().default(false),
	/** The person confirmed a fine-grained token's repository permissions. */
	confirmFineGrainedPermissions: z.boolean().default(false),
});

/** The saved credential a client may see: never the secret. */
export const pastedTokenCredentialSchema = z.object({
	id: z.string(),
	label: z.string(),
	externalAccountLogin: z.string().nullable(),
});

function defaultGitHubTokenLabel(login: string): string {
	return `GitHub token · ${login}`;
}

export type PastedTokenOutcome =
	| { outcome: "existing"; credential: CredentialMetadata }
	| { outcome: "created"; credential: CredentialMetadata };

export function toPastedTokenCredential(credential: CredentialMetadata) {
	return {
		id: credential.id,
		label: credential.label,
		externalAccountLogin: credential.externalAccountLogin,
	};
}

export async function savePastedGitHubToken(input: {
	actor: CredentialActor;
	user: { id: string; email?: string | null; name?: string | null };
	token: string;
	label?: string;
	saveAsNew: boolean;
	confirmFineGrainedPermissions?: boolean;
}): Promise<PastedTokenOutcome> {
	// The same check as the credential manager's own form: a rejected token,
	// a classic token short of a scope, or an unconfirmed fine-grained token
	// is refused here.
	const account = await checkGitHubTokenForSave({
		token: input.token,
		confirmFineGrainedPermissions:
			input.confirmFineGrainedPermissions ?? false,
	});
	if (!account) {
		throw new ORPCError("BAD_REQUEST", {
			message:
				"GitHub did not say which account this token belongs to, so it cannot be saved. Clear “Save in the credential manager” to use it for this repository only.",
		});
	}

	if (!input.saveAsNew) {
		const existing = await findOwnPatCredentialForAccount({
			organizationId: input.actor.organizationId,
			userId: input.actor.userId,
			provider: "GITHUB",
			externalAccountId: account.id,
		});
		if (existing) {
			return { outcome: "existing", credential: existing };
		}
	}

	const label = input.label?.trim() || defaultGitHubTokenLabel(account.login);
	const credential = await db.$transaction(async (tx) => {
		const created = await createCredential(
			{
				organizationId: input.actor.organizationId,
				userId: input.actor.userId,
				sharing: "PRIVATE",
				provider: "GITHUB",
				kind: "PAT",
				principal: "USER",
				label,
				origin: DEFAULT_PROVIDER_ORIGIN.GITHUB as string,
				externalAccountId: account.id,
				externalAccountLogin: account.login,
				scopes: account.scopes,
				// The shape `resolveCredential` reads.
				secret: { token: input.token },
				createdByUserId: input.user.id,
			},
			tx,
		);
		await recordAuditTx(tx, {
			action: "account.credential.created",
			actor: {
				type: "user",
				userId: input.user.id,
				emailSnapshot: input.user.email,
				nameSnapshot: input.user.name,
			},
			organizationId: input.actor.organizationId,
			resource: {
				type: "credential",
				id: created.id,
				name: created.label,
			},
			metadata: credentialAuditMetadata(created, { source: "pasted" }),
		});
		return created;
	});
	return { outcome: "created", credential };
}
