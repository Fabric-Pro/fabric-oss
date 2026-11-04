/**
 * Choose the credential-manager credential a repository integration runs with
 * (ADR-026), or clear the choice.
 *
 * A chosen credential is resolved as the caller, so a credential the caller
 * may not use is refused, and probed against THE REPOSITORY before it is
 * bound. While bound it is the only credential the repository is read with;
 * the stored token columns stay untouched, and clearing the choice
 * (`credentialId: null`) returns the repository to them. Available only while
 * the credential manager is on for the organization.
 */

import { ORPCError } from "@orpc/client";
import {
	db,
	getProjectRepoIntegration,
	logRepoIntegrationActivity,
} from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { resolveCredentialActor } from "../../../credential-manager/lib/context";
import { resolveSavedCredentialForRepository } from "./lib/saved-credential";

export const setRepoIntegrationCredentialProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.route({
		method: "PATCH",
		path: "/projects/:projectId/repository-integrations/:integrationId/credential",
		tags: ["Projects", "Repository Integrations"],
		summary: "Choose the credential a repository integration runs with",
	})
	.input(
		z.object({
			projectId: z.string().min(1),
			integrationId: z.string().min(1),
			/** A credential-manager credential, or null for the stored one. */
			credentialId: z.string().min(1).nullable(),
		}),
	)
	.output(
		z.object({
			integration: z.object({ id: z.string(), status: z.string() }),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;

		// The org comes from the project the caller is authorized on, never
		// from caller input.
		const project = await db.project.findUnique({
			where: { id: input.projectId },
			select: { organizationId: true },
		});
		const organizationId = project?.organizationId ?? null;
		if (!organizationId) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}
		// Refuses while the credential manager is off.
		const actor = await resolveCredentialActor(organizationId, user.id);

		const integration = await getProjectRepoIntegration(
			input.integrationId,
			input.projectId,
		);
		if (!integration) {
			throw new ORPCError("NOT_FOUND", {
				message: "Repository integration not found",
			});
		}
		if (
			integration.provider !== "GITHUB" &&
			integration.provider !== "GITLAB"
		) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Only GitHub and GitLab repositories can run with a saved credential.",
			});
		}

		if (input.credentialId) {
			await resolveSavedCredentialForRepository({
				credentialId: input.credentialId,
				actor,
				provider: integration.provider,
				repositoryUrl: integration.repositoryUrl,
				owner: integration.repositoryOwner,
				repo: integration.repositoryName,
			});
		}

		const updated = await db.projectRepositoryIntegration.update({
			where: { id: integration.id },
			data: input.credentialId
				? {
						credentialId: input.credentialId,
						status: "ACTIVE",
						lastError: null,
						refreshTokenRejectedAt: null,
						// A credential that just read the repository starts
						// with a full retirement budget.
						probeFailCount: 0,
					}
				: { credentialId: null },
			select: { id: true, status: true },
		});

		const repositoryName = `${integration.repositoryOwner}/${integration.repositoryName}`;
		await logRepoIntegrationActivity({
			projectId: input.projectId,
			userId: user.id,
			userName: user.name || "Unknown",
			organizationId,
			activityType: "repo_integration_credential_chosen",
			integrationId: integration.id,
			repositoryName,
			metadata: {
				provider: integration.provider,
				credentialId: input.credentialId,
			},
		});

		recordAuditFromRequest(context, {
			action: "org.integration.credential_rebound",
			category: "org",
			organizationId,
			projectId: input.projectId,
			resource: {
				type: "repository_integration",
				id: integration.id,
				name: repositoryName,
			},
			metadata: {
				provider: integration.provider,
				source: input.credentialId ? "saved" : "stored",
			},
		});

		return {
			integration: { id: updated.id, status: updated.status },
		};
	});
