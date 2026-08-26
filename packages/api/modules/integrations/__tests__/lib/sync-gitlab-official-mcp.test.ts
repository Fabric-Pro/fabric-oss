import { describe, expect, it, vi } from "vitest";
import {
	resetGitlabOfficialMcpBreaker,
	syncGitlabOfficialMcpConfig,
} from "../../lib/sync-gitlab-official-mcp";

/** The circuit-breaker columns only a fresh OAuth grant may reset. */
const BREAKER_FIELDS = [
	"needsReauth",
	"status",
	"refreshFailureCount",
	"lastRefreshFailedAt",
	"lastRefreshError",
	"consecutiveFailures",
] as const;

describe("syncGitlabOfficialMcpConfig", () => {
	const tokenBundle = {
		encryptedAccessToken: "enc",
		accessTokenHash: "hash",
		encryptedRefreshToken: null,
		tokenExpiresAt: null,
	};

	it("creates MCPConfig when capable=true and none exists", async () => {
		const tx = buildSyncTx({
			officialServerId: "srv-1",
			existingConfigId: null,
		});
		const result = await syncGitlabOfficialMcpConfig(tx as any, {
			userId: "u1",
			organizationId: null,
			capable: true,
			tokenBundle,
		});
		expect(tx.mCPConfig.create).toHaveBeenCalledOnce();
		expect(result).toEqual({ ok: true, action: "created" });
	});

	it("updates MCPConfig when capable=true and one exists", async () => {
		const tx = buildSyncTx({
			officialServerId: "srv-1",
			existingConfigId: "cfg-1",
		});
		const result = await syncGitlabOfficialMcpConfig(tx as any, {
			userId: "u1",
			organizationId: null,
			capable: true,
			tokenBundle,
		});
		expect(tx.mCPConfig.update).toHaveBeenCalledOnce();
		expect(tx.mCPConfig.delete).not.toHaveBeenCalled();
		expect(result).toEqual({ ok: true, action: "updated" });
	});

	it("deletes MCPConfig when capable=false and one exists", async () => {
		const tx = buildSyncTx({
			officialServerId: "srv-1",
			existingConfigId: "cfg-1",
		});
		const result = await syncGitlabOfficialMcpConfig(tx as any, {
			userId: "u1",
			organizationId: null,
			capable: false,
			tokenBundle,
		});
		expect(tx.mCPConfig.delete).toHaveBeenCalledOnce();
		expect(result).toEqual({ ok: true, action: "deleted" });
	});

	it("is a no-op when capable=false and none exists", async () => {
		const tx = buildSyncTx({
			officialServerId: "srv-1",
			existingConfigId: null,
		});
		const result = await syncGitlabOfficialMcpConfig(tx as any, {
			userId: "u1",
			organizationId: null,
			capable: false,
			tokenBundle,
		});
		expect(tx.mCPConfig.create).not.toHaveBeenCalled();
		expect(tx.mCPConfig.update).not.toHaveBeenCalled();
		expect(tx.mCPConfig.delete).not.toHaveBeenCalled();
		expect(result).toEqual({ ok: true, action: "noop" });
	});

	it("reports server-not-seeded when the gitlab-official MCPServer row is missing", async () => {
		const tx = buildSyncTx({
			officialServerId: null,
			existingConfigId: null,
		});
		const result = await syncGitlabOfficialMcpConfig(tx as any, {
			userId: "u1",
			organizationId: null,
			capable: true,
			tokenBundle,
		});
		expect(tx.mCPConfig.create).not.toHaveBeenCalled();
		expect(result).toEqual({ ok: false, reason: "server-not-seeded" });
	});

	it("omits tokenExpiresAt from the update payload when the bundle lacks it", async () => {
		const tx = buildSyncTx({
			officialServerId: "srv-1",
			existingConfigId: "cfg-1",
		});
		await syncGitlabOfficialMcpConfig(tx as any, {
			userId: "u1",
			organizationId: null,
			capable: true,
			tokenBundle: {
				encryptedAccessToken: "enc",
				accessTokenHash: "hash",
				encryptedRefreshToken: null,
				// tokenExpiresAt intentionally omitted
			},
		});
		const updateCall = tx.mCPConfig.update.mock.calls[0][0] as {
			data: Record<string, unknown>;
		};
		expect("tokenExpiresAt" in updateCall.data).toBe(false);
	});

	it("leaves the circuit-breaker fields untouched when resetBreaker is omitted", async () => {
		// A caller without a fresh OAuth grant (the capability recheck) must
		// not be able to lift `needsReauth`. The breaker is enforced at MCP
		// client creation and only a user re-auth may clear it — writing
		// these columns here resurrects a credential whose refresh token is
		// still dead.
		const tx = buildSyncTx({
			officialServerId: "srv-1",
			existingConfigId: "cfg-1",
		});
		await syncGitlabOfficialMcpConfig(tx as any, {
			userId: "u1",
			organizationId: null,
			capable: true,
			tokenBundle,
		});

		const updateCall = tx.mCPConfig.update.mock.calls[0][0] as {
			data: Record<string, unknown>;
		};
		for (const field of BREAKER_FIELDS) {
			expect(field in updateCall.data).toBe(false);
		}
		// Token material still written — only the breaker state is withheld.
		expect(updateCall.data.encryptedAccessToken).toBe("enc");
		expect(updateCall.data.accessTokenHash).toBe("hash");
	});

	it("resets the whole circuit-breaker state when resetBreaker is true", async () => {
		const tx = buildSyncTx({
			officialServerId: "srv-1",
			existingConfigId: "cfg-1",
		});
		await syncGitlabOfficialMcpConfig(tx as any, {
			userId: "u1",
			organizationId: null,
			capable: true,
			resetBreaker: true,
			tokenBundle,
		});

		const updateCall = tx.mCPConfig.update.mock.calls[0][0] as {
			data: Record<string, unknown>;
		};
		expect(updateCall.data).toMatchObject({
			needsReauth: false,
			status: "HEALTHY",
			refreshFailureCount: 0,
			lastRefreshFailedAt: null,
			lastRefreshError: null,
			consecutiveFailures: 0,
		});
	});

	it("does NOT delete a condemned MCPConfig when the caller has no reset authority", async () => {
		// The delete branch was the hole the `resetBreaker` gate on the update
		// branch left open: a recheck probing with the EXISTING (dead)
		// credential could drop the row entirely, and the next capable probe
		// then recreated it clean. Deleting is a stronger form of the very
		// laundering `resetBreaker` exists to prevent.
		const tx = buildSyncTx({
			officialServerId: "srv-1",
			existingConfigId: "cfg-1",
			existingConfigNeedsReauth: true,
		});

		const result = await syncGitlabOfficialMcpConfig(tx as any, {
			userId: "u1",
			organizationId: null,
			capable: false,
			resetBreaker: false,
			tokenBundle,
		});

		expect(tx.mCPConfig.delete).not.toHaveBeenCalled();
		expect(tx.mCPConfig.update).not.toHaveBeenCalled();
		expect(result).toEqual({ ok: true, action: "kept-condemned" });
	});

	it("does not resurrect a kept condemned row on the next capable recheck", async () => {
		// The other half of the laundering path: having survived the incapable
		// probe above, the row must also survive a capable one that carries no
		// fresh grant — it gets its token rewritten and keeps its breaker.
		const tx = buildSyncTx({
			officialServerId: "srv-1",
			existingConfigId: "cfg-1",
			existingConfigNeedsReauth: true,
		});

		const kept = await syncGitlabOfficialMcpConfig(tx as any, {
			userId: "u1",
			organizationId: null,
			capable: false,
			resetBreaker: false,
			tokenBundle,
		});
		const rechecked = await syncGitlabOfficialMcpConfig(tx as any, {
			userId: "u1",
			organizationId: null,
			capable: true,
			resetBreaker: false,
			tokenBundle,
		});

		expect(kept).toEqual({ ok: true, action: "kept-condemned" });
		expect(rechecked).toEqual({ ok: true, action: "updated" });
		expect(tx.mCPConfig.delete).not.toHaveBeenCalled();
		expect(tx.mCPConfig.create).not.toHaveBeenCalled();
		const updateCall = tx.mCPConfig.update.mock.calls[0][0] as {
			data: Record<string, unknown>;
		};
		for (const field of BREAKER_FIELDS) {
			expect(field in updateCall.data).toBe(false);
		}
	});

	it("still deletes a condemned MCPConfig for a caller holding a fresh grant", async () => {
		// Reset authority is the whole difference: a new grant may clear the
		// breaker, so it may also drop a row an authoritative probe says is
		// not usable.
		const tx = buildSyncTx({
			officialServerId: "srv-1",
			existingConfigId: "cfg-1",
			existingConfigNeedsReauth: true,
		});

		const result = await syncGitlabOfficialMcpConfig(tx as any, {
			userId: "u1",
			organizationId: null,
			capable: false,
			resetBreaker: true,
			tokenBundle,
		});

		expect(tx.mCPConfig.delete).toHaveBeenCalledOnce();
		expect(result).toEqual({ ok: true, action: "deleted" });
	});

	it("includes tokenExpiresAt in the update payload when explicitly null", async () => {
		const tx = buildSyncTx({
			officialServerId: "srv-1",
			existingConfigId: "cfg-1",
		});
		await syncGitlabOfficialMcpConfig(tx as any, {
			userId: "u1",
			organizationId: null,
			capable: true,
			tokenBundle: {
				encryptedAccessToken: "enc",
				accessTokenHash: "hash",
				encryptedRefreshToken: null,
				tokenExpiresAt: null,
			},
		});
		const updateCall = tx.mCPConfig.update.mock.calls[0][0] as {
			data: Record<string, unknown>;
		};
		expect("tokenExpiresAt" in updateCall.data).toBe(true);
		expect(updateCall.data.tokenExpiresAt).toBeNull();
	});
});

/**
 * The credential half of the contract, split out from the capability half so a
 * fresh grant can recover the official row even when the MCP probe that would
 * normally carry it came back inconclusive.
 */
describe("resetGitlabOfficialMcpBreaker", () => {
	const tokenBundle = {
		encryptedAccessToken: "enc",
		accessTokenHash: "hash",
		encryptedRefreshToken: "enc-refresh",
		tokenExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
	};

	it("clears the whole breaker state and rewrites the token on a condemned row", async () => {
		const tx = buildSyncTx({
			officialServerId: "srv-1",
			existingConfigId: "cfg-1",
			existingConfigNeedsReauth: true,
		});

		const result = await resetGitlabOfficialMcpBreaker(tx as any, {
			userId: "u1",
			organizationId: null,
			tokenBundle,
		});

		expect(result).toEqual({ ok: true, action: "reset" });
		const updateCall = tx.mCPConfig.update.mock.calls[0][0] as {
			where: { id: string };
			data: Record<string, unknown>;
		};
		expect(updateCall.where).toEqual({ id: "cfg-1" });
		expect(updateCall.data).toMatchObject({
			encryptedAccessToken: "enc",
			accessTokenHash: "hash",
			encryptedRefreshToken: "enc-refresh",
			needsReauth: false,
			status: "HEALTHY",
			refreshFailureCount: 0,
			lastRefreshFailedAt: null,
			lastRefreshError: null,
			consecutiveFailures: 0,
		});
	});

	it("makes no capability decision — never creates and never deletes", async () => {
		// This is what makes it safe to run on a NON-authoritative probe: the
		// only thing that moves is the credential.
		const tx = buildSyncTx({
			officialServerId: "srv-1",
			existingConfigId: null,
		});

		const result = await resetGitlabOfficialMcpBreaker(tx as any, {
			userId: "u1",
			organizationId: null,
			tokenBundle,
		});

		expect(result).toEqual({ ok: true, action: "noop" });
		expect(tx.mCPConfig.create).not.toHaveBeenCalled();
		expect(tx.mCPConfig.delete).not.toHaveBeenCalled();
		expect(tx.mCPConfig.update).not.toHaveBeenCalled();
	});

	it("reports server-not-seeded when the gitlab-official MCPServer row is missing", async () => {
		const tx = buildSyncTx({
			officialServerId: null,
			existingConfigId: null,
		});

		const result = await resetGitlabOfficialMcpBreaker(tx as any, {
			userId: "u1",
			organizationId: null,
			tokenBundle,
		});

		expect(result).toEqual({ ok: false, reason: "server-not-seeded" });
		expect(tx.mCPConfig.update).not.toHaveBeenCalled();
	});
});

function buildSyncTx(opts: {
	officialServerId: string | null;
	existingConfigId: string | null;
	/** Whether the existing row's circuit breaker has tripped. */
	existingConfigNeedsReauth?: boolean;
}) {
	return {
		mCPServer: {
			findFirst: vi.fn(async () =>
				opts.officialServerId ? { id: opts.officialServerId } : null,
			),
		},
		mCPConfig: {
			findFirst: vi.fn(async () =>
				opts.existingConfigId
					? {
							id: opts.existingConfigId,
							needsReauth:
								opts.existingConfigNeedsReauth ?? false,
						}
					: null,
			),
			create: vi.fn(async () => ({ id: "new" })),
			update: vi.fn(async () => ({ id: "updated" })),
			delete: vi.fn(async () => undefined),
		},
	};
}
