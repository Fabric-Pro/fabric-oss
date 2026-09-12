/**
 * `getGitHubWorkflowCredential` — which credential type a user actually stored.
 *
 * `extractAccessToken` accepts `access_token`, `GITHUB_TOKEN`, `token` and
 * `apiKey` alike, so a Personal Access Token and a GitHub App grant are
 * indistinguishable by the token string alone. The repository picker and the
 * connect path both branch on this classification: a PAT already carries its own
 * repository access and can be stored directly, while an App grant needs its
 * authorization flow to install the App on the target repository first.
 *
 * Getting it wrong in the "pat" direction is the damaging one — an App
 * user-to-server token stored as `encryptedPat` expires within hours and carries
 * no refresh token, so the integration dies silently a little after it was
 * connected. These cases are written against the shapes the real writers
 * produce, not invented ones.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockFindFirst } = vi.hoisted(() => ({
	mockFindFirst: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		workflowIntegration: {
			findFirst: mockFindFirst,
			findUnique: vi.fn(),
			update: vi.fn(),
		},
	},
}));

const { mockDecrypt } = vi.hoisted(() => ({
	mockDecrypt: vi.fn((v: string) => v),
}));

vi.mock("@repo/utils", () => ({
	decryptApiKey: (v: string) => mockDecrypt(v),
	encryptApiKey: vi.fn((v: string) => `enc-${v}`),
}));

import { getGitHubWorkflowCredential } from "../../src/github";

/** A stored row is only ever reached through its `credentials` blob. */
function storedCredentials(blob: string) {
	mockFindFirst.mockResolvedValue({
		id: "wfint-1",
		credentials: blob,
		settings: {},
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mockDecrypt.mockImplementation((v: string) => v);
});

describe("getGitHubWorkflowCredential", () => {
	it("returns null when the user has no active GitHub workflow integration", async () => {
		mockFindFirst.mockResolvedValue(null);

		expect(await getGitHubWorkflowCredential("user-1")).toBeNull();
	});

	it("classifies a GitHub App grant as oauth", async () => {
		// What the OAuth callback writes: access_token + refresh_token.
		storedCredentials(
			JSON.stringify({
				access_token: "gho_app_token",
				refresh_token: "ghr_refresh",
				expires_in: 28800,
			}),
		);

		expect(await getGitHubWorkflowCredential("user-1")).toEqual({
			kind: "oauth",
			token: "gho_app_token",
		});
	});

	it("classifies an App grant with token expiry disabled as oauth", async () => {
		// No refresh_token, but still an App grant — `access_token` alone decides.
		storedCredentials(JSON.stringify({ access_token: "gho_app_token" }));

		const result = await getGitHubWorkflowCredential("user-1");

		expect(result?.kind).toBe("oauth");
	});

	it("classifies a manually saved PAT as pat", async () => {
		// What the integrations form writes: the plugin's envVar field name.
		storedCredentials(JSON.stringify({ GITHUB_TOKEN: "ghp_manual_token" }));

		expect(await getGitHubWorkflowCredential("user-1")).toEqual({
			kind: "pat",
			token: "ghp_manual_token",
		});
	});

	it("classifies a fine-grained PAT stored under apiKey as pat", async () => {
		storedCredentials(
			JSON.stringify({ apiKey: "github_pat_fine_grained" }),
		);

		expect(await getGitHubWorkflowCredential("user-1")).toEqual({
			kind: "pat",
			token: "github_pat_fine_grained",
		});
	});

	it("classifies a bare, non-JSON token string as pat", async () => {
		storedCredentials("ghp_bare_token_string");

		expect(await getGitHubWorkflowCredential("user-1")).toEqual({
			kind: "pat",
			token: "ghp_bare_token_string",
		});
	});

	it("returns null rather than guessing when the credential cannot be decrypted", async () => {
		// Undecryptable ciphertext says nothing about the credential type, and
		// guessing "pat" is what would store an App token in `encryptedPat` and
		// let it expire silently. Exercised through the classifier's own decrypt
		// guard, which runs before the refresh.
		storedCredentials("corrupt-ciphertext");
		mockDecrypt.mockImplementation(() => {
			throw new Error("Invalid decryption key");
		});

		expect(await getGitHubWorkflowCredential("user-1")).toBeNull();
	});

	it("scopes the lookup to the caller and the organization context", async () => {
		mockFindFirst.mockResolvedValue(null);

		await getGitHubWorkflowCredential("user-1", "org-1");

		expect(mockFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					userId: "user-1",
					organizationId: "org-1",
					provider: "GITHUB",
					isActive: true,
				}),
			}),
		);
	});
});
