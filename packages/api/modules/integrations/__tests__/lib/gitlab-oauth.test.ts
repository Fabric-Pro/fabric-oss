import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	exchangeCodeForToken,
	generateOAuthState,
	generatePkce,
	getGitLabOAuthUrl,
	getGitLabUser,
	listGitLabBranches,
	listGitLabProjects,
	recordToolIngestError,
	refreshGitLabToken,
	resolveOrgIdForQuery,
	testGitLabToken,
} from "../../lib/gitlab-oauth";

const mockFetch = vi.fn();

beforeEach(() => {
	mockFetch.mockReset();
	vi.stubGlobal("fetch", mockFetch);
});

describe("generateOAuthState", () => {
	it("returns a 32-character hex string", () => {
		const state = generateOAuthState();
		expect(state).toMatch(/^[0-9a-f]{32}$/);
	});
});

describe("getGitLabOAuthUrl", () => {
	it("builds correct authorization URL", () => {
		const url = getGitLabOAuthUrl(
			"client123",
			"https://example.com/cb",
			"state456",
		);
		expect(url).toContain("https://gitlab.com/oauth/authorize?");
		expect(url).toContain("client_id=client123");
		expect(url).toContain("redirect_uri=https%3A%2F%2Fexample.com%2Fcb");
		expect(url).toContain("response_type=code");
		expect(url).toContain("state=state456");
	});

	it("encodes scopes with space separator (not +)", () => {
		const url = getGitLabOAuthUrl("c", "https://example.com", "s");
		// URLSearchParams encodes space as + which is correct for query strings
		expect(url).toContain("scope=api+read_user");
		// Must NOT contain %2B (double-encoded +)
		expect(url).not.toContain("scope=api%2Bread_user");
	});

	it("omits PKCE params when no codeChallenge is provided (backwards compat)", () => {
		const url = getGitLabOAuthUrl("c", "https://example.com", "s");
		expect(url).not.toContain("code_challenge");
		expect(url).not.toContain("code_challenge_method");
	});

	it("appends code_challenge and S256 method when codeChallenge is provided", () => {
		const url = getGitLabOAuthUrl(
			"c",
			"https://example.com",
			"s",
			"abc_challenge_xyz",
		);
		expect(url).toContain("code_challenge=abc_challenge_xyz");
		expect(url).toContain("code_challenge_method=S256");
	});
});

describe("generatePkce", () => {
	it("returns a URL-safe-base64 verifier between 43 and 128 chars", () => {
		const { codeVerifier } = generatePkce();
		expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
		expect(codeVerifier.length).toBeLessThanOrEqual(128);
		// RFC 7636: unreserved = ALPHA / DIGIT / "-" / "." / "_" / "~"
		// base64url uses [A-Za-z0-9_-]; both are URL-safe subsets.
		expect(codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/);
	});

	it("returns a challenge equal to base64url(sha256(verifier))", () => {
		const { codeVerifier, codeChallenge } = generatePkce();
		const expected = createHash("sha256")
			.update(codeVerifier)
			.digest("base64url");
		expect(codeChallenge).toBe(expected);
	});

	it("returns distinct verifiers on each call (non-determinism)", () => {
		const a = generatePkce();
		const b = generatePkce();
		expect(a.codeVerifier).not.toBe(b.codeVerifier);
		expect(a.codeChallenge).not.toBe(b.codeChallenge);
	});
});

describe("exchangeCodeForToken", () => {
	it("sends urlencoded body with correct fields", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				access_token: "tok_123",
				token_type: "bearer",
				expires_in: 7200,
				refresh_token: "ref_456",
				created_at: 1234567890,
				scope: "api read_user",
			}),
		});

		await exchangeCodeForToken(
			"code_abc",
			"client_id",
			"client_secret",
			"https://cb.com",
		);

		expect(mockFetch).toHaveBeenCalledWith(
			"https://gitlab.com/oauth/token",
			expect.objectContaining({
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
				},
			}),
		);

		const body = mockFetch.mock.calls[0][1].body;
		expect(body).toContain("grant_type=authorization_code");
		expect(body).toContain("code=code_abc");
		expect(body).toContain("client_id=client_id");
	});

	it("returns token response on success", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				access_token: "tok_123",
				token_type: "bearer",
				expires_in: 7200,
				refresh_token: "ref_456",
				created_at: 1234567890,
				scope: "api",
			}),
		});

		const result = await exchangeCodeForToken(
			"code",
			"cid",
			"csecret",
			"https://cb.com",
		);
		expect(result.access_token).toBe("tok_123");
		expect(result.refresh_token).toBe("ref_456");
	});

	it("throws on non-OK response", async () => {
		mockFetch.mockResolvedValueOnce({ ok: false, status: 400 });
		await expect(
			exchangeCodeForToken("code", "cid", "csecret", "https://cb.com"),
		).rejects.toThrow("GitLab token exchange failed: 400");
	});

	it("throws on error in response body", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				error: "invalid_grant",
				error_description: "Code was already used",
			}),
		});
		await expect(
			exchangeCodeForToken("code", "cid", "csecret", "https://cb.com"),
		).rejects.toThrow("Code was already used");
	});

	it("includes code_verifier in form body when provided (PKCE)", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				access_token: "tok",
				token_type: "bearer",
				expires_in: 7200,
				refresh_token: "ref",
				created_at: 1,
				scope: "api",
			}),
		});

		await exchangeCodeForToken(
			"code",
			"cid",
			"csecret",
			"https://cb.com",
			"my_pkce_verifier_value",
		);

		const body = mockFetch.mock.calls[0][1].body as string;
		expect(body).toContain("code_verifier=my_pkce_verifier_value");
	});

	it("omits code_verifier when not provided (backwards compat)", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				access_token: "tok",
				token_type: "bearer",
				expires_in: 7200,
				refresh_token: "ref",
				created_at: 1,
				scope: "api",
			}),
		});

		await exchangeCodeForToken("code", "cid", "csecret", "https://cb.com");

		const body = mockFetch.mock.calls[0][1].body as string;
		expect(body).not.toContain("code_verifier");
	});
});

describe("refreshGitLabToken", () => {
	it("sends grant_type=refresh_token with urlencoded body", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				access_token: "new_tok",
				token_type: "bearer",
				expires_in: 7200,
				refresh_token: "new_ref",
				created_at: 1234567890,
				scope: "api",
			}),
		});

		await refreshGitLabToken("old_ref", "cid", "csecret");

		const body = mockFetch.mock.calls[0][1].body;
		expect(body).toContain("grant_type=refresh_token");
		expect(body).toContain("refresh_token=old_ref");
	});

	it("throws a plain Error on a bare 401 (not decisive — must not condemn)", async () => {
		// The error TYPE is what consumers gate `MCPConfig.needsReauth` on,
		// and that flag is enforced: only a fresh OAuth grant from the user
		// clears it. A bare 401 does not say the user's grant died — OAuth
		// answers 401 for `invalid_client` (bad application credentials) too,
		// which a reconnect cannot fix. Only `invalid_grant` / `invalid_token`
		// are decisive. The mock has no `json()`, so this also covers the
		// non-JSON-body path, where nothing decisive is available at all.
		const { GitLabReauthRequiredError } = await import(
			"@repo/integrations/gitlab"
		);
		mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
		const err = await refreshGitLabToken("ref", "cid", "csecret").catch(
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(Error);
		expect(err).not.toBeInstanceOf(GitLabReauthRequiredError);
		expect((err as Error).message).toBe("GitLab token refresh failed: 401");
	});

	it("throws a generic Error on a 5xx (transient — must not condemn)", async () => {
		mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });
		await expect(
			refreshGitLabToken("ref", "cid", "csecret"),
		).rejects.toThrow("GitLab token refresh failed: 503");
	});

	it("posts to gitlab.com/oauth/token by default", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: async () => ({ access_token: "new_tok" }),
		});

		await refreshGitLabToken("old_ref", "cid", "csecret");

		expect(mockFetch).toHaveBeenCalledWith(
			"https://gitlab.com/oauth/token",
			expect.any(Object),
		);
	});

	it("posts to self-hosted token endpoint when baseUrl is provided", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: async () => ({ access_token: "new_tok" }),
		});

		await refreshGitLabToken("old_ref", "cid", "csecret", {
			baseUrl: "https://gitlab.example.com",
		});

		expect(mockFetch).toHaveBeenCalledWith(
			"https://gitlab.example.com/oauth/token",
			expect.any(Object),
		);
	});

	it("strips trailing slash from baseUrl before appending /oauth/token", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: async () => ({ access_token: "new_tok" }),
		});

		await refreshGitLabToken("old_ref", "cid", "csecret", {
			baseUrl: "https://gitlab.example.com/",
		});

		expect(mockFetch).toHaveBeenCalledWith(
			"https://gitlab.example.com/oauth/token",
			expect.any(Object),
		);
	});
});

describe("getGitLabUser", () => {
	it("sends Bearer token and returns user", async () => {
		const mockUser = {
			id: 1,
			username: "testuser",
			name: "Test User",
			email: "test@example.com",
			avatar_url: "https://gitlab.com/avatar.png",
			web_url: "https://gitlab.com/testuser",
		};
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: async () => mockUser,
		});

		const user = await getGitLabUser("tok_123");

		expect(mockFetch).toHaveBeenCalledWith(
			"https://gitlab.com/api/v4/user",
			expect.objectContaining({
				headers: { Authorization: "Bearer tok_123" },
			}),
		);
		expect(user.username).toBe("testuser");
	});

	it("throws on non-OK response", async () => {
		mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
		await expect(getGitLabUser("bad_tok")).rejects.toThrow(
			"Failed to get GitLab user: 401",
		);
	});
});

describe("listGitLabProjects", () => {
	it("passes correct params", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: async () => [],
		});

		await listGitLabProjects("tok", 2, 50);

		const url = mockFetch.mock.calls[0][0] as string;
		expect(url).toContain("membership=true");
		expect(url).toContain("order_by=updated_at");
		expect(url).toContain("sort=desc");
		expect(url).toContain("page=2");
		expect(url).toContain("per_page=50");
	});
});

describe("listGitLabBranches", () => {
	it("URL-encodes project ID", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: async () => [],
		});

		await listGitLabBranches("tok", "group/project");

		const url = mockFetch.mock.calls[0][0] as string;
		expect(url).toContain("/projects/group%2Fproject/repository/branches");
	});
});

describe("testGitLabToken", () => {
	it("returns true when getGitLabUser succeeds", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: async () => ({ id: 1, username: "u" }),
		});
		expect(await testGitLabToken("valid_tok")).toBe(true);
	});

	it("returns false when getGitLabUser fails", async () => {
		mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
		expect(await testGitLabToken("bad_tok")).toBe(false);
	});
});

describe("resolveOrgIdForQuery", () => {
	it("returns null for personal context (undefined organizationId)", () => {
		expect(resolveOrgIdForQuery({ organizationId: undefined })).toBeNull();
	});

	it("returns null for explicit null organizationId", () => {
		expect(resolveOrgIdForQuery({ organizationId: null })).toBeNull();
	});

	it("returns the org id when provided", () => {
		expect(resolveOrgIdForQuery({ organizationId: "org_abc" })).toBe(
			"org_abc",
		);
	});

	it("returns null for empty string organizationId", () => {
		// Empty string would be a logic bug — coerce to null defensively.
		expect(resolveOrgIdForQuery({ organizationId: "" })).toBeNull();
	});
});

describe("recordToolIngestError", () => {
	it("writes a structured error to WorkflowIntegration.settings", async () => {
		const updateMock = vi.fn().mockResolvedValue(undefined);
		const fakeDb = {
			workflowIntegration: {
				update: updateMock,
			},
		};

		await recordToolIngestError({
			db: fakeDb as never,
			integrationId: "wi_1",
			error: new Error("ingestion exploded"),
		});

		expect(updateMock).toHaveBeenCalledTimes(1);
		const call = updateMock.mock.calls[0][0];
		expect(call.where).toEqual({ id: "wi_1" });
		const settingsUpdate = call.data.settings;
		expect(settingsUpdate.lastToolIngestError.message).toBe(
			"ingestion exploded",
		);
		expect(settingsUpdate.lastToolIngestError.at).toMatch(/T\d\d:/); // ISO timestamp
	});

	it("coerces non-Error error values to string message", async () => {
		const updateMock = vi.fn().mockResolvedValue(undefined);
		const fakeDb = {
			workflowIntegration: {
				update: updateMock,
			},
		};

		await recordToolIngestError({
			db: fakeDb as never,
			integrationId: "wi_2",
			error: "string error",
		});

		const call = updateMock.mock.calls[0][0];
		expect(call.data.settings.lastToolIngestError.message).toBe(
			"string error",
		);
	});
});
