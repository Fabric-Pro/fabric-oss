/**
 * The one place that writes an MCP config's OAuth credential columns.
 *
 * An MCP server must never be able to make Fabric send a stored refresh
 * token, client secret or authorization code to an authorization server (AS)
 * of the MCP server's choosing. Two rules enforce that:
 *
 * 1. **Binding.** Every credential set is pinned to the AS that issued it
 *    (`mcp_config."oauthBinding"`). The binding is written only by the
 *    interactive connect flow (from the AS it registered the client with or
 *    exchanged the code at), from the catalog, or by the migration backfill.
 *    A refresh posts only to `binding.tokenEndpoint`; nothing ever re-asks
 *    the MCP server where to send credentials. An unbound config never
 *    refreshes.
 * 2. **Grant generation.** `mcp_config."oauthGrantGeneration"` fences every
 *    write. Registration replacement, a new grant and every token wipe
 *    increment it; a refresh write is a compare-and-set on the generation and
 *    the refresh-token ciphertext actually spent, so a refresh that started
 *    before a revoke, re-registration or reconnect can never restore the old
 *    tokens.
 *
 * Writers outside `@repo/database` call these functions; none of them writes
 * the client, token or binding columns directly.
 */

import { db, Prisma } from "../client";
import type { MCPStatus } from "../zod";
import {
	bearerOnlyOAuthMarker,
	isStoredMcpOAuthClientTrusted,
	type McpOAuthBearerOnly,
	type McpOAuthBinding,
	type McpOAuthStoredCredentials,
	mayStoredMcpOAuthClientFollow,
	parseMcpOAuthBinding,
	withCredentialFingerprint,
} from "./lib/mcp-oauth-binding";

export * from "./lib/mcp-oauth-binding";

// =============================================================================
// Writes
// =============================================================================

export type McpOAuthTenantGuard = {
	userId: string;
	organizationId: string | null;
};

export type McpOAuthTokenSet = {
	encryptedAccessToken: string;
	/** `hashApiKey(plaintext access token)`. */
	accessTokenHash: string;
	encryptedRefreshToken: string | null;
	tokenExpiresAt: Date | null;
};

/** A hand-imported token set: any part may be absent. */
export type McpOAuthImportedTokens = {
	encryptedAccessToken: string | null;
	accessTokenHash: string | null;
	encryptedRefreshToken: string | null;
	tokenExpiresAt: Date | null;
};

export type McpOAuthClientRegistration = {
	oauthClientId: string;
	encryptedOauthClientSecret: string | null;
	/** Already allowlisted (`allowlistDcrClientMetadata`), or null. */
	dcrClientMetadata: Record<string, unknown> | null;
	dcrRegistrationEndpoint: string | null;
	dcrRegisteredAt: Date | null;
};

export type McpOAuthWriteResult = {
	written: boolean;
	/** The config's generation after the write; null when nothing was written. */
	generation: number | null;
	/** The row as this write left it; null when nothing was written. */
	config: McpOAuthWrittenConfig | null;
};

const CLEARED_TOKENS = {
	encryptedAccessToken: null,
	accessTokenHash: null,
	encryptedRefreshToken: null,
	tokenExpiresAt: null,
} as const;

// A function, not a constant: `Prisma` is read at call time, so importing
// this module never touches the client.
function clearedClient() {
	return {
		oauthClientId: null,
		encryptedOauthClientSecret: null,
		dcrClientMetadata: Prisma.DbNull,
		dcrRegistrationEndpoint: null,
		dcrRegisteredAt: null,
	} as const;
}

/** What a fresh, working grant resets: the refresh circuit breaker. */
const BREAKER_RESET = {
	status: "HEALTHY" as MCPStatus,
	needsReauth: false,
	refreshFailureCount: 0,
	lastRefreshFailedAt: null,
	lastRefreshError: null,
	consecutiveFailures: 0,
} as const;

/**
 * The access token a config held when the caller read it (at the
 * `expectedGeneration` it passes). An import compares against this, and the
 * write is fenced on the same stored access-token ciphertext, so the
 * comparison is against exactly the token the row still holds when the write
 * lands.
 */
export type McpOAuthStoredAccessToken = {
	encryptedAccessToken: string | null;
	/** `hashApiKey(plaintext)`: an HMAC, the same for the same token. */
	accessTokenHash: string | null;
	tokenExpiresAt: Date | null;
};

/**
 * How an imported access token reached the server. Only a token supplied as
 * PLAINTEXT in the request (and encrypted and hashed by the server now) can
 * be a new grant. A token supplied as ciphertext — the shape `configs.list`
 * returns — is at best a copy of something already stored, so it never
 * counts as one. Passed explicitly by the caller, never inferred.
 */
export type McpOAuthImportSource = "plaintext" | "ciphertext";

/**
 * Whether a plaintext-imported access token is the token the config already
 * holds: `true`, `false`, or `null` when that cannot be established (which
 * counts as "not new"). Compared by the deterministic `accessTokenHash`; a
 * stored row without one is decrypted and hashed for the comparison, and a
 * stored ciphertext that cannot be decrypted is `null`.
 */
async function isStoredAccessToken(
	tokens: McpOAuthImportedTokens,
	stored: McpOAuthStoredAccessToken,
): Promise<boolean | null> {
	if (!stored.encryptedAccessToken) {
		return false;
	}
	if (tokens.encryptedAccessToken === stored.encryptedAccessToken) {
		return true;
	}
	if (!tokens.accessTokenHash) {
		return null;
	}
	if (stored.accessTokenHash) {
		return tokens.accessTokenHash === stored.accessTokenHash;
	}
	try {
		const { decryptApiKey, hashApiKey } = await import("@repo/utils");
		return (
			hashApiKey(decryptApiKey(stored.encryptedAccessToken)) ===
			tokens.accessTokenHash
		);
	} catch {
		return null;
	}
}

/**
 * What writing a hand-imported token set does to the breaker and the expiry.
 *
 * - Only an access token supplied as PLAINTEXT in this request, that differs
 *   from the stored token (see `isStoredAccessToken`), has a hash and has not
 *   expired, is a new grant: the same write resets the refresh circuit
 *   breaker, as the callback's new grant does.
 * - Everything else — a ciphertext import (whatever is stored, including
 *   nothing: a cleared row cannot be "re-filled" with a replayed ciphertext),
 *   the stored token re-submitted as plaintext, an unidentifiable or expired
 *   token, no access token — resets nothing, and keeps a known stored expiry
 *   (an import cannot erase or extend it; a stored null takes the caller's
 *   value).
 *
 * Deliberate limit: a person who holds the plaintext of their own expired
 * token can clear it and import it again as plaintext, which reads as a new
 * grant. They own the config and could reconnect anyway; the MCP server
 * rejects the token, and nothing is sent to any untrusted server.
 */
async function importedGrantEffect(
	tokens: McpOAuthImportedTokens | null | undefined,
	stored: McpOAuthStoredAccessToken | undefined,
	source: McpOAuthImportSource,
	now: Date = new Date(),
): Promise<{ resetBreaker: boolean; tokenExpiresAt?: Date | null }> {
	if (!tokens?.encryptedAccessToken) {
		return { resetBreaker: false };
	}
	const keptExpiry = {
		resetBreaker: false,
		tokenExpiresAt: stored?.tokenExpiresAt ?? tokens.tokenExpiresAt,
	};
	if (source !== "plaintext" || !stored) {
		return keptExpiry;
	}
	if ((await isStoredAccessToken(tokens, stored)) !== false) {
		return keptExpiry;
	}
	const usable =
		!!tokens.accessTokenHash &&
		(tokens.tokenExpiresAt === null || tokens.tokenExpiresAt > now);
	return { resetBreaker: usable };
}

/** The write's token and breaker columns for an imported set. */
async function importedTokenData(
	tokens: McpOAuthImportedTokens | null | undefined,
	stored: McpOAuthStoredAccessToken | undefined,
	source: McpOAuthImportSource,
) {
	const effect = await importedGrantEffect(tokens, stored, source);
	return {
		...tokenData(tokens),
		...(effect.tokenExpiresAt !== undefined
			? { tokenExpiresAt: effect.tokenExpiresAt }
			: {}),
		...(effect.resetBreaker ? BREAKER_RESET : {}),
	};
}

/** Fence on the stored access token the caller compared against. */
function storedTokenWhere(stored: McpOAuthStoredAccessToken | undefined) {
	return stored ? { encryptedAccessToken: stored.encryptedAccessToken } : {};
}

function tenantWhere(tenant?: McpOAuthTenantGuard) {
	if (!tenant) {
		return {};
	}
	return tenant.organizationId
		? { organizationId: tenant.organizationId, userId: tenant.userId }
		: { organizationId: null, userId: tenant.userId };
}

/** The client columns a write leaves as they are (and is fenced on). */
export type McpOAuthStoredClient = {
	oauthClientId: string | null;
	encryptedOauthClientSecret: string | null;
};

function clientWhere(client: McpOAuthStoredClient) {
	return {
		oauthClientId: client.oauthClientId,
		encryptedOauthClientSecret: client.encryptedOauthClientSecret,
	};
}

/**
 * A binding as stored beside the credential columns a write leaves behind:
 * a real binding carries their fingerprint (`credentialFingerprint`), which
 * only this module writes; bearer-only and null are unchanged. With
 * `trusted: false` (a kept client that no longer matched its binding) the
 * binding is written with no fingerprint, so it matches nothing and nothing
 * is sent until the connect flow writes a client again.
 */
function bindingFor(
	binding: McpOAuthBinding | McpOAuthBearerOnly | null,
	client: McpOAuthStoredClient | null,
	encryptedRefreshToken: string | null,
	trusted = true,
): McpOAuthBinding | McpOAuthBearerOnly | null {
	if (!binding || "mode" in binding) {
		return binding;
	}
	if (!trusted) {
		const { credentialFingerprint: _stale, ...unfingerprinted } = binding;
		return unfingerprinted;
	}
	return withCredentialFingerprint(binding, {
		oauthClientId: client?.oauthClientId ?? null,
		encryptedOauthClientSecret: client?.encryptedOauthClientSecret ?? null,
		encryptedRefreshToken,
	});
}

/**
 * The binding a write that KEEPS the stored client may store: `binding`
 * itself when the kept client may follow it (`mayStoredMcpOAuthClientFollow`
 * — same AS and token endpoint as its verified binding, or a public client),
 * otherwise nothing that could ever send it: bearer-only when tokens are
 * written with it, no binding when none are.
 */
function bindingForKeptClient(
	binding: McpOAuthBinding | McpOAuthBearerOnly | null,
	kept: McpOAuthStoredCredentials,
	writesTokens: boolean,
): McpOAuthBinding | McpOAuthBearerOnly | null {
	if (!binding || "mode" in binding) {
		return binding;
	}
	if (mayStoredMcpOAuthClientFollow(kept, binding)) {
		return binding;
	}
	return writesTokens ? bearerOnlyOAuthMarker() : null;
}

function bindingJson(binding: McpOAuthBinding | McpOAuthBearerOnly | null) {
	return binding === null
		? Prisma.DbNull
		: (binding as unknown as Prisma.InputJsonValue);
}

function clientData(client: McpOAuthClientRegistration | null) {
	if (client === null) {
		return clearedClient();
	}
	return {
		oauthClientId: client.oauthClientId,
		encryptedOauthClientSecret: client.encryptedOauthClientSecret,
		dcrClientMetadata:
			client.dcrClientMetadata === null
				? Prisma.DbNull
				: (client.dcrClientMetadata as Prisma.InputJsonValue),
		dcrRegistrationEndpoint: client.dcrRegistrationEndpoint,
		dcrRegisteredAt: client.dcrRegisteredAt,
	};
}

function tokenData(
	tokens: McpOAuthTokenSet | McpOAuthImportedTokens | null | undefined,
) {
	if (!tokens) {
		return CLEARED_TOKENS;
	}
	return {
		encryptedAccessToken: tokens.encryptedAccessToken,
		accessTokenHash: tokens.accessTokenHash,
		encryptedRefreshToken: tokens.encryptedRefreshToken,
		tokenExpiresAt: tokens.tokenExpiresAt,
	};
}

/**
 * `accessTokenHash` is uniquely indexed; a P2002 on it is a real bug (token
 * reuse, duplicated row), so it is surfaced loudly rather than swallowed.
 */
function rethrowTokenConflict(error: unknown, configId: string): never {
	if (
		error instanceof Prisma.PrismaClientKnownRequestError &&
		error.code === "P2002"
	) {
		const wrapped = new Error(
			`MCPConfig token write conflicted on a unique constraint for configId=${configId}: ${error.message}`,
		);
		(wrapped as { cause?: unknown }).cause = error;
		throw wrapped;
	}
	throw error;
}

/** The config row a credential write returns: what it wrote, as written. */
export type McpOAuthWrittenConfig = Prisma.MCPConfigGetPayload<{
	include: { mcpServer: true };
}>;

/** A database client: the default one, or an interactive transaction's. */
type DbClient = Pick<typeof db, "mCPConfig">;

/**
 * One conditional, generation-incrementing write. Returns the row exactly as
 * written (so a caller never re-reads and adopts someone else's write), or
 * null when no row matched the guard.
 */
async function writeIncrementingGeneration(
	configId: string,
	where: Prisma.MCPConfigWhereInput,
	data: Prisma.MCPConfigUpdateInput,
	client: DbClient = db,
): Promise<McpOAuthWrittenConfig | null> {
	try {
		return await client.mCPConfig.update({
			// `id` makes it unique; the remaining filters make it conditional
			// (Prisma reports P2025 when they do not match).
			where: {
				...where,
				id: configId,
			} as Prisma.MCPConfigWhereUniqueInput,
			data: { ...data, oauthGrantGeneration: { increment: 1 } },
			include: { mcpServer: true },
		});
	} catch (error) {
		if (
			error instanceof Prisma.PrismaClientKnownRequestError &&
			error.code === "P2025"
		) {
			return null;
		}
		return rethrowTokenConflict(error, configId);
	}
}

function writeResult(row: McpOAuthWrittenConfig | null): McpOAuthWriteResult {
	return row
		? { written: true, generation: row.oauthGrantGeneration, config: row }
		: { written: false, generation: null, config: null };
}

/**
 * Replace a config's client registration (a new client, or `client: null` to
 * remove it), in one statement: writes the client and the binding of the AS
 * it belongs to (or `null` when that is not known yet), clears the tokens —
 * a grant belongs to the client that obtained it — unless `tokens` imports a
 * new set, and increments the generation. An imported set holding a new,
 * usable access token supplied as plaintext resets the refresh circuit
 * breaker in the same write (`importedGrantEffect`); a ciphertext import,
 * re-submitting the stored token or clearing the tokens never lifts it.
 *
 * Conditional on `expectedGeneration` (what the caller read) and, with
 * `tenant`, on the owner's row. Returns the row as written; a caller must use
 * it rather than re-reading, which could adopt a concurrent registration.
 */
export async function replaceMcpOAuthRegistration(args: {
	configId: string;
	client: McpOAuthClientRegistration | null;
	/** Or, with imported tokens no AS may be trusted for, bearer-only. */
	binding: McpOAuthBinding | McpOAuthBearerOnly | null;
	tokens?: McpOAuthImportedTokens | null;
	/**
	 * The access token the caller read with `expectedGeneration`; required
	 * for imported tokens to reset the breaker (see `importedGrantEffect`).
	 */
	storedAccessToken?: McpOAuthStoredAccessToken;
	/**
	 * How the imported access token arrived. Omitted, it is treated as
	 * `"ciphertext"`: never a new grant.
	 */
	accessTokenSource?: McpOAuthImportSource;
	/**
	 * The generation the caller read the config at. Required: every
	 * replacement is derived from a read, and must not land on a config that
	 * changed since (a newer grant, revoke or registration).
	 */
	expectedGeneration: number;
	/**
	 * Set when `client` is the client already stored, kept (as read with
	 * `expectedGeneration`) rather than a new registration or one just
	 * entered. It is then fingerprinted under `binding` only when it may
	 * follow it (`bindingForKeptClient`), and the write is fenced on it.
	 */
	keptClient?: McpOAuthStoredCredentials;
	tenant?: McpOAuthTenantGuard;
	/** An interactive transaction to write in. */
	tx?: DbClient;
}): Promise<McpOAuthWriteResult> {
	const binding = args.keptClient
		? bindingForKeptClient(args.binding, args.keptClient, !!args.tokens)
		: args.binding;
	const row = await writeIncrementingGeneration(
		args.configId,
		{
			...tenantWhere(args.tenant),
			oauthGrantGeneration: args.expectedGeneration,
			...storedTokenWhere(args.storedAccessToken),
			...(args.keptClient ? clientWhere(args.keptClient) : {}),
		},
		{
			...clientData(args.client),
			...(await importedTokenData(
				args.tokens,
				args.storedAccessToken,
				args.accessTokenSource ?? "ciphertext",
			)),
			oauthBinding: bindingJson(
				bindingFor(
					binding,
					args.client,
					args.tokens?.encryptedRefreshToken ?? null,
				),
			),
		},
		args.tx,
	);
	return writeResult(row);
}

/**
 * Store tokens imported by hand (`mcp.configs.upsert`), leaving the client
 * untouched. An import never inherits an existing binding: it is bound only
 * to what the caller passes (the catalog's endpoint), otherwise unbound —
 * and an unbound config never refreshes. An import is a whole new grant: the
 * token set replaces every token column, so nothing the config held before is
 * kept under the new binding. Only a NEW, usable access token supplied as
 * plaintext is a new grant, so only then does the same write reset the
 * refresh circuit breaker (`needsReauth`, `status`, the failure counters), as
 * the callback's `saveMcpOAuthGrant` does. A ciphertext import or the stored
 * token re-submitted resets nothing and keeps a known expiry; see
 * `importedGrantEffect`.
 * Conditional on `expectedGeneration` and on the stored access token the
 * caller compared against; increments the generation.
 */
export async function importMcpOAuthTokens(args: {
	configId: string;
	/** A complete replacement grant: omitted parts are cleared, not kept. */
	tokens: McpOAuthImportedTokens | null;
	/** Bound to an independent AS, or explicitly bearer-only. */
	binding: McpOAuthBinding | McpOAuthBearerOnly | null;
	/** The access token the caller read with `expectedGeneration`. */
	storedAccessToken?: McpOAuthStoredAccessToken;
	/** How the access token arrived; omitted, `"ciphertext"` (never new). */
	accessTokenSource?: McpOAuthImportSource;
	/** The generation the caller read the config at (see above). */
	expectedGeneration: number;
	/**
	 * The credentials the caller read with `expectedGeneration`. The import
	 * leaves the client as it is and the write is fenced on it. The new
	 * binding is stored (fingerprinted over that client) only when the client
	 * may follow it — its verified binding names the same AS and token
	 * endpoint, or it is a public client; otherwise the import is stored
	 * bearer-only (`bindingForKeptClient`).
	 */
	stored: McpOAuthStoredCredentials;
	tenant?: McpOAuthTenantGuard;
	tx?: DbClient;
}): Promise<McpOAuthWriteResult> {
	const row = await writeIncrementingGeneration(
		args.configId,
		{
			...tenantWhere(args.tenant),
			oauthGrantGeneration: args.expectedGeneration,
			...storedTokenWhere(args.storedAccessToken),
			...clientWhere(args.stored),
		},
		{
			...(await importedTokenData(
				args.tokens,
				args.storedAccessToken,
				args.accessTokenSource ?? "ciphertext",
			)),
			oauthBinding: bindingJson(
				bindingFor(
					bindingForKeptClient(
						args.binding,
						args.stored,
						!!args.tokens,
					),
					args.stored,
					args.tokens?.encryptedRefreshToken ?? null,
				),
			),
		},
		args.tx,
	);
	return writeResult(row);
}

/**
 * Save the tokens of a new grant (the OAuth callback's code exchange) with
 * the binding of the AS that issued them, resetting the refresh circuit
 * breaker and incrementing the generation — only while the config's
 * generation is still the one the flow's `start` captured. Returns
 * `written: false` when the config's credentials changed in between.
 */
export async function saveMcpOAuthGrant(args: {
	configId: string;
	expectedGeneration: number;
	binding: McpOAuthBinding;
	tokens: McpOAuthTokenSet;
	/**
	 * The client the code was exchanged with, as stored. The write is fenced
	 * on it, and the binding's fingerprint covers it.
	 */
	client: McpOAuthStoredClient;
}): Promise<McpOAuthWriteResult> {
	const row = await writeIncrementingGeneration(
		args.configId,
		{
			oauthGrantGeneration: args.expectedGeneration,
			...clientWhere(args.client),
		},
		{
			...tokenData(args.tokens),
			oauthBinding: bindingJson(
				bindingFor(
					args.binding,
					args.client,
					args.tokens.encryptedRefreshToken,
				),
			),
			...BREAKER_RESET,
		},
	);
	return writeResult(row);
}

/**
 * Save the result of a refresh: a compare-and-set on the generation and the
 * refresh-token ciphertext the refresh actually spent. A lost race (the
 * config was revoked, re-registered or reconnected, or another refresh
 * rotated the token first) writes nothing and returns `"superseded"` — never
 * a failure strike. Does not change the generation.
 */
export async function saveMcpOAuthRefresh(args: {
	configId: string;
	expectedGeneration: number;
	expectedRefreshToken: string;
	tokens: McpOAuthTokenSet;
	/**
	 * The binding the refresh was made under (unchanged while the generation
	 * holds). Rewritten with the fingerprint of the credential set now stored.
	 */
	binding: McpOAuthBinding;
	/** The client the refresh authenticated with; fenced on. */
	client: McpOAuthStoredClient;
}): Promise<"written" | "superseded"> {
	try {
		const result = await db.mCPConfig.updateMany({
			where: {
				id: args.configId,
				oauthGrantGeneration: args.expectedGeneration,
				encryptedRefreshToken: args.expectedRefreshToken,
				...clientWhere(args.client),
			},
			data: {
				...tokenData(args.tokens),
				oauthBinding: bindingJson(
					bindingFor(
						args.binding,
						args.client,
						args.tokens.encryptedRefreshToken,
					),
				),
				...BREAKER_RESET,
			},
		});
		return result.count > 0 ? "written" : "superseded";
	} catch (error) {
		return rethrowTokenConflict(error, args.configId);
	}
}

/**
 * Wipe a config's tokens (revoke, invalidation), incrementing the
 * generation so a refresh already in flight cannot restore them. Keeps the
 * binding (only the explicit connect flow rebinds), re-fingerprinted for the
 * credential columns the wipe leaves.
 *
 * The fingerprint needs the client columns the row keeps, so this reads them
 * and writes conditionally on them (and on everything else the caller
 * passes); a row that changed in between is read again, a few times.
 *
 * - `expectedGeneration` / `expectedRefreshToken` make it conditional (a
 *   provider instance invalidates only the grant it was handed).
 * - `clearClient` also removes the client registration.
 * - `extraData` carries caller-specific columns (status, chained tokens).
 *
 * Returns the number of rows changed (0 or 1).
 */
export async function wipeMcpOAuthTokens(args: {
	configId: string;
	tenant?: McpOAuthTenantGuard;
	expectedGeneration?: number;
	expectedRefreshToken?: string;
	clearClient?: boolean;
	needsReauth?: boolean;
	extraData?: Prisma.MCPConfigUpdateManyMutationInput;
	/** An interactive transaction to read and write in. */
	tx?: DbClient;
}): Promise<number> {
	const client = args.tx ?? db;
	for (let attempt = 0; attempt < 3; attempt++) {
		const current = await client.mCPConfig.findUnique({
			where: { id: args.configId },
			select: {
				oauthClientId: true,
				encryptedOauthClientSecret: true,
				encryptedRefreshToken: true,
				oauthBinding: true,
			},
		});
		if (!current) {
			return 0;
		}
		// Judged on the row as read: a refresh token written since is wiped
		// below anyway, and a client written since fails the fence.
		const trusted = isStoredMcpOAuthClientTrusted(current);
		const keptClient: McpOAuthStoredClient | null = args.clearClient
			? null
			: {
					oauthClientId: current.oauthClientId,
					encryptedOauthClientSecret:
						current.encryptedOauthClientSecret,
				};
		const binding = parseMcpOAuthBinding(current.oauthBinding);
		const result = await client.mCPConfig.updateMany({
			where: {
				id: args.configId,
				...tenantWhere(args.tenant),
				...(args.expectedGeneration === undefined
					? {}
					: { oauthGrantGeneration: args.expectedGeneration }),
				...(args.expectedRefreshToken === undefined
					? {}
					: { encryptedRefreshToken: args.expectedRefreshToken }),
				...clientWhere(current),
			},
			data: {
				...args.extraData,
				...CLEARED_TOKENS,
				...(args.clearClient ? clearedClient() : {}),
				...(binding
					? {
							oauthBinding: bindingJson(
								bindingFor(
									binding,
									keptClient,
									null,
									// A cleared client leaves nothing untrusted.
									!!args.clearClient || trusted,
								),
							),
						}
					: {}),
				...(args.needsReauth === undefined
					? {}
					: { needsReauth: args.needsReauth }),
				oauthGrantGeneration: { increment: 1 },
			},
		});
		if (result.count > 0) {
			return result.count;
		}
		// Not matched: either a condition the caller set no longer holds
		// (then nothing is wiped, by design), or the client changed between
		// the read and the write — read again.
		const after = await client.mCPConfig.findUnique({
			where: { id: args.configId },
			select: { oauthClientId: true, encryptedOauthClientSecret: true },
		});
		if (
			!after ||
			(after.oauthClientId === current.oauthClientId &&
				after.encryptedOauthClientSecret ===
					current.encryptedOauthClientSecret)
		) {
			return 0;
		}
	}
	return 0;
}

/**
 * Wipe the tokens of every config matching `where` (bulk revoke, a custom
 * server's endpoints changing), incrementing each one's generation.
 * `clearBinding` also unbinds them, for when the AS they were bound through
 * is no longer the server's. A wipe that keeps the bindings goes row by row
 * (`wipeMcpOAuthTokens`), so each keeps a correct fingerprint.
 */
export async function wipeMcpOAuthTokensWhere(args: {
	where: Prisma.MCPConfigWhereInput;
	clearBinding?: boolean;
	/** Also remove the client registration (id, secret, metadata). */
	clearClient?: boolean;
	extraData?: Prisma.MCPConfigUpdateManyMutationInput;
	client?: Prisma.TransactionClient;
}): Promise<number> {
	if (args.clearBinding) {
		const result = await (args.client ?? db).mCPConfig.updateMany({
			where: args.where,
			data: {
				...args.extraData,
				...CLEARED_TOKENS,
				oauthBinding: Prisma.DbNull,
				...(args.clearClient ? clearedClient() : {}),
				oauthGrantGeneration: { increment: 1 },
			},
		});
		return result.count;
	}
	const rows = await (args.client ?? db).mCPConfig.findMany({
		where: args.where,
		select: { id: true },
	});
	let count = 0;
	for (const row of rows) {
		count += await wipeMcpOAuthTokens({
			configId: row.id,
			clearClient: args.clearClient,
			extraData: args.extraData,
			tx: args.client,
		});
	}
	return count;
}

/**
 * Flag a config for reconnect without counting a refresh strike (its
 * credentials are unbound, so no refresh can be attempted) — only while its
 * generation is still `expectedGeneration`.
 */
export async function markMcpOAuthReconnectRequired(args: {
	configId: string;
	expectedGeneration: number;
	reason: string;
}): Promise<boolean> {
	const result = await db.mCPConfig.updateMany({
		where: {
			id: args.configId,
			oauthGrantGeneration: args.expectedGeneration,
			needsReauth: false,
		},
		data: {
			needsReauth: true,
			lastRefreshError: args.reason.slice(0, 500),
		},
	});
	return result.count > 0;
}

/** The config's current grant generation, or null when it does not exist. */
export async function getMcpOAuthGrantGeneration(
	configId: string,
): Promise<number | null> {
	const row = await db.mCPConfig.findUnique({
		where: { id: configId },
		select: { oauthGrantGeneration: true },
	});
	return row?.oauthGrantGeneration ?? null;
}
