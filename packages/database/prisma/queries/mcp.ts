import crypto from "node:crypto";
import { db, Prisma } from "../client";
import { CURATED_SYSTEM_MCP_SERVER_KEY_SET } from "../curated-mcp-server-keys";
import {
	DEFAULT_PROJECT_MANAGEMENT_DISPLAY_OVERRIDES,
	DEFAULT_PROJECT_MANAGEMENT_ICON_KEY_OVERRIDES,
	DEFAULT_PROJECT_MANAGEMENT_KEYS,
	PM_SERVER_ID_KEY_SENTINEL_PREFIX,
} from "../default-pm-tool-keys";
import {
	GITLAB_PERSONAL_MCP_SERVER_KEYS,
	isGitLabPersonalMcpServerKey,
} from "./lib/gitlab-personal-keys";
import {
	wipeMcpOAuthTokens,
	wipeMcpOAuthTokensWhere,
} from "./mcp-oauth-credentials";

// Re-export sentinel helpers so `@repo/integrations` consumers
// (`getProjectPMServerKey`) can recognise key-sentinel ids through the
// existing `@repo/database` public surface.
export {
	isPmServerIdKeySentinel,
	readPmServerIdKeySentinel,
} from "../default-pm-tool-keys";

import type {
	MCPApiKeyMethod,
	MCPAuthType,
	MCPStatus,
	MCPTransport,
} from "../zod";

// Maximum consecutive refresh failures before marking as needs re-auth
const MAX_REFRESH_FAILURES = 3;

/**
 * OAuth error codes that prove the stored grant itself is dead.
 *
 * `invalid_grant` (RFC 6749 §5.2) and `invalid_token` are the provider
 * positively rejecting the refresh token — the one situation a user
 * reconnect actually fixes. Every other code (`network_error`,
 * `invalid_response`, `invalid_client`, `http_5xx`, …) says nothing about
 * the grant, so it must never condemn the credential.
 *
 * Exported so the `@repo/mcp` OAuth provider classifies with the same
 * predicate rather than spelling the codes out a second time.
 */
export function isPermanentGrantFailure(
	errorCode: string | undefined | null,
): boolean {
	return errorCode === "invalid_grant" || errorCode === "invalid_token";
}

function isUsableSystemMcpServer(server: {
	isSystemProvided: boolean;
	key: string;
	defaultUrl: string | null;
}) {
	if (!server.isSystemProvided) {
		return true;
	}

	if (!CURATED_SYSTEM_MCP_SERVER_KEY_SET.has(server.key)) {
		return false;
	}

	if (!server.defaultUrl) {
		return true;
	}

	// Hide stale imported registry entries that are not actually connectable.
	if (server.defaultUrl.includes("{") || server.defaultUrl.includes("}")) {
		return false;
	}

	try {
		const url = new URL(server.defaultUrl);
		const hostname = url.hostname.toLowerCase();

		if (hostname === "server.smithery.ai") {
			return false;
		}

		if (hostname.endsWith(".mcp.com.ai")) {
			return false;
		}

		return true;
	} catch {
		return false;
	}
}

// MCP Registry Queries
export async function getMcpServers() {
	return db.mCPServer.findMany({ orderBy: { name: "asc" } });
}

/**
 * Read the current MCP registry version counter.
 *
 * The counter lives in the singleton `mcp_registry_version` table and is
 * bumped by an `AFTER INSERT/UPDATE/DELETE` Postgres trigger on `mcp_server`
 * (see migration 20260523000200_add_mcp_registry_version_tracking). The API
 * layer appends this version to the Redis cache key so any write — Prisma,
 * raw SQL migration, or hand-edit — produces a fresh key on the next
 * request, with no application-level invalidation discipline required.
 *
 * Returns `null` if the row is missing (pre-migration deployment) so the
 * cache can fall back to a static key without crashing.
 */
export async function getMcpRegistryVersion(): Promise<bigint | null> {
	try {
		const row = await db.mcpRegistryVersion.findUnique({
			where: { id: 1 },
			select: { version: true },
		});
		return row?.version ?? null;
	} catch {
		// Pre-migration environments don't have the table yet — fall back to
		// the static key on the cache side.
		return null;
	}
}

/**
 * Get MCP server by ID with tenant filtering
 *
 * SECURITY: Always include tenant context to prevent ID enumeration attacks.
 * System-provided servers are always accessible.
 *
 * MCP Servers follow "Strict" ownership pattern:
 * - System servers: isSystemProvided=true (available to all)
 * - Personal servers: userId is set, organizationId is null
 * - Org servers: userId is null, organizationId is set
 *
 * @param id - Server ID
 * @param opts - Tenant context (userId and/or organizationId)
 */
export async function getMcpServerById(
	id: string,
	opts?: { userId?: string; organizationId?: string },
) {
	// If no tenant context provided, only allow system servers (backward compatibility)
	if (!opts?.userId && !opts?.organizationId) {
		return db.mCPServer.findFirst({
			where: { id, isSystemProvided: true },
		});
	}

	// Build OR clauses for tenant-owned servers
	const orClauses: Array<{
		isSystemProvided?: boolean;
		userId?: string | null;
		organizationId?: string | null;
	}> = [{ isSystemProvided: true }];

	if (opts.organizationId) {
		if (!opts.userId) {
			throw new Error(
				"userId is required when looking up MCP servers in org context",
			);
		}
		// Org context: look for the current user's org-scoped servers
		orClauses.push({
			userId: opts.userId,
			organizationId: opts.organizationId,
		});
	} else if (opts.userId) {
		// Personal context: look for user-owned servers
		orClauses.push({
			userId: opts.userId,
			organizationId: null,
		});
	}

	return db.mCPServer.findFirst({
		where: {
			id,
			OR: orClauses,
		},
	});
}

/**
 * List only system-provided MCP servers (public registry)
 * Used for the public MCP registry page that doesn't require authentication
 */
/**
 * An MCP server the given tenant may use, or null: a system-provided server,
 * or a custom server owned by exactly this tenant — the exclusive tenant
 * filter (`{ organizationId, userId }` in an organization, `{ organizationId:
 * null, userId }` personally; never OR-ed). A tenant without a user owns no
 * custom server. Every path that writes or uses a config's OAuth credentials
 * checks its server through this: a config must never send a secret to the
 * endpoints of a server another person or organization controls.
 */
export async function getMcpServerForTenant(
	id: string,
	tenant: { userId: string | null; organizationId: string | null },
) {
	const server = await db.mCPServer.findUnique({ where: { id } });
	if (!server) {
		return null;
	}
	if (server.isSystemProvided) {
		return server;
	}
	if (!tenant.userId) {
		return null;
	}
	const ownedHere = tenant.organizationId
		? server.userId === tenant.userId &&
			server.organizationId === tenant.organizationId
		: server.userId === tenant.userId && server.organizationId === null;
	return ownedHere ? server : null;
}

export async function listSystemMcpServers() {
	const servers = await db.mCPServer.findMany({
		where: {
			isSystemProvided: true,
			isImplemented: true,
		},
		orderBy: { name: "asc" },
	});

	return servers.filter(isUsableSystemMcpServer);
}

/**
 * Get MCP servers by their keys
 * Used for agent templates that specify required MCP servers
 *
 * @param keys - Array of server keys (e.g., ["fizzy", "linear"])
 * @returns Array of MCP servers matching the keys
 */
export async function getMcpServersByKeys(keys: string[]) {
	if (!keys.length) {
		return [];
	}

	return db.mCPServer.findMany({
		where: {
			key: { in: keys },
			isSystemProvided: true, // Only system servers can be referenced by key in templates
		},
		orderBy: { name: "asc" },
	});
}

/**
 * Get MCP servers with their user config status
 * Returns servers with information about whether the user has configured them
 *
 * SECURITY: Uses strict XOR tenant isolation - configs from other contexts
 * are completely invisible (not even their existence is revealed).
 *
 * @param keys - Array of server keys to look up
 * @param userId - User ID to check configs for
 * @param organizationId - Organization ID (null for personal context)
 * @returns Array of servers with isConfigured flag
 */
export async function getMcpServersWithConfigStatus({
	keys,
	userId,
	organizationId,
}: {
	keys: string[];
	userId: string;
	organizationId?: string | null;
}) {
	if (!keys.length) {
		return [];
	}

	// Get the servers
	const servers = await db.mCPServer.findMany({
		where: {
			key: { in: keys },
			isSystemProvided: true,
		},
	});

	if (!servers.length) {
		return [];
	}

	// Get user's configs for these servers
	const serverIds = servers.map((s) => s.id);

	// Build tenant filter (strict XOR pattern - absolute isolation)
	const tenantFilter = organizationId
		? { organizationId, userId }
		: { organizationId: null, userId };

	// Get configs in current context ONLY
	const configs = await db.mCPConfig.findMany({
		where: {
			mcpServerId: { in: serverIds },
			...tenantFilter,
			enabled: true,
		},
		select: {
			id: true,
			mcpServerId: true,
			displayName: true,
		},
	});

	// Map configs by server ID
	const configByServerId = new Map(configs.map((c) => [c.mcpServerId, c]));

	// Return servers with config status
	return servers.map((server) => {
		const config = configByServerId.get(server.id);
		return {
			...server,
			isConfigured: !!config,
			configId: config?.id ?? null,
			configName: config?.displayName ?? null,
		};
	});
}

/**
 * Get all MCP configs matching server keys/names for a user
 * Returns ALL available configs (system + custom servers) that match the required keys
 * User can then select which config to use for their agent
 *
 * SECURITY: Uses strict XOR tenant isolation
 *
 * @param keys - Array of server keys/names to match (case-insensitive)
 * @param userId - User ID
 * @param organizationId - Organization ID (null for personal context)
 * @returns Array of matching configs with server info
 */
export async function getAvailableMcpConfigsForKeys({
	keys,
	userId,
	organizationId,
}: {
	keys: string[];
	userId: string;
	organizationId?: string | null;
}) {
	if (!keys.length) {
		return [];
	}

	// Build tenant filter (strict XOR pattern)
	const tenantFilter = organizationId
		? { organizationId, userId }
		: { organizationId: null, userId };

	// Find all enabled configs where:
	// 1. The linked server's key matches (for system servers)
	// 2. OR the linked server's name contains the key (for custom servers)
	// 3. OR the config's displayName contains the key
	const configs = await db.mCPConfig.findMany({
		where: {
			...tenantFilter,
			enabled: true,
			OR: keys.flatMap((key) => [
				// Match system server by key
				{
					mcpServer: {
						key: { equals: key, mode: "insensitive" as const },
					},
				},
				// Match server name containing the key
				{
					mcpServer: {
						name: { contains: key, mode: "insensitive" as const },
					},
				},
				// Match config display name containing the key
				{
					displayName: {
						contains: key,
						mode: "insensitive" as const,
					},
				},
			]),
		},
		include: {
			mcpServer: {
				select: {
					id: true,
					key: true,
					name: true,
					description: true,
					iconUrl: true,
					isSystemProvided: true,
				},
			},
		},
		orderBy: [
			// Prefer system servers first
			{ mcpServer: { isSystemProvided: "desc" } },
			{ displayName: "asc" },
		],
	});

	// Group configs by the key they match
	const result: {
		key: string;
		configs: Array<{
			configId: string;
			configName: string;
			serverId: string | null;
			serverName: string | null;
			serverKey: string | null;
			isSystemServer: boolean;
			iconUrl: string | null;
		}>;
	}[] = [];

	for (const key of keys) {
		const matchingConfigs = configs.filter((c) => {
			const serverKey = c.mcpServer?.key?.toLowerCase();
			const serverName = c.mcpServer?.name?.toLowerCase();
			const configName = c.displayName?.toLowerCase();
			const searchKey = key.toLowerCase();

			return (
				serverKey === searchKey ||
				serverName?.includes(searchKey) ||
				configName?.includes(searchKey)
			);
		});

		result.push({
			key,
			configs: matchingConfigs.map((c) => ({
				configId: c.id,
				configName: c.displayName || c.mcpServer?.name || "Unnamed",
				serverId: c.mcpServer?.id ?? null,
				serverName: c.mcpServer?.name ?? null,
				serverKey: c.mcpServer?.key ?? null,
				isSystemServer: c.mcpServer?.isSystemProvided ?? false,
				iconUrl: c.mcpServer?.iconUrl ?? null,
			})),
		});
	}

	return result;
}

/**
 * List MCP servers accessible to a tenant with XOR isolation.
 *
 * TENANT ISOLATION (XOR Pattern):
 * - ORGANIZATION CONTEXT: SYSTEM + USER'S ORG-SCOPED servers only
 * - PERSONAL CONTEXT: SYSTEM + USER servers only
 *
 * Personal servers are NEVER accessible in org context and vice versa.
 * This ensures complete data isolation between personal and organization accounts.
 *
 * Note: Org-scoped custom servers follow the same per-user-within-context model as configs:
 * they are owned by a single user within a single org and are not shared with other members.
 */
export async function listMcpServersAccessibleToTenant({
	userId,
	organizationId,
	includeNonImplemented,
}: {
	userId?: string;
	organizationId?: string;
	includeNonImplemented?: boolean;
}) {
	// XOR PATTERN: Strict context isolation
	const systemCondition = includeNonImplemented
		? { isSystemProvided: true }
		: { isSystemProvided: true, isImplemented: true };

	const conditions: Array<Record<string, unknown>> = [systemCondition];

	if (organizationId) {
		if (!userId) {
			throw new Error(
				"userId is required when listing MCP servers in org context",
			);
		}
		// ORGANIZATION CONTEXT: SYSTEM + USER'S ORG-SCOPED servers only
		conditions.push({ userId, organizationId });
	} else if (userId) {
		// PERSONAL CONTEXT: SYSTEM + USER servers only (no org servers)
		conditions.push({ userId, organizationId: null });
	}

	const servers = await db.mCPServer.findMany({
		where: { OR: conditions },
		orderBy: [{ isSystemProvided: "desc" }, { name: "asc" }],
	});

	return servers.filter(isUsableSystemMcpServer);
}

/**
 * List only custom (user-created) MCP servers for a tenant.
 * Used when system servers are served from cache.
 */
export async function listCustomMcpServersForTenant({
	userId,
	organizationId,
}: {
	userId?: string;
	organizationId?: string;
}) {
	if (!userId) {
		return [];
	}
	return db.mCPServer.findMany({
		where: {
			isSystemProvided: false,
			...(organizationId
				? { userId, organizationId }
				: { userId, organizationId: null }),
		},
		orderBy: { name: "asc" },
	});
}

export async function createCustomMcpServer({
	userId,
	organizationId,
	createdById,
	data,
}: {
	userId?: string;
	organizationId?: string;
	createdById: string;
	data: {
		key: string;
		name: string;
		description?: string | null;
		defaultUrl?: string | null;
		docsUrl?: string | null;
		transport: MCPTransport;
		authMethods: MCPAuthType[];
		oauthDiscoveryUrl?: string | null;
		oauthAuthorizationEndpoint?: string | null;
		oauthTokenEndpoint?: string | null;
		dcrRegistrationEndpoint?: string | null;
		category?: string | null;
		tags?: string[];
	};
}) {
	// Per-user-within-context pattern: userId is required, organizationId is optional
	// 1. Personal: userId set, organizationId null
	// 2. Organization: userId set, organizationId set (user-private within org)
	if (!userId) {
		throw new Error("MCP server must have a userId for per-user ownership");
	}

	return db.mCPServer.create({
		data: {
			key: data.key,
			name: data.name,
			description: data.description ?? null,
			defaultUrl: data.defaultUrl ?? null,
			docsUrl: data.docsUrl ?? null,
			transport: data.transport,
			authMethods: data.authMethods,
			oauthDiscoveryUrl: data.oauthDiscoveryUrl ?? null,
			oauthAuthorizationEndpoint: data.oauthAuthorizationEndpoint ?? null,
			oauthTokenEndpoint: data.oauthTokenEndpoint ?? null,
			dcrRegistrationEndpoint: data.dcrRegistrationEndpoint ?? null,
			category: data.category ?? null,
			tags: data.tags ?? [],
			isSystemProvided: false,
			createdById,
			userId: userId ?? null,
			organizationId: organizationId ?? null,
		},
	});
}

export async function updateCustomMcpServer({
	id,
	userId,
	organizationId,
	data,
}: {
	id: string;
	userId?: string;
	organizationId?: string;
	data: Partial<{
		name: string;
		description: string | null;
		defaultUrl: string | null;
		docsUrl: string | null;
		transport: MCPTransport;
		authMethods: MCPAuthType[];
		oauthDiscoveryUrl: string | null;
		oauthAuthorizationEndpoint: string | null;
		oauthTokenEndpoint: string | null;
		dcrRegistrationEndpoint: string | null;
		category: string | null;
		tags: string[];
	}>;
}) {
	const existing = await db.mCPServer.findFirst({
		where: {
			id,
			OR: [
				{ isSystemProvided: true },
				...(organizationId && userId
					? [
							{
								isSystemProvided: false,
								userId,
								organizationId,
							},
						]
					: []),
				...(userId && !organizationId
					? [
							{
								isSystemProvided: false,
								userId,
								organizationId: null,
							},
						]
					: []),
			],
		},
	});
	if (!existing) {
		throw new Error("MCP server not found");
	}
	if (existing.isSystemProvided) {
		throw new Error("Cannot modify system-provided MCP server");
	}

	// A change to where this server's OAuth flows go (its URL, discovery
	// document, endpoints or registration endpoint) retires every config that
	// inherits it, in the same transaction as the server update:
	// - tokens, binding AND client registration are removed — a client
	//   entered or registered for the old endpoints must not be presented to
	//   the new ones;
	// - every such config's grant generation moves, whatever it held, so an
	//   OAuth flow already started against the old endpoints cannot complete.
	// Their owners reconnect.
	const changed = <K extends keyof typeof data>(key: K) =>
		data[key] !== undefined &&
		(data[key] ?? null) !==
			((existing as Record<string, unknown>)[key] ?? null);
	const endpointsChanged =
		changed("oauthDiscoveryUrl") ||
		changed("oauthAuthorizationEndpoint") ||
		changed("oauthTokenEndpoint") ||
		changed("dcrRegistrationEndpoint");
	const defaultUrlChanged = changed("defaultUrl");

	if (!endpointsChanged && !defaultUrlChanged) {
		return db.mCPServer.update({ where: { id }, data });
	}

	return db.$transaction(async (tx) => {
		const updated = await tx.mCPServer.update({ where: { id }, data });
		await wipeMcpOAuthTokensWhere({
			client: tx,
			where: {
				mcpServerId: id,
				AND: [
					// A URL change reaches only the configs that use the
					// server's URL: no URL of their own, or a copy of the old one.
					...(endpointsChanged
						? []
						: [
								{
									OR: [
										{ baseUrl: null },
										{ baseUrl: "" },
										...(existing.defaultUrl
											? [{ baseUrl: existing.defaultUrl }]
											: []),
									],
								},
							]),
				],
			},
			clearBinding: true,
			clearClient: true,
		});
		return updated;
	});
}

export async function deleteCustomMcpServer({
	id,
	userId,
	organizationId,
}: {
	id: string;
	userId?: string;
	organizationId?: string;
}) {
	const existing = await db.mCPServer.findFirst({
		where: {
			id,
			OR: [
				{ isSystemProvided: true },
				...(organizationId && userId
					? [
							{
								isSystemProvided: false,
								userId,
								organizationId,
							},
						]
					: []),
				...(userId && !organizationId
					? [
							{
								isSystemProvided: false,
								userId,
								organizationId: null,
							},
						]
					: []),
			],
		},
	});
	if (!existing) {
		return { success: true };
	}
	if (existing.isSystemProvided) {
		throw new Error("Cannot delete system-provided MCP server");
	}
	await db.mCPServer.delete({ where: { id } });
	return { success: true };
}

/**
 * Get MCP server by key with XOR tenant isolation.
 *
 * TENANT ISOLATION (XOR Pattern):
 * - ORGANIZATION CONTEXT: SYSTEM + ORG servers only
 * - PERSONAL CONTEXT: SYSTEM + USER servers only
 *
 * Personal servers are NEVER accessible in org context and vice versa.
 */
export async function getMcpServerByKey(
	key: string,
	opts: {
		userId?: string;
		organizationId?: string;
		includeSystem?: boolean;
	} = {},
) {
	// XOR PATTERN: Strict context isolation
	const orClauses: {
		isSystemProvided?: boolean;
		userId?: string | null;
		organizationId?: string | null;
	}[] = [];

	if (opts.includeSystem !== false) {
		orClauses.push({ isSystemProvided: true });
	}

	if (opts.organizationId) {
		if (!opts.userId) {
			throw new Error(
				"userId is required when looking up MCP servers in org context",
			);
		}
		// ORGANIZATION CONTEXT: SYSTEM + USER'S ORG-SCOPED servers only
		orClauses.push({
			isSystemProvided: false,
			userId: opts.userId,
			organizationId: opts.organizationId,
		});
	} else if (opts.userId) {
		// PERSONAL CONTEXT: SYSTEM + USER servers only (no org servers)
		orClauses.push({
			isSystemProvided: false,
			userId: opts.userId,
			organizationId: null,
		});
	}

	return db.mCPServer.findFirst({
		where: {
			key,
			OR: orClauses.length > 0 ? orClauses : undefined,
		},
		// Prefer tenant-owned over system-provided when both exist
		orderBy: { isSystemProvided: "asc" },
	});
}

// MCP Configs (multi-tenancy)
/**
 * List MCP configs for a tenant
 *
 * MCP Configs follow "per-user within context" ownership pattern:
 * - Personal configs: userId is set, organizationId is null
 * - Org configs: userId is set, organizationId is set (user's config within org)
 *
 * STRICT XOR isolation:
 * - In org context: returns configs where organizationId matches (user's org configs)
 * - In personal context: returns configs where organizationId is null (user's personal configs)
 *
 * CRITICAL: Never returns configs from both contexts - absolute isolation required
 */
export async function listMcpConfigsForTenant({
	userId,
	organizationId,
}: {
	userId?: string;
	organizationId?: string | null;
}) {
	if (!userId && !organizationId) {
		return [];
	}

	// Security: org context MUST have a userId to prevent cross-user visibility.
	// Prisma ignores undefined fields in where clauses, so { organizationId, userId: undefined }
	// would silently return ALL org configs. Throw early to prevent this.
	if (organizationId && !userId) {
		throw new Error(
			"userId is required when listing MCP configs in org context",
		);
	}

	// Per-user within context pattern:
	// - Org configs: userId is set, organizationId is set (user's config within org)
	// - Personal configs: userId is set, organizationId is null
	const where = organizationId
		? { organizationId, userId } // Org context: user's own configs within this org
		: { userId, organizationId: null }; // Personal context: user's personal configs only

	return db.mCPConfig.findMany({
		where,
		include: { mcpServer: true },
		orderBy: { createdAt: "desc" },
	});
}

/**
 * INTERNAL: Get MCP config by ID without tenant filtering.
 * Only use this for:
 * - Internal functions that perform their own authorization (e.g., getValidAccessToken)
 * - System-level operations like health checks that run on all configs
 *
 * For API procedures/routes, use getMcpConfigById with tenant context instead.
 */
export async function getMcpConfigByIdInternal(id: string) {
	return db.mCPConfig.findUnique({
		where: { id },
		include: { mcpServer: true },
	});
}

/**
 * Get MCP config by ID with tenant filtering
 *
 * SECURITY: Always include tenant context to prevent ID enumeration attacks.
 *
 * MCP configs follow "per-user within context" ownership pattern:
 * - Personal configs: userId is set, organizationId is null
 * - Org configs: userId is set, organizationId is set (user's config within org)
 *
 * This function looks up configs based on context:
 * - In personal context (no organizationId): ONLY personal configs where userId matches
 * - In org context (with organizationId): ONLY configs where organizationId matches
 *
 * There is NO cross-context access. Users must install MCP configs separately
 * in each context (personal vs org) where they want to use them.
 *
 * @param id - Config ID
 * @param opts - Tenant context (userId required for personal, organizationId for org)
 */
export async function getMcpConfigById(
	id: string,
	opts?: { userId: string; organizationId?: string },
) {
	// If no tenant context, return null (security: prevent ID enumeration)
	if (!opts?.userId) {
		return null;
	}

	// Per-user within context pattern:
	// - Org configs: userId is set, organizationId is set (user's config within org)
	// - Personal configs: userId is set, organizationId is null
	return db.mCPConfig.findFirst({
		where: {
			id,
			...(opts.organizationId
				? {
						// Org context: user's own config within this org
						organizationId: opts.organizationId,
						userId: opts.userId,
					}
				: {
						// Personal context: look for user-owned configs
						userId: opts.userId,
						organizationId: null,
					}),
		},
		include: { mcpServer: true },
	});
}

export async function getMcpConfigForTenantAndServer({
	mcpServerId,
	userId,
	organizationId,
}: {
	mcpServerId: string;
	userId?: string;
	organizationId?: string;
}) {
	// MCP configs follow two patterns:
	// 1. Personal only: userId set, organizationId null
	// 2. Per-user within org: userId set, organizationId set (user's config within org context)
	// At minimum, userId must be provided
	if (!userId) {
		throw new Error(
			"MCP config must have a userId (for personal or per-user org configs)",
		);
	}

	return db.mCPConfig.findFirst({
		where: {
			mcpServerId,
			userId,
			organizationId: organizationId ?? null,
		},
		include: { mcpServer: true },
		orderBy: { updatedAt: "desc" },
	});
}

/**
 * Resolve the PM MCP config for a user given a project's stored configId and/or serverId.
 *
 * Resolution strategy:
 * 1. If `configId` is provided AND belongs to the current user/tenant → use it directly
 * 2. Otherwise fall back to `getMcpConfigForTenantAndServer` using `mcpServerId`
 * 3. Handle legacy projects with only `configId` (no `mcpServerId`) by extracting serverId from the stored config
 */
export async function resolvePMConfigForUser({
	configId,
	mcpServerId,
	userId,
	organizationId,
}: {
	configId?: string | null;
	mcpServerId?: string | null;
	userId: string;
	organizationId?: string;
}) {
	// 1. If configId is provided, verify it belongs to this user/tenant
	if (configId) {
		const config = await db.mCPConfig.findFirst({
			where: {
				id: configId,
				userId,
				organizationId: organizationId ?? null,
			},
			include: { mcpServer: true },
		});
		if (config) {
			return config;
		}
	}

	// 2. Resolve mcpServerId — if missing, try to extract from the legacy configId.
	//
	// Metadata-only lookup: selects ONLY `mcpServerId` (never credentials).
	//   - Org context: intentionally NOT user-scoped — a non-owner needs to read
	//     which PM server a project-pinned (creator-owned) config targets so step
	//     3 can resolve THEIR OWN config for that same server. Org-scoped so it
	//     can never read another tenant's row.
	//   - Personal context (`organizationId` null): user-scoped. Personal configs
	//     are strictly single-owner (a personal project has exactly one member),
	//     so there is no "cross-user-within-tenant" case here — omitting the
	//     userId filter would let one user probe another's personal config
	//     serverId, violating personal XOR isolation.
	// Either way step 3 re-filters by userId, so this function can never RETURN
	// another user's config.
	let resolvedServerId = mcpServerId;
	if (!resolvedServerId && configId) {
		const legacyConfig = await db.mCPConfig.findFirst({
			where: {
				id: configId,
				// `undefined` omits the filter (org context); a real userId is
				// required in personal context.
				userId: organizationId ? undefined : userId,
				organizationId: organizationId ?? null,
			},
			select: { mcpServerId: true },
		});
		resolvedServerId = legacyConfig?.mcpServerId ?? null;
	}

	if (!resolvedServerId) {
		return null;
	}

	// 3. Fall back to server-based resolution (picks most recently updated config)
	return getMcpConfigForTenantAndServer({
		mcpServerId: resolvedServerId,
		userId,
		organizationId,
	});
}

/**
 * Resolve the effective MCP config for a REPORT data-source binding, for the
 * user the report runs as.
 *
 * Mirrors {@link resolvePMConfigForUser}: PREFER the explicitly-bound config id
 * when it still resolves for this user/tenant; otherwise SELF-HEAL by falling
 * back to the user's own enabled config for the same server (matched by the data
 * source's provider/key — the same fuzzy match the connection picker uses via
 * {@link getAvailableMcpConfigsForKeys}).
 *
 * This is the root-cause fix for dangling report bindings: a report stores an
 * opaque config id with no referential integrity, so a deleted / reconnected /
 * foreign-context config id used to hard-fail the whole run with CONFIG_NOT_FOUND
 * and block every save. PM-sync never had this problem because it resolves
 * server-anchored; reports now do too.
 *
 * @returns the effective config id + whether it was healed (i.e. differs from the
 *          stored id), or `null` when neither the stored id nor any server
 *          fallback resolves for this user (truly unconfigured — the UI then shows
 *          "Reconnect required").
 */
export async function resolveReportMcpConfig({
	storedConfigId,
	serverKeys,
	userId,
	organizationId,
}: {
	storedConfigId?: string | null;
	/** Candidate keys identifying the data source's server (provider, key, …). */
	serverKeys: string[];
	userId: string;
	organizationId?: string;
}): Promise<{ configId: string; healed: boolean; enabled: boolean } | null> {
	// Self-heal fallback (step 2) is DISABLED by default. Scheduled reports aren't
	// wired to a runner yet (the only trigger is the manual Generate button), so the
	// fallback's only payoff — keeping unattended runs alive — doesn't apply today,
	// while silently substituting a different connection for a removed one is
	// confusing (and can pick the wrong account when the user has several). With it
	// off, a removed connection surfaces as "Reconnect required" so the user
	// reconnects explicitly. Re-enable when scheduled reports + run-failure
	// notifications land: set FABRIC_REPORTS_CONNECTION_SELF_HEAL=true AND restore
	// the matching clause in TemplateInstanceDetail's `isDataSourceResolvable`.
	const selfHealEnabled =
		process.env.FABRIC_REPORTS_CONNECTION_SELF_HEAL === "true";

	// 1. Prefer the explicitly-bound config when it still resolves for this tenant.
	if (storedConfigId) {
		const cfg = await getMcpConfigById(storedConfigId, {
			userId,
			organizationId,
		});
		if (cfg) {
			return { configId: cfg.id, healed: false, enabled: cfg.enabled };
		}
	}

	// 2. Self-heal (GATED — see selfHealEnabled above; off by default): the stored
	//    id is gone or belongs to another user/context — fall back to the user's
	//    own enabled config for the same server.
	if (selfHealEnabled) {
		const keys = Array.from(
			new Set(
				serverKeys.map((k) => k?.trim()).filter(Boolean) as string[],
			),
		);
		if (keys.length > 0) {
			const groups = await getAvailableMcpConfigsForKeys({
				keys,
				userId,
				organizationId,
			});
			for (const group of groups) {
				const candidate = group.configs[0];
				if (candidate) {
					// getAvailableMcpConfigsForKeys already filters enabled === true.
					return {
						configId: candidate.configId,
						healed: true,
						enabled: true,
					};
				}
			}
		}
	}

	return null;
}

/**
 * Create a new MCP config (always creates, never upserts).
 * Use this when the user explicitly wants a second config for the same server
 * (e.g., Azure DevOps for different projects).
 */
export async function createMcpConfig({
	mcpServerId,
	userId,
	organizationId,
	data,
}: {
	mcpServerId: string;
	userId?: string;
	organizationId?: string;
	data: Partial<{
		displayName: string | null;
		baseUrl: string | null;
		transport: MCPTransport | null;
		authType: MCPAuthType;
		apiKeyMethod: MCPApiKeyMethod | null;
		// OAuth client and token columns are written only through
		// `./mcp-oauth-credentials`, which binds and fences them.
		encryptedApiKey: string | null;
		scopes: string[];
		commandArgs: string[];
		enabled: boolean;
		description: string | null;
		domainKeywords: string[];
		exampleQueries: string[];
	}>;
}) {
	if (!userId) {
		throw new Error(
			"MCP config must have a userId (for personal or per-user org configs)",
		);
	}

	const createData = {
		mcpServerId,
		userId,
		organizationId: organizationId ?? null,
		displayName: data.displayName ?? null,
		baseUrl: data.baseUrl ?? null,
		transport: data.transport ?? null,
		authType: data.authType ?? ("NONE" as MCPAuthType),
		apiKeyMethod: data.apiKeyMethod ?? ("BEARER" as MCPApiKeyMethod),
		encryptedApiKey: data.encryptedApiKey ?? null,
		scopes: data.scopes ?? [],
		commandArgs: data.commandArgs ?? [],
		enabled: data.enabled ?? true,
		status: "HEALTHY" as MCPStatus,
		description: data.description ?? null,
		domainKeywords: data.domainKeywords ?? [],
		exampleQueries: data.exampleQueries ?? [],
	};

	return db.mCPConfig.create({ data: createData });
}

export async function upsertMcpConfig({
	mcpServerId,
	userId,
	organizationId,
	data,
}: {
	mcpServerId: string;
	userId?: string;
	organizationId?: string;
	data: Partial<{
		displayName: string | null;
		baseUrl: string | null;
		transport: MCPTransport | null;
		authType: MCPAuthType;
		apiKeyMethod: MCPApiKeyMethod | null;
		// OAuth client and token columns are written only through
		// `./mcp-oauth-credentials`, which binds and fences them.
		encryptedApiKey: string | null;
		scopes: string[];
		commandArgs: string[];
		enabled: boolean;
		// Semantic server routing metadata
		description: string | null;
		domainKeywords: string[];
		exampleQueries: string[];
	}>;
}) {
	// MCP configs can be:
	// 1. Personal only: userId set, organizationId null
	// 2. Per-user within org: userId set, organizationId set (user's config within org context)
	// At minimum, userId must be provided
	if (!userId) {
		throw new Error(
			"MCP config must have a userId (for personal or per-user org configs)",
		);
	}

	const tenantFilter = {
		mcpServerId,
		userId,
		organizationId: organizationId ?? null,
	};

	const existing = await db.mCPConfig.findFirst({ where: tenantFilter });
	if (existing) {
		// Filter out null apiKeyMethod since it's not a valid update value
		const { apiKeyMethod, ...restData } = data;
		const updateData =
			apiKeyMethod === null
				? restData
				: {
						...restData,
						...(apiKeyMethod !== undefined ? { apiKeyMethod } : {}),
					};
		return db.mCPConfig.update({
			where: { id: existing.id },
			data: updateData,
		});
	}

	const createData = {
		...tenantFilter,
		displayName: data.displayName ?? null,
		baseUrl: data.baseUrl ?? null,
		transport: data.transport ?? null,
		authType: data.authType ?? ("NONE" as MCPAuthType),
		apiKeyMethod: data.apiKeyMethod ?? ("BEARER" as MCPApiKeyMethod),
		encryptedApiKey: data.encryptedApiKey ?? null,
		scopes: data.scopes ?? [],
		commandArgs: data.commandArgs ?? [],
		enabled: data.enabled ?? true,
		status: "HEALTHY" as MCPStatus,
		// Semantic server routing metadata
		description: data.description ?? null,
		domainKeywords: data.domainKeywords ?? [],
		exampleQueries: data.exampleQueries ?? [],
	};

	return db.mCPConfig.create({ data: createData });
}

export async function deleteMcpConfig(id: string) {
	await db.mCPConfig.delete({ where: { id } });
	return { success: true };
}

export async function updateMcpConfigEnabled({
	id,
	enabled,
}: {
	id: string;
	enabled: boolean;
}) {
	return db.mCPConfig.update({
		where: { id },
		data: { enabled },
	});
}

// Health status updates
export async function setMcpConfigHealth({
	id,
	status,
	failoverUrl,
	consecutiveFailures,
}: {
	id: string;
	status: MCPStatus;
	failoverUrl?: string | null;
	consecutiveFailures?: number;
}) {
	return db.mCPConfig.update({
		where: { id },
		data: {
			status,
			lastHealthCheckAt: new Date(),
			failoverUrl: failoverUrl ?? null,
			consecutiveFailures: consecutiveFailures ?? 0,
		},
	});
}

// Short-lived session tokens
export async function createMcpClientSession({
	configId,
	userId,
	organizationId,
	ttlMinutes = 15,
}: {
	configId: string;
	userId: string;
	organizationId?: string;
	ttlMinutes?: number;
}) {
	const token = crypto.randomUUID();
	const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);
	const session = await db.mCPClientSession.create({
		data: {
			token,
			configId,
			userId,
			organizationId: organizationId ?? null,
			expiresAt,
		},
	});
	return { token: session.token, expiresAt: session.expiresAt };
}

export async function getMcpClientSession(token: string) {
	return db.mCPClientSession.findUnique({
		where: { token },
		include: { config: { include: { mcpServer: true } } },
	});
}

// OAuth state helpers
export async function createOauthState({
	mcpServerId,
	configId,
	userId,
	organizationId,
	codeVerifier,
	redirectUri,
	authorizationServerSnapshot,
	expectedGrantGeneration,
}: {
	mcpServerId: string;
	configId: string;
	userId: string;
	organizationId?: string;
	codeVerifier?: string;
	redirectUri?: string;
	/**
	 * What `start` resolved — the authorization server, endpoints and client —
	 * for the callback to use unchanged. Not secret.
	 */
	authorizationServerSnapshot?: Record<string, unknown>;
	/** The config's `oauthGrantGeneration` when `start` ran. */
	expectedGrantGeneration?: number;
}) {
	const state = crypto.randomUUID();
	const now = new Date();
	const expiresAt = new Date(now.getTime() + 10 * 60 * 1000); // 10 minutes

	await db.mCPOAuthState.create({
		data: {
			state,
			mcpServerId,
			configId,
			userId,
			organizationId: organizationId ?? null,
			codeVerifier: codeVerifier ?? null,
			redirectUri: redirectUri ?? null,
			...(authorizationServerSnapshot
				? {
						authorizationServerSnapshot:
							authorizationServerSnapshot as Prisma.InputJsonValue,
					}
				: {}),
			expectedGrantGeneration: expectedGrantGeneration ?? null,
			expiresAt,
		},
	});
	return state;
}

export async function getOauthState(state: string) {
	return db.mCPOAuthState.findUnique({ where: { state } });
}

export async function deleteOauthState(state: string) {
	await db.mCPOAuthState.delete({ where: { state } }).catch(() => {});
}

/**
 * Revoke a configuration's OAuth credentials: the server's own tokens
 * (access token and its lookup hash, refresh token, expiry) and the chained
 * Atlassian Cloud tokens with their site details, in ONE update. Two
 * separate updates could fail between them and leave the chained tokens
 * stored on a config the tile then shows as revoked. Keeps the row and its
 * client registration. Sets status to UNAVAILABLE.
 *
 * Owner-scoped with the exclusive tenant filter, so a config id from another
 * person or organization changes nothing; returns the number of rows
 * changed (0 or 1).
 */
export async function revokeOAuthTokens(
	configId: string,
	tenant: { userId: string; organizationId: string | null },
): Promise<number> {
	// Through the credential module: the wipe increments the grant
	// generation, so a refresh already in flight cannot write the revoked
	// grant back.
	return wipeMcpOAuthTokens({
		configId,
		tenant,
		extraData: {
			status: "UNAVAILABLE", // Mark as unavailable since no valid tokens
			encryptedAtlassianCloudAccessToken: null,
			encryptedAtlassianCloudRefreshToken: null,
			atlassianCloudTokenExpiresAt: null,
			atlassianCloudSiteUrl: null,
			atlassianCloudCloudId: null,
			atlassianCloudAccessibleResources: Prisma.DbNull,
			atlassianCloudScopes: [],
			atlassianCloudConnectedAt: null,
			atlassianCloudRefreshFailureCount: 0,
			atlassianCloudLastRefreshFailedAt: null,
			atlassianCloudLastRefreshError: null,
		},
	});
}

/**
 * Revoke all OAuth tokens for a user's PERSONAL configs only.
 * Useful for security incidents or user account deletion.
 *
 * TENANT ISOLATION (XOR Pattern):
 * Only revokes tokens for personal configs (organizationId IS NULL).
 * Org configs are NOT affected - use revokeAllOrgOAuthTokens for those.
 */
export async function revokeAllUserOAuthTokens(userId: string) {
	const count = await wipeMcpOAuthTokensWhere({
		where: {
			userId,
			organizationId: null, // XOR: Only personal configs
			authType: "OAUTH2",
		},
		extraData: { status: "UNAVAILABLE" },
	});
	return { count };
}

/**
 * Revoke all OAuth tokens for an organization's configs.
 * Useful for security incidents or organization offboarding.
 *
 * TENANT ISOLATION (XOR Pattern):
 * Only revokes tokens for org configs (organizationId matches).
 * Personal configs are NOT affected - use revokeAllUserOAuthTokens for those.
 */
export async function revokeAllOrgOAuthTokens(organizationId: string) {
	const count = await wipeMcpOAuthTokensWhere({
		where: {
			organizationId,
			authType: "OAUTH2",
		},
		extraData: { status: "UNAVAILABLE" },
	});
	return { count };
}

/**
 * Clean up expired OAuth states
 * Should be called periodically (e.g., every hour)
 */
export async function cleanupExpiredOAuthStates() {
	const now = new Date();
	const result = await db.mCPOAuthState.deleteMany({
		where: {
			expiresAt: {
				lt: now,
			},
		},
	});
	return result.count;
}

export async function cleanupExpiredMcpSessions() {
	await db.mCPClientSession.deleteMany({
		where: { expiresAt: { lt: new Date() } },
	});
}

export { GITLAB_PERSONAL_MCP_SERVER_KEYS, isGitLabPersonalMcpServerKey };

/**
 * Thrown by `getValidAccessToken` for any config of a GitLab personal server
 * key, whatever its `authType`. Its token must come from the GitLab connection
 * service, never from the MCPConfig row: not its OAuth columns (refreshing a
 * copy rotates the very grant the connection holds and kills it) and not an
 * API key stored there (a second, unmanaged GitLab credential).
 */
export class GitLabPersonalCredentialRequiredError extends Error {
	constructor(configId: string) {
		super(
			`MCP config ${configId} uses the personal GitLab connection; resolve its token through the GitLab connection service`,
		);
		this.name = "GitLabPersonalCredentialRequiredError";
	}
}

/**
 * Load an MCP config and verify the caller may use it, without touching its
 * credential.
 *
 * Supports both personal (user-level) and organizational MCP configs:
 * - For user-level configs: verifies the config belongs to the user
 * - For org-level configs: verifies the user is a member of the organization
 *
 * Throws on any mismatch. Shared by `getValidAccessToken` and by the GitLab
 * credential adapter in `@repo/mcp`, which must run the same check BEFORE it
 * resolves the person's GitLab connection — accepting a config id and then
 * trusting its owner would not be authorization.
 */
export async function authorizeMcpConfigAccess({
	configId,
	userId,
	organizationId,
}: {
	configId: string;
	userId: string;
	organizationId?: string | null;
}) {
	// Use internal function - authorization is done below
	const cfg = await getMcpConfigByIdInternal(configId);

	if (!cfg) {
		throw new Error("MCP config not found");
	}

	// Verify context matches if organizationId is explicitly provided
	if (organizationId !== undefined) {
		// If caller specifies org context, config must be an org config for that org
		if (organizationId && cfg.organizationId !== organizationId) {
			throw new Error(
				"Unauthorized: MCP config does not belong to the specified organization",
			);
		}
		// If caller specifies personal context (null), config must be personal
		if (organizationId === null && cfg.organizationId !== null) {
			throw new Error(
				"Unauthorized: MCP config is not a personal config",
			);
		}
	}

	// Verify user has access
	if (cfg.userId) {
		// Personal (user-level) config - verify ownership
		if (cfg.userId !== userId) {
			throw new Error(
				"Unauthorized: You do not have access to this MCP config",
			);
		}
	} else if (cfg.organizationId) {
		// Organization-level config - verify membership
		const membership = await db.member.findUnique({
			where: {
				organizationId_userId: {
					organizationId: cfg.organizationId,
					userId,
				},
			},
		});

		if (!membership) {
			throw new Error(
				"Unauthorized: You are not a member of the organization that owns this MCP config",
			);
		}
	}

	return cfg;
}

/**
 * Get a valid access token for an MCP config
 * Automatically refreshes if expired
 *
 * Authorization is `authorizeMcpConfigAccess`. GitLab personal server keys
 * (`GITLAB_PERSONAL_MCP_SERVER_KEYS`) are refused with
 * `GitLabPersonalCredentialRequiredError` whatever the config's `authType`:
 * callers resolve those through `getValidMcpAccessToken` in `@repo/mcp`.
 *
 * @param configId - MCP config ID
 * @param userId - User ID (for authorization)
 * @returns Decrypted access token (API key or OAuth access token) or null if not available
 */
export async function getValidAccessToken({
	configId,
	userId,
	organizationId,
}: {
	configId: string;
	userId: string;
	organizationId?: string | null;
}): Promise<string | null> {
	const cfg = await authorizeMcpConfigAccess({
		configId,
		userId,
		organizationId,
	});

	// Keyed on the server, not `authType`: an API-key or no-auth config of a
	// GitLab personal server holds no credential either.
	if (
		isGitLabPersonalMcpServerKey(
			(cfg.mcpServer as { key?: string } | null)?.key,
		)
	) {
		throw new GitLabPersonalCredentialRequiredError(configId);
	}

	// If not OAuth, return API key or null
	if (cfg.authType !== "OAUTH2") {
		return cfg.encryptedApiKey
			? (await import("@repo/utils")).decryptApiKey(cfg.encryptedApiKey)
			: null;
	}

	// Check if access token exists
	if (!cfg.encryptedAccessToken) {
		return null; // No token available
	}

	// Check if token is expired
	const now = new Date();
	let isExpired = !!(cfg.tokenExpiresAt && cfg.tokenExpiresAt <= now);

	// For known short-lived-token servers with null tokenExpiresAt (e.g. Notion),
	// check token age against known lifetime.
	const server = cfg.mcpServer as { defaultUrl?: string } | null;
	const serverBaseUrl = cfg.baseUrl || server?.defaultUrl;
	const { getMcpServerDefaultTokenExpiry, refreshMcpOAuthAccessToken } =
		await import("./mcp-oauth-refresh");
	const knownExpiry = getMcpServerDefaultTokenExpiry(serverBaseUrl);
	const tokenAge = cfg.updatedAt
		? Date.now() - new Date(cfg.updatedAt).getTime()
		: Number.POSITIVE_INFINITY;

	// If token age exceeds known lifetime, treat as hard-expired (same as tokenExpiresAt)
	if (!cfg.tokenExpiresAt && knownExpiry !== null) {
		if (tokenAge > knownExpiry * 1000) {
			isExpired = true;
		}
	}

	// Proactive refresh: between 75%-100% of known lifetime, try refresh but allow fallback
	const shouldProactivelyRefresh =
		!isExpired &&
		!cfg.tokenExpiresAt &&
		knownExpiry !== null &&
		cfg.encryptedRefreshToken &&
		tokenAge > knownExpiry * 0.75 * 1000;

	if (!isExpired && !shouldProactivelyRefresh) {
		// Token is still valid
		return (await import("@repo/utils")).decryptApiKey(
			cfg.encryptedAccessToken,
		);
	}

	// Token is expired or due for proactive refresh — try to refresh
	if (!cfg.encryptedRefreshToken) {
		if (isExpired) {
			return null; // Expired and no refresh token
		}
		// Proactive refresh not possible but token might still work
		return (await import("@repo/utils")).decryptApiKey(
			cfg.encryptedAccessToken,
		);
	}

	// Circuit breaker: the refresh token has already failed
	// MAX_REFRESH_FAILURES times, so another attempt would just re-hammer a
	// dead token and record a further failure. Only a successful re-auth
	// (a new grant through the connect flow) clears the flag.
	if (cfg.needsReauth) {
		if (!isExpired) {
			// Proactive-refresh window: the current token is still valid.
			return (await import("@repo/utils")).decryptApiKey(
				cfg.encryptedAccessToken,
			);
		}
		return null;
	}

	// Refresh through the one bound refresh path. Only count a failure
	// against the 3-strike circuit breaker when the token is hard-expired — a
	// proactive miss in the soft (75%-100%) window falls through to the
	// still-valid current token below, so transient errors there must not
	// flip the config to needsReauth.
	const outcome = await refreshMcpOAuthAccessToken(configId, {
		recordFailures: isExpired,
		expectedGeneration: cfg.oauthGrantGeneration,
	});
	if (outcome.status === "refreshed") {
		return outcome.accessToken;
	}
	if (outcome.status === "superseded") {
		// The credentials changed while refreshing (another refresh won, or the
		// config was reconnected or revoked). Use what is on the row now, if it
		// is a live token for a grant that is not condemned.
		const current = await getMcpConfigByIdInternal(configId);
		if (
			current?.encryptedAccessToken &&
			!current.needsReauth &&
			(!current.tokenExpiresAt || current.tokenExpiresAt > new Date())
		) {
			return (await import("@repo/utils")).decryptApiKey(
				current.encryptedAccessToken,
			);
		}
		return null;
	}
	// If proactive refresh failed, only return stale token in the soft window (75%-100%)
	if (!isExpired) {
		return (await import("@repo/utils")).decryptApiKey(
			cfg.encryptedAccessToken,
		);
	}
	return null; // Hard-expired and refresh failed
}

/**
 * Arguments for `recordRefreshFailure`.
 *
 * The union is the invariant, not a comment about it: a condemning call
 * (`permanent: true`) cannot be written without the `expectedRefreshToken` the
 * condemnation has to be bound to. Left optional, a caller could claim a dead
 * grant with no evidence attached and condemn unconditionally — and
 * `needsReauth` is ENFORCED, so that hard-blocks the integration until the user
 * completes a whole new OAuth flow.
 */
type RecordRefreshFailureArgs = {
	configId: string;
	/** Stored to `lastRefreshError`, truncated to 500 characters. */
	errorMessage: string;
	/**
	 * The `oauthGrantGeneration` the failed refresh was made under. Every
	 * write below is conditional on the config still holding it, so a failure
	 * of a grant that has since been revoked, replaced or reconnected never
	 * lands on the new one.
	 */
	expectedGeneration?: number;
} & (
	| {
			/**
			 * Whether the provider positively rejected the GRANT — an
			 * `invalid_grant` or `invalid_token` response (see
			 * `isPermanentGrantFailure`). Only these may condemn the
			 * credential: `needsReauth` is enforced at client creation, tool
			 * discovery and refresh, and its only exit is a user reconnect,
			 * which cannot fix a network outage, an IdP 5xx, a bad client
			 * secret or a misconfigured endpoint. Those still record
			 * diagnostics and still count toward the strike counter for
			 * triage, but never flip the flag.
			 *
			 * Typed `boolean` rather than `true` so callers can pass
			 * `isPermanentGrantFailure(code)` straight through; what this
			 * member forbids is a caller that MIGHT condemn holding no
			 * evidence.
			 */
			permanent: boolean;
			/**
			 * The `encryptedRefreshToken` ciphertext as READ before the
			 * refresh was attempted — the row version the provider passed
			 * judgement on. The condemning write is made conditional on the
			 * row still holding it: if a parallel refresh rotated the token
			 * while we were in flight, our rejection describes a superseded
			 * token and must not condemn a now-live credential.
			 */
			expectedRefreshToken: string;
	  }
	| {
			/** Transient unless classified — see the sibling member. */
			permanent?: false;
			/**
			 * Not accepted here: the calls that omit a classification are the
			 * local preflight failures, which never posted a token and so have
			 * no row version to bind anything to.
			 */
			expectedRefreshToken?: never;
	  }
);

/**
 * Record a token refresh failure
 * Tracks consecutive failures and marks as needs re-auth after threshold
 */
export async function recordRefreshFailure({
	configId,
	errorMessage,
	permanent = false,
	expectedRefreshToken,
	expectedGeneration,
}: RecordRefreshFailureArgs): Promise<{
	needsReauth: boolean;
	failureCount: number;
}> {
	// Internal function - used after authorization has been verified
	const cfg = await getMcpConfigByIdInternal(configId);
	if (!cfg) {
		return { needsReauth: false, failureCount: 0 };
	}
	// A failure of a grant the config no longer holds says nothing about the
	// one it holds now.
	if (
		expectedGeneration !== undefined &&
		cfg.oauthGrantGeneration !== expectedGeneration
	) {
		return {
			needsReauth: cfg.needsReauth,
			failureCount: cfg.refreshFailureCount ?? 0,
		};
	}
	const generationGuard =
		expectedGeneration === undefined
			? {}
			: { oauthGrantGeneration: expectedGeneration };

	// Already condemned — the breaker has tripped and only a fresh user grant
	// clears it. Re-writing the row would inflate counters and overwrite the
	// diagnostics from the failure that actually tripped it, both of which
	// triage reads.
	if (cfg.needsReauth) {
		return {
			needsReauth: true,
			failureCount: cfg.refreshFailureCount ?? 0,
		};
	}

	const newFailureCount = (cfg.refreshFailureCount ?? 0) + 1;
	const needsReauth = permanent && newFailureCount >= MAX_REFRESH_FAILURES;

	const diagnostics = {
		refreshFailureCount: newFailureCount,
		lastRefreshFailedAt: new Date(),
		lastRefreshError: errorMessage.slice(0, 500), // Limit error message length
	};

	if (needsReauth && expectedRefreshToken) {
		// Optimistic concurrency on the condemning write. Reading the row and
		// comparing tokens (the caller's rotation check) narrows the window but
		// does not close it: the winning refresh can persist its replacement
		// between that read and this write, so an unconditional update would
		// condemn a credential that is live by the time it lands.
		//
		// The version token is the CIPHERTEXT, deliberately — the opposite of
		// the caller's rotation check, which compares DECRYPTED values because
		// `encryptApiKey` is non-deterministic and a re-encrypt of the same
		// plaintext would look like a rotation. Here the question is not "is
		// this a different token" but "is this the same row version I read",
		// and the stored ciphertext answers exactly that. A writer that
		// re-encrypted the same plaintext without rotating therefore blocks the
		// condemnation — the fail-safe direction: the next refresh re-attempts
		// and condemns on evidence of its own.
		//
		// `needsReauth: false` guards the same write on the other axis: an
		// already-condemned row carries the diagnostics of the failure that
		// tripped it, and a later racer must not replace them with its own
		// while double-counting the strike (the same reasoning as the
		// already-condemned early return above, which this closes the window
		// on).
		const condemned = await db.mCPConfig.updateMany({
			where: {
				id: configId,
				encryptedRefreshToken: expectedRefreshToken,
				needsReauth: false,
				...generationGuard,
			},
			data: {
				...diagnostics,
				needsReauth: true,
				status: "UNAVAILABLE",
			},
		});

		if (condemned.count === 0) {
			// Zero matches means the row moved on under us — it rotated its
			// refresh token, or a concurrent failure condemned it first. The
			// diagnostics-only write tells the two apart: gated on the breaker
			// alone, it lands for a rotation and declines for a condemnation.
			// Either way `needsReauth`/`status` are omitted entirely rather
			// than written as `false`, so this write cannot clear a flag a
			// concurrent, better-evidenced failure set.
			const recorded = await db.mCPConfig.updateMany({
				where: { id: configId, needsReauth: false, ...generationGuard },
				data: diagnostics,
			});

			if (recorded.count === 0) {
				// Condemned under us. Not an error: report what is true rather
				// than the `false` our stale snapshot computed, with that
				// snapshot's counter, since our increment never landed.
				return {
					needsReauth: true,
					failureCount: cfg.refreshFailureCount ?? 0,
				};
			}

			// A rotation, then. Recording the telemetry against a rotated row
			// beats losing it — that would hide a recurring problem — but it
			// is worth a line, because a rejection that could not be acted on
			// is exactly what a lost race looks like from here.
			// `console.error` because most log shippers drop warn-level by
			// default.
			console.error(
				"[MCP] refresh rejection would have condemned a config whose refresh token has since been rotated — recording the failure only",
				{ configId },
			);
			return { needsReauth: false, failureCount: newFailureCount };
		}

		return { needsReauth: true, failureCount: newFailureCount };
	}

	if (needsReauth) {
		// A condemnation carrying no `expectedRefreshToken`. The typed
		// signature no longer allows this — `permanent: true` must travel with
		// its evidence — so it is reachable only from an untyped caller. Keep
		// condemning: dropping the strike here would fail open into the retry
		// storm the breaker exists to stop. There is no row version to bind
		// to, but the breaker guard still applies: a row condemned under us is
		// already behind the breaker, so declining changes no outcome and
		// preserves the diagnostics of the failure that tripped it.
		const condemned = await db.mCPConfig.updateMany({
			where: { id: configId, needsReauth: false, ...generationGuard },
			data: {
				...diagnostics,
				needsReauth: true,
				status: "UNAVAILABLE",
			},
		});

		if (condemned.count === 0) {
			return {
				needsReauth: true,
				failureCount: cfg.refreshFailureCount ?? 0,
			};
		}

		return { needsReauth: true, failureCount: newFailureCount };
	}

	// Diagnostics only. `needsReauth`/`status` are deliberately ABSENT rather
	// than written as `false`/unchanged: a transient failure that read the flag
	// as false would otherwise land AFTER a concurrent permanent one set it and
	// restore the credential the better-evidenced failure just condemned —
	// last-writer-wins, reopening the storm. The `needsReauth: false` guard
	// closes the same race from the other side, so a breaker that tripped
	// between our read and this write declines the write outright instead of
	// inflating counters and overwriting the diagnostics of the failure that
	// actually tripped it (the same reasoning as the already-condemned early
	// return above).
	const recorded = await db.mCPConfig.updateMany({
		where: { id: configId, needsReauth: false, ...generationGuard },
		data: diagnostics,
	});

	if (recorded.count === 0) {
		// Not an error: the row is condemned now, so report what is true rather
		// than the `false` our stale snapshot computed. The counter comes from
		// that snapshot too — our increment never landed.
		return {
			needsReauth: true,
			failureCount: cfg.refreshFailureCount ?? 0,
		};
	}

	return { needsReauth, failureCount: newFailureCount };
}

/**
 * Clear refresh failure tracking after a successful grant, only while the
 * config still holds the grant generation the caller saw succeed: a success
 * of a grant that has since been revoked or replaced must not clear the
 * breaker of the one that replaced it. Returns whether it applied.
 *
 * The token writes in `./mcp-oauth-credentials` reset the breaker themselves;
 * this is for flows whose credential lives elsewhere (GitLab personal).
 */
export async function clearRefreshFailures(
	configId: string,
	options: { expectedGeneration: number },
): Promise<boolean> {
	const result = await db.mCPConfig.updateMany({
		where: {
			id: configId,
			oauthGrantGeneration: options.expectedGeneration,
		},
		data: {
			refreshFailureCount: 0,
			lastRefreshFailedAt: null,
			lastRefreshError: null,
			needsReauth: false,
			// Restore status to HEALTHY too. The 3-strike circuit breaker
			// in `recordRefreshFailure` flips status to UNAVAILABLE
			// alongside `needsReauth: true`; clearing failures without
			// flipping status back left configs in a stuck UNAVAILABLE
			// state after the refresh path recovered.
			status: "HEALTHY" as MCPStatus,
			consecutiveFailures: 0,
		},
	});
	return result.count > 0;
}

// =============================================================================
// Tool Caching
// =============================================================================

/**
 * Cached tool definition structure
 */
export interface CachedTool {
	name: string;
	description: string | null;
	inputSchema: Record<string, unknown> | null;
}

/**
 * Update cached tools for an MCP config
 *
 * Called by the ingestion workflow after successfully fetching tools from the server.
 * This avoids the need to connect to MCP servers on every page load.
 */
export async function updateMcpConfigToolCache({
	configId,
	tools,
}: {
	configId: string;
	tools: CachedTool[];
}) {
	return db.mCPConfig.update({
		where: { id: configId },
		data: {
			cachedTools: tools as unknown as Prisma.InputJsonValue,
			toolsCachedAt: new Date(),
			toolCount: tools.length,
		},
	});
}

/**
 * Get cached tools for an MCP config
 *
 * Returns the cached tools if available, or null if not cached.
 */
export async function getMcpConfigCachedTools(configId: string): Promise<{
	tools: CachedTool[] | null;
	cachedAt: Date | null;
	toolCount: number;
}> {
	const config = await db.mCPConfig.findUnique({
		where: { id: configId },
		select: {
			cachedTools: true,
			toolsCachedAt: true,
			toolCount: true,
		},
	});

	if (!config) {
		return { tools: null, cachedAt: null, toolCount: 0 };
	}

	return {
		tools: config.cachedTools as CachedTool[] | null,
		cachedAt: config.toolsCachedAt,
		toolCount: config.toolCount,
	};
}

/**
 * Clear cached tools for an MCP config
 *
 * Called when config is disabled or deleted.
 */
/**
 * Get the email of a user's Google account (if they signed in via Google).
 * Used to pass `login_hint` to Google OAuth flows (e.g., Google Drive MCP).
 */
export async function getGoogleAccountEmail(
	userId: string,
): Promise<string | null> {
	const account = await db.account.findFirst({
		where: { userId, providerId: "google" },
		select: { userId: true },
	});
	if (!account) {
		return null;
	}

	// The Account table stores the Google user ID in accountId, not the email.
	// Fetch the email from the User table instead.
	const user = await db.user.findUnique({
		where: { id: userId },
		select: { email: true },
	});
	return user?.email ?? null;
}

export async function clearMcpConfigToolCache(configId: string) {
	return db.mCPConfig.update({
		where: { id: configId },
		data: {
			cachedTools: Prisma.DbNull,
			toolsCachedAt: null,
			toolCount: 0,
		},
	});
}

export type PmToolTransport = "mcp" | "rest";

export interface PmToolOption {
	key: string;
	displayName: string;
	iconKey: string;
	isDefault: boolean;
	isConfigured: boolean;
	mcpServerId: string;
	mcpConfigId: string | null;
	configDisplayName: string | null;
	transport: PmToolTransport | null;
	/**
	 * True iff the wizard is in org context, the caller's GitLab is not
	 * usable in this organization, and their personal-scope GitLab
	 * connection is (see `PmToolGitLabStatus.personalScopeConnected`). The
	 * picker uses this to render a distinct "connected in personal — connect
	 * for this org" affordance.
	 */
	connectedInPersonalScope?: boolean;
}

/**
 * The caller's GitLab connection, as the GitLab connection service reports
 * it (`@repo/integrations/gitlab` `readGitLabPersonalConnection`). This
 * package cannot import that service, so the API layer reads it and passes
 * it in; the picker never decides GitLab's status from rows of its own, so it
 * cannot disagree with any other GitLab screen.
 */
export interface PmToolGitLabStatus {
	/** The caller's connection in the picker's tenant. */
	state: "connected" | "needs-reconnect" | "not-connected";
	/**
	 * Org context only: the caller's personal-scope connection is usable.
	 * Ignored in personal context.
	 */
	personalScopeConnected?: boolean;
}

/**
 * List PM tool options available to a tenant for the project setup
 * wizard.
 *
 * Returns the union of:
 *   1. Platform defaults (`DEFAULT_PROJECT_MANAGEMENT_KEYS`) — emitted
 *      regardless of whether the tenant has an MCPConfig for them.
 *   2. Tenant's enabled MCPConfigs whose linked MCPServer has
 *      category = "Project Management" OR tags includes
 *      "project-management".
 *
 * GitLab is offered as configured only when `gitlab.state` is "connected":
 * an enabled `gitlab` / `gitlab-official` MCPConfig is a transport record,
 * not a connection, and a connection that needs reconnecting cannot run PM
 * sync. Otherwise GitLab falls back to its not-configured default stub (the
 * option model has no needs-reconnect state).
 *
 * Deduplication is keyed on `MCPServer.key` — if the tenant has a
 * config for a default key, only the configured option is emitted
 * (the default-only stub is suppressed for that tenant).
 *
 * XOR tenant isolation: org context never sees personal configs,
 * personal context never sees org configs. Defaults are
 * tenant-agnostic.
 *
 * Sort order:
 *   1. Configured rows alphabetically by display name.
 *   2. Default-only stubs in fixed order matching
 *      DEFAULT_PROJECT_MANAGEMENT_KEYS.
 */
export async function listAvailablePmTools({
	userId,
	organizationId,
	gitlab,
}: {
	userId: string;
	organizationId: string | null;
	gitlab: PmToolGitLabStatus;
}): Promise<PmToolOption[]> {
	const tenantFilter = organizationId
		? { organizationId, userId }
		: { organizationId: null, userId };
	const gitlabUsable = gitlab.state === "connected";

	const [defaultServers, tenantConfigs] = await Promise.all([
		db.mCPServer.findMany({
			where: {
				isSystemProvided: true,
				key: { in: [...DEFAULT_PROJECT_MANAGEMENT_KEYS] },
			},
			select: { id: true, key: true, name: true },
		}),
		db.mCPConfig.findMany({
			where: {
				...tenantFilter,
				enabled: true,
				OR: [
					{ mcpServer: { category: "Project Management" } },
					{ mcpServer: { tags: { has: "project-management" } } },
				],
			},
			include: {
				mcpServer: {
					select: {
						id: true,
						key: true,
						name: true,
						category: true,
						tags: true,
					},
				},
			},
		}),
	]);

	const configuredOptions: PmToolOption[] = [];
	const configuredKeys = new Set<string>();

	for (const config of tenantConfigs) {
		const server = config.mcpServer;
		if (!server) {
			continue;
		}
		const key = server.key;
		// A GitLab MCPConfig is a transport record; the person's connection
		// decides whether GitLab is usable.
		if (isGitLabPersonalMcpServerKey(key) && !gitlabUsable) {
			continue;
		}
		const isDefault = DEFAULT_PROJECT_MANAGEMENT_KEYS.includes(
			key as (typeof DEFAULT_PROJECT_MANAGEMENT_KEYS)[number],
		);
		const displayName =
			DEFAULT_PROJECT_MANAGEMENT_DISPLAY_OVERRIDES[key] ?? server.name;
		const iconKey =
			DEFAULT_PROJECT_MANAGEMENT_ICON_KEY_OVERRIDES[key] ?? key;
		configuredOptions.push({
			key,
			displayName,
			iconKey,
			isDefault,
			isConfigured: true,
			mcpServerId: server.id,
			mcpConfigId: config.id,
			configDisplayName: config.displayName ?? server.name,
			transport: "mcp",
		});
		configuredKeys.add(key);
	}

	configuredOptions.sort((a, b) =>
		a.displayName.localeCompare(b.displayName),
	);

	// Catalog-row resilience: a default key with no `MCPServer` row would
	// previously be silently dropped from the picker (both the REST-
	// synthesis branch and the default-stub loop did `defaultServers.find`
	// and short-circuited when undefined). That left environments whose
	// seed predated a new default key — staging at one point lacked the
	// `gitlab-official` row — with no way to see the tool in the picker
	// even when the user had a fully working `WorkflowIntegration`. The
	// picker must treat the integration as ground truth; the catalog row
	// is a UI-label pointer, not a gate.
	//
	// `MCPServer.id` is a cuid; when the row is absent we emit
	// `${PM_SERVER_ID_KEY_SENTINEL_PREFIX}${key}` (see default-pm-tool-keys.ts)
	// as a stable, deterministic fallback. Downstream consumers that look
	// the id up (e.g. `getProjectPMServerKey`) recognise the sentinel
	// shape and resolve it back to the key.
	function resolveServerIdForKey(key: string): string {
		const found = defaultServers.find((s) => s.key === key);
		return found ? found.id : `${PM_SERVER_ID_KEY_SENTINEL_PREFIX}${key}`;
	}
	const missingDefaultKeys = DEFAULT_PROJECT_MANAGEMENT_KEYS.filter(
		(key) => !defaultServers.some((s) => s.key === key),
	);
	if (missingDefaultKeys.length > 0) {
		// Loud so production telemetry surfaces the misconfigured environment.
		// `console.error` because most log shippers drop warn-level by default.
		console.error(
			"[available-pm-tools] MCPServer catalog rows missing — seed is out of date. Picker emitting key-sentinel ids as a degradation fallback. Missing keys:",
			missingDefaultKeys.join(", "),
		);
	}

	// GitLab REST-fallback synthesis:
	// If the caller's GitLab connection is usable but there is no enabled
	// gitlab-official MCPConfig, surface a REST-mode entry so the wizard
	// treats it as configured. PM runtime dispatch already resolves the REST
	// source via resolveGitLabPMSource(); the MCPConfig is absent because the
	// tier probe found the GitLab instance is not MCP-capable (Free/Bronze,
	// or self-hosted CE without the MCP endpoint).
	const restGitlabSynthesized: PmToolOption[] = [];
	if (!configuredKeys.has("gitlab-official") && gitlabUsable) {
		const gitlabServer = defaultServers.find(
			(s) => s.key === "gitlab-official",
		);
		const displayName =
			DEFAULT_PROJECT_MANAGEMENT_DISPLAY_OVERRIDES["gitlab-official"] ??
			gitlabServer?.name ??
			"GitLab";
		const iconKey =
			DEFAULT_PROJECT_MANAGEMENT_ICON_KEY_OVERRIDES["gitlab-official"] ??
			"gitlab-official";
		restGitlabSynthesized.push({
			key: "gitlab-official",
			displayName,
			iconKey,
			isDefault: true,
			isConfigured: true,
			mcpServerId: resolveServerIdForKey("gitlab-official"),
			mcpConfigId: null,
			configDisplayName: "GitLab (REST)",
			transport: "rest",
		});
		configuredKeys.add("gitlab-official");
	}

	const defaultStubs: PmToolOption[] = [];
	for (const key of DEFAULT_PROJECT_MANAGEMENT_KEYS) {
		if (configuredKeys.has(key)) {
			continue;
		}
		const server = defaultServers.find((s) => s.key === key);
		const displayName =
			DEFAULT_PROJECT_MANAGEMENT_DISPLAY_OVERRIDES[key] ??
			server?.name ??
			key;
		const iconKey =
			DEFAULT_PROJECT_MANAGEMENT_ICON_KEY_OVERRIDES[key] ?? key;
		const isPersonalGitlab =
			key === "gitlab-official" &&
			organizationId !== null &&
			gitlab.personalScopeConnected === true;
		defaultStubs.push({
			key,
			displayName,
			iconKey,
			isDefault: true,
			isConfigured: false,
			mcpServerId: resolveServerIdForKey(key),
			mcpConfigId: null,
			configDisplayName: null,
			transport: null,
			...(isPersonalGitlab ? { connectedInPersonalScope: true } : {}),
		});
	}

	return [...configuredOptions, ...restGitlabSynthesized, ...defaultStubs];
}

// =====================================================================
// Hybrid Atlassian Cloud OAuth — chained 3LO token storage (PR #1169).
// These helpers manage the SECONDARY OAuth token (audience =
// api.atlassian.com) that's chained off the primary Rovo MCP OAuth
// (audience = mcp.atlassian.com). The secondary token unlocks REST
// attachment upload + site-direct attachment URL rewriting for Jira
// push. When absent, the PM-sync image-upload path degrades to base64.
// =====================================================================

/**
 * Write fresh Atlassian Cloud tokens + site context to an MCPConfig.
 * Called from the dedicated `/api/mcp/atlassian-cloud/callback` route
 * after a successful 3LO exchange, and from the refresh helper. Resets
 * Atlassian-Cloud-specific failure counters on success.
 */
/** One Atlassian site the user granted access to (from accessible-resources). */
export type AtlassianCloudResource = {
	id: string; // cloudId (tenant UUID)
	url: string; // site URL, e.g. https://acme.atlassian.net
	name?: string;
};

export async function updateMcpAtlassianCloudTokens({
	configId,
	encryptedAccessToken,
	encryptedRefreshToken,
	tokenExpiresAt,
	siteUrl,
	cloudId,
	scopes,
	accessibleResources,
}: {
	configId: string;
	encryptedAccessToken: string;
	encryptedRefreshToken: string | null;
	tokenExpiresAt: Date | null;
	siteUrl: string;
	cloudId: string;
	scopes: string[];
	// Full accessible-resources list. The token grants access to ALL of
	// these sites; the upload path routes each issue to its own site by
	// matching the issue's cloudId against this list. Optional so the
	// refresh path (which preserves the existing list) can omit it.
	accessibleResources?: AtlassianCloudResource[];
}) {
	return await db.mCPConfig.update({
		where: { id: configId },
		data: {
			encryptedAtlassianCloudAccessToken: encryptedAccessToken,
			encryptedAtlassianCloudRefreshToken: encryptedRefreshToken,
			atlassianCloudTokenExpiresAt: tokenExpiresAt,
			atlassianCloudSiteUrl: siteUrl,
			atlassianCloudCloudId: cloudId,
			atlassianCloudScopes: scopes,
			...(accessibleResources
				? { atlassianCloudAccessibleResources: accessibleResources }
				: {}),
			atlassianCloudConnectedAt: new Date(),
			atlassianCloudRefreshFailureCount: 0,
			atlassianCloudLastRefreshFailedAt: null,
			atlassianCloudLastRefreshError: null,
		},
	});
}

/**
 * Record an Atlassian-Cloud refresh failure. After 3 consecutive
 * failures, the upload path should silently fall back to base64 inline
 * — but we never flip the primary `status` or `needsReauth` flags from
 * the Cloud path, because the Rovo (primary) connection is what gates
 * the rest of the MCP tooling.
 */
export async function recordMcpAtlassianCloudRefreshFailure({
	configId,
	error,
}: {
	configId: string;
	error: string;
}) {
	const current = await db.mCPConfig.findUnique({
		where: { id: configId },
		select: { atlassianCloudRefreshFailureCount: true },
	});
	const nextCount = (current?.atlassianCloudRefreshFailureCount ?? 0) + 1;
	await db.mCPConfig.update({
		where: { id: configId },
		data: {
			atlassianCloudRefreshFailureCount: nextCount,
			atlassianCloudLastRefreshFailedAt: new Date(),
			atlassianCloudLastRefreshError: error.slice(0, 500),
		},
	});
	return { failureCount: nextCount };
}

/**
 * Clear the Atlassian Cloud connection (user disconnect, or explicit
 * "Remove image-attachment support" action). Leaves the primary Rovo
 * connection untouched.
 */
export async function clearMcpAtlassianCloudTokens(
	configId: string,
): Promise<void> {
	await db.mCPConfig.update({
		where: { id: configId },
		data: {
			encryptedAtlassianCloudAccessToken: null,
			encryptedAtlassianCloudRefreshToken: null,
			atlassianCloudTokenExpiresAt: null,
			atlassianCloudSiteUrl: null,
			atlassianCloudCloudId: null,
			atlassianCloudAccessibleResources: Prisma.DbNull,
			atlassianCloudScopes: [],
			atlassianCloudConnectedAt: null,
			atlassianCloudRefreshFailureCount: 0,
			atlassianCloudLastRefreshFailedAt: null,
			atlassianCloudLastRefreshError: null,
		},
	});
}
