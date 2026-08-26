/**
 * PAT health-check coverage for GitHub and GitLab repository integrations.
 *
 * These combinations shipped via PAT-connect but the health check only knew
 * GITHUB+OAUTH, GITLAB+OAUTH and AZURE_DEVOPS+PAT — so every PAT-connected
 * GitHub/GitLab repo fell through to "Unknown provider/authMethod combination"
 * and was flipped to ERROR on the next 30-minute cycle, surfacing
 * "Connection error — reconnect to restore access" in the UI for a credential
 * that was working. Observed live on staging: a GitLab PAT that had just
 * cloned and indexed the repository was marked broken minutes later.
 *
 * Run with: pnpm --filter @repo/temporal test repo-health-check-pat
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockProjectRepositoryIntegrationUpdate = vi.fn();
const mockProjectRepositoryIntegrationFindUnique = vi.fn();
const mockSetIntegrationStatus = vi.fn();
const mockLogRepoIntegrationActivity = vi.fn();
const mockUserFindUnique = vi.fn();

vi.mock("@repo/database", () => ({
	db: {
		projectRepositoryIntegration: {
			update: (...args: unknown[]) =>
				mockProjectRepositoryIntegrationUpdate(...args),
			findUnique: (...args: unknown[]) =>
				mockProjectRepositoryIntegrationFindUnique(...args),
		},
		user: {
			findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
		},
		project: { findUnique: vi.fn() },
	},
	getActiveIntegrations: vi.fn(),
	logRepoIntegrationActivity: (...args: unknown[]) =>
		mockLogRepoIntegrationActivity(...args),
	setIntegrationStatus: (...args: unknown[]) =>
		mockSetIntegrationStatus(...args),
	restoreIntegrationActive: vi.fn(),
	createRepoIntegrationCredentialNotification: vi.fn(),
}));

vi.mock("@repo/integrations/gitlab", async () => {
	const actual = await vi.importActual<
		typeof import("@repo/integrations/gitlab")
	>("@repo/integrations/gitlab");
	return {
		...actual,
		gitlabRequest: vi.fn(),
		getValidGitLabAccessToken: vi.fn(),
	};
});

vi.mock("@repo/integrations", () => ({
	refreshProjectRepoGitHubTokenWithOutcome: vi
		.fn()
		.mockResolvedValue({ token: null, platformFault: "INTERNAL" }),
}));

vi.mock("@repo/utils", () => ({
	decryptApiKey: (token: string) => `decrypted:${token}`,
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import {
	type CheckIntegrationHealthInput,
	checkRepoIntegrationHealth,
} from "../src/activities/repo-health-check";

function buildInput(
	overrides: Partial<CheckIntegrationHealthInput> = {},
): CheckIntegrationHealthInput {
	return {
		integrationId: "int-pat-1",
		provider: "GITHUB",
		authMethod: "PAT",
		encryptedAccessToken: null,
		encryptedRefreshToken: null,
		encryptedPat: "enc-pat",
		tokenExpiresAt: null,
		updatedAt: new Date("2026-01-01T00:00:00Z"),
		configuredByUserId: "user-1",
		projectId: "project-1",
		projectName: "Project One",
		organizationId: "org-1",
		repositoryOwner: "owner",
		repositoryName: "repo",
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mockUserFindUnique.mockResolvedValue({ name: "Test User" });
	mockProjectRepositoryIntegrationFindUnique.mockResolvedValue({
		status: "ACTIVE",
	});
	mockProjectRepositoryIntegrationUpdate.mockResolvedValue({});
	mockSetIntegrationStatus.mockResolvedValue({
		status: "TOKEN_EXPIRED",
		statusChanged: true,
		previousStatus: "ACTIVE",
	});
});

describe("checkRepoIntegrationHealth — PAT-connected repositories", () => {
	it("GITHUB+PAT with a valid token is healthy, not an unknown combination", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			status: 200,
			headers: new Headers(),
		});

		const result = await checkRepoIntegrationHealth(buildInput());

		expect(result.healthy).toBe(true);
		// The regression: this used to be flipped to ERROR without any probe.
		expect(mockSetIntegrationStatus).not.toHaveBeenCalled();
		const [url, init] = mockFetch.mock.calls[0];
		// The probe is REPOSITORY-scoped, not account-level: a scoped PAT can
		// be valid at account level yet unable to read this one repository, and
		// that distinction decides the status.
		expect(url).toBe("https://api.github.com/repos/owner/repo");
		expect(
			(init as { headers: Record<string, string> }).headers.Authorization,
		).toBe("Bearer decrypted:enc-pat");
	});

	it("GITLAB+PAT with a valid token is healthy and uses the PRIVATE-TOKEN header", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			status: 200,
			headers: new Headers(),
		});

		const result = await checkRepoIntegrationHealth(
			buildInput({ provider: "GITLAB" }),
		);

		expect(result.healthy).toBe(true);
		expect(mockSetIntegrationStatus).not.toHaveBeenCalled();
		const [url, init] = mockFetch.mock.calls[0];
		expect(url).toBe("https://gitlab.com/api/v4/projects/owner%2Frepo");
		// GitLab PATs authenticate with PRIVATE-TOKEN, not a bearer header.
		expect(
			(init as { headers: Record<string, string> }).headers[
				"PRIVATE-TOKEN"
			],
		).toBe("decrypted:enc-pat");
	});

	it("a revoked PAT is reported as TOKEN_EXPIRED, not a generic error", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: false,
			status: 401,
			headers: new Headers(),
		});

		const result = await checkRepoIntegrationHealth(
			buildInput({ provider: "GITLAB" }),
		);

		expect(result.healthy).toBe(false);
		expect(mockSetIntegrationStatus).toHaveBeenCalledWith(
			"int-pat-1",
			"TOKEN_EXPIRED",
			expect.stringContaining("rejected the connected credentials"),
		);
	});

	// A quota wall is not a dead credential. Flipping a working PAT to
	// TOKEN_EXPIRED because the org was busy notifies the user to reconnect a
	// credential that is fine — the exact false positive the OAuth branch was
	// already hardened against.
	it("a GitHub 403 rate-limit response does NOT mark the PAT expired", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: false,
			status: 403,
			headers: new Headers({ "x-ratelimit-remaining": "0" }),
		});

		const result = await checkRepoIntegrationHealth(buildInput());

		expect(result.healthy).toBe(true);
		expect(mockSetIntegrationStatus).not.toHaveBeenCalled();
	});

	it("a GitLab 429 rate-limit response does NOT mark the PAT expired", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: false,
			status: 429,
			headers: new Headers(),
		});

		const result = await checkRepoIntegrationHealth(
			buildInput({ provider: "GITLAB" }),
		);

		expect(result.healthy).toBe(true);
		expect(mockSetIntegrationStatus).not.toHaveBeenCalled();
	});

	// A 403 that is NOT a quota wall means the PAT authenticated but cannot
	// read THIS repository — deliberately NOT TOKEN_EXPIRED (reconnect fixes
	// nothing there); the row becomes REPO_UNAVAILABLE with the grant-remedy
	// wording. Deliberate behaviour change with the repo-scoped probe.
	it("a 403 with quota remaining is REPO_UNAVAILABLE, not expired", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: false,
			status: 403,
			headers: new Headers({ "x-ratelimit-remaining": "4999" }),
		});

		const result = await checkRepoIntegrationHealth(buildInput());

		expect(result.healthy).toBe(false);
		expect(mockSetIntegrationStatus).toHaveBeenCalledWith(
			"int-pat-1",
			"REPO_UNAVAILABLE",
			expect.stringContaining("refused this repository"),
		);
	});

	it("a 404 (repo invisible to the PAT) is REPO_UNAVAILABLE", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: false,
			status: 404,
			headers: new Headers(),
		});
		mockSetIntegrationStatus.mockResolvedValueOnce({
			written: true,
			statusChanged: true,
			status: "REPO_UNAVAILABLE",
		});

		const result = await checkRepoIntegrationHealth(
			buildInput({ provider: "GITLAB" }),
		);

		expect(result.healthy).toBe(false);
		expect(mockSetIntegrationStatus).toHaveBeenCalledWith(
			"int-pat-1",
			"REPO_UNAVAILABLE",
			expect.stringContaining("not visible"),
		);
		// The PAT lane must feed the same retirement budget as the OAuth
		// lanes, or a deleted repo connected by PAT gets probed forever.
		expect(mockProjectRepositoryIntegrationUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "int-pat-1" },
				data: { probeFailCount: { increment: 1 } },
			}),
		);
	});

	it("a transient 5xx makes no transition — status stays as it was", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: false,
			status: 502,
			headers: new Headers(),
		});
		mockProjectRepositoryIntegrationUpdate.mockResolvedValue({});

		const result = await checkRepoIntegrationHealth(buildInput());

		expect(result.healthy).toBe(true);
		expect(result.statusChanged).toBe(false);
		expect(mockSetIntegrationStatus).not.toHaveBeenCalled();
		// The sweep is still stamped so the cadence advances.
		expect(mockProjectRepositoryIntegrationUpdate).toHaveBeenCalled();
	});

	it("a PAT row with no stored token is TOKEN_EXPIRED without probing", async () => {
		const result = await checkRepoIntegrationHealth(
			buildInput({ encryptedPat: null }),
		);

		expect(result.healthy).toBe(false);
		expect(mockFetch).not.toHaveBeenCalled();
		expect(mockSetIntegrationStatus).toHaveBeenCalledWith(
			"int-pat-1",
			"TOKEN_EXPIRED",
			"No PAT configured",
		);
	});
});
