/**
 * Start Existing Project Setup
 *
 * Validates the project, issues AI token, and starts the
 * existingProjectSetupWorkflow Temporal workflow.
 * Returns immediately (fire-and-forget) — user is redirected to project page.
 *
 * AUTHORIZATION: `requireProjectPermission(PROJECT_UPDATE)` gates the call.
 * Repo-integration auto-population inside the handler is gated separately
 * to project owners only via `getProjectMemberRole`.
 *
 * Provider note: GitHub/GitLab repo integrations are auto-created here from the
 * user's stored credentials (OAuth or PAT). Azure DevOps uses a per-repo PAT (no stored
 * OAuth integration to copy), so its integration is created up front by the
 * shared `AzureDevOpsPatRepoPicker` via `repositoryIntegrations.connect`. ADO
 * URLs are therefore NOT dropped — they reach the workflow in `repoUrls` like
 * any other provider (see the ADO branch before the workflow start).
 */

import { ORPCError } from "@orpc/client";
import { issueAIToken } from "@repo/ai-token";
import {
	resolveDefaultBranch,
	validateGitLabPat,
	verifyRepositoryAccess,
} from "@repo/connectors";
import {
	createProjectRepoIntegration,
	db,
	getProjectMemberRole,
	logRepoIntegrationActivity,
	ProjectMemberRole,
	parseRepoUrl,
	syncLegacyProjectRepoOnConnect,
} from "@repo/database";
import { getTemporalClient } from "@repo/temporal";
import { encryptApiKey } from "@repo/utils";
import { assertSafeOutboundUrlResolved } from "@repo/utils/url-security";
import { z } from "zod";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

function outboundRepositoryUrl(repositoryUrl: string): string {
	const trimmed = repositoryUrl.trim();
	const scpStyle = trimmed.match(/^git@([^:]+):(.+)$/i);
	if (scpStyle) {
		return `https://${scpStyle[1]}/${scpStyle[2]}`;
	}
	return /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)
		? trimmed
		: `https://${trimmed}`;
}

async function assertSafeRepositoryUrls(
	repositoryUrls: string[],
): Promise<void> {
	for (const repositoryUrl of repositoryUrls) {
		if (!parseRepoUrl(repositoryUrl)) {
			throw new ORPCError("BAD_REQUEST", {
				message: `Unsupported repository URL: ${repositoryUrl}`,
			});
		}
		try {
			await assertSafeOutboundUrlResolved(
				outboundRepositoryUrl(repositoryUrl),
			);
		} catch {
			throw new ORPCError("BAD_REQUEST", {
				message: `Repository URL must resolve to a public address: ${repositoryUrl}`,
			});
		}
	}
}

export const startExistingSetupProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/existing-setup/start",
		tags: ["Projects"],
		summary:
			"Start existing project setup (code analysis + sequential doc generation)",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			repoUrls: z.array(z.string()).default([]),
			selectedDocumentTypes: z.array(z.string()).default([]),
			projectTypes: z.array(z.string()).default([]),
			projectName: z.string(),
			documentPrompts: z
				.record(
					z.string(),
					z.object({
						promptId: z.string().optional(),
						customInstructions: z.string().optional(),
					}),
				)
				.optional(),
			repoTags: z
				.record(
					z.string(),
					z
						.string()
						.trim()
						.max(50)
						.regex(/^(?!.*---)[a-zA-Z0-9_\-./ ]+$/, {
							message:
								"Role tag can only contain letters, numbers, spaces, hyphens, underscores, dots, and slashes (and cannot contain '---')",
						}),
				)
				.optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { user } = context;
		const {
			projectId,
			selectedDocumentTypes,
			repoUrls,
			projectTypes,
			projectName,
			documentPrompts,
		} = input;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		await assertSafeRepositoryUrls(repoUrls);

		// Authorization is enforced by `requireProjectPermission` above.

		// Get project with PM config info
		const project = await db.project.findUnique({
			where: { id: projectId },
		});

		if (!project) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found",
			});
		}

		// Check if setup is already in progress
		if (project.codeAnalysisStatus === "SCANNING") {
			throw new ORPCError("CONFLICT", {
				message: "Project setup is already in progress",
			});
		}

		// Validate unique role tags
		if (input.repoTags) {
			const nonNullTags = Object.values(input.repoTags)
				.map((t) => t.trim())
				.filter((t) => t.length > 0);
			const lowerTags = nonNullTags.map((t) => t.toLowerCase());
			if (new Set(lowerTags).size !== lowerTags.length) {
				throw new ORPCError("CONFLICT", {
					message: "Each repository must have a unique role tag",
				});
			}

			const existingWithTags =
				await db.projectRepositoryIntegration.findMany({
					where: {
						projectId,
						roleTag: { not: null },
					},
					select: {
						roleTag: true,
						repositoryOwner: true,
						repositoryName: true,
					},
				});
			for (const tag of nonNullTags) {
				const collision = existingWithTags.find(
					(e) => e.roleTag?.toLowerCase() === tag.toLowerCase(),
				);
				if (collision) {
					throw new ORPCError("CONFLICT", {
						message: `The role tag "${tag}" is already assigned to ${collision.repositoryOwner}/${collision.repositoryName}`,
					});
				}
			}
		}

		// Issue AI token for the workflow
		const aiToken = await issueAIToken({
			userId: user.id,
			organizationId,
			source: "existing-project-setup",
			expirySeconds: 7200, // 2 hours — sequential doc gen can take a while
		});

		// Build PM config from project record
		const pmMcpConfigId = project.projectManagementMcpConfigId ?? undefined;
		const pmContainerId = project.projectManagementContainerId ?? undefined;
		const pmAdditionalContext =
			project.projectManagementAdditionalContext as
				| Record<string, string>
				| undefined;

		const skippedRepos: string[] = [];

		// Auto-populate project-level repo integrations from user's GitHub credentials.
		// This ensures that when a project is created via the "existing project" flow,
		// the shared credentials are available to all project members automatically.
		// Only owners can configure project-level integrations.
		const projectRole = await getProjectMemberRole(projectId, user.id);
		if (repoUrls.length > 0 && projectRole === ProjectMemberRole.OWNER) {
			const orgIdForQuery = organizationId ?? null;
			const stagedRepos = new Set<string>();

			type DecryptedCredential = {
				access_token?: string;
				refresh_token?: string;
				expires_in?: number;
				token_obtained_at?: string;
				scope?: string;
				apiKey?: string;
				pat?: string;
				apiToken?: string;
			};

			// Auto-populate project-level repo integrations from user's GitHub credentials.
			const userGitHubIntegration =
				await db.workflowIntegration.findFirst({
					where: {
						userId: user.id,
						provider: "GITHUB",
						isActive: true,
						...(orgIdForQuery
							? { organizationId: orgIdForQuery }
							: { organizationId: null }),
					},
				});

			if (userGitHubIntegration?.credentials) {
				const { decryptApiKey } = await import("@repo/utils");
				let credJson: DecryptedCredential = {};
				try {
					credJson = JSON.parse(
						decryptApiKey(userGitHubIntegration.credentials),
					);
				} catch (err) {
					console.warn(
						"[ExistingSetup] Failed to decrypt or parse GitHub credentials:",
						err,
					);
				}

				const patToken = credJson.apiKey || credJson.pat;
				const isPat =
					!credJson.access_token &&
					!credJson.refresh_token &&
					Boolean(patToken);
				const token = (isPat ? patToken : credJson.access_token) || "";

				for (const repoUrl of repoUrls) {
					const parsed = parseRepoUrl(repoUrl.trim());
					if (!parsed || parsed.provider !== "GITHUB") {
						continue;
					}

					const repoLabel = `GitHub: ${parsed.owner}/${parsed.name}`;
					const repoKey = `GITHUB:${parsed.owner.toLowerCase()}/${parsed.name.toLowerCase()}`;
					if (stagedRepos.has(repoKey)) {
						continue;
					}

					const existing =
						await db.projectRepositoryIntegration.findFirst({
							where: {
								projectId,
								provider: "GITHUB",
								repositoryOwner: parsed.owner,
								repositoryName: parsed.name,
							},
						});
					if (existing) {
						stagedRepos.add(repoKey);
						continue;
					}

					if (!token) {
						skippedRepos.push(repoLabel);
						continue;
					}

					// Probe the REPOSITORY itself for both credential arms before
					// creating anything (Fizzy #2252 AC1): an account-level token
					// being alive says nothing about this repo, and the OAuth arm
					// used to skip validation entirely, writing Active rows the
					// app cannot read. Definitive negatives skip the repo — the
					// same contract the PAT arm already had — while an
					// inconclusive probe defers to the scheduled sweep instead of
					// blocking a bulk import on a transient blip. The probe never
					// throws.
					const {
						outcome: accessOutcome,
						defaultBranch: probedDefaultBranch,
					} = await verifyRepositoryAccess({
						provider: "GITHUB",
						token,
						repositoryUrl: `https://github.com/${parsed.owner}/${parsed.name}`,
						owner: parsed.owner,
						repo: parsed.name,
					});
					if (
						accessOutcome === "unauthorized" ||
						accessOutcome === "forbidden" ||
						accessOutcome === "not-found"
					) {
						console.warn(
							`[ExistingSetup] Skipping GitHub integration for ${parsed.owner}/${parsed.name}: repository probe answered ${accessOutcome}`,
						);
						skippedRepos.push(repoLabel);
						continue;
					}

					let created = false;
					try {
						const resolvedBranch = await resolveDefaultBranch({
							// The probe's payload already carries default_branch —
							// passing it here short-circuits resolveDefaultBranch's
							// second identical fetch.
							providedBranch:
								project.defaultBranch ?? probedDefaultBranch,
							provider: "GITHUB",
							token,
							repositoryUrl: `https://github.com/${parsed.owner}/${parsed.name}`,
							owner: parsed.owner,
							repo: parsed.name,
						});

						await createProjectRepoIntegration({
							projectId,
							provider: "GITHUB",
							authMethod: isPat ? "PAT" : "OAUTH",
							repositoryUrl: repoUrl.trim(),
							repositoryOwner: parsed.owner,
							repositoryName: parsed.name,
							defaultBranch: resolvedBranch,
							encryptedAccessToken: !isPat
								? encryptApiKey(token)
								: undefined,
							encryptedPat: isPat
								? encryptApiKey(token)
								: undefined,
							encryptedRefreshToken:
								!isPat && credJson.refresh_token
									? encryptApiKey(credJson.refresh_token)
									: undefined,
							tokenExpiresAt:
								!isPat && credJson.expires_in
									? new Date(
											(credJson.token_obtained_at
												? new Date(
														credJson.token_obtained_at,
													).getTime()
												: Date.now()) +
												credJson.expires_in * 1000,
										)
									: undefined,
							tokenScopes:
								!isPat && credJson.scope
									? credJson.scope.split(",")
									: [],
							configuredByUserId: user.id,
							roleTag: input.repoTags?.[repoUrl.trim()] ?? null,
						});
						created = true;
						stagedRepos.add(repoKey);

						await syncLegacyProjectRepoOnConnect(
							projectId,
							repoUrl.trim(),
							parsed.owner,
							parsed.name,
							resolvedBranch,
						);

						await logRepoIntegrationActivity({
							projectId,
							userId: user.id,
							userName: user.name || "Unknown",
							organizationId,
							activityType: "repo_integration_configured",
							repositoryName: `${parsed.owner}/${parsed.name}`,
							metadata: {
								provider: "GITHUB",
								authMethod: isPat ? "PAT" : "OAUTH",
								source: "auto_from_existing_setup",
							},
						}).catch(() => {});
					} catch (err) {
						// Don't fail the setup if auto-population fails
						console.error(
							"[ExistingSetup] Error setting up GitHub project repo integration:",
							err,
						);
						if (!created) {
							skippedRepos.push(repoLabel);
						}
					}
				}
			}

			// Auto-populate project-level repo integrations from user's GitLab credentials.
			const userGitLabIntegration =
				await db.workflowIntegration.findFirst({
					where: {
						userId: user.id,
						provider: "GITLAB",
						isActive: true,
						...(orgIdForQuery
							? { organizationId: orgIdForQuery }
							: { organizationId: null }),
					},
				});

			if (userGitLabIntegration?.credentials) {
				const { decryptApiKey } = await import("@repo/utils");
				let credJson: DecryptedCredential = {};
				try {
					credJson = JSON.parse(
						decryptApiKey(userGitLabIntegration.credentials),
					);
				} catch (err) {
					console.warn(
						"[ExistingSetup] Failed to decrypt or parse GitLab credentials:",
						err,
					);
				}

				const patToken = credJson.apiToken || credJson.pat;
				const isPat =
					!credJson.access_token &&
					!credJson.refresh_token &&
					Boolean(patToken);
				const token = (isPat ? patToken : credJson.access_token) || "";

				for (const repoUrl of repoUrls) {
					const parsed = parseRepoUrl(repoUrl.trim());
					if (!parsed || parsed.provider !== "GITLAB") {
						continue;
					}

					const repoLabel = `GitLab: ${parsed.owner}/${parsed.name}`;
					const repoKey = `GITLAB:${parsed.owner.toLowerCase()}/${parsed.name.toLowerCase()}`;
					if (stagedRepos.has(repoKey)) {
						continue;
					}

					const existing =
						await db.projectRepositoryIntegration.findFirst({
							where: {
								projectId,
								provider: "GITLAB",
								repositoryOwner: parsed.owner,
								repositoryName: parsed.name,
							},
						});
					if (existing) {
						stagedRepos.add(repoKey);
						continue;
					}

					let created = false;
					try {
						if (!token) {
							console.warn(
								`[ExistingSetup] No access token or PAT found in GitLab credentials for ${parsed.owner}/${parsed.name}`,
							);
							skippedRepos.push(repoLabel);
							continue;
						}

						// The OAuth probe's payload carries default_branch; when it
						// exists, resolveDefaultBranch below skips its second
						// identical fetch (same short-circuit as the GitHub arm).
						let probedGitLabBranch: string | undefined;

						if (isPat) {
							let hostname = "";
							try {
								hostname = new URL(
									outboundRepositoryUrl(repoUrl),
								).hostname
									.toLowerCase()
									.replace(/\.$/, "");
							} catch {
								console.warn(
									`[ExistingSetup] Skipping GitLab integration for ${parsed.owner}/${parsed.name} due to invalid URL`,
								);
								skippedRepos.push(repoLabel);
								continue;
							}

							if (hostname !== "gitlab.com") {
								console.warn(
									`[ExistingSetup] Skipping GitLab integration for ${parsed.owner}/${parsed.name}: host ${hostname} unsupported`,
								);
								skippedRepos.push(repoLabel);
								continue;
							}

							const validation = await validateGitLabPat({
								pat: token,
								host: "https://gitlab.com",
								projectPath: `${parsed.owner}/${parsed.name}`,
							});
							if (!validation.ok) {
								console.warn(
									`[ExistingSetup] Skipping GitLab integration for ${parsed.owner}/${parsed.name} due to validation status ${validation.status}`,
								);
								skippedRepos.push(repoLabel);
								continue;
							}
						} else {
							// OAuth arm probes the repository itself (Fizzy #2252
							// AC1, same as the GitHub arm): a gitlab.com OAuth
							// token that cannot read THIS repo must not produce an
							// Active row.
							const {
								outcome: gitlabAccessOutcome,
								defaultBranch,
							} = await verifyRepositoryAccess({
								provider: "GITLAB",
								token,
								gitlabAuth: "bearer",
								repositoryUrl: repoUrl.trim(),
								owner: parsed.owner,
								repo: parsed.name,
							});
							if (
								gitlabAccessOutcome === "unauthorized" ||
								gitlabAccessOutcome === "forbidden" ||
								gitlabAccessOutcome === "not-found"
							) {
								console.warn(
									`[ExistingSetup] Skipping GitLab integration for ${parsed.owner}/${parsed.name}: repository probe answered ${gitlabAccessOutcome}`,
								);
								skippedRepos.push(repoLabel);
								continue;
							}
							probedGitLabBranch = defaultBranch;
						}

						const resolvedBranch = await resolveDefaultBranch({
							providedBranch:
								project.defaultBranch ?? probedGitLabBranch,
							provider: "GITLAB",
							token,
							repositoryUrl: repoUrl.trim(),
							owner: parsed.owner,
							repo: parsed.name,
						});

						await createProjectRepoIntegration({
							projectId,
							provider: "GITLAB",
							authMethod: isPat ? "PAT" : "OAUTH",
							repositoryUrl: repoUrl.trim(),
							repositoryOwner: parsed.owner,
							repositoryName: parsed.name,
							defaultBranch: resolvedBranch,
							encryptedAccessToken: !isPat
								? encryptApiKey(token)
								: undefined,
							encryptedPat: isPat
								? encryptApiKey(token)
								: undefined,
							encryptedRefreshToken:
								!isPat && credJson.refresh_token
									? encryptApiKey(credJson.refresh_token)
									: undefined,
							tokenExpiresAt:
								!isPat && credJson.expires_in
									? new Date(
											(credJson.token_obtained_at
												? new Date(
														credJson.token_obtained_at,
													).getTime()
												: Date.now()) +
												credJson.expires_in * 1000,
										)
									: undefined,
							tokenScopes:
								!isPat && credJson.scope
									? credJson.scope.split(" ")
									: [],
							configuredByUserId: user.id,
							roleTag: input.repoTags?.[repoUrl.trim()] ?? null,
						});
						created = true;
						stagedRepos.add(repoKey);

						await syncLegacyProjectRepoOnConnect(
							projectId,
							repoUrl.trim(),
							parsed.owner,
							parsed.name,
							resolvedBranch,
						);

						await logRepoIntegrationActivity({
							projectId,
							userId: user.id,
							userName: user.name || "Unknown",
							organizationId,
							activityType: "repo_integration_configured",
							repositoryName: `${parsed.owner}/${parsed.name}`,
							metadata: {
								provider: "GITLAB",
								authMethod: isPat ? "PAT" : "OAUTH",
								source: "auto_from_existing_setup",
							},
						}).catch(() => {});
					} catch (err) {
						// Don't fail the setup if auto-population fails
						console.error(
							"[ExistingSetup] Error setting up GitLab project repo integration:",
							err,
						);
						if (!created) {
							skippedRepos.push(repoLabel);
						}
					}
				}
			}
		}

		// Azure DevOps repo URLs: NOT auto-created here, intentionally.
		//
		// GitHub/GitLab above auto-create a `ProjectRepositoryIntegration` from
		// the user's stored `workflowIntegration` credentials (OAuth or PAT). Azure DevOps
		// has NO equivalent: it authenticates with a per-repo PAT, and there is no
		// stored `workflowIntegration` to copy a token from. Auto-creating an
		// ADO integration here is therefore impossible without a PAT — which is
		// exactly why the shared `AzureDevOpsPatRepoPicker` creates the integration
		// up front (via `repositoryIntegrations.connect`) at repo-selection time.
		//
		// Historically ADO URLs fell straight through both branches above and the
		// integration was never created, so ADO repos were silently dropped. They
		// are NOT dropped now: the ADO URLs still reach the workflow below in
		// `repoUrls` (this list is provider-agnostic — never provider-filtered),
		// and the orchestrator handles them via its graceful ADO MCP-skip while
		// clone-based `codeIndexingWorkflow` (triggered off the picker's `connect`
		// → `syncLegacyProjectRepoOnConnect`) remains the source of truth for ADO
		// code context. This explicit branch documents that contract so a future
		// reader cannot re-introduce the silent drop.
		if (repoUrls.length > 0 && projectRole === ProjectMemberRole.OWNER) {
			for (const repoUrl of repoUrls) {
				const parsed = parseRepoUrl(repoUrl.trim());
				if (!parsed || parsed.provider !== "AZURE_DEVOPS") {
					continue;
				}
				const existing =
					await db.projectRepositoryIntegration.findFirst({
						where: {
							projectId,
							provider: "AZURE_DEVOPS",
							repositoryOwner: parsed.owner,
							repositoryName: parsed.name,
						},
					});
				if (!existing) {
					// No-op (cannot create without a PAT) — but log so a missing
					// integration is observable rather than a mystery drop. The
					// repo URL still flows to the workflow below.
					console.warn(
						`[ExistingSetup] Azure DevOps repo "${parsed.owner}/${parsed.name}" has no ProjectRepositoryIntegration; it should have been created by the PAT picker. The URL is still passed to the workflow, but clone-based indexing requires the PAT integration.`,
					);
				}
			}
		}

		// Start the Temporal workflow
		const client = await getTemporalClient();
		const workflowId = `existing-setup-${projectId}-${Date.now()}`;

		await client.workflow.start(
			"existingProjectSetupWorkflow",
			withCorrelationMemo({
				taskQueue: "project-documents",
				workflowId,
				args: [
					{
						projectId,
						userId: user.id,
						organizationId,
						aiToken,
						repoUrls: repoUrls.filter((u) => u.trim()),
						selectedDocumentTypes,
						projectTypes,
						projectName,
						pmMcpConfigId,
						pmContainerId,
						pmAdditionalContext,
						documentPrompts,
					},
				],
				workflowExecutionTimeout: "2h",
			}),
		);

		// Update project status immediately
		await db.project.update({
			where: { id: projectId },
			data: {
				codeAnalysisStatus: "SCANNING",
				codeAnalysisWorkflowId: workflowId,
			},
		});

		// Audit log: user triggered a repo scan
		if (repoUrls.length > 0) {
			await logRepoIntegrationActivity({
				projectId,
				userId: user.id,
				userName: user.name || "Unknown",
				organizationId,
				activityType: "repo_scan_triggered",
				metadata: {
					repoUrls: repoUrls.filter((u) => u.trim()),
					workflowId,
				},
			}).catch((err) => {
				// Don't fail the procedure if audit logging fails
				console.error(
					"[AuditLog] Failed to log repo_scan_triggered:",
					err,
				);
			});
		}

		return {
			workflowId,
			status: "SCANNING" as const,
			skippedRepos: skippedRepos.length > 0 ? skippedRepos : undefined,
		};
	});
