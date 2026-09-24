/**
 * `projects.contexts.repositorySync.configure` — point the project's Living
 * Memory at selected folders and files of a branch in one of its connected
 * repositories (design 2026-09-23 §5.1, Fizzy #2657).
 *
 * Authorization, in order: `projectNotFoundUnlessVisible`, then
 * CONTEXT_CREATE, then the hosting organization resolved server-side
 * (`resolveContextSyncAccess`); any `organizationId` in the input is ignored.
 *
 * Every check that reaches the network or the credential happens here,
 * OUTSIDE any transaction: the integration belongs to this project and is
 * ACTIVE, the branch name passes the conservative git-ref subset and then
 * exists on the remote (through the integration's own, freshly resolved
 * credential), and the paths are canonical (`./paths`). Only then does
 * `upsertContextRepositorySync` run its one transaction under the
 * configuration lock, which re-checks the integration and refuses a
 * repository change while the sync still manages rows. The caller becomes
 * the member runs act as, the generation is bumped so an in-flight run is
 * fenced, and no run is started: the client calls `syncNow` after this.
 */
import { ORPCError } from "@orpc/client";
import { verifyRepositoryBranch } from "@repo/connectors";
import {
	getProjectRepoIntegration,
	upsertContextRepositorySync,
} from "@repo/database";
import { resolveFreshRepoTokenForRow } from "@repo/integrations/repo-auth";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../../lib/audit";
import { projectNotFoundUnlessVisible } from "../../../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { resolveContextSyncAccess } from "./access";
import { canonicalizeContextSyncPaths } from "./paths";

function credentialsExpired(): ORPCError<string, unknown> {
	return new ORPCError("BAD_REQUEST", {
		message:
			"Repository credentials have expired — reconnect the repository to sync from it.",
		data: { code: "REPOSITORY_CREDENTIALS_EXPIRED" },
	});
}

/**
 * A platform-side fault resolving or verifying the credential — never the
 * customer's grant, so never "reconnect the repository": a decryption
 * failure (`credentialFault: "DECRYPT_FAILED"`), or an `unauthorized` branch
 * check made with the stale stored token after a refresh WE could not
 * perform (`refreshFault`). Both read as the same unreachable repository an
 * ordinary network failure does.
 */
function repositoryUnreachable(message: string): ORPCError<string, unknown> {
	return new ORPCError("INTERNAL_SERVER_ERROR", {
		message,
		data: { code: "REPOSITORY_UNREACHABLE" },
	});
}

function repositoryUnavailable(): ORPCError<string, unknown> {
	return new ORPCError("BAD_REQUEST", {
		message:
			"This repository connection needs attention before it can be synced from.",
		data: { code: "REPOSITORY_UNAVAILABLE" },
	});
}

function samePaths(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((path, i) => path === b[i]);
}

export const configureContextRepositorySyncProcedure = tenantProtectedProcedure
	// Visibility before permission: see the file comment.
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.CONTEXT_CREATE))
	.route({
		method: "PUT",
		path: "/projects/:projectId/contexts/repository-sync",
		tags: ["Projects", "Contexts"],
		summary: "Configure the Living Memory repository sync",
	})
	.input(
		z.object({
			projectId: z.string().min(1).max(128),
			organizationId: z.string().nullable().optional(),
			repositoryIntegrationId: z.string().min(1).max(128),
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
			// Bounded here only to keep an unbounded list out of the handler;
			// the at-most-50 rule is applied after duplicates are dropped.
			paths: z.array(z.string().max(1024)).min(1).max(200),
		}),
	)
	.handler(async ({ input, context }) => {
		const { organizationId } = await resolveContextSyncAccess(
			input.projectId,
			context.user.id,
			Permissions.CONTEXT_CREATE,
		);

		const canonical = canonicalizeContextSyncPaths(input.paths);
		if (!canonical.ok) {
			throw new ORPCError("BAD_REQUEST", {
				message: canonical.message,
				data:
					"path" in canonical
						? { code: canonical.code, path: canonical.path }
						: { code: canonical.code },
			});
		}
		const { paths } = canonical;

		// Bound to THIS project before any credential column is read: an
		// integration of another project is not found, whatever its id.
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
			// "ABSENT" (no ciphertext) is the customer's to fix;
			// "DECRYPT_FAILED" (ciphertext present, decryption threw) never is.
			if (resolved.credentialFault === "DECRYPT_FAILED") {
				throw repositoryUnreachable(
					"Couldn't resolve the repository's stored credentials. Try again.",
				);
			}
			throw credentialsExpired();
		}
		const outcome = await verifyRepositoryBranch({
			provider: integration.provider,
			token: resolved.token,
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
			// A refresh fault means the token just sent is the stale stored one
			// after WE failed to refresh it: the remote's rejection says nothing
			// about the customer's grant.
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

		const written = await upsertContextRepositorySync({
			projectId: input.projectId,
			organizationId,
			userId: context.user.id,
			repositoryIntegrationId: integration.id,
			ref: input.ref,
			paths,
		});
		if (written.status === "integration-unavailable") {
			throw repositoryUnavailable();
		}
		if (written.status === "repository-change-requires-disconnect") {
			throw new ORPCError("BAD_REQUEST", {
				message: `This project's Living Memory still has ${written.managedCount} file${written.managedCount === 1 ? "" : "s"} synced from another repository. Disconnect that sync first to change the repository.`,
				data: {
					code: "REPOSITORY_CHANGE_REQUIRES_DISCONNECT",
					managedCount: written.managedCount,
				},
			});
		}

		recordAuditFromRequest(context, {
			action: "project.context.repository_sync_configured",
			category: "project",
			organizationId,
			projectId: input.projectId,
			resource: {
				type: "project_context_repository_sync",
				id: written.sync.id,
				name: `${integration.repositoryOwner}/${integration.repositoryName}`,
			},
			metadata: {
				provider: integration.provider,
				pathCount: written.sync.paths.length,
				refChanged: written.previous
					? written.previous.ref !== written.sync.ref
					: true,
				pathsChanged: written.previous
					? !samePaths(written.previous.paths, written.sync.paths)
					: true,
				generation: written.sync.generation,
			},
		});
		return { syncId: written.sync.id, generation: written.sync.generation };
	});
