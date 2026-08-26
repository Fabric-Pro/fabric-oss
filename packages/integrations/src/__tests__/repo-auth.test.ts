import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Imported for real (not mocked): `resolveValidGitLabToken` uses `instanceof`
// to separate "the customer's grant is dead" from every other throw, so the
// test has to raise the genuine class.
import { GitLabReauthRequiredError } from "../gitlab/oauth-refresh";

// --- mocks (vi.hoisted so the vi.mock factories can reference them) ---
const {
	findFirst,
	findUnique,
	setIntegrationStatus,
	createRepoIntegrationCredentialNotification,
	refreshGh,
	getValidGitLabAccessToken,
	decryptApiKey,
} = vi.hoisted(() => ({
	findFirst: vi.fn(),
	findUnique: vi.fn(),
	setIntegrationStatus: vi.fn(),
	createRepoIntegrationCredentialNotification: vi.fn(),
	// `refreshProjectRepoGitHubTokenWithOutcome` — the variant that reports WHY
	// a null token came back. `resolveFreshRepoTokenForRow` calls this one so a
	// platform refresh failure (no deployment OAuth client credentials, a token
	// endpoint outage) can be told apart from a dead customer grant.
	refreshGh: vi.fn(),
	getValidGitLabAccessToken: vi.fn(),
	// A real vi.fn() (not a bare arrow) so individual tests can override the
	// implementation to THROW — simulating a decrypt failure — via
	// `mockImplementationOnce`. `clearAllMocks` in `beforeEach` resets call
	// history but not this default implementation.
	decryptApiKey: vi.fn((v: string) => `dec:${v}`),
}));

vi.mock("@repo/database", () => ({
	db: { projectRepositoryIntegration: { findFirst, findUnique } },
	setIntegrationStatus,
	createRepoIntegrationCredentialNotification,
}));

vi.mock("@repo/utils", () => ({
	decryptApiKey,
}));

vi.mock("../github/index", () => ({
	refreshProjectRepoGitHubTokenWithOutcome: refreshGh,
}));

vi.mock("../gitlab/index", () => ({
	GitLabReauthRequiredError,
	getValidGitLabAccessToken,
	refreshGitLabToken: vi.fn(),
}));

import {
	buildAuthCloneUrl,
	forceReExchangeRepoCredentials,
	isGitAuthError,
	markRepoReauthRequired,
	resolveFreshRepoToken,
} from "../repo-auth";

const base = {
	provider: "GITHUB",
	authMethod: "OAUTH",
	encryptedAccessToken: "acc",
	encryptedRefreshToken: "ref",
	encryptedPat: null,
	tokenExpiresAt: new Date(),
	updatedAt: new Date(),
};

beforeEach(() => {
	vi.clearAllMocks();
});
afterEach(() => {
	delete process.env.GITLAB_CLIENT_ID;
	delete process.env.GITLAB_CLIENT_SECRET;
});

describe("isGitAuthError", () => {
	it("matches git transport auth failures", () => {
		for (const m of [
			"fatal: Authentication failed for 'https://...'",
			"remote: Invalid username or token.",
			"could not read Username for 'https://github.com'",
			"HTTP Basic: Access denied",
		]) {
			expect(isGitAuthError(new Error(m))).toBe(true);
		}
	});
	it("does not match rate-limit / network / cancel", () => {
		for (const m of [
			"API rate limit exceeded",
			"Could not resolve host: github.com",
			"the operation was canceled",
		]) {
			expect(isGitAuthError(new Error(m))).toBe(false);
		}
	});
});

describe("buildAuthCloneUrl", () => {
	const url = "https://host/o/r.git";
	it("uses the per-provider basic-auth username", () => {
		expect(buildAuthCloneUrl("GITHUB", url, "T")).toContain(
			"x-access-token:T@",
		);
		expect(buildAuthCloneUrl("GITLAB", url, "T")).toContain("oauth2:T@");
		expect(buildAuthCloneUrl("AZURE_DEVOPS", url, "T")).toContain("pat:T@");
	});
});

describe("resolveFreshRepoToken", () => {
	const input = { integrationId: "i1", projectId: "p1" };

	it("returns nulls when the row is absent", async () => {
		findFirst.mockResolvedValue(null);
		expect(await resolveFreshRepoToken(input)).toEqual({
			token: null,
			authMethod: null,
			provider: null,
		});
	});

	it("decrypts the PAT for PAT rows", async () => {
		findFirst.mockResolvedValue({
			...base,
			authMethod: "PAT",
			provider: "AZURE_DEVOPS",
			encryptedPat: "patblob",
		});
		expect(await resolveFreshRepoToken(input)).toEqual({
			token: "dec:patblob",
			authMethod: "PAT",
			provider: "AZURE_DEVOPS",
		});
		expect(refreshGh).not.toHaveBeenCalled();
	});

	it("returns the refreshed GitHub token when available", async () => {
		findFirst.mockResolvedValue({ ...base });
		refreshGh.mockResolvedValue({ token: "fresh-gh" });
		const out = await resolveFreshRepoToken(input);
		expect(out.token).toBe("fresh-gh");
		expect(refreshGh).toHaveBeenCalledWith(
			expect.objectContaining({ integrationId: "i1" }),
		);
	});

	it("falls back to the stored access token when GitHub refresh returns null", async () => {
		findFirst.mockResolvedValue({ ...base });
		refreshGh.mockResolvedValue({ token: null });
		expect((await resolveFreshRepoToken(input)).token).toBe("dec:acc");
	});

	// The fallback token above is very likely dead (`base.tokenExpiresAt` is
	// now). Clone paths still want it — a git auth failure is what drives their
	// self-heal — but a caller holding a working alternative credential must be
	// able to tell, or it will serve a 401 instead of using the alternative.
	it("flags the fallback token stale when it is already hard-expired", async () => {
		findFirst.mockResolvedValue({
			...base,
			tokenExpiresAt: new Date(Date.now() - 60_000),
		});
		refreshGh.mockResolvedValue({ token: null });
		const out = await resolveFreshRepoToken(input);
		expect(out.token).toBe("dec:acc");
		expect(out.stale).toBe(true);
	});

	it("does NOT flag stale when the refresh succeeded", async () => {
		findFirst.mockResolvedValue({
			...base,
			tokenExpiresAt: new Date(Date.now() - 60_000),
		});
		refreshGh.mockResolvedValue({ token: "fresh-gh" });
		const out = await resolveFreshRepoToken(input);
		expect(out.token).toBe("fresh-gh");
		expect(out.stale).toBeFalsy();
	});

	// Unknown expiry must mean REFRESH, not "never expires". GitLab's OAuth
	// callback persists tokenExpiresAt: null whenever the token response omits
	// expires_in, and GitLab tokens die in ~2h — reading null as long-lived
	// served those rows a dead token forever and never even reached
	// getValidGitLabAccessToken, which handles unknown expiry correctly.
	it("refreshes a GitLab row whose expiry is unknown (null)", async () => {
		process.env.GITLAB_CLIENT_ID = "cid";
		process.env.GITLAB_CLIENT_SECRET = "csec";
		findFirst.mockResolvedValue({
			...base,
			provider: "GITLAB",
			tokenExpiresAt: null,
		});
		getValidGitLabAccessToken.mockResolvedValue("gl-refreshed");
		expect((await resolveFreshRepoToken(input)).token).toBe("gl-refreshed");
		expect(getValidGitLabAccessToken).toHaveBeenCalled();
	});

	it("refreshes a GitHub row whose expiry is unknown (null)", async () => {
		findFirst.mockResolvedValue({ ...base, tokenExpiresAt: null });
		refreshGh.mockResolvedValue({ token: "gh-refreshed" });
		expect((await resolveFreshRepoToken(input)).token).toBe("gh-refreshed");
		expect(refreshGh).toHaveBeenCalled();
	});

	// A PAT has no expiry and no refresh token — unknown expiry must NOT drag it
	// into a pointless refresh.
	it("still returns a PAT untouched despite null expiry", async () => {
		findFirst.mockResolvedValue({
			...base,
			authMethod: "PAT",
			provider: "GITLAB",
			encryptedPat: "patblob",
			tokenExpiresAt: null,
		});
		expect((await resolveFreshRepoToken(input)).token).toBe("dec:patblob");
		expect(getValidGitLabAccessToken).not.toHaveBeenCalled();
		expect(refreshGh).not.toHaveBeenCalled();
	});

	it("does not call GitLab refresh for a token that is not near expiry", async () => {
		process.env.GITLAB_CLIENT_ID = "cid";
		process.env.GITLAB_CLIENT_SECRET = "csec";
		findFirst.mockResolvedValue({
			...base,
			provider: "GITLAB",
			tokenExpiresAt: new Date(Date.now() + 60 * 60_000),
		});
		expect((await resolveFreshRepoToken(input)).token).toBe("dec:acc");
		expect(getValidGitLabAccessToken).not.toHaveBeenCalled();
	});

	it("decrypts the stored access token for GitHub rows without a refresh token", async () => {
		findFirst.mockResolvedValue({ ...base, encryptedRefreshToken: null });
		expect((await resolveFreshRepoToken(input)).token).toBe("dec:acc");
		expect(refreshGh).not.toHaveBeenCalled();
	});

	it("resolves a valid GitLab token when client creds are configured", async () => {
		process.env.GITLAB_CLIENT_ID = "cid";
		process.env.GITLAB_CLIENT_SECRET = "csec";
		findFirst.mockResolvedValue({ ...base, provider: "GITLAB" });
		getValidGitLabAccessToken.mockResolvedValue("gl-tok");
		expect((await resolveFreshRepoToken(input)).token).toBe("gl-tok");
	});

	it("falls back to the stored access token for GitLab when client creds are missing", async () => {
		findFirst.mockResolvedValue({ ...base, provider: "GITLAB" });
		expect((await resolveFreshRepoToken(input)).token).toBe("dec:acc");
		expect(getValidGitLabAccessToken).not.toHaveBeenCalled();
	});

	// Card #2383, finding 1: a decrypt THROW (lost/rotated encryption key,
	// corrupted ciphertext) must be distinguishable from "nothing was stored"
	// — the former is a platform fault affecting every tenant at once, and
	// must never be reported to a customer as "reconnect your repository".
	describe("credentialFault", () => {
		it("marks ABSENT when there is no ciphertext to decrypt (PAT)", async () => {
			findFirst.mockResolvedValue({
				...base,
				authMethod: "PAT",
				provider: "AZURE_DEVOPS",
				encryptedPat: null,
			});
			const out = await resolveFreshRepoToken(input);
			expect(out.token).toBeNull();
			expect(out.credentialFault).toBe("ABSENT");
		});

		it("marks DECRYPT_FAILED when ciphertext is present but decryptApiKey throws (PAT)", async () => {
			decryptApiKey.mockImplementationOnce(() => {
				throw new Error("bad key");
			});
			findFirst.mockResolvedValue({
				...base,
				authMethod: "PAT",
				provider: "AZURE_DEVOPS",
				encryptedPat: "patblob",
			});
			const out = await resolveFreshRepoToken(input);
			expect(out.token).toBeNull();
			expect(out.credentialFault).toBe("DECRYPT_FAILED");
		});

		it("marks DECRYPT_FAILED for a GitHub row not near expiry whose stored token won't decrypt", async () => {
			decryptApiKey.mockImplementationOnce(() => {
				throw new Error("bad key");
			});
			// No refresh token → takes the "decrypt directly" branch rather than
			// refreshing first.
			findFirst.mockResolvedValue({
				...base,
				tokenExpiresAt: new Date(Date.now() + 60 * 60_000),
				encryptedRefreshToken: null,
			});
			const out = await resolveFreshRepoToken(input);
			expect(out.token).toBeNull();
			expect(out.credentialFault).toBe("DECRYPT_FAILED");
		});

		it("marks DECRYPT_FAILED on the GitHub refresh-failed fallback decrypt", async () => {
			decryptApiKey.mockImplementationOnce(() => {
				throw new Error("bad key");
			});
			findFirst.mockResolvedValue({ ...base });
			refreshGh.mockResolvedValue({ token: null });
			const out = await resolveFreshRepoToken(input);
			expect(out.token).toBeNull();
			expect(out.credentialFault).toBe("DECRYPT_FAILED");
		});

		it("marks DECRYPT_FAILED on the GitLab refresh-failed fallback decrypt", async () => {
			decryptApiKey.mockImplementationOnce(() => {
				throw new Error("bad key");
			});
			findFirst.mockResolvedValue({ ...base, provider: "GITLAB" });
			const out = await resolveFreshRepoToken(input);
			expect(out.token).toBeNull();
			expect(out.credentialFault).toBe("DECRYPT_FAILED");
		});

		it("does not set credentialFault when the decrypt succeeds", async () => {
			findFirst.mockResolvedValue({ ...base });
			refreshGh.mockResolvedValue({ token: null });
			const out = await resolveFreshRepoToken(input);
			expect(out.token).toBe("dec:acc");
			expect(out.credentialFault).toBeUndefined();
		});
	});

	// A refresh can fail for reasons that are entirely OURS — no deployment
	// OAuth client credentials, a token-endpoint outage, our own database
	// throwing. The fallback then hands back the expired stored token, the
	// provider answers 401, and a consumer reading only the 401 blames the
	// customer's credential. `refreshFault` is what stops that inversion, and it
	// has to travel WITH a non-null token, unlike `credentialFault`.
	describe("refreshFault", () => {
		it("propagates a GitHub platform fault alongside the stale fallback token", async () => {
			findFirst.mockResolvedValue({
				...base,
				tokenExpiresAt: new Date(Date.now() - 60_000),
			});
			refreshGh.mockResolvedValue({
				token: null,
				platformFault: "MISSING_CLIENT_CREDENTIALS",
			});
			const out = await resolveFreshRepoToken(input);
			expect(out.token).toBe("dec:acc");
			expect(out.stale).toBe(true);
			expect(out.refreshFault).toBe("MISSING_CLIENT_CREDENTIALS");
		});

		it("leaves refreshFault unset when GitHub's refresh failed for a GRANT reason", async () => {
			// No `platformFault` means the provider rejected the customer's
			// grant — a 401 downstream IS theirs to fix, and the reconnect
			// signal must survive.
			findFirst.mockResolvedValue({ ...base });
			refreshGh.mockResolvedValue({ token: null });
			const out = await resolveFreshRepoToken(input);
			expect(out.token).toBe("dec:acc");
			expect(out.refreshFault).toBeUndefined();
		});

		it("leaves refreshFault unset when the refresh succeeded", async () => {
			findFirst.mockResolvedValue({ ...base });
			refreshGh.mockResolvedValue({ token: "fresh-gh" });
			const out = await resolveFreshRepoToken(input);
			expect(out.token).toBe("fresh-gh");
			expect(out.refreshFault).toBeUndefined();
		});

		it("marks MISSING_CLIENT_CREDENTIALS for GitLab when the deployment has no client id/secret", async () => {
			// The same hazard on the GitLab side: an unset GITLAB_CLIENT_ID
			// fails every GitLab integration on the deployment at once.
			findFirst.mockResolvedValue({ ...base, provider: "GITLAB" });
			const out = await resolveFreshRepoToken(input);
			expect(out.token).toBe("dec:acc");
			expect(out.refreshFault).toBe("MISSING_CLIENT_CREDENTIALS");
			expect(getValidGitLabAccessToken).not.toHaveBeenCalled();
		});

		it("marks INTERNAL when the GitLab resolution throws something that is not a dead grant", async () => {
			process.env.GITLAB_CLIENT_ID = "cid";
			process.env.GITLAB_CLIENT_SECRET = "csec";
			findFirst.mockResolvedValue({ ...base, provider: "GITLAB" });
			getValidGitLabAccessToken.mockRejectedValue(
				new Error("token endpoint 503"),
			);
			const out = await resolveFreshRepoToken(input);
			expect(out.token).toBe("dec:acc");
			expect(out.refreshFault).toBe("INTERNAL");
		});

		it("leaves refreshFault unset when GitLab raises GitLabReauthRequiredError (the grant really is dead)", async () => {
			process.env.GITLAB_CLIENT_ID = "cid";
			process.env.GITLAB_CLIENT_SECRET = "csec";
			findFirst.mockResolvedValue({ ...base, provider: "GITLAB" });
			getValidGitLabAccessToken.mockRejectedValue(
				new GitLabReauthRequiredError(),
			);
			const out = await resolveFreshRepoToken(input);
			expect(out.token).toBe("dec:acc");
			expect(out.refreshFault).toBeUndefined();
		});
	});
});

describe("forceReExchangeRepoCredentials", () => {
	const input = { integrationId: "i1", userId: "u1" };

	it("force-re-exchanges GitHub OAuth and reports the outcome", async () => {
		findUnique.mockResolvedValue({
			provider: "GITHUB",
			authMethod: "OAUTH",
			encryptedRefreshToken: "ref",
			updatedAt: new Date(),
		});
		refreshGh.mockResolvedValue({ token: "new" });
		expect(await forceReExchangeRepoCredentials(input)).toEqual({
			refreshed: true,
		});
		expect(refreshGh).toHaveBeenCalledWith(
			expect.objectContaining({ forceReExchange: true }),
		);
	});

	it("reports not-refreshed when the GitHub exchange yields no token", async () => {
		findUnique.mockResolvedValue({
			provider: "GITHUB",
			authMethod: "OAUTH",
			encryptedRefreshToken: "ref",
			updatedAt: new Date(),
		});
		refreshGh.mockResolvedValue({ token: null });
		expect(await forceReExchangeRepoCredentials(input)).toEqual({
			refreshed: false,
		});
	});

	it("does not refresh PAT or refresh-tokenless rows", async () => {
		findUnique.mockResolvedValue({
			provider: "AZURE_DEVOPS",
			authMethod: "PAT",
			encryptedRefreshToken: null,
			updatedAt: new Date(),
		});
		expect(await forceReExchangeRepoCredentials(input)).toEqual({
			refreshed: false,
		});
		expect(refreshGh).not.toHaveBeenCalled();
	});
});

describe("markRepoReauthRequired", () => {
	it("notifies once on a genuine transition into TOKEN_EXPIRED", async () => {
		setIntegrationStatus.mockResolvedValue({
			statusChanged: true,
			previousStatus: "ACTIVE",
		});
		findUnique.mockResolvedValue({
			projectId: "p1",
			provider: "GITHUB",
			repositoryOwner: "o",
			repositoryName: "r",
			configuredByUserId: "u1",
			project: { name: "P", organizationId: "org1" },
		});
		await markRepoReauthRequired({ integrationId: "i1", reason: "dead" });
		expect(
			createRepoIntegrationCredentialNotification,
		).toHaveBeenCalledTimes(1);
	});

	it("does not notify when the status did not transition", async () => {
		setIntegrationStatus.mockResolvedValue({
			statusChanged: false,
			previousStatus: "TOKEN_EXPIRED",
		});
		await markRepoReauthRequired({ integrationId: "i1", reason: "dead" });
		expect(
			createRepoIntegrationCredentialNotification,
		).not.toHaveBeenCalled();
	});
});
