/**
 * Connect Repository Integration
 *
 * Creates a new project-level repository integration.
 * PROJECT_ADMIN+ (via PROJECT_SETTINGS_EDIT). Two auth methods:
 *  - OAUTH (GitHub / GitLab): this endpoint routes callers to the provider's
 *    OAuth start endpoint; credentials are stored on the callback.
 *  - PAT (Azure DevOps, GitHub, GitLab): accepts a token, validates it via the
 *    matching `@repo/connectors` request-path helper, then stores it encrypted.
 *    A scoped PAT is the reliable way to pull CI pipeline results from GitHub,
 *    since the GitHub App's OAuth token is Contents-scoped and can't read Actions.
 *
 * Note: PAT validation uses the synchronous connectors helpers (request path) —
 * NOT the Temporal health-check activities. This keeps the handler thin per
 * `backend/api.md` ("no business logic in procedures").
 */

import { ORPCError } from "@orpc/client";
import {
	resolveDefaultBranch,
	validateAzureDevOpsPat,
	validateGitHubPat,
	validateGitLabPat,
} from "@repo/connectors";
import {
	createProjectRepoIntegration,
	db,
	logRepoIntegrationActivity,
	parseRepoUrl,
	syncLegacyProjectRepoOnConnect,
} from "@repo/database";
import { encryptApiKey } from "@repo/utils";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { startCodeIndexingForProject } from "../../lib/code-indexing-trigger";
import {
	gitHubPatValidationMessage,
	gitLabPatValidationMessage,
} from "./lib/pat-validation-errors";

export const connectRepoIntegrationProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.route({
		method: "POST",
		path: "/projects/:projectId/repository-integrations",
		tags: ["Projects", "Repository Integrations"],
		summary: "Connect a repository integration to the project",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			provider: z.enum(["GITHUB", "GITLAB", "AZURE_DEVOPS"]),
			authMethod: z.enum(["OAUTH", "PAT"]),
			// Bounded span: js/polynomial-redos — this value is stored and later
			// re-parsed by parseAdoRepositoryUrl's legacy-URL regex (update-branch);
			// no real repository URL is anywhere near this length.
			repositoryUrl: z.string().url().max(2048),
			repositoryOwner: z.string(),
			repositoryName: z.string(),
			defaultBranch: z.string().optional(),
			roleTag: z
				.string()
				.trim()
				.max(50)
				.regex(/^(?!.*---)[a-zA-Z0-9_\-./ ]+$/, {
					message:
						"Role tag can only contain letters, numbers, spaces, hyphens, underscores, dots, and slashes (and cannot contain '---')",
				})
				.nullable()
				.optional(),
			// For PAT-based auth. Azure DevOps also needs `azureOrganization`;
			// GitHub / GitLab need only `pat`.
			pat: z.string().optional(),
			azureOrganization: z.string().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Validate repo URL
		const parsed = parseRepoUrl(input.repositoryUrl);
		if (!parsed) {
			throw new ORPCError("BAD_REQUEST", {
				message: "Cannot parse repository URL",
			});
		}

		// Use parsed values from the URL (not user-provided input) for consistency
		const provider = parsed.provider;
		const repositoryOwner = parsed.owner;
		const repositoryName = parsed.name;

		// For PAT auth, validate the PAT before storing
		if (input.authMethod === "PAT") {
			if (!input.pat) {
				throw new ORPCError("BAD_REQUEST", {
					message: "PAT is required for PAT authentication",
				});
			}

			const encryptedPat = encryptApiKey(input.pat);

			// Validate the PAT against the provider before storing. Each check is
			// delegated to a `@repo/connectors` request-path helper. Error mapping:
			// 401/403 (plus 404 for GitHub, which returns 404 for repos the token
			// cannot access) → invalid-PAT/insufficient permissions, other non-OK →
			// `{provider} returned status N`. Azure DevOps additionally needs the org;
			// GitHub and GitLab validate repository read permissions for the specific
			// target repo (the GitHub App's OAuth token is Contents-scoped and can't
			// read Actions, so a scoped PAT is the reliable way to pull CI pipeline
			// results).
			if (provider === "AZURE_DEVOPS") {
				if (!input.azureOrganization) {
					throw new ORPCError("BAD_REQUEST", {
						message:
							"Azure organization is required for Azure DevOps PAT",
					});
				}
				const validation = await validateAzureDevOpsPat({
					organization: input.azureOrganization,
					pat: input.pat,
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
			} else if (provider === "GITHUB") {
				const validation = await validateGitHubPat({
					pat: input.pat,
					owner: repositoryOwner,
					repo: repositoryName,
				});
				if (!validation.ok) {
					// Shared with the attach-PAT path so both tell one story per
					// status: 401 is the credential itself, 403 authenticated but
					// lacks the grant, and GitHub also answers 404 for a private
					// repo the token cannot see.
					throw new ORPCError("BAD_REQUEST", {
						message: gitHubPatValidationMessage(validation.status),
					});
				}
			} else {
				// GITLAB — gitlab.com only. `parseRepoUrl` recognises GitLab by a
				// `gitlab.com` SUBSTRING, so a crafted URL like
				// `https://<internal-host>/gitlab.com/a/b` would classify as GitLab
				// while its real host is attacker-controlled. Pin the API host to
				// gitlab.com and REJECT any other host, so neither this validation
				// fetch nor the later branch/pipeline fetches (which read the stored
				// repositoryUrl) can be pointed at an internal host (SSRF).
				let hostname: string;
				try {
					hostname = new URL(
						input.repositoryUrl,
					).hostname.toLowerCase();
				} catch {
					throw new ORPCError("BAD_REQUEST", {
						message: "Invalid GitLab repository URL",
					});
				}
				if (hostname !== "gitlab.com") {
					throw new ORPCError("BAD_REQUEST", {
						message:
							"Only gitlab.com repositories are supported for GitLab connections",
					});
				}
				const validation = await validateGitLabPat({
					pat: input.pat,
					host: "https://gitlab.com",
					projectPath: `${repositoryOwner}/${repositoryName}`,
				});
				if (!validation.ok) {
					throw new ORPCError("BAD_REQUEST", {
						message: gitLabPatValidationMessage(validation.status),
					});
				}
			}

			const resolvedBranch = await resolveDefaultBranch({
				providedBranch: input.defaultBranch,
				provider,
				token: input.pat,
				repositoryUrl: input.repositoryUrl,
				owner: repositoryOwner,
				repo: repositoryName,
				azureOrganization: input.azureOrganization,
				// GitLab PATs authenticate with PRIVATE-TOKEN, not Bearer.
				...(provider === "GITLAB"
					? { gitlabAuth: "private-token" as const }
					: {}),
			});

			const normalizedRoleTag = input.roleTag?.trim() || null;
			if (normalizedRoleTag) {
				const duplicate =
					await db.projectRepositoryIntegration.findFirst({
						where: {
							projectId: input.projectId,
							roleTag: {
								equals: normalizedRoleTag,
								mode: "insensitive",
							},
						},
						select: {
							id: true,
							repositoryOwner: true,
							repositoryName: true,
						},
					});
				if (duplicate) {
					throw new ORPCError("CONFLICT", {
						message: `The role tag "${normalizedRoleTag}" is already assigned to ${duplicate.repositoryOwner}/${duplicate.repositoryName}`,
					});
				}
			}

			let integration: Awaited<
				ReturnType<typeof createProjectRepoIntegration>
			>;
			try {
				integration = await createProjectRepoIntegration({
					projectId: input.projectId,
					provider,
					authMethod: input.authMethod,
					repositoryUrl: input.repositoryUrl,
					repositoryOwner,
					repositoryName,
					defaultBranch: resolvedBranch,
					roleTag: normalizedRoleTag,
					encryptedPat,
					azureOrganization: input.azureOrganization,
					configuredByUserId: user.id,
				});
			} catch (err: any) {
				if (err?.code === "P2002") {
					throw new ORPCError("CONFLICT", {
						message:
							"Repository is already connected to this project",
					});
				}
				throw err;
			}

			await syncLegacyProjectRepoOnConnect(
				input.projectId,
				input.repositoryUrl,
				repositoryOwner,
				repositoryName,
				resolvedBranch,
			);

			// Best-effort: kick off code indexing for the newly connected repo
			// (no-op unless FEATURE_CODE_INDEXING + codeSearchEnabled).
			await startCodeIndexingForProject({
				projectId: input.projectId,
				userId: user.id,
				organizationId,
				repositoryIntegrationId: integration.id,
			}).catch((error) => {
				console.error(
					"[connect] Failed to auto-start code indexing:",
					error,
				);
			});

			await logRepoIntegrationActivity({
				projectId: input.projectId,
				userId: user.id,
				userName: user.name || "Unknown",
				organizationId,
				activityType: "repo_integration_configured",
				integrationId: integration.id,
				repositoryName: `${repositoryOwner}/${repositoryName}`,
				metadata: {
					provider,
					authMethod: input.authMethod,
				},
			});

			// Audit-log emission. Org-level integration event —
			// the resource is the repo integration, not the project. We tag
			// `projectId` so the project viewer still surfaces it.
			recordAuditFromRequest(context, {
				action: "org.integration.connected",
				category: "org",
				organizationId,
				projectId: input.projectId,
				resource: {
					type: "repository_integration",
					id: integration.id,
					name: `${repositoryOwner}/${repositoryName}`,
				},
				metadata: {
					provider,
					authMethod: input.authMethod,
				},
			});

			return { integration: { id: integration.id }, success: true };
		}

		// authMethod === "OAUTH": OAuth credentials are stored during the
		// provider-specific OAuth callback, not via this procedure. Route callers
		// to the correct OAuth start endpoint. (PAT for any provider is handled above.)
		throw new ORPCError("BAD_REQUEST", {
			message:
				"For GitLab or GitHub OAuth, call integrations.gitlab.start (or integrations.github.start) with targetType: 'project' and projectId. This endpoint handles PAT-based integrations.",
		});
	});
