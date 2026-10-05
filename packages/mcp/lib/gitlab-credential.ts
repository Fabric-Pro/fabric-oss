/**
 * MCP transport credentials for the GitLab personal servers (`gitlab`,
 * `gitlab-official`).
 *
 * Those MCP configs no longer carry a credential of their own: the person's
 * one GitLab connection does (`@repo/integrations/gitlab` connection
 * service), and only that service refreshes it — with the client that issued
 * it. This module is the single place the MCP layer turns a GitLab config
 * into a bearer token:
 *
 *   1. the config must already be authorized for the caller
 *      (`authorizeMcpConfigAccess`, or a lookup scoped the same way), AND be
 *      the caller's own personal config in that tenant context — an
 *      organization-level or teammate's config never resolves to anyone's
 *      personal connection;
 *   2. the token comes from the connection service (refreshed when due);
 *   3. it is handed out only when the config's endpoint is on the same
 *      GitLab origin the credential was issued by.
 *
 * A caller that builds an MCP transport itself uses
 * `getValidMcpTransportAuth` / `getGitLabMcpTransportAuth`: they also check
 * the endpoint the transport will ACTUALLY connect to (which may differ from
 * the saved one — a test-connection URL, a failover URL) and return the
 * `fetch` the transport must use, so every credential-bearing request stays
 * on that origin and goes through the GitLab outbound guard.
 */
import type {
	OAuthClientInformation,
	OAuthClientMetadata,
	OAuthClientProvider,
	OAuthTokens,
} from "@ai-sdk/mcp";
import {
	authorizeMcpConfigAccess,
	getMcpConfigById,
	getValidAccessToken,
	isGitLabPersonalMcpServerKey,
	isOrganizationMember,
} from "@repo/database";
import {
	type GitLabConnectionDeps,
	getGitLabConnectionToken,
	gitlabOutboundFetch,
	mcpRowOrigin,
	parseGitLabOrigin,
	readStoredGitLabConnectionStatus,
} from "@repo/integrations/gitlab";

export type GitLabMcpCredentialErrorCode =
	| "not-owner"
	| "origin-mismatch"
	| "not-connected"
	| "needs-reauth"
	| "unavailable";

export class GitLabMcpCredentialError extends Error {
	readonly code: GitLabMcpCredentialErrorCode;
	constructor(code: GitLabMcpCredentialErrorCode, message: string) {
		super(message);
		this.name = "GitLabMcpCredentialError";
		this.code = code;
	}
}

/** The fields of an MCPConfig (with its server) this module reads. */
export type GitLabMcpConfigLike = {
	id: string;
	userId: string | null;
	organizationId: string | null;
	baseUrl: string | null;
	mcpServer?: { key?: string | null; defaultUrl?: string | null } | null;
};

export function isGitLabPersonalMcpConfig(
	config: Pick<GitLabMcpConfigLike, "mcpServer">,
): boolean {
	return isGitLabPersonalMcpServerKey(config.mcpServer?.key ?? undefined);
}

/**
 * The caller's GitLab connection token for an ALREADY-AUTHORIZED GitLab MCP
 * config. Throws `GitLabMcpCredentialError` when the config is not the
 * caller's own personal config in this tenant context, when the connection
 * is missing or needs reconnecting, or when the config's endpoint is on a
 * different GitLab origin than the credential.
 */
export async function getGitLabMcpAccessToken(args: {
	config: GitLabMcpConfigLike;
	userId: string;
	organizationId: string | null | undefined;
	deps?: Partial<GitLabConnectionDeps>;
}): Promise<string> {
	return (await resolveGitLabMcpCredential(args)).accessToken;
}

async function resolveGitLabMcpCredential(args: {
	config: GitLabMcpConfigLike;
	userId: string;
	organizationId: string | null | undefined;
	deps?: Partial<GitLabConnectionDeps>;
}): Promise<{ accessToken: string; origin: string; generation: number }> {
	const organizationId = args.organizationId ?? null;
	if (
		!args.config.userId ||
		args.config.userId !== args.userId ||
		(args.config.organizationId ?? null) !== organizationId
	) {
		throw new GitLabMcpCredentialError(
			"not-owner",
			"GitLab connections are personal: this MCP configuration does not belong to you in this context.",
		);
	}
	// Reading the connection can classify a legacy row, refresh the token
	// and hand it out, all in this organization. Every MCP entry point reaches
	// a GitLab config through here, and not all of them check that the
	// caller still belongs to the config's organization (some take it from a
	// request body or a workflow input), so it is checked here, once, for all
	// of them: a person who has left an organization keeps their config row
	// there but can no longer use the connection it names. A GitLab
	// connection lives in an organization (ADR-018); with none there is
	// nothing to read.
	if (!organizationId) {
		throw new GitLabMcpCredentialError(
			"not-owner",
			"GitLab connections belong to an organization: this MCP configuration has none.",
		);
	}
	// The same membership check `isCachedGitLabClientUsable` runs before a
	// cached client built here is used again.
	if (!(await isOrganizationMember(args.userId, organizationId))) {
		throw new GitLabMcpCredentialError(
			"not-owner",
			"You are no longer a member of the organization this GitLab MCP configuration belongs to.",
		);
	}
	// `anyOrigin`: the token goes only to this config's endpoint, and only
	// when that endpoint is on the credential's own instance (checked below).
	const token = await getGitLabConnectionToken(
		{ userId: args.userId, organizationId },
		{ mode: "strict", anyOrigin: true },
		args.deps,
	);
	if (!token.ok) {
		if (token.reason === "not-connected") {
			throw new GitLabMcpCredentialError(
				"not-connected",
				"GitLab is not connected. Connect GitLab in Settings > Integrations.",
			);
		}
		if (token.reason === "needs-reauth") {
			throw new GitLabMcpCredentialError(
				"needs-reauth",
				"Your GitLab connection needs to be reconnected. Reconnect GitLab in Settings > Integrations.",
			);
		}
		throw new GitLabMcpCredentialError("unavailable", token.message);
	}
	const configOrigin = mcpRowOrigin({
		baseUrl: args.config.baseUrl,
		mcpServer: args.config.mcpServer
			? { defaultUrl: args.config.mcpServer.defaultUrl ?? null }
			: null,
	});
	if (configOrigin !== token.origin) {
		throw originError();
	}
	return {
		accessToken: token.accessToken,
		origin: token.origin,
		generation: token.generation,
	};
}

/**
 * Whether an MCP client built for a GitLab personal config, holding the
 * connection token of generation `generation` as its bearer header, may
 * still be used: the caller is still a member of the config's organization
 * (the same `isOrganizationMember` check `resolveGitLabMcpCredential` runs
 * before it hands out a token), the config is still the caller's and
 * enabled, and the person's GitLab connection is still connected, needs no
 * reconnect, and is the same connection (a disconnect or a reconnect changes
 * the generation; a token refresh does not).
 *
 * Three reads, run together, and no write: the membership row, the config
 * row, and the stored connection (`readStoredGitLabConnectionStatus`, one
 * read, no classification). A read that fails rejects; the caller treats that
 * as unusable too.
 */
export async function isCachedGitLabClientUsable(args: {
	configId: string;
	userId: string;
	organizationId: string | null | undefined;
	generation: number | undefined;
}): Promise<boolean> {
	const organizationId = args.organizationId ?? null;
	if (!organizationId || args.generation === undefined) {
		return false;
	}
	const [isMember, config, status] = await Promise.all([
		isOrganizationMember(args.userId, organizationId),
		getMcpConfigById(args.configId, {
			userId: args.userId,
			organizationId,
		}),
		readStoredGitLabConnectionStatus({
			userId: args.userId,
			organizationId,
		}),
	]);
	return (
		isMember &&
		Boolean(config?.enabled) &&
		status.connected &&
		!status.needsReauth &&
		status.generation === args.generation
	);
}

/** The `fetch` signature the MCP SDK transports accept. */
export type GitLabMcpFetch = (
	url: string | URL,
	init?: RequestInit,
) => Promise<Response>;

function originError(): GitLabMcpCredentialError {
	return new GitLabMcpCredentialError(
		"origin-mismatch",
		"This MCP server is not on the GitLab instance your GitLab connection belongs to.",
	);
}

/**
 * The `fetch` for an MCP transport that carries a GitLab credential issued by
 * `origin`. Every request is refused before it is sent unless its URL is on
 * that origin; an allowed one goes through `gitlabOutboundFetch` (a
 * self-hosted instance through the outbound guard, which checks the literal
 * host and every resolved address), with redirects refused unless the caller
 * handles them itself (`redirect: "manual"`).
 */
export function createGitLabMcpFetch(origin: string): GitLabMcpFetch {
	return async (input, init) => {
		const url = typeof input === "string" ? input : input.toString();
		const checked = parseGitLabOrigin(url);
		if (!checked.ok || checked.origin !== origin) {
			throw originError();
		}
		return gitlabOutboundFetch(url, {
			...init,
			redirect: init?.redirect === "manual" ? "manual" : "error",
		});
	};
}

/**
 * The caller's GitLab connection token for an ALREADY-AUTHORIZED GitLab MCP
 * config, for a transport that will connect to `endpoint`. On top of
 * `getGitLabMcpAccessToken`'s checks, `endpoint` itself must be on the
 * credential's origin, and the returned `fetch` must be the transport's
 * fetch: it keeps every request on that origin and guarded.
 */
export async function getGitLabMcpTransportAuth(args: {
	config: GitLabMcpConfigLike;
	userId: string;
	organizationId: string | null | undefined;
	endpoint: string;
	deps?: Partial<GitLabConnectionDeps>;
}): Promise<{
	accessToken: string;
	fetch: GitLabMcpFetch;
	/** The connection generation the token belongs to. */
	generation: number;
}> {
	const credential = await resolveGitLabMcpCredential(args);
	const endpoint = parseGitLabOrigin(args.endpoint);
	if (!endpoint.ok || endpoint.origin !== credential.origin) {
		throw originError();
	}
	return {
		accessToken: credential.accessToken,
		fetch: createGitLabMcpFetch(credential.origin),
		generation: credential.generation,
	};
}

/**
 * `getValidMcpAccessToken` for a caller that builds the transport itself and
 * connects to `endpoint`. A GitLab personal config also gets the `fetch` its
 * transport must use (see `getGitLabMcpTransportAuth`); every other config
 * keeps the generic MCPConfig token and no fetch.
 */
export async function getValidMcpTransportAuth(args: {
	configId: string;
	userId: string;
	organizationId?: string | null;
	endpoint: string;
}): Promise<{ accessToken: string | null; fetch?: GitLabMcpFetch }> {
	const { endpoint, ...access } = args;
	const cfg = await authorizeMcpConfigAccess(access);
	// Keyed on the server, not `authType`: a GitLab personal config of any
	// auth type resolves through the person's connection, never its own row.
	if (isGitLabPersonalMcpConfig(cfg)) {
		return getGitLabMcpTransportAuth({
			config: cfg,
			userId: args.userId,
			organizationId: args.organizationId,
			endpoint,
		});
	}
	return { accessToken: await getValidAccessToken(access) };
}

/**
 * `getValidAccessToken` for every MCP config: GitLab personal configs get the
 * caller's GitLab connection token (after the same authorization check),
 * every other config keeps the generic MCPConfig path.
 */
export async function getValidMcpAccessToken(args: {
	configId: string;
	userId: string;
	organizationId?: string | null;
}): Promise<string | null> {
	const cfg = await authorizeMcpConfigAccess(args);
	// Keyed on the server, not `authType`: a GitLab personal config of any
	// auth type resolves through the person's connection, never its own row.
	if (isGitLabPersonalMcpConfig(cfg)) {
		return getGitLabMcpAccessToken({
			config: cfg,
			userId: args.userId,
			organizationId: args.organizationId,
		});
	}
	return getValidAccessToken(args);
}

/**
 * An `OAuthClientProvider` for a GitLab personal config, for code that drives
 * the MCP SDK's OAuth plumbing directly. It hands the SDK the connection's
 * current access token and nothing it could refresh with (no refresh token),
 * never stores tokens the SDK hands back, and never clears the config's
 * client registration — which may be the issuer of the person's credential.
 */
export function createGitLabConnectionAuthProvider(args: {
	config: GitLabMcpConfigLike & {
		oauthClientId?: string | null;
	};
	userId: string;
	organizationId: string | null | undefined;
	redirectUri: string;
	clientMetadata: OAuthClientMetadata;
	onAuthorizationRequired?: (authorizationUrl: URL) => void | Promise<void>;
	authorizationRequired: (authorizationUrl: URL) => Error;
}): OAuthClientProvider {
	return {
		async tokens(): Promise<OAuthTokens | undefined> {
			try {
				const accessToken = await getGitLabMcpAccessToken({
					config: args.config,
					userId: args.userId,
					organizationId: args.organizationId,
				});
				return { access_token: accessToken, token_type: "Bearer" };
			} catch (error) {
				if (error instanceof GitLabMcpCredentialError) {
					return undefined;
				}
				throw error;
			}
		},
		async saveTokens(): Promise<void> {
			// Tokens for this config are written only by the GitLab connection
			// service (connect, refresh). Nothing the SDK obtains is stored on
			// the MCP config.
		},
		async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
			if (args.onAuthorizationRequired) {
				await args.onAuthorizationRequired(authorizationUrl);
				return;
			}
			throw args.authorizationRequired(authorizationUrl);
		},
		async saveCodeVerifier(): Promise<void> {},
		async codeVerifier(): Promise<string> {
			throw new Error(
				"GitLab connections are authorized through Fabric's connect flow",
			);
		},
		get redirectUrl(): string {
			return args.redirectUri;
		},
		get clientMetadata(): OAuthClientMetadata {
			return args.clientMetadata;
		},
		async clientInformation(): Promise<OAuthClientInformation | undefined> {
			return args.config.oauthClientId
				? { client_id: args.config.oauthClientId }
				: undefined;
		},
		async saveClientInformation(): Promise<void> {
			// Registration is managed by Fabric's MCP connect flow.
		},
		async invalidateCredentials(): Promise<void> {
			// Never clear the registration or the connection from here: the
			// registration may be the issuer of the person's GitLab credential,
			// and only the connection service decides the credential is dead.
		},
	};
}
