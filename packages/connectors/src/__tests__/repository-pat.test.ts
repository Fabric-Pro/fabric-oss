import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	canGitHubTokenListRepositories,
	readGitHubTokenAccount,
	validateGitHubPat,
	validateGitLabPat,
} from "../repository-pat";

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

describe("readGitHubTokenAccount", () => {
	function userResponse(
		status: number,
		body: unknown,
		scopes: string | null,
	) {
		return {
			ok: status >= 200 && status < 300,
			status,
			json: async () => body,
			headers: {
				get: (name: string) =>
					name.toLowerCase() === "x-oauth-scopes" ? scopes : null,
			},
		};
	}

	it("reads the account id, login and classic scopes from GET /user", async () => {
		mockFetch.mockResolvedValue(
			userResponse(
				200,
				{ id: 42, login: "example-dev" },
				"repo, workflow",
			),
		);
		const result = await readGitHubTokenAccount({ pat: "ghp_x" });

		const [url, init] = mockFetch.mock.calls[0];
		expect(url).toBe("https://api.github.com/user");
		expect(init.headers.Authorization).toBe("Bearer ghp_x");
		expect(result).toEqual({
			ok: true,
			id: "42",
			login: "example-dev",
			scopes: ["repo", "workflow"],
			tokenType: "classic",
		});
	});

	it("gives a fine-grained token, which sends no scopes header, an empty list", async () => {
		mockFetch.mockResolvedValue(
			userResponse(200, { id: 7, login: "example-dev" }, null),
		);
		expect(await readGitHubTokenAccount({ pat: "github_pat_x" })).toEqual({
			ok: true,
			id: "7",
			login: "example-dev",
			scopes: [],
			tokenType: "fine-grained",
		});
	});

	it("calls a token whose scopes header is present but empty a classic token with no scopes", async () => {
		mockFetch.mockResolvedValue(
			userResponse(200, { id: 7, login: "example-dev" }, ""),
		);
		expect(await readGitHubTokenAccount({ pat: "ghp_x" })).toMatchObject({
			scopes: [],
			tokenType: "classic",
		});
	});

	it("returns { ok: false, status } on a non-2xx", async () => {
		mockFetch.mockResolvedValue(userResponse(401, {}, null));
		expect(await readGitHubTokenAccount({ pat: "ghp_x" })).toEqual({
			ok: false,
			status: 401,
		});
	});
});

describe("canGitHubTokenListRepositories", () => {
	it("asks for one repository and answers whether GitHub allowed it", async () => {
		mockFetch.mockResolvedValue(response(200));
		expect(
			await canGitHubTokenListRepositories({ pat: "github_pat_x" }),
		).toBe(true);
		expect(mockFetch.mock.calls[0]?.[0]).toBe(
			"https://api.github.com/user/repos?per_page=1",
		);
		mockFetch.mockResolvedValue(response(403));
		expect(
			await canGitHubTokenListRepositories({ pat: "github_pat_x" }),
		).toBe(false);
	});
});

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
