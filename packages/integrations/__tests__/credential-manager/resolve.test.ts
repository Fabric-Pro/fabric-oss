/**
 * `resolveCredential` — tenant and access checks before any secret is read,
 * and the refresh path's lock discipline: everything under the lock goes
 * through the transaction client, a queued caller reuses the winner's token,
 * and a rejected grant marks the row NEEDS_REAUTH at the generation it read.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
	getCredentialMetadata: vi.fn(),
	readCredentialSecret: vi.fn(),
	replaceCredentialSecretIfGeneration: vi.fn(),
	markCredentialStatusIfGeneration: vi.fn(),
	touchCredentialUsed: vi.fn(),
}));
const tx = vi.hoisted(() => ({ marker: "tx" }));

vi.mock("@repo/database", async () => {
	const access = await import(
		"../../../database/prisma/queries/lib/credential-access"
	);
	return { ...db, canUseCredential: access.canUseCredential };
});
vi.mock("@repo/database/prisma/queries/lib/refresh-lock", () => ({
	withRefreshLock: (_key: string, fn: (t: unknown) => unknown) => fn(tx),
}));
vi.mock("@repo/database/prisma/queries/lib/refresh-lock-key", () => ({
	credentialLockKey: (id: string) => `cred:${id}`,
}));

import {
	__resetCredentialAdaptersForTest,
	registerCredentialAdapter,
	resolveCredential,
} from "../../src/credential-manager/resolve";

const NOW = Date.parse("2026-10-31T12:00:00Z");

function row(overrides: Record<string, unknown> = {}) {
	return {
		id: "cred-1",
		organizationId: "org-1",
		userId: "user-1",
		sharing: "PRIVATE",
		provider: "GITHUB",
		kind: "GITHUB_APP_USER",
		principal: "USER",
		label: "octocat",
		origin: "https://github.com",
		scopes: ["repo"],
		status: "ACTIVE",
		generation: 3,
		expiresAt: new Date(NOW + 60 * 60 * 1000),
		...overrides,
	};
}

const userActor = {
	type: "user" as const,
	userId: "user-1",
	organizationId: "org-1",
	canManageOrganizationIntegrations: false,
};
const requirement = {
	provider: "GITHUB" as const,
	kinds: ["GITHUB_APP_USER" as const],
	scopes: ["repo"],
};

beforeEach(() => {
	vi.clearAllMocks();
	__resetCredentialAdaptersForTest();
	db.replaceCredentialSecretIfGeneration.mockResolvedValue(true);
	db.markCredentialStatusIfGeneration.mockResolvedValue(true);
});

describe("resolveCredential access", () => {
	it("looks the row up only inside the actor's organization", async () => {
		db.getCredentialMetadata.mockResolvedValue(null);
		const result = await resolveCredential({
			credentialId: "cred-1",
			actor: { ...userActor, organizationId: "org-2" },
			requirement,
		});
		expect(db.getCredentialMetadata).toHaveBeenCalledWith({
			id: "cred-1",
			organizationId: "org-2",
		});
		expect(result).toEqual({ ok: false, failure: { code: "not-found" } });
	});

	it("refuses another member's private credential without reading the secret", async () => {
		db.getCredentialMetadata.mockResolvedValue(row({ userId: "user-2" }));
		const result = await resolveCredential({
			credentialId: "cred-1",
			actor: userActor,
			requirement,
		});
		expect(result).toEqual({ ok: false, failure: { code: "forbidden" } });
		expect(db.readCredentialSecret).not.toHaveBeenCalled();
	});

	it("allows another member's credential once it is shared", async () => {
		const shared = row({ userId: "user-2", sharing: "ORGANIZATION" });
		db.getCredentialMetadata.mockResolvedValue(shared);
		db.readCredentialSecret.mockResolvedValue({
			credential: shared,
			secret: { accessToken: "t" },
		});
		const result = await resolveCredential({
			credentialId: "cred-1",
			actor: userActor,
			requirement,
			now: () => NOW,
		});
		expect(result.ok && result.value.token).toBe("t");
	});

	it("returns the requirement failure instead of a token", async () => {
		db.getCredentialMetadata.mockResolvedValue(row());
		const result = await resolveCredential({
			credentialId: "cred-1",
			actor: userActor,
			requirement: { ...requirement, scopes: ["project"] },
		});
		expect(result).toEqual({
			ok: false,
			failure: {
				code: "requirement",
				failures: [
					{ code: "insufficient-scope", missing: ["project"] },
				],
			},
		});
		expect(db.readCredentialSecret).not.toHaveBeenCalled();
	});

	it("lets a system actor use a bound row but never a revoked one", async () => {
		db.getCredentialMetadata.mockResolvedValue(row({ status: "REVOKED" }));
		const result = await resolveCredential({
			credentialId: "cred-1",
			actor: { type: "system", organizationId: "org-1" },
			requirement,
		});
		expect(result).toEqual({ ok: false, failure: { code: "forbidden" } });
	});
});

describe("resolveCredential app installations", () => {
	it("mints instead of reading a stored secret", async () => {
		const install = row({
			userId: null,
			sharing: "ORGANIZATION",
			kind: "APP_INSTALLATION",
			principal: "APP",
			scopes: [],
		});
		db.getCredentialMetadata.mockResolvedValue(install);
		const mint = vi.fn().mockResolvedValue({
			token: "ghs_minted",
			expiresAt: new Date(NOW + 3600_000),
		});
		registerCredentialAdapter({
			provider: "GITHUB",
			mintInstallationToken: mint,
		});
		const result = await resolveCredential({
			credentialId: "cred-1",
			actor: userActor,
			requirement: { provider: "GITHUB", kinds: ["APP_INSTALLATION"] },
		});
		expect(result.ok && result.value.token).toBe("ghs_minted");
		expect(db.readCredentialSecret).not.toHaveBeenCalled();
	});

	it("reports app-unavailable when no minting adapter is configured", async () => {
		db.getCredentialMetadata.mockResolvedValue(
			row({ userId: null, kind: "APP_INSTALLATION", principal: "APP" }),
		);
		const result = await resolveCredential({
			credentialId: "cred-1",
			actor: userActor,
			requirement: { provider: "GITHUB", kinds: ["APP_INSTALLATION"] },
		});
		expect(result).toEqual({
			ok: false,
			failure: { code: "app-unavailable" },
		});
	});
});

describe("resolveCredential refresh", () => {
	const nearExpiry = new Date(NOW + 60_000);

	function storedNearExpiry() {
		const cred = row({ expiresAt: nearExpiry });
		db.getCredentialMetadata.mockResolvedValue(cred);
		db.readCredentialSecret.mockResolvedValue({
			credential: cred,
			secret: { accessToken: "old", refreshToken: "r1" },
		});
		return cred;
	}

	it("refreshes under the lock and writes through the transaction at the generation it read", async () => {
		storedNearExpiry();
		const later = new Date(NOW + 8 * 3600_000);
		registerCredentialAdapter({
			provider: "GITHUB",
			refresh: vi.fn().mockResolvedValue({
				ok: true,
				secret: { accessToken: "new", refreshToken: "r2" },
				expiresAt: later,
			}),
		});
		const result = await resolveCredential({
			credentialId: "cred-1",
			actor: userActor,
			requirement,
			now: () => NOW,
		});
		expect(result.ok && result.value.token).toBe("new");
		expect(db.readCredentialSecret).toHaveBeenLastCalledWith(
			{ id: "cred-1", organizationId: "org-1" },
			tx,
		);
		expect(db.replaceCredentialSecretIfGeneration).toHaveBeenCalledWith(
			expect.objectContaining({ generation: 3, expiresAt: later }),
			tx,
		);
	});

	it("reuses the token a winner stored while this caller waited for the lock", async () => {
		const cred = storedNearExpiry();
		const fresh = {
			...cred,
			expiresAt: new Date(NOW + 8 * 3600_000),
			generation: 3,
		};
		db.readCredentialSecret
			.mockResolvedValueOnce({
				credential: cred,
				secret: { accessToken: "old", refreshToken: "r1" },
			})
			.mockResolvedValueOnce({
				credential: fresh,
				secret: { accessToken: "winner", refreshToken: "r2" },
			});
		const refresh = vi.fn();
		registerCredentialAdapter({ provider: "GITHUB", refresh });
		const result = await resolveCredential({
			credentialId: "cred-1",
			actor: userActor,
			requirement,
			now: () => NOW,
		});
		expect(result.ok && result.value.token).toBe("winner");
		expect(refresh).not.toHaveBeenCalled();
	});

	it("marks a rejected grant NEEDS_REAUTH through the transaction", async () => {
		storedNearExpiry();
		registerCredentialAdapter({
			provider: "GITHUB",
			refresh: vi
				.fn()
				.mockResolvedValue({ ok: false, reason: "rejected" }),
		});
		const result = await resolveCredential({
			credentialId: "cred-1",
			actor: userActor,
			requirement,
			now: () => NOW,
		});
		expect(result).toEqual({
			ok: false,
			failure: { code: "needs-reauth" },
		});
		expect(db.markCredentialStatusIfGeneration).toHaveBeenCalledWith(
			expect.objectContaining({
				generation: 3,
				status: "NEEDS_REAUTH",
				lastError: "refresh-rejected",
				refreshRejected: true,
			}),
			tx,
		);
	});

	it("keeps the stored token when the provider is unavailable", async () => {
		storedNearExpiry();
		registerCredentialAdapter({
			provider: "GITHUB",
			refresh: vi
				.fn()
				.mockResolvedValue({ ok: false, reason: "unavailable" }),
		});
		const result = await resolveCredential({
			credentialId: "cred-1",
			actor: userActor,
			requirement,
			now: () => NOW,
		});
		expect(result.ok && result.value.token).toBe("old");
		expect(db.markCredentialStatusIfGeneration).not.toHaveBeenCalled();
	});

	it("drops a refresh result when a reconnect moved the generation", async () => {
		storedNearExpiry();
		db.replaceCredentialSecretIfGeneration.mockResolvedValue(false);
		registerCredentialAdapter({
			provider: "GITHUB",
			refresh: vi.fn().mockResolvedValue({
				ok: true,
				secret: { accessToken: "lost", refreshToken: "r2" },
				expiresAt: new Date(NOW + 3600_000),
			}),
		});
		const result = await resolveCredential({
			credentialId: "cred-1",
			actor: userActor,
			requirement,
			now: () => NOW,
		});
		expect(result.ok && result.value.token).toBe("old");
	});
});
