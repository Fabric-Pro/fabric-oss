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
 * credential), and the paths — and the left-out paths, when given — are
 * canonical (`./paths`). Only then does
 * `upsertContextRepositorySync` run its one transaction under the
 * configuration lock, which re-checks the integration and refuses a
 * repository change while the sync still manages rows. The caller becomes
 * the member runs act as, and no run is started: the client calls `syncNow`
 * after this.
 *
 * `automatic` (design §11.1, Fizzy #2673) turns the shared poll and push
 * webhook on or off for this sync; omitted, the stored value is kept (off on
 * the first configure). Every configure clears a pause and makes the sync
 * due now.
 *
 * `excludedPaths` (Fizzy #2750 §5.3) is what the member left out inside a
 * selected folder. Omitted on the first configure, none; omitted on a later
 * one, the stored list is KEPT — resolved by the query under its lock — so
 * a client that does not send it (the "Automatic sync" toggle, "Re-enable")
 * can never erase it; `[]` clears it. When new paths no longer contain a
 * kept left-out path, the configure is refused `EXCLUDED_PATHS_STALE`
 * (reload and choose again) rather than dropping exclusions nobody saw.
 *
 * Only a change to what is synced — the repository, the branch, the paths
 * or the left-out paths — bumps the generation (fencing an in-flight run)
 * and clears the last applied run and the rest of the automatic schedule.
 * The "Automatic sync" toggle and "Re-enable" send the stored repository,
 * branch and paths, so they keep both, and a run already open finishes
 * normally (Fizzy #2713). The query decides which under its lock. Either is
 * audited as `project.context.repository_sync_configured`; the `*Changed`
 * flags say which it was, and `excludedPathCount` how many paths are left
 * out — never the paths themselves.
 *
 * Refusals are `BAD_REQUEST` with `data.code` (and `data.path` naming the
 * offending path where there is one): for `paths`, `INVALID_PATH`,
 * `EXCLUDED_PATH`, `TOO_MANY_PATHS`, `PATH_PREFIX_OVERLAP`; for
 * `excludedPaths`, `INVALID_PATH`, `EXCLUDED_PATH`,
 * `EXCLUDED_PATH_POLICY_FILE`, `TOO_MANY_EXCLUDED_PATHS`,
 * `EXCLUDED_PATH_OUTSIDE_SELECTION`, `EXCLUDED_PATH_OVERLAP` (with
 * `data.withPath`, the left-out path it is inside) and
 * `EXCLUDED_PATHS_STALE`.
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
	canonicalizeContextSyncExcludedPaths,
	canonicalizeContextSyncPaths,
	MAX_CONTEXT_SYNC_EXCLUDED_PATHS_INPUT,
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
			// Omitted: keep the stored list (see the file comment). Bounded
			// here only to keep an unbounded list out of the handler; the
			// at-most-200 rule is applied after duplicates are dropped.
			excludedPaths: z
				.array(z.string().max(MAX_CONTEXT_SYNC_PATH_LENGTH))
				.max(MAX_CONTEXT_SYNC_EXCLUDED_PATHS_INPUT)
				.optional(),
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

		let excludedPaths: string[] | undefined;
		if (input.excludedPaths !== undefined) {
			const excluded = canonicalizeContextSyncExcludedPaths(
				input.excludedPaths,
				paths,
			);
			if (!excluded.ok) {
				const { ok: _ok, message, ...data } = excluded;
				throw new ORPCError("BAD_REQUEST", { message, data });
			}
			excludedPaths = excluded.excludedPaths;
		}

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
			// Omitted, the stored list is kept: the key is not sent at all.
			...(excludedPaths === undefined ? {} : { excludedPaths }),
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
		if (written.status === "excluded-paths-stale") {
			// The paths changed and the caller did not say what to leave out;
			// the stored list no longer fits them (Fizzy #2750 §5.3).
			throw new ORPCError("BAD_REQUEST", {
				message:
					"The paths left out of this sync no longer fit the selection. Reload and choose again.",
				data: { code: "EXCLUDED_PATHS_STALE" },
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
				excludedPathCount: written.sync.excludedPaths.length,
				repositoryChanged: written.previous
					? written.previous.repositoryIntegrationId !==
						written.sync.repositoryIntegrationId
					: true,
				refChanged: written.previous
					? written.previous.ref !== written.sync.ref
					: true,
				pathsChanged: written.previous
					? !samePaths(written.previous.paths, written.sync.paths)
					: true,
				excludedPathsChanged: written.previous
					? !samePaths(
							written.previous.excludedPaths,
							written.sync.excludedPaths,
						)
					: true,
				generation: written.sync.generation,
			},
		});
		return { syncId: written.sync.id, generation: written.sync.generation };
	});
