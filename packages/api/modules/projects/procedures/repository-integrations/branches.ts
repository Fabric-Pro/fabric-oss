/**
 * `projects.repositoryIntegrations.branches` — a connected repository's own
 * default branch, as its provider reports it now, plus the names of its
 * branches, so a dialog that asks for a branch can seed it from the
 * repository instead of a stale stored value or an invented "main", and can
 * offer the real branches to pick from.
 *
 * READ ONLY. The answer never rewrites `ProjectRepositoryIntegration
 * .defaultBranch`: a stored branch may have been chosen on purpose (see
 * `update-branch.ts`), and a branch a person chose is never changed behind
 * their back. Callers use `defaultBranch` only where nothing was chosen yet.
 *
 * Authorization, in order: `projectNotFoundUnlessVisible` (the
 * `hasProjectAccess` "may you discover" predicate, so an org-role member
 * with no tie to the project hears NOT_FOUND), then PROJECT_SETTINGS_READ,
 * then the hosting organization resolved server-side; any `organizationId`
 * in the input is refused by the permission gate when it is not the host's.
 * The integration is loaded bound to the project and its credential is
 * resolved exactly as the repository-sync listings resolve it (including a
 * bound `credentialId`), and a failed read throws their error codes:
 * `REPOSITORY_NOT_FOUND`, `REPOSITORY_UNAVAILABLE`,
 * `REPOSITORY_CREDENTIALS_EXPIRED`, `REPOSITORY_UNREACHABLE`.
 *
 * `defaultBranch` is `null` when the provider listed the branches but would
 * not name its default; the caller then falls back to what it already has.
 * `truncated` is true when the listing reached the connectors bound, so the
 * picker says the list may be incomplete and still lets a name be typed.
 *
 * Not audited: it returns branch names, not content, and writes nothing.
 * Not cached: every call reads the provider live.
 */
import { ORPCError } from "@orpc/client";
import {
	fetchProviderDefaultBranch,
	listRepositoryBranches,
} from "@repo/connectors";
import { z } from "zod";
import { resolveEffectiveProjectPermissions } from "../../../../lib/effective-project-permissions";
import { projectNotFoundUnlessVisible } from "../../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	loadInstructionSyncIntegration,
	repositoryReadError,
	resolveInstructionSyncCredential,
} from "../instructions/repository-sync/repository";

/** The connectors listing stops at this many names (`MAX_BRANCHES`). */
const REPOSITORY_BRANCH_LIST_LIMIT = 300;

export interface RepositoryIntegrationBranches {
	defaultBranch: string | null;
	branches: string[];
	truncated: boolean;
}

/**
 * AUTHORIZATION: tenantProtectedProcedure + projectNotFoundUnlessVisible +
 * requireProjectPermission(PROJECT_SETTINGS_READ).
 */
export const listRepoIntegrationBranchesProcedure = tenantProtectedProcedure
	// Visibility before permission: see the file comment.
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/repository-integrations/:repositoryIntegrationId/branches",
		tags: ["Projects", "Repository Integrations"],
		summary:
			"List a connected repository's branches and its provider default branch",
	})
	.input(
		z.object({
			projectId: z.string().min(1),
			organizationId: z.string().nullable().optional(),
			repositoryIntegrationId: z.string().min(1),
		}),
	)
	.handler(
		async ({ input, context }): Promise<RepositoryIntegrationBranches> => {
			// The project's own organization, never the session's.
			const access = await resolveEffectiveProjectPermissions(
				input.projectId,
				context.user.id,
			);
			const organizationId = access?.organizationId ?? null;
			if (!organizationId) {
				throw new ORPCError("FORBIDDEN", {
					message:
						"Repository branches require an organization project",
				});
			}

			const integration = await loadInstructionSyncIntegration({
				repositoryIntegrationId: input.repositoryIntegrationId,
				projectId: input.projectId,
			});
			const { token, refreshFault } =
				await resolveInstructionSyncCredential(integration, {
					userId: context.user.id,
					organizationId,
				});
			const target = {
				provider: integration.provider,
				token,
				repositoryUrl: integration.repositoryUrl,
				owner: integration.repositoryOwner,
				repo: integration.repositoryName,
				azureOrganization: integration.azureOrganization,
				// GitLab PATs authenticate with PRIVATE-TOKEN; Azure DevOps
				// OAuth tokens with Bearer (PATs with Basic, the default).
				...(integration.provider === "GITLAB" &&
				integration.authMethod === "PAT"
					? { gitlabAuth: "private-token" as const }
					: {}),
				...(integration.provider === "AZURE_DEVOPS" &&
				integration.authMethod !== "PAT"
					? { azureDevOpsAuth: "bearer" as const }
					: {}),
			};

			const [listing, defaultBranch] = await Promise.all([
				listRepositoryBranches(target),
				fetchProviderDefaultBranch(target),
			]);
			if (!listing.ok) {
				// A listing names no branch, so "not-found" (the repository
				// itself is gone or hidden) is not BRANCH_NOT_FOUND; it reads
				// as unreachable, like any outcome other than a rejection.
				throw repositoryReadError(
					listing.outcome === "unauthorized"
						? "unauthorized"
						: "unreachable",
					{
						ref: integration.defaultBranch,
						refreshFault,
						unreachableMessage:
							"Couldn't reach the repository to list its branches. Try again.",
					},
				);
			}

			const branches = [
				...new Set(listing.branches.map((branch) => branch.name)),
			];
			return {
				defaultBranch,
				branches,
				truncated:
					listing.branches.length >= REPOSITORY_BRANCH_LIST_LIMIT,
			};
		},
	);
