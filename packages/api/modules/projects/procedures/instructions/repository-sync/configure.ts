import { ORPCError } from "@orpc/client";
import { verifyRepositoryBranch } from "@repo/connectors";
import {
	getProjectRepoIntegration,
	upsertInstructionRepositorySync,
} from "@repo/database";
import { validateRelativePath } from "@repo/instructions";
import { resolveFreshRepoTokenForRow } from "@repo/integrations/repo-auth";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { requireHostingOrganizationId } from "../hosting-organization";

/** Empty (the repository root) or a validated relative path; trailing slashes stripped. */
function normalizeRootPath(raw: string): string | null {
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
 * set `refreshFault` on an `unauthorized` branch check means the caller is
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

/**
 * AUTHORIZATION: tenantProtectedProcedure + requireProjectPermission(INSTRUCTION_CREATE).
 *
 * Points the project's coding instructions at a branch and optional folder
 * of one of its repository integrations (design 2026-09-23 §5.1). The caller
 * becomes the delegate automatic runs act as; the generation is bumped so
 * any in-flight run is fenced; the project flips to REPOSITORY. Does not
 * start a run: the client calls `syncNow` after this.
 */
export const configureRepositorySyncProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.INSTRUCTION_CREATE))
	.route({
		method: "PUT",
		path: "/projects/:projectId/instructions/repository-sync",
		tags: ["Projects", "Instructions"],
		summary: "Configure coding-instructions repository sync",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			repositoryIntegrationId: z.string().min(1),
			ref: z
				.string()
				.trim()
				.min(1)
				.max(255)
				// The same conservative git-ref subset as update-branch.ts; the
				// authoritative check is the remote lookup in the handler.
				.regex(
					// biome-ignore lint/suspicious/noControlCharactersInRegex: the class deliberately REJECTS control characters in branch names before the value reaches any URL.
					/^(?!\/)(?!.*\.\.)(?!.*[\s~^:?*[\\])(?!.*\/\/)[^\x00-\x1f]+(?<!\/)(?<!\.lock)$/,
				)
				.refine(
					(ref) => !ref.startsWith("refs/"),
					"Use the branch name without refs/",
				),
			rootPath: z.string().max(512),
			automatic: z.boolean().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = await requireHostingOrganizationId(
			input.projectId,
			context.user.id,
		);
		const rootPath = normalizeRootPath(input.rootPath);
		if (rootPath === null) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"The folder must be a relative path inside the repository.",
				data: { code: "INVALID_ROOT_PATH" },
			});
		}
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
			{ userId: context.user.id, organizationId },
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
		const { token } = resolved;
		const outcome = await verifyRepositoryBranch({
			provider: integration.provider,
			token,
			repositoryUrl: integration.repositoryUrl,
			owner: integration.repositoryOwner,
			repo: integration.repositoryName,
			azureOrganization: integration.azureOrganization,
			...(integration.provider === "GITLAB" &&
			integration.authMethod === "PAT"
				? { gitlabAuth: "private-token" as const }
				: {}),
			branch: input.ref,
		});
		if (outcome === "not-found") {
			throw new ORPCError("BAD_REQUEST", {
				message: `Branch "${input.ref}" wasn't found on the remote.`,
				data: { code: "BRANCH_NOT_FOUND" },
			});
		}
		if (outcome === "unauthorized") {
			// A refresh fault means the token we just sent is the stale stored
			// one after WE failed to refresh it — the remote's rejection is not
			// evidence the customer's grant is dead. Reserve the expired-
			// credentials prompt for a refresh-fault-free rejection.
			if (resolved.refreshFault) {
				throw repositoryUnreachable(
					"Couldn't verify the repository's credentials. Try again.",
				);
			}
			throw credentialsExpired();
		}
		if (outcome === "unreachable") {
			throw repositoryUnreachable(
				"Couldn't reach the repository to check the branch. Try again.",
			);
		}
		const written = await upsertInstructionRepositorySync({
			projectId: input.projectId,
			organizationId,
			userId: context.user.id,
			repositoryIntegrationId: integration.id,
			ref: input.ref,
			rootPath,
			...(input.automatic === undefined
				? {}
				: { automatic: input.automatic }),
		});
		if (!written) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}
		recordAuditFromRequest(context, {
			action: "project.instructions.repository_sync_configured",
			category: "project",
			organizationId,
			projectId: input.projectId,
			resource: {
				type: "project_instruction_repository_sync",
				id: written.sync.id,
				name: `${integration.repositoryOwner}/${integration.repositoryName}`,
			},
			metadata: {
				provider: integration.provider,
				automatic: written.sync.automatic,
				refChanged: written.previous
					? written.previous.ref !== written.sync.ref
					: true,
				rootPathChanged: written.previous
					? written.previous.rootPath !== written.sync.rootPath
					: true,
				generation: written.sync.generation,
			},
		});
		return { syncId: written.sync.id, generation: written.sync.generation };
	});
