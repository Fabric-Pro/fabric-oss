/**
 * Generic OAuth Procedures
 *
 * Handles OAuth flow for any OAuth-based integration.
 * Supports multiple providers (GitHub, Google Drive, Slack, etc.)
 */

import { ORPCError } from "@orpc/server";
import {
	createDataConnection,
	type DataConnectionProvider,
	db,
	getDataConnectionByProvider,
	type Prisma,
	updateDataConnection,
	type WorkflowIntegrationProvider,
} from "@repo/database";
import { OAUTH_APP_PROVIDERS } from "@repo/database/prisma/queries/lib/oauth-app-row";
import {
	findUsableGitLabConnection,
	GITLAB_DEFAULT_ORIGIN,
	getGitLabConnectionGeneration,
	getGitLabConnectionToken,
	identifyGitLabIssuer,
	readGitLabPersonalConnection,
} from "@repo/integrations/gitlab";
import { logger } from "@repo/logs";
import {
	triggerOAuthServerIngestion,
	triggerOAuthToolIngestion,
} from "@repo/temporal";
import { decryptApiKey, encryptApiKey } from "@repo/utils";
import { z } from "zod";
import {
	authorizeInputOrganization,
	Permissions,
	protectedProcedure,
	requireInputOrgPermission,
	requirePermission,
	resolveOrganizationId,
	resolveOrganizationIdForCaller,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { GITLAB_DATA_CONNECTION_CLEARED_TOKENS } from "../../data-connections/lib/gitlab-data-connection";
import { disconnectPersonalGitLab } from "../lib/gitlab-personal-disconnect";
import { authorizeGitLabTenant } from "../lib/gitlab-request-tenant";
import { persistGitLabToken } from "../lib/gitlab-token";
import {
	assertOAuthStateBoundToCaller,
	consumeOAuthStateOnce,
} from "../lib/oauth-callback-guard";
import {
	exchangeCodeForTokens,
	generateAuthorizationUrl,
	getOAuthCredentials,
	getOAuthCredentialsWithDb,
	getOAuthProvider,
	mapOAuthToWorkflowProvider,
	type OAuthProviderType,
} from "../lib/oauth-providers";
import { assertOAuthStartOrganization } from "../lib/oauth-start-organization";
import { decodeOAuthState, encodeOAuthState } from "../lib/oauth-state";

// The providers `saveAppCredentials` accepts are exactly the ones whose
// `<PROVIDER>_OAUTH_APP` names the shared list reserves, so selectors in other
// packages exclude every app row this procedure can create.
const OAuthProviderEnum = z.enum(OAUTH_APP_PROVIDERS);

function mapOAuthToDataConnectionProvider(
	provider: OAuthProviderType,
	returnUrl?: string,
): DataConnectionProvider | null {
	switch (provider) {
		case "AIRTABLE":
			return "AIRTABLE";
		case "ASANA":
			return "ASANA";
		case "BITBUCKET":
			return "BITBUCKET";
		case "DROPBOX":
			return "DROPBOX";
		case "GITHUB":
			return "GITHUB";
		case "GMAIL":
			return "GMAIL";
		case "GITLAB":
			return "GITLAB";
		case "GOOGLE_DRIVE":
			return "GOOGLE_DRIVE";
		case "HUBSPOT":
			return "HUBSPOT";
		case "INTERCOM":
			return "INTERCOM";
		case "LINEAR":
			return "LINEAR";
		case "MICROSOFT_GRAPH":
			return returnUrl?.includes("/TEAMS") ||
				returnUrl?.includes("provider=TEAMS")
				? "TEAMS"
				: "MICROSOFT_365";
		case "SLACK":
			return "SLACK";
		case "NOTION":
			return "NOTION";
		default:
			return null;
	}
}

function buildDefaultDataConnectionConfig(input: {
	provider: OAuthProviderType;
	login: string;
	returnUrl?: string;
}): Record<string, unknown> {
	switch (input.provider) {
		case "AIRTABLE":
			return {};
		case "ASANA":
			return {};
		case "BITBUCKET":
			return {
				includeIssues: true,
				includePullRequests: true,
			};
		case "DROPBOX":
			return {
				includePaperDocs: true,
			};
		case "GITHUB":
			return {
				owner: input.login,
				includeIssues: true,
				includePullRequests: true,
				includeDiscussions: false,
				includeCode: false,
			};
		case "SLACK":
			return {
				includePublicChannels: true,
				includePrivateChannels: false,
				includeThreads: true,
			};
		case "NOTION":
			return {
				includePages: true,
			};
		case "GOOGLE_DRIVE":
			return {
				includeSharedDrives: true,
			};
		case "HUBSPOT":
			return {
				objectTypes: ["tickets", "companies", "deals", "contacts"],
			};
		case "LINEAR":
			return {};
		case "GMAIL":
			return {
				labelIds: ["INBOX"],
				includeSpamTrash: false,
			};
		case "GITLAB":
			return {
				includeIssues: true,
				includeMergeRequests: true,
			};
		case "INTERCOM":
			return {
				includeArticles: true,
				includeConversations: true,
			};
		case "MICROSOFT_GRAPH":
			if (input.returnUrl?.includes("provider=TEAMS")) {
				return {};
			}
			return {
				includeSharePoint: true,
				includeOneDrive: true,
				includeTeams: false,
			};
		default:
			return {};
	}
}

export const genericOAuthProcedures = {
	/**
	 * Check if an OAuth provider is configured
	 */
	isConfigured: tenantProtectedProcedure
		.use(requireInputOrgPermission(Permissions.INTEGRATION_READ))
		.route({
			method: "GET",
			path: "/integrations/oauth/:provider/configured",
			tags: ["Integrations", "OAuth"],
			summary: "Check if OAuth provider is configured",
		})
		.input(
			z.object({
				provider: OAuthProviderEnum,
				organizationId: z.string().nullable().optional(),
			}),
		)
		.output(z.object({ configured: z.boolean(), providerName: z.string() }))
		.handler(async ({ input, context }) => {
			const provider = getOAuthProvider(input.provider);
			if (!provider) {
				return { configured: false, providerName: input.provider };
			}

			const organizationId =
				input.organizationId !== undefined
					? input.organizationId
					: context.session.activeOrganizationId;

			const { clientId, clientSecret } = await getOAuthCredentialsWithDb(
				provider,
				context.user.id,
				organizationId,
			);
			return {
				configured: !!(clientId && clientSecret),
				providerName: provider.name,
			};
		}),

	/**
	 * Start OAuth flow for any provider
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
			path: "/integrations/oauth/:provider/start",
			tags: ["Integrations", "OAuth"],
			summary: "Start OAuth flow",
		})
		.input(
			z.object({
				provider: OAuthProviderEnum,
				redirectUri: z.string().url(),
				returnUrl: z.string().optional(),
				organizationId: z.string().nullable().optional(),
			}),
		)
		.output(z.object({ authorizationUrl: z.string().url() }))
		.handler(async ({ input, context }) => {
			const provider = getOAuthProvider(input.provider);
			if (!provider) {
				throw new ORPCError("BAD_REQUEST", {
					message: `Unknown OAuth provider: ${input.provider}`,
				});
			}

			const userId = context.user.id;
			// The organization signed into the state is where the callback will
			// store the provider token, so it is resolved and membership-checked
			// here, by the same helper the callback's counterpart uses, rather
			// than read straight off the input. `requireInputOrgPermission`
			// above already refuses a non-member; this keeps the value that is
			// signed identical to the value that was authorized.
			const organizationId = await resolveOrganizationIdForCaller(
				input.organizationId,
				context.session,
				userId,
			);
			// The middleware refused a missing organization before the handler
			// ran; this is the handler's own fail-closed copy of the rule, and
			// it narrows the type so no state is ever minted without one.
			assertOAuthStartOrganization(organizationId);

			const { clientId } = await getOAuthCredentialsWithDb(
				provider,
				userId,
				organizationId,
			);
			if (!clientId) {
				throw new ORPCError("BAD_REQUEST", {
					message: `${provider.name} OAuth not configured. Please add your ${provider.name} app credentials in Settings > Integrations.`,
				});
			}

			// Generate signed state
			const state = encodeOAuthState({
				userId,
				organizationId,
				provider: input.provider,
				returnUrl: input.returnUrl,
				redirectUri: input.redirectUri,
			});

			// Generate authorization URL
			const authorizationUrl = generateAuthorizationUrl(
				provider,
				clientId,
				input.redirectUri,
				state,
			);

			return { authorizationUrl };
		}),

	/**
	 * Handle OAuth callback for any provider
	 *
	 * The provider redirects the user's browser here, so the request carries the
	 * user's session cookie and the procedure requires it: the token that comes
	 * back is stored under the user named in the signed state, and the session
	 * must be that user (see `assertOAuthStateBoundToCaller`). A public callback
	 * let anyone who started a flow have a victim's browser finish it.
	 */
	callback: protectedProcedure
		.use(requirePermission(Permissions.INTEGRATION_USE))
		.route({
			method: "GET",
			path: "/integrations/oauth/callback",
			tags: ["Integrations", "OAuth"],
			summary: "Handle OAuth callback",
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
				provider: z.string().optional(),
				returnUrl: z.string().optional(),
			}),
		)
		.handler(async ({ input, context }) => {
			// Handle OAuth errors
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

			const providerType = state.provider as OAuthProviderType;
			const provider = getOAuthProvider(providerType);
			if (!provider) {
				return {
					success: false,
					message: `Unknown OAuth provider: ${state.provider}`,
					provider: state.provider,
				};
			}

			// The session must be the user who started the flow, and still a
			// member of the organization the flow targets. Then the nonce is
			// spent, before the code exchange, so a replayed state stops here.
			await assertOAuthStateBoundToCaller(state, context.user);
			const replayed = await consumeOAuthStateOnce(state);
			if (replayed) {
				return { ...replayed, provider: provider.name };
			}

			const { clientId, clientSecret } = await getOAuthCredentialsWithDb(
				provider,
				state.userId,
				state.organizationId,
			);
			if (!clientId || !clientSecret) {
				return {
					success: false,
					message: `${provider.name} OAuth not configured. Please add your app credentials in Settings > Integrations.`,
					provider: provider.name,
				};
			}

			try {
				// A GitLab grant is the person's ONE GitLab connection, written
				// by the connection service. Read its generation BEFORE the
				// exchange so a disconnect or another connect landing meanwhile
				// is not overwritten.
				const gitlabTenant = {
					userId: state.userId,
					organizationId: state.organizationId ?? null,
				};
				const gitlabGenerationBefore =
					providerType === "GITLAB"
						? await getGitLabConnectionGeneration(gitlabTenant)
						: undefined;

				// Exchange code for tokens
				const redirectUri =
					state.redirectUri ||
					`${process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL}/api/integrations/oauth/callback`;

				const tokenResponse = await exchangeCodeForTokens(
					provider,
					input.code,
					clientId,
					clientSecret,
					redirectUri,
				);

				// Get user info
				const userInfo = await provider.getUserInfo(
					tokenResponse.access_token,
				);

				// Prepare credentials for storage
				const credentials = JSON.stringify({
					access_token: tokenResponse.access_token,
					token_type: tokenResponse.token_type,
					scope: tokenResponse.scope,
					refresh_token: tokenResponse.refresh_token,
					expires_in: tokenResponse.expires_in,
					token_obtained_at: new Date().toISOString(),
					// Slack v2 OAuth: store user token separately for search:read scope
					...(tokenResponse.authed_user?.access_token && {
						user_access_token:
							tokenResponse.authed_user.access_token,
					}),
					// Slack v2 OAuth: capture team + bot identity so trigger
					// dispatch can route mentions back to this workspace.
					...(tokenResponse.team?.id && {
						team_id: tokenResponse.team.id,
						team_name: tokenResponse.team.name,
					}),
					...(tokenResponse.bot_user_id && {
						bot_user_id: tokenResponse.bot_user_id,
					}),
				});

				const workflowProvider =
					mapOAuthToWorkflowProvider(providerType);
				const dataConnectionProvider = mapOAuthToDataConnectionProvider(
					providerType,
					state.returnUrl,
				);

				// IMPORTANT: Explicitly use null for personal context (not undefined)
				// Prisma treats undefined as "skip field" which can cause issues
				const orgIdForQuery = state.organizationId ?? null;

				let integration:
					| Awaited<ReturnType<typeof db.workflowIntegration.create>>
					| Awaited<ReturnType<typeof db.workflowIntegration.update>>
					| null = null;

				if (workflowProvider === "GITLAB") {
					// Through the connection service, with the client that issued
					// this grant: a later refresh uses exactly that client, and a
					// PAT or an earlier grant is replaced whole (no leftover
					// refresh token or issuer).
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
							id: Number(userInfo.id) || 0,
							username: userInfo.login,
							name: userInfo.name ?? userInfo.login,
							avatarUrl: userInfo.avatarUrl ?? null,
						},
						issuer: await identifyGitLabIssuer(gitlabTenant, {
							clientId,
							origin: GITLAB_DEFAULT_ORIGIN,
						}),
						freshGrant: true,
						expectedGeneration: gitlabGenerationBefore,
					});
					if (!persisted.written) {
						return {
							success: false,
							message:
								"Your GitLab connection changed while this sign-in was completing. Please connect GitLab again.",
							provider: provider.name,
						};
					}
				} else if (workflowProvider) {
					// Exclude the <PROVIDER>_OAUTH_APP row: it shares provider,
					// user and organization with the connection row but holds
					// the OAuth client credentials saveAppCredentials stored.
					// Matching it renamed it into a connection and overwrote the
					// client id and secret with this token, switching OAuth off
					// for the organization once the admin who saved them
					// connected. Same guard as status/disconnect below.
					const existingIntegration =
						await db.workflowIntegration.findFirst({
							where: {
								userId: state.userId,
								provider: workflowProvider as any,
								NOT: { name: `${providerType}_OAUTH_APP` },
								...(orgIdForQuery
									? { organizationId: orgIdForQuery }
									: { organizationId: null }),
							},
						});

					const integrationData = {
						name: `${provider.name}: ${userInfo.login}`,
						credentials: encryptApiKey(credentials),
						settings: {
							oderId: userInfo.id,
							login: userInfo.login,
							name: userInfo.name,
							email: userInfo.email,
							avatarUrl: userInfo.avatarUrl,
							scope: tokenResponse.scope,
							hasRefreshToken: !!tokenResponse.refresh_token,
							connectedAt: new Date().toISOString(),
							tokenExpiresAt: tokenResponse.expires_in
								? new Date(
										Date.now() +
											tokenResponse.expires_in * 1000,
									).toISOString()
								: null,
						},
						isActive: true,
						updatedAt: new Date(),
					};

					if (existingIntegration) {
						integration = await db.workflowIntegration.update({
							where: { id: existingIntegration.id },
							data: integrationData,
						});
					} else {
						integration = await db.workflowIntegration.create({
							data: {
								userId: state.userId,
								organizationId: orgIdForQuery,
								provider: workflowProvider as any,
								...integrationData,
							},
						});
					}
				}

				if (dataConnectionProvider) {
					const existingConnection =
						await getDataConnectionByProvider({
							provider: dataConnectionProvider,
							userId: state.userId,
							organizationId: orgIdForQuery,
						});

					const tokenExpiresAt = tokenResponse.expires_in
						? new Date(Date.now() + tokenResponse.expires_in * 1000)
						: null;
					const connectionConfig = buildDefaultDataConnectionConfig({
						provider: providerType,
						login: userInfo.login,
						returnUrl: state.returnUrl,
					});
					const connectionCredentials = {
						access_token: tokenResponse.access_token,
						refresh_token: tokenResponse.refresh_token ?? null,
						scope: tokenResponse.scope,
						token_type: tokenResponse.token_type,
						token_obtained_at: new Date().toISOString(),
						// Slack v2 OAuth: store user token for search:read scope
						...(tokenResponse.authed_user?.access_token && {
							user_access_token:
								tokenResponse.authed_user.access_token,
						}),
					};
					const connectionCredentialsJson =
						connectionCredentials as Prisma.InputJsonValue;
					const connectionConfigJson =
						connectionConfig as Prisma.InputJsonValue;

					if (dataConnectionProvider === "GITLAB") {
						// A GitLab Data Connection holds no token: a sync uses
						// the GitLab connection (written above by the connection
						// service) of the person who starts it. An existing row
						// keeps its config — its GitLab address included — and
						// loses any legacy token copy.
						if (existingConnection) {
							await updateDataConnection({
								id: existingConnection.id,
								userId: state.userId,
								organizationId: orgIdForQuery,
								data: {
									name: `${provider.name}: ${userInfo.login}`,
									status: "CONNECTED",
									...GITLAB_DATA_CONNECTION_CLEARED_TOKENS,
									lastSyncError: null,
								},
							});
						} else {
							await createDataConnection({
								userId: state.userId,
								organizationId: orgIdForQuery,
								provider: dataConnectionProvider,
								name: `${provider.name}: ${userInfo.login}`,
								createdBy: state.userId,
								externalWorkspaceId: userInfo.id,
								externalWorkspaceName: userInfo.login,
								config: connectionConfigJson,
								status: "CONNECTED",
							});
						}
					} else if (existingConnection) {
						await updateDataConnection({
							id: existingConnection.id,
							userId: state.userId,
							organizationId: orgIdForQuery,
							data: {
								name: `${provider.name}: ${userInfo.login}`,
								status: "CONNECTED",
								accessToken: tokenResponse.access_token,
								refreshToken:
									tokenResponse.refresh_token ?? null,
								tokenExpiresAt,
								credentials: connectionCredentialsJson,
								config: connectionConfigJson,
								lastSyncError: null,
							},
						});
					} else {
						await createDataConnection({
							userId: state.userId,
							organizationId: orgIdForQuery,
							provider: dataConnectionProvider,
							name: `${provider.name}: ${userInfo.login}`,
							createdBy: state.userId,
							externalWorkspaceId: userInfo.id,
							externalWorkspaceName: userInfo.login,
							accessToken: tokenResponse.access_token,
							refreshToken: tokenResponse.refresh_token,
							tokenExpiresAt: tokenExpiresAt ?? undefined,
							credentials: connectionCredentialsJson,
							config: connectionConfigJson,
							status: "CONNECTED",
						});
					}
				}

				// Trigger tool and server ingestion workflows in parallel
				// This enables semantic search and routing for the OAuth integration
				if (
					integration &&
					(workflowProvider === "MICROSOFT_GRAPH" ||
						workflowProvider === "GITHUB")
				) {
					try {
						// Fire and forget - don't block the callback response
						Promise.all([
							triggerOAuthToolIngestion({
								integrationId: integration.id,
								provider: workflowProvider as
									| "MICROSOFT_GRAPH"
									| "GITHUB",
								userId: state.userId,
								organizationId:
									state.organizationId ?? undefined,
							}),
							triggerOAuthServerIngestion({
								integrationId: integration.id,
								provider: workflowProvider as
									| "MICROSOFT_GRAPH"
									| "GITHUB",
								userId: state.userId,
								organizationId:
									state.organizationId ?? undefined,
							}),
						]).catch((error) => {
							console.error(
								`Failed to trigger OAuth ingestion workflows for ${provider.name}:`,
								error,
							);
						});
					} catch (error) {
						// Log but don't fail the OAuth connection
						console.error(
							`Failed to start OAuth ingestion workflows for ${provider.name}:`,
							error,
						);
					}
				}

				return {
					success: true,
					message: `Connected ${provider.name} account: ${userInfo.login}`,
					provider: provider.name,
					returnUrl: state.returnUrl,
				};
			} catch (error) {
				console.error(`${provider.name} OAuth error:`, error);
				return {
					success: false,
					message:
						error instanceof Error
							? error.message
							: `${provider.name} OAuth failed`,
					provider: provider.name,
				};
			}
		}),

	/**
	 * Get connection status for any OAuth provider
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
			path: "/integrations/oauth/:provider/status",
			tags: ["Integrations", "OAuth"],
			summary: "Get OAuth connection status",
		})
		.input(
			z.object({
				provider: OAuthProviderEnum,
				organizationId: z.string().nullable().optional(),
			}),
		)
		.output(
			z.object({
				connected: z.boolean(),
				providerName: z.string(),
				login: z.string().optional(),
				name: z.string().nullable().optional(),
				email: z.string().nullable().optional(),
				avatarUrl: z.string().nullable().optional(),
				scope: z.string().optional(),
				hasRefreshToken: z.boolean().optional(),
				connectedAt: z.string().optional(),
				/**
				 * GitLab only: the person's connection as every GitLab screen
				 * shows it. A connection that needs reconnecting has
				 * `connected: false` here.
				 */
				connectionState: z
					.enum(["connected", "needs-reconnect", "not-connected"])
					.optional(),
			}),
		)
		.handler(async ({ input, context }) => {
			const provider = getOAuthProvider(input.provider);
			if (!provider) {
				return { connected: false, providerName: input.provider };
			}

			const userId = context.user.id;
			// Use explicit organizationId from input for proper tenant isolation
			// Only fall back to session if input is undefined (not explicitly passed)
			const organizationId =
				input.organizationId !== undefined
					? input.organizationId
					: context.session.activeOrganizationId;
			const workflowProvider = mapOAuthToWorkflowProvider(input.provider);

			// GitLab: the person's one connection, as every other GitLab
			// screen reports it (`readGitLabPersonalConnection`). A row that is
			// active but needs reconnecting is not "connected" here, and a
			// project repository link never makes the person connected.
			if (workflowProvider === "GITLAB") {
				// Resolved and authorized before the read, which can adopt a
				// legacy copy into a connection row in this tenant.
				const tenant = await authorizeGitLabTenant(
					Permissions.INTEGRATION_READ,
					input.organizationId,
					context,
				);
				const { summary, status } =
					await readGitLabPersonalConnection(tenant);
				if (summary.state !== "connected") {
					return {
						connected: false,
						providerName: provider.name,
						connectionState: summary.state,
					};
				}
				return {
					connected: true,
					providerName: provider.name,
					connectionState: summary.state,
					login: summary.account?.username ?? undefined,
					name: summary.account?.name ?? null,
					avatarUrl: summary.account?.avatarUrl ?? null,
					scope:
						typeof status.settings.scope === "string"
							? status.settings.scope
							: undefined,
					hasRefreshToken: status.hasRefreshToken,
					connectedAt:
						typeof status.settings.connectedAt === "string"
							? status.settings.connectedAt
							: undefined,
				};
			}

			// Strict isolation: personal context (null) only sees personal integrations
			// Exclude _OAUTH_APP config records (those store client_id/secret, not connection tokens)
			const integration = await db.workflowIntegration.findFirst({
				where: {
					userId,
					provider: workflowProvider as any,
					isActive: true,
					NOT: { name: `${input.provider}_OAUTH_APP` },
					...(organizationId
						? { organizationId }
						: { organizationId: null }),
				},
			});

			if (!integration) {
				return {
					connected: false,
					providerName: provider.name,
				};
			}

			const settings = integration.settings as Record<
				string,
				unknown
			> | null;

			return {
				connected: true,
				providerName: provider.name,
				login: settings?.login as string | undefined,
				name: settings?.name as string | null | undefined,
				email: settings?.email as string | null | undefined,
				avatarUrl: settings?.avatarUrl as string | null | undefined,
				scope: settings?.scope as string | undefined,
				hasRefreshToken: settings?.hasRefreshToken as
					| boolean
					| undefined,
				connectedAt: settings?.connectedAt as string | undefined,
			};
		}),

	/**
	 * Disconnect any OAuth provider
	 *
	 * IMPORTANT: organizationId must be explicitly passed for proper tenant isolation
	 */
	disconnect: tenantProtectedProcedure
		// The floor every provider shares. GitLab removes only the caller's
		// own connection, so `MCP_CONNECT` (what connecting one needs) is
		// enough for it; every other provider is held to
		// `INTEGRATION_DISCONNECT` in the handler, against the resolved
		// organization.
		.use(requirePermission(Permissions.MCP_CONNECT))
		.route({
			method: "POST",
			path: "/integrations/oauth/:provider/disconnect",
			tags: ["Integrations", "OAuth"],
			summary: "Disconnect OAuth integration",
		})
		.input(
			z.object({
				provider: OAuthProviderEnum,
				organizationId: z.string().nullable().optional(),
			}),
		)
		.output(z.object({ success: z.boolean() }))
		.handler(async ({ input, context }) => {
			const userId = context.user.id;
			const workflowProvider = mapOAuthToWorkflowProvider(input.provider);

			// Providers that don't map to a workflow integration row have
			// nothing to revoke or deactivate here. When `workflowProvider` is
			// null the cast below still produces a value Prisma rejects at
			// runtime, so no-op explicitly.
			if (!workflowProvider) {
				return { success: true };
			}

			// GitLab: the person's connection is owned by the connection
			// service. A bare `isActive: false` here would leave its token,
			// issuer and generation behind, would leave the MCP configs'
			// columns uncleared, and would not fence an in-flight refresh — so take the one
			// personal GitLab disconnect every surface shares (core
			// disconnect, revocation with the issuing client, the person's
			// Data Connections marked expired, one audit row).
			if (workflowProvider === "GITLAB") {
				await disconnectPersonalGitLab({
					tenant: await authorizeGitLabTenant(
						Permissions.MCP_CONNECT,
						input.organizationId,
						context,
					),
					surface: "integrations.oauth.disconnect",
					audit: context,
				});
				return { success: true };
			}

			// Any other provider: the admin-level permission, checked against
			// the organization this request resolves to, and every query,
			// revocation and log line below acts in THAT organization. The
			// procedure-wide floor is only `MCP_CONNECT` (for the GitLab
			// branch), so this check must not be skippable:
			// `requireOrganization` refuses a request that resolves no
			// organization (explicit null, or none in the session) instead of
			// passing it through with no role check — ADR-018 has no personal
			// tenant to disconnect in. Using the returned organization, not a
			// separately resolved one, keeps authorization and the writes on
			// the same tenant when a guest write organization
			// (`effectiveWriteOrgId`) differs from the session's.
			const organizationId = await authorizeInputOrganization(
				Permissions.INTEGRATION_DISCONNECT,
				input.organizationId,
				context,
				{ requireOrganization: true },
			);
			if (!organizationId) {
				// `requireOrganization` refuses this above; this only narrows.
				throw new ORPCError("FORBIDDEN", {
					message: "An organization is required",
				});
			}

			// Every active connection row, so each one's token is revoked —
			// never the _OAUTH_APP row, which holds the OAuth client
			// credentials rather than a token.
			const connections = await db.workflowIntegration.findMany({
				where: {
					userId,
					// `mapOAuthToWorkflowProvider` returns `string | null` but
					// every non-null value is a valid enum member — narrow back
					// via cast rather than refactoring the helper's return type
					// across all callers.
					provider: workflowProvider as WorkflowIntegrationProvider,
					isActive: true,
					NOT: { name: `${input.provider}_OAUTH_APP` },
					organizationId,
				},
			});

			// Best-effort: revoke the grant at the provider before we drop our
			// copy, so disconnect actually invalidates the token rather than
			// leaving it live until natural expiry. Only runs for providers
			// that expose a revocation endpoint; never fails the disconnect
			// if revocation errors. Decrypt and revoke are caught separately
			// so a key-rotation/AES-tag failure doesn't get misreported as a
			// network revoke failure.
			const providerConfig = getOAuthProvider(input.provider);
			if (providerConfig?.revokeAccessToken) {
				for (const activeRow of connections) {
					if (!activeRow.credentials) {
						continue;
					}
					let tokenToRevoke: string | undefined;
					try {
						const creds = JSON.parse(
							decryptApiKey(activeRow.credentials),
						) as {
							access_token?: string;
							refresh_token?: string;
						};
						// Prefer the refresh token — revoking it invalidates the
						// entire grant (Google), not just one access token.
						tokenToRevoke =
							creds.refresh_token ?? creds.access_token;
					} catch (decryptError) {
						logger.error(
							`[OAuthDisconnect] Failed to decrypt ${input.provider} credentials for integration ${activeRow.id} (user=${userId}, org=${organizationId}): ${decryptError instanceof Error ? decryptError.message : String(decryptError)}`,
						);
					}
					if (tokenToRevoke) {
						try {
							await providerConfig.revokeAccessToken(
								tokenToRevoke,
							);
						} catch (revokeError) {
							logger.error(
								`[OAuthDisconnect] Failed to revoke ${input.provider} token for integration ${activeRow.id} (user=${userId}, org=${organizationId}): ${revokeError instanceof Error ? revokeError.message : String(revokeError)}`,
							);
						}
					}
				}
			}

			// Deactivate the connection rows, but NOT the _OAUTH_APP config
			// record.
			await db.workflowIntegration.updateMany({
				where: {
					userId,
					provider: workflowProvider as WorkflowIntegrationProvider,
					NOT: { name: `${input.provider}_OAUTH_APP` },
					organizationId,
				},
				data: {
					isActive: false,
				},
			});

			// Also disconnect matching DataConnection if provider maps to one
			const dataConnectionProvider = mapOAuthToDataConnectionProvider(
				input.provider,
			);
			if (dataConnectionProvider) {
				await db.dataConnection.updateMany({
					where: {
						userId,
						provider: dataConnectionProvider,
						organizationId,
					},
					data: {
						status: "EXPIRED",
					},
				});
			}

			return { success: true };
		}),

	/**
	 * Get access token for an OAuth provider (for use by other services)
	 * Handles token refresh if needed
	 *
	 * IMPORTANT: organizationId must be explicitly passed for proper tenant isolation
	 */
	getAccessToken: tenantProtectedProcedure
		.use(requirePermission(Permissions.INTEGRATION_READ))
		.route({
			method: "GET",
			path: "/integrations/oauth/:provider/token",
			tags: ["Integrations", "OAuth"],
			summary: "Get access token for OAuth provider",
		})
		.input(
			z.object({
				provider: OAuthProviderEnum,
				organizationId: z.string().nullable().optional(),
			}),
		)
		.output(
			z.object({
				success: z.boolean(),
				accessToken: z.string().optional(),
				error: z.string().optional(),
			}),
		)
		.handler(async ({ input, context }) => {
			const provider = getOAuthProvider(input.provider);
			if (!provider) {
				return {
					success: false,
					error: `Unknown provider: ${input.provider}`,
				};
			}

			const userId = context.user.id;
			// Use explicit organizationId from input for proper tenant isolation
			const organizationId =
				input.organizationId !== undefined
					? input.organizationId
					: context.session.activeOrganizationId;
			const workflowProvider = mapOAuthToWorkflowProvider(input.provider);

			// GitLab: the connection service reads (and refreshes) the token
			// with the client that issued it; rebuilding the credential here
			// would drop that issuer and the connection generation.
			// A bare token carries no GitLab instance, so this hands out only a
			// gitlab.com credential (the service's default refuses any other).
			if (workflowProvider === "GITLAB") {
				const token = await getGitLabConnectionToken(
					await authorizeGitLabTenant(
						Permissions.INTEGRATION_READ,
						input.organizationId,
						context,
					),
					{ mode: "strict" },
				);
				if (token.ok) {
					return { success: true, accessToken: token.accessToken };
				}
				return {
					success: false,
					error:
						token.reason === "not-connected"
							? `${provider.name} not connected`
							: token.reason === "unsupported-origin"
								? `${provider.name} is connected to a self-hosted instance, which this endpoint does not support.`
								: `${provider.name} token expired and cannot be refreshed. Please reconnect.`,
				};
			}

			const integration = await db.workflowIntegration.findFirst({
				where: {
					userId,
					provider: workflowProvider as any,
					NOT: { name: `${input.provider}_OAUTH_APP` },
					isActive: true,
					...(organizationId
						? { organizationId }
						: { organizationId: null }),
				},
			});

			if (!integration) {
				return {
					success: false,
					error: `${provider.name} not connected`,
				};
			}

			try {
				const credentialsJson = decryptApiKey(integration.credentials);
				const credentials = JSON.parse(credentialsJson) as {
					access_token: string;
					refresh_token?: string;
					expires_in?: number;
					token_obtained_at?: string;
				};

				// Check if token is expired and needs refresh
				if (
					provider.supportsRefreshToken &&
					credentials.refresh_token &&
					credentials.expires_in
				) {
					// If token_obtained_at is missing (pre-patch connection),
					// conservatively treat as expired to trigger refresh
					const expiresIn = credentials.expires_in;
					const isExpired = !credentials.token_obtained_at
						? true
						: (() => {
								const obtainedAt = new Date(
									credentials.token_obtained_at,
								).getTime();
								const expiresAt = obtainedAt + expiresIn * 1000;
								const bufferMs = 5 * 60 * 1000;
								return Date.now() >= expiresAt - bufferMs;
							})();

					if (isExpired) {
						// Token expired or about to expire — refresh it
						const { clientId: cId, clientSecret: cSecret } =
							await getOAuthCredentialsWithDb(
								provider,
								userId,
								organizationId,
							);
						if (!cId || !cSecret || !provider.refreshAccessToken) {
							return {
								success: false,
								error: `${provider.name} token expired and cannot be refreshed. Please reconnect.`,
							};
						}

						try {
							const refreshed = await provider.refreshAccessToken(
								credentials.refresh_token,
								cId,
								cSecret,
							);

							// Store refreshed credentials
							const newCredentials = JSON.stringify({
								access_token: refreshed.access_token,
								token_type: refreshed.token_type,
								scope: refreshed.scope,
								refresh_token:
									refreshed.refresh_token ||
									credentials.refresh_token,
								expires_in: refreshed.expires_in,
								token_obtained_at: new Date().toISOString(),
							});

							await db.workflowIntegration.update({
								where: { id: integration.id },
								data: {
									credentials: encryptApiKey(newCredentials),
									settings: {
										...(typeof integration.settings ===
											"object" &&
										integration.settings !== null
											? integration.settings
											: {}),
										tokenExpiresAt: refreshed.expires_in
											? new Date(
													Date.now() +
														refreshed.expires_in *
															1000,
												).toISOString()
											: null,
									},
									updatedAt: new Date(),
								},
							});

							return {
								success: true,
								accessToken: refreshed.access_token,
							};
						} catch (refreshError) {
							console.error(
								`Failed to refresh ${provider.name} token:`,
								refreshError,
							);
							return {
								success: false,
								error: `${provider.name} token expired and refresh failed. Please reconnect.`,
							};
						}
					}
				}

				return {
					success: true,
					accessToken: credentials.access_token,
				};
			} catch {
				return {
					success: false,
					error: "Failed to retrieve access token",
				};
			}
		}),

	/**
	 * Refresh OAuth tools - trigger re-ingestion into Qdrant
	 * This re-syncs tool definitions from the registry
	 *
	 * IMPORTANT: organizationId must be explicitly passed for proper tenant isolation
	 */
	refreshTools: tenantProtectedProcedure
		.use(requirePermission(Permissions.INTEGRATION_USE))
		.route({
			method: "POST",
			path: "/integrations/oauth/:provider/refresh-tools",
			tags: ["Integrations", "OAuth"],
			summary: "Refresh OAuth integration tools",
		})
		.input(
			z.object({
				provider: OAuthProviderEnum,
				organizationId: z.string().nullable().optional(),
			}),
		)
		.output(
			z.object({
				success: z.boolean(),
				toolCount: z.number(),
				version: z.string(),
				message: z.string(),
				error: z.string().optional(),
			}),
		)
		.handler(async ({ input, context }) => {
			const provider = getOAuthProvider(input.provider);
			if (!provider) {
				return {
					success: false,
					toolCount: 0,
					version: "0.0.0",
					message: `Unknown provider: ${input.provider}`,
				};
			}

			const userId = context.user.id;
			const workflowProvider = mapOAuthToWorkflowProvider(input.provider);
			// GitLab: resolved and authorized before the connection read
			// below, which can classify a legacy connection row in this tenant.
			const gitlabTenant =
				workflowProvider === "GITLAB"
					? await authorizeGitLabTenant(
							Permissions.INTEGRATION_USE,
							input.organizationId,
							context,
						)
					: null;
			// Use explicit organizationId from input for proper tenant isolation
			const organizationId = gitlabTenant
				? gitlabTenant.organizationId
				: input.organizationId !== undefined
					? input.organizationId
					: context.session.activeOrganizationId;

			// Check if integration exists and is active. GitLab: the person's
			// usable connection through the connection service, which reads a
			// reconnect-required connection as not connected.
			const integration =
				workflowProvider === "GITLAB"
					? await findUsableGitLabConnection(
							gitlabTenant ?? {
								userId,
								organizationId: organizationId ?? null,
							},
						).then((found) =>
							found ? { id: found.integrationId } : null,
						)
					: await db.workflowIntegration.findFirst({
							where: {
								userId,
								provider: workflowProvider as any,
								NOT: { name: `${input.provider}_OAUTH_APP` },
								isActive: true,
								...(organizationId
									? { organizationId }
									: { organizationId: null }),
							},
						});

			if (!integration) {
				return {
					success: false,
					toolCount: 0,
					version: "0.0.0",
					message: `${provider.name} not connected`,
				};
			}

			try {
				// Trigger both OAuth tool and server ingestion workflows
				const [toolResult, serverResult] = await Promise.all([
					triggerOAuthToolIngestion({
						integrationId: integration.id,
						provider: workflowProvider as
							| "MICROSOFT_GRAPH"
							| "GITHUB",
						userId,
						organizationId: organizationId ?? undefined,
					}),
					triggerOAuthServerIngestion({
						integrationId: integration.id,
						provider: workflowProvider as
							| "MICROSOFT_GRAPH"
							| "GITHUB",
						userId,
						organizationId: organizationId ?? undefined,
					}),
				]);

				if (toolResult?.workflowId || serverResult?.workflowId) {
					return {
						success: true,
						toolCount: 0, // Will be updated after workflow completes
						version: "pending",
						message: `Tool and server refresh workflows started (tools: ${toolResult?.workflowId}, server: ${serverResult?.workflowId})`,
					};
				}

				return {
					success: false,
					toolCount: 0,
					version: "0.0.0",
					message: "Temporal not available - refresh failed",
					error: "Temporal not available",
				};
			} catch (error) {
				console.error(`${provider.name} refresh error:`, error);
				return {
					success: false,
					toolCount: 0,
					version: "0.0.0",
					message:
						error instanceof Error
							? error.message
							: "Failed to refresh tools",
					error:
						error instanceof Error ? error.message : String(error),
				};
			}
		}),

	/**
	 * Save OAuth app credentials (client_id, client_secret) from the UI.
	 * Stored in WorkflowIntegration with name="<PROVIDER>_OAUTH_APP".
	 * This allows configuring OAuth providers without .env files.
	 */
	saveAppCredentials: tenantProtectedProcedure
		.use(requireInputOrgPermission(Permissions.INTEGRATION_CONNECT))
		.route({
			method: "POST",
			path: "/integrations/oauth/:provider/app-credentials",
			tags: ["Integrations", "OAuth"],
			summary: "Save OAuth app credentials (client ID & secret)",
		})
		.input(
			z.object({
				provider: OAuthProviderEnum,
				clientId: z.string().min(1),
				clientSecret: z.string().min(1),
				organizationId: z.string().nullable().optional(),
			}),
		)
		.output(z.object({ success: z.boolean(), message: z.string() }))
		.handler(async ({ input, context }) => {
			const provider = getOAuthProvider(input.provider);
			if (!provider) {
				throw new ORPCError("BAD_REQUEST", {
					message: `Unknown OAuth provider: ${input.provider}`,
				});
			}

			const userId = context.user.id;
			const organizationId = resolveOrganizationId(
				input.organizationId,
				context.session,
			);

			const appConfigName = `${input.provider}_OAUTH_APP`;
			const workflowProvider = mapOAuthToWorkflowProvider(input.provider);

			// Encrypt credentials
			const encryptedCredentials = encryptApiKey(
				JSON.stringify({
					client_id: input.clientId,
					client_secret: input.clientSecret,
				}),
			);

			// Find existing app config
			const existing = await db.workflowIntegration.findFirst({
				where: {
					name: appConfigName,
					provider: workflowProvider as any,
					...(organizationId
						? { organizationId }
						: { userId, organizationId: null }),
				},
			});

			if (existing) {
				await db.workflowIntegration.update({
					where: { id: existing.id },
					data: {
						credentials: encryptedCredentials,
						isActive: true,
						updatedAt: new Date(),
					},
				});
			} else {
				await db.workflowIntegration.create({
					data: {
						userId,
						organizationId: organizationId ?? null,
						provider: workflowProvider as any,
						name: appConfigName,
						credentials: encryptedCredentials,
						isActive: true,
					},
				});
			}

			return {
				success: true,
				message: `${provider.name} app credentials saved successfully`,
			};
		}),

	/**
	 * Check if OAuth app credentials are stored in the database.
	 */
	hasAppCredentials: tenantProtectedProcedure
		.use(requireInputOrgPermission(Permissions.INTEGRATION_READ))
		.route({
			method: "GET",
			path: "/integrations/oauth/:provider/app-credentials",
			tags: ["Integrations", "OAuth"],
			summary: "Check if OAuth app credentials are stored",
		})
		.input(
			z.object({
				provider: OAuthProviderEnum,
				organizationId: z.string().nullable().optional(),
			}),
		)
		.output(
			z.object({
				hasCredentials: z.boolean(),
				hasEnvCredentials: z.boolean(),
				maskedClientId: z.string().optional(),
			}),
		)
		.handler(async ({ input, context }) => {
			const provider = getOAuthProvider(input.provider);
			if (!provider) {
				return {
					hasCredentials: false,
					hasEnvCredentials: false,
				};
			}

			// Check .env
			const envCreds = getOAuthCredentials(provider);
			const hasEnvCredentials = !!(
				envCreds.clientId && envCreds.clientSecret
			);

			if (hasEnvCredentials) {
				return {
					hasCredentials: true,
					hasEnvCredentials: true,
					maskedClientId: `${envCreds.clientId?.substring(0, 8)}...`,
				};
			}

			// Check database
			const userId = context.user.id;
			const organizationId =
				input.organizationId !== undefined
					? input.organizationId
					: context.session.activeOrganizationId;

			const appConfigName = `${input.provider}_OAUTH_APP`;
			const workflowProvider = mapOAuthToWorkflowProvider(input.provider);

			const appConfig = await db.workflowIntegration.findFirst({
				where: {
					name: appConfigName,
					provider: workflowProvider as any,
					isActive: true,
					...(organizationId
						? { organizationId }
						: { userId, organizationId: null }),
				},
			});

			if (appConfig?.credentials) {
				try {
					const decrypted = JSON.parse(
						decryptApiKey(appConfig.credentials),
					) as Record<string, string>;
					if (decrypted.client_id) {
						return {
							hasCredentials: true,
							hasEnvCredentials: false,
							maskedClientId: `${decrypted.client_id.substring(0, 8)}...`,
						};
					}
				} catch {
					// Decryption failed
				}
			}

			return {
				hasCredentials: false,
				hasEnvCredentials: false,
			};
		}),

	/**
	 * Save a direct bot token for an OAuth provider (bypasses OAuth flow).
	 * Stores in the same format as the OAuth callback would, so downstream
	 * code (getSlackCredentials, etc.) can read it the same way.
	 */
	saveBotToken: tenantProtectedProcedure
		.use(requireInputOrgPermission(Permissions.INTEGRATION_CONNECT))
		.route({
			method: "POST",
			path: "/integrations/oauth/:provider/bot-token",
			tags: ["Integrations", "OAuth"],
			summary: "Save a direct bot token",
		})
		.input(
			z.object({
				provider: OAuthProviderEnum,
				botToken: z.string().min(1),
				organizationId: z.string().nullable().optional(),
			}),
		)
		.output(z.object({ success: z.boolean(), message: z.string() }))
		.handler(async ({ input, context }) => {
			const provider = getOAuthProvider(input.provider);
			if (!provider) {
				throw new ORPCError("BAD_REQUEST", {
					message: `Unknown OAuth provider: ${input.provider}`,
				});
			}

			// saveBotToken currently only supports Slack — guard against other providers
			if (input.provider !== "SLACK") {
				throw new ORPCError("BAD_REQUEST", {
					message: `Bot token flow is only supported for Slack. Use the OAuth flow for ${provider.name}.`,
				});
			}

			const userId = context.user.id;
			const organizationId = resolveOrganizationId(
				input.organizationId,
				context.session,
			);
			const workflowProvider = mapOAuthToWorkflowProvider(input.provider);

			// Validate bot token by calling auth.test
			let botInfo: { user_id?: string; user?: string; team?: string };
			try {
				const authResponse = await fetch(
					"https://slack.com/api/auth.test",
					{
						headers: {
							Authorization: `Bearer ${input.botToken}`,
						},
					},
				);
				const authData = (await authResponse.json()) as {
					ok: boolean;
					user_id?: string;
					user?: string;
					team?: string;
					error?: string;
				};
				if (!authData.ok) {
					throw new Error(authData.error || "Invalid token");
				}
				botInfo = authData;
			} catch (error) {
				const msg =
					error instanceof Error ? error.message : "Unknown error";
				throw new ORPCError("BAD_REQUEST", {
					message: `Invalid Slack bot token: ${msg}`,
				});
			}

			// Store in the same format as OAuth callback
			const credentials = JSON.stringify({
				access_token: input.botToken,
				token_type: "bot",
			});

			const orgIdForQuery = organizationId ?? null;

			// Find existing connection (exclude _OAUTH_APP config records)
			const existing = await db.workflowIntegration.findFirst({
				where: {
					userId,
					provider: workflowProvider as any,
					NOT: { name: `${input.provider}_OAUTH_APP` },
					...(orgIdForQuery
						? { organizationId: orgIdForQuery }
						: { organizationId: null }),
				},
			});

			const integrationData = {
				name: `${provider.name}: ${botInfo.user || "Bot"}`,
				credentials: encryptApiKey(credentials),
				settings: {
					login: botInfo.user || "Bot",
					name: botInfo.team || null,
					connectedAt: new Date().toISOString(),
					connectionMethod: "bot_token",
				},
				isActive: true,
				updatedAt: new Date(),
			};

			if (existing) {
				await db.workflowIntegration.update({
					where: { id: existing.id },
					data: integrationData,
				});
			} else {
				await db.workflowIntegration.create({
					data: {
						userId,
						organizationId: orgIdForQuery,
						provider: workflowProvider as any,
						...integrationData,
					},
				});
			}

			return {
				success: true,
				message: `Connected ${provider.name} workspace: ${botInfo.team || "workspace"}`,
			};
		}),
};
