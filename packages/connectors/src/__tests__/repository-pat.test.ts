import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateGitHubPat, validateGitLabPat } from "../repository-pat";

const mockFetch = vi.fn();

beforeEach(() => {
	vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

function response(status: number) {
	return { ok: status >= 200 && status < 300, status };
}

describe("validateGitHubPat", () => {
	it("validates against GET /repos/{owner}/{repo} with a Bearer token and returns ok on 200", async () => {
		mockFetch.mockResolvedValue(response(200));
		const result = await validateGitHubPat({
			pat: "ghp_x",
			owner: "acme-corp",
			repo: "my.feature-repo",
		});

		const [url, init] = mockFetch.mock.calls[0];
		expect(url).toBe(
			"https://api.github.com/repos/acme-corp/my.feature-repo",
		);
		expect(init.headers.Authorization).toBe("Bearer ghp_x");
		expect(result).toEqual({ ok: true });
	});

	it("returns { ok: false, status } on a non-2xx", async () => {
		mockFetch.mockResolvedValue(response(403));
		expect(
			await validateGitHubPat({
				pat: "ghp_x",
				owner: "acme",
				repo: "store",
			}),
		).toEqual({
			ok: false,
			status: 403,
		});
	});
});

describe("validateGitLabPat", () => {
	it("validates READ access to the REPO (GET /projects/:path), NOT /user", async () => {
		mockFetch.mockResolvedValue(response(200));
		const result = await validateGitLabPat({
			pat: "glpat_x",
			host: "https://gitlab.com",
			projectPath: "example-group/fabric-qa-demo",
		});

		const [url, init] = mockFetch.mock.calls[0];
		// The whole point of the fix: hit the project, not /user. `/user` needs the
		// unrelated `User: Read` permission a least-privilege fine-grained token
		// scoped only for repo/pipeline reads does not carry (403), which wrongly
		// rejected a token that CAN read the CI data we need.
		expect(url).toBe(
			"https://gitlab.com/api/v4/projects/example-group%2Ffabric-qa-demo",
		);
		expect(url).not.toContain("/user");
		expect(init.headers["PRIVATE-TOKEN"]).toBe("glpat_x");
		expect(result).toEqual({ ok: true });
	});

	it("URL-encodes a nested (subgroup) project path", async () => {
		mockFetch.mockResolvedValue(response(200));
		await validateGitLabPat({
			pat: "glpat_x",
			host: "https://gitlab.com",
			projectPath: "group/subgroup/app",
		});
		expect(mockFetch.mock.calls[0][0]).toBe(
			"https://gitlab.com/api/v4/projects/group%2Fsubgroup%2Fapp",
		);
	});

	it("returns { ok: false, status } when the token cannot read the repo (403)", async () => {
		mockFetch.mockResolvedValue(response(403));
		expect(
			await validateGitLabPat({
				pat: "glpat_x",
				host: "https://gitlab.com",
				projectPath: "group/app",
			}),
		).toEqual({ ok: false, status: 403 });
	});
});
