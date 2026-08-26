/**
 * Update Repository Integration Branch
 *
 * Changes the monitored branch (`defaultBranch`) of a project-level repository
 * integration. PROJECT_ADMIN+ (via PROJECT_SETTINGS_EDIT). The branch is
 * verified to exist on the remote BEFORE anything is written, using the
 * project integration's stored credentials via the `@repo/connectors`
 * `verifyRepositoryBranch` request-path helper (keeps the handler thin per
 * `backend/api.md`). For an expired GitHub OAuth credential a forced refresh
 * (`ensureFreshRepoCredentials`) runs first so a lapsed token self-heals
 * instead of failing the save.
 *
 * Error contract (distinct, specific messages per `global/error-handling.md`;
 * `data.code` lets the client map without message sniffing):
 *  - branch missing on the remote → BAD_REQUEST  (BRANCH_NOT_FOUND)
 *  - credentials unusable         → BAD_REQUEST  (REPOSITORY_CREDENTIALS_EXPIRED)
 *  - remote unreachable           → INTERNAL_SERVER_ERROR (REPOSITORY_UNREACHABLE)
 */

import { ORPCError } from "@orpc/client";
import { ensureFreshRepoCredentials } from "@repo/atlas";
import { verifyRepositoryBranch } from "@repo/connectors";
import {
	db,
	getProjectRepoIntegration,
	logRepoIntegrationActivity,
} from "@repo/database";
import { resolveFreshRepoTokenForRow } from "@repo/integrations/repo-auth";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/** Proactive-refresh buffer matching the credentials helper's near-expiry window. */
const TOKEN_NEAR_EXPIRY_BUFFER_MS = 60_000;

function credentialsExpiredError(): ORPCError<string, unknown> {
	return new ORPCError("BAD_REQUEST", {
		message:
			"Repository credentials have expired — reconnect the repository to change the branch.",
		data: { code: "REPOSITORY_CREDENTIALS_EXPIRED" },
	});
}

export const updateRepoIntegrationBranchProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.route({
		method: "PATCH",
		path: "/projects/:projectId/repository-integrations/:integrationId/branch",
		tags: ["Projects", "Repository Integrations"],
		summary: "Change the monitored branch of a repository integration",
	})
	.input(
		z.object({
			projectId: z.string().min(1),
			organizationId: z.string().nullable().optional(),
			integrationId: z.string().min(1),
			branch: z
				.string()
				.trim()
				.min(1)
				.max(255)
				// Conservative git-ref subset; the authoritative check is the
				// remote lookup below.
				.regex(
					// biome-ignore lint/suspicious/noControlCharactersInRegex: the class deliberately REJECTS control characters in branch names before the value reaches any URL.
					/^(?!\/)(?!.*\.\.)(?!.*[\s~^:?*[\\])(?!.*\/\/)[^\x00-\x1f]+(?<!\/)(?<!\.lock)$/,
				),
		}),
	)
	.output(
		z.object({
			integration: z.object({
				id: z.string(),
				defaultBranch: z.string(),
			}),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// 1. Load + bind: tenant scope is proven by `requireProjectPermission`;
		// the projectId in the lookup binds the integration to THAT project
		// before any credential column is read.
		let integration = await getProjectRepoIntegration(
			input.integrationId,
			input.projectId,
		);
		if (!integration) {
			throw new ORPCError("NOT_FOUND", {
				message: "Repository integration not found",
			});
		}

		// 2. Disconnected rows have their tokens wiped — nothing to verify with.
		if (integration.status === "DISCONNECTED") {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"This repository is disconnected. Reconnect it before changing the branch.",
				data: { code: "REPOSITORY_DISCONNECTED" },
			});
		}

		// 3. Same-branch save is an idempotent no-op: no write, no remote call.
		if (input.branch === integration.defaultBranch) {
			return {
				integration: {
					id: integration.id,
					defaultBranch: integration.defaultBranch,
				},
			};
		}

		// 4. Resolve a usable token. GitHub OAuth self-heals via a forced
		// refresh when expired/near-expiry; PAT and GitLab have no refresh path.
		if (
			integration.provider === "GITHUB" &&
			integration.authMethod === "OAUTH"
		) {
			const nearExpiry =
				integration.tokenExpiresAt != null &&
				integration.tokenExpiresAt.getTime() <=
					Date.now() + TOKEN_NEAR_EXPIRY_BUFFER_MS;
			if (integration.status !== "ACTIVE" || nearExpiry) {
				await ensureFreshRepoCredentials({
					integrationId: integration.id,
					userId: user.id,
					organizationId,
					force: true,
				});
				// Re-read: a successful refresh rotated the stored access token.
				integration =
					(await getProjectRepoIntegration(
						input.integrationId,
						input.projectId,
					)) ?? integration;
			}
		}
		if (integration.status === "TOKEN_EXPIRED") {
			throw credentialsExpiredError();
		}
		// Canonical resolver. GitLab DOES have a refresh path (the comment above
		// used to claim otherwise), and this branch previously decrypted its
		// ~2h-lived token raw — so a GitLab user whose token lapsed since the
		// last health-check cycle was told to reconnect the whole repository
		// when a refresh would have silently succeeded. PATs pass straight
		// through unchanged.
		const { token } = await resolveFreshRepoTokenForRow(
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
			{ userId: user.id, organizationId },
		);
		if (!token) {
			throw credentialsExpiredError();
		}

		// 5. Verify the branch exists on the remote before writing anything.
		const outcome = await verifyRepositoryBranch({
			provider: integration.provider,
			token,
			repositoryUrl: integration.repositoryUrl,
			owner: integration.repositoryOwner,
			repo: integration.repositoryName,
			azureOrganization: integration.azureOrganization,
			// GitLab PATs authenticate with PRIVATE-TOKEN, not Bearer — sending
			// the wrong header made every branch save read as a dead credential
			// for a perfectly good PAT.
			...(integration.provider === "GITLAB" &&
			integration.authMethod === "PAT"
				? { gitlabAuth: "private-token" as const }
				: {}),
			branch: input.branch,
		});
		if (outcome === "not-found") {
			throw new ORPCError("BAD_REQUEST", {
				message: `Branch "${input.branch}" wasn't found on the remote.`,
				data: { code: "BRANCH_NOT_FOUND" },
			});
		}
		if (outcome === "unauthorized") {
			throw credentialsExpiredError();
		}
		if (outcome === "unreachable") {
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message:
					"Couldn't reach the repository to verify the branch. Try again in a moment.",
				data: { code: "REPOSITORY_UNREACHABLE" },
			});
		}

		// 6. Persist the single field. The `updatedAt` bump this causes is
		// CAS-safe for concurrent token refreshes (losers re-read).
		const previousBranch = integration.defaultBranch;
		const updated = await db.projectRepositoryIntegration.update({
			where: { id: integration.id },
			data: { defaultBranch: input.branch },
			select: { id: true, defaultBranch: true },
		});

		const repositoryFullName = `${integration.repositoryOwner}/${integration.repositoryName}`;
		await logRepoIntegrationActivity({
			projectId: input.projectId,
			userId: user.id,
			userName: user.name || "Unknown",
			organizationId,
			activityType: "repo_integration_branch_changed",
			integrationId: integration.id,
			repositoryName: repositoryFullName,
			metadata: {
				provider: integration.provider,
				previousBranch,
				branch: input.branch,
			},
		});
		recordAuditFromRequest(context, {
			action: "atlas.branch.changed",
			category: "atlas",
			organizationId,
			projectId: input.projectId,
			resource: {
				type: "repository_integration",
				id: integration.id,
				name: repositoryFullName,
			},
			metadata: {
				previousBranch,
				branch: input.branch,
				provider: integration.provider,
			},
		});

		return {
			integration: {
				id: updated.id,
				defaultBranch: updated.defaultBranch,
			},
		};
	});
