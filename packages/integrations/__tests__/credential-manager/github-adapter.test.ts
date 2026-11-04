/**
 * The GitHub credential adapter: a near-expiry GitHub App user credential is
 * refreshed through `resolveCredential` with the issuing OAuth client, and
 * the real credential-store writes run against an in-memory `credential`
 * table. A refresh rotates the secret (generation +1); a rejected grant
 * marks the row NEEDS_REAUTH; an unavailable provider or a missing client
 * keeps the stored token and changes nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown> & { id: string; generation: number };

const h = vi.hoisted(() => {
	process.env.FABRIC_GITHUB_CLIENT_ID = "gh-client-id";
	process.env.FABRIC_GITHUB_CLIENT_SECRET = "gh-client-secret";
	return {
		rows: [] as Row[],
		refreshOAuthToken: vi.fn(),
		tx: { marker: "tx" } as Record<string, unknown>,
	};
});

function matches(row: Row, where: Record<string, unknown>): boolean {
	return Object.entries(where).every(([key, condition]) => {
		if (condition && typeof condition === "object" && "not" in condition) {
			return row[key] !== (condition as { not: unknown }).not;
		}
		return row[key] === condition;
	});
}

const credentialTable = {
	findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
		const row = h.rows.find((r) => matches(r, where));
		return row ? { ...row } : null;
	}),
	updateMany: vi.fn(
		async ({
			where,
			data,
		}: {
			where: Record<string, unknown>;
			data: Record<string, unknown>;
		}) => {
			const hit = h.rows.filter((r) => matches(r, where));
			for (const row of hit) {
				for (const [key, value] of Object.entries(data)) {
					row[key] =
						value &&
						typeof value === "object" &&
						"increment" in value
							? (row[key] as number) +
								(value as { increment: number }).increment
							: value;
				}
			}
			return { count: hit.length };
		},
	),
};
h.tx.credential = credentialTable;

vi.mock("../../../database/prisma/client", () => ({
	// A getter: this factory runs before the table above is initialised.
	db: {
		get credential() {
			return credentialTable;
		},
	},
}));
vi.mock("@repo/utils", () => ({
	encryptApiKey: (v: string) => `enc:${v}`,
	decryptApiKey: (v: string) => v.replace(/^enc:/, ""),
}));
vi.mock("@repo/utils/oauth-refresh", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/utils/oauth-refresh")>()),
	refreshOAuthToken: h.refreshOAuthToken,
}));
vi.mock("@repo/database", async () => {
	const store = await import(
		"../../../database/prisma/queries/credential-store"
	);
	const access = await import(
		"../../../database/prisma/queries/lib/credential-access"
	);
	return {
		...store,
		canUseCredential: access.canUseCredential,
		db: { workflowIntegration: { findFirst: vi.fn() } },
	};
});
vi.mock("@repo/database/prisma/queries/lib/refresh-lock", () => ({
	withRefreshLock: (
		_key: string,
		fn: (t: unknown, assertBudget: (ms: number) => void) => unknown,
	) => fn(h.tx, () => {}),
}));
vi.mock("@repo/database/prisma/queries/lib/refresh-lock-key", async (o) => ({
	...(await o<
		typeof import("@repo/database/prisma/queries/lib/refresh-lock-key")
	>()),
	credentialLockKey: (id: string) => `cred:${id}`,
}));

import {
	backfillCredentialAccounts,
	resolveCredential,
} from "../../src/credential-manager";

const NOW = Date.now();

function seed(overrides: Record<string, unknown> = {}, secret?: object) {
	h.rows.push({
		id: "cred-1",
		organizationId: "org-1",
		userId: "user-1",
		sharing: "PRIVATE",
		provider: "GITHUB",
		kind: "GITHUB_APP_USER",
		principal: "USER",
		label: "GitHub · octo-example",
		origin: "https://github.com",
		externalAccountId: "4242",
		externalAccountLogin: "octo-example",
		scopes: [],
		generation: 1,
		status: "ACTIVE",
		// Inside the refresh skew: due for a refresh.
		expiresAt: new Date(NOW + 60 * 1000),
		refreshRejectedAt: null,
		lastError: null,
		encryptedSecret: `enc:${JSON.stringify(
			secret ?? {
				accessToken: "old-access",
				refreshToken: "old-refresh",
				issuer: "gh-client-id",
			},
		)}`,
		...overrides,
	});
}

function storedSecret() {
	return JSON.parse(String(h.rows[0].encryptedSecret).replace(/^enc:/, ""));
}

const resolve = () =>
	resolveCredential({
		credentialId: "cred-1",
		actor: { type: "system", organizationId: "org-1" },
		requirement: { provider: "GITHUB", kinds: ["GITHUB_APP_USER"] },
	});

beforeEach(() => {
	vi.clearAllMocks();
	h.rows.length = 0;
});

describe("GitHub credential adapter", () => {
	it("refreshes a near-expiry GitHub App user credential with the issuing client and rotates it", async () => {
		seed();
		h.refreshOAuthToken.mockResolvedValue({
			ok: true,
			accessToken: "new-access",
			refreshToken: "new-refresh",
			expiresIn: 28800,
			tokenType: "bearer",
			scope: "",
		});

		const result = await resolve();

		expect(h.refreshOAuthToken).toHaveBeenCalledTimes(1);
		expect(h.refreshOAuthToken).toHaveBeenCalledWith(
			expect.objectContaining({
				tokenEndpoint: "https://github.com/login/oauth/access_token",
				refreshToken: "old-refresh",
				clientId: "gh-client-id",
				clientSecret: "gh-client-secret",
			}),
		);
		expect(result.ok && result.value.token).toBe("new-access");
		expect(result.ok && result.value.credential.generation).toBe(2);
		expect(h.rows[0].generation).toBe(2);
		expect(h.rows[0].status).toBe("ACTIVE");
		expect((h.rows[0].expiresAt as Date).getTime()).toBeGreaterThan(
			NOW + 7 * 60 * 60 * 1000,
		);
		expect(storedSecret()).toEqual({
			accessToken: "new-access",
			refreshToken: "new-refresh",
			issuer: "gh-client-id",
		});
		// No scope in the response keeps the stored ones.
		expect(h.rows[0].scopes).toEqual([]);
	});

	it("marks the credential NEEDS_REAUTH when GitHub rejects the refresh token", async () => {
		seed();
		h.refreshOAuthToken.mockResolvedValue({
			ok: false,
			errorCode: "bad_refresh_token",
			errorMessage: "bad_refresh_token",
		});

		const result = await resolve();

		expect(result).toEqual({
			ok: false,
			failure: { code: "needs-reauth" },
		});
		expect(h.rows[0]).toMatchObject({
			status: "NEEDS_REAUTH",
			lastError: "refresh-rejected",
			generation: 1,
		});
		expect(h.rows[0].refreshRejectedAt).toBeInstanceOf(Date);
		expect(storedSecret().refreshToken).toBe("old-refresh");
	});

	it.each([
		["a network fault", "network_error"],
		["a 5xx", "http_503"],
		["an ambiguous 404", "http_404"],
	])("keeps the stored token on %s", async (_label, errorCode) => {
		seed();
		h.refreshOAuthToken.mockResolvedValue({
			ok: false,
			errorCode,
			errorMessage: errorCode,
		});

		const result = await resolve();

		expect(result.ok && result.value.token).toBe("old-access");
		expect(h.rows[0]).toMatchObject({ status: "ACTIVE", generation: 1 });
		expect(storedSecret().refreshToken).toBe("old-refresh");
	});

	it("keeps the stored token when the exchange throws", async () => {
		seed();
		h.refreshOAuthToken.mockRejectedValue(new Error("socket hang up"));

		const result = await resolve();

		expect(result.ok && result.value.token).toBe("old-access");
		expect(h.rows[0].generation).toBe(1);
	});

	it("does not exchange when the configured client is not the grant's issuer", async () => {
		seed(
			{},
			{
				accessToken: "old-access",
				refreshToken: "old-refresh",
				issuer: "another-client-id",
			},
		);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		const result = await resolve();

		expect(h.refreshOAuthToken).not.toHaveBeenCalled();
		expect(result.ok && result.value.token).toBe("old-access");
		expect(h.rows[0]).toMatchObject({ status: "ACTIVE", generation: 1 });
		warn.mockRestore();
	});

	it("does not refresh a credential that is not near expiry", async () => {
		seed({ expiresAt: new Date(NOW + 2 * 60 * 60 * 1000) });

		const result = await resolve();

		expect(h.refreshOAuthToken).not.toHaveBeenCalled();
		expect(result.ok && result.value.token).toBe("old-access");
	});
});

describe("GitHub account backfill", () => {
	const fetchMock = vi.fn();

	function userResponse(status: number, scopes: string | null) {
		return {
			ok: status >= 200 && status < 300,
			status,
			json: async () => ({ id: 4242, login: "octo-example" }),
			headers: {
				get: (name: string) =>
					name.toLowerCase() === "x-oauth-scopes" ? scopes : null,
			},
		};
	}

	function seedPat(overrides: Record<string, unknown> = {}) {
		seed(
			{
				kind: "PAT",
				externalAccountId: null,
				externalAccountLogin: null,
				expiresAt: null,
				...overrides,
			},
			{ token: "ghp_example_pat" },
		);
	}

	const resolvePat = () =>
		resolveCredential({
			credentialId: "cred-1",
			actor: { type: "system", organizationId: "org-1" },
			requirement: { provider: "GITHUB", kinds: ["PAT"] },
		});

	beforeEach(() => {
		fetchMock.mockReset();
		fetchMock.mockResolvedValue(userResponse(200, "repo, workflow"));
		vi.stubGlobal("fetch", fetchMock);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("a token saved without its account learns it on first use, once, without touching the secret", async () => {
		seedPat();
		const first = await resolvePat();
		expect(first.ok && first.value.credential.externalAccountLogin).toBe(
			"octo-example",
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			"https://api.github.com/user",
		);
		expect(h.rows[0]).toMatchObject({
			externalAccountId: "4242",
			externalAccountLogin: "octo-example",
			scopes: ["repo", "workflow"],
			generation: 1,
		});
		expect(storedSecret()).toEqual({ token: "ghp_example_pat" });

		await resolvePat();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("never fails the resolve when GitHub cannot be reached or refuses", async () => {
		seedPat();
		fetchMock.mockRejectedValue(new TypeError("fetch failed"));
		const offline = await resolvePat();
		expect(offline.ok && offline.value.token).toBe("ghp_example_pat");
		fetchMock.mockResolvedValue(userResponse(401, null));
		const refused = await resolvePat();
		expect(refused.ok).toBe(true);
		expect(h.rows[0].externalAccountLogin).toBeNull();
	});

	it("does not overwrite an account written after the token was read (generation fence)", async () => {
		seedPat();
		fetchMock.mockImplementation(async () => {
			// A replaced secret lands while GitHub is being asked.
			h.rows[0].generation = 2;
			return userResponse(200, "repo");
		});
		await resolvePat();
		expect(h.rows[0].externalAccountLogin).toBeNull();
	});

	it("keeps a sign-in's granted scopes when GitHub reports none", async () => {
		seed(
			{
				kind: "GITHUB_APP_USER",
				externalAccountId: null,
				externalAccountLogin: null,
				scopes: ["repo"],
				expiresAt: null,
			},
			{ accessToken: "ghu_example" },
		);
		fetchMock.mockResolvedValue(userResponse(200, ""));
		await resolve();
		expect(h.rows[0]).toMatchObject({
			externalAccountLogin: "octo-example",
			scopes: ["repo"],
		});
	});

	it("asks nothing for a GitHub Enterprise origin", async () => {
		seedPat({ origin: "https://github.example.com" });
		await resolvePat();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("backfillCredentialAccounts fills each listed row of the organization once", async () => {
		seedPat();
		const recorded = await backfillCredentialAccounts({
			organizationId: "org-1",
			credentialIds: ["cred-1", "cred-1"],
		});
		expect(recorded).toEqual(new Map([["cred-1", "octo-example"]]));
		expect(fetchMock).toHaveBeenCalledTimes(1);

		const again = await backfillCredentialAccounts({
			organizationId: "org-1",
			credentialIds: ["cred-1"],
		});
		expect(again.size).toBe(0);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("backfillCredentialAccounts never reads a row of another organization", async () => {
		seedPat();
		const recorded = await backfillCredentialAccounts({
			organizationId: "org-2",
			credentialIds: ["cred-1"],
		});
		expect(recorded.size).toBe(0);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(h.rows[0].externalAccountLogin).toBeNull();
	});
});
