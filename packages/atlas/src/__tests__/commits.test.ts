import { afterEach, describe, expect, it, vi } from "vitest";
import { countCommitsSince } from "../commits";

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

function mockFetch(handler: (url: string) => { ok: boolean; body?: unknown }) {
	const fetchMock = vi.fn(async (url: string) => {
		const { ok, body } = handler(String(url));
		return {
			ok,
			text: async () => JSON.stringify(body ?? {}),
			json: async () => body ?? {},
		} as unknown as Response;
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("countCommitsSince", () => {
	it("counts GitHub ahead AND behind via the compare API", async () => {
		mockFetch((url) => {
			if (url.includes("/commits/main")) {
				return { ok: true, body: { sha: "HEADSHA" } };
			}
			if (url.includes("/compare/BASE...HEADSHA")) {
				return { ok: true, body: { ahead_by: 3, behind_by: 2 } };
			}
			return { ok: false };
		});
		const r = await countCommitsSince({
			provider: "GITHUB",
			token: "t",
			repositoryUrl: "https://github.com/o/r",
			owner: "o",
			repo: "r",
			branch: "main",
			baseSha: "BASE",
		});
		expect(r).toEqual({
			headSha: "HEADSHA",
			aheadBy: 3,
			behindBy: 2,
			comparable: true,
		});
	});

	it("resolves behind null when GitHub omits behind_by", async () => {
		mockFetch((url) => {
			if (url.includes("/commits/main")) {
				return { ok: true, body: { sha: "HEADSHA" } };
			}
			if (url.includes("/compare/BASE...HEADSHA")) {
				return { ok: true, body: { ahead_by: 3 } };
			}
			return { ok: false };
		});
		const r = await countCommitsSince({
			provider: "GITHUB",
			token: "t",
			repositoryUrl: "https://github.com/o/r",
			owner: "o",
			repo: "r",
			branch: "main",
			baseSha: "BASE",
		});
		expect(r).toEqual({
			headSha: "HEADSHA",
			aheadBy: 3,
			behindBy: null,
			comparable: true,
		});
	});

	it("short-circuits when GitHub head equals base", async () => {
		mockFetch((url) => {
			if (url.includes("/commits/main")) {
				return { ok: true, body: { sha: "BASE" } };
			}
			return { ok: false };
		});
		const r = await countCommitsSince({
			provider: "GITHUB",
			token: "t",
			repositoryUrl: "https://github.com/o/r",
			owner: "o",
			repo: "r",
			branch: "main",
			baseSha: "BASE",
		});
		expect(r).toEqual({
			headSha: "BASE",
			aheadBy: 0,
			behindBy: 0,
			comparable: true,
		});
	});

	it("counts GitLab ahead via compare and behind via the reverse compare", async () => {
		const fetchMock = mockFetch((url) => {
			// Reverse compare (behind): from=branch, to=baseSha.
			if (url.includes("compare?from=main&to=BASE")) {
				return { ok: true, body: { commits: [{}] } };
			}
			// Forward compare (ahead): from=baseSha, to=branch.
			if (url.includes("/repository/compare")) {
				return {
					ok: true,
					body: { commit: { id: "HEAD" }, commits: [{}, {}] },
				};
			}
			return { ok: false };
		});
		const r = await countCommitsSince({
			provider: "GITLAB",
			token: "t",
			repositoryUrl: "https://gitlab.com/o/r",
			owner: "o",
			repo: "r",
			branch: "main",
			baseSha: "BASE",
		});
		expect(r).toEqual({
			headSha: "HEAD",
			aheadBy: 2,
			behindBy: 1,
			comparable: true,
		});
		// Exactly two compares: forward + reverse.
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("keeps the GitLab ahead count when the reverse compare fails", async () => {
		mockFetch((url) => {
			if (url.includes("compare?from=main&to=BASE")) {
				return { ok: false };
			}
			if (url.includes("/repository/compare")) {
				return {
					ok: true,
					body: { commit: { id: "HEAD" }, commits: [{}, {}] },
				};
			}
			return { ok: false };
		});
		const r = await countCommitsSince({
			provider: "GITLAB",
			token: "t",
			repositoryUrl: "https://gitlab.com/o/r",
			owner: "o",
			repo: "r",
			branch: "main",
			baseSha: "BASE",
		});
		expect(r).toEqual({
			headSha: "HEAD",
			aheadBy: 2,
			behindBy: null,
			comparable: true,
		});
	});

	it("counts Azure DevOps commits via commitsBatch (behind unknown)", async () => {
		mockFetch((url) => {
			if (url.includes("/_apis/git/repositories/repo/commits")) {
				return {
					ok: true,
					body: { count: 5, value: [{ commitId: "H" }] },
				};
			}
			return { ok: false };
		});
		const r = await countCommitsSince({
			provider: "AZURE_DEVOPS",
			token: "t",
			repositoryUrl: "https://dev.azure.com/org/proj/_git/repo",
			owner: "org",
			repo: "repo",
			branch: "main",
			baseSha: "BASE",
		});
		expect(r).toEqual({
			headSha: "H",
			aheadBy: 5,
			behindBy: null,
			comparable: true,
		});
	});

	it("returns incomparable when the provider API errors", async () => {
		mockFetch(() => ({ ok: false }));
		const r = await countCommitsSince({
			provider: "GITHUB",
			token: "t",
			repositoryUrl: "https://github.com/o/r",
			owner: "o",
			repo: "r",
			branch: "main",
			baseSha: "BASE",
		});
		expect(r.comparable).toBe(false);
		expect(r.aheadBy).toBeNull();
		expect(r.behindBy).toBeNull();
	});

	it("returns incomparable for an unsupported provider", async () => {
		const r = await countCommitsSince({
			provider: "BITBUCKET",
			token: "t",
			repositoryUrl: "https://bitbucket.org/o/r",
			owner: "o",
			repo: "r",
			branch: "main",
			baseSha: "BASE",
		});
		expect(r).toEqual({
			headSha: null,
			aheadBy: null,
			behindBy: null,
			comparable: false,
		});
	});
});
