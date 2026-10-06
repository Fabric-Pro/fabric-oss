/**
 * Repository reads the chat Advisor makes through the Fabric catalog:
 * `code_tree` and `code_file_get`, run by the plan-mode code-search handler.
 *
 * - A tree larger than one page must say it is partial and how to continue,
 *   even when the provider did not flag it as truncated, and a second call
 *   with the advancing offset returns the next entries without overlap.
 * - `depth` limits the listing before it is paged, so a large repository's
 *   top level fits one page instead of being spread through every page.
 * - A read the provider refused or failed must reach the model with its
 *   reason, not as "File … not found" or "No files found"; a genuine 404 is
 *   still "not found". Checked through `runFabricCatalogTool`, which is what
 *   the chat loop calls, so the text survives the adapter.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	repos: [] as Array<Record<string, unknown>>,
	getRepositoryFile: vi.fn(),
	listRepositoryStructure: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: { project: { findUnique: vi.fn() } },
	getProjectCodeIndexes: vi.fn().mockResolvedValue([]),
	getProjectReposForCodeSearch: vi.fn(async () => h.repos),
	parseRepoUrl: vi.fn(),
}));
vi.mock("@repo/utils", () => ({ decryptApiKey: vi.fn() }));
vi.mock("@repo/integrations/repo-auth", () => ({
	resolveFreshRepoTokenForRow: vi.fn().mockResolvedValue({
		token: "token-example",
		method: "pat",
	}),
}));
vi.mock("@repo/integrations/github", () => ({
	getGitHubAccessToken: vi.fn(),
}));
vi.mock("@repo/connectors", () => ({
	searchRepositoryCode: vi.fn().mockResolvedValue({ results: [] }),
	getRepositoryFile: h.getRepositoryFile,
	listRepositoryStructure: h.listRepositoryStructure,
}));

const { TOOL_RESULTS } = await import(
	"../../src/workflows/orchestrator/orchestrator-config"
);
const { runFabricCatalogTool } = await import(
	"../../src/activities/orchestrator/execution/fabric-catalog-adapter"
);

const REPO = {
	provider: "GITHUB",
	owner: "example-org",
	repo: "app",
	branch: "main",
};

function call(toolName: string, args: Record<string, unknown>) {
	return runFabricCatalogTool({
		toolName,
		args,
		userId: "user-1",
		organizationId: "org-1",
		projectId: "project-1",
	});
}

/** A flat tree of `count` files, the shape the connector returns. */
function bigTree(count: number) {
	const entries = Array.from({ length: count }, (_, i) => ({
		path: `src/file-${String(i).padStart(4, "0")}.ts`,
		type: "file" as const,
	}));
	return {
		entries,
		totalFiles: count,
		totalDirectories: 0,
		// The provider listed everything: it is the host's page that is partial.
		truncated: false,
	};
}

function listedPaths(text: string): string[] {
	return [...text.matchAll(/📄 (\S+)/g)].map((m) => m[1]);
}

beforeEach(() => {
	vi.clearAllMocks();
	h.repos = [REPO];
});

describe("code_tree pages through a listing larger than one page", () => {
	it("says the first page is partial and gives the offset to continue", async () => {
		h.listRepositoryStructure.mockResolvedValue(bigTree(1200));

		const res = await call("code_tree", {});

		expect(res.success).toBe(true);
		const text = String((res as { output: unknown }).output);
		expect(text).toContain("directory listing");
		expect(text).toContain("not file contents");
		// The page is bounded by entry count and by characters, whichever
		// comes first; the range line says where it stopped.
		const range = text.match(/Showing entries 1–(\d+) of 1200/);
		expect(range).not.toBeNull();
		const shown = Number(range?.[1]);
		expect(shown).toBeGreaterThan(0);
		expect(shown).toBeLessThan(1200);
		expect(text).toContain(`offset=${shown}`);
		expect(listedPaths(text)).toHaveLength(shown);
	});

	it("pages to the end with the advancing offset, without overlap or gaps", async () => {
		h.listRepositoryStructure.mockResolvedValue(bigTree(1200));

		const seen: string[] = [];
		let offset = 0;
		let pages = 0;
		for (;;) {
			const text = String(
				((await call("code_tree", { offset })) as { output: unknown })
					.output,
			);
			const paths = listedPaths(text);
			expect(paths[0]).toBe(
				`src/file-${String(offset).padStart(4, "0")}.ts`,
			);
			seen.push(...paths);
			pages++;
			const next = text.match(/offset=(\d+)/);
			if (!next) {
				expect(text).toContain("of 1200 (end of listing)");
				break;
			}
			offset = Number(next[1]);
			expect(pages).toBeLessThan(20);
		}
		expect(pages).toBeGreaterThan(1);
		expect(new Set(seen).size).toBe(1200);
		expect(seen).toHaveLength(1200);
	});

	it("keeps a small listing whole, with no continuation", async () => {
		h.listRepositoryStructure.mockResolvedValue(bigTree(3));
		const text = String(
			((await call("code_tree", {})) as { output: unknown }).output,
		);
		expect(text).toMatch(/Showing entries 1–3 of 3 \(end of listing\)/);
		expect(text).not.toContain("offset=");
	});
});

describe("repository read failures are not reported as missing", () => {
	it.each([
		["forbidden", 403],
		["unauthorized", 401],
		["rate_limited", 429],
		["provider_error", 503],
	] as const)(
		"code_file_get: %s (HTTP %i) reaches the model with its reason",
		async (kind, status) => {
			h.getRepositoryFile.mockResolvedValue({
				path: "src/a.ts",
				content: "",
				size: 0,
				encoding: "none",
				isBinary: false,
				isTruncated: false,
				error: {
					kind,
					status,
					message: `Reading src/a.ts failed (HTTP ${status}).`,
				},
			});

			const res = await call("code_file_get", { path: "src/a.ts" });

			expect(res.success).toBe(false);
			const error = (res as { error: string }).error;
			expect(error).not.toMatch(/not found/i);
			expect(error).toContain(`HTTP ${status}`);
			expect(error).toContain("example-org/app");
		},
	);

	it("code_file_get: a genuine 404 is still 'not found'", async () => {
		h.getRepositoryFile.mockResolvedValue({
			path: "src/missing.ts",
			content: "",
			size: 0,
			encoding: "none",
			isBinary: false,
			isTruncated: false,
			error: {
				kind: "not_found",
				status: 404,
				message: "Reading src/missing.ts: not found (HTTP 404).",
			},
		});

		const res = await call("code_file_get", { path: "src/missing.ts" });

		expect(res).toEqual({
			success: false,
			error: "File src/missing.ts not found in any connected repository.",
		});
	});

	it("code_tree: a denied listing is an error with its reason, not 'No files found'", async () => {
		h.listRepositoryStructure.mockResolvedValue({
			entries: [],
			totalFiles: 0,
			totalDirectories: 0,
			truncated: false,
			error: {
				kind: "forbidden",
				status: 403,
				message: "Listing example-org/app was denied (HTTP 403).",
			},
		});

		const res = await call("code_tree", {});

		expect(res.success).toBe(false);
		const error = (res as { error: string }).error;
		expect(error).not.toContain("No files found");
		expect(error).toContain("HTTP 403");
	});

	it("code_tree: a genuinely empty repository is still 'No files found'", async () => {
		h.listRepositoryStructure.mockResolvedValue(bigTree(0));
		const res = await call("code_tree", {});
		expect(res).toEqual({
			success: true,
			output: "No files found in connected repositories.",
		});
	});
});

/**
 * A repository of `folders` top-level folders, each holding `filesEach`
 * files in a nested folder, plus two root files: the shape GitHub's recursive
 * tree returns, depth-first. `slash` prefixes every path with "/", as Azure
 * DevOps does, and adds the root folder's own entry.
 */
function nestedTree(folders: number, filesEach: number, slash = false) {
	const p = (path: string) => (slash ? `/${path}` : path);
	const entries: Array<{ path: string; type: "file" | "directory" }> = slash
		? [{ path: "/", type: "directory" }]
		: [];
	for (let f = 0; f < folders; f++) {
		const folder = `dir-${String(f).padStart(2, "0")}`;
		entries.push({ path: p(folder), type: "directory" });
		entries.push({ path: p(`${folder}/src`), type: "directory" });
		for (let i = 0; i < filesEach; i++) {
			entries.push({ path: p(`${folder}/src/f-${i}.ts`), type: "file" });
		}
	}
	entries.push({ path: p("README.md"), type: "file" });
	entries.push({ path: p("package.json"), type: "file" });
	return {
		entries,
		totalFiles: entries.filter((e) => e.type === "file").length,
		totalDirectories: entries.filter((e) => e.type === "directory").length,
		truncated: false,
	};
}

function listedEntries(text: string): string[] {
	return [...text.matchAll(/^(?:📁|📄) (\S+)/gm)].map((m) => m[1]);
}

describe("code_tree depth limits the listing before it is paged", () => {
	it("lists a large repository's top level in one page, with counts", async () => {
		// 30 × 502 + 2 = 15,062 entries: about 75 pages without depth.
		h.listRepositoryStructure.mockResolvedValue(nestedTree(30, 500));

		const text = String(
			((await call("code_tree", { depth: 1 })) as { output: unknown })
				.output,
		);

		expect(text).toMatch(/Showing entries 1–32 of 32 \(end of listing\)/);
		expect(text).toContain(
			"(2 files, 30 dirs across 1 repo(s), 1 level deep)",
		);
		const listed = listedEntries(text);
		expect(listed).toHaveLength(32);
		expect(listed.every((path) => !path.includes("/"))).toBe(true);
		expect(text).toContain("📁 dir-00 (501 entries below)");
		expect(text).toContain("📄 README.md\n");
		expect(text).not.toContain("offset=");
	});

	it("counts levels from the directory, and depth 2 goes one level further", async () => {
		const tree = nestedTree(3, 4);
		// GitHub filters to the directory before the handler sees it.
		h.listRepositoryStructure.mockResolvedValue({
			...tree,
			entries: tree.entries.filter((e) => e.path.startsWith("dir-01/")),
		});

		const one = String(
			(
				(await call("code_tree", {
					directory: "dir-01",
					depth: 1,
				})) as {
					output: unknown;
				}
			).output,
		);
		expect(listedEntries(one)).toEqual(["dir-01/src"]);
		expect(one).toContain("📁 dir-01/src (4 entries below)");

		const two = String(
			(
				(await call("code_tree", {
					directory: "dir-01/",
					depth: "2",
				})) as {
					output: unknown;
				}
			).output,
		);
		expect(listedEntries(two)).toEqual([
			"dir-01/src",
			"dir-01/src/f-0.ts",
			"dir-01/src/f-1.ts",
			"dir-01/src/f-2.ts",
			"dir-01/src/f-3.ts",
		]);
		expect(two).not.toContain("entries below");
	});

	it("handles Azure DevOps paths: leading slashes and the folder's own entry", async () => {
		h.repos = [
			{
				provider: "AZURE_DEVOPS",
				owner: "example-org",
				repo: "app",
				branch: "main",
				azureOrganization: "example-project",
			},
		];
		h.listRepositoryStructure.mockResolvedValue(nestedTree(2, 3, true));
		const root = String(
			((await call("code_tree", { depth: 1 })) as { output: unknown })
				.output,
		);
		expect(h.listRepositoryStructure).toHaveBeenLastCalledWith(
			expect.objectContaining({
				provider: "AZURE_DEVOPS",
				azureProject: "example-project",
				directory: undefined,
			}),
		);
		expect(listedEntries(root)).toEqual([
			"/dir-00",
			"/dir-01",
			"/README.md",
			"/package.json",
		]);
		expect(root).toContain("📁 /dir-00 (4 entries below)");

		const tree = nestedTree(2, 3, true);
		// Azure DevOps fetches the subtree itself, scope folder included, and
		// matches the scope path without regard to case.
		h.listRepositoryStructure.mockResolvedValue({
			...tree,
			entries: tree.entries.filter(
				(e) => e.path === "/dir-01" || e.path.startsWith("/dir-01/"),
			),
		});
		const scoped = String(
			(
				(await call("code_tree", {
					directory: "/DIR-01/",
					depth: 1,
				})) as {
					output: unknown;
				}
			).output,
		);
		expect(h.listRepositoryStructure).toHaveBeenLastCalledWith(
			expect.objectContaining({ directory: "/DIR-01/" }),
		);
		expect(listedEntries(scoped)).toEqual(["/dir-01/src"]);
		expect(scoped).toContain("📁 /dir-01/src (3 entries below)");
	});

	it("says an offset past the end of the limited listing is past its end", async () => {
		h.listRepositoryStructure.mockResolvedValue(nestedTree(2, 3));
		const res = await call("code_tree", { depth: 1, offset: 10 });
		expect(String((res as { output: unknown }).output)).toContain(
			"Offset 10 is past the end of this listing (4 entries).",
		);
	});

	it("keeps the provider's truncation warning on a limited listing", async () => {
		h.listRepositoryStructure.mockResolvedValue({
			...nestedTree(2, 3),
			truncated: true,
		});
		const text = String(
			((await call("code_tree", { depth: 1 })) as { output: unknown })
				.output,
		);
		expect(text).toContain("listing and its counts are incomplete");
		expect(listedEntries(text)).toHaveLength(4);
	});

	it.each([
		["dir", 0, 'code_tree (directory="dir", depth=1) and its repo'],
		[
			`packages/${"long-directory-name-".repeat(4)}end`,
			1,
			`code_tree (directory="packages/${"long-directory-name-".repeat(4)}end", depth=1, offset=1) and its repo`,
		],
	])(
		"asks for a repository that did not fit with the same arguments (%s)",
		async (directory, offset, advice) => {
			// Twenty repositories leave each too small a share to hold even
			// a shortened path, so a repository whose paths are too long
			// for its share is left out. (With a share large enough, an
			// overlong path is shortened and listed instead:
			// code-search-handler-fixed-page-size.test.ts.)
			h.repos = [
				REPO,
				...Array.from({ length: 19 }, (_, i) => ({
					...REPO,
					repo: `api-${i}`,
				})),
			];
			// Folder names too long for a repository's share of the result.
			const long = (n: number) =>
				`${directory}/${String(n).repeat(6_000)}`;
			h.listRepositoryStructure.mockImplementation(
				async ({ repo }: { repo: string }) =>
					repo === "app"
						? {
								entries: [
									{ path: long(1), type: "directory" },
									{ path: `${long(1)}/a.ts`, type: "file" },
									{ path: long(2), type: "directory" },
								],
								totalFiles: 1,
								totalDirectories: 2,
								truncated: false,
							}
						: nestedTree(1, 2),
			);
			const text = String(
				(
					(await call("code_tree", {
						directory,
						depth: 1,
						offset,
					})) as {
						output: unknown;
					}
				).output,
			);
			expect(text).toContain(
				"Not listed, to keep this result within its size limit",
			);
			expect(text).toContain(
				`${advice}: repo="example-org/app" (2 entries)`,
			);
			expect(text).not.toMatch(/and \d+ more/);
		},
	);

	it.each([2_000, 10_000])(
		"stays within the result budget with a %i-character directory, skipped and failed repositories",
		async (length) => {
			const directory = "d".repeat(length);
			h.repos = Array.from({ length: 50 }, (_, i) => ({
				...REPO,
				repo: `repo-${String(i).padStart(2, "0")}`,
			}));
			h.listRepositoryStructure.mockImplementation(
				async ({ repo }: { repo: string }) => {
					const n = Number(repo.slice(5));
					if (n >= 30) {
						return {
							entries: [],
							totalFiles: 0,
							totalDirectories: 0,
							truncated: false,
							error: {
								kind: "forbidden",
								status: 403,
								message: `Listing example-org/${repo} was denied (HTTP 403).`,
							},
						};
					}
					const path = `${directory}/${n === 0 ? "a.ts" : "x".repeat(6_000)}`;
					return {
						entries: [{ path, type: "file" }],
						totalFiles: 1,
						totalDirectories: 0,
						truncated: false,
					};
				},
			);
			const text = String(
				(
					(await call("code_tree", {
						directory,
						depth: 1,
						offset: 0,
					})) as {
						output: unknown;
					}
				).output,
			);
			expect(text).toContain(
				"Not listed, to keep this result within its size limit",
			);
			expect(text).toContain("Could not list");
			expect(text.length).toBeLessThanOrEqual(
				TOOL_RESULTS.maxChars - 2_000,
			);
		},
	);

	it("pages the limited listing, and the continuation keeps the depth", async () => {
		const tree = nestedTree(0, 0);
		for (let i = 0; i < 600; i++) {
			const folder = `dir-${String(i).padStart(3, "0")}`;
			tree.entries.push({ path: folder, type: "directory" });
			tree.entries.push({ path: `${folder}/deep.ts`, type: "file" });
		}
		h.listRepositoryStructure.mockResolvedValue(tree);

		const seen: string[] = [];
		let offset = 0;
		for (let pages = 0; ; pages++) {
			expect(pages).toBeLessThan(20);
			const text = String(
				(
					(await call("code_tree", { depth: 1, offset })) as {
						output: unknown;
					}
				).output,
			);
			expect(text).toMatch(/of 602\b/);
			seen.push(...listedEntries(text));
			const next = text.match(/offset=(\d+), depth=1 /);
			if (!next) {
				expect(text).toContain("of 602 (end of listing)");
				break;
			}
			offset = Number(next[1]);
		}
		expect(seen).toHaveLength(602);
		expect(new Set(seen).size).toBe(602);
		expect(seen.some((path) => path.includes("/"))).toBe(false);
	});

	it("points a long listing without depth at depth=1", async () => {
		h.listRepositoryStructure.mockResolvedValue(nestedTree(30, 500));
		const text = String(
			((await call("code_tree", {})) as { output: unknown }).output,
		);
		// The page-size sentence sits between the count and the
		// continuation (code-search-handler-fixed-page-size.test.ts).
		expect(text).toContain(
			"of 15062. Every page of this listing but the last holds",
		);
		expect(text).toContain("The listing continues");
		expect(text).toContain(
			"For an overview, depth=1 lists only the top level.",
		);
	});

	it.each([0, -1, "abc", null])(
		"lists every level when depth is %s",
		async (depth) => {
			h.listRepositoryStructure.mockResolvedValue(nestedTree(1, 3));
			const text = String(
				((await call("code_tree", { depth })) as { output: unknown })
					.output,
			);
			expect(text).toMatch(/Showing entries 1–7 of 7 \(end of listing\)/);
			expect(text).not.toContain("level");
		},
	);
});
