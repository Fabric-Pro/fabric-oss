/**
 * The GitLab personal connection service.
 *
 * A person's GitLab connection in one organization is ONE credential, held on
 * ONE row: their personal `WorkflowIntegration` (provider `GITLAB`, not the
 * `GITLAB_OAUTH_APP` client row, not workflow-scoped). Every writer and every
 * refresher of that credential goes through this module:
 *
 *   - `connectGitLab`             — a fresh grant or a PAT replaces the credential
 *   - `getGitLabConnectionToken`  — read (and refresh when due) the access token
 *   - `refreshGitLabConnection`   — the only refresh exchange
 *   - `classifyGitLabConnection`  — evidence-based issuer for a legacy row
 *   - `disconnectGitLabConnection` — the core of a personal disconnect
 *   - `patchGitLabConnectionSettings` — fenced settings writes (probe results)
 *
 * Three rules hold every operation together:
 *
 * 1. **Issuer identity.** The stored credential carries `issuer`: the OAuth
 *    client that actually issued it (app client id, or the MCP config whose
 *    dynamic client registration issued it) plus the GitLab origin. A refresh
 *    uses exactly that client against exactly that origin. If the client that
 *    is resolvable today has a different id, the refresh is refused as
 *    `client-unavailable` — never retried with another client, and never
 *    recorded as a dead grant.
 *
 * 2. **Lifecycle lock.** Every write takes one advisory lock per
 *    (user, organization) — `gitlabConnectionLockKey` — and re-reads the row
 *    under it, including `isActive` and the generation. Two first connects
 *    therefore cannot both create a row; the partial unique index
 *    `workflow_integration_personal_gitlab_key` backs that up in the
 *    database, and a create that still loses to it is retried once against
 *    the row that won (`retryOnPersonalRowConflict`).
 *
 * 3. **Generation fence.** `connectionGeneration` (inside the encrypted
 *    credential, so a settings-only writer cannot roll it back) increments on
 *    every connect, reconnect and disconnect. Refresh results, failure marks
 *    and OAuth-callback writes carry the generation they started from and
 *    drop their write when it moved.
 *
 * Two more rules apply at the module's edges:
 *
 * 4. **Legacy rows are classified first.** A connection row written before
 *    the credential recorded its issuer is given one from stored evidence
 *    (`classifyGitLabConnection`) — or marked reconnect-required when the
 *    evidence is ambiguous — before a token read, a refresh, a status read or
 *    a disconnect uses it. Classification only ever updates an existing row;
 *    it never creates one and never reads an MCP config's token columns.
 *
 * 5. **Origin.** A token is only for the GitLab instance that issued it.
 *    `getGitLabConnectionToken` refuses a non-gitlab.com credential
 *    (`unsupported-origin`) unless the caller passes `anyOrigin` and then
 *    sends the token only to `result.origin`.
 *
 * The `gitlab` / `gitlab-official` MCPConfig rows hold no token: migration
 * `20261004120000_gitlab_mcp_config_drop_token_copies` nulled the last legacy
 * copies. This module reads only their dynamic client registration (the
 * issuer of an `mcp-dcr` credential), writes only their breaker columns, and
 * on disconnect nulls their token columns again as a defence against a writer
 * outside this module.
 */

import {
	GITLAB_PERSONAL_MCP_SERVER_KEYS,
	type GitLabPersonalMcpServerKey,
	isGitLabPersonalMcpServerKey,
} from "@repo/database/prisma/queries/lib/gitlab-personal-keys";
import {
	gitlabConnectionLockKey,
	workflowIntegrationLockKey,
} from "@repo/database/prisma/queries/lib/refresh-lock-key";
import { decryptApiKey, encryptApiKey } from "@repo/utils";
import {
	GITLAB_TOKEN_EXCHANGE_TIMEOUT_MS,
	GitLabReauthRequiredError,
	type GitLabRefreshResponse,
	refreshGitLabToken,
} from "./oauth-refresh";
import {
	assertGitLabOrigin,
	credentialGitLabOrigin,
	GITLAB_DEFAULT_ORIGIN,
	gitlabOutboundFetch,
	parseGitLabOrigin,
	storedGitLabOrigin,
} from "./outbound";

export {
	GITLAB_PERSONAL_MCP_SERVER_KEYS,
	type GitLabPersonalMcpServerKey,
	isGitLabPersonalMcpServerKey,
};

export { GITLAB_DEFAULT_ORIGIN };

/** Refresh this long before the recorded expiry. */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

/**
 * The client that issued the stored credential — evidence, not a lookup
 * strategy. See rule 1 in the header.
 */
export type GitLabIssuer =
	| { kind: "app"; clientId: string; origin: string }
	| {
			kind: "mcp-dcr";
			mcpConfigId: string;
			serverKey: GitLabPersonalMcpServerKey;
			clientId: string;
			origin: string;
	  }
	| { kind: "pat"; origin: string };

export type GitLabTenant = {
	userId: string;
	organizationId: string | null;
};

export type GitLabAccount = {
	id: number;
	username: string;
	name: string | null;
	avatarUrl: string | null;
};

/** The decrypted shape of `WorkflowIntegration.credentials` for GitLab. */
export interface StoredGitLabCredential {
	access_token?: string;
	refresh_token?: string | null;
	token_type?: string;
	scope?: string;
	expires_in?: number;
	created_at?: number;
	token_obtained_at?: string;
	/** PAT shape written by the workflow-integration settings form. */
	GITLAB_ACCESS_TOKEN?: string;
	GITLAB_URL?: string;
	/** Older PAT shapes, and the older names of the instance address. */
	domain?: string;
	url?: string;
	token?: string;
	apiKey?: string;
	apiToken?: string;
	pat?: string;
	issuer?: GitLabIssuer;
	connectionGeneration?: number;
	/** Set (with every token field removed) by a disconnect. */
	disconnectedAt?: string;
}

// ---------------------------------------------------------------------------
// Structural database access. Satisfied by the Prisma client, by a Prisma
// transaction client, and by the in-memory fakes the tests use.
// ---------------------------------------------------------------------------

type Op = (args: never) => Promise<unknown>;

export interface GitLabConnectionDb {
	workflowIntegration: {
		findMany: Op;
		create: Op;
		update: Op;
		updateMany: Op;
	};
	mCPConfig: {
		findFirst: Op;
		/** The legacy adoption's API key copies (`connection-legacy-adoption.ts`). */
		findMany: Op;
		updateMany: Op;
	};
	projectRepositoryIntegration: {
		findMany: Op;
	};
}

export type GitLabConnectionLock = <T>(
	keys: readonly string[],
	fn: (
		tx: GitLabConnectionDb,
		assertBudget: (requiredMs: number) => void,
	) => Promise<T>,
) => Promise<T>;

export interface GitLabConnectionDeps {
	db: GitLabConnectionDb;
	withLock: GitLabConnectionLock;
	/** The token exchange; `refreshGitLabToken` in production. */
	exchange: typeof refreshGitLabToken;
	/**
	 * Revocation POST; `gitlabOutboundFetch` in production (the issuer's
	 * instance is user-supplied, so anything but gitlab.com goes through the
	 * outbound guard).
	 */
	fetchImpl: typeof fetch;
	now: () => number;
}

let defaultDepsPromise: Promise<GitLabConnectionDeps> | null = null;

/**
 * Production dependencies, resolved lazily so importing this module does not
 * open a database client (and so tests can substitute `@repo/database`).
 */
async function resolveDeps(
	overrides?: Partial<GitLabConnectionDeps>,
): Promise<GitLabConnectionDeps> {
	if (overrides?.db && overrides.withLock) {
		return {
			exchange: refreshGitLabToken,
			fetchImpl: gitlabOutboundFetch as typeof fetch,
			now: () => Date.now(),
			...overrides,
		} as GitLabConnectionDeps;
	}
	if (!defaultDepsPromise) {
		defaultDepsPromise = (async () => {
			const { db } = await import("@repo/database");
			const { withRefreshLock } = await import(
				"@repo/database/prisma/queries/lib/refresh-lock"
			);
			return {
				db: db as unknown as GitLabConnectionDb,
				withLock: ((keys, fn) =>
					withRefreshLock(keys, (tx, assertBudget) =>
						fn(tx as unknown as GitLabConnectionDb, assertBudget),
					)) as GitLabConnectionLock,
				exchange: refreshGitLabToken,
				fetchImpl: gitlabOutboundFetch as typeof fetch,
				now: () => Date.now(),
			};
		})().catch((error) => {
			defaultDepsPromise = null;
			throw error;
		});
	}
	const base = await defaultDepsPromise;
	return { ...base, ...overrides };
}

/** The service's dependencies, for sibling modules composing on it. */
export function resolveGitLabConnectionDeps(
	overrides?: Partial<GitLabConnectionDeps>,
): Promise<GitLabConnectionDeps> {
	return resolveDeps(overrides);
}

/** Test seam: drop the cached production dependencies. */
export function resetGitLabConnectionDepsForTests(): void {
	defaultDepsPromise = null;
}

// ---------------------------------------------------------------------------
// Rows and their parsed view
// ---------------------------------------------------------------------------

export interface GitLabConnectionRow {
	id: string;
	userId: string;
	organizationId: string | null;
	workflowId?: string | null;
	name: string;
	credentials: string;
	settings: unknown;
	isActive: boolean;
	createdAt?: Date | string;
	updatedAt?: Date | string;
}

export interface GitLabConnectionView {
	row: GitLabConnectionRow;
	credential: StoredGitLabCredential;
	accessToken: string | null;
	refreshToken: string | null;
	issuer: GitLabIssuer | null;
	generation: number;
	settings: Record<string, unknown>;
	needsReauth: boolean;
	/** A disconnect recorded by this service (never resurrected by classification). */
	disconnected: boolean;
	/**
	 * The stored credential could not be decrypted (for example an encryption
	 * key problem). Reported as a failure, never as "not connected", and never
	 * overwritten by classification: what it holds — including a disconnect — is
	 * unknown.
	 */
	unreadable: boolean;
	/** Recorded expiry in ms, or null when unknown. */
	expiresAtMs: number | null;
	/**
	 * The GitLab instance the credential belongs to. Empty when
	 * `originError` is set: the token must then go nowhere.
	 */
	origin: string;
	/**
	 * Why the recorded instance is refused (not https, embedded credentials,
	 * a loopback / private / link-local / metadata host, unparsable) — see
	 * `parseGitLabOrigin`. A refused instance is never replaced by gitlab.com.
	 */
	originError: string | null;
}

/**
 * The exclusive tenant filter for a person's GitLab connection rows. Never the
 * `GITLAB_OAUTH_APP` client row, never a workflow-scoped row.
 */
export function personalConnectionWhere(tenant: GitLabTenant) {
	const tenantFilter = tenant.organizationId
		? { organizationId: tenant.organizationId, userId: tenant.userId }
		: { organizationId: null, userId: tenant.userId };
	return {
		...tenantFilter,
		provider: "GITLAB" as const,
		workflowId: null,
		NOT: { name: "GITLAB_OAUTH_APP" },
	};
}

function toMs(value: Date | string | undefined | null): number {
	if (!value) {
		return 0;
	}
	const ms = value instanceof Date ? value.getTime() : Date.parse(value);
	return Number.isNaN(ms) ? 0 : ms;
}

/**
 * The canonical row among duplicates: active rows first, then the oldest,
 * then the lowest id. Built on fields this service never rewrites
 * (`createdAt`, `id`) so the choice cannot flip because a refresh touched one
 * row — and a disconnect deactivates every duplicate, so a stale active
 * duplicate can never become canonical behind the user's back.
 */
export function selectCanonicalConnection<T extends GitLabConnectionRow>(
	rows: readonly T[],
): T | null {
	if (rows.length === 0) {
		return null;
	}
	return [...rows].sort((a, b) => {
		if (a.isActive !== b.isActive) {
			return a.isActive ? -1 : 1;
		}
		const created = toMs(a.createdAt) - toMs(b.createdAt);
		if (created !== 0) {
			return created;
		}
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	})[0];
}

/** Lower-cased `scheme://host[:port]`, or null when unparsable. */
export function gitlabOriginOf(url: string | null | undefined): string | null {
	if (!url) {
		return null;
	}
	try {
		return new URL(url).origin.toLowerCase();
	} catch {
		return null;
	}
}

function parseCredential(ciphertext: string): {
	credential: StoredGitLabCredential;
	/** The stored ciphertext exists but could not be decrypted. */
	unreadable: boolean;
} {
	if (!ciphertext) {
		return { credential: {}, unreadable: false };
	}
	let plain: string;
	try {
		plain = decryptApiKey(ciphertext);
	} catch {
		return { credential: {}, unreadable: true };
	}
	try {
		const parsed = JSON.parse(plain) as unknown;
		if (typeof parsed === "object" && parsed !== null) {
			return {
				credential: parsed as StoredGitLabCredential,
				unreadable: false,
			};
		}
		return {
			credential:
				typeof parsed === "string"
					? { GITLAB_ACCESS_TOKEN: parsed }
					: {},
			unreadable: false,
		};
	} catch {
		// A raw token string stored without JSON — the oldest PAT shape.
		return {
			credential: plain ? { GITLAB_ACCESS_TOKEN: plain } : {},
			unreadable: false,
		};
	}
}

function credentialAccessToken(cred: StoredGitLabCredential): string | null {
	return (
		cred.access_token ||
		cred.GITLAB_ACCESS_TOKEN ||
		cred.token ||
		cred.apiKey ||
		cred.apiToken ||
		cred.pat ||
		null
	);
}

function isPatShape(cred: StoredGitLabCredential): boolean {
	return (
		!cred.access_token &&
		!cred.refresh_token &&
		Boolean(
			cred.GITLAB_ACCESS_TOKEN ||
				cred.token ||
				cred.apiKey ||
				cred.apiToken ||
				cred.pat,
		)
	);
}

function asSettings(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? { ...(value as Record<string, unknown>) }
		: {};
}

function recordedExpiryMs(
	cred: StoredGitLabCredential,
	settings: Record<string, unknown>,
): number | null {
	if (typeof settings.tokenExpiresAt === "string") {
		const ms = Date.parse(settings.tokenExpiresAt);
		if (!Number.isNaN(ms)) {
			return ms;
		}
	}
	if (cred.expires_in && cred.token_obtained_at) {
		const obtained = Date.parse(cred.token_obtained_at);
		if (!Number.isNaN(obtained)) {
			return obtained + cred.expires_in * 1000;
		}
	}
	return null;
}

export function viewConnection(row: GitLabConnectionRow): GitLabConnectionView {
	const { credential, unreadable } = parseCredential(row.credentials);
	const settings = asSettings(row.settings);
	const issuer = credential.issuer ?? null;
	// A present but refused address is an error, never gitlab.com.
	const checkedOrigin = storedGitLabOrigin(
		credential as Record<string, unknown>,
	);
	return {
		row,
		credential,
		accessToken: credentialAccessToken(credential),
		refreshToken: credential.refresh_token || null,
		issuer,
		generation:
			typeof credential.connectionGeneration === "number"
				? credential.connectionGeneration
				: 0,
		settings,
		needsReauth: settings.needsReauth === true,
		disconnected: Boolean(credential.disconnectedAt),
		unreadable,
		expiresAtMs: recordedExpiryMs(credential, settings),
		origin: checkedOrigin.ok ? checkedOrigin.origin : "",
		originError: checkedOrigin.ok ? null : checkedOrigin.reason,
	};
}

async function readRows(
	reader: GitLabConnectionDb,
	tenant: GitLabTenant,
): Promise<GitLabConnectionRow[]> {
	return (await reader.workflowIntegration.findMany({
		where: personalConnectionWhere(tenant),
	} as never)) as GitLabConnectionRow[];
}

export async function readGitLabConnection(
	reader: GitLabConnectionDb,
	tenant: GitLabTenant,
): Promise<GitLabConnectionView | null> {
	const row = selectCanonicalConnection(await readRows(reader, tenant));
	return row ? viewConnection(row) : null;
}

function lockKeys(tenant: GitLabTenant, rowId?: string | null): string[] {
	// The lifecycle key first, then the row key old-version refreshers take
	// (`wfint:<id>`), so a draining replica still serializes against us. Every
	// caller in this module takes them in this order.
	const keys = [
		gitlabConnectionLockKey(tenant.userId, tenant.organizationId),
	];
	if (rowId) {
		keys.push(workflowIntegrationLockKey(rowId));
	}
	return keys;
}

function encryptCredential(cred: StoredGitLabCredential): string {
	return encryptApiKey(JSON.stringify(cred));
}

/** A Prisma unique-constraint violation (`P2002`). */
function isUniqueViolation(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		(error as { code?: unknown }).code === "P2002"
	);
}

/**
 * Run one locked attempt that may create the person's connection row and,
 * when its create loses to the partial unique index on personal GitLab rows,
 * run it once more. Every writer in this module creates under the lifecycle
 * lock after re-reading, so only a writer that does not take that lock (an
 * old replica during a rolling deploy) can win the race. The losing attempt's
 * transaction rolls back as a whole, so the second attempt starts clean, and
 * its re-read under the lock finds the row that won and updates that row
 * instead. A second conflict is thrown: it is not this race.
 */
async function retryOnPersonalRowConflict<T>(
	attempt: () => Promise<T>,
): Promise<T> {
	try {
		return await attempt();
	} catch (error) {
		if (!isUniqueViolation(error)) {
			throw error;
		}
		return attempt();
	}
}

// ---------------------------------------------------------------------------
// Client resolution for an issuer
// ---------------------------------------------------------------------------

export type GitLabOAuthClient = { clientId: string; clientSecret: string };

/**
 * The integration OAuth app as resolvable right now: environment first, then
 * the tenant's stored `GITLAB_OAUTH_APP` rows (organization, then personal,
 * then the system-level row with no user and no organization).
 */
export async function resolveGitLabAppClient(
	reader: { workflowIntegration: { findMany: Op } },
	tenant: GitLabTenant,
): Promise<GitLabOAuthClient | null> {
	const envClientId = process.env.GITLAB_CLIENT_ID;
	const envClientSecret = process.env.GITLAB_CLIENT_SECRET;
	if (envClientId && envClientSecret) {
		return { clientId: envClientId, clientSecret: envClientSecret };
	}
	const candidates: Record<string, unknown>[] = [];
	if (tenant.organizationId) {
		candidates.push({
			organizationId: tenant.organizationId,
			provider: "GITLAB",
			name: "GITLAB_OAUTH_APP",
			isActive: true,
		});
	}
	candidates.push({
		userId: tenant.userId,
		organizationId: null,
		provider: "GITLAB",
		name: "GITLAB_OAUTH_APP",
		isActive: true,
	});
	candidates.push({
		userId: null,
		organizationId: null,
		provider: "GITLAB",
		name: "GITLAB_OAUTH_APP",
		isActive: true,
	});
	for (const where of candidates) {
		try {
			const rows = (await reader.workflowIntegration.findMany({
				where,
			} as never)) as Array<{ credentials: string }>;
			for (const row of rows) {
				try {
					const decrypted = JSON.parse(
						decryptApiKey(row.credentials),
					) as Record<string, string>;
					if (decrypted.client_id && decrypted.client_secret) {
						return {
							clientId: decrypted.client_id,
							clientSecret: decrypted.client_secret,
						};
					}
				} catch {
					// Undecryptable app row — try the next one.
				}
			}
		} catch {
			// Lookup failed — try the next scope.
		}
	}
	return null;
}

/**
 * A GitLab MCP config as this module reads it: its dynamic client
 * registration and its address. Never its token columns, which are null on
 * these rows (see the module header).
 */
type McpClientRow = {
	id: string;
	userId: string | null;
	organizationId: string | null;
	baseUrl: string | null;
	oauthClientId: string | null;
	encryptedOauthClientSecret: string | null;
	dcrClientMetadata: unknown;
	mcpServer?: { key?: string | null; defaultUrl?: string | null } | null;
};

const MCP_ROW_SELECT = {
	id: true,
	userId: true,
	organizationId: true,
	baseUrl: true,
	oauthClientId: true,
	encryptedOauthClientSecret: true,
	dcrClientMetadata: true,
	mcpServer: { select: { key: true, defaultUrl: true } },
};

/**
 * The MCP config row an issuer names by `id`, owned by exactly this person
 * in exactly this tenant context under this server key; a reference to a row
 * owned by anyone else, or under another server key, resolves to nothing.
 * The id is required: a person can own several configs under one key, so a
 * lookup without it would return an arbitrary one (`findOwnedMcpRows` reads
 * them all).
 */
async function findOwnedMcpRow(
	reader: GitLabConnectionDb,
	tenant: GitLabTenant,
	serverKey: GitLabPersonalMcpServerKey,
	id: string,
): Promise<McpClientRow | null> {
	const tenantFilter = tenant.organizationId
		? { organizationId: tenant.organizationId, userId: tenant.userId }
		: { organizationId: null, userId: tenant.userId };
	return (await reader.mCPConfig.findFirst({
		where: {
			id,
			...tenantFilter,
			mcpServer: { key: serverKey },
		},
		select: MCP_ROW_SELECT,
	} as never)) as McpClientRow | null;
}

/** Every MCP config row this person owns in this tenant under a server key. */
async function findOwnedMcpRows(
	reader: GitLabConnectionDb,
	tenant: GitLabTenant,
	serverKey: GitLabPersonalMcpServerKey,
): Promise<McpClientRow[]> {
	const tenantFilter = tenant.organizationId
		? { organizationId: tenant.organizationId, userId: tenant.userId }
		: { organizationId: null, userId: tenant.userId };
	return (await reader.mCPConfig.findMany({
		where: { ...tenantFilter, mcpServer: { key: serverKey } },
		select: MCP_ROW_SELECT,
	} as never)) as McpClientRow[];
}

function isPublicClient(metadata: unknown): boolean {
	return (
		typeof metadata === "object" &&
		metadata !== null &&
		(metadata as Record<string, unknown>).token_endpoint_auth_method ===
			"none"
	);
}

/**
 * The GitLab instance a GitLab MCP config points at: its own `baseUrl`, else
 * the server's default URL, else gitlab.com. Null when the address it names
 * is refused (`parseGitLabOrigin`) — a config pointing at a loopback,
 * private or metadata host is no GitLab instance a token may be sent to.
 */
export function mcpRowOrigin(row: {
	baseUrl: string | null;
	mcpServer?: { defaultUrl?: string | null } | null;
}): string | null {
	const named = row.baseUrl?.trim()
		? row.baseUrl
		: row.mcpServer?.defaultUrl?.trim()
			? row.mcpServer.defaultUrl
			: null;
	if (!named) {
		return GITLAB_DEFAULT_ORIGIN;
	}
	const checked = parseGitLabOrigin(named);
	return checked.ok ? checked.origin : null;
}

type ClientResolution =
	| { ok: true; client: GitLabOAuthClient }
	| { ok: false; message: string };

/**
 * The client named by `issuer`, if it is still the same client. A different
 * client id (the app was reconfigured, the DCR client was re-registered) is
 * NOT substituted: that is `client-unavailable`, which condemns nothing.
 */
async function resolveIssuerClient(
	reader: GitLabConnectionDb,
	tenant: GitLabTenant,
	issuer: GitLabIssuer,
): Promise<ClientResolution> {
	if (issuer.kind === "pat") {
		return {
			ok: false,
			message: "a personal access token is not refreshed",
		};
	}
	if (issuer.kind === "app") {
		const app = await resolveGitLabAppClient(reader, tenant);
		if (!app) {
			return {
				ok: false,
				message:
					"the GitLab OAuth app that issued this token is not configured",
			};
		}
		if (app.clientId !== issuer.clientId) {
			return {
				ok: false,
				message:
					"the configured GitLab OAuth app is not the one that issued this token",
			};
		}
		return { ok: true, client: app };
	}
	const row = await findOwnedMcpRow(
		reader,
		tenant,
		issuer.serverKey,
		issuer.mcpConfigId,
	);
	if (!row?.oauthClientId) {
		return {
			ok: false,
			message:
				"the MCP client registration that issued this token is gone",
		};
	}
	if (row.oauthClientId !== issuer.clientId) {
		return {
			ok: false,
			message:
				"the MCP client registration was replaced after this token was issued",
		};
	}
	if (isPublicClient(row.dcrClientMetadata)) {
		return {
			ok: true,
			client: { clientId: row.oauthClientId, clientSecret: "" },
		};
	}
	if (!row.encryptedOauthClientSecret) {
		return {
			ok: false,
			message: "the MCP client registration has no client secret",
		};
	}
	let clientSecret: string;
	try {
		clientSecret = decryptApiKey(row.encryptedOauthClientSecret);
	} catch {
		// A secret encrypted under a retired key, or corrupted: the client is
		// unusable, which is all this says — never a reason to fail the
		// caller (a disconnect must still commit its local cleanup).
		return {
			ok: false,
			message: "the MCP client registration's secret could not be read",
		};
	}
	return {
		ok: true,
		client: { clientId: row.oauthClientId, clientSecret },
	};
}

/**
 * Name the issuer of a token a caller just obtained with `clientId`, from the
 * clients this person can actually reach: the integration app when its id
 * matches, otherwise the person's own `gitlab` or `gitlab-official` MCP config
 * registered under that id. Falls back to an `app` issuer carrying the real
 * client id, which a later refresh reports as `client-unavailable` rather
 * than spending the grant with a different client.
 */
export async function identifyGitLabIssuer(
	tenant: GitLabTenant,
	args: { clientId: string; origin?: string | null },
	overrides?: Partial<GitLabConnectionDeps>,
): Promise<GitLabIssuer> {
	const deps = await resolveDeps(overrides);
	// A refused instance address throws (`GitLabOriginNotAllowedError`)
	// rather than being recorded — or replaced by gitlab.com.
	const origin = args.origin?.trim()
		? assertGitLabOrigin(args.origin)
		: GITLAB_DEFAULT_ORIGIN;
	const app = await resolveGitLabAppClient(deps.db, tenant);
	if (app && app.clientId === args.clientId) {
		return { kind: "app", clientId: args.clientId, origin };
	}
	// Every config the person owns under each key, not the first a query
	// returns: a person can have several, and the registration that issued
	// the grant may be on any of them. Several matching (the same client id
	// registered twice) resolve to the lowest id, deterministically.
	for (const serverKey of ["gitlab", "gitlab-official"] as const) {
		const row = (await findOwnedMcpRows(deps.db, tenant, serverKey))
			.filter((each) => each.oauthClientId === args.clientId)
			.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
		if (row) {
			return {
				kind: "mcp-dcr",
				mcpConfigId: row.id,
				serverKey,
				clientId: args.clientId,
				origin,
			};
		}
	}
	return { kind: "app", clientId: args.clientId, origin };
}

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------

function isDue(view: GitLabConnectionView, now: number): boolean {
	if (view.expiresAtMs === null) {
		// GitLab OAuth access tokens expire (~2h). Unknown expiry with a
		// refresh token forces one refresh, after which expiry is recorded; a
		// token without one (a PAT) is used as is.
		return Boolean(view.refreshToken);
	}
	return now >= view.expiresAtMs - REFRESH_BUFFER_MS;
}

function isPastExpiry(view: GitLabConnectionView, now: number): boolean {
	return view.expiresAtMs !== null && now >= view.expiresAtMs;
}

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------

export type ConnectGitLabInput = {
	accessToken: string;
	refreshToken: string | null;
	expiresAt: Date | null;
	scopes: string[];
	issuer: GitLabIssuer;
	account?: GitLabAccount | null;
	/**
	 * Whether the token comes from an authorization the person just completed
	 * (an OAuth code exchange, or a PAT they just entered). Only a fresh grant
	 * clears `needsReauth` — on the connection and on the breaker columns of
	 * the person's `gitlab` / `gitlab-official` MCP config rows.
	 */
	freshGrant: boolean;
	/** Extra settings to merge (e.g. capability probe results). */
	settingsPatch?: Record<string, unknown>;
	/**
	 * The generation the caller read before it started (an OAuth callback
	 * reads it before the code exchange). When the connection has moved since
	 * — a disconnect or another connect landed meanwhile — the write is
	 * dropped and `{ written: false }` returned.
	 */
	expectedGeneration?: number;
	/**
	 * Extra writes in the same transaction, after the connection is written
	 * (e.g. the capability sync of the `gitlab-official` MCPConfig). Receives
	 * the transaction client and the written connection's id.
	 */
	alsoInTransaction?: (
		tx: GitLabConnectionDb,
		written: { integrationId: string; generation: number },
	) => Promise<void>;
};

export type ConnectGitLabResult =
	| { written: true; integrationId: string; generation: number }
	| { written: false; reason: "stale"; generation: number };

const REAUTH_SETTINGS = [
	"needsReauth",
	"reauthReason",
	"lastRefreshFailedAt",
	"lastRefreshError",
] as const;

export async function connectGitLab(
	tenant: GitLabTenant,
	rawInput: ConnectGitLabInput,
	overrides?: Partial<GitLabConnectionDeps>,
): Promise<ConnectGitLabResult> {
	// The instance is checked before anything is written: a refused address
	// throws `GitLabOriginNotAllowedError` and is never recorded.
	const input: ConnectGitLabInput = {
		...rawInput,
		issuer: {
			...rawInput.issuer,
			origin: assertGitLabOrigin(rawInput.issuer.origin),
		},
	};
	const deps = await resolveDeps(overrides);
	return retryOnPersonalRowConflict(() => connectOnce(deps, tenant, input));
}

async function connectOnce(
	deps: GitLabConnectionDeps,
	tenant: GitLabTenant,
	input: ConnectGitLabInput,
): Promise<ConnectGitLabResult> {
	const preRow = selectCanonicalConnection(await readRows(deps.db, tenant));
	return deps.withLock(lockKeys(tenant, preRow?.id), async (tx) => {
		const rows = await readRows(tx, tenant);
		const current = selectCanonicalConnection(rows);
		const view = current ? viewConnection(current) : null;
		const generation = view?.generation ?? 0;
		if (
			input.expectedGeneration !== undefined &&
			generation !== input.expectedGeneration
		) {
			return {
				written: false as const,
				reason: "stale" as const,
				generation,
			};
		}
		const nextGeneration = generation + 1;
		const now = new Date(deps.now());
		const isPat = input.issuer.kind === "pat";
		const expiresInSeconds = input.expiresAt
			? Math.max(
					0,
					Math.round(
						(input.expiresAt.getTime() - now.getTime()) / 1000,
					),
				)
			: undefined;
		// Built from scratch: a PAT replacing an OAuth grant must not keep the
		// grant's refresh token or issuer, and vice versa.
		const credential: StoredGitLabCredential = isPat
			? {
					GITLAB_ACCESS_TOKEN: input.accessToken,
					GITLAB_URL: input.issuer.origin,
					access_token: input.accessToken,
					issuer: input.issuer,
					connectionGeneration: nextGeneration,
				}
			: {
					access_token: input.accessToken,
					refresh_token: input.refreshToken,
					token_type: "bearer",
					scope: input.scopes.join(" "),
					expires_in: expiresInSeconds,
					token_obtained_at: now.toISOString(),
					issuer: input.issuer,
					connectionGeneration: nextGeneration,
				};

		const settings: Record<string, unknown> = view
			? { ...view.settings }
			: {};
		for (const key of ["connectionState", "disconnectedAt"]) {
			delete settings[key];
		}
		if (input.freshGrant) {
			for (const key of REAUTH_SETTINGS) {
				delete settings[key];
			}
			// A new credential: the old tool-ingestion failure and capability
			// probe described the previous one (a caller that probed this one
			// passes the result in `settingsPatch`, applied below).
			delete settings.lastToolIngestError;
			delete settings.useOfficialMcp;
			delete settings.mcpProbe;
			settings.needsReauth = false;
		} else {
			settings.needsReauth = view?.needsReauth ?? false;
		}
		if (input.account) {
			settings.gitlabUserId = input.account.id;
			settings.gitlabUsername = input.account.username;
			settings.gitlabName = input.account.name;
			settings.gitlabAvatarUrl = input.account.avatarUrl;
		}
		settings.scope = input.scopes.join(" ");
		settings.scopes = input.scopes;
		settings.connectedAt = now.toISOString();
		settings.hasRefreshToken = !isPat && Boolean(input.refreshToken);
		settings.tokenExpiresAt = input.expiresAt
			? input.expiresAt.toISOString()
			: null;
		Object.assign(settings, input.settingsPatch ?? {});

		let integrationId: string;
		if (current) {
			await tx.workflowIntegration.update({
				where: { id: current.id },
				data: {
					credentials: encryptCredential(credential),
					settings,
					isActive: true,
				},
			} as never);
			integrationId = current.id;
		} else {
			const created = (await tx.workflowIntegration.create({
				data: {
					userId: tenant.userId,
					organizationId: tenant.organizationId,
					provider: "GITLAB",
					name: input.account?.username
						? `GitLab: ${input.account.username}`
						: "GitLab",
					credentials: encryptCredential(credential),
					settings,
					isActive: true,
				},
				select: { id: true },
			} as never)) as { id: string };
			integrationId = created.id;
		}

		if (input.freshGrant) {
			// Breaker columns only — never a token. A person who authorized a
			// new grant is no longer "awaiting reauthorization" anywhere their
			// GitLab connection is used.
			await tx.mCPConfig.updateMany({
				where: {
					...(tenant.organizationId
						? {
								organizationId: tenant.organizationId,
								userId: tenant.userId,
							}
						: { organizationId: null, userId: tenant.userId }),
					mcpServer: {
						key: { in: [...GITLAB_PERSONAL_MCP_SERVER_KEYS] },
					},
				},
				data: {
					needsReauth: false,
					status: "HEALTHY",
					refreshFailureCount: 0,
					lastRefreshFailedAt: null,
					lastRefreshError: null,
					consecutiveFailures: 0,
				},
			} as never);
		}

		await input.alsoInTransaction?.(tx, {
			integrationId,
			generation: nextGeneration,
		});

		return {
			written: true as const,
			integrationId,
			generation: nextGeneration,
		};
	});
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

export type GitLabRefreshFailureReason =
	| "not-connected"
	| "stale"
	| "needs-reauth"
	| "client-unavailable"
	| "no-refresh-token"
	| "transient";

export type GitLabRefreshOutcome =
	| { ok: true; accessToken: string; generation: number; refreshed: boolean }
	| {
			ok: false;
			reason: GitLabRefreshFailureReason;
			message: string;
			error?: unknown;
	  };

export type RefreshGitLabConnectionOptions = {
	/**
	 * The generation the caller read. A refresh that finds a different one
	 * returns `stale` without touching the provider: the connection the caller
	 * meant has been replaced or removed.
	 */
	expectedGeneration?: number;
	/**
	 * Refresh even though the recorded expiry is not due — used after GitLab
	 * answered 401 to `rejectedAccessToken`. Skipped when the stored token is
	 * no longer that one (someone else already refreshed).
	 */
	force?: boolean;
	rejectedAccessToken?: string;
};

const inFlightRefreshes = new Map<string, Promise<GitLabRefreshOutcome>>();

/**
 * The only refresh exchange for a personal GitLab connection. Never throws:
 * every outcome is a value, so a persisted `needsReauth` commits before the
 * caller sees the failure.
 *
 * A connection row written before credentials recorded their issuer is
 * classified first (rule 4), so the refresh knows which client to use.
 */
export async function refreshGitLabConnection(
	tenant: GitLabTenant,
	options: RefreshGitLabConnectionOptions = {},
	overrides?: Partial<GitLabConnectionDeps>,
): Promise<GitLabRefreshOutcome> {
	try {
		const deps = await resolveDeps(overrides);
		await classifyIfNeeded(deps, tenant, overrides);
	} catch (error) {
		return {
			ok: false,
			reason: "transient",
			message: "the GitLab connection could not be read",
			error,
		};
	}
	return refreshCoalesced(tenant, options, overrides);
}

/**
 * `refreshGitLabConnection` without the classification step, for a caller
 * that has already run it. Concurrent refreshes of the same connection with
 * the same options share one exchange.
 */
function refreshCoalesced(
	tenant: GitLabTenant,
	options: RefreshGitLabConnectionOptions,
	overrides?: Partial<GitLabConnectionDeps>,
): Promise<GitLabRefreshOutcome> {
	const flightKey = `${tenant.organizationId ?? "-"}:${tenant.userId}:${options.expectedGeneration ?? "*"}:${options.force ? (options.rejectedAccessToken ?? "force") : ""}`;
	const existing = inFlightRefreshes.get(flightKey);
	if (existing) {
		return existing;
	}
	const work = runRefresh(tenant, options, overrides).finally(() => {
		inFlightRefreshes.delete(flightKey);
	});
	inFlightRefreshes.set(flightKey, work);
	return work;
}

async function runRefresh(
	tenant: GitLabTenant,
	options: RefreshGitLabConnectionOptions,
	overrides?: Partial<GitLabConnectionDeps>,
): Promise<GitLabRefreshOutcome> {
	let deps: GitLabConnectionDeps;
	try {
		deps = await resolveDeps(overrides);
	} catch (error) {
		return {
			ok: false,
			reason: "transient",
			message: "dependencies unavailable",
			error,
		};
	}
	try {
		const preRow = selectCanonicalConnection(
			await readRows(deps.db, tenant),
		);
		return await deps.withLock(
			lockKeys(tenant, preRow?.id),
			async (tx, assertBudget): Promise<GitLabRefreshOutcome> => {
				const view = await readGitLabConnection(tx, tenant);
				if (!view || !view.row.isActive || !view.accessToken) {
					return {
						ok: false,
						reason: "not-connected",
						message: "GitLab is not connected",
					};
				}
				if (
					options.expectedGeneration !== undefined &&
					view.generation !== options.expectedGeneration
				) {
					return {
						ok: false,
						reason: "stale",
						message:
							"the GitLab connection changed while this refresh waited",
					};
				}
				if (view.needsReauth) {
					return {
						ok: false,
						reason: "needs-reauth",
						message:
							"the GitLab connection needs to be reconnected",
					};
				}
				if (view.originError) {
					// The refresh exchange would send the grant (and a client
					// secret) to that instance. Condemns nothing.
					return {
						ok: false,
						reason: "client-unavailable",
						message: `the GitLab instance recorded for this connection is not allowed (${view.originError})`,
					};
				}
				const now = deps.now();
				if (options.force) {
					if (
						options.rejectedAccessToken &&
						view.accessToken !== options.rejectedAccessToken
					) {
						// A winner refreshed while we waited — its token is the
						// answer, not a second exchange.
						return {
							ok: true,
							accessToken: view.accessToken,
							generation: view.generation,
							refreshed: false,
						};
					}
				} else if (!isDue(view, now)) {
					return {
						ok: true,
						accessToken: view.accessToken,
						generation: view.generation,
						refreshed: false,
					};
				}
				if (!view.refreshToken) {
					return {
						ok: false,
						reason: "no-refresh-token",
						message: "the GitLab token has no refresh token",
					};
				}
				if (!view.issuer) {
					return {
						ok: false,
						reason: "client-unavailable",
						message:
							"the client that issued this GitLab token is unknown; reconnect to record it",
					};
				}
				const client = await resolveIssuerClient(
					tx,
					tenant,
					view.issuer,
				);
				if (!client.ok) {
					return {
						ok: false,
						reason: "client-unavailable",
						message: client.message,
					};
				}
				assertBudget(GITLAB_TOKEN_EXCHANGE_TIMEOUT_MS);
				let refreshed: GitLabRefreshResponse;
				try {
					refreshed = await deps.exchange(
						view.refreshToken,
						client.client.clientId,
						client.client.clientSecret,
						{ baseUrl: view.origin },
					);
				} catch (error) {
					if (!(error instanceof GitLabReauthRequiredError)) {
						return {
							ok: false,
							reason: "transient",
							message:
								"the GitLab token refresh did not complete",
							error,
						};
					}
					await writeNeedsReauth(tx, view, deps, "invalid_grant");
					return {
						ok: false,
						reason: "needs-reauth",
						message: "GitLab rejected the stored grant",
						error,
					};
				}
				const obtainedAt = new Date(deps.now());
				const credential: StoredGitLabCredential = {
					...view.credential,
					access_token: refreshed.access_token,
					refresh_token: refreshed.refresh_token ?? view.refreshToken,
					token_type:
						refreshed.token_type ?? view.credential.token_type,
					scope: refreshed.scope ?? view.credential.scope,
					expires_in: refreshed.expires_in,
					created_at: refreshed.created_at,
					token_obtained_at: obtainedAt.toISOString(),
				};
				const written = (await tx.workflowIntegration.updateMany({
					// `isActive` guards against a deactivation by a writer that
					// does not take this lock (another provider surface).
					where: { id: view.row.id, isActive: true },
					data: {
						credentials: encryptCredential(credential),
						settings: {
							...view.settings,
							tokenExpiresAt: refreshed.expires_in
								? new Date(
										obtainedAt.getTime() +
											refreshed.expires_in * 1000,
									).toISOString()
								: null,
						},
					},
				} as never)) as { count: number };
				if (written.count === 0) {
					return {
						ok: false,
						reason: "not-connected",
						message:
							"the GitLab connection was disconnected during the refresh",
					};
				}
				return {
					ok: true,
					accessToken: refreshed.access_token,
					generation: view.generation,
					refreshed: true,
				};
			},
		);
	} catch (error) {
		// Lock budget exhausted, transaction timeout, database error: no
		// verdict about the grant.
		return {
			ok: false,
			reason: "transient",
			message: "the GitLab token refresh could not run",
			error,
		};
	}
}

async function writeNeedsReauth(
	tx: GitLabConnectionDb,
	view: GitLabConnectionView,
	deps: GitLabConnectionDeps,
	reason: string,
): Promise<void> {
	const settings = { ...view.settings };
	// Drop the cached capability probe with the credential that produced it.
	delete settings.useOfficialMcp;
	delete settings.mcpProbe;
	await tx.workflowIntegration.updateMany({
		where: { id: view.row.id, isActive: true },
		data: {
			settings: {
				...settings,
				needsReauth: true,
				reauthReason: reason,
				lastRefreshFailedAt: new Date(deps.now()).toISOString(),
			},
		},
	} as never);
}

// ---------------------------------------------------------------------------
// Read (with lazy classification and refresh)
// ---------------------------------------------------------------------------

/**
 * Whether a read should first classify the connection: an active row that
 * holds a token but no issuer, and is not already awaiting a reconnect. A
 * connection with an issuer — every connection written by `connectGitLab` —
 * never does, so the hot path of a healthy connection costs one query.
 */
function needsClassification(view: GitLabConnectionView | null): boolean {
	return Boolean(
		view?.row.isActive &&
			view.accessToken &&
			!view.issuer &&
			!view.needsReauth &&
			!view.disconnected &&
			!view.unreadable,
	);
}

async function classifyIfNeeded(
	deps: GitLabConnectionDeps,
	tenant: GitLabTenant,
	overrides?: Partial<GitLabConnectionDeps>,
): Promise<void> {
	if (!needsClassification(await readGitLabConnection(deps.db, tenant))) {
		return;
	}
	try {
		await classifyGitLabConnection(tenant, overrides);
	} catch (error) {
		// Classification only improves the read; it never fails it. An
		// unclassified connection still refuses to refresh (no issuer).
		console.error("[gitlab-connection] classification failed", {
			userId: tenant.userId,
			organizationId: tenant.organizationId,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

export type GitLabConnectionTokenResult =
	| {
			ok: true;
			accessToken: string;
			issuer: GitLabIssuer | null;
			origin: string;
			integrationId: string;
			generation: number;
			/** The connection row's settings as read (capability flags etc.). */
			settings: Record<string, unknown>;
	  }
	| {
			ok: false;
			reason:
				| Exclude<GitLabRefreshFailureReason, "stale">
				| "unsupported-origin";
			message: string;
			integrationId?: string;
			error?: unknown;
	  };

export type GetGitLabConnectionTokenOptions = {
	/**
	 * `lenient` (default): a refresh that failed for a non-terminal reason
	 * (transient, client-unavailable, no refresh token) hands back the
	 * current token. `strict`: the same, except a token past its recorded
	 * expiry is then a failure. Either way a refresh that found the
	 * connection disconnected or condemned is a failure.
	 */
	mode?: "lenient" | "strict";
	/**
	 * The caller sends the token only to `result.origin` (or checks the
	 * endpoint against it itself). Without it, a credential issued by any
	 * GitLab instance other than gitlab.com is refused as
	 * `unsupported-origin` before the token leaves this module — so a caller
	 * that still builds gitlab.com URLs can never hand a self-hosted
	 * credential to gitlab.com.
	 */
	anyOrigin?: boolean;
};

export async function getGitLabConnectionToken(
	tenant: GitLabTenant,
	options: GetGitLabConnectionTokenOptions = {},
	overrides?: Partial<GitLabConnectionDeps>,
): Promise<GitLabConnectionTokenResult> {
	const deps = await resolveDeps(overrides);
	await classifyIfNeeded(deps, tenant, overrides);
	for (let attempt = 0; attempt < 2; attempt++) {
		const view = await readGitLabConnection(deps.db, tenant);
		if (view?.row.isActive && view.unreadable) {
			return {
				ok: false,
				reason: "transient",
				message: "the stored GitLab credential could not be read",
				integrationId: view.row.id,
				error: new Error("GitLab credential could not be decrypted"),
			};
		}
		if (!view || !view.row.isActive || !view.accessToken) {
			return {
				ok: false,
				reason: "not-connected",
				message: "GitLab is not connected",
				integrationId: view?.row.id,
			};
		}
		const success = (accessToken: string, generation: number) => ({
			ok: true as const,
			accessToken,
			issuer: view.issuer,
			origin: view.origin,
			integrationId: view.row.id,
			generation,
			settings: view.settings,
		});
		if (view.needsReauth) {
			return {
				ok: false,
				reason: "needs-reauth",
				message: "the GitLab connection needs to be reconnected",
				integrationId: view.row.id,
			};
		}
		if (view.originError) {
			// The recorded instance is refused: the token goes nowhere, for
			// any caller — `anyOrigin` included.
			return {
				ok: false,
				reason: "unsupported-origin",
				message: `the GitLab instance recorded for this connection is not allowed (${view.originError})`,
				integrationId: view.row.id,
			};
		}
		if (
			!options.anyOrigin &&
			(gitlabOriginOf(view.origin) ?? view.origin) !==
				GITLAB_DEFAULT_ORIGIN
		) {
			return {
				ok: false,
				reason: "unsupported-origin",
				message:
					"this GitLab connection belongs to a GitLab instance this feature does not support",
				integrationId: view.row.id,
			};
		}
		const now = deps.now();
		if (!isDue(view, now)) {
			return success(view.accessToken, view.generation);
		}
		if (!view.refreshToken || view.issuer?.kind === "pat") {
			// Nothing to refresh with: the token is used as is, in either mode
			// (strict mode reports a refresh that FAILED, not one never tried).
			return success(view.accessToken, view.generation);
		}
		const outcome = await refreshCoalesced(
			tenant,
			{ expectedGeneration: view.generation },
			overrides,
		);
		if (outcome.ok) {
			return success(outcome.accessToken, outcome.generation);
		}
		if (outcome.reason === "stale") {
			continue;
		}
		// The refresh re-read the row under the lock. A connection it found
		// gone or condemned must not be answered with the token read before
		// it (the captured-token fallback that outlived a disconnect).
		const terminal =
			outcome.reason === "not-connected" ||
			outcome.reason === "needs-reauth";
		if (
			!terminal &&
			(options.mode !== "strict" || !isPastExpiry(view, deps.now()))
		) {
			// Still usable as far as this read can tell: hand it back; a 401
			// path can force a refresh bound to it. Logged with fixed fields
			// only — a provider error message can carry response text.
			console.warn(
				"[gitlab-connection] refresh failed; using current token",
				{
					userId: tenant.userId,
					organizationId: tenant.organizationId,
					integrationId: view.row.id,
					reason: outcome.reason,
					detail: outcome.message,
					errorName:
						outcome.error instanceof Error
							? outcome.error.name
							: undefined,
				},
			);
			return success(view.accessToken, view.generation);
		}
		return {
			ok: false,
			reason: outcome.reason,
			message: outcome.message,
			integrationId: view.row.id,
			error: outcome.error,
		};
	}
	return {
		ok: false,
		reason: "transient",
		message: "the GitLab connection kept changing while it was read",
	};
}

// ---------------------------------------------------------------------------
// Status (no refresh)
// ---------------------------------------------------------------------------

/**
 * The connection generation as of now. A connect flow reads it BEFORE its
 * code exchange and passes it to `connectGitLab` as `expectedGeneration`, so a
 * disconnect (or another connect) that lands during the exchange is not
 * overwritten. Classification never moves the generation, so this read does
 * not run it.
 */
export async function getGitLabConnectionGeneration(
	tenant: GitLabTenant,
	overrides?: Partial<GitLabConnectionDeps>,
): Promise<number> {
	const deps = await resolveDeps(overrides);
	const view = await readGitLabConnection(deps.db, tenant);
	return view?.generation ?? 0;
}

export type GitLabConnectionStatus = {
	connected: boolean;
	needsReauth: boolean;
	reauthReason?: string;
	issuerKind?: GitLabIssuer["kind"];
	origin?: string;
	tokenExpiresAt: string | null;
	hasRefreshToken: boolean;
	integrationId?: string;
	/** For fenced follow-up writes (`patchGitLabConnectionSettings`). */
	generation: number;
	settings: Record<string, unknown>;
};

export async function getGitLabConnectionStatus(
	tenant: GitLabTenant,
	overrides?: Partial<GitLabConnectionDeps>,
): Promise<GitLabConnectionStatus> {
	const deps = await resolveDeps(overrides);
	await classifyIfNeeded(deps, tenant, overrides);
	return statusOfView(await readGitLabConnection(deps.db, tenant));
}

/**
 * The connection's status exactly as stored, from one read: no
 * classification, no refresh, no other write. For reports, dry runs and reads
 * about a tenant other than the one a request acts in, which must not change
 * anything, and for a caller that needs only the status on a hot path (the
 * MCP client cache's reuse check, on every cached-client use).
 */
export async function readStoredGitLabConnectionStatus(
	tenant: GitLabTenant,
	overrides?: Partial<GitLabConnectionDeps>,
): Promise<GitLabConnectionStatus> {
	const deps = await resolveDeps(overrides);
	return statusOfView(await readGitLabConnection(deps.db, tenant));
}

function statusOfView(
	view: GitLabConnectionView | null,
): GitLabConnectionStatus {
	if (view?.row.isActive && view.unreadable) {
		// Present but unusable: ask for a reconnect rather than reporting the
		// person as never connected.
		return {
			connected: true,
			needsReauth: true,
			reauthReason: "credential-unreadable",
			tokenExpiresAt: null,
			hasRefreshToken: false,
			integrationId: view.row.id,
			generation: view.generation,
			settings: view.settings,
		};
	}
	if (!view || !view.row.isActive || !view.accessToken) {
		return {
			connected: false,
			needsReauth: false,
			tokenExpiresAt: null,
			hasRefreshToken: false,
			integrationId: view?.row.id,
			generation: view?.generation ?? 0,
			settings: view?.settings ?? {},
		};
	}
	return {
		connected: true,
		needsReauth: view.needsReauth,
		reauthReason:
			typeof view.settings.reauthReason === "string"
				? view.settings.reauthReason
				: undefined,
		issuerKind: view.issuer?.kind,
		origin: view.origin,
		tokenExpiresAt:
			view.expiresAtMs !== null
				? new Date(view.expiresAtMs).toISOString()
				: null,
		hasRefreshToken: Boolean(view.refreshToken),
		integrationId: view.row.id,
		generation: view.generation,
		settings: view.settings,
	};
}

/**
 * The person's usable GitLab connection, for code that only needs to know
 * whether a personal GitLab path is open (and which row backs it) without
 * reading a token yet. It reads the status `getGitLabConnectionStatus`
 * reports, so a legacy row without an issuer is classified first.
 *
 * Null when there is no connection or it needs reconnecting — callers treat
 * both as "not connected". A connection whose issuing client is no longer
 * available still counts: that only shows at refresh time, and the token read
 * that follows reports it as a token failure.
 */
export async function findUsableGitLabConnection(
	tenant: GitLabTenant,
	overrides?: Partial<GitLabConnectionDeps>,
): Promise<{ integrationId: string; origin: string | null } | null> {
	const status = await getGitLabConnectionStatus(tenant, overrides);
	if (!status.connected || status.needsReauth || !status.integrationId) {
		return null;
	}
	// `origin` is the instance the connection was issued by — null when the
	// recorded instance is not an allowed address (nothing may go there).
	return {
		integrationId: status.integrationId,
		origin: status.origin || null,
	};
}

// ---------------------------------------------------------------------------
// Fenced settings writes
// ---------------------------------------------------------------------------

/**
 * Merge `patch` into the connection's settings under the lifecycle lock, only
 * if the connection is still active at `expectedGeneration`. Returns whether
 * the write landed. For results computed from an earlier read (a capability
 * probe), so they cannot overwrite a newer connect, disconnect or reauth mark.
 */
export async function patchGitLabConnectionSettings(
	tenant: GitLabTenant,
	args: {
		expectedGeneration: number;
		patch: Record<string, unknown>;
		/** Keys to delete before merging. */
		remove?: string[];
		/** Extra writes in the same transaction, after the settings write. */
		alsoInTransaction?: (tx: GitLabConnectionDb) => Promise<void>;
	},
	overrides?: Partial<GitLabConnectionDeps>,
): Promise<boolean> {
	const deps = await resolveDeps(overrides);
	const preRow = selectCanonicalConnection(await readRows(deps.db, tenant));
	return deps.withLock(lockKeys(tenant, preRow?.id), async (tx) => {
		const view = await readGitLabConnection(tx, tenant);
		if (
			!view ||
			!view.row.isActive ||
			view.generation !== args.expectedGeneration
		) {
			return false;
		}
		const settings = { ...view.settings };
		for (const key of args.remove ?? []) {
			delete settings[key];
		}
		const patch = { ...args.patch };
		if (view.needsReauth) {
			// A reauth mark that landed after the caller's read wins over
			// any probe result computed from the now-dead credential.
			delete patch.useOfficialMcp;
			delete patch.mcpProbe;
		}
		await tx.workflowIntegration.update({
			where: { id: view.row.id },
			data: { settings: { ...settings, ...patch } },
		} as never);
		await args.alsoInTransaction?.(tx);
		return true;
	});
}

// ---------------------------------------------------------------------------
// Disconnect (core)
// ---------------------------------------------------------------------------

export type DisconnectGitLabResult = {
	/**
	 * Rows deactivated (every personal duplicate). Empty when the person had
	 * no connection row — the disconnect then only wrote its fence (an
	 * inactive tombstone), which is not reported here.
	 */
	integrationIds: string[];
	generation: number;
	/** Null when every revocation succeeded or none was needed. */
	revocationWarning: string | null;
};

/**
 * The transaction a disconnect's caller-supplied writes run in: the
 * service's own tables plus the person's GitLab Data Connections.
 */
export type GitLabDisconnectTx = GitLabConnectionDb & {
	dataConnection: { updateMany: Op };
};

export type DisconnectGitLabOptions = {
	/**
	 * Writes that belong to this disconnect, run inside its locked
	 * transaction after the service's own writes. They commit or roll back
	 * with the disconnect, and they cannot land after a reconnect that
	 * follows it: a reconnect takes the same lifecycle lock, so it either
	 * ran before this transaction (and this disconnect then supersedes it)
	 * or runs after these writes have committed. A write made after this
	 * function returns has neither guarantee.
	 */
	withinDisconnect?: (
		tx: GitLabDisconnectTx,
		outcome: { generation: number; integrationIds: string[] },
	) => Promise<void>;
};

/**
 * The core of a personal GitLab disconnect: under the lifecycle lock, bump the
 * generation, empty the credential and deactivate every personal row (or, with
 * no row at all, write an inactive tombstone carrying the generation); clear
 * the token columns of both GitLab MCP config rows (rows, `enabled` and DCR
 * registration are kept); then run the caller's `withinDisconnect` writes in
 * the same transaction. Revocation at GitLab runs after the commit, with the
 * issuer's own client, best effort. Project repository links are untouched.
 */
export async function disconnectGitLabConnection(
	tenant: GitLabTenant,
	overrides?: Partial<GitLabConnectionDeps>,
	options?: DisconnectGitLabOptions,
): Promise<DisconnectGitLabResult> {
	const deps = await resolveDeps(overrides);
	// A legacy row without an issuer is classified first, so the disconnect
	// below can revoke its grant with the client that issued it.
	await classifyIfNeeded(deps, tenant, overrides);
	const outcome = await retryOnPersonalRowConflict(async () => {
		const preRow = selectCanonicalConnection(
			await readRows(deps.db, tenant),
		);
		return deps.withLock(lockKeys(tenant, preRow?.id), async (tx) => {
			const rows = await readRows(tx, tenant);
			const views = rows.map(viewConnection);
			const generation =
				Math.max(0, ...views.map((each) => each.generation)) + 1;
			const disconnectedAt = new Date(deps.now()).toISOString();
			const revoke: Array<{
				token: string;
				issuer: GitLabIssuer | null;
			}> = [];
			for (const view of views) {
				if (view.row.isActive && view.accessToken) {
					revoke.push({
						token: view.accessToken,
						issuer: view.issuer,
					});
				}
				const settings = { ...view.settings };
				delete settings.useOfficialMcp;
				delete settings.mcpProbe;
				await tx.workflowIntegration.update({
					where: { id: view.row.id },
					data: {
						isActive: false,
						// "Empty" means no token of any kind: only the fence survives.
						credentials: encryptCredential({
							connectionGeneration: generation,
							disconnectedAt,
						}),
						settings: {
							...settings,
							connectionState: "disconnected",
							disconnectedAt,
							tokenExpiresAt: null,
							hasRefreshToken: false,
						},
					},
				} as never);
			}
			if (rows.length === 0) {
				// Nothing to deactivate, but the fence must still move: a
				// first connect that read generation 0 before this disconnect
				// (an OAuth callback mid-exchange) would otherwise find no row,
				// still see 0, and create an active connection after the
				// person disconnected. An inactive tombstone carrying the
				// bumped generation and the disconnect marker — no token of
				// any kind — makes that write stale. Classification never
				// touches it (a disconnected connection is left alone); a
				// fresh connect reuses it.
				await tx.workflowIntegration.create({
					data: {
						userId: tenant.userId,
						organizationId: tenant.organizationId,
						provider: "GITLAB",
						name: "GitLab",
						credentials: encryptCredential({
							connectionGeneration: generation,
							disconnectedAt,
						}),
						settings: {
							connectionState: "disconnected",
							disconnectedAt,
							tokenExpiresAt: null,
							hasRefreshToken: false,
						},
						isActive: false,
					},
					select: { id: true },
				} as never);
			}
			const tenantFilter = tenant.organizationId
				? {
						organizationId: tenant.organizationId,
						userId: tenant.userId,
					}
				: { organizationId: null, userId: tenant.userId };
			await tx.mCPConfig.updateMany({
				where: {
					...tenantFilter,
					mcpServer: {
						key: { in: [...GITLAB_PERSONAL_MCP_SERVER_KEYS] },
					},
				},
				data: {
					encryptedAccessToken: null,
					accessTokenHash: null,
					encryptedRefreshToken: null,
					tokenExpiresAt: null,
					// An API key stored on a GitLab config (a personal access
					// token saved there by an older release) is a GitLab
					// credential too, and goes with the connection.
					encryptedApiKey: null,
					needsReauth: true,
				},
			} as never);
			if (options?.withinDisconnect) {
				await options.withinDisconnect(tx as GitLabDisconnectTx, {
					generation,
					integrationIds: rows.map((row) => row.id),
				});
			}
			// Resolve the revocation clients while still holding the transaction
			// connection (reads only), so the HTTP calls after commit need no DB.
			const targets: Array<{
				token: string;
				origin: string;
				client: GitLabOAuthClient | null;
			}> = [];
			for (const each of revoke) {
				if (!each.issuer || each.issuer.kind === "pat") {
					continue;
				}
				// Revocation is best effort: a refused instance address or a
				// client that cannot be resolved (its secret unreadable, say)
				// skips it with the warning below — it never blocks the local
				// cleanup above from committing.
				const origin = parseGitLabOrigin(each.issuer.origin);
				let client: GitLabOAuthClient | null = null;
				if (origin.ok) {
					try {
						const resolved = await resolveIssuerClient(
							tx,
							tenant,
							each.issuer,
						);
						client = resolved.ok ? resolved.client : null;
					} catch (error) {
						console.error(
							"[gitlab-connection] revocation client unavailable",
							{
								userId: tenant.userId,
								organizationId: tenant.organizationId,
								error:
									error instanceof Error
										? error.message
										: String(error),
							},
						);
					}
				}
				targets.push({
					token: each.token,
					origin: origin.ok ? origin.origin : "",
					client,
				});
			}
			return {
				integrationIds: rows.map((row) => row.id),
				generation,
				targets,
			};
		});
	});

	let revocationWarning: string | null = null;
	for (const target of outcome.targets) {
		if (!target.client) {
			revocationWarning =
				"Local connection removed; GitLab-side revocation was skipped because the issuing OAuth client is no longer available — revoke the application at GitLab under User settings > Applications.";
			continue;
		}
		try {
			const body = new URLSearchParams({
				token: target.token,
				client_id: target.client.clientId,
			});
			if (target.client.clientSecret) {
				body.set("client_secret", target.client.clientSecret);
			}
			const response = await deps.fetchImpl(
				`${target.origin}/oauth/revoke`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/x-www-form-urlencoded",
					},
					body: body.toString(),
					signal: AbortSignal.timeout(
						GITLAB_TOKEN_EXCHANGE_TIMEOUT_MS,
					),
				},
			);
			if (!response.ok) {
				throw new Error(`Revocation returned ${response.status}`);
			}
		} catch (error) {
			revocationWarning =
				"Local connection removed; GitLab-side revocation failed — revoke the application at GitLab under User settings > Applications.";
			console.error("[gitlab-connection] revocation failed", {
				userId: tenant.userId,
				organizationId: tenant.organizationId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return {
		integrationIds: outcome.integrationIds,
		generation: outcome.generation,
		revocationWarning,
	};
}

// ---------------------------------------------------------------------------
// Classification of legacy connection rows
// ---------------------------------------------------------------------------

/** What classification decides from: stored evidence only. */
export type GitLabClassificationSnapshot = {
	rows: GitLabConnectionRow[];
	/** Plaintext access and refresh tokens of the tenant's GitLab repository links. */
	repositoryTokens: ReadonlySet<string>;
	appClientId: string | null;
};

export type GitLabClassificationPlan =
	| { action: "none"; reason: string }
	| { action: "classify"; rowId: string; issuer: GitLabIssuer }
	| {
			action: "reconnect-required";
			rowId: string;
			reason:
				| "shared-with-repository"
				| "issuer-unknown"
				| "origin-refused";
	  };

/** @internal Shared with `connection-legacy-adoption.ts`. */
export function decryptOrNull(value: string | null | undefined): string | null {
	if (!value) {
		return null;
	}
	try {
		return decryptApiKey(value);
	} catch {
		return null;
	}
}

/**
 * Decide, from stored evidence only, which client issued a connection row that
 * does not record one. Pure: no I/O, no exchange. Never guesses an issuer by
 * trying a refresh.
 */
export function planGitLabClassification(
	snapshot: GitLabClassificationSnapshot,
): GitLabClassificationPlan {
	const canonical = selectCanonicalConnection(snapshot.rows);
	const view = canonical ? viewConnection(canonical) : null;

	if (!view) {
		return { action: "none", reason: "no connection" };
	}
	if (view.disconnected) {
		return { action: "none", reason: "disconnected by the user" };
	}
	if (view.unreadable) {
		return { action: "none", reason: "stored credential unreadable" };
	}
	if (!view.row.isActive || !view.accessToken) {
		return { action: "none", reason: "inactive or holds no token" };
	}
	if (view.issuer) {
		return { action: "none", reason: "already has an issuer" };
	}
	if (view.needsReauth) {
		return { action: "none", reason: "already awaiting reconnect" };
	}
	// The instance the legacy credential names, across every historical field
	// (`GITLAB_URL`, `domain`, `url`). A named but refused address is not
	// classified onto gitlab.com: the person re-enters it.
	const named = credentialGitLabOrigin(
		view.credential as Record<string, unknown>,
	);
	if (named.present && !named.ok) {
		return {
			action: "reconnect-required",
			rowId: view.row.id,
			reason: "origin-refused",
		};
	}
	const credentialOrigin = named.present
		? (named as { origin: string }).origin
		: GITLAB_DEFAULT_ORIGIN;
	if (isPatShape(view.credential)) {
		return {
			action: "classify",
			rowId: view.row.id,
			issuer: { kind: "pat", origin: credentialOrigin },
		};
	}
	if (
		snapshot.repositoryTokens.has(view.accessToken) ||
		(view.refreshToken && snapshot.repositoryTokens.has(view.refreshToken))
	) {
		return {
			action: "reconnect-required",
			rowId: view.row.id,
			reason: "shared-with-repository",
		};
	}
	if (!view.refreshToken) {
		// A bare access token: never refreshed by anyone, used as is.
		return {
			action: "classify",
			rowId: view.row.id,
			issuer: { kind: "pat", origin: credentialOrigin },
		};
	}
	// The integration app is gitlab.com's: a grant naming another instance
	// was not issued by it.
	if (snapshot.appClientId && credentialOrigin === GITLAB_DEFAULT_ORIGIN) {
		return {
			action: "classify",
			rowId: view.row.id,
			issuer: {
				kind: "app",
				clientId: snapshot.appClientId,
				origin: GITLAB_DEFAULT_ORIGIN,
			},
		};
	}
	return {
		action: "reconnect-required",
		rowId: view.row.id,
		reason: "issuer-unknown",
	};
}

async function loadRepositoryTokens(
	reader: GitLabConnectionDb,
	tenant: GitLabTenant,
): Promise<Set<string>> {
	const rows = (await reader.projectRepositoryIntegration.findMany({
		where: {
			provider: "GITLAB",
			project: tenant.organizationId
				? { organizationId: tenant.organizationId }
				: { organizationId: null },
		},
		select: { encryptedAccessToken: true, encryptedRefreshToken: true },
	} as never)) as Array<{
		encryptedAccessToken: string | null;
		encryptedRefreshToken: string | null;
	}>;
	const tokens = new Set<string>();
	for (const row of rows) {
		for (const value of [
			row.encryptedAccessToken,
			row.encryptedRefreshToken,
		]) {
			const plain = decryptOrNull(value);
			if (plain) {
				tokens.add(plain);
			}
		}
	}
	return tokens;
}

/**
 * The evidence classification decides from. The repository links and the app
 * client are loaded only when the canonical row actually needs classifying.
 *
 * @internal Shared with `connection-legacy-adoption.ts`.
 */
export async function loadGitLabClassificationSnapshot(
	reader: GitLabConnectionDb,
	tenant: GitLabTenant,
): Promise<GitLabClassificationSnapshot> {
	const rows = await readRows(reader, tenant);
	const canonical = selectCanonicalConnection(rows);
	const needsEvidence = Boolean(
		canonical?.isActive && !viewConnection(canonical).issuer,
	);
	const [repositoryTokens, app] = needsEvidence
		? await Promise.all([
				loadRepositoryTokens(reader, tenant),
				resolveGitLabAppClient(reader, tenant),
			])
		: [new Set<string>(), null];
	return {
		rows,
		repositoryTokens,
		appClientId: app?.clientId ?? null,
	};
}

/**
 * Write a `classify` or `reconnect-required` plan to its row, inside the
 * caller's locked transaction. Returns the row written, or null when the row
 * is gone. The generation is kept: classification records what is already
 * true of the credential, it does not replace it.
 *
 * @internal Shared with `connection-legacy-adoption.ts`.
 */
export async function applyGitLabClassification(
	tx: GitLabConnectionDb,
	snapshot: GitLabClassificationSnapshot,
	// The legacy adoption planner adds its own reconnect reason, so the
	// reason is any string here.
	plan:
		| Extract<GitLabClassificationPlan, { action: "classify" }>
		| { action: "reconnect-required"; rowId: string; reason: string },
): Promise<string | null> {
	const row = snapshot.rows.find((each) => each.id === plan.rowId);
	if (!row) {
		return null;
	}
	const view = viewConnection(row);
	if (plan.action === "classify") {
		await tx.workflowIntegration.update({
			where: { id: row.id },
			data: {
				credentials: encryptCredential({
					...view.credential,
					issuer: plan.issuer,
					connectionGeneration: view.generation,
				}),
			},
		} as never);
		return row.id;
	}
	await tx.workflowIntegration.update({
		where: { id: row.id },
		data: {
			settings: {
				...view.settings,
				needsReauth: true,
				reauthReason: plan.reason,
			},
		},
	} as never);
	return row.id;
}

export type GitLabClassificationResult = {
	plan: GitLabClassificationPlan;
	applied: boolean;
	integrationId?: string;
};

/**
 * Give a connection row that records no issuer one, from stored evidence, or
 * mark it reconnect-required when the evidence is ambiguous — idempotently.
 * The plan is decided twice: once without the lock (so a person with nothing
 * to classify never takes it) and again under it, where it is applied. Only
 * ever updates the existing row: it never creates one.
 */
export async function classifyGitLabConnection(
	tenant: GitLabTenant,
	overrides?: Partial<GitLabConnectionDeps>,
	options: { dryRun?: boolean } = {},
): Promise<GitLabClassificationResult> {
	const deps = await resolveDeps(overrides);
	const preSnapshot = await loadGitLabClassificationSnapshot(deps.db, tenant);
	const prePlan = planGitLabClassification(preSnapshot);
	if (prePlan.action === "none" || options.dryRun) {
		return { plan: prePlan, applied: false };
	}
	const preRow = selectCanonicalConnection(preSnapshot.rows);
	return deps.withLock(lockKeys(tenant, preRow?.id), async (tx) => {
		const snapshot = await loadGitLabClassificationSnapshot(tx, tenant);
		const plan = planGitLabClassification(snapshot);
		if (plan.action === "none") {
			return { plan, applied: false };
		}
		const written = await applyGitLabClassification(tx, snapshot, plan);
		return written
			? { plan, applied: true, integrationId: written }
			: { plan, applied: false };
	});
}

/**
 * @internal Shared with `connection-legacy-adoption.ts`: the person's
 * personal connection rows, and the lock keys every writer takes for them.
 */
export const gitlabConnectionInternals = {
	readRows,
	lockKeys,
	encryptCredential,
	toMs,
	isPatShape,
};
