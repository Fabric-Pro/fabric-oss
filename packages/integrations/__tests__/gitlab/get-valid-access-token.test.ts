import {
	REFRESH_LOCK_DB_HEADROOM_MS,
	REFRESH_LOCK_MAX_WAIT_MS,
	REFRESH_LOCK_TRANSACTION_TIMEOUT_MS,
} from "@repo/database/prisma/queries/lib/refresh-lock-key";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The locked-transaction budget guard measures elapsed time with
// `performance.now()` (monotonic), not `Date.now()`. `vi.setSystemTime()`
// does NOT move `performance.now()` in this project's Vitest/Node
// combination — only `vi.advanceTimersByTime()` moves `Date` and
// `performance.now()` together. So every test below that simulates a lock
// wait uses `vi.advanceTimersByTime()` for that step; `vi.setSystemTime()`
// is used only to pin the initial "now" that `tokenExpiresAt` fixtures are
// computed relative to.

vi.mock("@repo/utils", () => ({
	encryptApiKey: (v: string) => `enc_${v}`,
	decryptApiKey: (v: string) => v.replace("enc_", ""),
}));

/** The transaction-options object every locked `$transaction` call must pass. */
const LOCK_TX_OPTIONS = {
	timeout: REFRESH_LOCK_TRANSACTION_TIMEOUT_MS,
	maxWait: REFRESH_LOCK_MAX_WAIT_MS,
};

describe("locked-transaction budget invariant", () => {
	it("REFRESH_LOCK_TRANSACTION_TIMEOUT_MS covers the one bounded HTTP hop this transaction makes PLUS a full REFRESH_LOCK_DB_HEADROOM_MS of DB round-trips", async () => {
		// getValidGitLabAccessToken's locked branches make exactly ONE bounded
		// HTTP call inside the transaction — the injected `refresh`, which
		// every production caller wires to `refreshGitLabToken`, bounded to
		// GITLAB_TOKEN_EXCHANGE_TIMEOUT_MS. A "timeout > exchange" check alone
		// would pass even with a single millisecond of slack for every DB
		// round-trip the transaction makes — not the real invariant
		// `assertRefreshLockBudget` enforces at runtime. Assert the same
		// arithmetic the guard uses, so a future edit that breaks it fails
		// here instead of only inside a live transaction.
		const { GITLAB_TOKEN_EXCHANGE_TIMEOUT_MS } = await import(
			"../../src/gitlab/oauth-refresh"
		);
		expect(
			REFRESH_LOCK_TRANSACTION_TIMEOUT_MS -
				GITLAB_TOKEN_EXCHANGE_TIMEOUT_MS,
		).toBeGreaterThanOrEqual(REFRESH_LOCK_DB_HEADROOM_MS);
	});
});

const refreshSpy = vi.fn();

describe("getValidGitLabAccessToken", () => {
	beforeEach(() => {
		refreshSpy.mockReset();
		vi.resetModules();
	});

	it("returns existing access token when not near expiry", async () => {
		const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
		const fakeDb = {
			workflowIntegration: {
				findUnique: vi.fn().mockResolvedValue({
					id: "wi_1",
					credentials:
						"enc_" +
						JSON.stringify({
							access_token: "current-token",
							refresh_token: "refresh-token",
						}),
					settings: { tokenExpiresAt: future },
				}),
				update: vi.fn(),
			},
		};

		const { getValidGitLabAccessToken } = await import(
			"../../src/gitlab/get-valid-access-token"
		);
		const token = await getValidGitLabAccessToken({
			db: fakeDb as never,
			integrationId: "wi_1",
			clientId: "id",
			clientSecret: "secret",
			refresh: refreshSpy,
		});
		expect(token).toBe("current-token");
		expect(refreshSpy).not.toHaveBeenCalled();
	});

	it("refreshes when within 60s of expiry", async () => {
		const near = new Date(Date.now() + 30 * 1000).toISOString();
		const updateMock = vi.fn();
		const fakeDb = {
			workflowIntegration: {
				findUnique: vi.fn().mockResolvedValue({
					id: "wi_1",
					credentials:
						"enc_" +
						JSON.stringify({
							access_token: "stale",
							refresh_token: "refresh-token",
						}),
					settings: { tokenExpiresAt: near },
				}),
				update: updateMock,
			},
		};
		refreshSpy.mockResolvedValue({
			access_token: "fresh",
			refresh_token: "refresh-token",
			expires_in: 7200,
		});

		const { getValidGitLabAccessToken } = await import(
			"../../src/gitlab/get-valid-access-token"
		);
		const token = await getValidGitLabAccessToken({
			db: fakeDb as never,
			integrationId: "wi_1",
			clientId: "id",
			clientSecret: "secret",
			refresh: refreshSpy,
		});
		expect(token).toBe("fresh");
		expect(refreshSpy).toHaveBeenCalledTimes(1);
		expect(updateMock).toHaveBeenCalledTimes(1);
	});

	it("refreshes when expiry is unknown (null) and a refresh token exists", async () => {
		const updateMock = vi.fn();
		const fakeDb = {
			workflowIntegration: {
				findUnique: vi.fn().mockResolvedValue({
					id: "wi_1",
					credentials:
						"enc_" +
						JSON.stringify({
							access_token: "maybe-expired",
							refresh_token: "refresh-token",
						}),
					settings: {}, // no tokenExpiresAt
				}),
				update: updateMock,
			},
		};
		refreshSpy.mockResolvedValue({
			access_token: "fresh",
			refresh_token: "refresh-token",
			expires_in: 7200,
		});

		const { getValidGitLabAccessToken } = await import(
			"../../src/gitlab/get-valid-access-token"
		);
		const token = await getValidGitLabAccessToken({
			db: fakeDb as never,
			integrationId: "wi_1",
			clientId: "id",
			clientSecret: "secret",
			refresh: refreshSpy,
		});
		expect(token).toBe("fresh");
		expect(refreshSpy).toHaveBeenCalledTimes(1);
		expect(updateMock).toHaveBeenCalledTimes(1);
	});

	it("returns stored token when expiry unknown and no refresh token (PAT)", async () => {
		const fakeDb = {
			workflowIntegration: {
				findUnique: vi.fn().mockResolvedValue({
					id: "wi_1",
					credentials: `enc_${JSON.stringify({ access_token: "pat-token" })}`,
					settings: {},
				}),
				update: vi.fn(),
			},
		};

		const { getValidGitLabAccessToken } = await import(
			"../../src/gitlab/get-valid-access-token"
		);
		const token = await getValidGitLabAccessToken({
			db: fakeDb as never,
			integrationId: "wi_1",
			clientId: "id",
			clientSecret: "secret",
			refresh: refreshSpy,
		});
		expect(token).toBe("pat-token");
		expect(refreshSpy).not.toHaveBeenCalled();
	});

	it("calls markNeedsReauth when refresh throws GitLabReauthRequiredError", async () => {
		const past = new Date(Date.now() - 60 * 1000).toISOString();
		const updateMock = vi.fn();
		const markNeedsReauthMock = vi.fn().mockResolvedValue(undefined);

		const fakeDb = {
			workflowIntegration: {
				findUnique: vi.fn().mockResolvedValue({
					id: "wi_1",
					credentials:
						"enc_" +
						JSON.stringify({
							access_token: "old-token",
							refresh_token: "dead-refresh",
						}),
					settings: { tokenExpiresAt: past },
				}),
				update: updateMock,
			},
		};

		const { getValidGitLabAccessToken } = await import(
			"../../src/gitlab/get-valid-access-token"
		);
		const { GitLabReauthRequiredError } = await import(
			"../../src/gitlab/oauth-refresh"
		);

		refreshSpy.mockRejectedValueOnce(new GitLabReauthRequiredError());

		await expect(
			getValidGitLabAccessToken({
				db: fakeDb as never,
				integrationId: "wi_1",
				clientId: "id",
				clientSecret: "secret",
				refresh: refreshSpy,
				markNeedsReauth: markNeedsReauthMock,
			}),
		).rejects.toBeInstanceOf(GitLabReauthRequiredError);

		expect(markNeedsReauthMock).toHaveBeenCalledTimes(1);
		expect(markNeedsReauthMock).toHaveBeenCalledWith({
			integrationId: "wi_1",
			source: "user",
		});
		// No row update on failed refresh
		expect(updateMock).not.toHaveBeenCalled();
	});

	it("does NOT call markNeedsReauth on generic refresh failure", async () => {
		const past = new Date(Date.now() - 60 * 1000).toISOString();
		const markNeedsReauthMock = vi.fn().mockResolvedValue(undefined);

		const fakeDb = {
			workflowIntegration: {
				findUnique: vi.fn().mockResolvedValue({
					id: "wi_1",
					credentials:
						"enc_" +
						JSON.stringify({
							access_token: "old-token",
							refresh_token: "refresh",
						}),
					settings: { tokenExpiresAt: past },
				}),
				update: vi.fn(),
			},
		};

		const { getValidGitLabAccessToken } = await import(
			"../../src/gitlab/get-valid-access-token"
		);

		refreshSpy.mockRejectedValueOnce(
			new Error("GitLab token refresh failed: 503"),
		);

		await expect(
			getValidGitLabAccessToken({
				db: fakeDb as never,
				integrationId: "wi_1",
				clientId: "id",
				clientSecret: "secret",
				refresh: refreshSpy,
				markNeedsReauth: markNeedsReauthMock,
			}),
		).rejects.toThrow(/503/);

		expect(markNeedsReauthMock).not.toHaveBeenCalled();
	});

	it("concurrent calls produce a single refresh (lock)", async () => {
		const near = new Date(Date.now() + 5 * 1000).toISOString();
		const fakeDb = {
			workflowIntegration: {
				findUnique: vi.fn().mockResolvedValue({
					id: "wi_1",
					credentials:
						"enc_" +
						JSON.stringify({
							access_token: "stale",
							refresh_token: "refresh-token",
						}),
					settings: { tokenExpiresAt: near },
				}),
				update: vi.fn(),
			},
		};
		refreshSpy.mockImplementation(
			() =>
				new Promise((resolve) =>
					setTimeout(
						() =>
							resolve({
								access_token: "fresh",
								refresh_token: "refresh-token",
								expires_in: 7200,
							}),
						30,
					),
				),
		);

		const { getValidGitLabAccessToken } = await import(
			"../../src/gitlab/get-valid-access-token"
		);
		const args = {
			db: fakeDb as never,
			integrationId: "wi_1",
			clientId: "id",
			clientSecret: "secret",
			refresh: refreshSpy,
		};
		const [a, b, c] = await Promise.all([
			getValidGitLabAccessToken(args),
			getValidGitLabAccessToken(args),
			getValidGitLabAccessToken(args),
		]);
		expect([a, b, c]).toEqual(["fresh", "fresh", "fresh"]);
		expect(refreshSpy).toHaveBeenCalledTimes(1);
	});
});

describe("getValidGitLabAccessToken — source: project", () => {
	beforeEach(() => {
		refreshSpy.mockReset();
		vi.resetModules();
	});

	it("returns project-scoped access token when not near expiry", async () => {
		const future = new Date(Date.now() + 10 * 60 * 1000);
		const fakeDb = {
			workflowIntegration: { findUnique: vi.fn(), update: vi.fn() },
			projectRepositoryIntegration: {
				findUnique: vi.fn().mockResolvedValue({
					id: "pri_1",
					encryptedAccessToken: "enc_proj-token",
					encryptedRefreshToken: "enc_proj-refresh",
					tokenExpiresAt: future,
				}),
				update: vi.fn(),
			},
		};

		const { getValidGitLabAccessToken } = await import(
			"../../src/gitlab/get-valid-access-token"
		);
		const token = await getValidGitLabAccessToken({
			db: fakeDb as never,
			integrationId: "pri_1",
			clientId: "id",
			clientSecret: "secret",
			source: "project",
			refresh: refreshSpy,
		});
		expect(token).toBe("proj-token");
		expect(refreshSpy).not.toHaveBeenCalled();
		expect(fakeDb.workflowIntegration.findUnique).not.toHaveBeenCalled();
	});

	it("refreshes project-scoped token when near expiry", async () => {
		const near = new Date(Date.now() + 30 * 1000);
		const updateManyMock = vi.fn().mockResolvedValue({ count: 1 });
		const fakeDb = {
			workflowIntegration: { findUnique: vi.fn(), update: vi.fn() },
			projectRepositoryIntegration: {
				findUnique: vi.fn().mockResolvedValue({
					id: "pri_1",
					encryptedAccessToken: "enc_stale-proj",
					encryptedRefreshToken: "enc_proj-refresh",
					tokenExpiresAt: near,
				}),
				update: vi.fn(),
				updateMany: updateManyMock,
			},
		};
		refreshSpy.mockResolvedValue({
			access_token: "fresh-proj",
			refresh_token: "new-refresh",
			expires_in: 7200,
		});

		const { getValidGitLabAccessToken } = await import(
			"../../src/gitlab/get-valid-access-token"
		);
		const token = await getValidGitLabAccessToken({
			db: fakeDb as never,
			integrationId: "pri_1",
			clientId: "id",
			clientSecret: "secret",
			source: "project",
			refresh: refreshSpy,
		});
		expect(token).toBe("fresh-proj");
		expect(refreshSpy).toHaveBeenCalledTimes(1);
		expect(updateManyMock).toHaveBeenCalledTimes(1);
		expect(fakeDb.workflowIntegration.findUnique).not.toHaveBeenCalled();
	});

	it("refreshes project-scoped token when expiry is unknown (null)", async () => {
		const updateManyMock = vi.fn().mockResolvedValue({ count: 1 });
		const fakeDb = {
			workflowIntegration: { findUnique: vi.fn(), update: vi.fn() },
			projectRepositoryIntegration: {
				findUnique: vi.fn().mockResolvedValue({
					id: "pri_1",
					encryptedAccessToken: "enc_maybe-expired",
					encryptedRefreshToken: "enc_proj-refresh",
					tokenExpiresAt: null,
				}),
				update: vi.fn(),
				updateMany: updateManyMock,
			},
		};
		refreshSpy.mockResolvedValue({
			access_token: "fresh-proj",
			refresh_token: "new-refresh",
			expires_in: 7200,
		});

		const { getValidGitLabAccessToken } = await import(
			"../../src/gitlab/get-valid-access-token"
		);
		const token = await getValidGitLabAccessToken({
			db: fakeDb as never,
			integrationId: "pri_1",
			clientId: "id",
			clientSecret: "secret",
			source: "project",
			refresh: refreshSpy,
		});
		expect(token).toBe("fresh-proj");
		expect(refreshSpy).toHaveBeenCalledTimes(1);
		expect(updateManyMock).toHaveBeenCalledTimes(1);
	});

	it("throws and does not return a token when updateMany matches 0 rows (concurrent disconnect)", async () => {
		// Simulates: OAuth exchange succeeds but the row was disconnected
		// (tokens wiped) concurrently before the write. The conditional
		// updateMany returns count: 0 — the function must throw, never
		// hand back the refreshed token.
		const near = new Date(Date.now() + 30 * 1000);
		const updateManyMock = vi.fn().mockResolvedValue({ count: 0 });
		const fakeDb = {
			workflowIntegration: { findUnique: vi.fn(), update: vi.fn() },
			projectRepositoryIntegration: {
				findUnique: vi.fn().mockResolvedValue({
					id: "pri_1",
					encryptedAccessToken: "enc_stale-proj",
					encryptedRefreshToken: "enc_proj-refresh",
					tokenExpiresAt: near,
				}),
				update: vi.fn(),
				updateMany: updateManyMock,
			},
		};
		refreshSpy.mockResolvedValue({
			access_token: "fresh-proj",
			refresh_token: "new-refresh",
			expires_in: 7200,
		});

		const { getValidGitLabAccessToken } = await import(
			"../../src/gitlab/get-valid-access-token"
		);
		await expect(
			getValidGitLabAccessToken({
				db: fakeDb as never,
				integrationId: "pri_1",
				clientId: "id",
				clientSecret: "secret",
				source: "project",
				refresh: refreshSpy,
			}),
		).rejects.toThrow(
			"GitLab integration was disconnected during token refresh",
		);

		// Refresh DID run (OAuth exchange happened before the disconnect was detected).
		expect(refreshSpy).toHaveBeenCalledTimes(1);
		// Conditional write was attempted but matched nothing.
		expect(updateManyMock).toHaveBeenCalledTimes(1);
		expect(updateManyMock).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					id: "pri_1",
					status: { not: "DISCONNECTED" },
				}),
			}),
		);
	});
});

describe("getValidGitLabAccessToken — postgres advisory lock", () => {
	beforeEach(() => {
		refreshSpy.mockReset();
		vi.resetModules();
	});

	it("skips the locked $transaction entirely when the outer read shows a fresh token", async () => {
		// Outer pre-read: token still has plenty of life. The locked path
		// must NOT be entered — no transaction, no advisory lock, no
		// roundtrip cost on the hot path.
		const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
		const outerFindUnique = vi.fn().mockResolvedValue({
			id: "wi_1",
			credentials:
				"enc_" +
				JSON.stringify({
					access_token: "fresh",
					refresh_token: "refresh-token",
				}),
			settings: { tokenExpiresAt: future },
		});
		const outerUpdate = vi.fn();
		const txSpy = vi.fn();
		const queryRawSpy = vi.fn();
		const fakePrisma = {
			$queryRaw: queryRawSpy,
			$transaction: txSpy,
		};

		const { getValidGitLabAccessToken } = await import(
			"../../src/gitlab/get-valid-access-token"
		);
		const token = await getValidGitLabAccessToken({
			db: {
				workflowIntegration: {
					findUnique: outerFindUnique,
					update: outerUpdate,
				},
			} as never,
			integrationId: "wi_1",
			clientId: "id",
			clientSecret: "secret",
			refresh: refreshSpy,
			prisma: fakePrisma as never,
		});

		expect(token).toBe("fresh");
		expect(outerFindUnique).toHaveBeenCalledTimes(1);
		// Critical: no $transaction, no advisory lock query, no refresh.
		expect(txSpy).not.toHaveBeenCalled();
		expect(queryRawSpy).not.toHaveBeenCalled();
		expect(refreshSpy).not.toHaveBeenCalled();
		expect(outerUpdate).not.toHaveBeenCalled();
	});

	it("acquires advisory lock and re-reads row when prisma is provided and outer read says refresh-needed", async () => {
		// Outer (pre-lock) read: token expiring, refresh required.
		const near = new Date(Date.now() + 5 * 1000).toISOString();
		// Inner (post-lock) re-read: another process already refreshed —
		// expiry is well in the future and access_token is "fresh".
		const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();

		const outerFindUnique = vi.fn().mockResolvedValue({
			id: "wi_1",
			credentials:
				"enc_" +
				JSON.stringify({
					access_token: "stale",
					refresh_token: "refresh-token",
				}),
			settings: { tokenExpiresAt: near },
		});
		const outerUpdate = vi.fn();

		const txFindUnique = vi.fn().mockResolvedValue({
			id: "wi_1",
			credentials:
				"enc_" +
				JSON.stringify({
					access_token: "fresh",
					refresh_token: "refresh-token",
				}),
			settings: { tokenExpiresAt: future },
		});
		const txUpdate = vi.fn();
		const queryRawSpy = vi.fn().mockResolvedValue(undefined);

		const tx = {
			$executeRaw: queryRawSpy,
			workflowIntegration: {
				findUnique: txFindUnique,
				update: txUpdate,
			},
		};
		const txSpy = vi.fn(async (cb: (t: typeof tx) => Promise<unknown>) =>
			cb(tx),
		);
		const fakePrisma = {
			$queryRaw: vi.fn(),
			$transaction: txSpy,
		};

		const { getValidGitLabAccessToken } = await import(
			"../../src/gitlab/get-valid-access-token"
		);
		const token = await getValidGitLabAccessToken({
			db: {
				workflowIntegration: {
					findUnique: outerFindUnique,
					update: outerUpdate,
				},
			} as never,
			integrationId: "wi_1",
			clientId: "id",
			clientSecret: "secret",
			refresh: refreshSpy,
			prisma: fakePrisma as never,
		});

		expect(token).toBe("fresh");
		// Outer pre-read fired and observed an expiring token.
		expect(outerFindUnique).toHaveBeenCalledTimes(1);
		// TWO advisory locks fire: the legacy single-bigint key first, then the
		// unified two-int key. Postgres treats pg_advisory_xact_lock(int4,int4)
		// and pg_advisory_xact_lock(int8) as SEPARATE lock spaces, so the old
		// form could never block against the other refresh paths — which is
		// exactly how two callers ended up spending the same single-use
		// rotating refresh token. Holding both for the duration of the rolling
		// deploy is what keeps a draining replica (which only knows the legacy
		// key) serialized against a live one.
		expect(queryRawSpy).toHaveBeenCalledTimes(2);
		const legacyArg = queryRawSpy.mock.calls[0][0] as TemplateStringsArray;
		const unifiedArg = queryRawSpy.mock.calls[1][0] as TemplateStringsArray;
		// Legacy MUST be acquired first — that ordering is what makes the
		// double-lock deadlock-free (old replicas take only the legacy key, so
		// nobody ever waits on it while holding the unified one).
		expect(legacyArg.join("")).toMatch(
			/pg_advisory_xact_lock\(hashtext\(::text\)::bigint\)/,
		);
		expect(unifiedArg.join("")).toMatch(
			/pg_advisory_xact_lock\(::int, ::int\)/,
		);
		// Outer write path was NOT used — refresh happens on the tx.
		expect(outerUpdate).not.toHaveBeenCalled();
		// Re-read happened under the lock.
		expect(txFindUnique).toHaveBeenCalledTimes(1);
		// Re-read found a fresh row → refresh skipped.
		expect(refreshSpy).not.toHaveBeenCalled();
		expect(txUpdate).not.toHaveBeenCalled();
		// The explicit budget: without it this transaction runs under Prisma's
		// 5s default, which the injected `refresh` (bounded in production to
		// GITLAB_TOKEN_EXCHANGE_TIMEOUT_MS = 10s) can outrun on its own — see
		// the comment at this call site in get-valid-access-token.ts.
		expect(txSpy.mock.calls[0][1]).toEqual(LOCK_TX_OPTIONS);
	});

	it("refreshes and persists inside the transaction when re-read still needs refresh", async () => {
		const near = new Date(Date.now() + 5 * 1000).toISOString();
		const outerFindUnique = vi.fn().mockResolvedValue({
			id: "wi_1",
			credentials:
				"enc_" +
				JSON.stringify({
					access_token: "stale",
					refresh_token: "refresh-token",
				}),
			settings: { tokenExpiresAt: near },
		});
		const txFindUnique = vi.fn().mockResolvedValue({
			id: "wi_1",
			credentials:
				"enc_" +
				JSON.stringify({
					access_token: "stale",
					refresh_token: "refresh-token",
				}),
			settings: { tokenExpiresAt: near },
		});
		const txUpdate = vi.fn();
		const queryRawSpy = vi.fn().mockResolvedValue(undefined);
		const tx = {
			$executeRaw: queryRawSpy,
			workflowIntegration: {
				findUnique: txFindUnique,
				update: txUpdate,
			},
		};
		const fakePrisma = {
			$queryRaw: vi.fn(),
			$transaction: vi.fn(
				async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
			),
		};

		refreshSpy.mockResolvedValue({
			access_token: "fresh",
			refresh_token: "rotated",
			expires_in: 7200,
		});

		const { getValidGitLabAccessToken } = await import(
			"../../src/gitlab/get-valid-access-token"
		);
		const token = await getValidGitLabAccessToken({
			db: {
				workflowIntegration: {
					findUnique: outerFindUnique,
					update: vi.fn(),
				},
			} as never,
			integrationId: "wi_1",
			clientId: "id",
			clientSecret: "secret",
			refresh: refreshSpy,
			prisma: fakePrisma as never,
		});

		expect(token).toBe("fresh");
		// Legacy + unified advisory locks (see the transitional double-lock).
		expect(queryRawSpy).toHaveBeenCalledTimes(2);
		expect(refreshSpy).toHaveBeenCalledTimes(1);
		expect(txUpdate).toHaveBeenCalledTimes(1);
		expect(fakePrisma.$transaction.mock.calls[0][1]).toEqual(
			LOCK_TX_OPTIONS,
		);
	});

	it("passes the explicit transaction budget on the PROJECT-source locked branch too", async () => {
		// Same asymmetry the defect report describes, on the other branch:
		// `getValidGitLabAccessToken`'s project-source path opens its own
		// `$transaction` and must carry the identical budget. Nothing above
		// exercises the project branch under a real `prisma` double, so this
		// is the only place a regression there (e.g. only fixing the
		// user-source branch) would be caught.
		const near = new Date(Date.now() + 5 * 1000);
		const outerFindUnique = vi.fn().mockResolvedValue({
			id: "pri_1",
			encryptedAccessToken: "enc_stale-proj",
			encryptedRefreshToken: "enc_proj-refresh",
			tokenExpiresAt: near,
		});
		const txFindUnique = vi.fn().mockResolvedValue({
			id: "pri_1",
			encryptedAccessToken: "enc_stale-proj",
			encryptedRefreshToken: "enc_proj-refresh",
			tokenExpiresAt: near,
		});
		const txUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
		const queryRawSpy = vi.fn().mockResolvedValue(undefined);
		const tx = {
			$executeRaw: queryRawSpy,
			projectRepositoryIntegration: {
				findUnique: txFindUnique,
				updateMany: txUpdateMany,
			},
		};
		const txSpy = vi.fn(async (cb: (t: typeof tx) => Promise<unknown>) =>
			cb(tx),
		);
		const fakePrisma = {
			$queryRaw: vi.fn(),
			$transaction: txSpy,
		};

		refreshSpy.mockResolvedValue({
			access_token: "fresh-proj",
			refresh_token: "new-refresh",
			expires_in: 7200,
		});

		const { getValidGitLabAccessToken } = await import(
			"../../src/gitlab/get-valid-access-token"
		);
		const token = await getValidGitLabAccessToken({
			db: {
				workflowIntegration: { findUnique: vi.fn(), update: vi.fn() },
				projectRepositoryIntegration: {
					findUnique: outerFindUnique,
					update: vi.fn(),
				},
			} as never,
			integrationId: "pri_1",
			clientId: "id",
			clientSecret: "secret",
			source: "project",
			refresh: refreshSpy,
			prisma: fakePrisma as never,
		});

		expect(token).toBe("fresh-proj");
		expect(refreshSpy).toHaveBeenCalledTimes(1);
		expect(txUpdateMany).toHaveBeenCalledTimes(1);
		expect(txSpy.mock.calls[0][1]).toEqual(LOCK_TX_OPTIONS);
	});

	it("bails out with RefreshLockBudgetExhaustedError on the PROJECT-source branch when the re-read still needs a refresh and the lock wait already ate the budget", async () => {
		vi.useFakeTimers();
		const start = new Date(2026, 0, 1);
		vi.setSystemTime(start);

		const near = new Date(start.getTime() + 5 * 1000);
		const outerFindUnique = vi.fn().mockResolvedValue({
			id: "pri_1",
			encryptedAccessToken: "enc_stale-proj",
			encryptedRefreshToken: "enc_proj-refresh",
			tokenExpiresAt: near,
		});
		const queryRawSpy = vi.fn().mockImplementation(async () => {
			vi.advanceTimersByTime(15_000);
			return undefined;
		});
		// In-lock re-read: STILL stale — this caller genuinely needs the
		// exchange, so it must reach and trip the guard.
		const txFindUnique = vi.fn().mockResolvedValue({
			id: "pri_1",
			encryptedAccessToken: "enc_stale-proj",
			encryptedRefreshToken: "enc_proj-refresh",
			tokenExpiresAt: near,
		});
		const tx = {
			$executeRaw: queryRawSpy,
			projectRepositoryIntegration: {
				findUnique: txFindUnique,
				updateMany: vi.fn(),
			},
		};
		const fakePrisma = {
			$queryRaw: vi.fn(),
			$transaction: vi.fn(
				async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
			),
		};

		const { getValidGitLabAccessToken } = await import(
			"../../src/gitlab/get-valid-access-token"
		);
		const { RefreshLockBudgetExhaustedError } = await import(
			"@repo/database/prisma/queries/lib/refresh-lock-key"
		);

		const err = await getValidGitLabAccessToken({
			db: {
				workflowIntegration: { findUnique: vi.fn(), update: vi.fn() },
				projectRepositoryIntegration: {
					findUnique: outerFindUnique,
					update: vi.fn(),
				},
			} as never,
			integrationId: "pri_1",
			clientId: "id",
			clientSecret: "secret",
			source: "project",
			refresh: refreshSpy,
			prisma: fakePrisma as never,
		}).catch((e: unknown) => e);

		expect(err).toBeInstanceOf(RefreshLockBudgetExhaustedError);
		expect(txFindUnique).toHaveBeenCalledTimes(1);
		expect(refreshSpy).not.toHaveBeenCalled();

		vi.useRealTimers();
	});

	it("returns the winner's freshly persisted token via the short-circuit on the PROJECT-source branch even when the lock wait already exhausted the budget", async () => {
		vi.useFakeTimers();
		const start = new Date(2026, 0, 1);
		vi.setSystemTime(start);

		const near = new Date(start.getTime() + 5 * 1000);
		const future = new Date(start.getTime() + 60 * 60 * 1000);
		const outerFindUnique = vi.fn().mockResolvedValue({
			id: "pri_1",
			encryptedAccessToken: "enc_stale-proj",
			encryptedRefreshToken: "enc_proj-refresh",
			tokenExpiresAt: near,
		});
		const queryRawSpy = vi.fn().mockImplementation(async () => {
			vi.advanceTimersByTime(15_000);
			return undefined;
		});
		// In-lock re-read: the WINNER's fresh row — no bounded HTTP work
		// needed at all.
		const txFindUnique = vi.fn().mockResolvedValue({
			id: "pri_1",
			encryptedAccessToken: "enc_winner-proj",
			encryptedRefreshToken: "enc_winner-refresh",
			tokenExpiresAt: future,
		});
		const tx = {
			$executeRaw: queryRawSpy,
			projectRepositoryIntegration: {
				findUnique: txFindUnique,
				updateMany: vi.fn(),
			},
		};
		const fakePrisma = {
			$queryRaw: vi.fn(),
			$transaction: vi.fn(
				async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
			),
		};

		const { getValidGitLabAccessToken } = await import(
			"../../src/gitlab/get-valid-access-token"
		);

		const token = await getValidGitLabAccessToken({
			db: {
				workflowIntegration: { findUnique: vi.fn(), update: vi.fn() },
				projectRepositoryIntegration: {
					findUnique: outerFindUnique,
					update: vi.fn(),
				},
			} as never,
			integrationId: "pri_1",
			clientId: "id",
			clientSecret: "secret",
			source: "project",
			refresh: refreshSpy,
			prisma: fakePrisma as never,
		});

		expect(token).toBe("winner-proj");
		expect(refreshSpy).not.toHaveBeenCalled();

		vi.useRealTimers();
	});

	it("bails out with RefreshLockBudgetExhaustedError — never attempting the exchange — when the re-read still needs a refresh and the lock wait already ate the user-branch budget", async () => {
		// Models a waiter that queued behind another process's own refresh
		// (its exchange + DB round-trips) and only acquires the advisory lock
		// deep into its own 20s transaction budget. The IN-LOCK re-read still
		// shows a stale row (unlike the short-circuit tests below), so this
		// caller really is about to start a fresh GITLAB_TOKEN_EXCHANGE_TIMEOUT_MS
		// -bounded exchange — exactly the case the guard exists to stop.
		vi.useFakeTimers();
		const start = new Date(2026, 0, 1);
		vi.setSystemTime(start);

		const near = new Date(start.getTime() + 5 * 1000).toISOString();
		const outerFindUnique = vi.fn().mockResolvedValue({
			id: "wi_1",
			credentials:
				"enc_" +
				JSON.stringify({
					access_token: "stale",
					refresh_token: "refresh-token",
				}),
			settings: { tokenExpiresAt: near },
		});
		const queryRawSpy = vi.fn().mockImplementation(async () => {
			// Simulate a 15s wait for the advisory lock — leaves only 5s of
			// the 20s budget, not enough for a 10s exchange plus DB headroom.
			vi.advanceTimersByTime(15_000);
			return undefined;
		});
		// The in-lock re-read: STILL stale (same near-future expiry, still
		// has a refresh token) — this caller genuinely needs the exchange,
		// so it must reach and trip the guard rather than short-circuiting.
		const txFindUnique = vi.fn().mockResolvedValue({
			id: "wi_1",
			credentials:
				"enc_" +
				JSON.stringify({
					access_token: "stale",
					refresh_token: "refresh-token",
				}),
			settings: { tokenExpiresAt: near },
		});
		const tx = {
			$executeRaw: queryRawSpy,
			workflowIntegration: { findUnique: txFindUnique, update: vi.fn() },
		};
		const fakePrisma = {
			$queryRaw: vi.fn(),
			$transaction: vi.fn(
				async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
			),
		};

		const { getValidGitLabAccessToken } = await import(
			"../../src/gitlab/get-valid-access-token"
		);
		const { RefreshLockBudgetExhaustedError } = await import(
			"@repo/database/prisma/queries/lib/refresh-lock-key"
		);
		const { GitLabReauthRequiredError } = await import(
			"../../src/gitlab/oauth-refresh"
		);

		const err = await getValidGitLabAccessToken({
			db: {
				workflowIntegration: {
					findUnique: outerFindUnique,
					update: vi.fn(),
				},
			} as never,
			integrationId: "wi_1",
			clientId: "id",
			clientSecret: "secret",
			refresh: refreshSpy,
			prisma: fakePrisma as never,
		}).catch((e: unknown) => e);

		expect(err).toBeInstanceOf(RefreshLockBudgetExhaustedError);
		// Transient, not a grant verdict — must never be mistaken for one.
		expect(err).not.toBeInstanceOf(GitLabReauthRequiredError);
		// The re-read DID run (it decided the exchange was still needed);
		// the guard fires right after that, before the exchange itself.
		expect(txFindUnique).toHaveBeenCalledTimes(1);
		expect(refreshSpy).not.toHaveBeenCalled();

		vi.useRealTimers();
	});

	it("returns the winner's freshly persisted token via the short-circuit even when the lock wait already exhausted the user-branch budget", async () => {
		// The budget guard must only gate BOUNDED PROVIDER WORK, never the
		// lock acquisition itself. A waiter that queues behind a legitimate
		// holder and, once it acquires the lock, finds via the re-read above
		// that the winner already persisted a fresh token has no bounded
		// work left to do — gating on the lock wait alone would reject that
		// waiter with RefreshLockBudgetExhaustedError before it ever looked,
		// even though it needed no further budget. This is the common
		// contended case, not the rare one: prove it is NEVER gated.
		vi.useFakeTimers();
		const start = new Date(2026, 0, 1);
		vi.setSystemTime(start);

		const near = new Date(start.getTime() + 5 * 1000).toISOString();
		const future = new Date(start.getTime() + 60 * 60 * 1000).toISOString();
		const outerFindUnique = vi.fn().mockResolvedValue({
			id: "wi_1",
			credentials:
				"enc_" +
				JSON.stringify({
					access_token: "stale",
					refresh_token: "refresh-token",
				}),
			settings: { tokenExpiresAt: near },
		});
		const queryRawSpy = vi.fn().mockImplementation(async () => {
			// Same 15s lock wait as the exhaustion test above — the budget
			// really is gone by the time this caller acquires the lock.
			vi.advanceTimersByTime(15_000);
			return undefined;
		});
		// The in-lock re-read shows the WINNER's fresh token: no bounded HTTP
		// work is needed at all.
		const txFindUnique = vi.fn().mockResolvedValue({
			id: "wi_1",
			credentials:
				"enc_" +
				JSON.stringify({
					access_token: "winner-token",
					refresh_token: "winner-refresh",
				}),
			settings: { tokenExpiresAt: future },
		});
		const tx = {
			$executeRaw: queryRawSpy,
			workflowIntegration: { findUnique: txFindUnique, update: vi.fn() },
		};
		const fakePrisma = {
			$queryRaw: vi.fn(),
			$transaction: vi.fn(
				async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
			),
		};

		const { getValidGitLabAccessToken } = await import(
			"../../src/gitlab/get-valid-access-token"
		);

		const token = await getValidGitLabAccessToken({
			db: {
				workflowIntegration: {
					findUnique: outerFindUnique,
					update: vi.fn(),
				},
			} as never,
			integrationId: "wi_1",
			clientId: "id",
			clientSecret: "secret",
			refresh: refreshSpy,
			prisma: fakePrisma as never,
		});

		expect(token).toBe("winner-token");
		expect(refreshSpy).not.toHaveBeenCalled();

		vi.useRealTimers();
	});

	it("falls back to in-process behavior when prisma is omitted", async () => {
		const near = new Date(Date.now() + 30 * 1000).toISOString();
		const updateMock = vi.fn();
		const fakeDb = {
			workflowIntegration: {
				findUnique: vi.fn().mockResolvedValue({
					id: "wi_1",
					credentials:
						"enc_" +
						JSON.stringify({
							access_token: "stale",
							refresh_token: "refresh-token",
						}),
					settings: { tokenExpiresAt: near },
				}),
				update: updateMock,
			},
		};
		refreshSpy.mockResolvedValue({
			access_token: "fresh",
			refresh_token: "refresh-token",
			expires_in: 7200,
		});

		const { getValidGitLabAccessToken } = await import(
			"../../src/gitlab/get-valid-access-token"
		);
		const token = await getValidGitLabAccessToken({
			db: fakeDb as never,
			integrationId: "wi_1",
			clientId: "id",
			clientSecret: "secret",
			refresh: refreshSpy,
			// no prisma — falls through to the non-transactional path
		});
		expect(token).toBe("fresh");
		expect(refreshSpy).toHaveBeenCalledTimes(1);
		expect(updateMock).toHaveBeenCalledTimes(1);
	});
});

// A caller's pre-exchange gate (Fizzy #2563): consulted under the lock,
// immediately before the exchange, so time the pre-read, the lock wait and the
// re-read consumed counts against the caller's reserve. The in-process single
// flight is shared, so only the caller that starts an exchange is gated: one
// that joins an exchange already under way never attaches its gate to it, and
// one that joins a flight whose leader was refused runs its own.
describe("getValidGitLabAccessToken — a caller's pre-exchange gate", () => {
	const staleRow = () => ({
		id: "pri_1",
		encryptedAccessToken: "enc_stale-proj",
		encryptedRefreshToken: "enc_proj-refresh",
		tokenExpiresAt: new Date(Date.now() + 5 * 1000),
	});
	const refreshed = {
		access_token: "fresh",
		refresh_token: "rotated",
		expires_in: 7200,
	};

	beforeEach(() => {
		refreshSpy.mockReset();
		vi.resetModules();
	});

	function locked(consume: () => void) {
		const txFindUnique = vi.fn().mockResolvedValue(staleRow());
		const updateMany = vi.fn().mockResolvedValue({ count: 1 });
		const tx = {
			$executeRaw: vi.fn().mockImplementationOnce(async () => {
				consume();
				return undefined;
			}),
			projectRepositoryIntegration: {
				findUnique: txFindUnique,
				updateMany,
			},
		};
		const prisma = {
			$queryRaw: vi.fn(),
			$transaction: vi.fn(
				async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
			),
		};
		const db = {
			workflowIntegration: { findUnique: vi.fn(), update: vi.fn() },
			projectRepositoryIntegration: {
				findUnique: vi.fn().mockResolvedValue(staleRow()),
				update: vi.fn(),
				updateMany,
			},
		};
		return { db, prisma, updateMany };
	}

	it("a reserve consumed by the lock wait starts no exchange, and the refusal is thrown unchanged", async () => {
		const refused = new Error("too little time left to exchange");
		let left = 35_000;
		const gate = vi.fn(() => {
			if (left < 30_000) {
				throw refused;
			}
		});
		const { db, prisma, updateMany } = locked(() => {
			left -= 10_000;
		});
		const { getValidGitLabAccessToken } = await import(
			"../../src/gitlab/get-valid-access-token"
		);
		const err = await getValidGitLabAccessToken({
			db: db as never,
			integrationId: "pri_1",
			clientId: "id",
			clientSecret: "secret",
			source: "project",
			refresh: refreshSpy,
			prisma: prisma as never,
			beforeExchange: gate,
		}).catch((e: unknown) => e);
		expect(err).toBe(refused);
		expect(gate).toHaveBeenCalledTimes(1);
		expect(refreshSpy).not.toHaveBeenCalled();
		expect(updateMany).not.toHaveBeenCalled();
	});

	it("exchanges when the gate passes after the lock wait", async () => {
		const gate = vi.fn();
		const { db, prisma } = locked(() => {});
		refreshSpy.mockResolvedValue(refreshed);
		const { getValidGitLabAccessToken } = await import(
			"../../src/gitlab/get-valid-access-token"
		);
		const token = await getValidGitLabAccessToken({
			db: db as never,
			integrationId: "pri_1",
			clientId: "id",
			clientSecret: "secret",
			source: "project",
			refresh: refreshSpy,
			prisma: prisma as never,
			beforeExchange: gate,
		});
		expect(token).toBe("fresh");
		expect(gate).toHaveBeenCalledTimes(1);
		expect(gate.mock.invocationCallOrder[0]).toBeLessThan(
			refreshSpy.mock.invocationCallOrder[0] as number,
		);
	});

	it("never consults the gate for a still-fresh token", async () => {
		const gate = vi.fn(() => {
			throw new Error("must not be consulted");
		});
		const db = {
			workflowIntegration: { findUnique: vi.fn(), update: vi.fn() },
			projectRepositoryIntegration: {
				findUnique: vi.fn().mockResolvedValue({
					...staleRow(),
					tokenExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
				}),
				update: vi.fn(),
			},
		};
		const { getValidGitLabAccessToken } = await import(
			"../../src/gitlab/get-valid-access-token"
		);
		const token = await getValidGitLabAccessToken({
			db: db as never,
			integrationId: "pri_1",
			clientId: "id",
			clientSecret: "secret",
			source: "project",
			refresh: refreshSpy,
			beforeExchange: gate,
		});
		expect(token).toBe("stale-proj");
		expect(gate).not.toHaveBeenCalled();
	});

	/** No `$transaction`: the in-process single flight is the only lock. */
	function unlockedDb() {
		return {
			workflowIntegration: { findUnique: vi.fn(), update: vi.fn() },
			projectRepositoryIntegration: {
				findUnique: vi.fn().mockResolvedValue(staleRow()),
				update: vi.fn(),
				updateMany: vi.fn().mockResolvedValue({ count: 1 }),
			},
		};
	}

	it("a caller joining an exchange already under way is not gated, and its gate is never attached to it", async () => {
		const db = unlockedDb();
		let finish: (value: typeof refreshed) => void = () => {};
		refreshSpy.mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const { getValidGitLabAccessToken } = await import(
			"../../src/gitlab/get-valid-access-token"
		);
		const base = {
			db: db as never,
			integrationId: "pri_1",
			clientId: "id",
			clientSecret: "secret",
			source: "project" as const,
			refresh: refreshSpy,
		};
		const leaderGate = vi.fn();
		const leader = getValidGitLabAccessToken({
			...base,
			beforeExchange: leaderGate,
		});
		await vi.waitFor(() => expect(refreshSpy).toHaveBeenCalledTimes(1));
		const joinerGate = vi.fn(() => {
			throw new Error("the joiner starts no exchange");
		});
		const joiner = getValidGitLabAccessToken({
			...base,
			beforeExchange: joinerGate,
		});
		finish(refreshed);
		expect(await Promise.all([leader, joiner])).toEqual(["fresh", "fresh"]);
		expect(refreshSpy).toHaveBeenCalledTimes(1);
		expect(leaderGate).toHaveBeenCalledTimes(1);
		expect(joinerGate).not.toHaveBeenCalled();
	});

	it("a caller that joined a flight its leader's gate refused runs its own exchange instead of inheriting the refusal", async () => {
		const db = unlockedDb();
		refreshSpy.mockResolvedValue(refreshed);
		const { getValidGitLabAccessToken } = await import(
			"../../src/gitlab/get-valid-access-token"
		);
		const base = {
			db: db as never,
			integrationId: "pri_1",
			clientId: "id",
			clientSecret: "secret",
			source: "project" as const,
			refresh: refreshSpy,
		};
		const refused = new Error("the leader is out of time");
		const leaderGate = vi.fn(() => {
			throw refused;
		});
		const joinerGate = vi.fn();
		const leader = getValidGitLabAccessToken({
			...base,
			beforeExchange: leaderGate,
		}).catch((e: unknown) => e);
		const joiner = getValidGitLabAccessToken({
			...base,
			beforeExchange: joinerGate,
		});
		expect(await leader).toBe(refused);
		expect(await joiner).toBe("fresh");
		expect(joinerGate).toHaveBeenCalledTimes(1);
		expect(refreshSpy).toHaveBeenCalledTimes(1);
	});
});
