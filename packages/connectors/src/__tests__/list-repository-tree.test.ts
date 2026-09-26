/**
 * `listRepositoryTree` — the Living Memory repository-sync dialog's tree read
 * (Fizzy #2674). A closed outcome set like `listRepositoryBranches`: every
 * provider failure is `ok: false`, never an empty listing; GitLab is
 * `unsupported`; every path is in the sync's plain spelling; and the token
 * never leaves the request.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	isRepositoryTreeProvider,
	listRepositoryTree,
	MAX_REPOSITORY_TREE_ENTRIES,
} from "../repository-tree";

const mockFetch = vi.fn();

beforeEach(() => {
	vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

// Distinctive and token-shaped, so a leak assertion cannot pass by accident.
const SECRET_TOKEN = "ghs_example_tree_secret";

function jsonResponse(status: number, body: unknown = {}) {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
	};
}

const githubInput = {
	provider: "GITHUB" as const,
	token: SECRET_TOKEN,
	repositoryUrl: "https://github.com/example-org/memory",
	owner: "example-org",
	repo: "memory",
	branch: "release/1.2",
};

const adoInput = {
	provider: "AZURE_DEVOPS" as const,
	token: SECRET_TOKEN,
	repositoryUrl: "https://dev.azure.com/example-org/Proj/_git/memory",
	owner: "example-org",
	repo: "memory",
	azureOrganization: "example-org",
	branch: "main",
};

const gitlabInput = {
	provider: "GITLAB" as const,
	token: SECRET_TOKEN,
	repositoryUrl: "https://gitlab.com/example-org/memory",
	owner: "example-org",
	repo: "memory",
	branch: "main",
};

/** The sync's plain spelling, as `configure`'s path rules require it. */
function expectPlain(paths: string[]) {
	for (const path of paths) {
		expect(path.startsWith("/"), path).toBe(false);
		expect(path.endsWith("/"), path).toBe(false);
		expect(path.includes("\\"), path).toBe(false);
		expect(path.trim(), path).toBe(path);
		expect(path, path).not.toBe("");
	}
}

describe("listRepositoryTree — GitHub", () => {
	it("lists blobs as files and trees as dirs in provider order, dropping submodules", async () => {
		mockFetch.mockResolvedValue(
			jsonResponse(200, {
				sha: "abc",
				truncated: false,
				tree: [
					{ path: "docs", type: "tree" },
					{ path: "docs/guide.md", type: "blob" },
					{ path: "vendor/lib", type: "commit" },
					{ path: "README.md", type: "blob" },
				],
			}),
		);

		const result = await listRepositoryTree(githubInput);

		expect(result).toEqual({
			ok: true,
			entries: [
				{ path: "docs", type: "dir" },
				{ path: "docs/guide.md", type: "file" },
				{ path: "README.md", type: "file" },
			],
			truncated: false,
		});
		const [url, init] = mockFetch.mock.calls[0] as [
			string,
			{ headers: Record<string, string>; signal?: AbortSignal },
		];
		expect(url).toBe(
			"https://api.github.com/repos/example-org/memory/git/trees/release%2F1.2?recursive=1",
		);
		expect(init.headers.Authorization).toBe(`Bearer ${SECRET_TOKEN}`);
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});

	it("marks a blob that is not a regular file — a symbolic link — regular: false (Fizzy #2726)", async () => {
		mockFetch.mockResolvedValue(
			jsonResponse(200, {
				truncated: false,
				tree: [
					{ path: "docs", type: "tree", mode: "040000" },
					{ path: "docs/guide.md", type: "blob", mode: "100644" },
					{ path: "run.sh", type: "blob", mode: "100755" },
					{ path: "linked.md", type: "blob", mode: "120000" },
					{ path: "docs/odd-mode.md", type: "blob", mode: "100664" },
					{ path: "vendor/lib", type: "commit", mode: "160000" },
					// No mode at all: a file, as before the marker.
					{ path: "legacy.md", type: "blob" },
				],
			}),
		);

		expect(await listRepositoryTree(githubInput)).toEqual({
			ok: true,
			entries: [
				{ path: "docs", type: "dir" },
				{ path: "docs/guide.md", type: "file" },
				{ path: "run.sh", type: "file" },
				{ path: "linked.md", type: "file", regular: false },
				{ path: "docs/odd-mode.md", type: "file", regular: false },
				{ path: "legacy.md", type: "file" },
			],
			truncated: false,
		});
	});

	it("carries the provider's own truncated flag", async () => {
		mockFetch.mockResolvedValue(
			jsonResponse(200, {
				truncated: true,
				tree: [{ path: "docs", type: "tree" }],
			}),
		);

		expect(await listRepositoryTree(githubInput)).toEqual({
			ok: true,
			entries: [{ path: "docs", type: "dir" }],
			truncated: true,
		});
	});

	it("cuts a listing over the cap to the cap and marks it truncated", async () => {
		const tree = Array.from(
			{ length: MAX_REPOSITORY_TREE_ENTRIES + 5 },
			(_, i) => ({ path: `docs/f${i}.md`, type: "blob" }),
		);
		mockFetch.mockResolvedValue(
			jsonResponse(200, { truncated: false, tree }),
		);

		const result = await listRepositoryTree(githubInput);

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.truncated).toBe(true);
		expect(result.entries).toHaveLength(MAX_REPOSITORY_TREE_ENTRIES);
		expect(result.entries.at(-1)).toEqual({
			path: `docs/f${MAX_REPOSITORY_TREE_ENTRIES - 1}.md`,
			type: "file",
		});
	});

	it("leaves out a path that has no plain spelling", async () => {
		mockFetch.mockResolvedValue(
			jsonResponse(200, {
				truncated: false,
				tree: [
					{ path: "docs", type: "tree" },
					{ path: "docs\\odd.md", type: "blob" },
					{ path: " spaced.md", type: "blob" },
				],
			}),
		);

		expect(await listRepositoryTree(githubInput)).toEqual({
			ok: true,
			entries: [{ path: "docs", type: "dir" }],
			truncated: false,
		});
	});

	it("answers 404 not-found", async () => {
		mockFetch.mockResolvedValue(
			jsonResponse(404, { message: "Not Found" }),
		);

		expect(await listRepositoryTree(githubInput)).toEqual({
			ok: false,
			outcome: "not-found",
		});
	});

	it.each([401, 403])("answers %s unauthorized", async (status) => {
		mockFetch.mockResolvedValue(jsonResponse(status));

		expect(await listRepositoryTree(githubInput)).toEqual({
			ok: false,
			outcome: "unauthorized",
		});
	});

	it("answers a repository with no commits (409 'Git Repository is empty') as an empty tree", async () => {
		mockFetch.mockResolvedValue(
			jsonResponse(409, { message: "Git Repository is empty." }),
		);

		expect(await listRepositoryTree(githubInput)).toEqual({
			ok: true,
			entries: [],
			truncated: false,
		});
	});

	it.each([
		["another message", { message: "Conflict: reference is locked" }],
		["no message", {}],
		[
			"a message that only mentions an empty repository",
			{ message: "The Git Repository is empty." },
		],
	])(
		"answers a 409 with %s unreachable, never an empty tree",
		async (_label, body) => {
			mockFetch.mockResolvedValue(jsonResponse(409, body));

			expect(await listRepositoryTree(githubInput)).toEqual({
				ok: false,
				outcome: "unreachable",
			});
		},
	);

	it("answers a 409 whose body is not JSON unreachable", async () => {
		mockFetch.mockResolvedValue({
			ok: false,
			status: 409,
			json: async () => {
				throw new SyntaxError(
					"Unexpected token < in JSON at position 0",
				);
			},
		});

		expect(await listRepositoryTree(githubInput)).toEqual({
			ok: false,
			outcome: "unreachable",
		});
	});

	it("matches the empty-repository message case-insensitively", async () => {
		mockFetch.mockResolvedValue(
			jsonResponse(409, { message: "git repository is EMPTY" }),
		);

		expect(await listRepositoryTree(githubInput)).toEqual({
			ok: true,
			entries: [],
			truncated: false,
		});
	});

	it.each([500, 502, 422])("answers %s unreachable", async (status) => {
		mockFetch.mockResolvedValue(jsonResponse(status));

		expect(await listRepositoryTree(githubInput)).toEqual({
			ok: false,
			outcome: "unreachable",
		});
	});

	it("answers a network failure unreachable, never an empty success", async () => {
		mockFetch.mockRejectedValue(
			new Error(`connect ECONNREFUSED while sending ${SECRET_TOKEN}`),
		);

		const result = await listRepositoryTree(githubInput);

		expect(result.ok).toBe(false);
		expect(result).toEqual({ ok: false, outcome: "unreachable" });
	});

	it("answers a body that is not JSON unreachable, never an empty success", async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => {
				throw new SyntaxError(
					"Unexpected token < in JSON at position 0",
				);
			},
		});

		const result = await listRepositoryTree(githubInput);

		expect(result.ok).toBe(false);
		expect(result).toEqual({ ok: false, outcome: "unreachable" });
	});

	it("answers JSON without a tree unreachable, never an empty success", async () => {
		mockFetch.mockResolvedValue(jsonResponse(200, { message: "odd" }));

		const result = await listRepositoryTree(githubInput);

		expect(result.ok).toBe(false);
		expect(result).toEqual({ ok: false, outcome: "unreachable" });
	});
});

describe("listRepositoryTree — Azure DevOps", () => {
	it("strips the leading slash, skips the root, maps isFolder to dir and drops submodules", async () => {
		mockFetch.mockResolvedValue(
			jsonResponse(200, {
				count: 5,
				value: [
					{ path: "/", isFolder: true, gitObjectType: "tree" },
					{ path: "/docs", isFolder: true, gitObjectType: "tree" },
					{ path: "/docs/guide.md", gitObjectType: "blob" },
					{ path: "/vendor/lib", gitObjectType: "commit" },
					{ path: "/README.md", gitObjectType: "blob" },
				],
			}),
		);

		const result = await listRepositoryTree(adoInput);

		expect(result).toEqual({
			ok: true,
			entries: [
				{ path: "docs", type: "dir" },
				{ path: "docs/guide.md", type: "file" },
				{ path: "README.md", type: "file" },
			],
			truncated: false,
		});
		if (result.ok) {
			expectPlain(result.entries.map((e) => e.path));
		}
		const [url, init] = mockFetch.mock.calls[0] as [
			string,
			{ headers: Record<string, string>; signal?: AbortSignal },
		];
		const parsed = new URL(url);
		expect(`${parsed.origin}${parsed.pathname}`).toBe(
			"https://dev.azure.com/example-org/Proj/_apis/git/repositories/memory/items",
		);
		expect(parsed.searchParams.get("recursionLevel")).toBe("full");
		expect(parsed.searchParams.get("versionDescriptor.version")).toBe(
			"main",
		);
		expect(parsed.searchParams.get("versionDescriptor.versionType")).toBe(
			"branch",
		);
		expect(init.headers.Authorization).toBe(
			`Basic ${Buffer.from(`:${SECRET_TOKEN}`).toString("base64")}`,
		);
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});

	it("cuts a listing over the cap to the cap and marks it truncated", async () => {
		const value = [
			{ path: "/", isFolder: true },
			...Array.from(
				{ length: MAX_REPOSITORY_TREE_ENTRIES + 1 },
				(_, i) => ({
					path: `/docs/f${i}.md`,
					gitObjectType: "blob",
				}),
			),
		];
		mockFetch.mockResolvedValue(jsonResponse(200, { value }));

		const result = await listRepositoryTree(adoInput);

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.truncated).toBe(true);
		expect(result.entries).toHaveLength(MAX_REPOSITORY_TREE_ENTRIES);
		expect(result.entries[0]).toEqual({ path: "docs/f0.md", type: "file" });
	});

	it("marks a symbolic link regular: false, as a file even when it also claims to be a folder (Fizzy #2726)", async () => {
		mockFetch.mockResolvedValue(
			jsonResponse(200, {
				value: [
					{ path: "/", isFolder: true, gitObjectType: "tree" },
					{ path: "/docs", isFolder: true, gitObjectType: "tree" },
					{ path: "/docs/guide.md", gitObjectType: "blob" },
					{
						path: "/linked.md",
						gitObjectType: "blob",
						isSymLink: true,
					},
					{
						path: "/linked-folder",
						isFolder: true,
						isSymLink: true,
					},
					{
						path: "/plain.md",
						gitObjectType: "blob",
						isSymLink: false,
					},
				],
			}),
		);

		expect(await listRepositoryTree(adoInput)).toEqual({
			ok: true,
			entries: [
				{ path: "docs", type: "dir" },
				{ path: "docs/guide.md", type: "file" },
				{ path: "linked.md", type: "file", regular: false },
				{ path: "linked-folder", type: "file", regular: false },
				{ path: "plain.md", type: "file" },
			],
			truncated: false,
		});
	});

	it("answers the 203 sign-in page unauthorized", async () => {
		mockFetch.mockResolvedValue(jsonResponse(203));

		expect(await listRepositoryTree(adoInput)).toEqual({
			ok: false,
			outcome: "unauthorized",
		});
	});

	it("answers a missing branch not-found", async () => {
		mockFetch.mockResolvedValue(jsonResponse(404));

		expect(await listRepositoryTree(adoInput)).toEqual({
			ok: false,
			outcome: "not-found",
		});
	});

	it("answers a network failure unreachable", async () => {
		mockFetch.mockRejectedValue(new TypeError("fetch failed"));

		expect(await listRepositoryTree(adoInput)).toEqual({
			ok: false,
			outcome: "unreachable",
		});
	});
});

describe("listRepositoryTree — GitLab", () => {
	it("is unsupported and makes no request", async () => {
		expect(await listRepositoryTree(gitlabInput)).toEqual({
			ok: false,
			outcome: "unsupported",
		});
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("is the provider list callers consult before resolving a credential", () => {
		expect(isRepositoryTreeProvider("GITHUB")).toBe(true);
		expect(isRepositoryTreeProvider("AZURE_DEVOPS")).toBe(true);
		expect(isRepositoryTreeProvider("GITLAB")).toBe(false);
		expect(isRepositoryTreeProvider("BITBUCKET")).toBe(false);
	});
});

describe("listRepositoryTree — the token", () => {
	it("never appears in a result, whatever the provider answered", async () => {
		const answers = [
			() => mockFetch.mockResolvedValue(jsonResponse(401)),
			() => mockFetch.mockResolvedValue(jsonResponse(404)),
			() =>
				mockFetch.mockRejectedValue(new Error(`boom ${SECRET_TOKEN}`)),
			() =>
				mockFetch.mockResolvedValue(
					jsonResponse(200, {
						truncated: false,
						tree: [{ path: "docs", type: "tree" }],
					}),
				),
		];
		for (const answer of answers) {
			answer();
			for (const input of [githubInput, adoInput, gitlabInput]) {
				const result = await listRepositoryTree(input);
				expect(JSON.stringify(result)).not.toContain(SECRET_TOKEN);
			}
		}
	});
});
