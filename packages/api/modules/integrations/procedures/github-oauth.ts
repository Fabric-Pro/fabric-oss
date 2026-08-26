/**
 * GitHub OAuth Procedures
 *
 * Handles GitHub OAuth flow for task agent integration.
 * Stores OAuth tokens in WorkflowIntegration model.
 */

import { ORPCError } from "@orpc/server";
import {
	integrationStatusForRepoAccess,
	resolveDefaultBranch,
	verifyRepositoryAccess,
} from "@repo/connectors";
import {
	createProjectRepoIntegration,
	db,
	logRepoIntegrationActivity,
	syncLegacyProjectRepoOnConnect,
} from "@repo/database";
import { getGitHubToken } from "@repo/integrations";
import { encryptApiKey } from "@repo/utils";
import { z } from "zod";
import { userHasProjectPermission } from "../../../lib/project-permissions";
import {
	Permissions,
	publicProcedure,
	requireInputOrgPermission,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { startCodeIndexingForProject } from "../../projects/lib/code-indexing-trigger";
import {
	exchangeCodeForToken,
	type GitHubTokenResponse,
	type GitHubUser,
	getGitHubOAuthUrl,
	getGitHubUser,
	listGitHubBranches,
} from "../lib/github-oauth";
import { decodeOAuthState, encodeOAuthState } from "../lib/oauth-state";

/**
 * Get GitHub OAuth configuration from environment
 */
function getGitHubConfig() {
	const clientId = process.env.FABRIC_GITHUB_CLIENT_ID;
	const clientSecret = process.env.FABRIC_GITHUB_CLIENT_SECRET;

	return { clientId, clientSecret };
}

export const githubOAuthProcedures = {
	/**
	 * Check if GitHub OAuth is configured
	 */
	isConfigured: tenantProtectedProcedure
		.use(requirePermission(Permissions.INTEGRATION_READ))
		.route({
			method: "GET",
			path: "/integrations/github/oauth/configured",
			tags: ["Integrations", "GitHub"],
			summary: "Check if GitHub OAuth is configured",
		})
		.output(z.object({ configured: z.boolean() }))
		.handler(async () => {
			const { clientId, clientSecret } = getGitHubConfig();
			return { configured: !!(clientId && clientSecret) };
		}),

	/**
	 * Start GitHub OAuth flow
	 *
	 * IMPORTANT: organizationId must be explicitly passed for proper tenant isolation:
	 * - Pass the org ID string when in organization context
	 * - Pass null explicitly when in personal context
	 */
	start: tenantProtectedProcedure
		.use(requireInputOrgPermission(Permissions.INTEGRATION_USE))
		.route({
			method: "POST",
			path: "/integrations/github/oauth/start",
			tags: ["Integrations", "GitHub"],
			summary: "Start GitHub OAuth flow",
		})
		.input(
			z.object({
				redirectUri: z.string().url(),
				returnUrl: z
					.string()
					.refine(
						// Same-origin relative paths only (SOC 2 CC6.1). Reject
						// absolute URLs and protocol-relative "//host" to close the
						// open-redirect / post-OAuth JS-injection vector at the
						// callback sink.
						// Same-origin relative path only: a single leading "/" NOT
						// followed by "/" or "\" ("\" normalizes to "/" in browsers,
						// so "/\host" is an open-redirect just like "//host").
						(url) => url.startsWith("/") && !/^\/[/\\]/.test(url),
						{
							message:
								"returnUrl must be a same-origin relative path",
						},
					)
					.optional(),
				organizationId: z.string().nullable().optional(),
				// Project-level integration fields
				targetType: z.enum(["user", "project"]).optional(),
				projectId: z.string().optional(),
				repositoryUrl: z.string().optional(),
				repositoryOwner: z.string().optional(),
				repositoryName: z.string().optional(),
				defaultBranch: z.string().optional(),
				roleTag: z
					.string()
					.trim()
					.max(50)
					.regex(/^(?!.*---)[a-zA-Z0-9_\-./ ]+$/, {
						message:
							"Role tag can only contain letters, numbers, spaces, hyphens, underscores, dots, and slashes (and cannot contain '---')",
					})
					.optional(),
			}),
		)
		.output(z.object({ authorizationUrl: z.string().url() }))
		.handler(async ({ input, context }) => {
			const { clientId } = getGitHubConfig();

			if (!clientId) {
				throw new ORPCError("BAD_REQUEST", {
					message:
						"GitHub OAuth not configured. Please set FABRIC_GITHUB_CLIENT_ID environment variable.",
				});
			}

			const userId = context.user.id;
			// Use explicit organizationId from input for proper tenant isolation
			const organizationId =
				input.organizationId !== undefined
					? input.organizationId
					: context.session.activeOrganizationId;

			// Generate signed state (include redirectUri so callback uses same value)
			const state = encodeOAuthState({
				userId,
				organizationId: organizationId ?? undefined,
				provider: "github",
				returnUrl: input.returnUrl,
				redirectUri: input.redirectUri,
				targetType: input.targetType,
				projectId: input.projectId,
				repositoryUrl: input.repositoryUrl,
				repositoryOwner: input.repositoryOwner,
				repositoryName: input.repositoryName,
				defaultBranch: input.defaultBranch,
				roleTag: input.roleTag,
			});

			// Generate authorization URL
			const authorizationUrl = getGitHubOAuthUrl(
				clientId,
				input.redirectUri,
				state,
			);

			return { authorizationUrl };
		}),

	/**
	 * Handle GitHub OAuth callback
	 * This is a public procedure because it's called by GitHub's redirect
	 */
	callback: publicProcedure
		.use(requirePermission(Permissions.INTEGRATION_USE))
		.route({
			method: "GET",
			path: "/integrations/github/oauth/callback",
			tags: ["Integrations", "GitHub"],
			summary: "Handle GitHub OAuth callback",
		})
		.input(
			z.object({
				code: z.string().optional(),
				state: z.string().optional(),
				error: z.string().optional(),
				error_description: z.string().optional(),
			}),
		)
		.output(
			z.object({
				success: z.boolean(),
				message: z.string(),
				returnUrl: z.string().optional(),
			}),
		)
		.handler(async ({ input }) => {
			// Handle OAuth errors from GitHub
			if (input.error) {
				return {
					success: false,
					message: input.error_description || input.error,
				};
			}

			if (!input.state || !input.code) {
				return {
					success: false,
					message: "Missing state or code parameter",
				};
			}

			// Decode and verify state
			const state = decodeOAuthState(input.state);
			if (!state) {
				return {
					success: false,
					message:
						"Invalid or expired OAuth state. Please try again.",
				};
			}

			if (state.provider !== "github") {
				return {
					success: false,
					message: "Invalid OAuth provider in state",
				};
			}

			const { clientId, clientSecret } = getGitHubConfig();
			if (!clientId || !clientSecret) {
				return {
					success: false,
					message: "GitHub OAuth not configured on server",
				};
			}

			try {
				// Exchange code for access token
				// Use the same redirectUri that was used in the initial request (stored in state)
				const redirectUri =
					state.redirectUri ||
					`${process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL}/api/integrations/github/oauth/callback`;
				const tokenResponse = await exchangeCodeForToken(
					input.code,
					clientId,
					clientSecret,
					redirectUri,
				);

				// Get GitHub user info
				const githubUser = await getGitHubUser(
					tokenResponse.access_token,
				);

				// Route credentials based on targetType in the OAuth state.
				// This branching happens here (in the callback) rather than in a separate
				// handler because: (1) GitHub redirects to a single callback URL — we can't
				// have two callbacks, (2) the OAuth state already carries all the routing
				// information (targetType, projectId), and (3) the token exchange logic is
				// identical regardless of where the credentials are stored.
				if (state.targetType === "project") {
					// Fail explicitly if required project fields are missing
					if (
						!state.projectId ||
						!state.repositoryOwner ||
						!state.repositoryName
					) {
						return {
							success: false,
							message:
								"Missing project integration fields (projectId, repositoryOwner, or repositoryName)",
						};
					}

					// Defense in depth for states minted before the START-path
					// host pin: the stored URL drives authenticated worker-side
					// git clones, so it must name github.com — mirroring the
					// GitLab callback's pin.
					if (
						state.repositoryUrl &&
						new URL(state.repositoryUrl).hostname.toLowerCase() !==
							"github.com"
					) {
						return {
							success: false,
							message:
								"Only github.com repositories are supported for GitHub connections",
						};
					}

					// Verify the user has permission to edit project settings.
					// Mirrors the `requireProjectPermission(PROJECT_SETTINGS_EDIT)`
					// middleware used by the connect/disconnect procedures — see
					// `packages/api/lib/project-permissions.ts`. Unlike a
					// `ProjectMember`-only check, this also honors the org-role
					// matrix (org owner/admin without an explicit ProjectMember
					// row).
					const allowed = await userHasProjectPermission(
						state.projectId,
						state.userId,
						Permissions.PROJECT_SETTINGS_EDIT,
					);
					if (!allowed) {
						return {
							success: false,
							message:
								"You don't have permission to configure repository integrations for this project",
						};
					}

					const { connectedStatus } =
						await handleProjectTargetCallback({
							state: {
								userId: state.userId,
								organizationId: state.organizationId ?? null,
								projectId: state.projectId,
								repositoryUrl: state.repositoryUrl,
								repositoryOwner: state.repositoryOwner,
								repositoryName: state.repositoryName,
								defaultBranch: state.defaultBranch,
								roleTag: state.roleTag,
								targetType: "project",
							},
							tokenResponse,
							githubUser,
						});

					// AC1's "told at connect time": the popup and toast carry the
					// verdict, not just the success — the badge only appears once
					// the invalidated list query resolves.
					const repoSlug = `${state.repositoryOwner}/${state.repositoryName}`;
					const message =
						connectedStatus === "REPO_UNAVAILABLE"
							? `Connected ${repoSlug} — but Fabric cannot read it. Install the GitHub App on the repository, or connect it with a personal access token from its row menu.`
							: connectedStatus === "TOKEN_EXPIRED"
								? `Connected ${repoSlug} — but the credentials were rejected as invalid or expired. Reconnect from Settings ▸ Development.`
								: `Connected GitHub repository: ${repoSlug}`;

					return {
						success: true,
						message,
						returnUrl: state.returnUrl,
					};
				}

				// User-level integration: store in WorkflowIntegration (existing behavior)
				const credentials = JSON.stringify({
					access_token: tokenResponse.access_token,
					token_type: tokenResponse.token_type,
					scope: tokenResponse.scope,
					refresh_token: tokenResponse.refresh_token,
					expires_in: tokenResponse.expires_in,
					refresh_token_expires_in:
						tokenResponse.refresh_token_expires_in,
					token_obtained_at: new Date().toISOString(),
				});

				// IMPORTANT: Use null explicitly for personal context.
				// state.organizationId is undefined when there is no org —
				// passing undefined to Prisma causes it to skip the field
				// entirely, which breaks the XOR tenant isolation pattern.
				const orgIdForQuery = state.organizationId ?? null;

				const existingIntegration =
					await db.workflowIntegration.findFirst({
						where: {
							userId: state.userId,
							provider: "GITHUB",
							...(orgIdForQuery
								? { organizationId: orgIdForQuery }
								: { organizationId: null }),
						},
					});

				const settingsData = {
					githubUserId: githubUser.id,
					githubLogin: githubUser.login,
					githubName: githubUser.name,
					githubAvatarUrl: githubUser.avatar_url,
					scope: tokenResponse.scope,
					connectedAt: new Date().toISOString(),
					hasRefreshToken: !!tokenResponse.refresh_token,
					tokenExpiresAt: tokenResponse.expires_in
						? new Date(
								Date.now() + tokenResponse.expires_in * 1000,
							).toISOString()
						: null,
				};

				if (existingIntegration) {
					// Update existing integration
					await db.workflowIntegration.update({
						where: { id: existingIntegration.id },
						data: {
							name: `GitHub: ${githubUser.login}`,
							credentials: encryptApiKey(credentials),
							settings: settingsData,
							isActive: true,
							updatedAt: new Date(),
						},
					});
				} else {
					// Create new integration.
					// IMPORTANT: Pass orgIdForQuery (null for personal context),
					// never the raw state.organizationId (which can be undefined).
					await db.workflowIntegration.create({
						data: {
							userId: state.userId,
							organizationId: orgIdForQuery,
							provider: "GITHUB",
							name: `GitHub: ${githubUser.login}`,
							credentials: encryptApiKey(credentials),
							settings: settingsData,
							isActive: true,
						},
					});
				}

				// Auto-heal any EXPIRED DataConnection for this provider.
				// When actions are disconnected the DataConnection is set to EXPIRED,
				// so reconnecting actions should restore the search connection too.
				// The schema documents `accessToken` as encrypted-at-rest (SOC 2
				// CC6.1); store ciphertext to match — readers decrypt-with-passthrough
				// via the data-connections query layer. Mirrors the GitLab auto-heal
				// in `gitlab-oauth.ts`, which was already consistent.
				await db.dataConnection.updateMany({
					where: {
						userId: state.userId,
						provider: "GITHUB",
						status: "EXPIRED",
						...(orgIdForQuery
							? { organizationId: orgIdForQuery }
							: { organizationId: null }),
					},
					data: {
						accessToken: encryptApiKey(tokenResponse.access_token),
						status: "CONNECTED",
					},
				});

				return {
					success: true,
					message: `Connected GitHub account: ${githubUser.login}`,
					returnUrl: state.returnUrl,
				};
			} catch (error) {
				console.error("GitHub OAuth error:", error);
				return {
					success: false,
					message:
						error instanceof Error
							? error.message
							: "GitHub OAuth failed",
				};
			}
		}),

	/**
	 * Get current GitHub connection status
	 *
	 * IMPORTANT: organizationId must be explicitly passed for proper tenant isolation:
	 * - Pass the org ID string when in organization context
	 * - Pass null explicitly when in personal context
	 * - DO NOT rely on session.activeOrganizationId (can have stale values)
	 */
	status: tenantProtectedProcedure
		.use(requirePermission(Permissions.INTEGRATION_READ))
		.route({
			method: "GET",
			path: "/integrations/github/status",
			tags: ["Integrations", "GitHub"],
			summary: "Get GitHub connection status",
		})
		.input(
			z.object({
				organizationId: z.string().nullable().optional(),
			}),
		)
		.output(
			z.object({
				connected: z.boolean(),
				login: z.string().optional(),
				name: z.string().nullable().optional(),
				avatarUrl: z.string().optional(),
				scope: z.string().optional(),
				connectedAt: z.string().optional(),
			}),
		)
		.handler(async ({ input, context }) => {
			const userId = context.user.id;
			// Use explicit organizationId from input for proper tenant isolation
			// Only fall back to session if input is undefined (not explicitly passed)
			const organizationId =
				input.organizationId !== undefined
					? input.organizationId
					: context.session.activeOrganizationId;

			const integration = await db.workflowIntegration.findFirst({
				where: {
					userId,
					provider: "GITHUB",
					isActive: true,
					...(organizationId
						? { organizationId }
						: { organizationId: null }),
				},
			});

			if (!integration) {
				return { connected: false };
			}

			const settings = integration.settings as Record<
				string,
				unknown
			> | null;

			return {
				connected: true,
				login: settings?.githubLogin as string | undefined,
				name: settings?.githubName as string | null | undefined,
				avatarUrl: settings?.githubAvatarUrl as string | undefined,
				scope: settings?.scope as string | undefined,
				connectedAt: settings?.connectedAt as string | undefined,
			};
		}),

	/**
	 * Disconnect GitHub
	 *
	 * IMPORTANT: organizationId must be explicitly passed for proper tenant isolation
	 */
	disconnect: tenantProtectedProcedure
		.use(requirePermission(Permissions.INTEGRATION_DISCONNECT))
		.route({
			method: "POST",
			path: "/integrations/github/disconnect",
			tags: ["Integrations", "GitHub"],
			summary: "Disconnect GitHub integration",
		})
		.input(
			z.object({
				organizationId: z.string().nullable().optional(),
			}),
		)
		.output(z.object({ success: z.boolean() }))
		.handler(async ({ input, context }) => {
			const userId = context.user.id;
			// Use explicit organizationId from input for proper tenant isolation
			const organizationId =
				input.organizationId !== undefined
					? input.organizationId
					: context.session.activeOrganizationId;

			// Revoke the token with GitHub
			const integrations = await db.workflowIntegration.findMany({
				where: {
					userId,
					provider: "GITHUB",
					isActive: true,
					...(organizationId
						? { organizationId }
						: { organizationId: null }),
				},
			});

			// Use the SAME config the connect flow uses. Previously this read
			// GITHUB_CLIENT_ID/SECRET while connect reads FABRIC_GITHUB_* (see
			// getGitHubConfig), so in every real deployment these were unset and
			// the revoke loop below was silently skipped — leaving OAuth tokens
			// live at GitHub after disconnect. Fall back to the legacy names for
			// any deployment that still sets them.
			const githubClientId =
				process.env.FABRIC_GITHUB_CLIENT_ID ??
				process.env.GITHUB_CLIENT_ID;
			const githubClientSecret =
				process.env.FABRIC_GITHUB_CLIENT_SECRET ??
				process.env.GITHUB_CLIENT_SECRET;

			if (githubClientId && githubClientSecret) {
				for (const integration of integrations) {
					if (integration.credentials) {
						try {
							const { decryptApiKey } = await import(
								"@repo/utils"
							);
							const credJson = decryptApiKey(
								integration.credentials,
							);
							const creds = JSON.parse(credJson) as {
								access_token?: string;
							};
							if (creds.access_token) {
								await fetch(
									`https://api.github.com/applications/${githubClientId}/token`,
									{
										method: "DELETE",
										headers: {
											Authorization: `Basic ${Buffer.from(`${githubClientId}:${githubClientSecret}`).toString("base64")}`,
											Accept: "application/vnd.github.v3+json",
											"Content-Type": "application/json",
										},
										body: JSON.stringify({
											access_token: creds.access_token,
										}),
									},
								);
							}
						} catch {
							// Token revocation failure is non-fatal
						}
					}
				}
			}

			await db.workflowIntegration.updateMany({
				where: {
					userId,
					provider: "GITHUB",
					...(organizationId
						? { organizationId }
						: { organizationId: null }),
				},
				data: {
					isActive: false,
				},
			});

			// Also disconnect the corresponding DataConnection (GitHub shares the same OAuth app)
			await db.dataConnection.updateMany({
				where: {
					userId,
					provider: "GITHUB",
					...(organizationId
						? { organizationId }
						: { organizationId: null }),
				},
				data: {
					status: "EXPIRED",
				},
			});

			return { success: true };
		}),

	/**
	 * List user's GitHub repositories
	 *
	 * IMPORTANT: organizationId must be explicitly passed for proper tenant isolation
	 */
	listRepos: tenantProtectedProcedure
		.use(requirePermission(Permissions.INTEGRATION_READ))
		.route({
			method: "GET",
			path: "/integrations/github/repos",
			tags: ["Integrations", "GitHub"],
			summary: "List GitHub repositories",
		})
		.input(
			z.object({
				page: z.number().optional().default(1),
				perPage: z.number().optional().default(30),
				organizationId: z.string().nullable().optional(),
			}),
		)
		.output(
			z.object({
				repos: z.array(
					z.object({
						id: z.number(),
						name: z.string(),
						fullName: z.string(),
						owner: z.string(),
						private: z.boolean(),
						defaultBranch: z.string(),
						description: z.string().nullable(),
						url: z.string(),
					}),
				),
			}),
		)
		.handler(async ({ input, context }) => {
			const userId = context.user.id;
			// Use explicit organizationId from input for proper tenant isolation
			const organizationId =
				input.organizationId !== undefined
					? input.organizationId
					: context.session.activeOrganizationId;

			// Refresh-aware: a GitHub App user token expires after 8 hours, so
			// reading `credentials.access_token` directly left the repo picker
			// empty for anyone who connected more than a day ago.
			const accessToken = await getGitHubToken({
				userId,
				organizationId: organizationId ?? undefined,
			});

			if (!accessToken) {
				throw new ORPCError("BAD_REQUEST", {
					message:
						"GitHub not connected. Please connect your GitHub account first.",
				});
			}

			const { listGitHubRepos } = await import("../lib/github-oauth");
			const repos = await listGitHubRepos(
				accessToken,
				input.page,
				input.perPage,
			);

			return {
				repos: repos.map((repo) => ({
					id: repo.id,
					name: repo.name,
					fullName: repo.full_name,
					owner: repo.owner.login,
					private: repo.private,
					defaultBranch: repo.default_branch,
					description: repo.description,
					url: repo.html_url,
				})),
			};
		}),

	/**
	 * List branches for a GitHub repository
	 *
	 * IMPORTANT: organizationId must be explicitly passed for proper tenant isolation
	 */
	listBranches: tenantProtectedProcedure
		.use(requirePermission(Permissions.INTEGRATION_READ))
		.route({
			method: "GET",
			path: "/integrations/github/branches",
			tags: ["Integrations", "GitHub"],
			summary: "List branches for a GitHub repository",
		})
		.input(
			z.object({
				owner: z.string(),
				repo: z.string(),
				organizationId: z.string().nullable().optional(),
			}),
		)
		.output(
			z.object({
				branches: z.array(
					z.object({
						name: z.string(),
						protected: z.boolean(),
					}),
				),
			}),
		)
		.handler(async ({ input, context }) => {
			const userId = context.user.id;
			const organizationId =
				input.organizationId !== undefined
					? input.organizationId
					: context.session.activeOrganizationId;

			const accessToken = await getGitHubToken({
				userId,
				organizationId: organizationId ?? undefined,
			});

			if (!accessToken) {
				throw new ORPCError("BAD_REQUEST", {
					message:
						"GitHub not connected. Please connect your GitHub account first.",
				});
			}

			const branches = await listGitHubBranches(
				accessToken,
				input.owner,
				input.repo,
			);

			return {
				branches: branches.map((b) => ({
					name: b.name,
					protected: b.protected,
				})),
			};
		}),
};

/**
 * Project-target branch of the GitHub OAuth callback.
 *
 * Pure helper exported so it can be unit-tested in isolation without spinning
 * up an oRPC context, mirroring `gitlab-oauth.ts`'s helper of the same name.
 * The parent callback procedure retains responsibility for validating the
 * required state fields (projectId, repositoryOwner, repositoryName) and
 * checking PROJECT_SETTINGS_EDIT permission before calling this.
 *
 * Upsert matches the compound unique key
 * [projectId, provider, repositoryOwner, repositoryName] so re-auth flows
 * update the existing row rather than creating duplicates.
 */
export async function handleProjectTargetCallback(args: {
	state: {
		userId: string;
		organizationId?: string | null;
		projectId: string;
		repositoryUrl?: string;
		repositoryOwner: string;
		repositoryName: string;
		defaultBranch?: string;
		roleTag?: string;
		targetType: "project";
	};
	tokenResponse: GitHubTokenResponse;
	githubUser: GitHubUser;
}): Promise<{
	connectedStatus: "ACTIVE" | "TOKEN_EXPIRED" | "REPO_UNAVAILABLE";
}> {
	const { state, tokenResponse, githubUser } = args;

	// Observe the REPOSITORY, not just the token. The exchange and GET /user
	// above prove the credential is alive; only a repo-scoped probe proves
	// Fabric can work with this repository — the two come apart when the app
	// is not installed on it, and writing ACTIVE from the token result alone
	// is what let an unreadable repo wear a green check (AC1).
	const { outcome: accessOutcome, defaultBranch: probedDefaultBranch } =
		await verifyRepositoryAccess({
			provider: "GITHUB",
			token: tokenResponse.access_token,
			repositoryUrl: `https://github.com/${state.repositoryOwner}/${state.repositoryName}`,
			owner: state.repositoryOwner,
			repo: state.repositoryName,
		});
	const verdict = integrationStatusForRepoAccess(accessOutcome, "GITHUB");

	const tokenExpiresAt = tokenResponse.expires_in
		? new Date(Date.now() + tokenResponse.expires_in * 1000)
		: null;

	const integrationData = {
		encryptedAccessToken: encryptApiKey(tokenResponse.access_token),
		encryptedRefreshToken: tokenResponse.refresh_token
			? encryptApiKey(tokenResponse.refresh_token)
			: null,
		tokenExpiresAt: tokenExpiresAt,
		tokenScopes: tokenResponse.scope ? tokenResponse.scope.split(",") : [],
		status: verdict.status,
		lastError: verdict.lastError,
		// The upsert matches on the repo identity only, so reconnecting over a
		// PAT-connected row would otherwise store an OAuth token that readers
		// never use (repo-auth prefers the stored PAT whenever authMethod is
		// PAT) while presenting the row as healthy OAuth. Make the conversion
		// explicit: the row becomes OAuth-backed and the PAT is dropped.
		authMethod: "OAUTH" as const,
		encryptedPat: null,
		azureOrganization: null,
		// Reconnect supersedes any earlier refresh-token rejection; clearing it
		// returns the row to the scheduled health check's sweep.
		refreshTokenRejectedAt: null,
		// A re-authenticated credential must start with a full retirement
		// budget: a stale count would let one failed sweep retire this row.
		probeFailCount: 0,
	};

	// Upsert: update if integration already exists (e.g. re-auth), otherwise create
	const existing = await db.projectRepositoryIntegration.findFirst({
		where: {
			projectId: state.projectId,
			provider: "GITHUB",
			repositoryOwner: state.repositoryOwner,
			repositoryName: state.repositoryName,
		},
	});

	const resolvedBranch = await resolveDefaultBranch({
		// The probe's payload already carries default_branch on success —
		// passing it short-circuits a second identical fetch.
		providedBranch: state.defaultBranch ?? probedDefaultBranch,
		provider: "GITHUB",
		token: tokenResponse.access_token,
		repositoryUrl: `https://github.com/${state.repositoryOwner}/${state.repositoryName}`,
		owner: state.repositoryOwner,
		repo: state.repositoryName,
	});

	let integrationId: string;

	if (existing) {
		await db.projectRepositoryIntegration.update({
			where: { id: existing.id },
			data: integrationData,
		});
		integrationId = existing.id;
	} else {
		const created = await createProjectRepoIntegration({
			projectId: state.projectId,
			provider: "GITHUB",
			authMethod: "OAUTH",
			repositoryUrl:
				state.repositoryUrl ??
				`https://github.com/${state.repositoryOwner}/${state.repositoryName}`,
			repositoryOwner: state.repositoryOwner,
			repositoryName: state.repositoryName,
			defaultBranch: resolvedBranch,
			roleTag: state.roleTag ?? null,
			encryptedAccessToken: integrationData.encryptedAccessToken,
			encryptedRefreshToken:
				integrationData.encryptedRefreshToken ?? undefined,
			tokenExpiresAt: integrationData.tokenExpiresAt ?? undefined,
			tokenScopes: integrationData.tokenScopes,
			status: integrationData.status,
			lastError: integrationData.lastError,
			configuredByUserId: state.userId,
		});
		integrationId = created.id;
	}

	await syncLegacyProjectRepoOnConnect(
		state.projectId,
		state.repositoryUrl ??
			`https://github.com/${state.repositoryOwner}/${state.repositoryName}`,
		state.repositoryOwner,
		state.repositoryName,
		resolvedBranch,
	);

	// Best-effort: index the newly connected repo (no-op unless
	// FEATURE_CODE_INDEXING + codeSearchEnabled).
	await startCodeIndexingForProject({
		projectId: state.projectId,
		userId: state.userId,
		organizationId: state.organizationId ?? null,
		repositoryIntegrationId: integrationId,
	}).catch((error) => {
		console.error(
			"[github-oauth] Failed to auto-start code indexing:",
			error,
		);
	});

	await logRepoIntegrationActivity({
		projectId: state.projectId,
		userId: state.userId,
		userName: githubUser.login,
		organizationId: state.organizationId ?? null,
		activityType: "repo_integration_configured",
		repositoryName: `${state.repositoryOwner}/${state.repositoryName}`,
		metadata: {
			provider: "GITHUB",
			authMethod: "OAUTH",
			githubLogin: githubUser.login,
		},
	});

	return { connectedStatus: verdict.status };
}
