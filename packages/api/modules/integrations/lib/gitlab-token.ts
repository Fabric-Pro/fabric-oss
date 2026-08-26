import {
	advisoryObjectKey,
	mcpConfigLockKey,
	REFRESH_ADVISORY_CLASS,
	workflowIntegrationLockKey,
} from "@repo/database/prisma/queries/lib/refresh-lock-key";
import {
	type GitLabIntegrationSettings,
	GitLabReauthRequiredError,
	probeGitLabMcp,
} from "@repo/integrations/gitlab";
import { decryptApiKey, encryptApiKey, hashApiKey } from "@repo/utils";
import {
	resetGitlabOfficialMcpBreaker,
	syncGitlabOfficialMcpConfig,
} from "./sync-gitlab-official-mcp";

type ProbeResult = Awaited<ReturnType<typeof probeGitLabMcp>>;

type GitLabTokenSource = "mcp" | "workflow_integration";

export type GitLabToken = {
	source: GitLabTokenSource;
	/**
	 * Id of the row the token came from. Used to derive the advisory-lock key so
	 * this path addresses the SAME row identity as every other refresh path —
	 * a per-user key hashed differently and silently stopped serializing.
	 */
	rowId?: string;
	accessToken: string;
	refreshToken: string | null;
	/**
	 * The stored ciphertexts, carried out of the read alongside the decrypted
	 * values above.
	 *
	 * A `needsReauth` condemnation has to be bound to the row VERSION the
	 * provider actually judged (see `GitLabMcpReauthEvidence`), and
	 * `encryptApiKey` is non-deterministic — re-encrypting the plaintext above
	 * would produce a value that matches nothing in the row. Carrying the
	 * ciphertext is therefore the only way a later writer can hold that
	 * version token at all.
	 *
	 * Populated for `source: "mcp"` only. The WorkflowIntegration store keeps
	 * one encrypted JSON blob instead of per-token columns, and a rejection
	 * about it is no evidence about any MCPConfig row.
	 */
	encryptedAccessToken?: string;
	encryptedRefreshToken?: string | null;
	expiresAt: Date | null;
	needsReauth: boolean;
};

export type GitLabTokenCtx = {
	userId: string;
	organizationId: string | null;
};

// Narrow db accessor — accepts the real PrismaClient OR a structural fake
// (used by tests). We avoid coupling to Prisma's generated types here so
// the helper can be exercised without spinning up a Prisma client.
type DbReader = {
	mCPConfig: {
		findFirst: (args: unknown) => Promise<unknown>;
	};
	workflowIntegration: {
		findFirst: (args: unknown) => Promise<unknown>;
	};
};

type McpConfigRow = {
	id: string;
	encryptedAccessToken: string | null;
	encryptedRefreshToken: string | null;
	tokenExpiresAt: Date | null;
	needsReauth: boolean;
};

type WorkflowIntegrationRow = {
	id: string;
	credentials: string;
	settings: unknown;
};

/**
 * Read the GitLab token for a tenant context. Prefers the MCPConfig row
 * (primary store after unification); falls back to WorkflowIntegration
 * for users who haven't been reconciled yet. Returns `null` when neither
 * row exists.
 *
 * Asymmetric on purpose: `MCPConfig` keeps expiry on a top-level column
 * while `WorkflowIntegration` nests it inside `settings.tokenExpiresAt`
 * as an ISO string. The helper normalizes both shapes into a uniform
 * `GitLabToken`.
 */
export async function loadGitLabToken(
	db: DbReader,
	ctx: GitLabTokenCtx,
): Promise<GitLabToken | null> {
	const mcp = (await db.mCPConfig.findFirst({
		where: {
			userId: ctx.userId,
			organizationId: ctx.organizationId,
			mcpServer: { key: "gitlab" },
		},
		select: {
			id: true,
			encryptedAccessToken: true,
			encryptedRefreshToken: true,
			tokenExpiresAt: true,
			needsReauth: true,
		},
	})) as McpConfigRow | null;

	if (mcp?.encryptedAccessToken) {
		return {
			source: "mcp",
			rowId: mcp.id,
			accessToken: decryptApiKey(mcp.encryptedAccessToken),
			refreshToken: mcp.encryptedRefreshToken
				? decryptApiKey(mcp.encryptedRefreshToken)
				: null,
			encryptedAccessToken: mcp.encryptedAccessToken,
			encryptedRefreshToken: mcp.encryptedRefreshToken,
			expiresAt: mcp.tokenExpiresAt,
			needsReauth: mcp.needsReauth,
		};
	}

	const wi = (await db.workflowIntegration.findFirst({
		where: {
			userId: ctx.userId,
			organizationId: ctx.organizationId,
			provider: "GITLAB",
		},
		select: { id: true, credentials: true, settings: true },
	})) as WorkflowIntegrationRow | null;

	if (!wi?.credentials) {
		return null;
	}

	const decrypted = decryptApiKey(wi.credentials);
	let parsed: { access_token: string; refresh_token?: string };
	try {
		parsed = JSON.parse(decrypted) as typeof parsed;
	} catch {
		return null;
	}

	const settings = (wi.settings ?? {}) as {
		tokenExpiresAt?: string | null;
		needsReauth?: boolean;
	};
	const expiresAt = settings.tokenExpiresAt
		? new Date(settings.tokenExpiresAt)
		: null;

	// No `encrypted*` fields: this store's ciphertext is one JSON blob covering
	// both tokens, not the MCPConfig columns a condemnation binds itself to.
	return {
		source: "workflow_integration",
		rowId: wi.id,
		accessToken: parsed.access_token,
		refreshToken: parsed.refresh_token ?? null,
		expiresAt,
		needsReauth: Boolean(settings.needsReauth),
	};
}

// --- persistGitLabToken ---

type TxAccessor = {
	mCPServer: {
		findFirst: (args: unknown) => Promise<unknown>;
	};
	mCPConfig: {
		findFirst: (args: unknown) => Promise<unknown>;
		create: (args: unknown) => Promise<unknown>;
		update: (args: unknown) => Promise<unknown>;
		delete: (args: unknown) => Promise<unknown>;
	};
	workflowIntegration: {
		findFirst: (args: unknown) => Promise<unknown>;
		create: (args: unknown) => Promise<unknown>;
		update: (args: unknown) => Promise<unknown>;
	};
};

type DbWithTransaction = {
	$transaction: <T>(cb: (tx: TxAccessor) => Promise<T>) => Promise<T>;
};

export type GitLabUserIdentity = {
	id: number;
	username: string;
	name: string;
	avatarUrl: string | null;
};

export type PersistTokenInput = {
	userId: string;
	organizationId: string | null;
	token: {
		accessToken: string;
		refreshToken: string | null;
		expiresAt: Date | null;
		scopes: string[];
	};
	gitlabUser: GitLabUserIdentity;
	/**
	 * Whether the caller holds a NEW grant the user just authorized — i.e. it
	 * has completed an OAuth authorization-code exchange and the token below
	 * is that exchange's output.
	 *
	 * This is the reset authority for the circuit breaker. `true` clears
	 * `needsReauth`, `status`, `refreshFailureCount`, `lastRefreshFailedAt`,
	 * `lastRefreshError` and `consecutiveFailures` on BOTH the primary
	 * `gitlab` MCPConfig and the synced `gitlab-official` one (plus the
	 * WorkflowIntegration-side mirror of the flag). `false` writes the token
	 * fields and leaves every one of those exactly as it found them.
	 *
	 * On the `gitlab-official` row this holds even when the MCP capability
	 * probe came back inconclusive: that probe's authority is over whether the
	 * official server is usable, not over whether the user's credential is
	 * alive, and a reconnect that raced a probe timeout must not leave a
	 * condemned row stranded.
	 *
	 * Required, not defaulted, so a new call site has to make the call
	 * deliberately. Pass `false` from anything that re-persists a token read
	 * out of the database (reconcile, backfills) and from anything that only
	 * renewed one (`grant_type=refresh_token`). `needsReauth` is ENFORCED — a
	 * flagged config is refused at client creation, filtered out of tool
	 * discovery and blocked from refreshing — and nothing but a new grant may
	 * lift it. Clearing it without one resurrects a credential whose refresh
	 * token is still dead; and a renewing caller holds no evidence at all
	 * about the `gitlab-official` row, which stores its own refresh token and
	 * is condemned independently by the PM adapter and the Temporal resolver.
	 */
	freshGrant: boolean;
	/**
	 * Optional override for the GitLab instance base URL — used by the probe.
	 * Defaults to `https://gitlab.com`. Self-hosted GitLab callers should
	 * pass the instance origin so we don't ship the freshly-issued bearer
	 * token to `gitlab.com/api/v4/mcp`.
	 *
	 * Today the OAuth procedure only supports gitlab.com so no production
	 * caller passes this yet; the parameter is accepted to make the
	 * self-hosted path additive when it lands.
	 */
	baseUrl?: string;
};

/**
 * Dual-write a GitLab token into both `MCPConfig` and
 * `WorkflowIntegration` in a single transaction. Used by the unified
 * OAuth callback, the refresh path and the reconciler; clears the
 * circuit-breaker state on both sides only when the caller passes
 * `freshGrant: true` (see `PersistTokenInput.freshGrant`).
 *
 * Uses findFirst + update/create instead of Prisma `upsert` because
 * neither table carries a compound-unique constraint on
 * (userId, organizationId, mcpServerId / provider). Adding the
 * constraint would require a backfill against existing duplicates;
 * the findFirst pattern matches the established `gitlab-oauth.ts`
 * callback shape and keeps the change additive.
 */
export type PersistTokenResult = {
	mcpConfigId: string;
	workflowIntegrationId: string;
};

/**
 * Pre-computed payload for `persistGitLabTokenOnTx`. Holds all the
 * side-effect-free / network-only work (encryption + MCP probe) so the
 * inner write helper can run with zero non-DB I/O while holding the tx
 * connection.
 */
type PreparedTokenWrite = {
	encAccess: string;
	hashAccess: string;
	encRefresh: string | null;
	wiCredentials: string;
	probe: ProbeResult;
	probeBaseUrl: string;
	isAuthoritative: boolean;
};

/**
 * Side-effect-free precomputation for a token write: encrypts/hashes
 * the new credentials and runs the MCP probe (HTTP, up to 2s). Does NO
 * database I/O — safe (and required) to call BEFORE opening a
 * `$transaction`, so the probe doesn't hold a DB connection while
 * doing network work.
 *
 * The locked-refresh branch in `getValidGitLabToken` is the one
 * deliberate exception: it calls `prepareTokenWrite` *inside* its
 * `$transaction` because the freshly-issued access token only exists
 * after the in-tx refresh succeeds. That cost is acceptable — the
 * locked path fires only when a refresh is actually needed.
 */
async function prepareTokenWrite(
	input: PersistTokenInput,
): Promise<PreparedTokenWrite> {
	const encAccess = encryptApiKey(input.token.accessToken);
	const hashAccess = hashApiKey(input.token.accessToken);
	const encRefresh = input.token.refreshToken
		? encryptApiKey(input.token.refreshToken)
		: null;

	const probeBaseUrl = input.baseUrl ?? "https://gitlab.com";
	const probe = await probeGitLabMcp({
		baseUrl: probeBaseUrl,
		accessToken: input.token.accessToken,
	});

	const isAuthoritative =
		probe.status === "ok" ||
		probe.status === "unauthorized" ||
		probe.status === "not-found";

	const expiresInSeconds = input.token.expiresAt
		? Math.max(
				0,
				Math.round(
					(input.token.expiresAt.getTime() - Date.now()) / 1000,
				),
			)
		: undefined;
	const wiCredentials = encryptApiKey(
		JSON.stringify({
			access_token: input.token.accessToken,
			refresh_token: input.token.refreshToken,
			scope: input.token.scopes.join(" "),
			expires_in: expiresInSeconds,
			token_obtained_at: new Date().toISOString(),
		}),
	);

	return {
		encAccess,
		hashAccess,
		encRefresh,
		wiCredentials,
		probe,
		probeBaseUrl,
		isAuthoritative,
	};
}

/**
 * Same writes as `persistGitLabToken` but operates on an EXISTING
 * transaction client. Used by paths that already hold a `$transaction`
 * (e.g. the advisory-lock branch in `getValidGitLabToken`) so we don't
 * nest `$transaction` calls — `TransactionClient` does not expose
 * `$transaction` and would throw at runtime.
 *
 * The non-tx wrapper below (`persistGitLabToken`) is the typical caller;
 * it runs `prepareTokenWrite` BEFORE opening a `$transaction` and then
 * delegates here. Keep this helper free of any `$transaction` invocation
 * and any non-DB I/O (no HTTP probe, no encryption — both happen in
 * `prepareTokenWrite`).
 */
async function persistGitLabTokenOnTx(
	tx: TxAccessor,
	input: PersistTokenInput,
	prepared: PreparedTokenWrite,
): Promise<PersistTokenResult> {
	const {
		encAccess,
		hashAccess,
		encRefresh,
		wiCredentials,
		probe,
		probeBaseUrl,
		isAuthoritative,
	} = prepared;

	if (!isAuthoritative) {
		console.error(
			"[gitlab-token] non-authoritative probe on persistGitLabToken — leaving useOfficialMcp absent",
			{
				userId: input.userId,
				organizationId: input.organizationId,
				probeStatus: probe.status,
			},
		);
	}

	const wiSettings: Record<string, unknown> = {
		gitlabUserId: input.gitlabUser.id,
		gitlabUsername: input.gitlabUser.username,
		gitlabName: input.gitlabUser.name,
		gitlabAvatarUrl: input.gitlabUser.avatarUrl,
		scope: input.token.scopes.join(" "),
		scopes: input.token.scopes,
		connectedAt: new Date().toISOString(),
		hasRefreshToken: input.token.refreshToken !== null,
		tokenExpiresAt: input.token.expiresAt
			? input.token.expiresAt.toISOString()
			: null,
		needsReauth: false,
		mcpProbe: {
			status: probe.status,
			httpStatus: probe.httpStatus,
			checkedAt: new Date().toISOString(),
			baseUrl: probeBaseUrl,
		},
	};
	if (isAuthoritative) {
		wiSettings.useOfficialMcp = probe.capable;
	}

	const gitlabServer = (await tx.mCPServer.findFirst({
		where: { key: "gitlab", isSystemProvided: true },
		select: { id: true },
	})) as { id: string } | null;
	if (!gitlabServer) {
		throw new Error(
			"GitLab MCPServer row missing — run seed:mcp-registry to seed it",
		);
	}

	const existingMcp = (await tx.mCPConfig.findFirst({
		where: {
			userId: input.userId,
			organizationId: input.organizationId,
			mcpServerId: gitlabServer.id,
		},
		select: { id: true },
	})) as { id: string } | null;

	let mcpConfigId: string;
	if (existingMcp) {
		const mcpData: Record<string, unknown> = {
			encryptedAccessToken: encAccess,
			accessTokenHash: hashAccess,
			encryptedRefreshToken: encRefresh,
			tokenExpiresAt: input.token.expiresAt,
		};
		if (input.freshGrant) {
			// A successful re-auth is a full recovery signal: reset the
			// whole circuit-breaker state, not just the flag. Leaving
			// refreshFailureCount at its tripped value would re-trip the
			// breaker on the next single transient failure. Mirrors
			// updateMcpConfigTokens, which this GitLab path bypasses.
			// Gated because callers without a new grant only ever re-persist
			// a token that is already stored — see PersistTokenInput.freshGrant.
			mcpData.needsReauth = false;
			mcpData.status = "HEALTHY";
			mcpData.refreshFailureCount = 0;
			mcpData.lastRefreshFailedAt = null;
			mcpData.lastRefreshError = null;
			mcpData.consecutiveFailures = 0;
		}
		await tx.mCPConfig.update({
			where: { id: existingMcp.id },
			data: mcpData,
		});
		mcpConfigId = existingMcp.id;
	} else {
		const created = (await tx.mCPConfig.create({
			data: {
				userId: input.userId,
				organizationId: input.organizationId,
				mcpServerId: gitlabServer.id,
				authType: "OAUTH2",
				encryptedAccessToken: encAccess,
				accessTokenHash: hashAccess,
				encryptedRefreshToken: encRefresh,
				tokenExpiresAt: input.token.expiresAt,
				// No `freshGrant` gate: a brand-new row has no breaker state
				// to resurrect, and this just restates the schema default.
				needsReauth: false,
				scopes: input.token.scopes,
			},
			select: { id: true },
		})) as { id: string };
		mcpConfigId = created.id;
	}

	const officialTokenBundle = {
		encryptedAccessToken: encAccess,
		accessTokenHash: hashAccess,
		encryptedRefreshToken: encRefresh,
		tokenExpiresAt: input.token.expiresAt,
	};

	if (isAuthoritative) {
		const syncResult = await syncGitlabOfficialMcpConfig(tx as never, {
			userId: input.userId,
			organizationId: input.organizationId,
			capable: probe.capable,
			// Same authority as the primary-config update above: only a
			// caller holding a new grant may clear this row's breaker. It
			// carries its OWN refresh token and is condemned independently
			// of the primary row, so a caller that merely renewed the
			// primary grant has no evidence about it at all.
			resetBreaker: input.freshGrant,
			tokenBundle: officialTokenBundle,
		});
		if (!syncResult.ok) {
			console.error(
				"[gitlab-token] gitlab-official MCPServer row missing — skipped MCPConfig sync",
				{
					userId: input.userId,
					organizationId: input.organizationId,
				},
			);
		} else if (syncResult.action === "kept-condemned") {
			// Rare and worth seeing: an incapable probe found a condemned row
			// and this caller holds no fresh grant, so the row survives a
			// delete it would otherwise have taken. `console.error` because
			// most log shippers drop warn-level by default.
			console.error(
				"[gitlab-token] kept a condemned gitlab-official MCPConfig that an incapable probe would have deleted — no fresh grant to clear its breaker",
				{
					userId: input.userId,
					organizationId: input.organizationId,
				},
			);
		}
	} else if (input.freshGrant) {
		// Probe authority governs the CAPABILITY decision; it says nothing
		// about the CREDENTIAL. The user just authorized a new grant, so the
		// official row's breaker and token have to move even though this probe
		// cannot say whether the official server is usable — otherwise a
		// reconnect that happened to race a probe timeout leaves that row
		// condemned and holding a dead token, `reconcile` refuses while it is
		// (it checks both rows), and the capability recheck has no authority to
		// clear it. The recovery is credential-only by construction: the helper
		// updates an existing row and never creates or deletes one, so a
		// non-authoritative probe still cannot flip capability state.
		const resetResult = await resetGitlabOfficialMcpBreaker(tx as never, {
			userId: input.userId,
			organizationId: input.organizationId,
			tokenBundle: officialTokenBundle,
		});
		if (!resetResult.ok) {
			console.error(
				"[gitlab-token] gitlab-official MCPServer row missing — skipped breaker reset",
				{
					userId: input.userId,
					organizationId: input.organizationId,
				},
			);
		}
	}

	const existingWi = (await tx.workflowIntegration.findFirst({
		where: {
			userId: input.userId,
			organizationId: input.organizationId,
			provider: "GITLAB",
		},
		select: { id: true, settings: true },
	})) as { id: string; settings: unknown } | null;

	if (!input.freshGrant && existingWi) {
		// `settings` is rebuilt from scratch above, so the default
		// `needsReauth: false` would clear this store's copy of the breaker
		// the same way an ungated column write clears the MCPConfig one.
		// Without a new grant, carry the stored value forward instead.
		const priorSettings = (existingWi.settings ?? {}) as {
			needsReauth?: boolean;
		};
		wiSettings.needsReauth = Boolean(priorSettings.needsReauth);
	}

	let workflowIntegrationId: string;
	if (existingWi) {
		await tx.workflowIntegration.update({
			where: { id: existingWi.id },
			data: {
				credentials: wiCredentials,
				settings: wiSettings,
				isActive: true,
			},
		});
		workflowIntegrationId = existingWi.id;
	} else {
		const created = (await tx.workflowIntegration.create({
			data: {
				userId: input.userId,
				organizationId: input.organizationId,
				provider: "GITLAB",
				name: `GitLab: ${input.gitlabUser.username}`,
				credentials: wiCredentials,
				settings: wiSettings,
				isActive: true,
			},
			select: { id: true },
		})) as { id: string };
		workflowIntegrationId = created.id;
	}

	return { mcpConfigId, workflowIntegrationId };
}

export async function persistGitLabToken(
	db: DbWithTransaction,
	input: PersistTokenInput,
): Promise<PersistTokenResult> {
	// Run encryption + the MCP probe (up to 2s of network I/O) BEFORE
	// opening the transaction so we don't hold a DB connection during
	// non-DB work. See PR #1035 — "the probe runs *before* the
	// transaction" — and the locked-refresh branch in
	// `getValidGitLabToken` is the only deliberate exception.
	const prepared = await prepareTokenWrite(input);
	return db.$transaction((tx) => persistGitLabTokenOnTx(tx, input, prepared));
}

// --- getValidGitLabToken / markNeedsReauth ---

const GITLAB_TOKEN_URL = "https://gitlab.com/oauth/token";
const REFRESH_BUFFER_MS = 60 * 1000;

export { GitLabReauthRequiredError };

function isExpiring(expiresAt: Date | null): boolean {
	if (!expiresAt) {
		// Unknown expiry: GitLab OAuth tokens DO expire (~2h). Treat as
		// expiring so the caller refreshes rather than handing back a token
		// that may already be dead. (GitLab integrations always carry a
		// refresh token; the caller surfaces reconnect if one is absent.)
		return true;
	}
	return expiresAt.getTime() - Date.now() <= REFRESH_BUFFER_MS;
}

type RefreshedToken = {
	accessToken: string;
	refreshToken: string | null;
	expiresAt: Date | null;
	scopes: string[];
};

export type GitLabOAuthCredentials = {
	clientId: string;
	clientSecret: string;
};

async function refreshAtGitLab(
	refreshToken: string,
	credentials?: GitLabOAuthCredentials,
): Promise<RefreshedToken> {
	const clientId =
		credentials?.clientId ?? process.env.GITLAB_CLIENT_ID ?? "";
	const clientSecret =
		credentials?.clientSecret ?? process.env.GITLAB_CLIENT_SECRET ?? "";
	const params = new URLSearchParams({
		grant_type: "refresh_token",
		refresh_token: refreshToken,
		client_id: clientId,
		client_secret: clientSecret,
	});
	const res = await fetch(GITLAB_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: params.toString(),
	});
	if (!res.ok) {
		let body: { error?: string } = {};
		try {
			body = (await res.json()) as { error?: string };
		} catch {
			// fall through to generic error below
		}
		// Same classification rule as the shared `refreshGitLabToken` in
		// @repo/integrations — the two must not disagree about the same
		// response, because the typed error is what condemns the credential
		// (`needsReauth`, enforced, cleared only by a user re-auth). Only
		// `invalid_grant` and `invalid_token` identify the user's grant as
		// the dead thing; a bare HTTP status does not (a 401 also covers
		// `invalid_client`, i.e. the OAuth APP's credentials, which no
		// reconnect can fix), so everything undecisive stays a plain Error.
		if (body.error === "invalid_grant" || body.error === "invalid_token") {
			throw new GitLabReauthRequiredError();
		}
		throw new Error(`GitLab refresh failed: ${res.status}`);
	}
	const json = (await res.json()) as {
		access_token: string;
		refresh_token?: string;
		expires_in?: number;
		created_at?: number;
		scope?: string;
		error?: string;
		error_description?: string;
	};
	// GitLab can answer 200 with an OAuth error body. Without this branch a
	// dead grant reaching us that way is never condemned (and `access_token`
	// would be persisted as `undefined`).
	if (json.error === "invalid_grant" || json.error === "invalid_token") {
		throw new GitLabReauthRequiredError();
	}
	if (json.error) {
		throw new Error(
			`GitLab refresh error: ${json.error_description || json.error}`,
		);
	}
	const expiresAt =
		json.created_at && json.expires_in
			? new Date((json.created_at + json.expires_in) * 1000)
			: json.expires_in
				? new Date(Date.now() + json.expires_in * 1000)
				: null;
	return {
		accessToken: json.access_token,
		refreshToken: json.refresh_token ?? null,
		expiresAt,
		scopes: json.scope ? json.scope.split(" ") : ["api", "read_user"],
	};
}

/**
 * The `where` fragment a condemnation on `MCPConfig` is gated on: one row, one
 * ciphertext pinning its version, and the breaker not already tripped.
 */
type McpReauthCondition = {
	id: string;
	needsReauth: boolean;
	encryptedAccessToken?: string;
	encryptedRefreshToken?: string;
};

type TxForReauth = {
	mCPConfig: {
		/**
		 * `updateMany`, not `update`, deliberately: `update` cannot express the
		 * evidence predicate below, and a row that fails that predicate must be
		 * left alone rather than written to anyway. The predicate is required
		 * in the type for the same reason `GitLabRefreshFailureDb` requires
		 * its own — an unguarded condemnation should not typecheck.
		 */
		updateMany: (args: {
			where: McpReauthCondition;
			data: { needsReauth: true };
		}) => Promise<{ count: number }>;
	};
	workflowIntegration: {
		findFirst: (args: unknown) => Promise<unknown>;
		update: (args: unknown) => Promise<unknown>;
	};
};

/**
 * The evidence a `needsReauth` write on `MCPConfig` must be bound to.
 *
 * That column is ENFORCED — a flagged config is refused at MCP client
 * creation, filtered out of tool discovery and blocked from refreshing — and
 * nothing but a fresh OAuth grant performed by the user clears it. The
 * advisory lock this path takes does NOT make an unconditional write safe: it
 * serialises refreshers against each other, but the OAuth callback never
 * acquires it. So a user can complete a real reconnect while a refresh is
 * in flight, and the stale `invalid_grant` that comes back afterwards would
 * condemn the row that now holds the freshly authorized credential — hard
 * blocking the integration the user just fixed.
 *
 * `boundTo` names which stored ciphertext pins the row version this rejection
 * is about:
 *   - `"refreshToken"` — a rejected exchange, bound to the refresh token we
 *     posted.
 *   - `"accessToken"` — the branch that found no refresh token to post and so
 *     has no refresh ciphertext to name. Any column a reconnect is guaranteed
 *     to move works as a version token, and the access token is one.
 *
 * The version token is the CIPHERTEXT rather than a re-encrypt of the
 * plaintext: `encryptApiKey` is non-deterministic, so a re-encrypt would match
 * nothing and decline every condemnation. Same rule as `recordRefreshFailure`
 * in `@repo/database` and the shared GitLab refresh-failure writer.
 */
type GitLabMcpReauthEvidence = {
	/** The token as READ, before the exchange that got rejected. */
	token: GitLabToken;
	boundTo: "refreshToken" | "accessToken";
};

/**
 * Turn the evidence into the row-version predicate, or `null` when the
 * rejection is no evidence about any MCPConfig row and therefore may not move
 * the enforced column at all.
 *
 * `null` is not a fail-open: it means the credential came from the legacy
 * WorkflowIntegration store, and for those `loadGitLabToken` reads the breaker
 * out of `settings.needsReauth` — which `markNeedsReauthOnTx` still writes. The
 * loop this whole path exists to stop is stopped by that flag, on the same
 * store the dead credential lives in.
 */
function mcpEvidenceCondition(
	evidence: GitLabMcpReauthEvidence,
): Omit<McpReauthCondition, "needsReauth"> | null {
	const { token, boundTo } = evidence;
	if (token.source !== "mcp" || !token.rowId) {
		return null;
	}
	if (boundTo === "refreshToken") {
		return token.encryptedRefreshToken
			? {
					id: token.rowId,
					encryptedRefreshToken: token.encryptedRefreshToken,
				}
			: null;
	}
	return token.encryptedAccessToken
		? { id: token.rowId, encryptedAccessToken: token.encryptedAccessToken }
		: null;
}

type DbForReauth = TxForReauth & {
	$transaction: <T>(cb: (tx: TxForReauth) => Promise<T>) => Promise<T>;
};

/**
 * Same writes as `markNeedsReauth` but operates on an EXISTING
 * transaction client. Callers already inside a `$transaction` (e.g.
 * the locked branch in `getValidGitLabToken`) must use this helper
 * instead — `TransactionClient` does not expose `$transaction`.
 *
 * `evidence` binds the MCPConfig condemnation to the row version the provider
 * actually rejected — see `GitLabMcpReauthEvidence`.
 */
async function markNeedsReauthOnTx(
	tx: TxForReauth,
	ctx: GitLabTokenCtx,
	evidence: GitLabMcpReauthEvidence,
): Promise<void> {
	// The MCPConfig write is EVIDENCE-BOUND; the WorkflowIntegration write
	// below is not. Not an oversight: `MCPConfig.needsReauth` is the enforced
	// breaker, so a condemnation landing on a row a reconnect has since
	// refreshed hard-blocks a working credential. The settings-JSON copy is
	// the legacy, unenforced mirror — binding it is tracked separately as
	// issue #2806 and deliberately out of scope here.
	const condition = mcpEvidenceCondition(evidence);
	if (condition) {
		const condemned = await tx.mCPConfig.updateMany({
			where: { ...condition, needsReauth: false },
			data: { needsReauth: true },
		});
		if (condemned.count === 0) {
			// The row moved on between the read this evidence came from and
			// this write: a reconnect (or a parallel refresh) replaced the
			// version we judged, or a better-evidenced failure condemned it
			// first. Neither is an error — a zero match is the expected
			// outcome of the race, the same rule the sibling writers follow.
			// They tell the two cases apart with a diagnostics-only fallback
			// write; this helper writes no diagnostics, so one line covers
			// both. `console.error` because most log shippers drop warn-level
			// by default.
			console.error(
				"[gitlab-token] declined to condemn an MCPConfig — it no longer holds the credential this rejection judged, or was already condemned",
				{ mcpConfigId: condition.id, boundTo: evidence.boundTo },
			);
		}
	} else {
		console.error(
			"[gitlab-token] refresh rejection carried no MCPConfig row version to bind to — the enforced breaker is left alone and only the WorkflowIntegration flag is written",
			{
				userId: ctx.userId,
				organizationId: ctx.organizationId,
				source: evidence.token.source,
			},
		);
	}

	const wi = (await tx.workflowIntegration.findFirst({
		where: {
			userId: ctx.userId,
			organizationId: ctx.organizationId,
			provider: "GITLAB",
		},
		select: { id: true, settings: true },
	})) as { id: string; settings: unknown } | null;
	if (wi) {
		const settings = (wi.settings ?? {}) as GitLabIntegrationSettings;
		// Drop cached capability probe alongside marking needsReauth.
		// Without this, callers that read `useOfficialMcp` / `mcpProbe`
		// from this JSON column keep rendering the previous probe result
		// after a dead refresh, contradicting the actual auth state.
		// The next successful `recheckCapabilities` repopulates them.
		const { useOfficialMcp: _u, mcpProbe: _p, ...preserved } = settings;
		await tx.workflowIntegration.update({
			where: { id: wi.id },
			data: {
				settings: { ...preserved, needsReauth: true },
			},
		});
	}
}

/**
 * Mark both stores `needsReauth = true` for the tenant. Called when a
 * refresh exchange returns `invalid_grant`; lets the UI surface a
 * one-shot "Reconnect GitLab" prompt instead of every caller
 * independently retrying the dead refresh token.
 *
 * `evidence` is required, not defaulted, so a new call site has to name the
 * row version its rejection is about — see `GitLabMcpReauthEvidence`.
 */
async function markNeedsReauth(
	db: DbForReauth,
	ctx: GitLabTokenCtx,
	evidence: GitLabMcpReauthEvidence,
): Promise<void> {
	await db.$transaction((tx) => markNeedsReauthOnTx(tx, ctx, evidence));
}

type DbFull = DbReader & DbWithTransaction & DbForReauth;

/**
 * Structural type for the inner tx-client passed to the locked branch.
 * Intentionally narrow — only the accessors actually used inside the
 * `$transaction` callback. `$transaction` is deliberately omitted so
 * the type forbids re-opening a transaction (a runtime bug on a real
 * `Prisma.TransactionClient`). The shape combines:
 *  - reader (loadGitLabToken / loadStoredGitLabUser)
 *  - reauth writes (markNeedsReauthOnTx)
 *  - persist writes (persistGitLabTokenOnTx — via `TxAccessor`)
 *  - $executeRaw for the advisory-lock call
 */
type TxClient = DbReader &
	TxForReauth &
	TxAccessor & {
		// $executeRaw (not $queryRaw): the advisory-lock SELECT returns `void`,
		// which the pg driver adapter's $queryRaw cannot deserialize.
		$executeRaw: (
			template: TemplateStringsArray,
			...values: unknown[]
		) => Promise<unknown>;
	};

type LockClient = {
	$queryRaw: (
		template: TemplateStringsArray,
		...values: unknown[]
	) => Promise<unknown>;
	$transaction: <T>(callback: (tx: TxClient) => Promise<T>) => Promise<T>;
};

/**
 * Resolve the client used for the cross-process advisory lock.
 *
 * `db` IS the real PrismaClient at every production call site, so default to
 * it. The explicit override stays for callers that want a different client,
 * and the `undefined` return keeps test doubles (which have no `$transaction`)
 * on the unlocked fallback.
 */
function resolveLockClient(
	db: DbFull,
	override?: LockClient,
): LockClient | undefined {
	if (override) {
		return override;
	}
	const candidate = db as unknown as Partial<LockClient> | null;
	return typeof candidate?.$transaction === "function"
		? (candidate as LockClient)
		: undefined;
}

/**
 * What the locked-refresh transaction hands back, instead of throwing its own
 * verdict from inside the callback.
 *
 * Throwing out of a Prisma interactive transaction ROLLS IT BACK, and the two
 * failing branches in that callback write a `needsReauth` condemnation before
 * they give up. Raised from inside, the throw would discard exactly the write
 * that stops the caller re-posting the dead grant on its next call. So every
 * decision the callback reaches is carried out as a value and re-raised after
 * the commit — see the transaction boundary in `getValidGitLabToken`.
 */
type LockedRefreshOutcome =
	| { ok: true; token: string }
	| { ok: false; error: GitLabReauthRequiredError };

/**
 * Get a valid GitLab access token for a tenant. Refreshes if near
 * expiry and dual-writes the new token. Throws `GitLabReauthRequiredError`
 * when the stored refresh token is dead (invalid_grant) or when no
 * refresh token is available — callers should surface the
 * "Reconnect GitLab" prompt.
 */
export async function getValidGitLabToken(
	db: DbFull,
	ctx: GitLabTokenCtx,
	opts?: {
		credentials?: GitLabOAuthCredentials;
		/**
		 * Prisma client used to acquire a Postgres advisory lock around the
		 * refresh-then-persist block, giving cross-process single-flight on
		 * multi-replica deploys.
		 *
		 * Rarely needed: it now DEFAULTS to `db`, which is the real
		 * PrismaClient at every production call site. It used to be opt-in,
		 * and the sole production caller (`gitlab-recheck.ts`) never passed
		 * it — so the lock below existed but never once executed outside
		 * tests, and two processes could still spend the same single-use
		 * rotating refresh token. Pass it explicitly only to override that;
		 * when neither this nor `db` exposes `$transaction` (test doubles),
		 * the unlocked fallback runs.
		 *
		 * The inner `tx` is typed structurally as `TxClient` — a narrow
		 * shape limited to the accessors used inside the locked body. It
		 * intentionally OMITS `$transaction`; nested transactions on a real
		 * `Prisma.TransactionClient` would throw at runtime.
		 */
		prisma?: {
			$queryRaw: (
				template: TemplateStringsArray,
				...values: unknown[]
			) => Promise<unknown>;
			$transaction: <T>(
				callback: (tx: TxClient) => Promise<T>,
			) => Promise<T>;
		};
	},
): Promise<string> {
	// Non-tx pre-read first: if the cached token is fresh, return it
	// without entering a transaction or taking the advisory lock. The
	// locked path is reserved for the refresh-needed case so a hot caller
	// doesn't burn a DB roundtrip + lock acquisition on every call.
	const current = await loadGitLabToken(db, ctx);
	if (!current) {
		throw new GitLabReauthRequiredError("NO_TOKEN");
	}
	if (current.needsReauth) {
		throw new GitLabReauthRequiredError();
	}
	if (!isExpiring(current.expiresAt)) {
		return current.accessToken;
	}
	if (!current.refreshToken) {
		// Nothing was posted, so there is no refresh ciphertext to bind to —
		// bind to the access token this read saw instead. A reconnect that has
		// since supplied the missing refresh token rewrites both columns, so
		// its row fails this predicate and survives our stale verdict.
		await markNeedsReauth(db, ctx, {
			token: current,
			boundTo: "accessToken",
		});
		throw new GitLabReauthRequiredError("NO_REFRESH_TOKEN");
	}

	// Locked path: under the advisory lock, re-read and double-check
	// whether the token still needs a refresh, then refresh-and-persist
	// inline on the tx client. We must NOT call `persistGitLabToken` or
	// `markNeedsReauth` here — both open their own `$transaction`, which
	// `Prisma.TransactionClient` does not support. Use the `*OnTx`
	// helpers instead.
	const lockClient = resolveLockClient(db, opts?.prisma);
	if (lockClient) {
		// Key on the ROW, not on the user. This path and gitlab/index.ts can both
		// refresh the same WorkflowIntegration row; a per-user key hashed to a
		// different lock id, so neither ever waited for the other and both spent
		// the same single-use rotating refresh token. Falling back to the user
		// tuple only when the row id is somehow absent keeps this total.
		const lockKey = current.rowId
			? current.source === "mcp"
				? mcpConfigLockKey(current.rowId)
				: workflowIntegrationLockKey(current.rowId)
			: `gitlab-token:${ctx.organizationId ?? "null"}:${ctx.userId}`;
		// Transaction boundary. Nothing this callback decides may be RAISED from
		// inside it: a throw rolls the transaction back, and the two branches
		// below condemn the credential (`markNeedsReauthOnTx` — the enforced
		// `MCPConfig.needsReauth` plus its WorkflowIntegration mirror) before
		// they fail. Thrown from in here, that condemnation is discarded and the
		// dead grant is posted again on the very next call, which is the retry
		// loop the breaker exists to stop. So every decision resolves as a value
		// and the error is re-raised, unchanged, once the write has committed.
		const outcome = await lockClient.$transaction<LockedRefreshOutcome>(
			async (tx) => {
				// $executeRaw (not $queryRaw): pg_advisory_xact_lock() returns `void`,
				// which the Postgres driver adapter's $queryRaw cannot deserialize
				// ("Failed to deserialize column of type 'void'") — that throw aborts
				// the whole refresh transaction. $executeRaw returns a row count and
				// never deserializes columns.
				await tx.$executeRaw`SELECT pg_advisory_xact_lock(${REFRESH_ADVISORY_CLASS}::int, ${advisoryObjectKey(lockKey)}::int)`;
				const reloaded = await loadGitLabToken(tx, ctx);
				if (!reloaded) {
					return {
						ok: false,
						error: new GitLabReauthRequiredError("NO_TOKEN"),
					};
				}
				if (reloaded.needsReauth) {
					return {
						ok: false,
						error: new GitLabReauthRequiredError(),
					};
				}
				if (!isExpiring(reloaded.expiresAt)) {
					// Another process refreshed while we waited for the lock.
					return { ok: true, token: reloaded.accessToken };
				}
				if (!reloaded.refreshToken) {
					// No refresh ciphertext to bind to — same substitution as
					// the pre-read branch above.
					await markNeedsReauthOnTx(tx, ctx, {
						token: reloaded,
						boundTo: "accessToken",
					});
					return {
						ok: false,
						error: new GitLabReauthRequiredError(
							"NO_REFRESH_TOKEN",
						),
					};
				}
				try {
					const refreshed = await refreshAtGitLab(
						reloaded.refreshToken,
						opts?.credentials,
					);
					const gitlabUser = await loadStoredGitLabUser(tx, ctx);
					const persistInput: PersistTokenInput = {
						userId: ctx.userId,
						organizationId: ctx.organizationId,
						token: refreshed,
						gitlabUser,
						// A refresh renews the EXISTING grant; the user authorized
						// nothing new. Both reads above already fail when the
						// primary row is condemned, so the only breaker a reset
						// could reach from here is the `gitlab-official` row's —
						// which this path knows nothing about.
						freshGrant: false,
					};
					// Locked-path exception: the probe runs INSIDE the
					// transaction because the new access token only exists
					// after the in-tx refresh. The lock is only held for
					// rare refresh-needed cases, so the extra in-tx HTTP
					// hop is an acceptable trade for cross-process
					// single-flight.
					const prepared = await prepareTokenWrite(persistInput);
					await persistGitLabTokenOnTx(tx, persistInput, prepared);
					return { ok: true, token: refreshed.accessToken };
				} catch (err) {
					if (err instanceof GitLabReauthRequiredError) {
						// Bound to the refresh token we actually posted — the
						// ciphertext `reloaded` carried out of the in-tx read,
						// since re-encrypting the plaintext would match nothing.
						await markNeedsReauthOnTx(tx, ctx, {
							token: reloaded,
							boundTo: "refreshToken",
						});
						return { ok: false, error: err };
					}
					// Asymmetric ON PURPOSE, and the asymmetry is the point of
					// the whole shape: this is a genuine failure — a dead
					// connection, a missing MCPServer row, a half-written
					// persist — with no verdict to preserve, so rolling back is
					// the correct outcome. Only a condemnation has to survive
					// the transaction.
					throw err;
				}
			},
		);
		if (!outcome.ok) {
			throw outcome.error;
		}
		return outcome.token;
	}

	// Unlocked path: no Prisma client wired (typical for unit tests).
	// Falls through to the existing helpers which open their own
	// `$transaction`. Unchanged from the prior behavior.
	try {
		const refreshed = await refreshAtGitLab(
			current.refreshToken,
			opts?.credentials,
		);
		const gitlabUser = await loadStoredGitLabUser(db, ctx);
		await persistGitLabToken(db, {
			userId: ctx.userId,
			organizationId: ctx.organizationId,
			token: refreshed,
			gitlabUser,
			// Renewal, not a new grant — see the locked branch above.
			freshGrant: false,
		});
		return refreshed.accessToken;
	} catch (err) {
		if (err instanceof GitLabReauthRequiredError) {
			// Same binding as the locked branch: the ciphertext behind the
			// refresh token this path posted.
			await markNeedsReauth(db, ctx, {
				token: current,
				boundTo: "refreshToken",
			});
		}
		throw err;
	}
}

async function loadStoredGitLabUser(
	db: {
		workflowIntegration: { findFirst: (args: unknown) => Promise<unknown> };
	},
	ctx: GitLabTokenCtx,
): Promise<GitLabUserIdentity> {
	const wi = (await db.workflowIntegration.findFirst({
		where: {
			userId: ctx.userId,
			organizationId: ctx.organizationId,
			provider: "GITLAB",
		},
		select: { settings: true },
	})) as { settings: unknown } | null;
	const s = (wi?.settings ?? {}) as Record<string, unknown>;
	return {
		id: typeof s.gitlabUserId === "number" ? s.gitlabUserId : 0,
		username: typeof s.gitlabUsername === "string" ? s.gitlabUsername : "",
		name: typeof s.gitlabName === "string" ? s.gitlabName : "",
		avatarUrl:
			typeof s.gitlabAvatarUrl === "string"
				? (s.gitlabAvatarUrl as string)
				: null,
	};
}
