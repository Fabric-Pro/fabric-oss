import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Imported for real (not mocked): `resolveValidGitLabToken` uses `instanceof`
// to separate "the customer's grant is dead" from every other throw, so the
// test has to raise the genuine class.
import { GitLabReauthRequiredError } from "../gitlab/oauth-refresh";

// --- mocks (vi.hoisted so the vi.mock factories can reference them) ---
const {
	findFirst,
	findUnique,
	transaction,
	txExecuteRaw,
	setIntegrationStatus,
	createRepoIntegrationCredentialNotification,
	refreshGh,
	getValidGitLabAccessToken,
	decryptApiKey,
} = vi.hoisted(() => ({
	findFirst: vi.fn(),
	findUnique: vi.fn(),
	transaction: vi.fn(),
	txExecuteRaw: vi.fn(),
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
	db: {
		projectRepositoryIntegration: { findFirst, findUnique },
		$transaction: transaction,
	},
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

import { runExchangeGate } from "../exchange-gate";
import {
	buildAuthCloneUrl,
	forceReExchangeRepoCredentials,
	isGitAuthError,
	markRepoReauthRequired,
	REPO_REAUTH_NOTIFY_BOUND_MS,
	REPO_REAUTH_STEP_BOUND_MS,
	REPO_REAUTH_WRITE_BOUND_MS,
	resolveFreshRepoToken,
	resolveFreshRepoTokenForRow,
} from "../repo-auth";

/** The transaction client the reauth status write runs on. */
const reauthTx = { $executeRaw: txExecuteRaw };

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
	transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
		fn(reauthTx),
	);
	txExecuteRaw.mockResolvedValue(1);
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
	it("matches a GitHub SAML SSO wall, even beside the trailing 403 (Fizzy #2563)", () => {
		const http403 =
			"fatal: unable to access 'https://github.com/example-org/repo.git/': The requested URL returned error: 403";
		for (const m of [
			`remote: The 'example-org' organization has enabled or enforced SAML SSO.\nremote: To access this repository, you must re-authorize the OAuth Application.\n${http403}`,
			`remote: The 'example-org' organization has enabled or enforced SAML SSO.\n${http403}`,
			`remote: Resource protected by organization SAML enforcement. You must grant your Personal Access token access to this organization.\n${http403}`,
			`remote: To access this repository, you must re-authorize the OAuth Application.\n${http403}`,
		]) {
			expect(isGitAuthError(new Error(m))).toBe(true);
		}
	});
	it("does not match a bare 403 or a write refusal", () => {
		for (const m of [
			"fatal: unable to access 'https://github.com/example-org/repo.git/': The requested URL returned error: 403",
			"remote: Write access to repository not granted.",
		]) {
			expect(isGitAuthError(new Error(m))).toBe(false);
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

// The reauth status write has its own enforced bound (Fizzy #2563), so a
// caller with a deadline can size its reserve to it: pool admission plus a
// transaction whose statements the server stops before Prisma rolls it back.
describe("markRepoReauthRequired — the bounded status write", () => {
	it("writes the status inside a transaction bounded by REPO_REAUTH_WRITE_BOUND_MS, with a statement timeout inside it", async () => {
		const order: string[] = [];
		txExecuteRaw.mockImplementation(async (sql: TemplateStringsArray) => {
			order.push(sql.join("?"));
			return 1;
		});
		setIntegrationStatus.mockImplementation(async () => {
			order.push("status");
			return { statusChanged: false, previousStatus: "TOKEN_EXPIRED" };
		});
		await markRepoReauthRequired({ integrationId: "i1", reason: "dead" });

		expect(transaction).toHaveBeenCalledTimes(1);
		const options = transaction.mock.calls[0]?.[1] as {
			timeout: number;
			maxWait: number;
		};
		expect(options.timeout + options.maxWait).toBe(
			REPO_REAUTH_WRITE_BOUND_MS,
		);
		expect(order).toEqual([
			"SELECT set_config('statement_timeout', ?, true)",
			"status",
		]);
		const statementTimeout = txExecuteRaw.mock.calls[0]?.[1] as string;
		expect(statementTimeout).toMatch(/^\d+ms$/);
		expect(Number.parseInt(statementTimeout, 10)).toBeLessThan(
			options.timeout,
		);
		// The write runs on the transaction, not the pool.
		expect(setIntegrationStatus).toHaveBeenCalledWith(
			"i1",
			"TOKEN_EXPIRED",
			"dead",
			undefined,
			undefined,
			reauthTx,
		);
	});

	it("a status write the bound cut short writes nothing, notifies nobody and does not throw", async () => {
		transaction.mockRejectedValueOnce(
			new Error("Transaction already closed"),
		);
		await expect(
			markRepoReauthRequired({ integrationId: "i1", reason: "dead" }),
		).resolves.toBeUndefined();
		expect(setIntegrationStatus).not.toHaveBeenCalled();
		expect(
			createRepoIntegrationCredentialNotification,
		).not.toHaveBeenCalled();
	});
});

// The notification after a transition is best-effort and bounded on its own
// (Fizzy #2563): the status row, already committed, is what drives the UI's
// reconnect prompt, so a notification phase that runs out of time or is
// stopped is skipped, logged once, and never outlives its bound.
describe("markRepoReauthRequired — the bounded notification", () => {
	const integrationRow = {
		projectId: "p1",
		provider: "GITHUB",
		repositoryOwner: "o",
		repositoryName: "r",
		configuredByUserId: "u1",
		project: { name: "P", organizationId: "org1" },
	};
	const never = () => new Promise<never>(() => {});
	let info: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		info = vi.spyOn(console, "info").mockImplementation(() => {});
		setIntegrationStatus.mockResolvedValue({
			statusChanged: true,
			previousStatus: "ACTIVE",
		});
	});
	afterEach(() => {
		vi.useRealTimers();
		info.mockRestore();
		// Never leave a stuck implementation behind for a later test.
		findUnique.mockReset();
		createRepoIntegrationCredentialNotification.mockReset();
	});

	it("reserves the write and the notification together", () => {
		expect(REPO_REAUTH_NOTIFY_BOUND_MS).toBe(10_000);
		expect(REPO_REAUTH_STEP_BOUND_MS).toBe(
			REPO_REAUTH_WRITE_BOUND_MS + REPO_REAUTH_NOTIFY_BOUND_MS,
		);
		expect(REPO_REAUTH_STEP_BOUND_MS).toBe(20_000);
	});

	it.each([
		["its integration read", () => findUnique.mockImplementation(never)],
		[
			"its fan-out",
			() => {
				findUnique.mockResolvedValue(integrationRow);
				createRepoIntegrationCredentialNotification.mockImplementation(
					never,
				);
			},
		],
	])(
		"a notification phase stuck in %s is cut at 10 s: the write stays committed, the skip is logged once and nothing else follows",
		async (_step, stick) => {
			stick();
			let settled = false;
			const run = markRepoReauthRequired({
				integrationId: "i1",
				reason: "dead",
			}).finally(() => {
				settled = true;
			});
			await vi.advanceTimersByTimeAsync(REPO_REAUTH_NOTIFY_BOUND_MS - 1);
			expect(settled).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			await expect(run).resolves.toBeUndefined();

			expect(setIntegrationStatus).toHaveBeenCalledTimes(1);
			expect(info).toHaveBeenCalledTimes(1);
			expect(info).toHaveBeenCalledWith(
				"[repo-auth] repo_auth.reauth_notification_skipped",
				{
					event: "repo_auth.reauth_notification_skipped",
					integrationId: "i1",
					reason: "timeout",
				},
			);
			const callsAtCut =
				createRepoIntegrationCredentialNotification.mock.calls.length;
			await vi.advanceTimersByTimeAsync(10 * 60_000);
			expect(
				createRepoIntegrationCredentialNotification.mock.calls.length,
			).toBe(callsAtCut);
			expect(info).toHaveBeenCalledTimes(1);
		},
	);

	it("an abort between the committed write and the notification rethrows the caller's reason and starts no notification", async () => {
		const stop = new Error("caller stopped");
		const controller = new AbortController();
		setIntegrationStatus.mockImplementation(async () => {
			controller.abort(stop);
			return { statusChanged: true, previousStatus: "ACTIVE" };
		});
		findUnique.mockResolvedValue(integrationRow);
		await expect(
			markRepoReauthRequired({
				integrationId: "i1",
				reason: "dead",
				signal: controller.signal,
			}),
		).rejects.toBe(stop);
		expect(setIntegrationStatus).toHaveBeenCalledTimes(1);
		expect(transaction).toHaveBeenCalledTimes(1);
		expect(findUnique).not.toHaveBeenCalled();
		expect(
			createRepoIntegrationCredentialNotification,
		).not.toHaveBeenCalled();
	});

	it("an abort during the notification cuts it at once, logs the skip, then rethrows the caller's reason", async () => {
		const stop = new Error("caller stopped");
		const controller = new AbortController();
		findUnique.mockImplementation(() => {
			setTimeout(() => controller.abort(stop), 2_000);
			return never();
		});
		let outcome: unknown;
		const run = markRepoReauthRequired({
			integrationId: "i1",
			reason: "dead",
			signal: controller.signal,
		}).catch((e: unknown) => {
			outcome = e;
		});
		await vi.advanceTimersByTimeAsync(2_000);
		await run;
		expect(outcome).toBe(stop);
		expect(setIntegrationStatus).toHaveBeenCalledTimes(1);
		expect(info).toHaveBeenCalledWith(
			"[repo-auth] repo_auth.reauth_notification_skipped",
			{
				event: "repo_auth.reauth_notification_skipped",
				integrationId: "i1",
				reason: "aborted",
			},
		);
		expect(
			createRepoIntegrationCredentialNotification,
		).not.toHaveBeenCalled();
	});

	it("a notification whose bound is already spent at entry starts neither the read nor the fan-out, and logs the skip once", async () => {
		// The caller is still live (it passes the post-write check), but the
		// combined bound it gets is already aborted.
		const spent = new AbortController();
		spent.abort(new Error("bound spent"));
		const any = vi.spyOn(AbortSignal, "any").mockReturnValue(spent.signal);
		try {
			findUnique.mockResolvedValue(integrationRow);
			await markRepoReauthRequired({
				integrationId: "i1",
				reason: "dead",
				signal: new AbortController().signal,
			});
		} finally {
			any.mockRestore();
		}
		expect(setIntegrationStatus).toHaveBeenCalledTimes(1);
		expect(findUnique).not.toHaveBeenCalled();
		expect(
			createRepoIntegrationCredentialNotification,
		).not.toHaveBeenCalled();
		expect(info).toHaveBeenCalledTimes(1);
		expect(info).toHaveBeenCalledWith(
			"[repo-auth] repo_auth.reauth_notification_skipped",
			{
				event: "repo_auth.reauth_notification_skipped",
				integrationId: "i1",
				reason: "timeout",
			},
		);
	});

	it("a notification that finishes inside its bound is sent and logs no skip", async () => {
		findUnique.mockResolvedValue(integrationRow);
		createRepoIntegrationCredentialNotification.mockResolvedValue(
			undefined,
		);
		await markRepoReauthRequired({ integrationId: "i1", reason: "dead" });
		expect(
			createRepoIntegrationCredentialNotification,
		).toHaveBeenCalledTimes(1);
		expect(info).not.toHaveBeenCalled();
	});
});

// A caller's pre-exchange gate (Fizzy #2563): handed to the provider refresh,
// which consults it under its lock immediately before an exchange. A refusal
// reaches the caller unchanged, never as a platform fault or a fallback token;
// a PAT or still-fresh token never consults it.
describe("a caller's pre-exchange gate", () => {
	const refused = new Error("too little time left to exchange");
	const refusing = () =>
		vi.fn<() => void>(() => {
			throw refused;
		});
	const nearExpiry = {
		...base,
		integrationId: "i1",
		tokenExpiresAt: new Date(Date.now() - 1000),
	};
	const fresh = {
		...nearExpiry,
		tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
	};

	it.each([
		["a PAT", { ...nearExpiry, authMethod: "PAT", encryptedPat: "pat" }],
		["a still-fresh GitHub token", fresh],
		["a still-fresh GitLab token", { ...fresh, provider: "GITLAB" }],
	])("%s resolves without consulting the gate", async (_name, row) => {
		const gate = refusing();
		const resolved = await resolveFreshRepoTokenForRow(row as never, {
			beforeExchange: gate,
		});
		expect(resolved.token).toMatch(/^dec:/);
		expect(gate).not.toHaveBeenCalled();
		expect(refreshGh).not.toHaveBeenCalled();
		expect(getValidGitLabAccessToken).not.toHaveBeenCalled();
	});

	it("resolveFreshRepoToken hands the gate to the GitHub refresh: a reserve the row read consumed refuses the exchange, and the refusal is thrown unchanged", async () => {
		let left = 35_000;
		const gate = vi.fn(() => {
			if (left < 30_000) {
				throw refused;
			}
		});
		findFirst.mockImplementation(async () => {
			left -= 10_000;
			return nearExpiry;
		});
		const exchange = vi.fn();
		refreshGh.mockImplementation(
			async (i: { beforeExchange?: () => void }) => {
				runExchangeGate(i.beforeExchange);
				exchange();
				return { token: "fresh" };
			},
		);
		await expect(
			resolveFreshRepoToken({
				integrationId: "i1",
				projectId: "p1",
				beforeExchange: gate,
			}),
		).rejects.toBe(refused);
		expect(gate).toHaveBeenCalledTimes(1);
		expect(exchange).not.toHaveBeenCalled();
	});

	it("a GitLab refusal is thrown unchanged, not reported as a platform fault with the stored token", async () => {
		process.env.GITLAB_CLIENT_ID = "id";
		process.env.GITLAB_CLIENT_SECRET = "secret";
		getValidGitLabAccessToken.mockImplementation(
			async (a: { beforeExchange?: () => void }) => {
				runExchangeGate(a.beforeExchange);
				return "fresh";
			},
		);
		const gate = refusing();
		await expect(
			resolveFreshRepoTokenForRow(
				{ ...nearExpiry, provider: "GITLAB" } as never,
				{
					beforeExchange: gate,
				},
			),
		).rejects.toBe(refused);
		expect(gate).toHaveBeenCalledTimes(1);
	});

	it.each([["GITHUB"], ["GITLAB"]])(
		"forceReExchangeRepoCredentials throws a %s refusal unchanged, not { refreshed: false }",
		async (provider) => {
			process.env.GITLAB_CLIENT_ID = "id";
			process.env.GITLAB_CLIENT_SECRET = "secret";
			findUnique.mockResolvedValue({
				provider,
				authMethod: "OAUTH",
				encryptedRefreshToken: "ref",
				updatedAt: new Date(),
			});
			refreshGh.mockImplementation(
				async (i: { beforeExchange?: () => void }) => {
					runExchangeGate(i.beforeExchange);
					return { token: "fresh" };
				},
			);
			getValidGitLabAccessToken.mockImplementation(
				async (a: { beforeExchange?: () => void }) => {
					runExchangeGate(a.beforeExchange);
					return "fresh";
				},
			);
			const gate = refusing();
			await expect(
				forceReExchangeRepoCredentials({
					integrationId: "i1",
					userId: "u1",
					beforeExchange: gate,
				}),
			).rejects.toBe(refused);
			expect(gate).toHaveBeenCalledTimes(1);
		},
	);
});

// A caller's signal (Fizzy #2563): a cancelled or out-of-time caller starts
// no refresh, status write or notification, and gets its own abort reason
// back instead of a verdict. An exchange or a status write already under way
// is left to finish; the notification starts only after the post-write check
// and is waited for only within its own bound.
describe("a caller's signal", () => {
	const stop = new Error("caller stopped");
	const aborted = () => {
		const controller = new AbortController();
		controller.abort(stop);
		return controller.signal;
	};
	const nearExpiry = {
		...base,
		integrationId: "i1",
		tokenExpiresAt: new Date(Date.now() - 1000),
	};

	it("resolveFreshRepoToken throws an already-aborted signal's reason and reads nothing", async () => {
		await expect(
			resolveFreshRepoToken({
				integrationId: "i1",
				projectId: "p1",
				signal: aborted(),
			}),
		).rejects.toBe(stop);
		expect(findFirst).not.toHaveBeenCalled();
		expect(refreshGh).not.toHaveBeenCalled();
	});

	it("resolveFreshRepoToken starts no refresh when the signal aborts while the row is read", async () => {
		const controller = new AbortController();
		findFirst.mockImplementation(async () => {
			controller.abort(stop);
			return nearExpiry;
		});
		await expect(
			resolveFreshRepoToken({
				integrationId: "i1",
				projectId: "p1",
				signal: controller.signal,
			}),
		).rejects.toBe(stop);
		expect(refreshGh).not.toHaveBeenCalled();
	});

	it("resolveFreshRepoToken passes the signal into the GitHub refresh", async () => {
		const controller = new AbortController();
		findFirst.mockResolvedValue(nearExpiry);
		refreshGh.mockResolvedValue({ token: "fresh" });
		const resolved = await resolveFreshRepoToken({
			integrationId: "i1",
			projectId: "p1",
			signal: controller.signal,
		});
		expect(resolved.token).toBe("fresh");
		expect(refreshGh).toHaveBeenCalledWith(
			expect.objectContaining({ signal: controller.signal }),
		);
	});

	it.each([
		["GITHUB", () => refreshGh],
		["GITLAB", () => getValidGitLabAccessToken],
	] as const)(
		"resolveFreshRepoTokenForRow starts no %s refresh once the signal has aborted",
		async (provider, refresher) => {
			process.env.GITLAB_CLIENT_ID = "id";
			process.env.GITLAB_CLIENT_SECRET = "secret";
			await expect(
				resolveFreshRepoTokenForRow(
					{ ...nearExpiry, provider } as never,
					{ signal: aborted() },
				),
			).rejects.toBe(stop);
			expect(refresher()).not.toHaveBeenCalled();
		},
	);

	// An exchange that has started runs to its end and its result is
	// persisted (the refresh token is single-use); the caller then gets its
	// own reason rather than a token it no longer wants.
	it.each([
		["GITHUB", "fresh", () => refreshGh],
		["GITHUB", null, () => refreshGh],
		["GITLAB", "fresh", () => getValidGitLabAccessToken],
	] as const)(
		"resolveFreshRepoTokenForRow completes a %s refresh (token %s) the signal aborted during, then throws the reason",
		async (provider, token, refresher) => {
			process.env.GITLAB_CLIENT_ID = "id";
			process.env.GITLAB_CLIENT_SECRET = "secret";
			const controller = new AbortController();
			if (provider === "GITHUB") {
				refreshGh.mockImplementationOnce(async () => {
					controller.abort(stop);
					return { token };
				});
			} else {
				getValidGitLabAccessToken.mockImplementationOnce(async () => {
					controller.abort(stop);
					return token;
				});
			}
			await expect(
				resolveFreshRepoTokenForRow(
					{ ...nearExpiry, provider } as never,
					{ signal: controller.signal },
				),
			).rejects.toBe(stop);
			expect(refresher()).toHaveBeenCalledTimes(1);
		},
	);

	it.each([
		["GITHUB", () => refreshGh],
		["GITLAB", () => getValidGitLabAccessToken],
	] as const)(
		"forceReExchangeRepoCredentials completes a %s re-exchange the signal aborted during, then throws the reason",
		async (provider, refresher) => {
			process.env.GITLAB_CLIENT_ID = "id";
			process.env.GITLAB_CLIENT_SECRET = "secret";
			findUnique.mockResolvedValue({
				provider,
				authMethod: "OAUTH",
				encryptedRefreshToken: "ref",
				updatedAt: new Date(),
			});
			const controller = new AbortController();
			if (provider === "GITHUB") {
				refreshGh.mockImplementationOnce(async () => {
					controller.abort(stop);
					return { token: "fresh" };
				});
			} else {
				getValidGitLabAccessToken.mockImplementationOnce(async () => {
					controller.abort(stop);
					return "fresh";
				});
			}
			await expect(
				forceReExchangeRepoCredentials({
					integrationId: "i1",
					userId: "u1",
					signal: controller.signal,
				}),
			).rejects.toBe(stop);
			expect(refresher()).toHaveBeenCalledTimes(1);
		},
	);

	it("forceReExchangeRepoCredentials throws the reason, not { refreshed: false }, and starts no exchange", async () => {
		await expect(
			forceReExchangeRepoCredentials({
				integrationId: "i1",
				userId: "u1",
				signal: aborted(),
			}),
		).rejects.toBe(stop);
		expect(findUnique).not.toHaveBeenCalled();
		expect(refreshGh).not.toHaveBeenCalled();
	});

	it("forceReExchangeRepoCredentials rethrows the caller's abort from the refresh, and still reports any other failure as not refreshed", async () => {
		findUnique.mockResolvedValue({
			provider: "GITHUB",
			authMethod: "OAUTH",
			encryptedRefreshToken: "ref",
			updatedAt: new Date(),
		});
		const controller = new AbortController();
		refreshGh.mockImplementationOnce(async () => {
			controller.abort(stop);
			throw stop;
		});
		await expect(
			forceReExchangeRepoCredentials({
				integrationId: "i1",
				userId: "u1",
				signal: controller.signal,
			}),
		).rejects.toBe(stop);
		expect(refreshGh).toHaveBeenCalledWith(
			expect.objectContaining({ signal: controller.signal }),
		);

		refreshGh.mockRejectedValueOnce(new Error("pool exhausted"));
		expect(
			await forceReExchangeRepoCredentials({
				integrationId: "i1",
				userId: "u1",
				signal: new AbortController().signal,
			}),
		).toEqual({ refreshed: false });
	});

	it("markRepoReauthRequired throws the reason and writes no status once the signal has aborted", async () => {
		await expect(
			markRepoReauthRequired({
				integrationId: "i1",
				reason: "dead",
				signal: aborted(),
			}),
		).rejects.toBe(stop);
		expect(setIntegrationStatus).not.toHaveBeenCalled();
		expect(
			createRepoIntegrationCredentialNotification,
		).not.toHaveBeenCalled();
	});

	// An abort during the status write: the write commits, and the
	// notification, which would start after the stop, does not.
	it("markRepoReauthRequired completes a status write the signal aborted during, then throws the reason without notifying", async () => {
		const controller = new AbortController();
		setIntegrationStatus.mockImplementation(async () => {
			controller.abort(stop);
			return { statusChanged: true, previousStatus: "ACTIVE" };
		});
		// A configuring user to notify, so only the stop can prevent it.
		findUnique.mockResolvedValue({
			projectId: "p1",
			provider: "GITHUB",
			repositoryOwner: "o",
			repositoryName: "r",
			configuredByUserId: "u1",
			project: { name: "P", organizationId: "org1" },
		});
		await expect(
			markRepoReauthRequired({
				integrationId: "i1",
				reason: "dead",
				signal: controller.signal,
			}),
		).rejects.toBe(stop);
		expect(setIntegrationStatus).toHaveBeenCalledTimes(1);
		expect(
			createRepoIntegrationCredentialNotification,
		).not.toHaveBeenCalled();
	});
});
