import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type ResolveDefaultBranchInput,
	resolveDefaultBranch,
} from "../repository-branch";

const mockFetch = vi.fn();
let mockWarn: ReturnType<typeof vi.spyOn>;
let timeoutSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	vi.stubGlobal("fetch", mockFetch);
	mockWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
	timeoutSpy = vi.spyOn(AbortSignal, "timeout");
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

function jsonResponse(status: number, body: unknown = {}) {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
	};
}

const baseInput: Omit<ResolveDefaultBranchInput, "provider"> = {
	token: "test-token",
	repositoryUrl: "https://github.com/acme/widgets",
	owner: "acme",
	repo: "widgets",
};

describe("resolveDefaultBranch", () => {
	it("returns providedBranch without fetching if it is set", async () => {
		const result = await resolveDefaultBranch({
			...baseInput,
			provider: "GITHUB",
			providedBranch: "feature-branch",
		});

		expect(result).toBe("feature-branch");
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("returns the default branch for GitHub on a happy path", async () => {
		mockFetch.mockResolvedValue(
			jsonResponse(200, { default_branch: "develop" }),
		);

		const result = await resolveDefaultBranch({
			...baseInput,
			provider: "GITHUB",
		});

		expect(result).toBe("develop");
		const [url, init] = mockFetch.mock.calls[0];
		expect(url).toBe("https://api.github.com/repos/acme/widgets");
		expect(init.headers.Authorization).toBe("Bearer test-token");
		expect(timeoutSpy).toHaveBeenCalledWith(5000);
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});

	it("returns the stripped branch name for Azure DevOps (e.g. refs/heads/dev -> dev)", async () => {
		mockFetch.mockResolvedValue(
			jsonResponse(200, { defaultBranch: "refs/heads/dev" }),
		);

		const result = await resolveDefaultBranch({
			...baseInput,
			provider: "AZURE_DEVOPS",
			repositoryUrl: "https://dev.azure.com/my-org/Proj/_git/widgets",
			azureOrganization: "my-org",
		});

		expect(result).toBe("dev");
		const [url, init] = mockFetch.mock.calls[0];
		expect(url).toContain(
			"https://dev.azure.com/my-org/Proj/_apis/git/repositories/widgets",
		);
		expect(init.headers.Authorization).toMatch(/^Basic /);
	});

	it("warns and falls back to 'main' when fetch throws an error", async () => {
		mockFetch.mockRejectedValue(new Error("Network Error"));

		const result = await resolveDefaultBranch({
			...baseInput,
			provider: "GITHUB",
		});

		expect(result).toBe("main");
		expect(mockWarn).toHaveBeenCalledWith(
			"Failed to resolve default branch; falling back",
			expect.objectContaining({
				provider: "GITHUB",
				repo: "widgets",
				error: "Network Error",
			}),
		);
	});

	it("falls back to 'main' on a non-200 response without throwing", async () => {
		mockFetch.mockResolvedValue(jsonResponse(404));

		const result = await resolveDefaultBranch({
			...baseInput,
			provider: "GITHUB",
		});

		expect(result).toBe("main");
	});

	it("fetches from the API instead of returning providedBranch when providedBranch is an empty string", async () => {
		mockFetch.mockResolvedValue(
			jsonResponse(200, { default_branch: "main" }),
		);

		await resolveDefaultBranch({
			...baseInput,
			provider: "GITHUB",
			providedBranch: "",
		});

		expect(mockFetch).toHaveBeenCalled();
	});

	it("returns the default branch for GitLab on a happy path", async () => {
		mockFetch.mockResolvedValue(
			jsonResponse(200, { default_branch: "master" }),
		);

		const result = await resolveDefaultBranch({
			...baseInput,
			provider: "GITLAB",
			repositoryUrl: "https://gitlab.com/acme/widgets",
		});

		expect(result).toBe("master");
		const [url, init] = mockFetch.mock.calls[0];
		expect(url).toBe("https://gitlab.com/api/v4/projects/acme%2Fwidgets");
		expect(init.headers.Authorization).toBe("Bearer test-token");
	});

	// SSRF pin (Fizzy #2252 follow-up): the fetch host is gitlab.com even when
	// the stored URL names another host — these authenticated requests carry a
	// live access token and must not be aimable at an internal network.
	it("pins the GitLab API host to gitlab.com regardless of the stored URL", async () => {
		mockFetch.mockResolvedValue(
			jsonResponse(200, { default_branch: "master" }),
		);

		await resolveDefaultBranch({
			...baseInput,
			provider: "GITLAB",
			repositoryUrl: "https://internal-host.attacker.tld/acme/widgets",
		});

		const [url] = mockFetch.mock.calls[0];
		expect(url).toMatch(/^https:\/\/gitlab\.com\//);
	});

	it("returns 'main' without fetching for Azure DevOps if the organization cannot be resolved", async () => {
		const result = await resolveDefaultBranch({
			...baseInput,
			provider: "AZURE_DEVOPS",
			repositoryUrl: "https://invalid-url.com",
			azureOrganization: undefined,
		});

		expect(result).toBe("main");
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("returns 'main' if the API returns an empty string for the default branch", async () => {
		mockFetch.mockResolvedValue(jsonResponse(200, { default_branch: "" }));

		const result = await resolveDefaultBranch({
			...baseInput,
			provider: "GITHUB",
		});

		expect(result).toBe("main");
	});
});
