import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/utils", () => ({
	encryptApiKey: (v: string) => `enc_${v}`,
	decryptApiKey: (v: string) => v.replace("enc_", ""),
}));

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
