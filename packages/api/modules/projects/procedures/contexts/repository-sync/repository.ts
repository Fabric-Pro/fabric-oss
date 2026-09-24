/**
 * The repository a Living Memory repository-sync procedure reads through,
 * shared by `configure` (the branch check) and `listTree` (the tree read) so
 * both refuse on the same terms and in the same words (design 2026-09-23
 * §5.1, Fizzy #2674).
 *
 * The integration is loaded bound to the project (another project's
 * integration is not found, whatever its id) and must be ACTIVE
 * (`loadContextSyncIntegration`). Its credential is resolved fresh in a
 * separate step (`resolveContextSyncCredential`), so a caller can answer
 * from the integration alone before any token work. A credential fault is
 * either the customer's to fix (`REPOSITORY_CREDENTIALS_EXPIRED`,
 * reconnect) or ours (`REPOSITORY_UNREACHABLE`, try again) — never the one
 * read as the other. No error carries the token.
 */
import { ORPCError } from "@orpc/client";
import { getProjectRepoIntegration } from "@repo/database";
import { resolveFreshRepoTokenForRow } from "@repo/integrations/repo-auth";
import { z } from "zod";

/**
 * A branch name: the same conservative git-ref subset as update-branch.ts;
 * the authoritative check is the remote lookup in the handler.
 */
export const contextSyncRefSchema = z
	.string()
	.trim()
	.min(1)
	.max(255)
	.regex(
		// biome-ignore lint/suspicious/noControlCharactersInRegex: the class deliberately REJECTS control characters in branch names before the value reaches any URL.
		/^(?!\/)(?!.*\.\.)(?!.*[\s~^:?*[\\])(?!.*\/\/)[^\x00-\x1f]+(?<!\/)(?<!\.lock)$/,
	)
	.refine(
		(ref) => !ref.startsWith("refs/"),
		"Use the branch name without refs/",
	);

function credentialsExpired(): ORPCError<string, unknown> {
	return new ORPCError("BAD_REQUEST", {
		message:
			"Repository credentials have expired — reconnect the repository to sync from it.",
		data: { code: "REPOSITORY_CREDENTIALS_EXPIRED" },
	});
}

/**
 * A platform-side fault resolving or using the credential — never the
 * customer's grant, so never "reconnect the repository": a decryption
 * failure (`credentialFault: "DECRYPT_FAILED"`), or an `unauthorized`
 * answer to a request made with the stale stored token after a refresh WE
 * could not perform (`refreshFault`). Both read as the same unreachable
 * repository an ordinary network failure does.
 */
function repositoryUnreachable(message: string): ORPCError<string, unknown> {
	return new ORPCError("INTERNAL_SERVER_ERROR", {
		message,
		data: { code: "REPOSITORY_UNREACHABLE" },
	});
}

export function repositoryUnavailable(): ORPCError<string, unknown> {
	return new ORPCError("BAD_REQUEST", {
		message:
			"This repository connection needs attention before it can be synced from.",
		data: { code: "REPOSITORY_UNAVAILABLE" },
	});
}

type ResolvedToken = Awaited<ReturnType<typeof resolveFreshRepoTokenForRow>>;

type ContextSyncIntegration = NonNullable<
	Awaited<ReturnType<typeof getProjectRepoIntegration>>
>;

/**
 * The project's ACTIVE integration, or the refusal. Reads no credential:
 * a caller that can answer from the integration alone (`listTree`, for a
 * provider it cannot list) does so before `resolveContextSyncCredential`.
 * Reached only after the procedure's gate and `resolveContextSyncAccess`.
 */
export async function loadContextSyncIntegration(input: {
	repositoryIntegrationId: string;
	projectId: string;
}): Promise<ContextSyncIntegration> {
	// Bound to THIS project before any credential column is read.
	const integration = await getProjectRepoIntegration(
		input.repositoryIntegrationId,
		input.projectId,
	);
	if (!integration) {
		throw new ORPCError("NOT_FOUND", {
			message: "Repository integration not found",
			data: { code: "REPOSITORY_NOT_FOUND" },
		});
	}
	if (integration.status !== "ACTIVE") {
		throw repositoryUnavailable();
	}
	return integration;
}

/**
 * A usable token for an integration `loadContextSyncIntegration` returned,
 * or the refusal, with the organization `resolveContextSyncAccess` resolved.
 */
export async function resolveContextSyncCredential(
	integration: ContextSyncIntegration,
	actor: { userId: string; organizationId: string },
): Promise<{ token: string; refreshFault: ResolvedToken["refreshFault"] }> {
	const resolved = await resolveFreshRepoTokenForRow(
		{
			integrationId: integration.id,
			provider: integration.provider,
			authMethod: integration.authMethod,
			encryptedAccessToken: integration.encryptedAccessToken,
			encryptedRefreshToken: integration.encryptedRefreshToken,
			encryptedPat: integration.encryptedPat,
			tokenExpiresAt: integration.tokenExpiresAt,
			updatedAt: integration.updatedAt,
		},
		{ userId: actor.userId, organizationId: actor.organizationId },
	);
	if (!resolved.token) {
		// "ABSENT" (no ciphertext) is the customer's to fix;
		// "DECRYPT_FAILED" (ciphertext present, decryption threw) never is.
		if (resolved.credentialFault === "DECRYPT_FAILED") {
			throw repositoryUnreachable(
				"Couldn't resolve the repository's stored credentials. Try again.",
			);
		}
		throw credentialsExpired();
	}
	return { token: resolved.token, refreshFault: resolved.refreshFault };
}

/**
 * The error for a remote read that did not succeed, in the codes the
 * configure dialog already words: `BRANCH_NOT_FOUND`,
 * `REPOSITORY_CREDENTIALS_EXPIRED`, `REPOSITORY_UNREACHABLE`.
 */
export function repositoryReadError(
	outcome: "not-found" | "unauthorized" | "unreachable",
	options: {
		ref: string;
		refreshFault: ResolvedToken["refreshFault"];
		unreachableMessage: string;
	},
): ORPCError<string, unknown> {
	if (outcome === "not-found") {
		return new ORPCError("BAD_REQUEST", {
			message: `Branch "${options.ref}" wasn't found on the remote.`,
			data: { code: "BRANCH_NOT_FOUND" },
		});
	}
	if (outcome === "unauthorized") {
		// A refresh fault means the token just sent is the stale stored one
		// after WE failed to refresh it: the remote's rejection says nothing
		// about the customer's grant.
		if (options.refreshFault) {
			return repositoryUnreachable(
				"Couldn't verify the repository's credentials. Try again.",
			);
		}
		return credentialsExpired();
	}
	return repositoryUnreachable(options.unreachableMessage);
}
