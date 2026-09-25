import type { Prisma } from "@repo/database";
import {
	advisoryObjectKey,
	assertRefreshLockBudget,
	REFRESH_ADVISORY_CLASS,
	REFRESH_LOCK_MAX_WAIT_MS,
	REFRESH_LOCK_TRANSACTION_TIMEOUT_MS,
	repoIntegrationLockKey,
	workflowIntegrationLockKey,
} from "@repo/database/prisma/queries/lib/refresh-lock-key";
import { decryptApiKey, encryptApiKey } from "@repo/utils";
import {
	type BeforeExchange,
	isExchangeRefusal,
	runExchangeGate,
} from "../exchange-gate";
import {
	GITLAB_TOKEN_EXCHANGE_TIMEOUT_MS,
	GitLabReauthRequiredError,
	type GitLabRefreshResponse,
} from "./oauth-refresh";

const REFRESH_BUFFER_SECONDS = 60;

export type { GitLabRefreshResponse };

export type GitLabRefreshFn = (
	refreshToken: string,
	clientId: string,
	clientSecret: string,
) => Promise<GitLabRefreshResponse>;

// Per-integration in-flight refresh locks. Prevents concurrent refresh calls
// within a single process.
//
// This is NOT sufficient on its own: GitLab rotates the refresh token on every
// exchange and the old one dies immediately, so two PROCESSES (web + worker, or
// two worker replicas) refreshing the same integration means the loser gets
// `invalid_grant` and — worse — may persist `needsReauth` on a connection that
// a concurrent winner just refreshed perfectly well. An earlier comment here
// claimed "cross-process concurrency is fine, GitLab tolerates redundant
// refresh and the latest call wins"; that is false for a single-use rotating
// grant, and staging showed exactly the predicted `invalid_grant` storm.
// Cross-process safety comes from the Postgres advisory lock below, which is
// now taken by DEFAULT (see `resolveLockClient`).
const inflight: Map<string, Promise<string>> = new Map();

/**
 * Resolve the client used for the cross-process advisory lock.
 *
 * Callers used to have to opt in by passing `prisma`, and almost none did —
 * including the canonical repo-credential resolver and the repo pickers — so
 * the lock existed but was virtually never taken. `db` IS the PrismaClient at
 * every production call site, so default to it and keep the opt-out only for
 * test doubles that cannot support a transaction.
 */
function resolveLockClient(args: {
	db: unknown;
	prisma?: PrismaForLock;
}): PrismaForLock | undefined {
	if (args.prisma) {
		return args.prisma;
	}
	const candidate = args.db as Partial<PrismaForLock> | null;
	return typeof candidate?.$transaction === "function"
		? (candidate as PrismaForLock)
		: undefined;
}

type Source = "user" | "project";

// Minimal db accessor interfaces. These use `args: unknown` / `Promise<unknown>`
// on each method so that the real PrismaClient satisfies the interface
// structurally without requiring every Prisma type parameter to line up.
// The actual call signatures are enforced at the call sites inside this
// function via explicit casts on the resolved values.
interface WorkflowIntegrationAccessor {
	findUnique: (args: unknown) => Promise<unknown>;
	update: (args: unknown) => Promise<unknown>;
}

interface ProjectRepoIntegrationAccessor {
	findUnique: (args: unknown) => Promise<unknown>;
	update: (args: unknown) => Promise<unknown>;
	updateMany: (args: unknown) => Promise<{ count: number }>;
}

// Inner tx-client shape passed to the `$transaction` callback. Deliberately
// narrow — only the accessors used inside the locked body. `$transaction`
// is OMITTED so the type forbids re-opening a nested transaction (Prisma's
// real `TransactionClient` does not expose `$transaction`; calling it would
// throw at runtime).
interface TxClient {
	// $executeRaw (not $queryRaw): the advisory-lock SELECT returns `void`, which
	// the pg driver adapter's $queryRaw cannot deserialize.
	$executeRaw: (
		template: TemplateStringsArray,
		...values: unknown[]
	) => Promise<unknown>;
	workflowIntegration: WorkflowIntegrationAccessor;
	projectRepositoryIntegration?: ProjectRepoIntegrationAccessor;
}

// Loose structural shape of the subset of PrismaClient we need to acquire
// the advisory lock. Kept narrow so tests can stub it with `vi.fn()` and so
// it doesn't pull Prisma generated types into this module's public surface.
interface PrismaForLock {
	$queryRaw: (
		template: TemplateStringsArray,
		...values: unknown[]
	) => Promise<unknown>;
	// `options` must stay part of this type: without it, TypeScript would
	// happily accept a caller that omits `{ timeout, maxWait }` on
	// `$transaction`, silently defaulting every locked refresh to Prisma's
	// 5s interactive-transaction timeout — well under the bounded provider
	// exchange this callback runs INSIDE the transaction. Both locked
	// branches below pass an explicit `{ timeout, maxWait }` budget (see
	// REFRESH_LOCK_TRANSACTION_TIMEOUT_MS in refresh-lock-key.ts). Typed
	// loosely (matches Prisma's own `options?` shape) so a real
	// `PrismaClient` and a `vi.fn()` test double both satisfy this
	// structurally without importing Prisma's generated `$transaction`
	// overloads into this module's public surface.
	$transaction: <T>(
		callback: (tx: TxClient) => Promise<T>,
		options?: { timeout?: number; maxWait?: number },
	) => Promise<T>;
}

export async function getValidGitLabAccessToken(args: {
	db: {
		workflowIntegration: WorkflowIntegrationAccessor;
		projectRepositoryIntegration?: ProjectRepoIntegrationAccessor;
	};
	integrationId: string;
	clientId: string;
	clientSecret: string;
	source?: Source; // default "user"
	/** Injected refresh implementation. Avoids a dep on @repo/api. */
	refresh: GitLabRefreshFn;
	/**
	 * Optional. Called when refresh throws `GitLabReauthRequiredError`
	 * (typically `invalid_grant`) so the caller can persist needsReauth
	 * across MCPConfig + WorkflowIntegration before the error bubbles
	 * to the UI. Mirrors the unified path's markNeedsReauth wiring.
	 */
	markNeedsReauth?: (info: {
		integrationId: string;
		source: Source;
	}) => Promise<void>;
	/**
	 * Prisma client used to acquire the Postgres advisory lock around the
	 * refresh-then-persist block, giving cross-process single-flight.
	 *
	 * Rarely needed: it now DEFAULTS to `db`, which is the real PrismaClient at
	 * every production call site. Pass it explicitly only to override that.
	 * When neither supplies `$transaction` (test doubles), the in-process
	 * `inflight` Map is the only protection — correct for tests, never for
	 * production.
	 */
	prisma?: PrismaForLock;
	/**
	 * The caller's pre-exchange gate (see `BeforeExchange`), consulted under
	 * the lock immediately before the exchange. Only a caller that starts an
	 * exchange is gated: one that joins a flight already under way waits for
	 * it and never attaches its gate to it.
	 */
	beforeExchange?: BeforeExchange;
}): Promise<string> {
	const cacheKey = `${args.source ?? "user"}:${args.integrationId}`;
	const existing = inflight.get(cacheKey);
	if (existing) {
		// Another caller leads this flight under its own gate. When that gate
		// refused, nothing was sent and the refusal is not this caller's:
		// run a flight of its own (the entry is gone by the time the leader's
		// promise settles) rather than inherit it.
		return existing.catch((error: unknown) => {
			if (isExchangeRefusal(error)) {
				return getValidGitLabAccessToken(args);
			}
			throw error;
		});
	}

	// Local helper to avoid duplicating the try/catch + markNeedsReauth dance
	// across the user and project branches. Closes over `args` so callers just
	// pass the refresh token. Defined OUTSIDE the `work` IIFE so it remains in
	// scope for both branches (and stays decoupled from the inflight cache).
	const refreshOrMarkReauth = async (
		refreshToken: string,
	): Promise<GitLabRefreshResponse> => {
		// Every exchange passes here, under the lock on the locked paths and
		// after the lock budget check, so this is immediately before the
		// request. A refusal is thrown before the try: it is never a refresh
		// failure.
		runExchangeGate(args.beforeExchange);
		try {
			return await args.refresh(
				refreshToken,
				args.clientId,
				args.clientSecret,
			);
		} catch (err) {
			if (
				err instanceof GitLabReauthRequiredError &&
				args.markNeedsReauth
			) {
				await args.markNeedsReauth({
					integrationId: args.integrationId,
					source: args.source ?? "user",
				});
			}
			throw err;
		}
	};

	// Lock key from the SHARED builders — not a local string. The "user" source
	// touches the same WorkflowIntegration row that gitlab/index.ts refreshes, so
	// both must address it identically or they land on different lock ids and
	// stop serializing. They previously did exactly that (`user:<id>` here vs
	// `wfint:<id>` there, and in a different Postgres lock space to boot), which
	// let both spend the same single-use rotating refresh token.
	const lockKey =
		(args.source ?? "user") === "project"
			? repoIntegrationLockKey(args.integrationId)
			: workflowIntegrationLockKey(args.integrationId);

	// The key this path used before the unification, kept only for the rolling
	// deploy. It also lived in the single-bigint lock space, which Postgres keeps
	// entirely separate from the two-int space `lockKey` now uses — so a draining
	// replica and a live one would not serialize against each other for the few
	// minutes both are serving. Taking the legacy key first and `lockKey` second
	// closes that window without any deadlock risk: old replicas take only the
	// legacy key, and new replicas always take it before the new one.
	// Remove once this revision is fully rolled out everywhere.
	const legacyLockKey = `${args.source ?? "user"}:${args.integrationId}`;

	const work = (async () => {
		try {
			if ((args.source ?? "user") === "project") {
				if (!args.db.projectRepositoryIntegration) {
					throw new Error(
						"projectRepositoryIntegration accessor missing on db object",
					);
				}

				// Non-tx pre-read first. The lock + transaction are only
				// entered when the outer read says a refresh is needed —
				// otherwise we'd burn a DB roundtrip + advisory lock
				// acquisition on every fresh-token call. Mirrors the
				// ordering in `gitlab-token.ts::getValidGitLabToken`.
				const rawProjectRow =
					await args.db.projectRepositoryIntegration.findUnique({
						where: { id: args.integrationId },
					});
				if (!rawProjectRow) {
					throw new Error(
						`Project GitLab integration ${args.integrationId} not found`,
					);
				}
				const row = rawProjectRow as {
					id: string;
					encryptedAccessToken: string;
					encryptedRefreshToken: string | null;
					tokenExpiresAt: Date | null;
				};

				// Unknown expiry (null) must NOT be treated as "never expires" —
				// GitLab tokens expire ~2h. Refresh when expiring/expired OR
				// when expiry is unknown (be safe).
				const unknownExpiry = !row.tokenExpiresAt;
				const needsRefresh = row.tokenExpiresAt
					? row.tokenExpiresAt.getTime() - Date.now() <
						REFRESH_BUFFER_SECONDS * 1000
					: true;

				if (!needsRefresh) {
					return decryptApiKey(row.encryptedAccessToken);
				}
				if (!row.encryptedRefreshToken) {
					// Can't refresh. Unknown expiry is most likely a PAT — return
					// the stored token as-is. A known-expired token is dead, so
					// surface the reconnect requirement.
					if (unknownExpiry) {
						return decryptApiKey(row.encryptedAccessToken);
					}
					throw new Error(
						"GitLab project token expired and no refresh_token available — reconnect required",
					);
				}

				// Locked path: re-read under advisory lock, double-check
				// needsRefresh, then refresh + persist atomically. Another
				// process that races us will block on the lock and observe
				// the fresh token after our transaction commits.
				const lockClient = resolveLockClient(args);
				if (lockClient) {
					// Explicit budget — REQUIRED, not optional. This transaction
					// holds the advisory lock across `args.refresh(...)`, the
					// injected provider exchange (every production caller wires
					// `refreshGitLabToken`, bounded to
					// GITLAB_TOKEN_EXCHANGE_TIMEOUT_MS = 10s — see
					// oauth-refresh.ts) plus its own DB round-trips (lock
					// acquisition, re-read, persist). Prisma's interactive
					// transaction defaults to a 5s timeout, which the bounded
					// exchange alone can outrun; hitting that default rolls the
					// transaction back and releases the lock WHILE the exchange
					// is still in flight, so the exchange can still succeed at
					// GitLab (rotating and killing the single-use refresh token)
					// while the persist below never runs — the rotated token is
					// lost and the credential gets condemned on the next call.
					// See REFRESH_LOCK_TRANSACTION_TIMEOUT_MS in
					// refresh-lock-key.ts for the general invariant this budget
					// must satisfy.
					return await lockClient.$transaction(
						async (tx) => {
							// Measured from the FIRST statement in the callback —
							// the instant closest to when Prisma arms its `timeout`
							// timer (see REFRESH_LOCK_MAX_WAIT_MS's comment:
							// `maxWait` covers only the pre-callback connection
							// acquisition, never the lock wait below).
							//
							// `performance.now()`, not `Date.now()`: monotonic, so
							// an NTP correction stepping the wall clock backwards
							// mid-transaction can't make elapsed look smaller than
							// it really was. Only the delta between two calls is
							// used, so the different epoch doesn't matter.
							const lockStartedAt = performance.now();
							if (!tx.projectRepositoryIntegration) {
								throw new Error(
									"projectRepositoryIntegration accessor missing on tx",
								);
							}
							await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${legacyLockKey}::text)::bigint)`;
							await tx.$executeRaw`SELECT pg_advisory_xact_lock(${REFRESH_ADVISORY_CLASS}::int, ${advisoryObjectKey(lockKey)}::int)`;

							const rawProjectRowLocked =
								await tx.projectRepositoryIntegration.findUnique(
									{
										where: { id: args.integrationId },
									},
								);
							if (!rawProjectRowLocked) {
								throw new Error(
									`Project GitLab integration ${args.integrationId} not found`,
								);
							}
							const lockedRow = rawProjectRowLocked as {
								id: string;
								encryptedAccessToken: string;
								encryptedRefreshToken: string | null;
								tokenExpiresAt: Date | null;
							};

							const unknownExpiryLocked =
								!lockedRow.tokenExpiresAt;
							const needsRefreshLocked = lockedRow.tokenExpiresAt
								? lockedRow.tokenExpiresAt.getTime() -
										Date.now() <
									REFRESH_BUFFER_SECONDS * 1000
								: true;

							// Every branch above this point returns (or throws)
							// without touching the provider, so none of them are
							// gated: a caller that queued behind a winner and finds
							// — via this re-read — that there is no bounded HTTP
							// work left to do (the row is fresh, or there is no
							// refresh token to exchange) must be able to return
							// immediately, however long the lock wait was. Only
							// the path below, which is actually about to start
							// the exchange, is gated.
							if (!needsRefreshLocked) {
								return decryptApiKey(
									lockedRow.encryptedAccessToken,
								);
							}
							if (!lockedRow.encryptedRefreshToken) {
								if (unknownExpiryLocked) {
									return decryptApiKey(
										lockedRow.encryptedAccessToken,
									);
								}
								throw new Error(
									"GitLab project token expired and no refresh_token available — reconnect required",
								);
							}
							// Gate the upcoming exchange on the budget actually
							// left, not on the fixed constants alone: a waiter
							// that queued behind another refresh's own ~10s
							// exchange can acquire this lock with most of its 20s
							// transaction budget already spent. Starting a fresh
							// exchange it cannot finish reproduces the exact
							// defect this budget exists to prevent. Thrown here —
							// immediately before the only bounded HTTP call this
							// branch makes, and before any try/catch that resolves
							// a decision as a value — so it can only ever roll the
							// transaction back as an ordinary failure; see
							// RefreshLockBudgetExhaustedError's doc for why it
							// must never be treated as a dead-grant verdict.
							assertRefreshLockBudget({
								elapsedMs: performance.now() - lockStartedAt,
								requiredMs: GITLAB_TOKEN_EXCHANGE_TIMEOUT_MS,
							});
							const refreshedLocked = await refreshOrMarkReauth(
								decryptApiKey(lockedRow.encryptedRefreshToken),
							);
							const resultLocked =
								await tx.projectRepositoryIntegration.updateMany(
									{
										where: {
											id: args.integrationId,
											// Never repopulate tokens onto a row that was
											// disconnected (tokens wiped) while the OAuth
											// exchange was in flight — the advisory lock does
											// not block a concurrent disconnect.
											status: { not: "DISCONNECTED" },
										},
										data: {
											encryptedAccessToken: encryptApiKey(
												refreshedLocked.access_token,
											),
											encryptedRefreshToken:
												refreshedLocked.refresh_token
													? encryptApiKey(
															refreshedLocked.refresh_token,
														)
													: null,
											tokenExpiresAt:
												refreshedLocked.expires_in
													? new Date(
															Date.now() +
																refreshedLocked.expires_in *
																	1000,
														)
													: null,
										},
									},
								);
							if (resultLocked.count === 0) {
								throw new Error(
									"GitLab integration was disconnected during token refresh",
								);
							}
							return refreshedLocked.access_token;
						},
						{
							timeout: REFRESH_LOCK_TRANSACTION_TIMEOUT_MS,
							maxWait: REFRESH_LOCK_MAX_WAIT_MS,
						},
					);
				}

				// Unlocked path (no prisma supplied): in-process inflight Map is
				// the only dedupe. Test environments use this path.
				const refreshed = await refreshOrMarkReauth(
					decryptApiKey(row.encryptedRefreshToken),
				);
				const result =
					await args.db.projectRepositoryIntegration.updateMany({
						where: {
							id: args.integrationId,
							// Never repopulate tokens onto a row that was
							// disconnected (tokens wiped) while the OAuth
							// exchange was in flight.
							status: { not: "DISCONNECTED" },
						},
						data: {
							encryptedAccessToken: encryptApiKey(
								refreshed.access_token,
							),
							encryptedRefreshToken: refreshed.refresh_token
								? encryptApiKey(refreshed.refresh_token)
								: null,
							tokenExpiresAt: refreshed.expires_in
								? new Date(
										Date.now() +
											refreshed.expires_in * 1000,
									)
								: null,
						},
					});
				if (result.count === 0) {
					throw new Error(
						"GitLab integration was disconnected during token refresh",
					);
				}
				return refreshed.access_token;
			}

			// source === "user"

			// Non-tx pre-read first; only enter the locked $transaction when
			// the outer read says a refresh is actually needed.
			const rawRow = await args.db.workflowIntegration.findUnique({
				where: { id: args.integrationId },
			});
			if (!rawRow) {
				throw new Error(
					`GitLab integration ${args.integrationId} not found`,
				);
			}
			const wiRow = rawRow as {
				id: string;
				credentials: string;
				settings: unknown;
			};

			const credentials = JSON.parse(
				decryptApiKey(wiRow.credentials),
			) as {
				access_token: string;
				refresh_token?: string;
			};
			const settings = (wiRow.settings ?? {}) as {
				tokenExpiresAt?: string | null;
			};

			// Unknown expiry (null) must NOT be treated as "never expires" —
			// GitLab tokens expire ~2h. Refresh when expiring/expired OR when
			// expiry is unknown (be safe).
			const unknownExpiry = !settings.tokenExpiresAt;
			const needsRefresh =
				unknownExpiry ||
				new Date(settings.tokenExpiresAt as string).getTime() -
					Date.now() <
					REFRESH_BUFFER_SECONDS * 1000;

			if (!needsRefresh) {
				return credentials.access_token;
			}
			if (!credentials.refresh_token) {
				// Can't refresh. Unknown expiry is most likely a PAT — return the
				// stored token as-is. A known-expired token is dead, so surface
				// the reconnect requirement.
				if (unknownExpiry) {
					return credentials.access_token;
				}
				throw new Error(
					"GitLab token expired and no refresh_token available — reconnect required",
				);
			}

			// Locked path: re-read under advisory lock, double-check
			// needsRefresh, then refresh + persist atomically.
			const lockClient = resolveLockClient(args);
			if (lockClient) {
				// Same explicit budget as the project branch above, and for the
				// same reason: this transaction holds the advisory lock across
				// `args.refresh(...)` (bounded to GITLAB_TOKEN_EXCHANGE_TIMEOUT_MS
				// = 10s at every production call site) plus its own DB
				// round-trips. Omitting it runs under Prisma's 5s ITX default,
				// which the exchange alone can outrun — the transaction rolls
				// back and releases the lock mid-exchange, losing the freshly
				// rotated single-use refresh token. See
				// REFRESH_LOCK_TRANSACTION_TIMEOUT_MS in refresh-lock-key.ts.
				return await lockClient.$transaction(
					async (tx) => {
						// Measured from the FIRST statement in the callback — see
						// the project branch above for why, and for why it's
						// `performance.now()` rather than `Date.now()`.
						const lockStartedAt = performance.now();
						await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${legacyLockKey}::text)::bigint)`;
						await tx.$executeRaw`SELECT pg_advisory_xact_lock(${REFRESH_ADVISORY_CLASS}::int, ${advisoryObjectKey(lockKey)}::int)`;

						const rawRowLocked =
							await tx.workflowIntegration.findUnique({
								where: { id: args.integrationId },
							});
						if (!rawRowLocked) {
							throw new Error(
								`GitLab integration ${args.integrationId} not found`,
							);
						}
						const wiRowLocked = rawRowLocked as {
							id: string;
							credentials: string;
							settings: unknown;
						};

						const credentialsLocked = JSON.parse(
							decryptApiKey(wiRowLocked.credentials),
						) as {
							access_token: string;
							refresh_token?: string;
						};
						const settingsLocked = (wiRowLocked.settings ?? {}) as {
							tokenExpiresAt?: string | null;
						};

						const unknownExpiryLocked =
							!settingsLocked.tokenExpiresAt;
						const needsRefreshLocked =
							unknownExpiryLocked ||
							new Date(
								settingsLocked.tokenExpiresAt as string,
							).getTime() -
								Date.now() <
								REFRESH_BUFFER_SECONDS * 1000;

						// Every branch above this point returns (or throws) without
						// touching the provider — see the project branch's
						// comment for the full rationale. None of them are
						// gated; only the exchange below is.
						if (!needsRefreshLocked) {
							// Another process already refreshed while we waited.
							return credentialsLocked.access_token;
						}
						if (!credentialsLocked.refresh_token) {
							if (unknownExpiryLocked) {
								return credentialsLocked.access_token;
							}
							throw new Error(
								"GitLab token expired and no refresh_token available — reconnect required",
							);
						}

						// Gate the exchange on the budget actually left,
						// immediately before the only bounded HTTP call this
						// branch makes — see the project branch's comment for
						// the full rationale and why this must be, and is,
						// outside any try/catch that resolves a decision as a
						// value.
						assertRefreshLockBudget({
							elapsedMs: performance.now() - lockStartedAt,
							requiredMs: GITLAB_TOKEN_EXCHANGE_TIMEOUT_MS,
						});
						const refreshedLocked = await refreshOrMarkReauth(
							credentialsLocked.refresh_token,
						);

						const newCredentialsLocked = JSON.stringify({
							access_token: refreshedLocked.access_token,
							refresh_token:
								refreshedLocked.refresh_token ??
								credentialsLocked.refresh_token,
							token_type: refreshedLocked.token_type,
							scope: refreshedLocked.scope,
							expires_in: refreshedLocked.expires_in,
							created_at: refreshedLocked.created_at,
							token_obtained_at: new Date().toISOString(),
						});
						const newExpiresAtLocked = refreshedLocked.expires_in
							? new Date(
									Date.now() +
										refreshedLocked.expires_in * 1000,
								).toISOString()
							: null;

						await tx.workflowIntegration.update({
							where: { id: args.integrationId },
							data: {
								credentials:
									encryptApiKey(newCredentialsLocked),
								settings: {
									...(settingsLocked as Record<
										string,
										unknown
									>),
									tokenExpiresAt: newExpiresAtLocked,
								} as Prisma.InputJsonValue,
							},
						});

						return refreshedLocked.access_token;
					},
					{
						timeout: REFRESH_LOCK_TRANSACTION_TIMEOUT_MS,
						maxWait: REFRESH_LOCK_MAX_WAIT_MS,
					},
				);
			}

			// Unlocked path (no prisma supplied): in-process inflight Map is the
			// only dedupe. Test environments use this path.
			const refreshed = await refreshOrMarkReauth(
				credentials.refresh_token,
			);

			const newCredentials = JSON.stringify({
				access_token: refreshed.access_token,
				refresh_token:
					refreshed.refresh_token ?? credentials.refresh_token,
				token_type: refreshed.token_type,
				scope: refreshed.scope,
				expires_in: refreshed.expires_in,
				created_at: refreshed.created_at,
				token_obtained_at: new Date().toISOString(),
			});
			const newExpiresAt = refreshed.expires_in
				? new Date(
						Date.now() + refreshed.expires_in * 1000,
					).toISOString()
				: null;

			await args.db.workflowIntegration.update({
				where: { id: args.integrationId },
				data: {
					credentials: encryptApiKey(newCredentials),
					settings: {
						...(settings as Record<string, unknown>),
						tokenExpiresAt: newExpiresAt,
					} as Prisma.InputJsonValue,
				},
			});

			return refreshed.access_token;
		} finally {
			inflight.delete(cacheKey);
		}
	})();

	inflight.set(cacheKey, work);
	return work;
}
