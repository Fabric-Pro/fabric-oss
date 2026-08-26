/**
 * Attach a personal access token to an EXISTING repository integration
 * (Fizzy #2252 AC5).
 *
 * The defect this closes: when the connected credential cannot read the
 * repository (the provider app is not installed on it), the only remedy used
 * to be disconnect → re-add, losing branch pins and history. This procedure
 * validates the PAT against THE REPOSITORY first — never storing an untested
 * credential — then converts the row to PAT-backed in one write: OAuth token
 * columns are cleared so readers (repo-auth prefers the stored PAT whenever
 * authMethod is PAT) can never mix the two credentials, and the row returns to
 * ACTIVE with its cause line cleared. Branch/qa-branch pins are preserved.
 *
 * Validation failures are BAD_REQUEST with the same per-status sentences the
 * connect path uses (shared helper) — nothing is written on failure.
 */

import { ORPCError } from "@orpc/client";
import {
	validateAzureDevOpsPat,
	validateGitHubPat,
	validateGitLabPat,
} from "@repo/connectors";
import {
	db,
	getProjectRepoIntegration,
	logRepoIntegrationActivity,
} from "@repo/database";
import { encryptApiKey } from "@repo/utils";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	gitHubPatValidationMessage,
	gitLabPatValidationMessage,
} from "./lib/pat-validation-errors";

export const attachPatToRepoIntegrationProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.route({
		method: "PATCH",
		path: "/projects/:projectId/repository-integrations/:integrationId/pat",
		tags: ["Projects", "Repository Integrations"],
		summary:
			"Attach a personal access token to an existing repository integration",
	})
	.input(
		z.object({
			projectId: z.string().min(1),
			integrationId: z.string().min(1),
			patToken: z.string().trim().min(1),
			azureOrganization: z.string().trim().min(1).optional(),
		}),
	)
	.output(
		z.object({
			integration: z.object({ id: z.string(), status: z.string() }),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;

		// The org comes from the PROJECT the caller is already authorized on —
		// never from caller input (input-org ratchet, SOC 2 CC6.1).
		const project = await db.project.findUnique({
			where: { id: input.projectId },
			select: { organizationId: true },
		});
		const organizationId = project?.organizationId ?? null;

		const integration = await getProjectRepoIntegration(
			input.integrationId,
			input.projectId,
		);
		if (!integration) {
			throw new ORPCError("NOT_FOUND", {
				message: "Repository integration not found",
			});
		}
		if (integration.status === "DISCONNECTED") {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"This repository is disconnected. Reconnect it before attaching a token.",
				data: { code: "REPOSITORY_DISCONNECTED" },
			});
		}

		const azureOrganization =
			integration.provider === "AZURE_DEVOPS"
				? (input.azureOrganization ?? integration.azureOrganization)
				: undefined;
		if (integration.provider === "AZURE_DEVOPS" && !azureOrganization) {
			throw new ORPCError("BAD_REQUEST", {
				message: "Azure organization is required for Azure DevOps PAT",
			});
		}
		// GitLab repo integrations are gitlab.com-only; pinning here mirrors the
		// connect path so the validated request can never be aimed elsewhere.
		let gitlabHostCheck: string | undefined;
		if (integration.provider === "GITLAB") {
			try {
				gitlabHostCheck = new URL(
					integration.repositoryUrl,
				).hostname.toLowerCase();
			} catch {
				gitlabHostCheck = undefined;
			}
			if (gitlabHostCheck !== "gitlab.com") {
				throw new ORPCError("BAD_REQUEST", {
					message:
						"Only gitlab.com repositories are supported for GitLab connections",
				});
			}
		}

		switch (integration.provider) {
			case "GITHUB": {
				const validation = await validateGitHubPat({
					pat: input.patToken,
					owner: integration.repositoryOwner,
					repo: integration.repositoryName,
				});
				if (!validation.ok) {
					throw new ORPCError("BAD_REQUEST", {
						message: gitHubPatValidationMessage(validation.status),
					});
				}
				break;
			}
			case "GITLAB": {
				const validation = await validateGitLabPat({
					pat: input.patToken,
					host: "https://gitlab.com",
					projectPath: `${integration.repositoryOwner}/${integration.repositoryName}`,
				});
				if (!validation.ok) {
					throw new ORPCError("BAD_REQUEST", {
						message: gitLabPatValidationMessage(validation.status),
					});
				}
				break;
			}
			case "AZURE_DEVOPS": {
				const validation = await validateAzureDevOpsPat({
					organization: azureOrganization as string,
					pat: input.patToken,
				});
				if (!validation.ok) {
					throw new ORPCError("BAD_REQUEST", {
						message:
							validation.status === 401 ||
							validation.status === 403
								? "Invalid PAT or insufficient permissions"
								: `Azure DevOps returned status ${validation.status}`,
					});
				}
				break;
			}
		}

		const updated = await db.projectRepositoryIntegration.update({
			where: { id: integration.id },
			data: {
				authMethod: "PAT",
				encryptedPat: encryptApiKey(input.patToken),
				// Clear every OAuth column: readers pick the credential by
				// authMethod, and leftover OAuth columns would let a later
				// authMethod flip resurrect a stale token.
				encryptedAccessToken: null,
				encryptedRefreshToken: null,
				tokenExpiresAt: null,
				tokenScopes: [],
				...(integration.provider === "AZURE_DEVOPS"
					? { azureOrganization }
					: { azureOrganization: null }),
				status: "ACTIVE",
				lastError: null,
				refreshTokenRejectedAt: null,
				// A fresh credential must start with a full retirement budget:
				// a stale count would let one failed sweep retire this row.
				probeFailCount: 0,
			},
			select: { id: true, status: true },
		});

		await logRepoIntegrationActivity({
			projectId: input.projectId,
			userId: user.id,
			userName: user.name || "Unknown",
			organizationId,
			activityType: "repo_integration_pat_attached",
			integrationId: integration.id,
			repositoryName: `${integration.repositoryOwner}/${integration.repositoryName}`,
			metadata: { provider: integration.provider, authMethod: "PAT" },
		});

		recordAuditFromRequest(context, {
			action: "org.integration.credential_rebound",
			category: "org",
			organizationId,
			projectId: input.projectId,
			resource: {
				type: "repository_integration",
				id: integration.id,
				name: `${integration.repositoryOwner}/${integration.repositoryName}`,
			},
			metadata: {
				provider: integration.provider,
				authMethod: "PAT",
			},
		});

		return {
			integration: { id: updated.id, status: updated.status },
		};
	});
