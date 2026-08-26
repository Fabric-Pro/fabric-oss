/**
 * Hybrid Atlassian Cloud OAuth 2.0 (3LO) — PR #1169.
 *
 * Secondary OAuth flow chained off the primary Rovo MCP OAuth. Returns
 * a token whose audience is `api.atlassian.com` (not
 * `mcp.atlassian.com`), enabling REST attachment upload + site-direct
 * attachment URL rewriting for Jira push. Sits next to (not replacing)
 * the primary `mcp/oauth.start` + `mcp/oauth.callback` procedures.
 *
 * # Why a separate token, not just Rovo
 * Rovo's MCP audience-locked token returns 401 at `api.atlassian.com`
 * (probed live, see `project_pm_sync_jira_hybrid_oauth.md` memory).
 * Rovo's tool surface has no attachment upload (open Atlassian issue
 * since Feb 2026, no ETA). The only way to create a Jira attachment
 * with the right size limits + site-direct URL format is the standalone
 * 3LO REST path.
 *
 * # Why the flow isn't bundled into the primary OAuth flow
 * - Standalone Atlassian OAuth (auth.atlassian.com) does NOT support
 *   DCR — clients must be pre-registered at
 *   developer.atlassian.com/console with a fixed callback URL.
 * - Pre-registered apps cannot share their redirect_uri with the Rovo
 *   audience (different audience claim → different consent screen).
 * - User runs both consent screens back-to-back during a single
 *   "Connect Atlassian" click; the secondary screen is skippable.
 *
 * # Graceful degradation
 * - Cloud token absent → Jira upload helper degrades to base64 inline
 *   (existing PR #1167 behaviour).
 * - Cloud token expired → refresh path attempts rotation; failure →
 *   degrade.
 * - 3 consecutive refresh failures → `atlassianCloudRefreshFailureCount`
 *   trips; degrade. Primary Rovo connection NEVER affected.
 *
 * # Required env vars (per environment)
 *   ATLASSIAN_CLOUD_OAUTH_CLIENT_ID     — public OAuth client identifier
 *   ATLASSIAN_CLOUD_OAUTH_CLIENT_SECRET — confidential OAuth secret
 *
 * # Required scopes
 *   read:me read:jira-user read:jira-work write:jira-work
 *   read:attachment:jira write:attachment:jira offline_access
 */

import { ORPCError } from "@orpc/server";
import {
	createOauthState,
	deleteOauthState,
	getMcpConfigByIdInternal,
	getOauthState,
	getOrganizationById,
	updateMcpAtlassianCloudTokens,
} from "@repo/database";
import { encryptApiKey } from "@repo/utils";
import {
	assertSafeOutboundUrl,
	safeFetchOutbound,
} from "@repo/utils/url-security";
import { z } from "zod";
import {
	Permissions,
	publicProcedure,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";
import {
	generateCodeChallenge,
	generateCodeVerifier,
} from "../lib/oauth-discovery";

const AUTHORIZATION_ENDPOINT = "https://auth.atlassian.com/authorize";
const TOKEN_ENDPOINT = "https://auth.atlassian.com/oauth/token";
const ACCESSIBLE_RESOURCES_ENDPOINT =
	"https://api.atlassian.com/oauth/token/accessible-resources";

/**
 * Granular OAuth scopes for Jira attachment + issue operations.
 *
 * Atlassian's OAuth 2.0 (3LO) supports both legacy (e.g. `read:jira-work`)
 * and granular (e.g. `read:attachment:jira`) scope names. We request
 * BOTH variants — granular for new-style enforcement, legacy for back-compat
 * with sites that haven't been migrated to granular scopes.
 *
 * `offline_access` is required to get a refresh_token in the response.
 */
const REQUIRED_SCOPES = [
	"read:me",
	"read:jira-user",
	"read:jira-work",
	"write:jira-work",
	"read:attachment:jira",
	"write:attachment:jira",
	"read:issue:jira",
	"write:issue:jira",
	"offline_access",
];

/**
 * Reject the literal string "placeholder" — that's the value Key Vault
 * is seeded with before real secrets are synced. Without this filter,
 * `process.env.ATLASSIAN_CLOUD_OAUTH_CLIENT_ID === "placeholder"` would
 * pass the truthy check and the OAuth flow would 401 with a confusing
 * error from Atlassian. Treating "placeholder" as "not configured"
 * keeps the no-secrets path symmetric with the missing-env-var path.
 */
function isConfiguredEnvValue(v: string | undefined): v is string {
	return !!v && v !== "placeholder";
}

function getEnvCredentials(): {
	clientId: string;
	clientSecret: string;
} | null {
	const clientId = process.env.ATLASSIAN_CLOUD_OAUTH_CLIENT_ID;
	const clientSecret = process.env.ATLASSIAN_CLOUD_OAUTH_CLIENT_SECRET;
	if (
		!isConfiguredEnvValue(clientId) ||
		!isConfiguredEnvValue(clientSecret)
	) {
		return null;
	}
	return { clientId, clientSecret };
}

async function authorizeConfigAccess(
	configId: string,
	userId: string,
): Promise<{
	cfg: NonNullable<Awaited<ReturnType<typeof getMcpConfigByIdInternal>>>;
}> {
	const cfg = await getMcpConfigByIdInternal(configId);
	if (!cfg) {
		throw new ORPCError("NOT_FOUND", { message: "MCP config not found" });
	}

	if (cfg.userId) {
		if (cfg.userId !== userId) {
			throw new ORPCError("FORBIDDEN", {
				message: "You do not have access to this MCP config",
			});
		}
	} else if (cfg.organizationId) {
		const organization = await getOrganizationById(cfg.organizationId);
		if (!organization) {
			throw new ORPCError("NOT_FOUND", {
				message: "Organization not found",
			});
		}
		const membership = await verifyOrganizationMembership(
			cfg.organizationId,
			userId,
		);
		if (!membership) {
			throw new ORPCError("FORBIDDEN", {
				message: "You are not a member of this organization",
			});
		}
		if (membership.role !== "admin" && membership.role !== "owner") {
			throw new ORPCError("FORBIDDEN", {
				message:
					"Only organization admins can manage Atlassian Cloud OAuth for this MCP config",
			});
		}
	} else {
		throw new ORPCError("INTERNAL_SERVER_ERROR", {
			message: "MCP config must belong to a user or an organization",
		});
	}

	return { cfg };
}

export const atlassianCloudProcedures = {
	/**
	 * Begin a hybrid 3LO flow for the given MCP config. Returns the
	 * Atlassian authorization URL + state token. The state token is
	 * stored in the SAME MCPOAuthState table as the primary flow so the
	 * callback handler can validate it.
	 */
	start: tenantProtectedProcedure
		.use(requirePermission(Permissions.MCP_CONNECT))
		.route({
			method: "POST",
			path: "/mcp/atlassian-cloud/start",
			tags: ["MCP", "Atlassian"],
			summary:
				"Start hybrid Atlassian Cloud OAuth 3LO flow for image-attachment support",
		})
		.input(
			z.object({
				configId: z.string(),
				redirectUri: z.string().url(),
			}),
		)
		.output(
			z.object({ authorizationUrl: z.string().url(), state: z.string() }),
		)
		.handler(async ({ input, context }) => {
			const creds = getEnvCredentials();
			if (!creds) {
				throw new ORPCError("BAD_REQUEST", {
					message:
						"Atlassian Cloud OAuth not configured for this environment — set ATLASSIAN_CLOUD_OAUTH_CLIENT_ID and ATLASSIAN_CLOUD_OAUTH_CLIENT_SECRET",
				});
			}

			const { cfg } = await authorizeConfigAccess(
				input.configId,
				context.user.id,
			);

			const codeVerifier = generateCodeVerifier();
			const codeChallenge = generateCodeChallenge(codeVerifier);

			const state = await createOauthState({
				mcpServerId: cfg.mcpServerId,
				configId: cfg.id,
				userId: context.user.id,
				organizationId: cfg.organizationId ?? undefined,
				codeVerifier,
				redirectUri: input.redirectUri,
			});

			const params = new URLSearchParams({
				audience: "api.atlassian.com",
				client_id: creds.clientId,
				scope: REQUIRED_SCOPES.join(" "),
				redirect_uri: input.redirectUri,
				state,
				response_type: "code",
				prompt: "consent",
				code_challenge: codeChallenge,
				code_challenge_method: "S256",
			});

			return {
				authorizationUrl: `${AUTHORIZATION_ENDPOINT}?${params.toString()}`,
				state,
			};
		}),

	/**
	 * Exchange an authorization code for tokens, fetch the accessible
	 * resources to identify the user's Atlassian site, and persist the
	 * encrypted tokens + cloudId to the MCPConfig row.
	 *
	 * If the response contains multiple accessible resources, we pick
	 * the first one (matches the user's primary site). A future
	 * enhancement could let the user choose during the consent flow.
	 */
	callback: publicProcedure
		.use(requirePermission(Permissions.MCP_UPDATE))
		.route({
			method: "GET",
			path: "/mcp/atlassian-cloud/callback",
			tags: ["MCP", "Atlassian"],
			summary: "Handle hybrid Atlassian Cloud OAuth callback",
		})
		.input(
			z.object({
				code: z.string().optional(),
				state: z.string().optional(),
				error: z.string().optional(),
				error_description: z.string().optional(),
			}),
		)
		.output(z.object({ success: z.boolean(), message: z.string() }))
		.handler(async ({ input }) => {
			if (input.error) {
				return {
					success: false,
					message:
						input.error_description ||
						input.error ||
						"Atlassian denied the authorization request",
				};
			}
			if (!input.state || !input.code) {
				return { success: false, message: "Missing state or code" };
			}

			const creds = getEnvCredentials();
			if (!creds) {
				return {
					success: false,
					message:
						"Atlassian Cloud OAuth not configured for this environment",
				};
			}

			const stateRecord = await getOauthState(input.state);
			if (!stateRecord) {
				return { success: false, message: "Invalid state" };
			}

			const now = new Date();
			if (stateRecord.expiresAt && stateRecord.expiresAt < now) {
				await deleteOauthState(input.state);
				return {
					success: false,
					message: "Authorization state expired — please retry",
				};
			}

			const cfg = await getMcpConfigByIdInternal(stateRecord.configId);
			if (!cfg) {
				return { success: false, message: "Config not found" };
			}
			if (stateRecord.organizationId !== cfg.organizationId) {
				return {
					success: false,
					message:
						"Organization context mismatch — Atlassian Cloud OAuth was initiated in a different context",
				};
			}

			assertSafeOutboundUrl(TOKEN_ENDPOINT);
			const tokenBody = new URLSearchParams({
				grant_type: "authorization_code",
				client_id: creds.clientId,
				client_secret: creds.clientSecret,
				code: input.code,
				redirect_uri: stateRecord.redirectUri || "",
			});
			if (stateRecord.codeVerifier) {
				tokenBody.set("code_verifier", stateRecord.codeVerifier);
			}

			const tokenRes = await safeFetchOutbound(TOKEN_ENDPOINT, {
				method: "POST",
				headers: {
					"content-type": "application/x-www-form-urlencoded",
					accept: "application/json",
				},
				body: tokenBody,
			});
			const tokenJson = (await tokenRes
				.json()
				.catch(() => null)) as Record<string, unknown> | null;
			if (!tokenRes.ok || !tokenJson) {
				const errMsg =
					(tokenJson?.error_description as string | undefined) ||
					(tokenJson?.error as string | undefined) ||
					`HTTP ${tokenRes.status}`;
				return {
					success: false,
					message: `Atlassian token exchange failed: ${errMsg}`,
				};
			}

			const accessToken = tokenJson.access_token as string | undefined;
			const refreshToken =
				(tokenJson.refresh_token as string | undefined) ?? null;
			const expiresIn =
				(tokenJson.expires_in as number | undefined) ?? null;
			const scopeStr = (tokenJson.scope as string | undefined) ?? "";
			const scopesGranted = scopeStr
				.split(" ")
				.map((s) => s.trim())
				.filter(Boolean);
			if (!accessToken) {
				return {
					success: false,
					message:
						"Atlassian token response did not include access_token",
				};
			}

			assertSafeOutboundUrl(ACCESSIBLE_RESOURCES_ENDPOINT);
			const resourcesRes = await safeFetchOutbound(
				ACCESSIBLE_RESOURCES_ENDPOINT,
				{
					method: "GET",
					headers: {
						authorization: `Bearer ${accessToken}`,
						accept: "application/json",
					},
				},
			);
			const resourcesJson = (await resourcesRes
				.json()
				.catch(() => null)) as Array<{
				id: string;
				url: string;
				name?: string;
				scopes?: string[];
			}> | null;
			if (!resourcesRes.ok || !Array.isArray(resourcesJson)) {
				return {
					success: false,
					message: `Atlassian accessible-resources failed: HTTP ${resourcesRes.status}`,
				};
			}
			if (resourcesJson.length === 0) {
				return {
					success: false,
					message:
						"No Atlassian sites accessible to the granted token — does this user have a Jira site?",
				};
			}
			// Keep every site with a valid id+url. The token grants access
			// to ALL of them, so the PM-sync upload path routes each Jira
			// issue to its OWN site (the issue's cloudId is embedded in the
			// story's externalUrl). Accounts with multiple Atlassian sites
			// push issues to different ones — binding to a single "primary"
			// site (the old behaviour) sent uploads to the wrong tenant.
			const accessibleResources = resourcesJson
				.filter((r) => r?.id && r.url)
				.map((r) => ({ id: r.id, url: r.url, name: r.name }));
			if (accessibleResources.length === 0) {
				return {
					success: false,
					message:
						"Atlassian accessible-resources response missing id/url for every site",
				};
			}
			// The "primary" site is still stored for the banner display +
			// back-compat, but the upload path no longer depends on it.
			const primary = accessibleResources[0];

			const tokenExpiresAt = expiresIn
				? new Date(Date.now() + expiresIn * 1000)
				: null;

			await updateMcpAtlassianCloudTokens({
				configId: cfg.id,
				encryptedAccessToken: encryptApiKey(accessToken),
				encryptedRefreshToken: refreshToken
					? encryptApiKey(refreshToken)
					: null,
				tokenExpiresAt,
				siteUrl: primary.url,
				cloudId: primary.id,
				scopes: scopesGranted,
				accessibleResources,
			});

			await deleteOauthState(input.state);

			const siteList =
				accessibleResources.length === 1
					? primary.url
					: `${accessibleResources.length} Atlassian sites`;
			return {
				success: true,
				message: `Atlassian Cloud connected for image-attachment uploads on ${siteList}`,
			};
		}),

	/**
	 * Read-only status probe for the UI banner. Returns whether the
	 * Cloud token is configured + the site URL + the current
	 * refresh-failure count. Does NOT return token material.
	 */
	status: tenantProtectedProcedure
		.use(requirePermission(Permissions.MCP_CONNECT))
		.route({
			method: "GET",
			path: "/mcp/atlassian-cloud/status",
			tags: ["MCP", "Atlassian"],
			summary: "Get Atlassian Cloud connection status for an MCP config",
		})
		.input(z.object({ configId: z.string() }))
		.output(
			z.object({
				connected: z.boolean(),
				siteUrl: z.string().nullable(),
				connectedAt: z.string().nullable(),
				refreshFailureCount: z.number().int().nonnegative(),
				lastRefreshError: z.string().nullable(),
				envConfigured: z.boolean(),
			}),
		)
		.handler(async ({ input, context }) => {
			const { cfg } = await authorizeConfigAccess(
				input.configId,
				context.user.id,
			);
			return {
				connected: cfg.encryptedAtlassianCloudAccessToken !== null,
				siteUrl: cfg.atlassianCloudSiteUrl ?? null,
				connectedAt: cfg.atlassianCloudConnectedAt
					? cfg.atlassianCloudConnectedAt.toISOString()
					: null,
				refreshFailureCount: cfg.atlassianCloudRefreshFailureCount ?? 0,
				lastRefreshError: cfg.atlassianCloudLastRefreshError ?? null,
				envConfigured: getEnvCredentials() !== null,
			};
		}),
};
