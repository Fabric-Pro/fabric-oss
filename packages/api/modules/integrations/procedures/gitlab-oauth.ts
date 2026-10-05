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
	syncLegacyProjectRepoOnConnect,
} from "@repo/database";
import {
	GITLAB_DEFAULT_ORIGIN,
	type GitLabApiCredential,
	GitLabApiError,
	getGitLabConnectionGeneration,
	getGitLabConnectionStatus,
	getGitLabConnectionToken,
	gitlabApiBaseForOrigin,
	gitlabFetch,
	identifyGitLabIssuer,
	patchGitLabConnectionSettings,
	readGitLabPersonalConnection,
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
	protectedProcedure,
	requireInputOrgPermission,
	requirePermission,
	resolveOrganizationIdForCaller,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { GITLAB_DATA_CONNECTION_CLEARED_TOKENS } from "../../data-connections/lib/gitlab-data-connection";
import { startCodeIndexingForProject } from "../../projects/lib/code-indexing-trigger";
import {
	type EnableGitLabPMResult,
	enableGitLabPMForProject,
} from "../lib/enable-gitlab-pm-for-project";
import {
	exchangeCodeForToken,
	generatePkce,
	getGitLabOAuthUrl,
	getGitLabUser,
	listGitLabBranches,
	listGitLabProjects,
	recordToolIngestError,
	resolveOrgIdForQuery,
} from "../lib/gitlab-oauth";
import { disconnectPersonalGitLab } from "../lib/gitlab-personal-disconnect";
import {
	GitLabIntegrationNotConnectedError,
	recheckGitlabCapabilities,
} from "../lib/gitlab-recheck";
import { authorizeGitLabTenant } from "../lib/gitlab-request-tenant";
import {
	ensureGitLabRegistryRow,
	GitLabReauthRequiredError,
	persistGitLabToken,
} from "../lib/gitlab-token";
import {
	assertOAuthStateBoundToCaller,
	consumeOAuthStateOnce,
} from "../lib/oauth-callback-guard";
import {
	getOAuthCredentialsWithDb,
	getOAuthProvider,
} from "../lib/oauth-providers";
import { assertOAuthStartOrganization } from "../lib/oauth-start-organization";
import { decodeOAuthState, encodeOAuthState } from "../lib/oauth-state";
import { resolveProjectRepositoryIdentity } from "../lib/repository-identity";

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

/**
 * The caller's own GitLab token for the repository pickers — the personal
 * connection, refreshed with whichever client issued it, together with the
 * REST base of the GitLab instance that issued it (so a self-hosted
 * credential is only ever sent to its own instance). Requires no
 * integration-app credentials, so a connection made through the MCP
 * registry (dynamic client registration) works the same.
 */
async function requirePersonalGitLabToken(
	userId: string,
	organizationId: string | null,
): Promise<GitLabApiCredential> {
	const token = await getGitLabConnectionToken(
		{ userId, organizationId },
		{ mode: "strict", anyOrigin: true },
	);
	if (token.ok) {
		return {
			token: token.accessToken,
			apiBase: gitlabApiBaseForOrigin(token.origin),
		};
	}
	throw new ORPCError("BAD_REQUEST", {
		message:
			token.reason === "not-connected"
				? "GitLab not connected. Please connect your GitLab account first."
				: "Your GitLab connection needs to be reconnected. Reconnect GitLab in Settings > Integrations.",
	});
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
		.use(
			requireInputOrgPermission(Permissions.INTEGRATION_USE, {
				// Integration OAuth has no personal arm (ADR-018): an explicit
				// `organizationId: null` must not skip the role check and mint
				// a state that later stores an organization-less token.
				requireOrganization: true,
			}),
		)
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
			const userId = context.user.id;
			// The organization signed into the state is where the callback will
			// store the token, so it is resolved and membership-checked here by
			// the shared helper rather than read straight off the input.
			// `requireInputOrgPermission` above already refuses a non-member;
			// this keeps the signed value identical to the authorized one, and
			// the credential lookup below reads the same resolved value.
			const organizationId = await resolveOrganizationIdForCaller(
				input.organizationId,
				context.session,
				userId,
			);
			// The middleware refused a missing organization before the handler
			// ran; this is the handler's own fail-closed copy of the rule, and
			// it narrows the type so no state is ever minted without one.
			assertOAuthStartOrganization(organizationId);

			const { clientId } = await getGitLabConfigWithDb(
				userId,
				organizationId,
			);

			if (!clientId) {
				throw new ORPCError("BAD_REQUEST", {
					message:
						"GitLab OAuth not configured. Please set GITLAB_CLIENT_ID environment variable.",
				});
			}

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

			// `repositoryUrl` and `repositoryOwner`/`repositoryName` are three
			// independent, unvalidated fields on this input. Resolving and
			// validating identity here — before the user is ever sent to
			// GitLab — is better UX than the callback's own refusal after the
			// round trip; it also means the state below signs the canonical
			// `parsed.url`/`owner`/`name` rather than whatever the caller
			// sent. The GitLab project picker sends `repositoryName` as
			// GitLab's `path_with_namespace`, which already repeats the owner
			// (e.g. owner "group/subgroup", name "group/subgroup/repo") —
			// `resolveProjectRepositoryIdentity` accepts that legacy shape as
			// a match and returns the bare owner/name split instead, so the
			// probe and the stored row never see the doubled path. A
			// project-target flow with no `projectId`, or with too little
			// identity info for the helper to build ANY candidate from (both
			// repositoryUrl and a full owner/name pair absent), is refused
			// here too — signing a state that the callback's own "missing
			// project integration fields" check would refuse anyway is worse
			// UX than refusing at start, and previously signed the raw,
			// unvalidated partial fields into the state in the meantime.
			let projectRepositoryUrl: string | undefined;
			let projectRepositoryOwner: string | undefined;
			let projectRepositoryName: string | undefined;
			if (input.targetType === "project") {
				const resolved = resolveProjectRepositoryIdentity({
					provider: "GITLAB",
					repositoryUrl: input.repositoryUrl,
					repositoryOwner: input.repositoryOwner,
					repositoryName: input.repositoryName,
					caseSensitive: true,
				});
				if (!input.projectId || !resolved) {
					throw new ORPCError("BAD_REQUEST", {
						message:
							"Missing project integration fields (projectId, repositoryOwner, or repositoryName)",
					});
				}
				projectRepositoryUrl = resolved.url;
				projectRepositoryOwner = resolved.owner;
				projectRepositoryName = resolved.name;
			}

			// PKCE (S256): bind this authorization request to the
			// verifier stored in our signed state so an intercepted code
			// cannot be redeemed by a third party. See generatePkce().
			const { codeVerifier, codeChallenge } = generatePkce();

			// Generate signed state (include redirectUri so callback uses same value)
			const state = encodeOAuthState({
				userId,
				organizationId,
				provider: "gitlab",
				returnUrl: input.returnUrl,
				redirectUri: input.redirectUri,
				targetType: input.targetType,
				projectId: input.projectId,
				repositoryUrl: projectRepositoryUrl,
				repositoryOwner: projectRepositoryOwner,
				repositoryName: projectRepositoryName,
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
	 *
	 * GitLab redirects the user's browser here, so the request carries the
	 * session cookie and the procedure requires it: the session must be the
	 * user named in the signed state (see `assertOAuthStateBoundToCaller`). A
	 * public callback let anyone who started a flow have a victim finish it.
	 */
	callback: protectedProcedure
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
		.handler(async ({ input, context }) => {
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

			// The session must be the user who started the flow, and still a
			// member of the organization the flow targets. Then the nonce is
			// spent, before the code exchange, so a replayed state stops here.
			await assertOAuthStateBoundToCaller(state, context.user);
			const replayed = await consumeOAuthStateOnce(state);
			if (replayed) {
				return replayed;
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

			// IMPORTANT: Use null explicitly for personal context.
			// state.organizationId is undefined when there is no org --
			// passing undefined to Prisma causes it to skip the field
			// entirely, which breaks the XOR tenant isolation pattern.
			// resolveOrgIdForQuery coerces undefined/empty-string to null.
			const orgIdForQuery = resolveOrgIdForQuery(state);
			const connectionTenant = {
				userId: state.userId,
				organizationId: orgIdForQuery,
			};

			try {
				// Read the connection generation BEFORE the exchange: a
				// disconnect or another connect that lands while GitLab answers
				// must not be overwritten by this callback's write. Project
				// repository links never touch the personal connection.
				const generationBefore =
					state.targetType === "project"
						? null
						: await getGitLabConnectionGeneration(connectionTenant);

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

					const { connectedStatus, personalConnectionRequiredForPm } =
						await handleProjectTargetCallback({
							state: {
								userId: state.userId,
								organizationId: state.organizationId ?? null,
								projectId: state.projectId,
								// Passed through as-is — `handleProjectTargetCallback`
								// (via `resolveProjectRepositoryIdentity`) builds its
								// own fallback candidate when this is absent, using
								// the legacy-shape-aware construction. Pre-building it
								// here with a naive `${owner}/${name}` concatenation
								// doubled the path for a legacy-shaped
								// `repositoryName` (owner "group/subgroup", name
								// "group/subgroup/repo").
								repositoryUrl: state.repositoryUrl,
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
					const repoMessage =
						connectedStatus === "REPO_UNAVAILABLE"
							? `Connected ${repoSlug} — but Fabric cannot read it. Install the provider app on the repository, or connect it with a personal access token from its row menu.`
							: connectedStatus === "TOKEN_EXPIRED"
								? `Connected ${repoSlug} — but the credentials were rejected as invalid or expired. Reconnect from Settings ▸ Development.`
								: `Connected GitLab repository: ${repoSlug}`;
					// The repository link is a team grant; GitLab PM runs on the
					// acting person's own connection.
					const message = personalConnectionRequiredForPm
						? `${repoMessage.replace(/\.?$/, ".")} To use GitLab issues for project management, connect your personal GitLab account in Settings ▸ Integrations.`
						: repoMessage;

					return {
						success: true,
						message,
						returnUrl: state.returnUrl,
					};
				}

				// The one personal GitLab connection, written through the
				// connection service with the client that issued this grant.
				// No MCPConfig receives a token.
				const issuer = await identifyGitLabIssuer(connectionTenant, {
					clientId,
					origin: GITLAB_DEFAULT_ORIGIN,
				});
				const persisted = await persistGitLabToken({
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
					issuer,
					// The authorization-code exchange above just returned:
					// this is a grant the user has freshly authorized, so it
					// may lift the reconnect-required state.
					freshGrant: true,
					expectedGeneration: generationBefore ?? undefined,
				});
				if (!persisted.written) {
					return {
						success: false,
						message:
							"Your GitLab connection changed while this sign-in was completing. Please connect GitLab again.",
					};
				}
				const workflowIntegrationId = persisted.workflowIntegrationId;
				const integrationRow = { id: workflowIntegrationId };

				// Auto-heal any EXPIRED DataConnection for this provider: the
				// disconnect marked it EXPIRED, and the person is connected
				// again. Status only — a GitLab Data Connection holds no token
				// (a sync uses the starting person's live connection), so any
				// legacy copy is cleared rather than refreshed.
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
						...GITLAB_DATA_CONNECTION_CLEARED_TOKENS,
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
							tenant: connectionTenant,
							generation: persisted.generation,
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
				/**
				 * The person's connection as every screen shows it (see
				 * `readGitLabPersonalConnection`): connected, needs
				 * reconnect, or not connected. `connected` stays true for a
				 * connection that needs reconnecting, with `needsReauth`.
				 */
				state: z.enum([
					"connected",
					"needs-reconnect",
					"not-connected",
				]),
				/** The GitLab instance the connection belongs to. */
				origin: z.string().nullable().optional(),
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
			// Resolved and authorized before the read below, which can
			// classify a legacy connection row in this tenant.
			const { userId, organizationId } = await authorizeGitLabTenant(
				Permissions.INTEGRATION_READ,
				input.organizationId,
				context,
			);

			// The one personal connection. Its own reconnect-required state is
			// the only one that counts: the MCPConfig breaker columns no longer
			// describe a credential, and those configs hold no token.
			const { status: connection, summary } =
				await readGitLabPersonalConnection({ userId, organizationId });

			if (summary.state === "not-connected") {
				return { connected: false, state: summary.state };
			}

			const settings = connection.settings;
			const needsReauth = connection.needsReauth;

			const lastToolIngestError = settings?.lastToolIngestError as
				| { message: string; at: string }
				| undefined;

			return {
				connected: true,
				state: summary.state,
				origin: summary.origin,
				username: summary.account?.username ?? undefined,
				name: summary.account?.name ?? null,
				avatarUrl: summary.account?.avatarUrl ?? undefined,
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
		// Removes only the caller's own connection, so it needs what
		// connecting one needs on the MCP tile (`MCP_CONNECT`), not the
		// admin-level `INTEGRATION_DISCONNECT` for shared integrations. The
		// handler checks it again against the resolved organization.
		.use(requirePermission(Permissions.MCP_CONNECT))
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
			const tenant = await authorizeGitLabTenant(
				Permissions.MCP_CONNECT,
				input.organizationId,
				context,
			);

			// The one personal GitLab disconnect every surface shares: the
			// connection service's core disconnect (generation bump, credential
			// emptied, MCP token copies cleared with rows and client
			// registrations kept, best-effort revocation), the person's GitLab
			// Data Connections marked expired, the registry cache dropped and
			// one audit row. Project repository links are untouched.
			const { revocationWarning } = await disconnectPersonalGitLab({
				tenant,
				surface: "integrations.gitlab.disconnect",
				audit: context,
			});

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
			const { userId, organizationId } = await authorizeGitLabTenant(
				Permissions.INTEGRATION_READ,
				input.organizationId,
				context,
			);

			const accessToken = await requirePersonalGitLabToken(
				userId,
				organizationId,
			);

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
			const { userId, organizationId } = await authorizeGitLabTenant(
				Permissions.INTEGRATION_READ,
				input.organizationId,
				context,
			);

			const branchAccessToken = await requirePersonalGitLabToken(
				userId,
				organizationId,
			);

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
			const { organizationId: orgIdForQuery } =
				await authorizeGitLabTenant(
					Permissions.INTEGRATION_USE,
					input.organizationId,
					context,
				);
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
			// Clear the lastToolIngestError marker on the person's connection —
			// a merge fenced on its generation, never a whole-settings rewrite.
			const connection = await getGitLabConnectionStatus({
				userId: context.user.id,
				organizationId: orgIdForQuery,
			});
			if (connection.integrationId && connection.connected) {
				await patchGitLabConnectionSettings(
					{ userId: context.user.id, organizationId: orgIdForQuery },
					{
						expectedGeneration: connection.generation,
						patch: {},
						remove: ["lastToolIngestError"],
					},
				);
			}
			return { triggered: configs.length };
		}),

	/**
	 * Reconcile GitLab without a fresh OAuth dance: for a person whose GitLab
	 * connection is usable, make sure the `gitlab` registry entry the MCP page
	 * lists exists. No token is copied anywhere.
	 *
	 * Returns:
	 *   - { status: "RECONCILED" } — added the registry entry
	 *   - { status: "ALREADY_BOTH" } — nothing was missing
	 *   - { status: "NEEDS_REAUTH" } — the connection is marked
	 *     reconnect-required, its issuing client is gone, or GitLab turned
	 *     the `/user` probe away (401/403). ADVISORY: reconcile never marks
	 *     the connection itself.
	 *
	 * Anything else — GitLab unreachable or erroring, a failed write —
	 * throws rather than returning a status.
	 */
	reconcile: tenantProtectedProcedure
		.use(requirePermission(Permissions.INTEGRATION_USE))
		.route({
			method: "POST",
			path: "/integrations/gitlab/reconcile",
			tags: ["Integrations", "GitLab"],
			summary:
				"Add the GitLab registry entry for an existing connection without re-OAuth",
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
			const tenant = await authorizeGitLabTenant(
				Permissions.INTEGRATION_USE,
				input.organizationId,
				context,
			);
			const orgIdForQuery = tenant.organizationId;

			const token = await getGitLabConnectionToken(tenant, {
				mode: "strict",
				// The `/user` check below goes to the credential's own
				// instance.
				anyOrigin: true,
			});
			if (!token.ok) {
				if (token.reason === "not-connected") {
					throw new ORPCError("NOT_FOUND", {
						message: "No GitLab token to reconcile",
					});
				}
				if (token.reason === "transient") {
					throw new ORPCError("INTERNAL_SERVER_ERROR", {
						message: token.message,
					});
				}
				return { status: "NEEDS_REAUTH" as const };
			}

			const registry = await db.mCPConfig.findFirst({
				where: {
					userId: context.user.id,
					...(orgIdForQuery
						? { organizationId: orgIdForQuery }
						: { organizationId: null }),
					mcpServer: { key: "gitlab" },
				},
				select: { id: true },
			});
			if (registry) {
				return { status: "ALREADY_BOTH" as const };
			}

			// Validate the token against GitLab before reporting success. This
			// goes through `gitlabFetch` because it throws a `GitLabApiError`
			// carrying the HTTP status — the only thing that separates "GitLab
			// turned this token away" from "GitLab is having a bad minute".
			try {
				await gitlabFetch(
					{
						token: token.accessToken,
						apiBase: gitlabApiBaseForOrigin(token.origin),
					},
					"/user",
				);
			} catch (err) {
				if (isGitLabProbeRejection(err)) {
					// Advisory only: a `/user` 401 shows the ACCESS token is
					// unusable right now; it is no verdict on the grant.
					return { status: "NEEDS_REAUTH" as const };
				}
				throw err;
			}

			if (!registry) {
				await ensureGitLabRegistryRow(db as never, tenant);
			}
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
			const tenant = await authorizeGitLabTenant(
				Permissions.INTEGRATION_READ,
				input.organizationId,
				context,
			);
			const [{ summary }, mcp] = await Promise.all([
				readGitLabPersonalConnection(tenant),
				db.mCPConfig.findFirst({
					where: {
						userId: tenant.userId,
						organizationId: tenant.organizationId,
						mcpServer: { key: "gitlab" },
					},
					select: { id: true },
				}),
			]);
			return {
				hasWorkflowIntegration: summary.state !== "not-connected",
				hasMcpConfig: !!mcp,
				// The connection's own state. The MCPConfig breaker columns no
				// longer describe the credential.
				needsReauth: summary.state === "needs-reconnect",
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
			// Resolved and authorized before the recheck, which reads (and can
			// classify or refresh) the connection and writes its settings: the
			// caller must be a member with INTEGRATION_USE in the organization
			// the request resolves to, not merely in the session's. No
			// organization is refused (ADR-018) rather than read as a
			// no-organization tenant.
			const tenant = await authorizeGitLabTenant(
				Permissions.INTEGRATION_USE,
				input.organizationId,
				context,
			);
			try {
				return await recheckGitlabCapabilities({ input: tenant });
			} catch (err) {
				// Surface dead-refresh-token as a clean UNAUTHORIZED so the
				// integration page can show "Reconnect GitLab" instead of a
				// generic 500. The connection service already recorded the
				// reconnect-required state; we just need to tell the caller why.
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
		/**
		 * Optional: when absent, `resolveProjectRepositoryIdentity` below
		 * builds its own `https://gitlab.com/...` fallback candidate from
		 * `repositoryOwner`/`repositoryName` (legacy-shape aware), which is
		 * inherently gitlab.com by construction — the SSRF pin further down
		 * only needs to run when a caller-supplied URL is actually present.
		 */
		repositoryUrl?: string;
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
	/**
	 * True when the repository connected but GitLab PM could not be set up
	 * because the caller has no usable personal GitLab connection.
	 */
	personalConnectionRequiredForPm: boolean;
}> {
	const { state, tokenResponse, gitlabUser } = args;

	// Last-gate SSRF pin: every API call this helper and its downstream flows
	// make carries a live token, so a caller-supplied stored URL must name
	// gitlab.com. The START path validates this too — this covers states
	// minted before that guard existed. Skipped when `repositoryUrl` is
	// absent: the fallback candidate `resolveProjectRepositoryIdentity`
	// builds below is always `https://gitlab.com/...` by construction, so
	// there is nothing caller-controlled to pin here.
	if (
		state.repositoryUrl &&
		new URL(state.repositoryUrl).hostname.toLowerCase() !== "gitlab.com"
	) {
		throw new ORPCError("BAD_REQUEST", {
			message:
				"Only gitlab.com repositories are supported for GitLab connections",
		});
	}

	// Route the caller-supplied URL (from the OAuth start request, signed
	// into `state`) through the same canonicalisation the connect/PAT path
	// uses before anything is written: userinfo is stripped, and a query
	// string or fragment — never part of a repository's identity — is
	// refused rather than stored. GitLab's own project picker sends
	// `repositoryName` as `path_with_namespace`, which already repeats the
	// owner (e.g. owner "group/subgroup", name "group/subgroup/repo");
	// `resolveProjectRepositoryIdentity` accepts that legacy shape as a
	// match and returns the bare owner/name split, so the probe and every
	// write below use that resolved pair — never `state.repositoryOwner`/
	// `repositoryName` directly — rather than the doubled path a naive
	// concatenation would build. GitLab paths are case-sensitive, so the
	// comparison is exact (unlike the GitHub callback's case-insensitive
	// one). `state.repositoryOwner`/`repositoryName` are required by this
	// function's signature and `state.repositoryUrl` is always populated by
	// the outer callback (falling back to the owner/name shape when the
	// signed state omitted it), so a candidate can always be built and
	// `resolved` is never null here in practice; the defensive branch below
	// keeps this function's own contract self-checking rather than trusting
	// that.
	const resolved = resolveProjectRepositoryIdentity({
		provider: "GITLAB",
		repositoryUrl: state.repositoryUrl,
		repositoryOwner: state.repositoryOwner,
		repositoryName: state.repositoryName,
		caseSensitive: true,
	});
	if (!resolved) {
		throw new ORPCError("BAD_REQUEST", {
			message: "Cannot parse repository URL",
		});
	}
	const repositoryUrl = resolved.url;
	const repositoryOwner = resolved.owner;
	const repositoryName = resolved.name;

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
			repositoryUrl,
			owner: repositoryOwner,
			repo: repositoryName,
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
		repositoryUrl,
		owner: repositoryOwner,
		repo: repositoryName,
	});

	// A plain upsert on the canonical [projectId, provider, repositoryOwner,
	// repositoryName] key would never find a row a picker created before this
	// fix (or while the picker's own owner/name bug was live): those rows are
	// stored under the LEGACY doubled name — `${repositoryOwner}/${repositoryName}`
	// as `repositoryName`, with the same `repositoryOwner`. Reconnecting one
	// with a blind upsert would silently CREATE A SECOND row instead of
	// updating the first. So: in one transaction, look up both keys. If only
	// the legacy row exists, migrate it to the canonical owner/name/url IN
	// PLACE (same `id`, so anything referencing this row — audit history, the
	// legacy `Project.repositoryOwner`/`repositoryName` sync, a future FK —
	// keeps pointing at it) and treat it as an update. If BOTH exist (the
	// legacy row was reconnected once while the old exact-match bug was live,
	// creating a second, canonical row alongside it), update the canonical
	// one and leave the legacy row untouched — it may still be referenced
	// elsewhere, so this is not the place to delete it silently.
	const legacyRepositoryName = `${repositoryOwner}/${repositoryName}`;
	const integration = await db.$transaction(async (tx) => {
		const [canonicalRow, legacyRow] = await Promise.all([
			tx.projectRepositoryIntegration.findFirst({
				where: {
					projectId: state.projectId,
					provider: "GITLAB",
					repositoryOwner,
					repositoryName,
				},
			}),
			tx.projectRepositoryIntegration.findFirst({
				where: {
					projectId: state.projectId,
					provider: "GITLAB",
					repositoryOwner,
					repositoryName: legacyRepositoryName,
				},
			}),
		]);

		if (canonicalRow) {
			if (legacyRow) {
				console.warn(
					`[gitlab-oauth] Both a canonical (id=${canonicalRow.id}) and a legacy-named (id=${legacyRow.id}, repositoryName="${legacyRepositoryName}") ProjectRepositoryIntegration row exist for project ${state.projectId} (${repositoryOwner}/${repositoryName}). Updated the canonical row; the legacy row was left untouched and needs manual review.`,
				);
			}
			return tx.projectRepositoryIntegration.update({
				where: { id: canonicalRow.id },
				data: credentialFields,
			});
		}

		if (legacyRow) {
			return tx.projectRepositoryIntegration.update({
				where: { id: legacyRow.id },
				data: {
					repositoryUrl,
					repositoryOwner,
					repositoryName,
					...credentialFields,
				},
			});
		}

		return tx.projectRepositoryIntegration.create({
			data: {
				projectId: state.projectId,
				provider: "GITLAB",
				repositoryUrl,
				repositoryOwner,
				repositoryName,
				defaultBranch: resolvedBranch,
				roleTag: state.roleTag ?? null,
				configuredByUserId: state.userId,
				...credentialFields,
			},
		});
	});

	await syncLegacyProjectRepoOnConnect(
		state.projectId,
		repositoryUrl,
		repositoryOwner,
		repositoryName,
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
		repositoryName: `${repositoryOwner}/${repositoryName}`,
		metadata: {
			provider: "GITLAB",
			authMethod: "OAUTH",
			gitlabUsername: gitlabUser.username,
		},
	});

	// Offer the connected repository as the project's GitLab PM source — but
	// only through the CALLER's own GitLab connection. The repository grant
	// above is a separate team credential: it is never written into the
	// caller's personal connection nor used for PM. Best-effort — a failure
	// here must never fail the repository connection the user asked for.
	let pm: EnableGitLabPMResult | null = null;
	try {
		pm = await enableGitLabPMForProject({
			userId: state.userId,
			organizationId: state.organizationId ?? null,
			projectId: state.projectId,
			repositoryOwner,
			repositoryName,
			repositoryUrl,
		});
	} catch (err) {
		console.error(
			"[GitLab OAuth] PM auto-wire failed (repo connect still succeeded)",
			{ projectId: state.projectId, error: err },
		);
	}

	return {
		connectedStatus: verdict.status,
		personalConnectionRequiredForPm:
			pm?.pmWired === false &&
			pm.reason === "personal-connection-required",
	};
}
