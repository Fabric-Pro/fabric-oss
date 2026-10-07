/**
 * v1 MCP routes
 * GET /mcp/servers      list accessible MCP servers (system + tenant's custom)
 * GET /mcp/configs      list tenant's MCP configurations
 * GET /mcp/configs/:id  get a specific MCP config
 */
import {
	credentialFingerprintMatches,
	deleteMcpConfig,
	getMcpConfigById,
	getOrganizationMembership,
	getValidAccessToken,
	isGitLabPersonalMcpServerKey,
	listCustomMcpServersForTenant,
	listMcpConfigsForTenant,
	listSystemMcpServers,
	markMcpOAuthReconnectRequired,
	parseMcpOAuthBinding,
} from "@repo/database";
import { logDataEvent, logger } from "@repo/logs";
import {
	GitLabMcpCredentialError,
	getValidMcpAccessToken,
	isGitLabPersonalMcpConfig,
} from "@repo/mcp";
import {
	hasPermission,
	Permissions,
	resolveOrgPermissions,
} from "@repo/permissions";
import { decryptApiKey } from "@repo/utils";
import type { Hono } from "hono";
import { requireScope } from "../external-api/middleware/api-key-auth";
import { projectBoundRefusal } from "../external-api/project-bound";
import type { ExternalApiVariables } from "../external-api/types";
import { removeGitLabPersonalMcpConfig } from "../mcp/lib/gitlab-config-removal";
import { forbidden, notFound, ok, resolveV1Context } from "./helpers";

const DEFAULT_EXPORT_TIMEOUT_MS = 5000;
const EXPORT_VERSION = "1.0";

interface ExportableServer {
	name: string;
	type: "streamableHttp";
	url: string;
	headers?: Record<string, string>;
	oauth?: {
		accessToken: string;
		refreshToken?: string;
		expiresAt?: number;
		scope?: string;
	};
	timeoutMs: number;
	disabled: false;
	description?: string;
	provider?: string;
}

function sanitizeServerName(input: string | null | undefined): string {
	const normalized = (input ?? "")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");

	return normalized || "mcp-server";
}

function ensureUniqueName(name: string, seen: Map<string, number>) {
	const count = seen.get(name) ?? 0;
	seen.set(name, count + 1);

	if (count === 0) {
		return name;
	}

	return `${name}-${count + 1}`;
}

function isExportableStreamableHttpConfig(config: {
	enabled: boolean;
	baseUrl?: string | null;
	transport?: string | null;
	mcpServer?: {
		transport?: string | null;
		defaultUrl?: string | null;
	} | null;
}) {
	if (!config.enabled) {
		return false;
	}

	const transport = config.transport ?? config.mcpServer?.transport ?? null;
	if (transport !== "HTTP") {
		return false;
	}

	const rawUrl = config.baseUrl ?? config.mcpServer?.defaultUrl ?? null;
	if (!rawUrl) {
		return false;
	}

	try {
		const parsed = new URL(rawUrl);
		return parsed.protocol === "https:";
	} catch {
		return false;
	}
}

async function buildExportableServer(
	config: Awaited<ReturnType<typeof listMcpConfigsForTenant>>[number],
	ctx: { userId: string; organizationId: string | null },
	seenNames: Map<string, number>,
): Promise<ExportableServer | null> {
	if (!isExportableStreamableHttpConfig(config)) {
		return null;
	}

	const url = config.baseUrl ?? config.mcpServer?.defaultUrl;
	if (!url) {
		return null;
	}

	const provider = config.mcpServer?.key ?? undefined;
	const description =
		config.description ?? config.mcpServer?.description ?? undefined;
	const baseName = sanitizeServerName(
		config.displayName ?? config.mcpServer?.key ?? config.mcpServer?.name,
	);
	const name = ensureUniqueName(baseName, seenNames);

	// A GitLab personal server exports the caller's GitLab connection token,
	// whatever auth type its config names: an API key stored on such a row is
	// never exported (nor read).
	const isGitLabPersonalServer = isGitLabPersonalMcpServerKey(
		config.mcpServer?.key,
	);

	if (config.authType === "API_KEY" && !isGitLabPersonalServer) {
		const apiKey = await getValidAccessToken({
			configId: config.id,
			userId: ctx.userId,
			organizationId: ctx.organizationId,
		});

		if (!apiKey) {
			return null;
		}

		const headers: Record<string, string> =
			config.apiKeyMethod === "HEADER"
				? { "X-API-Key": apiKey }
				: {
						Authorization:
							config.apiKeyMethod === "PLAIN"
								? apiKey
								: `Bearer ${apiKey}`,
					};

		return {
			name,
			type: "streamableHttp",
			url,
			headers,
			timeoutMs: DEFAULT_EXPORT_TIMEOUT_MS,
			disabled: false,
			...(description ? { description } : {}),
			...(provider ? { provider } : {}),
		};
	}

	if (config.authType === "OAUTH2" || isGitLabPersonalServer) {
		// GitLab personal servers resolve to the caller's GitLab connection
		// token (`getValidMcpAccessToken`); a missing or unusable connection
		// skips the server like a missing token does.
		const accessToken = await getValidMcpAccessToken({
			configId: config.id,
			userId: ctx.userId,
			organizationId: ctx.organizationId,
		}).catch((error: unknown) => {
			if (error instanceof GitLabMcpCredentialError) {
				return null;
			}
			throw error;
		});

		if (!accessToken) {
			return null;
		}

		const refreshedConfig = await getMcpConfigById(config.id, {
			userId: ctx.userId,
			organizationId: ctx.organizationId ?? undefined,
		});

		if (!refreshedConfig) {
			return null;
		}

		// A GitLab personal config's token columns are a legacy copy of the
		// person's GitLab grant: never export its refresh token (a client
		// spending it would rotate the grant out from under the connection)
		// nor its stale expiry.
		const isGitLabPersonal = isGitLabPersonalMcpConfig(refreshedConfig);
		// The exported client spends the refresh token on its own, so it is
		// exported only for a grant bound to its authorization server and
		// still the credential set that binding was written with
		// (`credentialFingerprint`). An unbound or bearer-only grant exports
		// the access token alone; a mismatch — a writer outside the
		// credential module replaced a credential — also flags the config
		// for reconnect.
		const binding = parseMcpOAuthBinding(refreshedConfig.oauthBinding);
		let exportRefreshToken =
			!isGitLabPersonal &&
			!!binding &&
			!!refreshedConfig.encryptedRefreshToken;
		if (
			exportRefreshToken &&
			binding &&
			!credentialFingerprintMatches(binding, refreshedConfig)
		) {
			exportRefreshToken = false;
			await markMcpOAuthReconnectRequired({
				configId: refreshedConfig.id,
				expectedGeneration: refreshedConfig.oauthGrantGeneration,
				reason: "Reconnect required: the stored OAuth credentials do not match the connection they were bound with.",
			});
		}
		const refreshToken =
			exportRefreshToken && refreshedConfig.encryptedRefreshToken
				? decryptApiKey(refreshedConfig.encryptedRefreshToken)
				: undefined;

		return {
			name,
			type: "streamableHttp",
			url,
			oauth: {
				accessToken,
				...(refreshToken ? { refreshToken } : {}),
				...(!isGitLabPersonal && refreshedConfig.tokenExpiresAt
					? { expiresAt: refreshedConfig.tokenExpiresAt.getTime() }
					: {}),
				...(refreshedConfig.scopes.length > 0
					? { scope: refreshedConfig.scopes.join(" ") }
					: {}),
			},
			timeoutMs: DEFAULT_EXPORT_TIMEOUT_MS,
			disabled: false,
			...(description ? { description } : {}),
			...(provider ? { provider } : {}),
		};
	}

	if (config.authType === "NONE") {
		return {
			name,
			type: "streamableHttp",
			url,
			timeoutMs: DEFAULT_EXPORT_TIMEOUT_MS,
			disabled: false,
			...(description ? { description } : {}),
			...(provider ? { provider } : {}),
		};
	}

	return null;
}

export async function buildMcpConfigExportResponse(ctx: {
	userId: string;
	organizationId: string | null;
}) {
	const configs = await listMcpConfigsForTenant({
		userId: ctx.userId,
		organizationId: ctx.organizationId,
	});

	const seenNames = new Map<string, number>();
	const servers = (
		await Promise.all(
			configs.map((config) =>
				buildExportableServer(config, ctx, seenNames),
			),
		)
	).filter((server): server is ExportableServer => server !== null);

	return {
		servers,
		exportedAt: Date.now(),
		version: EXPORT_VERSION,
	};
}

export function registerMcpRoutes(
	app: Hono<{ Variables: ExternalApiVariables }>,
) {
	/**
	 * GET /user/mcp-config
	 * Exports enabled StreamableHTTP MCP configs with active credentials.
	 */
	app.get("/user/mcp-config", requireScope("mcp:read"), async (c) => {
		const apiCtx = c.get("externalApiContext");
		// The export is the organization's connected servers, which an agent
		// that signed in for one project may not have.
		if (apiCtx.boundProjectId !== undefined) {
			const refusal = await projectBoundRefusal(apiCtx.boundProjectId);
			return c.json(
				{ error: { message: refusal.error } },
				refusal.status,
			);
		}
		const tenantContext = {
			userId: apiCtx.userId,
			organizationId: apiCtx.organizationId ?? null,
		};

		try {
			const response = await buildMcpConfigExportResponse(tenantContext);

			c.header("Cache-Control", "no-store, private");
			c.header("Pragma", "no-cache");

			// AUDIT-LOG-V1 SCOPE: This event stays on the stdout/webhook path
			// (@repo/logs/audit-logger.ts) for v1. Per D5 of
			// docs/audit-log/README.md, AI/MCP/
			// workflow events are deferred to Phase 2. Do NOT migrate to recordAudit
			// without coordination — dual-writing is acceptable but a unilateral migration
			// loses the stdout/webhook delivery the operator currently relies on.
			void logDataEvent(
				"EXPORT",
				"mcp_config",
				tenantContext.organizationId ?? tenantContext.userId,
				apiCtx.userId,
				{
					apiKeyId: apiCtx.keyId,
					apiKeyType: apiCtx.keyType,
					clientIp:
						c.req
							.header("x-forwarded-for")
							?.split(",")[0]
							?.trim() ??
						c.req.header("x-real-ip") ??
						undefined,
					clientVersion:
						c.req.header("x-client-version") ?? undefined,
					organizationId: tenantContext.organizationId ?? undefined,
					serverCount: response.servers.length,
					userAgent: c.req.header("user-agent") ?? undefined,
				},
			).catch(() => {});

			return c.json(response);
		} catch (error) {
			logger.error("[v1] Failed to export MCP configuration", {
				error: error instanceof Error ? error.message : String(error),
				organizationId: tenantContext.organizationId,
				userId: tenantContext.userId,
			});

			return c.json(
				{
					error: "InternalError",
					message: "Failed to fetch MCP configuration",
				},
				500,
			);
		}
	});

	/**
	 * GET /user/mcp-config/validate
	 * Validates whether the caller has exportable StreamableHTTP MCP configs.
	 */
	app.get(
		"/user/mcp-config/validate",
		requireScope("mcp:read"),
		async (c) => {
			const apiCtx = c.get("externalApiContext");
			if (apiCtx.boundProjectId !== undefined) {
				const refusal = await projectBoundRefusal(
					apiCtx.boundProjectId,
				);
				return c.json(
					{ error: { message: refusal.error } },
					refusal.status,
				);
			}
			const response = await buildMcpConfigExportResponse({
				userId: apiCtx.userId,
				organizationId: apiCtx.organizationId ?? null,
			});

			const warnings = response.servers.flatMap((server) => {
				const expiresAt = server.oauth?.expiresAt;
				if (!expiresAt) {
					return [];
				}

				const msUntilExpiry = expiresAt - Date.now();
				if (msUntilExpiry > 60 * 60 * 1000) {
					return [];
				}

				return [
					{
						server: server.name,
						message: "OAuth token expires in less than 1 hour",
					},
				];
			});

			c.header("Cache-Control", "no-store, private");
			c.header("Pragma", "no-cache");

			return c.json({
				valid: response.servers.length > 0,
				serverCount: response.servers.length,
				warnings,
			});
		},
	);

	/**
	 * GET /mcp/servers
	 * Lists all MCP servers accessible to the tenant (system + custom).
	 */
	app.get("/mcp/servers", requireScope("mcp:read"), async (c) => {
		const apiCtx = c.get("externalApiContext");
		const ctx = await resolveV1Context(
			apiCtx,
			c.req.query("org"),
			c.req.query("personal") === "1",
		);
		if ("error" in ctx) {
			return c.json({ error: { message: ctx.error } }, ctx.status);
		}

		const [systemServers, customServers] = await Promise.all([
			listSystemMcpServers(),
			listCustomMcpServersForTenant({
				userId: ctx.userId,
				organizationId: ctx.organizationId ?? undefined,
			}),
		]);

		const servers = [
			...systemServers.map((s) => ({
				id: s.id,
				key: s.key,
				name: s.name,
				description: s.description ?? null,
				transport: s.transport,
				defaultUrl: s.defaultUrl ?? null,
				docsUrl: s.docsUrl ?? null,
				author: s.author ?? null,
				category: s.category ?? null,
				tags: s.tags,
				isSystemProvided: true,
				// Additive metadata field so the registry UI can render the
				// "Always on" pill on managed-default rows. Custom servers
				// cannot be default-enabled in v1.
				defaultEnabled: s.defaultEnabled,
				createdAt: s.createdAt.toISOString(),
			})),
			...customServers.map((s) => ({
				id: s.id,
				key: s.key,
				name: s.name,
				description: s.description ?? null,
				transport: s.transport,
				defaultUrl: s.defaultUrl ?? null,
				docsUrl: s.docsUrl ?? null,
				author: s.author ?? null,
				category: s.category ?? null,
				tags: s.tags,
				isSystemProvided: false,
				defaultEnabled: false,
				createdAt: s.createdAt.toISOString(),
			})),
		];

		return c.json(ok(servers, { total: servers.length }));
	});

	/**
	 * GET /mcp/configs
	 * Lists the tenant's MCP configurations (no sensitive credential fields).
	 */
	app.get("/mcp/configs", requireScope("mcp:read"), async (c) => {
		const apiCtx = c.get("externalApiContext");
		const ctx = await resolveV1Context(
			apiCtx,
			c.req.query("org"),
			c.req.query("personal") === "1",
		);
		if ("error" in ctx) {
			return c.json({ error: { message: ctx.error } }, ctx.status);
		}

		const configs = await listMcpConfigsForTenant({
			userId: ctx.userId,
			organizationId: ctx.organizationId,
		});

		const result = configs.map((cfg) => ({
			id: cfg.id,
			mcpServerId: cfg.mcpServerId,
			serverKey: cfg.mcpServer?.key ?? null,
			serverName: cfg.mcpServer?.name ?? null,
			displayName: cfg.displayName ?? null,
			transport: cfg.transport ?? null,
			authType: cfg.authType,
			enabled: cfg.enabled,
			status: cfg.status,
			lastHealthCheckAt: cfg.lastHealthCheckAt?.toISOString() ?? null,
			createdAt: cfg.createdAt.toISOString(),
		}));

		return c.json(ok(result, { total: result.length }));
	});

	/**
	 * GET /mcp/configs/:id
	 * Gets a specific MCP config owned by the tenant.
	 */
	app.get("/mcp/configs/:id", requireScope("mcp:read"), async (c) => {
		const apiCtx = c.get("externalApiContext");
		const ctx = await resolveV1Context(
			apiCtx,
			c.req.query("org"),
			c.req.query("personal") === "1",
		);
		if ("error" in ctx) {
			return c.json({ error: { message: ctx.error } }, ctx.status);
		}

		const config = await getMcpConfigById(c.req.param("id")!, {
			userId: ctx.userId,
			organizationId: ctx.organizationId ?? undefined,
		});

		if (!config) {
			return c.json(notFound("MCP config"), 404);
		}

		return c.json(
			ok({
				id: config.id,
				mcpServerId: config.mcpServerId,
				serverKey: config.mcpServer?.key ?? null,
				serverName: config.mcpServer?.name ?? null,
				displayName: config.displayName ?? null,
				baseUrl: config.baseUrl ?? null,
				transport: config.transport ?? null,
				authType: config.authType,
				enabled: config.enabled,
				status: config.status,
				lastHealthCheckAt:
					config.lastHealthCheckAt?.toISOString() ?? null,
				createdAt: config.createdAt.toISOString(),
			}),
		);
	});

	/**
	 * DELETE /mcp/configs/:id
	 * Deletes a tenant's MCP configuration.
	 */
	app.delete("/mcp/configs/:id", requireScope("mcp:write"), async (c) => {
		const apiCtx = c.get("externalApiContext");
		const ctx = await resolveV1Context(
			apiCtx,
			c.req.query("org"),
			c.req.query("personal") === "1",
		);
		if ("error" in ctx) {
			return c.json({ error: { message: ctx.error } }, ctx.status);
		}

		// A key never grants more than the app: the in-app Delete requires
		// `MCP_DELETE`, so the key's owner must hold it now, in this
		// organization. Checked after `requireScope` and unconditionally —
		// `mcp:write` and a `*` key pass the scope check alike, and a demoted
		// owner's key still carries the scope it was minted with. A separate
		// refusal from the scope one, before the config is looked up.
		const permissionRefusal = await mcpDeletePermissionRefusal(ctx);
		if (permissionRefusal) {
			return c.json(forbidden(permissionRefusal), 403);
		}

		const config = await getMcpConfigById(c.req.param("id")!, {
			userId: ctx.userId,
			organizationId: ctx.organizationId ?? undefined,
		});

		if (!config) {
			return c.json(notFound("MCP config"), 404);
		}

		// GitLab personal servers: the same Delete the MCP server tile does —
		// the one personal GitLab disconnect plus `enabled: false`, keeping
		// the row and its client registration for a reconnect.
		if (isGitLabPersonalMcpServerKey(config.mcpServer?.key)) {
			await removeGitLabPersonalMcpConfig({
				config,
				surface: "v1.mcp.configs.delete",
				audit: { headers: c.req.raw.headers },
				actor: { type: "api_key", userId: ctx.userId },
			});
			return c.json(
				ok({ id: config.id, deleted: false, disconnected: true }),
			);
		}

		await deleteMcpConfig(config.id);

		return c.json(ok({ id: config.id, deleted: true }));
	});
}

/**
 * Null when the key's owner currently holds `MCP_DELETE` in the request's
 * organization; otherwise why not. `resolveV1Context` always resolves an
 * organization on success (`helpers.ts`), so a missing one is refused rather
 * than read as personal context.
 */
async function mcpDeletePermissionRefusal(ctx: {
	userId: string;
	organizationId: string | null;
}): Promise<string | null> {
	if (!ctx.organizationId) {
		return "Deleting an MCP config requires an organization";
	}
	const membership = await getOrganizationMembership(
		ctx.organizationId,
		ctx.userId,
	);
	if (
		!membership ||
		!hasPermission(
			resolveOrgPermissions(membership.role),
			Permissions.MCP_DELETE,
		)
	) {
		return "The key's owner does not have permission to delete MCP configs in this organization";
	}
	return null;
}
