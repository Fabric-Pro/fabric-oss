import { describe, expect, it, vi } from "vitest";
import {
	GitLabMcpError,
	GitLabMcpMethodNotFoundError,
} from "../../src/gitlab/mcp-client";
import {
	GitLabReauthRequiredError,
	GitLabRefreshSuppressedError,
} from "../../src/gitlab/oauth-refresh";
import {
	callMcpWithRestFallback,
	type GitLabSource,
	resolveGitLabSource,
} from "../../src/gitlab/source";

const baseDeps = {
	now: () => new Date("2026-05-15T12:00:00Z"),
	// `markRefreshFailure` is required: a caller that omitted it degraded to
	// REST while persisting nothing, so the next request refreshed the same
	// dead token again (issue #2795). Cases that never reach the failure path
	// take this explicit no-op; the ones that assert on the writer pass their
	// own AFTER the spread.
	markRefreshFailure: async () => {},
};

function makeDb(opts: {
	mcpConfig?: {
		id: string;
		baseUrl: string | null;
		encryptedAccessToken: string;
		encryptedRefreshToken?: string | null;
		tokenExpiresAt: Date | null;
		mcpServer: { defaultUrl: string | null } | null;
	} | null;
}) {
	const mcpConfig = opts.mcpConfig
		? {
				// Default to a refresh token being present so existing tests
				// (which assert opts.refresh runs) keep their original
				// behavior. New tests that exercise the PAT short-circuit
				// pass `encryptedRefreshToken: null` explicitly.
				encryptedRefreshToken: "enc:refresh",
				...opts.mcpConfig,
			}
		: null;
	return {
		mCPConfig: {
			findFirst: vi.fn(async () => mcpConfig ?? null),
		},
		// Returning null → settings absent → flag === "legacy" → today's MCPConfig-wins behavior
		workflowIntegration: {
			findFirst: vi.fn(async () => null),
		},
	};
}

describe("resolveGitLabSource", () => {
	it("returns official-mcp when an enabled gitlab-official config exists (uses baseUrl)", async () => {
		const db = makeDb({
			mcpConfig: {
				id: "cfg1",
				baseUrl: "https://custom.gitlab.com/api/v4/mcp",
				encryptedAccessToken: "enc:abc",
				tokenExpiresAt: new Date("2026-05-15T13:00:00Z"),
				mcpServer: { defaultUrl: "https://gitlab.com/api/v4/mcp" },
			},
		});
		const refresh = vi.fn(async () => "should-not-be-called");
		const src = await resolveGitLabSource({
			userId: "u1",
			organizationId: null,
			db: db as never,
			decrypt: () => "decrypted-token",
			refresh,
			getRestToken: async () => null,
			...baseDeps,
		});
		expect(src?.kind).toBe("official-mcp");
		expect(refresh).not.toHaveBeenCalled();
	});

	it("returns official-mcp using mcpServer.defaultUrl when baseUrl is null", async () => {
		const db = makeDb({
			mcpConfig: {
				id: "cfg1",
				baseUrl: null,
				encryptedAccessToken: "enc:abc",
				tokenExpiresAt: new Date("2026-05-15T13:00:00Z"),
				mcpServer: { defaultUrl: "https://gitlab.com/api/v4/mcp" },
			},
		});
		const refresh = vi.fn(async () => "should-not-be-called");
		const src = await resolveGitLabSource({
			userId: "u1",
			organizationId: null,
			db: db as never,
			decrypt: () => "decrypted-token",
			refresh,
			getRestToken: async () => null,
			...baseDeps,
		});
		expect(src?.kind).toBe("official-mcp");
		expect(refresh).not.toHaveBeenCalled();
	});

	it("falls through to REST when both baseUrl and mcpServer.defaultUrl are null but a REST token is available", async () => {
		const db = makeDb({
			mcpConfig: {
				id: "cfg1",
				baseUrl: null,
				encryptedAccessToken: "enc:abc",
				tokenExpiresAt: new Date("2026-05-15T13:00:00Z"),
				mcpServer: { defaultUrl: null },
			},
		});
		const src = await resolveGitLabSource({
			userId: "u1",
			organizationId: null,
			db: db as never,
			decrypt: () => "decrypted-token",
			refresh: async () => {
				throw new Error("should not refresh");
			},
			getRestToken: async () => "wi-token",
			...baseDeps,
		});
		expect(src).toEqual({ kind: "rest-adapter", token: "wi-token" });
	});

	it("returns null when both baseUrl and mcpServer.defaultUrl are null and no REST token", async () => {
		const db = makeDb({
			mcpConfig: {
				id: "cfg1",
				baseUrl: null,
				encryptedAccessToken: "enc:abc",
				tokenExpiresAt: new Date("2026-05-15T13:00:00Z"),
				mcpServer: null,
			},
		});
		const src = await resolveGitLabSource({
			userId: "u1",
			organizationId: null,
			db: db as never,
			decrypt: () => "decrypted-token",
			refresh: async () => {
				throw new Error("should not refresh");
			},
			getRestToken: async () => null,
			...baseDeps,
		});
		expect(src).toBeNull();
	});

	it("falls back to rest-adapter when no MCP config but WI token present", async () => {
		const db = makeDb({});
		const src = await resolveGitLabSource({
			userId: "u1",
			organizationId: null,
			db: db as never,
			decrypt: () => "decrypted-token",
			refresh: async () => {
				throw new Error("should not refresh");
			},
			getRestToken: async () => "wi-token",
			...baseDeps,
		});
		expect(src).toEqual({ kind: "rest-adapter", token: "wi-token" });
	});

	it("returns null when no source is connected", async () => {
		const db = makeDb({});
		const src = await resolveGitLabSource({
			userId: "u1",
			organizationId: null,
			db: db as never,
			decrypt: () => "decrypted-token",
			refresh: async () => {
				throw new Error("should not refresh");
			},
			getRestToken: async () => null,
			...baseDeps,
		});
		expect(src).toBeNull();
	});

	it("filters out MCPConfig rows with null encryptedAccessToken (needs-reauth)", async () => {
		const db = makeDb({});
		const findFirstSpy = db.mCPConfig.findFirst;
		await resolveGitLabSource({
			userId: "u1",
			organizationId: null,
			db: db as never,
			decrypt: () => "decrypted-token",
			refresh: async () => {
				throw new Error("should not refresh");
			},
			getRestToken: async () => null,
			...baseDeps,
		});
		const callArg = findFirstSpy.mock.calls[0][0] as {
			where: Record<string, unknown>;
		};
		// The where-clause must exclude rows with null tokens so the
		// resolver never decrypts null and instead falls through to REST.
		expect(callArg.where.encryptedAccessToken).toEqual({ not: null });
	});

	it("filters out MCPConfig rows the refresh circuit breaker has tripped (needsReauth)", async () => {
		// Tripping the breaker leaves encryptedAccessToken populated, so the
		// null-token filter alone still selects the row and drives a refresh
		// that can only fail again. The row must be excluded outright and the
		// caller degraded to REST.
		const db = makeDb({});
		const findFirstSpy = db.mCPConfig.findFirst;
		const refresh = vi.fn(async () => {
			throw new Error("should not refresh a condemned config");
		});
		const src = await resolveGitLabSource({
			userId: "u1",
			organizationId: null,
			db: db as never,
			decrypt: () => "decrypted-token",
			refresh,
			getRestToken: async () => "rest-token",
			...baseDeps,
		});
		const callArg = findFirstSpy.mock.calls[0][0] as {
			where: Record<string, unknown>;
		};
		expect(callArg.where.needsReauth).toBe(false);
		expect(src).toEqual({ kind: "rest-adapter", token: "rest-token" });
		expect(refresh).not.toHaveBeenCalled();
	});

	it("treats null tokenExpiresAt as 'must refresh' and invokes opts.refresh", async () => {
		// Legacy MCPConfig rows whose expiry was never recorded must NOT
		// self-classify as "never expires" — that hides token expiry until a
		// 401 surfaces. Null expiry must trigger refresh, matching the stance
		// in get-valid-access-token.ts:82-86.
		const db = makeDb({
			mcpConfig: {
				id: "cfg-null-expiry",
				baseUrl: null,
				encryptedAccessToken: "enc:abc",
				tokenExpiresAt: null,
				mcpServer: { defaultUrl: "https://gitlab.com/api/v4/mcp" },
			},
		});
		const refresh = vi.fn(async () => "fresh-token");
		const decrypt = vi.fn(() => "decrypted-token");
		const src = await resolveGitLabSource({
			userId: "u1",
			organizationId: null,
			db: db as never,
			decrypt,
			refresh,
			getRestToken: async () => null,
			...baseDeps,
		});
		expect(src?.kind).toBe("official-mcp");
		expect(refresh).toHaveBeenCalledOnce();
		expect(refresh).toHaveBeenCalledWith("cfg-null-expiry");
		expect(decrypt).not.toHaveBeenCalled();
	});

	it("falls through to REST adapter when MCP refresh rejects", async () => {
		// A rejected refresh (revoked grant, dead refresh token, transient DB
		// error) must not bubble as INTERNAL_SERVER_ERROR — the resolver
		// should degrade to the REST adapter if a WI token is available.
		const db = makeDb({
			mcpConfig: {
				id: "cfg-refresh-fails",
				baseUrl: null,
				encryptedAccessToken: "enc:abc",
				tokenExpiresAt: new Date("2026-05-15T11:00:00Z"), // expired
				mcpServer: { defaultUrl: "https://gitlab.com/api/v4/mcp" },
			},
		});
		const refresh = vi.fn(async () => {
			throw new Error("refresh-revoked");
		});
		const getRestToken = vi.fn(async () => "rest-fallback-token");
		const src = await resolveGitLabSource({
			userId: "u1",
			organizationId: null,
			db: db as never,
			decrypt: () => "decrypted-token",
			refresh,
			getRestToken,
			...baseDeps,
		});
		expect(src).toEqual({
			kind: "rest-adapter",
			token: "rest-fallback-token",
		});
		expect(refresh).toHaveBeenCalledOnce();
		expect(getRestToken).toHaveBeenCalledOnce();
	});

	it("returns the stored access token when expiry is unknown AND no refresh credential (PAT / legacy row)", async () => {
		// Sequence we want to preserve: tokenExpiresAt=null,
		// encryptedAccessToken=valid, encryptedRefreshToken=null. The old
		// code computed `expiresAt = 0`, set `needsRefresh = true`, called
		// `opts.refresh` which threw "no refresh token", and silently
		// degraded to REST — losing the still-valid access token. Mirror
		// get-valid-access-token.ts:91-100: return the stored token as-is.
		const db = makeDb({
			mcpConfig: {
				id: "cfg-pat",
				baseUrl: null,
				encryptedAccessToken: "enc:abc",
				encryptedRefreshToken: null,
				tokenExpiresAt: null,
				mcpServer: { defaultUrl: "https://gitlab.com/api/v4/mcp" },
			},
		});
		const refresh = vi.fn(async () => {
			throw new Error("should not refresh PAT");
		});
		const decrypt = vi.fn(() => "stored-token");
		const src = await resolveGitLabSource({
			userId: "u1",
			organizationId: null,
			db: db as never,
			decrypt,
			refresh,
			getRestToken: async () => null,
			...baseDeps,
		});
		expect(src?.kind).toBe("official-mcp");
		expect(refresh).not.toHaveBeenCalled();
		expect(decrypt).toHaveBeenCalledWith("enc:abc");
	});

	it("reports a transient MCP refresh failure with reauthRequired=false", async () => {
		// A plain Error means the refresh failed for a reason that says
		// nothing about the credential (network blip, 5xx, DB outage).
		// `needsReauth` is enforced downstream — a flagged config is refused
		// at MCP client creation — so the resolver must not let a writer
		// condemn on this. The failure is still reported so the diagnostic
		// columns keep recording it (they are diagnostics only — no writer
		// evaluates a threshold, so this never escalates on its own).
		const db = makeDb({
			mcpConfig: {
				id: "cfg-transient",
				baseUrl: null,
				encryptedAccessToken: "enc:abc",
				encryptedRefreshToken: "enc:refresh",
				tokenExpiresAt: new Date("2026-05-15T11:00:00Z"), // expired
				mcpServer: { defaultUrl: "https://gitlab.com/api/v4/mcp" },
			},
		});
		const refresh = vi.fn(async () => {
			throw new Error("GitLab token refresh failed: 503");
		});
		const markRefreshFailure = vi.fn(async () => {});
		const getRestToken = vi.fn(async () => "rest-token");

		const src = await resolveGitLabSource({
			userId: "u1",
			organizationId: null,
			db: db as never,
			decrypt: () => "decrypted-token",
			refresh,
			getRestToken,
			...baseDeps,
			markRefreshFailure,
		});

		expect(src).toEqual({ kind: "rest-adapter", token: "rest-token" });
		expect(markRefreshFailure).toHaveBeenCalledOnce();
		expect(markRefreshFailure).toHaveBeenCalledWith({
			mcpConfigId: "cfg-transient",
			error: "GitLab token refresh failed: 503",
			reauthRequired: false,
			expectedRefreshToken: "enc:refresh",
		});
	});

	it("reports a revoked grant with reauthRequired=true", async () => {
		// GitLabReauthRequiredError is thrown only when GitLab answered
		// `invalid_grant` or `invalid_token` — the two signals that no retry
		// can recover, and therefore the only ones that may condemn the
		// credential. A bare 401/403 does not qualify. The Settings reconnect
		// banner is gated on the resulting needsReauth.
		const db = makeDb({
			mcpConfig: {
				id: "cfg-revoked",
				baseUrl: null,
				encryptedAccessToken: "enc:abc",
				encryptedRefreshToken: "enc:refresh",
				tokenExpiresAt: new Date("2026-05-15T11:00:00Z"), // expired
				mcpServer: { defaultUrl: "https://gitlab.com/api/v4/mcp" },
			},
		});
		const refresh = vi.fn(async () => {
			throw new GitLabReauthRequiredError();
		});
		const markRefreshFailure = vi.fn(async () => {});
		const getRestToken = vi.fn(async () => "rest-token");

		const src = await resolveGitLabSource({
			userId: "u1",
			organizationId: null,
			db: db as never,
			decrypt: () => "decrypted-token",
			refresh,
			getRestToken,
			...baseDeps,
			markRefreshFailure,
		});

		// Still degrades to REST: only the marking is conditional.
		expect(src).toEqual({ kind: "rest-adapter", token: "rest-token" });
		expect(markRefreshFailure).toHaveBeenCalledOnce();
		expect(markRefreshFailure).toHaveBeenCalledWith({
			mcpConfigId: "cfg-revoked",
			error: "NEEDS_REAUTH",
			reauthRequired: true,
			// The row we selected still holds this ciphertext, so the writer
			// is free to condemn against it.
			expectedRefreshToken: "enc:refresh",
		});
	});

	it("forwards the ciphertext the refresh actually spent, not the one it selected", async () => {
		// `refreshMcpConfigToken` retries a lost rotation race with the token
		// the winner persisted, so the rejection it finally reports is about a
		// value this resolver never loaded. The writer binds its condemning
		// write to whatever we pass here — pass our own stale ciphertext and
		// the write would either miss a genuine revocation or, worse, be
		// evaluated against the wrong row version.
		const db = makeDb({
			mcpConfig: {
				id: "cfg-retried",
				baseUrl: null,
				encryptedAccessToken: "enc:abc",
				encryptedRefreshToken: "enc:first-refresh",
				tokenExpiresAt: new Date("2026-05-15T11:00:00Z"), // expired
				mcpServer: { defaultUrl: "https://gitlab.com/api/v4/mcp" },
			},
		});
		const refresh = vi.fn(async () => {
			const err = new GitLabReauthRequiredError();
			err.spentEncryptedRefreshToken = "enc:retried-refresh";
			throw err;
		});
		const markRefreshFailure = vi.fn(async () => {});

		await resolveGitLabSource({
			userId: "u1",
			organizationId: null,
			db: db as never,
			decrypt: () => "decrypted-token",
			refresh,
			getRestToken: async () => "rest-token",
			...baseDeps,
			markRefreshFailure,
		});

		expect(markRefreshFailure).toHaveBeenCalledWith({
			mcpConfigId: "cfg-retried",
			error: "NEEDS_REAUTH",
			reauthRequired: true,
			expectedRefreshToken: "enc:retried-refresh",
		});
	});

	it("reports a rejection carrying no ciphertext as transient rather than condemning", async () => {
		// A condemnation may only travel with the row version it is bound to,
		// so one that arrives with nothing to bind to is downgraded rather
		// than cast into the condemning shape. Unreachable through
		// `refreshMcpConfigToken` (it stamps every rejection it lets escape,
		// and a row holding no refresh token fails earlier with a plain
		// Error), so this pins the contract for any other `refresh()` wired in
		// here. Fail-safe: a row with no refresh token has nothing to
		// re-hammer, so declining to condemn costs no retry storm — and the
		// warn keeps the dropped signal visible.
		const db = makeDb({
			mcpConfig: {
				id: "cfg-no-token",
				baseUrl: null,
				encryptedAccessToken: "enc:abc",
				encryptedRefreshToken: null,
				// KNOWN-expired, so the PAT short-circuit (which needs an
				// unknown expiry) doesn't claim this row first.
				tokenExpiresAt: new Date("2026-05-15T11:00:00Z"),
				mcpServer: { defaultUrl: "https://gitlab.com/api/v4/mcp" },
			},
		});
		const refresh = vi.fn(async () => {
			throw new GitLabReauthRequiredError();
		});
		const markRefreshFailure = vi.fn(async () => {});
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		const src = await resolveGitLabSource({
			userId: "u1",
			organizationId: null,
			db: db as never,
			decrypt: () => "decrypted-token",
			refresh,
			getRestToken: async () => "rest-token",
			...baseDeps,
			markRefreshFailure,
		});

		expect(src).toEqual({ kind: "rest-adapter", token: "rest-token" });
		expect(markRefreshFailure).toHaveBeenCalledWith({
			mcpConfigId: "cfg-no-token",
			error: "NEEDS_REAUTH",
			reauthRequired: false,
			expectedRefreshToken: null,
		});
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining("no refresh-token ciphertext"),
			{ mcpConfigId: "cfg-no-token" },
		);
		warnSpy.mockRestore();
	});

	it("does NOT record a failure when the refresh was suppressed by the breaker", async () => {
		// Race: the `needsReauth: false` filter selected this row while the
		// flag was still false, another request tripped the breaker, and the
		// refresh's own reload saw it and declined locally. Nothing was
		// attempted against GitLab, and the row is already condemned — so
		// there is no outcome to record. The REST degradation still runs.
		const db = makeDb({
			mcpConfig: {
				id: "cfg-suppressed",
				baseUrl: null,
				encryptedAccessToken: "enc:abc",
				encryptedRefreshToken: "enc:refresh",
				tokenExpiresAt: new Date("2026-05-15T11:00:00Z"), // expired
				mcpServer: { defaultUrl: "https://gitlab.com/api/v4/mcp" },
			},
		});
		const refresh = vi.fn(async () => {
			throw new GitLabRefreshSuppressedError(
				"MCPConfig cfg-suppressed needs re-authentication — refresh suppressed by the circuit breaker",
			);
		});
		const markRefreshFailure = vi.fn(async () => {});
		const getRestToken = vi.fn(async () => "rest-token");

		const src = await resolveGitLabSource({
			userId: "u1",
			organizationId: null,
			db: db as never,
			decrypt: () => "decrypted-token",
			refresh,
			getRestToken,
			...baseDeps,
			markRefreshFailure,
		});

		expect(src).toEqual({ kind: "rest-adapter", token: "rest-token" });
		expect(refresh).toHaveBeenCalledOnce();
		expect(markRefreshFailure).not.toHaveBeenCalled();
	});

	it("survives a markRefreshFailure rejection (DB down) and still falls through to REST", async () => {
		// If the marking step itself fails (DB outage during the same
		// request), the resolver must still degrade gracefully to REST so
		// the user keeps working. The fallback is the real recovery path.
		const db = makeDb({
			mcpConfig: {
				id: "cfg-revoked",
				baseUrl: null,
				encryptedAccessToken: "enc:abc",
				encryptedRefreshToken: "enc:refresh",
				tokenExpiresAt: new Date("2026-05-15T11:00:00Z"),
				mcpServer: { defaultUrl: "https://gitlab.com/api/v4/mcp" },
			},
		});
		const refresh = vi.fn(async () => {
			throw new Error("refresh-revoked");
		});
		const markRefreshFailure = vi.fn(async () => {
			throw new Error("db-down");
		});
		const getRestToken = vi.fn(async () => "rest-token");

		const src = await resolveGitLabSource({
			userId: "u1",
			organizationId: null,
			db: db as never,
			decrypt: () => "decrypted-token",
			refresh,
			getRestToken,
			...baseDeps,
			markRefreshFailure,
		});

		expect(src).toEqual({ kind: "rest-adapter", token: "rest-token" });
		expect(markRefreshFailure).toHaveBeenCalledOnce();
	});

	it("refreshes the MCP token when within the refresh buffer", async () => {
		const db = makeDb({
			mcpConfig: {
				id: "cfg1",
				baseUrl: null,
				encryptedAccessToken: "enc:abc",
				tokenExpiresAt: new Date("2026-05-15T12:00:30Z"), // 30s in the future, < 60s buffer
				mcpServer: { defaultUrl: "https://gitlab.com/api/v4/mcp" },
			},
		});
		const refresh = vi.fn(async () => "fresh-token");
		const src = await resolveGitLabSource({
			userId: "u1",
			organizationId: null,
			db: db as never,
			decrypt: () => "decrypted-token",
			refresh,
			getRestToken: async () => null,
			...baseDeps,
		});
		expect(src?.kind).toBe("official-mcp");
		expect(refresh).toHaveBeenCalledOnce();
	});
});

describe("resolveGitLabSource — useOfficialMcp flag", () => {
	it("returns rest-adapter when settings.useOfficialMcp === false (skips MCPConfig lookup)", async () => {
		const mcpFindFirst = vi.fn(); // should NOT be called
		const wiFindFirst = vi.fn().mockResolvedValue({
			settings: { useOfficialMcp: false, mcpProbe: null },
		});

		const result = await resolveGitLabSource({
			userId: "u1",
			organizationId: null,
			db: {
				mCPConfig: { findFirst: mcpFindFirst },
				workflowIntegration: { findFirst: wiFindFirst },
			} as never,
			decrypt: (s) => s,
			refresh: async () => "ignored",
			getRestToken: async () => "rest-token",
			markRefreshFailure: baseDeps.markRefreshFailure,
		});

		expect(result).toEqual({ kind: "rest-adapter", token: "rest-token" });
		expect(mcpFindFirst).not.toHaveBeenCalled();
	});

	it("returns official-mcp when settings.useOfficialMcp === true and MCPConfig exists", async () => {
		const wiFindFirst = vi.fn().mockResolvedValue({
			settings: { useOfficialMcp: true, mcpProbe: null },
		});
		const mcpFindFirst = vi.fn().mockResolvedValue({
			id: "cfg-1",
			baseUrl: null,
			encryptedAccessToken: "enc",
			tokenExpiresAt: null,
			mcpServer: { defaultUrl: "https://gitlab.com/api/v4/mcp" },
		});

		const result = await resolveGitLabSource({
			userId: "u1",
			organizationId: null,
			db: {
				mCPConfig: { findFirst: mcpFindFirst },
				workflowIntegration: { findFirst: wiFindFirst },
			} as never,
			decrypt: (s) => s,
			refresh: async () => "ignored",
			getRestToken: async () => null,
			markRefreshFailure: baseDeps.markRefreshFailure,
		});

		expect(result?.kind).toBe("official-mcp");
	});

	it("falls through to REST when settings.useOfficialMcp === true but MCPConfig is missing (corrupt state)", async () => {
		const wiFindFirst = vi.fn().mockResolvedValue({
			settings: { useOfficialMcp: true, mcpProbe: null },
		});
		const mcpFindFirst = vi.fn().mockResolvedValue(null);

		const result = await resolveGitLabSource({
			userId: "u1",
			organizationId: null,
			db: {
				mCPConfig: { findFirst: mcpFindFirst },
				workflowIntegration: { findFirst: wiFindFirst },
			} as never,
			decrypt: (s) => s,
			refresh: async () => "ignored",
			getRestToken: async () => "rest-token",
			markRefreshFailure: baseDeps.markRefreshFailure,
		});

		expect(result).toEqual({ kind: "rest-adapter", token: "rest-token" });
	});

	it("preserves legacy behavior when settings.useOfficialMcp is undefined", async () => {
		const wiFindFirst = vi.fn().mockResolvedValue({ settings: {} });
		const mcpFindFirst = vi.fn().mockResolvedValue({
			id: "cfg-legacy",
			baseUrl: null,
			encryptedAccessToken: "enc",
			tokenExpiresAt: null,
			mcpServer: { defaultUrl: "https://gitlab.com/api/v4/mcp" },
		});

		const result = await resolveGitLabSource({
			userId: "u1",
			organizationId: null,
			db: {
				mCPConfig: { findFirst: mcpFindFirst },
				workflowIntegration: { findFirst: wiFindFirst },
			} as never,
			decrypt: (s) => s,
			refresh: async () => "ignored",
			getRestToken: async () => null,
			markRefreshFailure: baseDeps.markRefreshFailure,
		});

		expect(result?.kind).toBe("official-mcp");
	});
});

describe("callMcpWithRestFallback", () => {
	function officialMcpSource(
		callTool: (
			name: string,
			args: Record<string, unknown>,
		) => Promise<unknown>,
	): GitLabSource {
		return { kind: "official-mcp", callTool };
	}

	it("read (no idempotent flag) + network Error falls back to REST", async () => {
		const callTool = vi.fn().mockRejectedValue(new Error("network down"));
		const restFallback = vi.fn().mockResolvedValue("rest-value");

		const result = await callMcpWithRestFallback({
			source: officialMcpSource(callTool),
			method: "list_issues",
			args: {},
			restFallback,
		});

		expect(result).toBe("rest-value");
		expect(restFallback).toHaveBeenCalledOnce();
	});

	it("write (idempotent: false) + network Error rethrows and does NOT fall back", async () => {
		const networkErr = new Error("network down");
		const callTool = vi.fn().mockRejectedValue(networkErr);
		const restFallback = vi.fn().mockResolvedValue("rest-value");

		await expect(
			callMcpWithRestFallback({
				source: officialMcpSource(callTool),
				method: "create_issue",
				args: {},
				restFallback,
				idempotent: false,
			}),
		).rejects.toBe(networkErr);
		expect(restFallback).not.toHaveBeenCalled();
	});

	it("write (idempotent: false) + GitLabMcpMethodNotFoundError still falls back to REST", async () => {
		const callTool = vi
			.fn()
			.mockRejectedValue(new GitLabMcpMethodNotFoundError("no method"));
		const restFallback = vi.fn().mockResolvedValue("rest-value");

		const result = await callMcpWithRestFallback({
			source: officialMcpSource(callTool),
			method: "create_issue",
			args: {},
			restFallback,
			idempotent: false,
		});

		expect(result).toBe("rest-value");
		expect(restFallback).toHaveBeenCalledOnce();
	});

	it("GitLabMcpError always rethrows and never falls back", async () => {
		const mcpErr = new GitLabMcpError("boom", 500);
		const callTool = vi.fn().mockRejectedValue(mcpErr);
		const restFallback = vi.fn().mockResolvedValue("rest-value");

		await expect(
			callMcpWithRestFallback({
				source: officialMcpSource(callTool),
				method: "list_issues",
				args: {},
				restFallback,
			}),
		).rejects.toBe(mcpErr);
		expect(restFallback).not.toHaveBeenCalled();
	});
});
