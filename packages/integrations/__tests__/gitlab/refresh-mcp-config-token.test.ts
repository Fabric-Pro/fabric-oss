import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpProbeResult } from "../../src/gitlab/probe-mcp";

// Vitest 4 returns the *same* spy when vi.spyOn() re-wraps an already-spied
// method, so the per-describe `beforeEach` re-spy of globalThis.fetch no
// longer starts with a clean call history. Restore after every test so each
// `vi.spyOn(globalThis, "fetch")` gets a fresh spy (matching v3 behaviour).
afterEach(() => {
	vi.restoreAllMocks();
});

vi.mock("@repo/utils", () => ({
	encryptApiKey: (v: string) => `enc_${v}`,
	decryptApiKey: (v: string) => v.replace("enc_", ""),
	hashApiKey: (v: string) => `hash_${v}`,
}));

// updateMcpConfigTokens is imported from @repo/database; we don't need a real
// implementation here because every test injects its own mock via the
// `updateMcpConfigTokens` arg. Stub the import to avoid pulling Prisma.
vi.mock("@repo/database", () => ({
	updateMcpConfigTokens: vi.fn(),
}));

describe("refreshMcpConfigToken", () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.resetModules();
		fetchSpy = vi.spyOn(globalThis, "fetch");
	});

	it("refreshes the MCPConfig OAuth token and persists the new hash + expiry", async () => {
		fetchSpy.mockResolvedValue(
			new Response(
				JSON.stringify({
					access_token: "new-access",
					refresh_token: "new-refresh",
					expires_in: 7200,
					token_type: "bearer",
					scope: "api",
				}),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			),
		);

		const updateMock = vi.fn().mockResolvedValue(undefined);
		const fakeDb = {
			mCPConfig: {
				findUnique: vi.fn().mockResolvedValue({
					id: "mcp_cfg_1",
					encryptedRefreshToken: "enc_old-refresh",
					oauthClientId: "client-id-123",
					encryptedOauthClientSecret: "enc_secret",
				}),
			},
		};

		const { refreshMcpConfigToken } = await import(
			"../../src/gitlab/refresh-mcp-config-token"
		);

		const token = await refreshMcpConfigToken({
			configId: "mcp_cfg_1",
			db: fakeDb as never,
			updateMcpConfigTokens: updateMock,
		});

		expect(token).toBe("new-access");

		// Persisted with the new hash and expiry
		expect(updateMock).toHaveBeenCalledTimes(1);
		const persistArgs = updateMock.mock.calls[0][0];
		expect(persistArgs.configId).toBe("mcp_cfg_1");
		expect(persistArgs.encryptedAccessToken).toBe("enc_new-access");
		expect(persistArgs.accessTokenHash).toBe("hash_new-access");
		expect(persistArgs.encryptedRefreshToken).toBe("enc_new-refresh");
		expect(persistArgs.tokenExpiresAt).toBeInstanceOf(Date);

		// Used the MCPConfig's own OAuth credentials, not WorkflowIntegration's
		const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		const body = init.body as string;
		expect(body).toContain("grant_type=refresh_token");
		expect(body).toContain("refresh_token=old-refresh");
		expect(body).toContain("client_id=client-id-123");
		expect(body).toContain("client_secret=secret");
	});

	it("preserves the existing refresh token when the response omits one", async () => {
		fetchSpy.mockResolvedValue(
			new Response(
				JSON.stringify({
					access_token: "rotated",
					expires_in: 3600,
				}),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			),
		);

		const updateMock = vi.fn().mockResolvedValue(undefined);
		const fakeDb = {
			mCPConfig: {
				findUnique: vi.fn().mockResolvedValue({
					id: "mcp_cfg_2",
					encryptedRefreshToken: "enc_keep-this",
					oauthClientId: "cid",
					encryptedOauthClientSecret: null,
				}),
			},
		};

		const { refreshMcpConfigToken } = await import(
			"../../src/gitlab/refresh-mcp-config-token"
		);

		await refreshMcpConfigToken({
			configId: "mcp_cfg_2",
			db: fakeDb as never,
			updateMcpConfigTokens: updateMock,
		});

		expect(updateMock.mock.calls[0][0].encryptedRefreshToken).toBe(
			"enc_keep-this",
		);
	});

	it("throws when encryptedRefreshToken is null (reconnect required)", async () => {
		const updateMock = vi.fn();
		const fakeDb = {
			mCPConfig: {
				findUnique: vi.fn().mockResolvedValue({
					id: "mcp_cfg_3",
					encryptedRefreshToken: null,
					oauthClientId: "cid",
					encryptedOauthClientSecret: null,
				}),
			},
		};

		const { refreshMcpConfigToken } = await import(
			"../../src/gitlab/refresh-mcp-config-token"
		);

		await expect(
			refreshMcpConfigToken({
				configId: "mcp_cfg_3",
				db: fakeDb as never,
				updateMcpConfigTokens: updateMock,
			}),
		).rejects.toThrow(/missing refresh credentials/i);

		expect(fetchSpy).not.toHaveBeenCalled();
		expect(updateMock).not.toHaveBeenCalled();
	});

	it("uses the MCPConfig baseUrl origin as the OAuth host (self-hosted)", async () => {
		fetchSpy.mockResolvedValue(
			new Response(
				JSON.stringify({ access_token: "tok", expires_in: 3600 }),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			),
		);

		const updateMock = vi.fn().mockResolvedValue(undefined);
		const fakeDb = {
			mCPConfig: {
				findUnique: vi.fn().mockResolvedValue({
					id: "mcp_cfg_selfhosted",
					encryptedRefreshToken: "enc_r",
					oauthClientId: "cid",
					encryptedOauthClientSecret: "enc_secret",
					baseUrl: "https://gitlab.example.com/api/v4/mcp",
				}),
			},
		};

		const { refreshMcpConfigToken } = await import(
			"../../src/gitlab/refresh-mcp-config-token"
		);

		await refreshMcpConfigToken({
			configId: "mcp_cfg_selfhosted",
			db: fakeDb as never,
			updateMcpConfigTokens: updateMock,
		});

		const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://gitlab.example.com/oauth/token");
	});

	it("falls back to gitlab.com when MCPConfig baseUrl is null", async () => {
		fetchSpy.mockResolvedValue(
			new Response(
				JSON.stringify({ access_token: "tok", expires_in: 3600 }),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			),
		);

		const updateMock = vi.fn().mockResolvedValue(undefined);
		const fakeDb = {
			mCPConfig: {
				findUnique: vi.fn().mockResolvedValue({
					id: "mcp_cfg_no_baseurl",
					encryptedRefreshToken: "enc_r",
					oauthClientId: "cid",
					encryptedOauthClientSecret: "enc_secret",
					baseUrl: null,
				}),
			},
		};

		const { refreshMcpConfigToken } = await import(
			"../../src/gitlab/refresh-mcp-config-token"
		);

		await refreshMcpConfigToken({
			configId: "mcp_cfg_no_baseurl",
			db: fakeDb as never,
			updateMcpConfigTokens: updateMock,
		});

		const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://gitlab.com/oauth/token");
	});

	it("throws without hitting the token endpoint when needsReauth is set (circuit breaker)", async () => {
		// Once the breaker trips, the refresh token is known-dead until the
		// user re-authenticates. Attempting the refresh anyway is what
		// produced the request storm this guard exists to stop. The error
		// TYPE is load-bearing: `resolveGitLabSource` reads it to skip
		// recording another failure against an already-condemned row.
		const updateMock = vi.fn();
		const findUnique = vi.fn().mockResolvedValue({
			id: "mcp_cfg_tripped",
			encryptedRefreshToken: "enc_r",
			oauthClientId: "cid",
			encryptedOauthClientSecret: "enc_secret",
			baseUrl: null,
			needsReauth: true,
		});
		const fakeDb = { mCPConfig: { findUnique } };

		const { refreshMcpConfigToken } = await import(
			"../../src/gitlab/refresh-mcp-config-token"
		);
		const { GitLabRefreshSuppressedError } = await import(
			"../../src/gitlab/oauth-refresh"
		);

		const call = () =>
			refreshMcpConfigToken({
				configId: "mcp_cfg_tripped",
				db: fakeDb as never,
				updateMcpConfigTokens: updateMock,
			});

		await expect(call()).rejects.toThrow(/needs re-authentication/i);
		await expect(call()).rejects.toBeInstanceOf(
			GitLabRefreshSuppressedError,
		);

		expect(fetchSpy).not.toHaveBeenCalled();
		expect(updateMock).not.toHaveBeenCalled();

		// The fake ignores `select`, so assert the real query asks for the
		// column — without it Prisma returns `undefined` and the guard above
		// silently never fires in production.
		const selectArg = findUnique.mock.calls[0][0] as {
			select: Record<string, unknown>;
		};
		expect(selectArg.select.needsReauth).toBe(true);
	});

	it("suppresses rather than reporting a config gap when a condemned row is ALSO missing its credentials", async () => {
		// Ordering matters because the two errors mean different things to the
		// caller: the ordinary one is a failure it records, the suppressed one
		// is a local decline it skips. A condemned row must produce the second
		// whatever else is wrong with it, or a raced caller writes further
		// diagnostics over the ones that explain the condemnation. Bounded in
		// practice — no endpoint is contacted either way — but the breaker is
		// consulted before every other rejection, as in the generic provider.
		const updateMock = vi.fn();
		const fakeDb = {
			mCPConfig: {
				findUnique: vi.fn().mockResolvedValue({
					id: "mcp_cfg_tripped_and_empty",
					encryptedRefreshToken: null,
					oauthClientId: null,
					encryptedOauthClientSecret: null,
					baseUrl: null,
					needsReauth: true,
				}),
			},
		};

		const { refreshMcpConfigToken } = await import(
			"../../src/gitlab/refresh-mcp-config-token"
		);
		const { GitLabRefreshSuppressedError } = await import(
			"../../src/gitlab/oauth-refresh"
		);

		await expect(
			refreshMcpConfigToken({
				configId: "mcp_cfg_tripped_and_empty",
				db: fakeDb as never,
				updateMcpConfigTokens: updateMock,
			}),
		).rejects.toBeInstanceOf(GitLabRefreshSuppressedError);

		expect(fetchSpy).not.toHaveBeenCalled();
		expect(updateMock).not.toHaveBeenCalled();
	});

	it("throws when oauthClientId is null", async () => {
		const updateMock = vi.fn();
		const fakeDb = {
			mCPConfig: {
				findUnique: vi.fn().mockResolvedValue({
					id: "mcp_cfg_4",
					encryptedRefreshToken: "enc_r",
					oauthClientId: null,
					encryptedOauthClientSecret: null,
				}),
			},
		};

		const { refreshMcpConfigToken } = await import(
			"../../src/gitlab/refresh-mcp-config-token"
		);

		await expect(
			refreshMcpConfigToken({
				configId: "mcp_cfg_4",
				db: fakeDb as never,
				updateMcpConfigTokens: updateMock,
			}),
		).rejects.toThrow(/missing refresh credentials/i);
	});
});

describe("refreshMcpConfigToken — rotation-race recovery", () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	/** The config row the first findUnique returns (refresh-creds shape). */
	const raceConfigRow = {
		id: "mcp_race",
		encryptedRefreshToken: "enc_stale-refresh",
		oauthClientId: "cid",
		encryptedOauthClientSecret: "enc_secret",
		baseUrl: null,
		needsReauth: false,
	};

	function invalidGrantResponse() {
		return new Response(JSON.stringify({ error: "invalid_grant" }), {
			status: 400,
			headers: { "content-type": "application/json" },
		});
	}

	function tokenResponse(body: Record<string, unknown>) {
		return new Response(JSON.stringify(body), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}

	beforeEach(() => {
		vi.resetModules();
		fetchSpy = vi.spyOn(globalThis, "fetch");
	});

	it("retries once with the rotated token when a parallel refresh won the race", async () => {
		// GitLab rotates the refresh token on every exchange, so the loser of
		// a concurrent refresh posts a token the winner already spent and gets
		// `invalid_grant` back. That is indistinguishable from a revoked grant
		// to the caller, which condemns the row on exactly this typed error —
		// so the credential must be reloaded and retried before giving up.
		fetchSpy
			.mockResolvedValueOnce(invalidGrantResponse())
			.mockResolvedValueOnce(
				tokenResponse({
					access_token: "post-race",
					refresh_token: "newer-refresh",
					expires_in: 7200,
				}),
			);

		const updateMock = vi.fn().mockResolvedValue(undefined);
		const findUnique = vi
			.fn()
			.mockResolvedValueOnce(raceConfigRow)
			.mockResolvedValueOnce({
				encryptedRefreshToken: "enc_rotated-refresh",
			});
		const fakeDb = { mCPConfig: { findUnique } };

		const { refreshMcpConfigToken } = await import(
			"../../src/gitlab/refresh-mcp-config-token"
		);

		const token = await refreshMcpConfigToken({
			configId: "mcp_race",
			db: fakeDb as never,
			updateMcpConfigTokens: updateMock,
		});

		expect(token).toBe("post-race");
		expect(fetchSpy).toHaveBeenCalledTimes(2);

		// The retry posted the value the winner persisted, not the spent one.
		const [, firstInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(firstInit.body as string).toContain(
			"refresh_token=stale-refresh",
		);
		const [, retryInit] = fetchSpy.mock.calls[1] as [string, RequestInit];
		expect(retryInit.body as string).toContain(
			"refresh_token=rotated-refresh",
		);

		// The reload asks for the column it compares on — without it Prisma
		// returns `undefined` and the recovery silently never fires.
		expect(findUnique).toHaveBeenCalledTimes(2);
		const reloadArgs = findUnique.mock.calls[1][0] as {
			select: Record<string, unknown>;
		};
		expect(reloadArgs.select.encryptedRefreshToken).toBe(true);

		expect(updateMock).toHaveBeenCalledTimes(1);
		expect(updateMock.mock.calls[0][0].encryptedAccessToken).toBe(
			"enc_post-race",
		);
	});

	it("rethrows when the stored refresh token is unchanged (a real revocation)", async () => {
		fetchSpy.mockResolvedValue(invalidGrantResponse());

		const updateMock = vi.fn();
		const findUnique = vi
			.fn()
			.mockResolvedValueOnce(raceConfigRow)
			.mockResolvedValueOnce({
				encryptedRefreshToken: raceConfigRow.encryptedRefreshToken,
			});
		const fakeDb = { mCPConfig: { findUnique } };

		const { refreshMcpConfigToken } = await import(
			"../../src/gitlab/refresh-mcp-config-token"
		);
		const { GitLabReauthRequiredError } = await import(
			"../../src/gitlab/oauth-refresh"
		);

		const rejection = await refreshMcpConfigToken({
			configId: "mcp_race",
			db: fakeDb as never,
			updateMcpConfigTokens: updateMock,
		}).catch((err: unknown) => err);

		expect(rejection).toBeInstanceOf(GitLabReauthRequiredError);
		// The rejection carries the ciphertext of the token it describes, so
		// the writer downstream can gate its `needsReauth` write on the row
		// still holding exactly that value. Here nothing rotated, so it is
		// the token the first load produced.
		expect(
			(rejection as { spentEncryptedRefreshToken?: string })
				.spentEncryptedRefreshToken,
		).toBe("enc_stale-refresh");

		// Nothing rotated, so no second exchange and nothing persisted — the
		// caller's classification condemns the row as before.
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(updateMock).not.toHaveBeenCalled();
	});

	it("does not reload or retry for a non-permanent failure", async () => {
		fetchSpy.mockResolvedValue(
			new Response("upstream boom", { status: 500 }),
		);

		const updateMock = vi.fn();
		const findUnique = vi.fn().mockResolvedValue(raceConfigRow);
		const fakeDb = { mCPConfig: { findUnique } };

		const { refreshMcpConfigToken } = await import(
			"../../src/gitlab/refresh-mcp-config-token"
		);

		await expect(
			refreshMcpConfigToken({
				configId: "mcp_race",
				db: fakeDb as never,
				updateMcpConfigTokens: updateMock,
			}),
		).rejects.toThrow(/token refresh failed: 500/i);

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(findUnique).toHaveBeenCalledTimes(1);
		expect(updateMock).not.toHaveBeenCalled();
	});

	it("persists the reloaded refresh token when the retry response omits one", async () => {
		// Falling back to the token THIS call spent would overwrite the fresh
		// value the winner of the race just stored.
		fetchSpy
			.mockResolvedValueOnce(invalidGrantResponse())
			.mockResolvedValueOnce(
				tokenResponse({ access_token: "post-race", expires_in: 3600 }),
			);

		const updateMock = vi.fn().mockResolvedValue(undefined);
		const findUnique = vi
			.fn()
			.mockResolvedValueOnce(raceConfigRow)
			.mockResolvedValueOnce({
				encryptedRefreshToken: "enc_rotated-refresh",
			});
		const fakeDb = { mCPConfig: { findUnique } };

		const { refreshMcpConfigToken } = await import(
			"../../src/gitlab/refresh-mcp-config-token"
		);

		await refreshMcpConfigToken({
			configId: "mcp_race",
			db: fakeDb as never,
			updateMcpConfigTokens: updateMock,
		});

		expect(updateMock.mock.calls[0][0].encryptedRefreshToken).toBe(
			"enc_rotated-refresh",
		);
	});

	it("does not condemn the grant when the retry loses a SECOND rotation race", async () => {
		// Three concurrent callers on T0: A spends T0→T1; B and C both reload
		// and retry with T1; B spends T1→T2 first, so C is told
		// `invalid_grant` about T1 while T2 is alive on the row. C's rejection
		// is stale evidence about a token that has already been replaced — it
		// must not reach the caller as the error type that trips `needsReauth`
		// on a live grant.
		fetchSpy
			.mockResolvedValueOnce(invalidGrantResponse())
			.mockResolvedValueOnce(invalidGrantResponse());

		const updateMock = vi.fn();
		const findUnique = vi
			.fn()
			.mockResolvedValueOnce(raceConfigRow)
			.mockResolvedValueOnce({
				encryptedRefreshToken: "enc_rotated-refresh",
			})
			.mockResolvedValueOnce({
				encryptedRefreshToken: "enc_rotated-again-refresh",
			});
		const fakeDb = { mCPConfig: { findUnique } };

		const { refreshMcpConfigToken } = await import(
			"../../src/gitlab/refresh-mcp-config-token"
		);
		const { GitLabReauthRequiredError, GitLabRefreshRaceLostError } =
			await import("../../src/gitlab/oauth-refresh");

		const failure = await refreshMcpConfigToken({
			configId: "mcp_race",
			db: fakeDb as never,
			updateMcpConfigTokens: updateMock,
		}).catch((err: unknown) => err);

		expect(failure).toBeInstanceOf(GitLabRefreshRaceLostError);
		// The distinction that matters: callers condemn on this type alone.
		expect(failure).not.toBeInstanceOf(GitLabReauthRequiredError);

		// Exactly one retry, then one more reload to test the evidence — no
		// third exchange, so this cannot loop.
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(findUnique).toHaveBeenCalledTimes(3);
		expect(updateMock).not.toHaveBeenCalled();
	});

	it("rethrows the retry's rejection when the stored token is still the one it posted", async () => {
		// Same shape as above, except nothing rotated while the retry was in
		// flight: the row still holds the token GitLab just rejected, so the
		// evidence is current and the grant really is dead.
		fetchSpy
			.mockResolvedValueOnce(invalidGrantResponse())
			.mockResolvedValueOnce(invalidGrantResponse());

		const updateMock = vi.fn();
		const findUnique = vi
			.fn()
			.mockResolvedValueOnce(raceConfigRow)
			.mockResolvedValue({
				encryptedRefreshToken: "enc_rotated-refresh",
			});
		const fakeDb = { mCPConfig: { findUnique } };

		const { refreshMcpConfigToken } = await import(
			"../../src/gitlab/refresh-mcp-config-token"
		);
		const { GitLabReauthRequiredError } = await import(
			"../../src/gitlab/oauth-refresh"
		);

		const rejection = await refreshMcpConfigToken({
			configId: "mcp_race",
			db: fakeDb as never,
			updateMcpConfigTokens: updateMock,
		}).catch((err: unknown) => err);

		expect(rejection).toBeInstanceOf(GitLabReauthRequiredError);
		// The stamp is the RETRIED token, not the one first loaded — that is
		// the value GitLab passed judgement on, and the only one a
		// condemning write may be gated on.
		expect(
			(rejection as { spentEncryptedRefreshToken?: string })
				.spentEncryptedRefreshToken,
		).toBe("enc_rotated-refresh");

		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(updateMock).not.toHaveBeenCalled();
	});
});

describe("refreshMcpConfigToken — re-probe wiring", () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	/** Returns a mock fetch Response for a successful OAuth token refresh. */
	function makeTokenResponse(accessToken = "new-access") {
		return new Response(
			JSON.stringify({
				access_token: accessToken,
				refresh_token: "new-refresh",
				expires_in: 7200,
				token_type: "bearer",
				scope: "api",
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	}

	/** Base MCPConfig row returned by the first findUnique (refresh-creds shape). */
	const baseConfigRow = {
		id: "mcp-probe-cfg",
		encryptedRefreshToken: "enc_old-refresh",
		oauthClientId: "cid",
		encryptedOauthClientSecret: "enc_secret",
		baseUrl: null,
	};

	/** MCPConfig owner row returned by the second findUnique (select userId/organizationId). */
	const ownerRow = { userId: "u-1", organizationId: null };

	beforeEach(() => {
		vi.resetModules();
		fetchSpy = vi.spyOn(globalThis, "fetch");
	});

	it("preserves useOfficialMcp=true when probe returns network-error (no flip, no delete)", async () => {
		fetchSpy.mockResolvedValue(makeTokenResponse());

		const probe = vi.fn<() => Promise<McpProbeResult>>().mockResolvedValue({
			capable: false,
			status: "network-error",
			httpStatus: null,
		});

		const updateMock = vi.fn().mockResolvedValue(undefined);

		// findUnique is called twice: first for refresh creds, second for owner.
		const findUnique = vi
			.fn()
			.mockResolvedValueOnce(baseConfigRow)
			.mockResolvedValueOnce(ownerRow);

		const wiFindFirst = vi.fn().mockResolvedValueOnce({
			id: "wi-1",
			settings: { useOfficialMcp: true, mcpProbe: null },
			credentials:
				"enc_" +
				JSON.stringify({
					access_token: "old-access",
					refresh_token: "old-refresh",
					token_type: "Bearer",
					scope: "api",
				}),
		});
		const wiUpdate = vi.fn().mockResolvedValue({ id: "wi-1" });
		const mcpDelete = vi.fn();

		const fakeDb = {
			mCPConfig: { findUnique, delete: mcpDelete },
			workflowIntegration: { findFirst: wiFindFirst, update: wiUpdate },
		};

		const { refreshMcpConfigToken } = await import(
			"../../src/gitlab/refresh-mcp-config-token"
		);

		const token = await refreshMcpConfigToken({
			configId: "mcp-probe-cfg",
			db: fakeDb as never,
			updateMcpConfigTokens: updateMock,
			probe,
		});

		expect(token).toBe("new-access");

		// useOfficialMcp preserved (network-error is non-authoritative)
		expect(wiUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					settings: expect.objectContaining({
						useOfficialMcp: true,
						mcpProbe: expect.objectContaining({
							status: "network-error",
						}),
					}),
				}),
			}),
		);

		// No delete because the flag didn't flip to false
		expect(mcpDelete).not.toHaveBeenCalled();
	});

	it("flips useOfficialMcp true → false and deletes the MCPConfig when probe returns not-found", async () => {
		fetchSpy.mockResolvedValue(makeTokenResponse("tok-downgrade"));

		const probe = vi.fn<() => Promise<McpProbeResult>>().mockResolvedValue({
			capable: false,
			status: "not-found",
			httpStatus: 404,
		});

		const updateMock = vi.fn().mockResolvedValue(undefined);

		const findUnique = vi
			.fn()
			.mockResolvedValueOnce(baseConfigRow)
			.mockResolvedValueOnce(ownerRow);

		const wiFindFirst = vi.fn().mockResolvedValueOnce({
			id: "wi-2",
			settings: { useOfficialMcp: true, mcpProbe: null },
			credentials:
				"enc_" +
				JSON.stringify({
					access_token: "old-access",
					refresh_token: "old-refresh",
					token_type: "Bearer",
					scope: "api",
				}),
		});
		const wiUpdate = vi.fn().mockResolvedValue({ id: "wi-2" });
		const mcpDelete = vi.fn().mockResolvedValue(undefined);

		const fakeDb = {
			mCPConfig: { findUnique, delete: mcpDelete },
			workflowIntegration: { findFirst: wiFindFirst, update: wiUpdate },
		};

		const { refreshMcpConfigToken } = await import(
			"../../src/gitlab/refresh-mcp-config-token"
		);

		await refreshMcpConfigToken({
			configId: "mcp-probe-cfg",
			db: fakeDb as never,
			updateMcpConfigTokens: updateMock,
			probe,
		});

		// Flag flipped to false
		expect(wiUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					settings: expect.objectContaining({
						useOfficialMcp: false,
						mcpProbe: expect.objectContaining({
							status: "not-found",
						}),
					}),
				}),
			}),
		);

		// Config deleted because it downgraded
		expect(mcpDelete).toHaveBeenCalledWith({
			where: { id: "mcp-probe-cfg" },
		});
	});

	it("skips probe entirely when workflowIntegration accessor is not provided (back-compat)", async () => {
		fetchSpy.mockResolvedValue(makeTokenResponse("back-compat-tok"));

		const probe = vi.fn<() => Promise<McpProbeResult>>();
		const updateMock = vi.fn().mockResolvedValue(undefined);

		// Only one findUnique call — the original refresh-creds one.
		const findUnique = vi.fn().mockResolvedValue(baseConfigRow);

		const fakeDb = {
			mCPConfig: { findUnique },
			// No workflowIntegration key
		};

		const { refreshMcpConfigToken } = await import(
			"../../src/gitlab/refresh-mcp-config-token"
		);

		const token = await refreshMcpConfigToken({
			configId: "mcp-probe-cfg",
			db: fakeDb as never,
			updateMcpConfigTokens: updateMock,
			probe,
		});

		expect(token).toBe("back-compat-tok");
		// probe must not have been called — no workflowIntegration passed
		expect(probe).not.toHaveBeenCalled();
		// findUnique called only once (for refresh creds)
		expect(findUnique).toHaveBeenCalledTimes(1);
	});

	it("dual-writes refreshed tokens to WorkflowIntegration.credentials and updates tokenExpiresAt in settings", async () => {
		const refreshMock = vi.fn().mockResolvedValue({
			access_token: "new-access-token",
			refresh_token: "new-refresh-token",
			expires_in: 7200,
			token_type: "Bearer",
		});

		const updateMcpConfigTokensMock = vi.fn().mockResolvedValue(undefined);
		const probeMock = vi.fn().mockResolvedValue({
			status: "ok",
			capable: true,
			httpStatus: 200,
		});

		const wiUpdateMock = vi.fn().mockResolvedValue({ id: "wi_1" });

		const fakeDb = {
			mCPConfig: {
				findUnique: vi
					.fn()
					.mockResolvedValueOnce({
						id: "mcp_1",
						encryptedRefreshToken: "enc_old-refresh",
						oauthClientId: "client-id",
						encryptedOauthClientSecret: "enc_client-secret",
						baseUrl: "https://gitlab.com/api/v4/mcp",
					})
					.mockResolvedValueOnce({
						userId: "user_1",
						organizationId: null,
					}),
			},
			workflowIntegration: {
				findFirst: vi.fn().mockResolvedValueOnce({
					id: "wi_1",
					settings: { useOfficialMcp: true },
					credentials:
						"enc_" +
						JSON.stringify({
							access_token: "old-access",
							refresh_token: "old-refresh",
							token_type: "Bearer",
							scope: "api read_user",
						}),
				}),
				update: wiUpdateMock,
			},
		};

		// Stub global fetch (oauth-refresh.ts uses it directly) by passing our
		// refresh implementation via the optional override pattern used in
		// existing tests. If the file uses a different shape, mirror it.
		fetchSpy.mockImplementation(async () => {
			return new Response(JSON.stringify(await refreshMock()), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		const { refreshMcpConfigToken } = await import(
			"../../src/gitlab/refresh-mcp-config-token"
		);

		await refreshMcpConfigToken({
			configId: "mcp_1",
			db: fakeDb as never,
			updateMcpConfigTokens: updateMcpConfigTokensMock,
			probe: probeMock,
		});

		expect(wiUpdateMock).toHaveBeenCalledTimes(1);
		const updateArg = wiUpdateMock.mock.calls[0][0];
		expect(updateArg.where).toEqual({ id: "wi_1" });

		// Settings still updated as before
		expect(updateArg.data.settings).toMatchObject({
			useOfficialMcp: true,
			mcpProbe: expect.objectContaining({ status: "ok" }),
		});
		// NEW: tokenExpiresAt now lives on settings too
		expect(updateArg.data.settings.tokenExpiresAt).toEqual(
			expect.any(String),
		);

		// NEW: credentials blob carries the refreshed tokens
		expect(updateArg.data.credentials).toEqual(
			expect.stringMatching(/^enc_/),
		);
		const decryptedJson = updateArg.data.credentials.replace("enc_", "");
		const parsed = JSON.parse(decryptedJson);
		expect(parsed.access_token).toBe("new-access-token");
		expect(parsed.refresh_token).toBe("new-refresh-token");
		expect(parsed.expires_in).toBe(7200);
		// Preserves fields we didn't refresh
		expect(parsed.token_type).toBe("Bearer");
		expect(parsed.scope).toBe("api read_user");
	});
});
