import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	GitLabIntegrationNotConnectedError,
	recheckGitlabCapabilities,
} from "../../lib/gitlab-recheck";

// Mock @repo/utils encrypt/hash to be identity so we can assert on values.
vi.mock("@repo/utils", () => ({
	encryptApiKey: (s: string) => `enc:${s}`,
	decryptApiKey: (s: string) =>
		s.startsWith("plain:")
			? s.slice("plain:".length)
			: JSON.stringify({ access_token: "at", refresh_token: "rt" }),
	hashApiKey: (s: string) => `hash:${s}`,
}));

// Mock @repo/integrations/gitlab to avoid loading the barrel (which pulls in
// @repo/database → Prisma client, not available in unit-test environments).
vi.mock("@repo/integrations/gitlab", () => ({
	probeGitLabMcp: vi.fn(),
	readUseOfficialMcp: (
		settings: { useOfficialMcp?: boolean } | null | undefined,
	): true | false | "legacy" => {
		if (!settings || typeof settings !== "object") {
			return "legacy";
		}
		if (settings.useOfficialMcp === true) {
			return true;
		}
		if (settings.useOfficialMcp === false) {
			return false;
		}
		return "legacy";
	},
}));

// Mock getValidGitLabToken so the recheck test focuses on probe + sync wiring,
// not the token refresh subsystem (covered by gitlab-token.test.ts).
const { getValidGitLabTokenMock } = vi.hoisted(() => ({
	getValidGitLabTokenMock: vi.fn(),
}));
vi.mock("../../lib/gitlab-token", () => ({
	getValidGitLabToken: getValidGitLabTokenMock,
}));

describe("recheckGitlabCapabilities", () => {
	const baseInput = { userId: "u1", organizationId: null };

	beforeEach(() => {
		getValidGitLabTokenMock.mockReset();
		getValidGitLabTokenMock.mockResolvedValue("fresh-access-token");
	});

	function makeDb(opts: {
		integration: { id: string; settings: unknown } | null;
		officialServerId: string | null;
		existingOfficialConfigId: string | null;
		existingOfficialConfigBaseUrl?: string | null;
		/** Whether the existing official row's circuit breaker has tripped. */
		existingOfficialConfigNeedsReauth?: boolean;
	}) {
		// Inner tx writes (called inside $transaction)
		const tx = {
			workflowIntegration: {
				findFirst: vi.fn(async () => opts.integration),
				update: vi.fn(async () => ({ id: opts.integration?.id })),
			},
			mCPServer: {
				findFirst: vi.fn(async () =>
					opts.officialServerId
						? { id: opts.officialServerId }
						: null,
				),
			},
			mCPConfig: {
				// Tx-side findFirst — used by syncGitlabOfficialMcpConfig to look up
				// the existing official config by mcpServerId. Returns the two
				// columns that select names: the id and the breaker flag that
				// gates the delete branch.
				findFirst: vi.fn(async () =>
					opts.existingOfficialConfigId
						? {
								id: opts.existingOfficialConfigId,
								needsReauth: Boolean(
									opts.existingOfficialConfigNeedsReauth,
								),
							}
						: null,
				),
				create: vi.fn(async () => ({ id: "new" })),
				update: vi.fn(async () => ({ id: "updated" })),
				delete: vi.fn(async () => undefined),
			},
		};

		// Outer db needs: workflowIntegration.findFirst (for the initial
		// not-connected check), mCPConfig.findFirst (for probe baseUrl derivation),
		// and $transaction (wraps the writes).
		const outer = {
			workflowIntegration: {
				findFirst: tx.workflowIntegration.findFirst,
				update: tx.workflowIntegration.update,
			},
			mCPServer: tx.mCPServer,
			mCPConfig: {
				...tx.mCPConfig,
				findFirst: vi.fn(async () =>
					opts.existingOfficialConfigId
						? {
								id: opts.existingOfficialConfigId,
								baseUrl:
									opts.existingOfficialConfigBaseUrl ?? null,
								tokenExpiresAt: null,
							}
						: null,
				),
			},
			$transaction: vi.fn(
				async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
			),
		};

		return { outer, tx };
	}

	it("throws when no GitLab integration is connected", async () => {
		const { outer } = makeDb({
			integration: null,
			officialServerId: "srv-1",
			existingOfficialConfigId: null,
		});
		await expect(
			recheckGitlabCapabilities({ db: outer as never, input: baseInput }),
		).rejects.toThrow(GitLabIntegrationNotConnectedError);
	});

	it("writes useOfficialMcp=true + creates MCPConfig when probe returns ok", async () => {
		const { outer, tx } = makeDb({
			integration: {
				id: "wi-1",
				settings: { useOfficialMcp: false, mcpProbe: null },
			},
			officialServerId: "srv-1",
			existingOfficialConfigId: null,
		});
		const probe = vi.fn().mockResolvedValue({
			capable: true,
			status: "ok",
			httpStatus: 200,
		});

		const result = await recheckGitlabCapabilities({
			db: outer as never,
			input: baseInput,
			probe,
		});

		expect(result.useOfficialMcp).toBe(true);
		expect(result.mcpProbe).toMatchObject({
			status: "ok",
			httpStatus: 200,
		});
		expect(tx.workflowIntegration.update).toHaveBeenCalledOnce();
		expect(tx.mCPConfig.create).toHaveBeenCalledOnce();
		expect(outer.$transaction).toHaveBeenCalledOnce();
	});

	it("preserves useOfficialMcp on network-error and does NOT touch MCPConfig", async () => {
		const { outer, tx } = makeDb({
			integration: {
				id: "wi-1",
				settings: { useOfficialMcp: true, mcpProbe: null },
			},
			officialServerId: "srv-1",
			existingOfficialConfigId: "cfg-1",
		});
		const probe = vi.fn().mockResolvedValue({
			capable: false,
			status: "network-error",
			httpStatus: null,
		});

		const result = await recheckGitlabCapabilities({
			db: outer as never,
			input: baseInput,
			probe,
		});

		expect(result.useOfficialMcp).toBe(true); // preserved
		expect(result.mcpProbe).toMatchObject({ status: "network-error" });
		expect(tx.workflowIntegration.update).toHaveBeenCalledOnce();
		expect(tx.mCPConfig.create).not.toHaveBeenCalled();
		expect(tx.mCPConfig.update).not.toHaveBeenCalled();
		expect(tx.mCPConfig.delete).not.toHaveBeenCalled();
	});

	it("flips true→false and deletes the MCPConfig when probe says not-found", async () => {
		const { outer, tx } = makeDb({
			integration: {
				id: "wi-1",
				settings: { useOfficialMcp: true, mcpProbe: null },
			},
			officialServerId: "srv-1",
			existingOfficialConfigId: "cfg-1",
		});
		const probe = vi.fn().mockResolvedValue({
			capable: false,
			status: "not-found",
			httpStatus: 404,
		});

		const result = await recheckGitlabCapabilities({
			db: outer as never,
			input: baseInput,
			probe,
		});

		expect(result.useOfficialMcp).toBe(false);
		expect(tx.mCPConfig.delete).toHaveBeenCalledOnce();
	});

	it("does NOT delete a condemned MCPConfig when the probe says not-found", async () => {
		// A recheck probes with the EXISTING credential, so it holds no
		// authority over the breaker — and deleting the row erases it more
		// completely than any update could: the next capable recheck recreates
		// the row clean, laundering a flag only a fresh grant may lift.
		const { outer, tx } = makeDb({
			integration: {
				id: "wi-1",
				settings: { useOfficialMcp: true, mcpProbe: null },
			},
			officialServerId: "srv-1",
			existingOfficialConfigId: "cfg-1",
			existingOfficialConfigNeedsReauth: true,
		});
		const probe = vi.fn().mockResolvedValue({
			capable: false,
			status: "not-found",
			httpStatus: 404,
		});

		const result = await recheckGitlabCapabilities({
			db: outer as never,
			input: baseInput,
			probe,
		});

		expect(tx.mCPConfig.delete).not.toHaveBeenCalled();
		expect(tx.mCPConfig.update).not.toHaveBeenCalled();
		// The capability decision still lands — it is the settings flag, not
		// the row's existence, that routes traffic away from the official
		// server.
		expect(result.useOfficialMcp).toBe(false);
		expect(tx.workflowIntegration.update).toHaveBeenCalledOnce();
	});

	it("does not resurrect a condemned MCPConfig on a later capable recheck", async () => {
		// Having survived the incapable probe above, the row must survive a
		// capable one too: it is updated in place with its breaker intact,
		// never recreated clean.
		const { outer, tx } = makeDb({
			integration: {
				id: "wi-1",
				settings: { useOfficialMcp: false, mcpProbe: null },
			},
			officialServerId: "srv-1",
			existingOfficialConfigId: "cfg-1",
			existingOfficialConfigNeedsReauth: true,
		});
		const probe = vi.fn().mockResolvedValue({
			capable: true,
			status: "ok",
			httpStatus: 200,
		});

		await recheckGitlabCapabilities({
			db: outer as never,
			input: baseInput,
			probe,
		});

		expect(tx.mCPConfig.create).not.toHaveBeenCalled();
		expect(tx.mCPConfig.update).toHaveBeenCalledOnce();
		const updateCall = tx.mCPConfig.update.mock.calls[0][0] as {
			where: { id: string };
			data: Record<string, unknown>;
		};
		expect(updateCall.where).toEqual({ id: "cfg-1" });
		expect("needsReauth" in updateCall.data).toBe(false);
	});

	it("uses MCPConfig.baseUrl origin as the probe baseUrl when present (self-hosted)", async () => {
		const { outer } = makeDb({
			integration: {
				id: "wi-1",
				settings: { useOfficialMcp: true, mcpProbe: null },
			},
			officialServerId: "srv-1",
			existingOfficialConfigId: "cfg-1",
			existingOfficialConfigBaseUrl:
				"https://gitlab.example.com/api/v4/mcp",
		});
		const probe = vi.fn().mockResolvedValue({
			capable: true,
			status: "ok",
			httpStatus: 200,
		});

		const result = await recheckGitlabCapabilities({
			db: outer as never,
			input: baseInput,
			probe,
		});

		expect(probe).toHaveBeenCalledWith(
			expect.objectContaining({ baseUrl: "https://gitlab.example.com" }),
		);
		expect(result.mcpProbe.baseUrl).toBe("https://gitlab.example.com");
	});

	it("omits tokenExpiresAt from the sync update payload (does not clobber MCPConfig expiry)", async () => {
		const { outer, tx } = makeDb({
			integration: {
				id: "wi-1",
				settings: { useOfficialMcp: true, mcpProbe: null },
			},
			officialServerId: "srv-1",
			existingOfficialConfigId: "cfg-1",
		});
		const probe = vi.fn().mockResolvedValue({
			capable: true,
			status: "ok",
			httpStatus: 200,
		});

		await recheckGitlabCapabilities({
			db: outer as never,
			input: baseInput,
			probe,
		});

		expect(tx.mCPConfig.update).toHaveBeenCalledOnce();
		const updateCall = tx.mCPConfig.update.mock.calls[0][0] as {
			data: Record<string, unknown>;
		};
		expect("tokenExpiresAt" in updateCall.data).toBe(false);
	});

	it("does NOT clear the circuit breaker on the synced MCPConfig (a recheck is not a new grant)", async () => {
		// A capability probe reuses the EXISTING credential — it even passes
		// `encryptedRefreshToken: null`. If it reset `needsReauth` and the
		// failure counters, any recheck would resurrect a config whose refresh
		// token is still dead, which is exactly what the enforced breaker
		// exists to prevent.
		const { outer, tx } = makeDb({
			integration: {
				id: "wi-1",
				settings: { useOfficialMcp: true, mcpProbe: null },
			},
			officialServerId: "srv-1",
			existingOfficialConfigId: "cfg-1",
		});
		const probe = vi.fn().mockResolvedValue({
			capable: true,
			status: "ok",
			httpStatus: 200,
		});

		await recheckGitlabCapabilities({
			db: outer as never,
			input: baseInput,
			probe,
		});

		expect(tx.mCPConfig.update).toHaveBeenCalledOnce();
		const updateCall = tx.mCPConfig.update.mock.calls[0][0] as {
			data: Record<string, unknown>;
		};
		for (const field of [
			"needsReauth",
			"status",
			"refreshFailureCount",
			"lastRefreshFailedAt",
			"lastRefreshError",
			"consecutiveFailures",
		]) {
			expect(field in updateCall.data).toBe(false);
		}
	});

	it("uses the refreshed token from getValidGitLabToken (not stale credentials)", async () => {
		const { outer } = makeDb({
			integration: {
				id: "wi-1",
				settings: { useOfficialMcp: true, mcpProbe: null },
			},
			officialServerId: "srv-1",
			existingOfficialConfigId: null,
		});
		getValidGitLabTokenMock.mockResolvedValueOnce("just-refreshed-token");
		const probe = vi.fn().mockResolvedValue({
			capable: true,
			status: "ok",
			httpStatus: 200,
		});

		await recheckGitlabCapabilities({
			db: outer as never,
			input: baseInput,
			probe,
		});

		expect(getValidGitLabTokenMock).toHaveBeenCalledOnce();
		expect(probe).toHaveBeenCalledWith(
			expect.objectContaining({ accessToken: "just-refreshed-token" }),
		);
	});
});
