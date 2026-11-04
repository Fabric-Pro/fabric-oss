/**
 * A credential-manager credential, resolved as the caller and probed against
 * one repository before anything binds it (ADR-026). Shared by choosing a
 * credential for a connected repository (`setCredential`) and by connecting
 * a new repository with a saved one (`connect`).
 */

import { ORPCError } from "@orpc/client";
import { verifyRepositoryAccess } from "@repo/connectors";
import type { CredentialActor } from "@repo/database";
import {
	type ResolvedCredential,
	resolveCredential,
} from "@repo/integrations/credential-manager";
import { REPOSITORY_CREDENTIAL_KINDS } from "@repo/integrations/repo-auth";

const ACCESS_MESSAGES: Record<string, string> = {
	unauthorized:
		"The provider rejected this credential. Choose another one or reconnect it in the credential manager.",
	forbidden:
		"This credential cannot read the repository. Grant it access to the repository, or choose another one.",
	"not-found":
		"This credential cannot see the repository. Grant it access to the repository, or choose another one.",
	unreachable: "The provider could not be reached. Try again in a moment.",
};

export async function resolveSavedCredentialForRepository(input: {
	credentialId: string;
	actor: CredentialActor;
	provider: "GITHUB" | "GITLAB";
	repositoryUrl: string;
	owner: string;
	repo: string;
}): Promise<ResolvedCredential> {
	const resolved = await resolveCredential({
		credentialId: input.credentialId,
		actor: { type: "user", ...input.actor },
		requirement: {
			provider: input.provider,
			kinds: REPOSITORY_CREDENTIAL_KINDS,
		},
	});
	if (!resolved.ok) {
		throw new ORPCError("BAD_REQUEST", {
			message:
				resolved.failure.code === "needs-reauth"
					? "This credential needs to be reconnected in the credential manager."
					: "This credential cannot be used for this repository.",
		});
	}
	const access = await verifyRepositoryAccess({
		provider: input.provider,
		token: resolved.value.token,
		repositoryUrl: input.repositoryUrl,
		owner: input.owner,
		repo: input.repo,
		gitlabAuth:
			resolved.value.credential.kind === "PAT"
				? "private-token"
				: "bearer",
	});
	if (access.outcome !== "accessible") {
		throw new ORPCError("BAD_REQUEST", {
			message:
				ACCESS_MESSAGES[access.outcome] ??
				"This credential cannot read the repository.",
		});
	}
	return resolved.value;
}
