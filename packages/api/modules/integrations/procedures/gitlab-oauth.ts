/**
 * GitLab OAuth Procedures
 *
 * Handles GitLab OAuth flow for task agent integration.
 * Stores OAuth tokens in WorkflowIntegration model.
 * Mirrors the GitHub OAuth procedures pattern.
 */

import { ORPCError } from "@orpc/server";
import {
	integrationStatusForRepoAccess,
	resolveDefaultBranch,
	verifyRepositoryAccess,
} from "@repo/connectors";
import {
	db,
	getProjectMemberRole,
	logRepoIntegrationActivity,
	type Prisma,
	syncLegacyProjectRepoOnConnect,
} from "@repo/database";
import {
	GitLabApiError,
	getValidGitLabAccessToken,
	gitlabFetch,
} from "@repo/integrations/gitlab";
import {
	hasPermission,
	Permissions as Perms,
	resolveProjectPermissions,
} from "@repo/permissions";
import { triggerMcpToolIngestion } from "@repo/temporal";
import { encryptApiKey } from "@repo/utils";
import { z } from "zod";
import {
	Permissions,
	publicProcedure,
	requireInputOrgPermission,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { startCodeIndexingForProject } from "../../projects/lib/code-indexing-trigger";
import { enableGitLabPMForProject } from "../lib/enable-gitlab-pm-for-project";
import {
	exchangeCodeForToken,
	type GitLabUser,
	generatePkce,
	getGitLabOAuthUrl,
	getGitLabUser,
	listGitLabBranches,
	listGitLabProjects,
	recordToolIngestError,
	refreshGitLabToken,
	resolveOrgIdForQuery,
} from "../lib/gitlab-oauth";
import {
	GitLabIntegrationNotConnectedError,
	recheckGitlabCapabilities,
} from "../lib/gitlab-recheck";
import {
	GitLabReauthRequiredError,
	persistGitLabToken,
} from "../lib/gitlab-token";
import {
	getOAuthCredentialsWithDb,
	getOAuthProvider,
} from "../lib/oauth-providers";
import { decodeOAuthState, encodeOAuthState } from "../lib/oauth-state";

/**
 * Get GitLab OAuth configuration from environment OR database.
 * Supports multi-tenant: env vars for single-tenant, DB for per-org credentials.
 */
async function getGitLabConfigWithDb(
	userId?: string,
	organizationId?: string | null,
) {
	const provider = getOAuthProvider("GITLAB");
	if (!provider) {
		return { clientId: undefined, clientSecret: undefined };
	}
	return getOAuthCredentialsWithDb(
		provider,
		userId,
		organizationId ?? undefined,
	);
}

/**
 * True when GitLab turned the `/user` probe away rather than being unreachable
 * or unhappy for reasons of its own: a 401 (the access token we sent is not
 * usable right now) or a 403 (scope, user policy, or an instance/admin
 * restriction). Reconnecting is the reliable way out of both, so reconcile
 * answers NEEDS_REAUTH and lets the UI offer the full Connect flow.
 *
 * This decides that ADVISORY status only. It is NOT proof that the stored
 * grant is dead — an access token is routinely stale while its refresh token
 * is perfectly good, and a 403 may be an administrator restriction unrelated
 * to the grant. So it must never gate a write to `MCPConfig.needsReauth`,
 * which is an enforced circuit breaker: a config carrying it is refused at MCP
 * client creation and filtered out of tool discovery, and only a fresh OAuth
 * grant clears it.
 *
 * A 5xx, a 429, a network error or a parse failure say nothing at all about
 * the credential; the caller re-throws those.
 */
function isGitLabProbeRejection(err: unknown): boolean {
	// A typed permanent-grant failure would warrant the same prompt. It cannot
	// reach here today — `gitlabFetch` performs no refresh and only ever
	// throws `GitLabApiError` — but the mapping stays correct if a refreshing
	// probe is ever wired in.
	if (err instanceof GitLabReauthRequiredError) {
		return true;
	}
	return (
		err instanceof GitLabApiError &&
		(err.status === 401 || err.status === 403)
	);
}

export const gitlabOAuthProcedures = {
	/**
	 * Check if GitLab OAuth is configured
	 */
	isConfigured: tenantProtectedProcedure
		.use(requirePermission(Permissions.INTEGRATION_READ))
		.route({
			method: "GET",
			path: "/integrations/gitlab/oauth/configured",
			tags: ["Integrations", "GitLab"],
			summary: "Check if GitLab OAuth is configured",
		})
		.output(z.object({ configured: z.boolean() }))
		.handler(async ({ context }) => {
			const { clientId, clientSecret } = await getGitLabConfigWithDb(
				context.user.id,
				context.session.activeOrganizationId,
			);
			return { configured: !!(clientId && clientSecret) };
		}),

	/**
	 * Start GitLab OAuth flow
	 *
	 * IMPORTANT: organizationId must be explicitly passed for proper tenant isolation:
	 * - Pass the org ID string when in organization context
	 * - Pass null explicitly when in personal context
	 */
	start: tenantProtectedProcedure
		.use(requireInputOrgPermission(Permissions.INTEGRATION_USE))
		.route({
			method: "POST",
			path: "/integrations/gitlab/oauth/start",
			tags: ["Integrations", "GitLab"],
			summary: "Start GitLab OAuth flow",
		})
		.input(
			z.object({
				redirectUri: z.string().url(),
				returnUrl: z
					.string()
					.refine(
						(url) => url.startsWith("/") && !url.startsWith("//"),
						{
							message:
								"returnUrl must be a relative path (starts with '/' but not '//')",
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
			const { clientId } = await getGitLabConfigWithDb(
				context.user.id,
				input.organizationId ?? context.session.activeOrganizationId,
			);

			if (!clientId) {
				throw new ORPCError("BAD_REQUEST", {
					message:
						"GitLab OAuth not configured. Please set GITLAB_CLIENT_ID environment variable.",
				});
			}

			const userId = context.user.id;
			// Use explicit organizationId from input for proper tenant isolation
			const organizationId =
				input.organizationId !== undefined
					? input.organizationId
					: context.session.activeOrganizationId;

			// A project-target flow stores repositoryUrl in signed state, and the
			// callback later derives authenticated API calls from it. Pin it to
			// gitlab.com at START — the same SSRF guard the PAT connect path has —
			// so a crafted URL can never steer those token-carrying requests at an
			// internal host. (User-target flows don't carry a repositoryUrl.)
			let repositoryUrlHost: string | null = null;
			if (input.targetType === "project" && input.repositoryUrl) {
				try {
					repositoryUrlHost = new URL(
						input.repositoryUrl,
					).hostname.toLowerCase();
				} catch {
					repositoryUrlHost = null;
				}
				if (repositoryUrlHost !== "gitlab.com") {
					throw new ORPCError("BAD_REQUEST", {
						message:
							"Only gitlab.com repositories are supported for GitLab connections",
					});
				}
			}

			// PKCE (S256): bind this authorization request to the
			// verifier stored in our signed state so an intercepted code
			// cannot be redeemed by a third party. See generatePkce().
			const { codeVerifier, codeChallenge } = generatePkce();

			// Generate signed state (include redirectUri so callback uses same value)
			const state = encodeOAuthState({
				userId,
				organizationId: organizationId ?? undefined,
				provider: "gitlab",
				returnUrl: input.returnUrl,
				redirectUri: input.redirectUri,
				targetType: input.targetType,
				projectId: input.projectId,
				repositoryUrl: input.repositoryUrl,
				repositoryOwner: input.repositoryOwner,
				repositoryName: input.repositoryName,
				defaultBranch: input.defaultBranch,
				roleTag: input.roleTag,
				codeVerifier,
			});

			// Generate authorization URL
			const authorizationUrl = getGitLabOAuthUrl(
				clientId,
				input.redirectUri,
				state,
				codeChallenge,
			);

			return { authorizationUrl };
		}),

	/**
	 * Handle GitLab OAuth callback
	 * This is a public procedure because it's called by GitLab's redirect
	 */
	callback: publicProcedure
		.use(requirePermission(Permissions.INTEGRATION_USE))
		.route({
			method: "GET",
			path: "/integrations/gitlab/oauth/callback",
			tags: ["Integrations", "GitLab"],
			summary: "Handle GitLab OAuth callback",
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
			// Handle OAuth errors from GitLab
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

			if (state.provider !== "gitlab") {
				return {
					success: false,
					message: "Invalid OAuth provider in state",
				};
			}

			const { clientId, clientSecret } = await getGitLabConfigWithDb(
				state.userId,
				state.organizationId,
			);
			if (!clientId || !clientSecret) {
				return {
					success: false,
					message: "GitLab OAuth not configured on server",
				};
			}

			try {
				// Exchange code for access token
				// Use the same redirectUri that was used in the initial request (stored in state)
				const redirectUri =
					state.redirectUri ||
					`${process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL}/api/integrations/gitlab/oauth/callback`;
				// PKCE: pass the verifier stashed in our signed state. Older
				// in-flight states (issued before PKCE rollout) won't have
				// `codeVerifier`; fall through without it so those callbacks
				// still complete during the deployment window.
				const tokenResponse = await exchangeCodeForToken(
					input.code,
					clientId,
					clientSecret,
					redirectUri,
					state.codeVerifier,
				);

				// Get GitLab user info
				const gitlabUser = await getGitLabUser(
					tokenResponse.access_token,
				);

				// Route credentials based on targetType in the OAuth state.
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
					// host pin: the callback's later API calls carry a live token,
					// so the stored URL must still be gitlab.com.
					if (
						state.repositoryUrl &&
						new URL(state.repositoryUrl).hostname.toLowerCase() !==
							"gitlab.com"
					) {
						return {
							success: false,
							message:
								"Only gitlab.com repositories are supported for GitLab connections",
						};
					}

					// Mirror the gate on `repository-integrations/connect.ts` so
					// PROJECT_ADMIN+ (who initiated the OAuth flow) can complete it.
					const role = await getProjectMemberRole(
						state.projectId,
						state.userId,
					);
					const granted = resolveProjectPermissions(role);
					if (!hasPermission(granted, Perms.PROJECT_SETTINGS_EDIT)) {
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
								repositoryUrl:
									state.repositoryUrl ??
									`https://gitlab.com/${state.repositoryOwner}/${state.repositoryName}`,
								repositoryOwner: state.repositoryOwner,
								repositoryName: state.repositoryName,
								defaultBranch: state.defaultBranch,
								roleTag: state.roleTag,
								targetType: "project",
							},
							tokenResponse,
							gitlabUser,
						});

					// AC1's "told at connect time" — same composition as the
					// GitHub callback.
					const repoSlug = `${state.repositoryOwner}/${state.repositoryName}`;
					const message =
						connectedStatus === "REPO_UNAVAILABLE"
							? `Connected ${repoSlug} — but Fabric cannot read it. Install the provider app on the repository, or connect it with a personal access token from its row menu.`
							: connectedStatus === "TOKEN_EXPIRED"
								? `Connected ${repoSlug} — but the credentials were rejected as invalid or expired. Reconnect from Settings ▸ Development.`
								: `Connected GitLab repository: ${repoSlug}`;

					return {
						success: true,
						message,
						returnUrl: state.returnUrl,
					};
				}

				// IMPORTANT: Use null explicitly for personal context.
				// state.organizationId is undefined when there is no org --
				// passing undefined to Prisma causes it to skip the field
				// entirely, which breaks the XOR tenant isolation pattern.
				// resolveOrgIdForQuery coerces undefined/empty-string to null.
				const orgIdForQuery = resolveOrgIdForQuery(state);

				// Unified dual-write: populates both WorkflowIntegration AND
				// MCPConfig so the official GitLab MCP server (`gitlab-official`)
				// can resolve the user from the same token used by PM features. See
				// `docs/superpowers/specs/2026-05-14-gitlab-oauth-unification-design.md`.
				const { workflowIntegrationId } = await persistGitLabToken(
					db as never,
					{
						userId: state.userId,
						organizationId: orgIdForQuery,
						token: {
							accessToken: tokenResponse.access_token,
							refreshToken: tokenResponse.refresh_token ?? null,
							expiresAt: tokenResponse.expires_in
								? new Date(
										Date.now() +
											tokenResponse.expires_in * 1000,
									)
								: null,
							scopes: tokenResponse.scope
								? tokenResponse.scope.split(" ")
								: ["api", "read_user"],
						},
						gitlabUser: {
							id: gitlabUser.id,
							username: gitlabUser.username,
							name: gitlabUser.name,
							avatarUrl: gitlabUser.avatar_url ?? null,
						},
						// The authorization-code exchange above just returned:
						// this is the one flow that holds a grant the user has
						// freshly authorized, so it is the one allowed to lift
						// the `needsReauth` breaker.
						freshGrant: true,
					},
				);
				const integrationRow = { id: workflowIntegrationId };

				// Auto-heal any EXPIRED DataConnection for this provider.
				// The schema documents `accessToken` as encrypted-at-rest (see
				// DataConnection model in schema.prisma); store ciphertext to
				// match. There is no current GitLab-specific reader of this
				// column — the WorkflowIntegration row is the source of truth.
				await db.dataConnection.updateMany({
					where: {
						userId: state.userId,
						provider: "GITLAB",
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

				// Trigger MCP tool ingestion for any GitLab MCP configs
				// that were waiting for OAuth credentials
				try {
					const gitlabMcpConfigs = await db.mCPConfig.findMany({
						where: {
							userId: state.userId,
							...(orgIdForQuery
								? { organizationId: orgIdForQuery }
								: { organizationId: null }),
							enabled: true,
							mcpServer: {
								key: "gitlab",
							},
						},
						include: { mcpServer: true },
					});

					for (const cfg of gitlabMcpConfigs) {
						await triggerMcpToolIngestion({
							mcpConfigId: cfg.id,
							serverName:
								cfg.displayName ||
								cfg.mcpServer?.name ||
								"GitLab",
							userId: state.userId,
							// Not a Prisma where-clause — temporal activity accepts optional string.
							organizationId: state.organizationId ?? undefined,
						});
					}
				} catch (err) {
					// Non-fatal: OAuth succeeded; ingestion failure is surfaced on the
					// integration row so the UI can show "retry tools" affordance.
					console.error(
						"[GitLab OAuth] Failed to trigger MCP tool ingestion",
						{ integrationId: integrationRow.id, error: err },
					);
					try {
						await recordToolIngestError({
							// `db as never`: PrismaClient's update method has a
							// generic signature returning a custom thenable; it is
							// not structurally assignable to the helper's narrowed
							// `(args: unknown) => Promise<unknown>` interface even
							// though it satisfies it at runtime. The cast is the
							// established pattern in this package for passing the
							// real PrismaClient to helpers with narrow db shapes.
							db: db as never,
							integrationId: integrationRow.id,
							error: err,
						});
					} catch (recordErr) {
						// If we cannot even record the error, log loudly — but still do not fail OAuth.
						console.error(
							"[GitLab OAuth] Failed to record tool ingestion error on integration row",
							{
								integrationId: integrationRow.id,
								error: recordErr,
							},
						);
					}
				}

				return {
					success: true,
					message: `Connected GitLab account: ${gitlabUser.username}`,
					returnUrl: state.returnUrl,
				};
			} catch (error) {
				console.error("GitLab OAuth error:", error);
				return {
					success: false,
					message:
						error instanceof Error
							? error.message
							: "GitLab OAuth failed",
				};
			}
		}),

	/**
	 * Get current GitLab connection status
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
			path: "/integrations/gitlab/status",
			tags: ["Integrations", "GitLab"],
			summary: "Get GitLab connection status",
		})
		.input(
			z.object({
				organizationId: z.string().nullable().optional(),
			}),
		)
		.output(
			z.object({
				connected: z.boolean(),
				username: z.string().optional(),
				name: z.string().nullable().optional(),
				avatarUrl: z.string().optional(),
				scope: z.string().optional(),
				connectedAt: z.string().optional(),
				needsReauth: z.boolean().optional(),
				settings: z
					.object({
						lastToolIngestError: z
							.object({
								message: z.string(),
								at: z.string(),
							})
							.optional(),
					})
					.optional(),
				// Transport-mode fields (populated after the first MCP probe)
				useOfficialMcp: z.boolean().optional(),
				mcpProbe: z
					.object({
						status: z.enum([
							"ok",
							"unauthorized",
							"not-found",
							"network-error",
							"timeout",
						]),
						httpStatus: z.number().nullable(),
						checkedAt: z.string(),
						baseUrl: z.string(),
					})
					.optional(),
			}),
		)
		.handler(async ({ input, context }) => {
			const userId = context.user.id;
			// Use explicit organizationId from input for proper tenant isolation
			const organizationId =
				input.organizationId !== undefined
					? input.organizationId
					: context.session.activeOrganizationId;

			const integration = await db.workflowIntegration.findFirst({
				where: {
					userId,
					provider: "GITLAB",
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

			const lastToolIngestError = settings?.lastToolIngestError as
				| { message: string; at: string }
				| undefined;

			// Also check the MCPConfig flag — refresh failures on either
			// side mark the same logical state.
			const mcp = await db.mCPConfig.findFirst({
				where: {
					userId,
					...(organizationId
						? { organizationId }
						: { organizationId: null }),
					mcpServer: { key: "gitlab" },
				},
				select: { needsReauth: true },
			});
			const needsReauth =
				Boolean(settings?.needsReauth) || Boolean(mcp?.needsReauth);

			return {
				connected: true,
				username: settings?.gitlabUsername as string | undefined,
				name: settings?.gitlabName as string | null | undefined,
				avatarUrl: settings?.gitlabAvatarUrl as string | undefined,
				scope: settings?.scope as string | undefined,
				connectedAt: settings?.connectedAt as string | undefined,
				needsReauth: needsReauth || undefined,
				settings: lastToolIngestError
					? { lastToolIngestError }
					: undefined,
				// Transport-mode fields (populated after the first MCP probe)
				useOfficialMcp:
					typeof settings?.useOfficialMcp === "boolean"
						? settings.useOfficialMcp
						: undefined,
				mcpProbe: (() => {
					const raw = settings?.mcpProbe as
						| {
								status: string;
								httpStatus: number | null;
								checkedAt: string;
								baseUrl: string;
						  }
						| undefined;
					if (
						!raw ||
						typeof raw.status !== "string" ||
						typeof raw.checkedAt !== "string"
					) {
						return undefined;
					}
					return raw as {
						status:
							| "ok"
							| "unauthorized"
							| "not-found"
							| "network-error"
							| "timeout";
						httpStatus: number | null;
						checkedAt: string;
						baseUrl: string;
					};
				})(),
			};
		}),

	/**
	 * Disconnect GitLab
	 *
	 * IMPORTANT: organizationId must be explicitly passed for proper tenant isolation
	 */
	disconnect: tenantProtectedProcedure
		.use(requirePermission(Permissions.INTEGRATION_DISCONNECT))
		.route({
			method: "POST",
			path: "/integrations/gitlab/disconnect",
			tags: ["Integrations", "GitLab"],
			summary: "Disconnect GitLab integration",
		})
		.input(
			z.object({
				organizationId: z.string().nullable().optional(),
			}),
		)
		.output(
			z.object({
				success: z.boolean(),
				revocationWarning: z.string().nullable().optional(),
			}),
		)
		.handler(async ({ input, context }) => {
			const userId = context.user.id;
			// Use explicit organizationId from input for proper tenant isolation
			const organizationId =
				input.organizationId !== undefined
					? input.organizationId
					: context.session.activeOrganizationId;

			// Revoke the token with GitLab
			const integrations = await db.workflowIntegration.findMany({
				where: {
					userId,
					provider: "GITLAB",
					isActive: true,
					...(organizationId
						? { organizationId }
						: { organizationId: null }),
				},
			});

			const { clientId, clientSecret } = await getGitLabConfigWithDb(
				userId,
				organizationId,
			);

			let revocationWarning: string | null = null;

			if (clientId && clientSecret) {
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
								// GitLab token revocation endpoint
								const revokeBody = new URLSearchParams({
									token: creds.access_token,
									client_id: clientId,
									client_secret: clientSecret,
								});
								const revokeResponse = await fetch(
									"https://gitlab.com/oauth/revoke",
									{
										method: "POST",
										headers: {
											"Content-Type":
												"application/x-www-form-urlencoded",
										},
										body: revokeBody.toString(),
									},
								);
								if (!revokeResponse.ok) {
									throw new Error(
										`Revocation returned ${revokeResponse.status}`,
									);
								}
							}
						} catch (err) {
							// Token revocation failure is non-fatal — local row is
							// still marked inactive. Surface a warning to the UI so
							// the user can manually revoke at gitlab.com.
							revocationWarning =
								"Local connection removed; GitLab-side revocation failed — visit gitlab.com/-/profile/applications to revoke manually.";
							console.error(
								"[GitLab disconnect] revocation failed:",
								err,
							);
						}
					}
				}
			}

			await db.workflowIntegration.updateMany({
				where: {
					userId,
					provider: "GITLAB",
					...(organizationId
						? { organizationId }
						: { organizationId: null }),
				},
				data: {
					isActive: false,
				},
			});

			// Also disconnect the corresponding DataConnection. Clear the
			// token so a revoked credential doesn't linger at rest.
			await db.dataConnection.updateMany({
				where: {
					userId,
					provider: "GITLAB",
					...(organizationId
						? { organizationId }
						: { organizationId: null }),
				},
				data: {
					status: "EXPIRED",
					accessToken: null,
				},
			});

			// Dual-disconnect: null out tokens on the corresponding MCPConfig
			// row so the GitLab MCP shim's `resolveUserFromBearer` stops
			// matching the revoked token. The MCPConfig row itself is kept
			// (preserves displayName, enabled flag, scopes) — a future
			// reconnect updates it in place via persistGitLabToken.
			await db.mCPConfig.updateMany({
				where: {
					userId,
					...(organizationId
						? { organizationId }
						: { organizationId: null }),
					mcpServer: { key: "gitlab" },
				},
				data: {
					encryptedAccessToken: null,
					accessTokenHash: null,
					encryptedRefreshToken: null,
					tokenExpiresAt: null,
					needsReauth: true,
				},
			});

			// Invalidate cached registry list so the tile flips back to
			// "Connect" immediately on next refresh.
			try {
				const { invalidateSystemServersCache } = await import(
					"../../../lib/mcp-registry-cache"
				);
				await invalidateSystemServersCache();
			} catch (err) {
				// Cache invalidation failure is non-fatal — entry will expire
				// from the cache's TTL within minutes.
				console.warn(
					"[GitLab disconnect] cache invalidation failed",
					err,
				);
			}

			return { success: true, revocationWarning };
		}),

	/**
	 * List user's GitLab projects
	 *
	 * IMPORTANT: organizationId must be explicitly passed for proper tenant isolation
	 */
	listProjects: tenantProtectedProcedure
		.use(requirePermission(Permissions.INTEGRATION_READ))
		.route({
			method: "GET",
			path: "/integrations/gitlab/projects",
			tags: ["Integrations", "GitLab"],
			summary: "List GitLab projects",
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
				projects: z.array(
					z.object({
						id: z.number(),
						name: z.string(),
						fullPath: z.string(),
						namespace: z.string(),
						visibility: z.string(),
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

			const integration = await db.workflowIntegration.findFirst({
				where: {
					userId,
					provider: "GITLAB",
					isActive: true,
					...(organizationId
						? { organizationId }
						: { organizationId: null }),
				},
			});

			if (!integration) {
				throw new ORPCError("BAD_REQUEST", {
					message:
						"GitLab not connected. Please connect your GitLab account first.",
				});
			}

			const { clientId, clientSecret } = await getGitLabConfigWithDb(
				userId,
				organizationId,
			);
			if (!clientId || !clientSecret) {
				throw new ORPCError("BAD_REQUEST", {
					message: "GitLab OAuth not configured on server",
				});
			}

			const accessToken = await getValidGitLabAccessToken({
				// See recordToolIngestError call site for cast rationale.
				db: db as never,
				integrationId: integration.id,
				clientId,
				clientSecret,
				refresh: refreshGitLabToken,
			});

			const projects = await listGitLabProjects(
				accessToken,
				input.page,
				input.perPage,
			);

			return {
				projects: projects.map((project) => ({
					id: project.id,
					name: project.name,
					fullPath: project.path_with_namespace,
					namespace: project.namespace.full_path,
					visibility: project.visibility,
					defaultBranch: project.default_branch,
					description: project.description,
					url: project.web_url,
				})),
			};
		}),

	/**
	 * List branches for a GitLab project
	 *
	 * IMPORTANT: organizationId must be explicitly passed for proper tenant isolation
	 */
	listBranches: tenantProtectedProcedure
		.use(requirePermission(Permissions.INTEGRATION_READ))
		.route({
			method: "GET",
			path: "/integrations/gitlab/branches",
			tags: ["Integrations", "GitLab"],
			summary: "List branches for a GitLab project",
		})
		.input(
			z.object({
				projectId: z.string(),
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

			const integration = await db.workflowIntegration.findFirst({
				where: {
					userId,
					provider: "GITLAB",
					isActive: true,
					...(organizationId
						? { organizationId }
						: { organizationId: null }),
				},
			});

			if (!integration) {
				throw new ORPCError("BAD_REQUEST", {
					message:
						"GitLab not connected. Please connect your GitLab account first.",
				});
			}

			const {
				clientId: branchClientId,
				clientSecret: branchClientSecret,
			} = await getGitLabConfigWithDb(userId, organizationId);
			if (!branchClientId || !branchClientSecret) {
				throw new ORPCError("BAD_REQUEST", {
					message: "GitLab OAuth not configured on server",
				});
			}

			const branchAccessToken = await getValidGitLabAccessToken({
				db: db as never,
				integrationId: integration.id,
				clientId: branchClientId,
				clientSecret: branchClientSecret,
				refresh: refreshGitLabToken,
			});

			const branches = await listGitLabBranches(
				branchAccessToken,
				input.projectId,
			);

			return {
				branches: branches.map((b) => ({
					name: b.name,
					protected: b.protected,
				})),
			};
		}),

	/**
	 * Retry MCP tool ingestion for GitLab
	 *
	 * Used by the UI to re-trigger ingestion when lastToolIngestError is present.
	 * Clears the lastToolIngestError marker on success.
	 */
	retryToolIngestion: tenantProtectedProcedure
		.use(requirePermission(Permissions.INTEGRATION_USE))
		.route({
			method: "POST",
			path: "/integrations/gitlab/oauth/retry-tool-ingestion",
			tags: ["Integrations", "GitLab"],
			summary: "Retry MCP tool ingestion for GitLab",
		})
		.input(z.object({ organizationId: z.string().nullable().optional() }))
		.output(z.object({ triggered: z.number() }))
		.handler(async ({ input, context }) => {
			const orgIdForQuery = resolveOrgIdForQuery({
				organizationId: input.organizationId ?? null,
			});
			const configs = await db.mCPConfig.findMany({
				where: {
					userId: context.user.id,
					...(orgIdForQuery
						? { organizationId: orgIdForQuery }
						: { organizationId: null }),
					enabled: true,
					mcpServer: { key: "gitlab" },
				},
				include: { mcpServer: true },
			});
			for (const cfg of configs) {
				await triggerMcpToolIngestion({
					mcpConfigId: cfg.id,
					serverName:
						cfg.displayName || cfg.mcpServer?.name || "GitLab",
					userId: context.user.id,
					organizationId: orgIdForQuery ?? undefined,
				});
			}
			// Clear the lastToolIngestError marker on the user's WorkflowIntegration.
			const integration = await db.workflowIntegration.findFirst({
				where: {
					userId: context.user.id,
					provider: "GITLAB",
					...(orgIdForQuery
						? { organizationId: orgIdForQuery }
						: { organizationId: null }),
				},
			});
			if (integration) {
				const settings = {
					...((integration.settings as Record<string, unknown>) ??
						{}),
				};
				delete settings.lastToolIngestError;
				await db.workflowIntegration.update({
					where: { id: integration.id },
					data: { settings: settings as Prisma.InputJsonValue },
				});
			}
			return { triggered: configs.length };
		}),

	/**
	 * Reconcile GitLab — populate the missing side WITHOUT a fresh OAuth
	 * dance. Used by users who have a token in one store (WorkflowIntegration
	 * OR MCPConfig) but not the other. Validates the existing token at
	 * GitLab (`GET /user`) and dual-writes via `persistGitLabToken`.
	 *
	 * Returns:
	 *   - { status: "RECONCILED" } — wrote the missing row
	 *   - { status: "ALREADY_BOTH" } — both rows already present
	 *   - { status: "NEEDS_REAUTH" } — GitLab turned the `/user` probe away
	 *     (401/403), or either stored credential (the primary `gitlab` row or
	 *     the `gitlab-official` one) was already condemned; either way the UI
	 *     should surface the full Connect flow. This status is
	 *     ADVISORY: it asks the user to reconnect, it does not report that the
	 *     stored grant has been condemned. Reconcile never writes the
	 *     `needsReauth` breaker itself — a probe rejection is not proof the
	 *     grant is dead, and only a fresh OAuth grant can clear that flag.
	 *
	 * Anything else — GitLab unreachable or erroring, a failed write —
	 * throws rather than returning a status. Those failures say nothing
	 * about the credential, and sending a user to reconnect a working
	 * integration is a dead end.
	 */
	reconcile: tenantProtectedProcedure
		.use(requirePermission(Permissions.INTEGRATION_USE))
		.route({
			method: "POST",
			path: "/integrations/gitlab/reconcile",
			tags: ["Integrations", "GitLab"],
			summary:
				"Backfill the missing GitLab token store (WI or MCPConfig) without re-OAuth",
		})
		.input(
			z.object({
				organizationId: z.string().nullable().optional(),
			}),
		)
		.output(
			z.object({
				status: z.enum(["RECONCILED", "ALREADY_BOTH", "NEEDS_REAUTH"]),
			}),
		)
		.handler(async ({ input, context }) => {
			const orgIdForQuery = resolveOrgIdForQuery({
				organizationId: input.organizationId ?? null,
			});
			const { loadGitLabToken, persistGitLabToken } = await import(
				"../lib/gitlab-token"
			);

			// `loadGitLabToken` reads the primary `gitlab` row (falling back to
			// WorkflowIntegration) and never looks at `gitlab-official` — but
			// that is the row the PM adapter and the Temporal resolver condemn,
			// it stores its own refresh token, and reconcile runs precisely
			// when the two have diverged. Read it alongside so a condemned
			// official row can't slip past the guard below.
			const [token, officialConfig] = await Promise.all([
				loadGitLabToken(db as never, {
					userId: context.user.id,
					organizationId: orgIdForQuery,
				}),
				db.mCPConfig.findFirst({
					where: {
						userId: context.user.id,
						...(orgIdForQuery
							? { organizationId: orgIdForQuery }
							: { organizationId: null }),
						mcpServer: { key: "gitlab-official" },
					},
					select: { needsReauth: true },
				}),
			]);
			if (!token) {
				throw new ORPCError("NOT_FOUND", {
					message: "No GitLab token to reconcile",
				});
			}

			// A condemned credential can only be cleared by a fresh OAuth
			// grant, and reconcile is a fast path that reuses the EXISTING
			// token. It therefore persists with `freshGrant: false` below, but
			// still declines up front: the answer the user needs is the full
			// Connect flow, not a backfilled row that stays blocked. Either
			// side being condemned is enough — they are written independently.
			if (token.needsReauth || officialConfig?.needsReauth) {
				return { status: "NEEDS_REAUTH" as const };
			}

			// Quick check: do both rows already exist? If so, no-op.
			const [existingWi, existingMcp] = await Promise.all([
				db.workflowIntegration.findFirst({
					where: {
						userId: context.user.id,
						provider: "GITLAB",
						...(orgIdForQuery
							? { organizationId: orgIdForQuery }
							: { organizationId: null }),
					},
					select: { id: true },
				}),
				db.mCPConfig.findFirst({
					where: {
						userId: context.user.id,
						...(orgIdForQuery
							? { organizationId: orgIdForQuery }
							: { organizationId: null }),
						mcpServer: { key: "gitlab" },
					},
					select: { id: true },
				}),
			]);
			if (existingWi && existingMcp) {
				return { status: "ALREADY_BOTH" as const };
			}

			// Validate the stored token against GitLab. This goes through
			// `gitlabFetch` rather than `getGitLabUser` because it throws a
			// `GitLabApiError` carrying the HTTP status — the only thing that
			// separates "GitLab turned this token away" from "GitLab is having
			// a bad minute". `getGitLabUser` throws an untyped Error, so a
			// probe through it cannot make that call.
			let glUser: GitLabUser;
			try {
				glUser = (await gitlabFetch(
					token.accessToken,
					"/user",
				)) as GitLabUser;
			} catch (err) {
				if (isGitLabProbeRejection(err)) {
					// Advisory only — deliberately no `markNeedsReauth` write.
					// A `/user` 401 shows the ACCESS token is unusable right
					// now, most often because it simply expired; the refresh
					// token behind it may be fine. Writing the enforced
					// breaker on that evidence would hard-block an integration
					// a refresh would have healed, and only the user can undo
					// it. The prompt below is always recoverable: if the grant
					// really is alive, reconnecting or a later refresh both
					// still work.
					return { status: "NEEDS_REAUTH" as const };
				}
				// Transient: GitLab was unreachable or erroring, which tells
				// us nothing about the credential — not even enough to ask
				// the user to reconnect. Surface the failure instead. Both
				// callers already catch, log and fall through to the full
				// OAuth flow, so the user still has a way forward — and a
				// retry once GitLab recovers reconciles.
				throw err;
			}

			// Past this point the token has proven itself; any failure is
			// ours (encryption, DB write). Leave it outside the catch so a
			// storage outage can't condemn a credential GitLab just accepted.
			await persistGitLabToken(db as never, {
				userId: context.user.id,
				organizationId: orgIdForQuery,
				token: {
					accessToken: token.accessToken,
					refreshToken: token.refreshToken,
					expiresAt: token.expiresAt,
					scopes: ["api", "read_user"],
				},
				gitlabUser: {
					id: glUser.id,
					username: glUser.username,
					name: glUser.name,
					avatarUrl: glUser.avatar_url ?? null,
				},
				// Reconcile backfills the missing store from the token it just
				// read out of the other one — no new grant, so no authority to
				// clear the breaker on either row. A `/user` 200 proves the
				// ACCESS token works; it says nothing about the refresh tokens
				// the breaker is about.
				freshGrant: false,
			});
			return { status: "RECONCILED" as const };
		}),

	/**
	 * Tenant-scoped presence checks used by the reconciler-aware UI tiles.
	 * Returns simple booleans so the UI can decide whether to show
	 * "Connect", "Enable for agents", or "Restore PM connection".
	 */
	connectionState: tenantProtectedProcedure
		.use(requirePermission(Permissions.INTEGRATION_READ))
		.route({
			method: "GET",
			path: "/integrations/gitlab/connection-state",
			tags: ["Integrations", "GitLab"],
			summary: "Whether the user has a GitLab WI / MCPConfig row",
		})
		.input(
			z.object({
				organizationId: z.string().nullable().optional(),
			}),
		)
		.output(
			z.object({
				hasWorkflowIntegration: z.boolean(),
				hasMcpConfig: z.boolean(),
				needsReauth: z.boolean(),
			}),
		)
		.handler(async ({ input, context }) => {
			const orgIdForQuery = resolveOrgIdForQuery({
				organizationId: input.organizationId ?? null,
			});
			const [wi, mcp] = await Promise.all([
				db.workflowIntegration.findFirst({
					where: {
						userId: context.user.id,
						provider: "GITLAB",
						...(orgIdForQuery
							? { organizationId: orgIdForQuery }
							: { organizationId: null }),
					},
					select: { id: true, settings: true },
				}),
				db.mCPConfig.findFirst({
					where: {
						userId: context.user.id,
						...(orgIdForQuery
							? { organizationId: orgIdForQuery }
							: { organizationId: null }),
						mcpServer: { key: "gitlab" },
					},
					select: { id: true, needsReauth: true },
				}),
			]);
			const wiSettings = (wi?.settings ?? {}) as {
				needsReauth?: boolean;
			};
			return {
				hasWorkflowIntegration: !!wi,
				hasMcpConfig: !!mcp,
				needsReauth: Boolean(
					mcp?.needsReauth || wiSettings.needsReauth,
				),
			};
		}),

	/**
	 * Re-probe GitLab to detect tier-based MCP capability changes.
	 *
	 * Runs the MCP probe for the current user's GitLab integration and updates
	 * `WorkflowIntegration.settings.useOfficialMcp` + `mcpProbe` accordingly.
	 * Transient network failures preserve the previous flag value.
	 */
	recheckCapabilities: tenantProtectedProcedure
		.use(requirePermission(Permissions.INTEGRATION_USE))
		.route({
			method: "POST",
			path: "/integrations/gitlab/recheck-capabilities",
			tags: ["Integrations", "GitLab"],
			summary:
				"Re-probe GitLab to detect tier-based MCP capability changes",
		})
		.input(
			z.object({
				organizationId: z.string().nullable().optional(),
			}),
		)
		.output(
			z.object({
				useOfficialMcp: z.boolean(),
				mcpProbe: z.object({
					status: z.enum([
						"ok",
						"unauthorized",
						"not-found",
						"network-error",
						"timeout",
					]),
					httpStatus: z.number().nullable(),
					checkedAt: z.string(),
					baseUrl: z.string(),
				}),
			}),
		)
		.handler(async ({ input, context }) => {
			// Use explicit organizationId from input (parity with sibling
			// procedures in this file) so personal-context recheck doesn't
			// pick up whatever org is currently active in the session.
			try {
				return await recheckGitlabCapabilities({
					db: db as unknown as Parameters<
						typeof recheckGitlabCapabilities
					>[0]["db"],
					input: {
						userId: context.user.id,
						organizationId: input.organizationId ?? null,
					},
				});
			} catch (err) {
				// Surface dead-refresh-token as a clean UNAUTHORIZED so the
				// integration page can show "Reconnect GitLab" instead of a
				// generic 500. The helper already marked needsReauth via the
				// markNeedsReauth path; we just need to tell the caller why.
				if (err instanceof GitLabReauthRequiredError) {
					throw new ORPCError("UNAUTHORIZED", {
						message:
							"GitLab access token expired and refresh failed. Please reconnect your GitLab account in Settings → Integrations.",
					});
				}
				// "Re-check" before the user has even connected GitLab — same
				// UX failure mode as the dead-token case, different cause.
				// Map to PRECONDITION_FAILED so the page shows a connect CTA
				// rather than a 500.
				if (err instanceof GitLabIntegrationNotConnectedError) {
					throw new ORPCError("PRECONDITION_FAILED", {
						message:
							"GitLab is not connected. Connect it in Settings → Integrations first.",
					});
				}
				throw err;
			}
		}),
};

/**
 * Pure helper for the project-level GitLab OAuth callback path.
 *
 * Exported so it can be unit-tested in isolation without spinning up an oRPC
 * context. The parent callback procedure retains responsibility for:
 *   - Validating required state fields (projectId, repositoryOwner, repositoryName)
 *   - Checking PROJECT_SETTINGS_EDIT permission before calling this
 *
 * Uses Prisma upsert on the compound unique key
 * [projectId, provider, repositoryOwner, repositoryName] so re-auth flows
 * (e.g. token expiry) update the existing row rather than creating duplicates.
 */
export async function handleProjectTargetCallback(args: {
	state: {
		userId: string;
		organizationId?: string | null;
		projectId: string;
		repositoryUrl: string;
		repositoryOwner: string;
		repositoryName: string;
		defaultBranch?: string;
		roleTag?: string | null;
		targetType: "project";
	};
	tokenResponse: {
		access_token: string;
		refresh_token?: string;
		expires_in?: number;
		token_type: string;
		scope?: string;
		created_at?: number;
	};
	gitlabUser: {
		id: number;
		username: string;
		name?: string;
		avatar_url?: string;
	};
}): Promise<{
	connectedStatus: "ACTIVE" | "TOKEN_EXPIRED" | "REPO_UNAVAILABLE";
}> {
	const { state, tokenResponse, gitlabUser } = args;

	// Last-gate SSRF pin: every API call this helper and its downstream flows
	// make carries a live token, so the stored URL must name gitlab.com. The
	// START path validates this too — this covers states minted before that
	// guard existed.
	if (new URL(state.repositoryUrl).hostname.toLowerCase() !== "gitlab.com") {
		throw new ORPCError("BAD_REQUEST", {
			message:
				"Only gitlab.com repositories are supported for GitLab connections",
		});
	}

	// Observe the REPOSITORY, not just the token — same reasoning as the GitHub
	// callback: the exchange proves the credential is alive, only a repo-scoped
	// probe proves Fabric can work with this repository. Host pinned to
	// gitlab.com (see `verifyRepositoryAccess`) so the probe cannot be aimed at
	// an internal host via the stored URL.
	const { outcome: accessOutcome, defaultBranch: probeDefaultBranch } =
		await verifyRepositoryAccess({
			provider: "GITLAB",
			token: tokenResponse.access_token,
			gitlabAuth: "bearer",
			repositoryUrl: state.repositoryUrl,
			owner: state.repositoryOwner,
			repo: state.repositoryName,
		});
	const verdict = integrationStatusForRepoAccess(accessOutcome, "GITLAB");

	const tokenExpiresAt = tokenResponse.expires_in
		? new Date(Date.now() + tokenResponse.expires_in * 1000)
		: null;
	const tokenScopes = tokenResponse.scope
		? tokenResponse.scope.split(" ")
		: [];

	const credentialFields = {
		encryptedAccessToken: encryptApiKey(tokenResponse.access_token),
		encryptedRefreshToken: tokenResponse.refresh_token
			? encryptApiKey(tokenResponse.refresh_token)
			: null,
		tokenExpiresAt,
		tokenScopes,
		status: verdict.status,
		lastError: verdict.lastError,
		// The upsert matches on the repo identity only; make reconnecting over
		// a PAT-connected row an explicit OAuth conversion instead of storing a
		// token readers ignore while keeping the PAT's authMethod.
		authMethod: "OAUTH" as const,
		encryptedPat: null,
		azureOrganization: null,
		// A re-authenticated credential must start with a full retirement
		// budget: a stale count would let one failed sweep retire this row.
		probeFailCount: 0,
	};

	const resolvedBranch = await resolveDefaultBranch({
		providedBranch: state.defaultBranch ?? probeDefaultBranch,
		provider: "GITLAB",
		token: tokenResponse.access_token,
		repositoryUrl: state.repositoryUrl,
		owner: state.repositoryOwner,
		repo: state.repositoryName,
	});

	const integration = await db.projectRepositoryIntegration.upsert({
		where: {
			projectId_provider_repositoryOwner_repositoryName: {
				projectId: state.projectId,
				provider: "GITLAB",
				repositoryOwner: state.repositoryOwner,
				repositoryName: state.repositoryName,
			},
		},
		create: {
			projectId: state.projectId,
			provider: "GITLAB",
			repositoryUrl: state.repositoryUrl,
			repositoryOwner: state.repositoryOwner,
			repositoryName: state.repositoryName,
			defaultBranch: resolvedBranch,
			roleTag: state.roleTag ?? null,
			configuredByUserId: state.userId,
			...credentialFields,
		},
		update: credentialFields,
	});

	await syncLegacyProjectRepoOnConnect(
		state.projectId,
		state.repositoryUrl,
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
		repositoryIntegrationId: integration.id,
	}).catch((error) => {
		console.error(
			"[gitlab-oauth] Failed to auto-start code indexing:",
			error,
		);
	});

	await logRepoIntegrationActivity({
		projectId: state.projectId,
		userId: state.userId,
		userName: gitlabUser.username,
		// Not a Prisma where-clause — activity logger accepts optional string.
		organizationId: state.organizationId ?? undefined,
		activityType: "repo_integration_configured",
		repositoryName: `${state.repositoryOwner}/${state.repositoryName}`,
		metadata: {
			provider: "GITLAB",
			authMethod: "OAUTH",
			gitlabUsername: gitlabUser.username,
		},
	});

	// Unify codebase + PM: the same token can drive GitLab issues, so make
	// this connection usable as the project's PM tool. Best-effort — a failure
	// here must never fail the repository connection the user actually asked
	// for.
	try {
		await enableGitLabPMForProject({
			userId: state.userId,
			organizationId: state.organizationId ?? null,
			projectId: state.projectId,
			repositoryOwner: state.repositoryOwner,
			repositoryName: state.repositoryName,
			token: {
				accessToken: tokenResponse.access_token,
				refreshToken: tokenResponse.refresh_token ?? null,
				expiresAt: tokenResponse.expires_in
					? new Date(Date.now() + tokenResponse.expires_in * 1000)
					: null,
				scopes: tokenResponse.scope
					? tokenResponse.scope.split(" ")
					: ["api", "read_user"],
			},
			gitlabUser: {
				id: gitlabUser.id,
				username: gitlabUser.username,
				name: gitlabUser.name ?? gitlabUser.username,
				avatarUrl: gitlabUser.avatar_url ?? null,
			},
			// `tokenResponse` is this callback's authorization-code exchange,
			// so connecting a repository doubles as a reconnect that clears a
			// condemned credential.
			freshGrant: true,
		});
	} catch (err) {
		console.error(
			"[GitLab OAuth] PM auto-wire failed (repo connect still succeeded)",
			{ projectId: state.projectId, error: err },
		);
	}

	return { connectedStatus: verdict.status };
}
