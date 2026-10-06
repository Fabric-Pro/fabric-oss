/**
 * The `validateAzureDevOpsPat` Temporal activity (connect flow): Azure DevOps
 * answers an invalid or expired PAT with HTTP 203 and an HTML sign-in page, and
 * `Response.ok` is true for 203, so the activity must read the status first.
 *
 * Run with: pnpm --filter @repo/temporal test repo-health-check-validate-ado-pat
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	db: {
		projectRepositoryIntegration: { update: vi.fn(), findUnique: vi.fn() },
		user: { findUnique: vi.fn() },
		project: { findUnique: vi.fn() },
	},
	getActiveIntegrations: vi.fn(),
	logRepoIntegrationActivity: vi.fn(),
	setIntegrationStatus: vi.fn(),
	restoreIntegrationActive: vi.fn(),
	createRepoIntegrationCredentialNotification: vi.fn(),
}));

vi.mock("@repo/integrations", () => ({
	refreshProjectRepoGitHubTokenWithOutcome: vi.fn(),
}));

vi.mock("@repo/utils", () => ({
	decryptApiKey: (token: string) => `decrypted:${token}`,
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { validateAzureDevOpsPat } from "../src/activities/repo-health-check";

const input = { encryptedPat: "enc-pat", azureOrganization: "example-org" };

beforeEach(() => {
	vi.clearAllMocks();
});

describe("validateAzureDevOpsPat activity", () => {
	it("is valid on a 200 from connectionData", async () => {
		mockFetch.mockResolvedValueOnce(new Response("{}", { status: 200 }));

		expect(await validateAzureDevOpsPat(input)).toEqual({ valid: true });
		expect(mockFetch.mock.calls[0][0]).toBe(
			"https://dev.azure.com/example-org/_apis/connectionData",
		);
	});

	it("is invalid for a 401", async () => {
		mockFetch.mockResolvedValueOnce(new Response("", { status: 401 }));

		expect(await validateAzureDevOpsPat(input)).toEqual({
			valid: false,
			error: "Invalid PAT or insufficient permissions",
		});
	});

	it("is invalid for ADO's 203 sign-in page, the same as a 401", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response("<html>sign in</html>", {
				status: 203,
				headers: { "content-type": "text/html" },
			}),
		);

		expect(await validateAzureDevOpsPat(input)).toEqual({
			valid: false,
			error: "Invalid PAT or insufficient permissions",
		});
	});
});
