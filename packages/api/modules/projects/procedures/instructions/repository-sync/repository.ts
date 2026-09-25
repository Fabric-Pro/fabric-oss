/**
 * The repository a coding-instructions repository-sync procedure reads
 * through, shared by `configure` (the branch check) and `listTree` (the tree
 * read, Fizzy #2725) so both refuse on the same terms and in the same words
 * (design 2026-09-23 §5.1).
 *
 * The integration is loaded bound to the project (another project's
 * integration is not found, whatever its id) and must be ACTIVE
 * (`loadInstructionSyncIntegration`). Its credential is resolved fresh in a
 * separate step (`resolveInstructionSyncCredential`), so a caller can answer
 * from the integration alone before any token work. A credential fault is
 * either the customer's to fix (`REPOSITORY_CREDENTIALS_EXPIRED`, reconnect)
 * or ours (`REPOSITORY_UNREACHABLE`, try again) — never the one read as the
 * other. No error carries the token.
 *
 * The folder rule (`normalizeRootPath`) lives here too, so the tree never
 * offers a folder `configure` would refuse.
 */
import { ORPCError } from "@orpc/client";
import { getProjectRepoIntegration } from "@repo/database";
import { validateRelativePath } from "@repo/instructions";
import { resolveFreshRepoTokenForRow } from "@repo/integrations/repo-auth";
import { z } from "zod";

/**
 * A branch name: the same conservative git-ref subset as update-branch.ts;
 * the authoritative check is the remote lookup in the handler.
 */
export const instructionSyncRefSchema = z
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

/** The longest `rootPath` `configure`'s input schema accepts. */
export const MAX_INSTRUCTION_SYNC_ROOT_PATH_LENGTH = 512;

/** Empty (the repository root) or a validated relative path; trailing slashes stripped. */
export function normalizeRootPath(raw: string): string | null {
	const trimmed = raw.trim().replace(/[/\\]+$/, "");
	if (trimmed === "") {
		return "";
	}
	const v = validateRelativePath(trimmed);
	return v.ok ? v.path : null;
}

function credentialsExpired(): ORPCError<string, unknown> {
	return new ORPCError("BAD_REQUEST", {
		message:
			"Repository credentials have expired — reconnect the repository to sync from it.",
		data: { code: "REPOSITORY_CREDENTIALS_EXPIRED" },
	});
}

/**
 * A platform-side fault resolving or verifying the credential — never the
 * customer's grant, so never "reconnect the repository". `credentialFault:
 * "DECRYPT_FAILED"` means a lost/rotated encryption key or corrupted
 * ciphertext (see `ResolvedRepoToken` in `@repo/integrations/repo-auth`); a
 * set `refreshFault` on an `unauthorized` remote answer means the caller is
 * being handed the stale stored token after a refresh WE could not perform
 * (no OAuth client credentials, a provider outage, our own error), so the
 * remote's 401 says nothing about the customer's grant. Both map to the same
 * `REPOSITORY_UNREACHABLE` an ordinary network failure gets, because from the
 * caller's side both ARE "we couldn't reach a verifiable credential".
 */
function repositoryUnreachable(message: string): ORPCError<string, unknown> {
	return new ORPCError("INTERNAL_SERVER_ERROR", {
		message,
		data: { code: "REPOSITORY_UNREACHABLE" },
	});
}

type ResolvedToken = Awaited<ReturnType<typeof resolveFreshRepoTokenForRow>>;

type InstructionSyncIntegration = NonNullable<
	Awaited<ReturnType<typeof getProjectRepoIntegration>>
>;

/**
 * The project's ACTIVE integration, or the refusal. Reads no credential: a
 * caller that can answer from the integration alone (`listTree`, for a
 * provider it cannot list) does so before `resolveInstructionSyncCredential`.
 * Reached only after the procedure's permission gate and the hosting
 * organization's resolution.
 */
export async function loadInstructionSyncIntegration(input: {
	repositoryIntegrationId: string;
	projectId: string;
}): Promise<InstructionSyncIntegration> {
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
		throw new ORPCError("BAD_REQUEST", {
			message:
				"This repository connection needs attention before it can be synced from.",
			data: { code: "REPOSITORY_UNAVAILABLE" },
		});
	}
	return integration;
}

/**
 * A usable token for an integration `loadInstructionSyncIntegration`
 * returned, or the refusal, acting in the hosting organization.
 */
export async function resolveInstructionSyncCredential(
	integration: InstructionSyncIntegration,
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
		// "ABSENT" (no ciphertext) is the customer's to fix; "DECRYPT_FAILED"
		// (ciphertext present, decryption threw) never is.
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
		// after WE failed to refresh it — the remote's rejection is not
		// evidence the customer's grant is dead. Reserve the expired-
		// credentials prompt for a refresh-fault-free rejection.
		if (options.refreshFault) {
			return repositoryUnreachable(
				"Couldn't verify the repository's credentials. Try again.",
			);
		}
		return credentialsExpired();
	}
	return repositoryUnreachable(options.unreachableMessage);
}
