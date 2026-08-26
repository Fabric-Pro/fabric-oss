import {
	type GitLabIntegrationSettings,
	readUseOfficialMcp,
} from "./integration-settings";
import {
	createGitLabMcpClient,
	type GitLabMcpClient,
	GitLabMcpError,
	GitLabMcpMethodNotFoundError,
} from "./mcp-client";
import {
	GitLabReauthRequiredError,
	GitLabRefreshSuppressedError,
} from "./oauth-refresh";

export type GitLabSource =
	| { kind: "official-mcp"; callTool: GitLabMcpClient["callTool"] }
	| { kind: "rest-adapter"; token: string };

const REFRESH_BUFFER_MS = 60_000;

export interface ResolveGitLabSourceOpts {
	userId: string;
	organizationId: string | null;
	projectId?: string;
	db: {
		mCPConfig: {
			findFirst: (args: {
				where: Record<string, unknown>;
				select: Record<string, unknown>;
			}) => Promise<{
				id: string;
				baseUrl: string | null;
				encryptedAccessToken: string;
				encryptedRefreshToken: string | null;
				tokenExpiresAt: Date | null;
				mcpServer: { defaultUrl: string | null } | null;
			} | null>;
		};
		workflowIntegration: {
			findFirst: (args: {
				where: Record<string, unknown>;
				select: Record<string, unknown>;
			}) => Promise<{ settings: unknown } | null>;
		};
	};
	decrypt: (cipher: string) => string;
	refresh: (configId: string) => Promise<string>;
	getRestToken: (opts: {
		userId: string;
		organizationId: string | null;
		projectId?: string;
	}) => Promise<string | null>;
	/**
	 * Best-effort callback invoked when `refresh()` rejects. Callers wire
	 * this to record the failure, and — only when `reauthRequired` says the
	 * credential is genuinely dead — to flip `MCPConfig.needsReauth=true` so
	 * the Settings reconnect banner surfaces.
	 *
	 * REQUIRED, and deliberately so: it used to be optional, and a caller
	 * that omitted it degraded to REST while persisting nothing, so the very
	 * next request refreshed the same dead token again — the retry storm in
	 * issue #2795. Every production caller passes
	 * `createGitLabRefreshFailureWriter`; a test with no interest in the
	 * failure path should pass an explicit no-op rather than reopen that
	 * hole by omission.
	 *
	 * If this callback itself rejects, the resolver swallows the error: the
	 * REST fallback is the real recovery path and must not be blocked by a DB
	 * outage during the marking step.
	 *
	 * Not invoked at all when `refresh()` declines locally
	 * (`GitLabRefreshSuppressedError`) — no provider contact happened, so
	 * there is no outcome to record against a row the breaker already
	 * condemned.
	 */
	markRefreshFailure: (
		args: {
			mcpConfigId: string;
			error: string;
		} & (
			| {
					/**
					 * True only when the provider positively rejected the grant
					 * — i.e. `refresh()` threw `GitLabReauthRequiredError`
					 * (GitLab answered `invalid_grant` or `invalid_token`),
					 * which no retry can recover. A bare 401/403 does not
					 * qualify: OAuth uses 401 for `invalid_client` too, so the
					 * status alone never proves the user's grant is the thing
					 * that died. False for transient network errors, 5xx
					 * responses, missing/invalid configuration and DB or
					 * encryption failures: none of those say anything about the
					 * credential itself. Also false for
					 * `GitLabRefreshRaceLostError`, where the provider did
					 * reject the token we posted but a concurrent refresh has
					 * already rotated it away — the rejection describes a
					 * credential that no longer exists. Writers must gate
					 * `needsReauth` on this flag — that column is enforced
					 * downstream (a flagged config is refused at MCP client
					 * creation and filtered out of tool discovery), so
					 * condemning on a transient failure hard-blocks a working
					 * integration until the user manually reconnects.
					 *
					 * Typed `boolean` rather than `true` so callers can pass a
					 * computed classification straight through; what this
					 * member forbids is a caller that MIGHT condemn holding no
					 * evidence. Mirrors `RecordRefreshFailureArgs.permanent` in
					 * `@repo/database`, which expresses the same invariant for
					 * the generic providers.
					 */
					reauthRequired: boolean;
					/**
					 * Ciphertext of the refresh token the rejection describes,
					 * as read before it was posted. Writers gate the
					 * `needsReauth` write on the row still holding this exact
					 * value: `reauthRequired` is decided from evidence gathered
					 * before the write, and with providers that rotate on every
					 * exchange (GitLab does) the winning refresh can persist a
					 * live replacement in between.
					 *
					 * Required here, and non-null: the condemning write is
					 * conditional on it, so a condemnation arriving without
					 * one has nothing to bind to and falls back to the
					 * breaker guard alone. Every production rejection carries
					 * one — `refreshMcpConfigToken` stamps the spent
					 * ciphertext on every `GitLabReauthRequiredError` it lets
					 * escape — so requiring it costs no caller anything and
					 * keeps the unbound write out of reach.
					 */
					expectedRefreshToken: string;
			  }
			| {
					/** Transient unless classified — see the sibling member. */
					reauthRequired?: false;
					/**
					 * Accepted but unused, unlike the `never` its
					 * `recordRefreshFailure` counterpart uses: a transient
					 * failure here still POSTED a token, so callers do hold a
					 * row version and there is no reason to make them strip it.
					 * Writers must not put it in the predicate — a network blip
					 * is no evidence about any particular row version.
					 */
					expectedRefreshToken?: string | null;
			  }
		),
	) => Promise<void>;
	now?: () => Date;
}

export async function resolveGitLabSource(
	opts: ResolveGitLabSourceOpts,
): Promise<GitLabSource | null> {
	const now = (opts.now ?? (() => new Date()))().getTime();

	const integration = await opts.db.workflowIntegration.findFirst({
		where: {
			userId: opts.userId,
			organizationId: opts.organizationId,
			provider: "GITLAB",
		},
		select: { settings: true },
	});
	const flag = readUseOfficialMcp(
		integration?.settings as GitLabIntegrationSettings | null | undefined,
	);

	const shouldCheckMcp = flag === true || flag === "legacy";
	const mcpConfig = shouldCheckMcp
		? await opts.db.mCPConfig.findFirst({
				where: {
					userId: opts.userId,
					organizationId: opts.organizationId,
					enabled: true,
					// Two separate exclusions, both landing on the documented
					// REST degradation. A null access token (disconnect or
					// revoke nulled the column) would otherwise reach
					// `decrypt()` as `null` and throw. `needsReauth` marks a
					// row whose refresh token the circuit breaker has already
					// condemned — the column stays populated when it trips, so
					// without this the row is still selected and drives a
					// refresh that can only fail again.
					encryptedAccessToken: { not: null },
					needsReauth: false,
					mcpServer: { key: "gitlab-official" },
				},
				select: {
					id: true,
					baseUrl: true,
					encryptedAccessToken: true,
					encryptedRefreshToken: true,
					tokenExpiresAt: true,
					mcpServer: { select: { defaultUrl: true } },
				},
			})
		: null;

	if (mcpConfig) {
		const serverUrl =
			mcpConfig.baseUrl ?? mcpConfig.mcpServer?.defaultUrl ?? null;
		if (!serverUrl) {
			// No URL at all — treat as not connected, fall through to REST.
			// (This is defensive: a properly seeded gitlab-official server
			// always has defaultUrl, but a corrupt config row could lack both.)
			const restToken = await opts.getRestToken({
				userId: opts.userId,
				organizationId: opts.organizationId,
				projectId: opts.projectId,
			});
			if (restToken) {
				return { kind: "rest-adapter", token: restToken };
			}
			return null;
		}
		// Null tokenExpiresAt means "expiry not recorded" — treat as
		// must-refresh rather than "never expires". Matches the stance in
		// get-valid-access-token.ts:82-86. Defaulting to POSITIVE_INFINITY
		// hid token expiry until callers saw a 401.
		const expiresAt = mcpConfig.tokenExpiresAt?.getTime() ?? 0;
		const unknownExpiry = !mcpConfig.tokenExpiresAt;
		const needsRefresh = expiresAt - now < REFRESH_BUFFER_MS;

		// PAT / legacy short-circuit. When refresh would be triggered but no
		// refresh credential exists AND expiry is unknown, this row is most
		// likely a PAT-style grant or a legacy row whose expiry was never
		// recorded. The stored access token may still be valid — return it
		// directly rather than forcing a doomed refresh. Mirrors the policy
		// in get-valid-access-token.ts:91-100. A KNOWN-expired token with no
		// refresh token would still need reconnect, so we let the
		// refresh-then-fall-through path (below) handle that case so the
		// caller still gets a fresh REST attempt.
		if (needsRefresh && !mcpConfig.encryptedRefreshToken && unknownExpiry) {
			const token = opts.decrypt(mcpConfig.encryptedAccessToken);
			const client = createGitLabMcpClient({ serverUrl, token });
			return { kind: "official-mcp", callTool: client.callTool };
		}

		let token: string;
		if (needsRefresh) {
			try {
				token = await opts.refresh(mcpConfig.id);
			} catch (err) {
				// Refresh failed (revoked grant, expired refresh token, transient
				// DB / encryption failure). Don't bubble as INTERNAL_SERVER_ERROR
				// — fall through to REST so the user keeps working while
				// reconnect is offered out of band.
				const errMessage =
					err instanceof Error ? err.message : String(err);
				// Classify here, where the error object still exists: the
				// callback only receives a string, so a writer downstream
				// could not tell a revoked grant from a network blip.
				const reauthRequired = err instanceof GitLabReauthRequiredError;

				// A suppressed refresh never contacted GitLab: the breaker had
				// already condemned this row and `refresh()` declined locally.
				// There is nothing to record — the `needsReauth: false` filter
				// above normally keeps such a row out of this path entirely,
				// but it loses the race where the flag trips between our
				// select and the refresh's own reload. Skip the marking only;
				// the REST degradation below still runs.
				const suppressed = err instanceof GitLabRefreshSuppressedError;

				// The row version the failure describes. Prefer the value
				// `refresh()` stamped on the error: its rotation-race retry
				// posts a token this resolver never loaded, and the write must
				// be bound to whichever one the provider judged. Our own
				// selected ciphertext is the fallback for every other failure
				// shape.
				const expectedRefreshToken =
					(err instanceof GitLabReauthRequiredError
						? err.spentEncryptedRefreshToken
						: undefined) ?? mcpConfig.encryptedRefreshToken;

				// Best-effort: record the failure, and let the writer flip
				// `MCPConfig.needsReauth=true` when `reauthRequired` says the
				// grant is genuinely dead, so the Settings reconnect banner
				// surfaces. Without that signal the user is permanently
				// degraded to REST with no prompt to reconnect. If marking
				// itself fails (DB outage), swallow — the REST fallback below
				// is the real recovery path.
				if (!suppressed) {
					// A condemnation may only travel with the row version it
					// is bound to, which is why the callback's type refuses
					// `reauthRequired: true` without a ciphertext. Unreachable
					// in production — `refreshMcpConfigToken` stamps every
					// `GitLabReauthRequiredError` it lets escape, and a row
					// holding no refresh token fails earlier with a plain
					// Error — but a custom `refresh()` could still get here, so
					// report it as transient rather than condemn on no
					// evidence. Fail-safe: a row with no refresh token has
					// nothing to re-hammer, so declining costs no retry storm.
					// Logged because a dropped condemnation is otherwise
					// invisible.
					if (reauthRequired && !expectedRefreshToken) {
						console.warn(
							"[gitlab-source] refresh rejection carried no refresh-token ciphertext — recording a transient failure instead of condemning on no evidence",
							{ mcpConfigId: mcpConfig.id },
						);
					}
					try {
						await opts.markRefreshFailure(
							reauthRequired && expectedRefreshToken
								? {
										mcpConfigId: mcpConfig.id,
										error: errMessage,
										reauthRequired,
										expectedRefreshToken,
									}
								: {
										mcpConfigId: mcpConfig.id,
										error: errMessage,
										reauthRequired: false,
										expectedRefreshToken,
									},
						);
					} catch (markErr) {
						console.warn(
							"[gitlab-source] failed to mark MCPConfig needsReauth",
							{
								mcpConfigId: mcpConfig.id,
								markErr:
									markErr instanceof Error
										? markErr.message
										: String(markErr),
							},
						);
					}
				}

				// Capture structured error context (status/code when
				// present) so production triage can distinguish "revoked"
				// from "transient outage".
				const errCtx =
					err && typeof err === "object" && "status" in err
						? {
								status: (err as { status?: number }).status,
								message: errMessage,
							}
						: { message: errMessage };
				console.warn(
					"[gitlab-source] MCP refresh failed; falling through to REST",
					{ mcpConfigId: mcpConfig.id, ...errCtx },
				);

				const restToken = await opts.getRestToken({
					userId: opts.userId,
					organizationId: opts.organizationId,
					projectId: opts.projectId,
				});
				if (restToken) {
					return { kind: "rest-adapter", token: restToken };
				}
				return null;
			}
		} else {
			token = opts.decrypt(mcpConfig.encryptedAccessToken);
		}
		const client = createGitLabMcpClient({
			serverUrl,
			token,
		});
		return { kind: "official-mcp", callTool: client.callTool };
	}
	if (flag === true) {
		// Corrupt state: settings flag says capable but the MCPConfig row
		// we need is missing. Use console.error so production telemetry
		// surfaces this (most log shippers drop warn-level by default).
		// TODO(observability): wire @repo/logs here when the integrations
		// package can take that dep without circulars.
		console.error(
			"[gitlab-source] settings.useOfficialMcp=true but gitlab-official MCPConfig missing — falling back to REST",
		);
	}

	const restToken = await opts.getRestToken({
		userId: opts.userId,
		organizationId: opts.organizationId,
		projectId: opts.projectId,
	});
	if (restToken) {
		return { kind: "rest-adapter", token: restToken };
	}
	return null;
}

/**
 * Call the official GitLab MCP server, falling back to the REST adapter on
 * failure.
 *
 * `idempotent` (default `true`) controls the write-safety of the fallback.
 * For reads, an ambiguous network/parse error after the request was sent is
 * harmless to retry over REST. For WRITES (`idempotent: false`), it is NOT:
 * a network error raised client-side may mean the mutation already landed
 * server-side (the request reached GitLab, the response was lost). Blindly
 * retrying that write over REST would DUPLICATE the mutation (e.g. create a
 * second GitLab issue). So writes only fall back when the server *proves* the
 * call never ran — i.e. a `GitLabMcpMethodNotFoundError` — and otherwise
 * rethrow the ambiguous error for the caller to handle.
 */
export async function callMcpWithRestFallback<T>(args: {
	source: GitLabSource;
	method: string;
	args: Record<string, unknown>;
	restFallback: () => Promise<T>;
	idempotent?: boolean;
}): Promise<T> {
	if (args.source.kind === "rest-adapter") {
		return args.restFallback();
	}
	const idempotent = args.idempotent ?? true;
	try {
		return (await args.source.callTool(args.method, args.args)) as T;
	} catch (err) {
		// Method-not-found proves the call never executed server-side, so a
		// REST retry can never duplicate — always fall back, even for writes.
		if (err instanceof GitLabMcpMethodNotFoundError) {
			console.warn(
				`[gitlab] official MCP missing method ${args.method}, falling back to REST`,
			);
			return args.restFallback();
		}
		// Network/parse errors bubble up as plain Error from fetch. These are
		// ambiguous: the mutation may have landed before the failure. Only
		// fall back when the operation is idempotent; writes rethrow instead
		// to avoid duplicating a mutation that may already have succeeded.
		if (!(err instanceof GitLabMcpError)) {
			if (idempotent) {
				console.warn(
					`[gitlab] official MCP network error on ${args.method}, falling back to REST: ${err instanceof Error ? err.message : String(err)}`,
				);
				return args.restFallback();
			}
			console.warn(
				`[gitlab] official MCP network error on non-idempotent ${args.method}; NOT falling back to REST (avoiding duplicate write): ${err instanceof Error ? err.message : String(err)}`,
			);
			throw err;
		}
		throw err;
	}
}
