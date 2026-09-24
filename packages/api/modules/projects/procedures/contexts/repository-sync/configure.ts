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
 *
 * `automatic` (design §11.1, Fizzy #2673) turns the shared poll and push
 * webhook on or off for this sync; omitted, the stored value is kept (off on
 * the first configure). Every configure also resets the automatic schedule,
 * as the coding-instructions configure does.
 */
import { ORPCError } from "@orpc/client";
import { verifyRepositoryBranch } from "@repo/connectors";
import { upsertContextRepositorySync } from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../../lib/audit";
import { projectNotFoundUnlessVisible } from "../../../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { resolveContextSyncAccess } from "./access";
import {
	canonicalizeContextSyncPaths,
	MAX_CONTEXT_SYNC_PATH_LENGTH,
} from "./paths";
import {
	contextSyncRefSchema,
	loadContextSyncIntegration,
	repositoryReadError,
	repositoryUnavailable,
	resolveContextSyncCredential,
} from "./repository";

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
			ref: contextSyncRefSchema,
			// Bounded here only to keep an unbounded list out of the handler;
			// the at-most-50 rule is applied after duplicates are dropped.
			paths: z
				.array(z.string().max(MAX_CONTEXT_SYNC_PATH_LENGTH))
				.min(1)
				.max(200),
			automatic: z.boolean().optional(),
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

		const integration = await loadContextSyncIntegration({
			repositoryIntegrationId: input.repositoryIntegrationId,
			projectId: input.projectId,
		});
		const { token, refreshFault } = await resolveContextSyncCredential(
			integration,
			{ userId: context.user.id, organizationId },
		);
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
		if (outcome !== "exists") {
			throw repositoryReadError(outcome, {
				ref: input.ref,
				refreshFault,
				unreachableMessage:
					"Couldn't reach the repository to check the branch. Try again.",
			});
		}

		const written = await upsertContextRepositorySync({
			projectId: input.projectId,
			organizationId,
			userId: context.user.id,
			repositoryIntegrationId: integration.id,
			ref: input.ref,
			paths,
			...(input.automatic === undefined
				? {}
				: { automatic: input.automatic }),
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
				automatic: written.sync.automatic,
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
