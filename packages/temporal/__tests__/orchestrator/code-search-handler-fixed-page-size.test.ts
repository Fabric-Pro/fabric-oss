/**
 * `code_tree` pages a listing in pages of a fixed entry count, so a model
 * that reads page 1 (entries 1–N) and then requests offsets N, 2N, 3N … in
 * parallel gets every entry exactly once.
 *
 * Pages used to be filled greedily up to a character budget, so their
 * entry counts varied with path length: page 1 held 149 entries, page 2
 * 113, and a model extrapolating a stride of 149 silently skipped the
 * entries between each real page end and its guessed next offset.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	repos: [] as Array<Record<string, unknown>>,
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
	getRepositoryFile: vi.fn(),
	listRepositoryStructure: h.listRepositoryStructure,
}));

const { TOOL_RESULTS } = await import(
	"../../src/workflows/orchestrator/orchestrator-config"
);
const { runFabricCatalogTool } = await import(
	"../../src/activities/orchestrator/execution/fabric-catalog-adapter"
);

const BUDGET = TOOL_RESULTS.maxChars - 2_000;

const repo = (name: string) => ({
	provider: "GITHUB",
	owner: "example-org",
	repo: name,
	branch: "main",
});

/**
 * 1,800 files whose path lengths vary in clusters: short paths first, then
 * a run of long ones, then medium, then short again — the shape that made
 * greedy pages hold different entry counts.
 */
function clusteredTree(prefix = "") {
	const paths: string[] = [];
	const add = (count: number, make: (i: number) => string) => {
		for (let i = 0; i < count; i++) {
			paths.push(`${prefix}${make(paths.length)}`);
		}
	};
	const id = (i: number) => String(i).padStart(4, "0");
	add(500, (i) => `src/f-${id(i)}.ts`);
	add(
		400,
		(i) =>
			`packages/example-feature-area/src/components/deeply/nested/module/${id(i)}/index.tsx`,
	);
	add(450, (i) => `apps/web/modules/area/component-${id(i)}.tsx`);
	add(450, (i) => `lib/u-${id(i)}.ts`);
	return {
		paths,
		structure: {
			entries: paths.map((path) => ({ path, type: "file" as const })),
			totalFiles: paths.length,
			totalDirectories: 0,
			truncated: false,
		},
	};
}

async function tree(args: Record<string, unknown>): Promise<string> {
	const res = await runFabricCatalogTool({
		toolName: "code_tree",
		args,
		userId: "user-1",
		organizationId: "org-1",
		projectId: "project-1",
	});
	expect(res.success).toBe(true);
	const text = String((res as { output: unknown }).output);
	expect(text.length).toBeLessThanOrEqual(BUDGET);
	return text;
}

function listedPaths(text: string): string[] {
	return [...text.matchAll(/^📄 (\S+)/gm)].map((m) => m[1]);
}

/** The first and last entry numbers of a block's range line. */
function range(text: string): { from: number; to: number; total: number } {
	const m = text.match(/Showing entries (\d+)–(\d+) of (\d+)/);
	expect(m).not.toBeNull();
	return { from: Number(m?.[1]), to: Number(m?.[2]), total: Number(m?.[3]) };
}

/** One repository's block of a multi-repository listing. */
function block(text: string, name: string): string {
	const start = text.indexOf(`## example-org/${name}\n`);
	expect(start).toBeGreaterThanOrEqual(0);
	const end = text.indexOf("\n## ", start + 1);
	return text.slice(start, end === -1 ? undefined : end);
}

beforeEach(() => {
	vi.clearAllMocks();
	h.repos = [repo("app")];
});

describe("code_tree pages hold a fixed number of entries", () => {
	it("reading page 1 and then every multiple of its size returns the whole listing once", async () => {
		const { paths, structure } = clusteredTree();
		h.listRepositoryStructure.mockResolvedValue(structure);

		const first = await tree({});
		const { from, to, total } = range(first);
		expect(from).toBe(1);
		expect(total).toBe(paths.length);
		const size = to;
		expect(size).toBeLessThan(total);

		// What a model does: extrapolate the stride and request every later
		// page without reading the one before it. The requests are
		// independent, so issuing them one at a time here changes nothing.
		const pages = [first];
		for (let offset = size; offset < total; offset += size) {
			pages.push(await tree({ offset }));
		}

		const seen = pages.flatMap(listedPaths);
		const missing = paths.filter((p) => !seen.includes(p));
		expect(missing).toEqual([]);
		expect(new Set(seen).size).toBe(seen.length);
		expect(seen).toEqual(paths);
		pages.slice(0, -1).forEach((page, k) => {
			expect(listedPaths(page)).toHaveLength(size);
			expect(range(page).from).toBe(k * size + 1);
		});
		expect(pages.at(-1)).toContain("(end of listing)");
	});

	it("states the page size and that later pages can be requested together", async () => {
		h.listRepositoryStructure.mockResolvedValue(clusteredTree().structure);
		const text = await tree({});
		const { to: size } = range(text);
		expect(text).toContain(
			`Every page of this listing but the last holds ${size} entries, so pages start at offsets 0, ${size}, ${2 * size}, … (they can be requested together).`,
		);
		expect(text).toContain(`call code_tree again with offset=${size}`);
	});

	it("the page size does not depend on the offset", async () => {
		h.listRepositoryStructure.mockResolvedValue(clusteredTree().structure);
		const sizeAt = async (offset: number) => {
			const text = await tree({ offset });
			const m = text.match(/holds (\d+) entries/);
			expect(m).not.toBeNull();
			const { from, to } = range(text);
			expect(from).toBe(offset + 1);
			expect(to - from + 1).toBe(Number(m?.[1]));
			return Number(m?.[1]);
		};
		const size = await sizeAt(0);
		// Inside the run of long paths, at an aligned offset, and at an
		// arbitrary four-digit offset that is no multiple of the size.
		expect(await sizeAt(size)).toBe(size);
		expect(await sizeAt(5 * size)).toBe(size);
		expect(1234 % size).not.toBe(0);
		expect(await sizeAt(1234)).toBe(size);
	});

	it("an offset past the end is still reported as past the end", async () => {
		h.listRepositoryStructure.mockResolvedValue(clusteredTree().structure);
		const text = await tree({ offset: 5_000 });
		expect(text).toContain(
			"Offset 5000 is past the end of this listing (1800 entries).",
		);
	});
});

describe("code_tree across several repositories", () => {
	beforeEach(() => {
		h.repos = [repo("app"), repo("api")];
		h.listRepositoryStructure.mockImplementation(
			async ({ repo: name }: { repo: string }) =>
				clusteredTree(`${name}/`).structure,
		);
	});

	it("keeps each repository's page size across offsets, and a repo-filtered page is no smaller", async () => {
		const sizes = async (offset: number) => {
			const text = await tree({ offset });
			return ["app", "api"].map((name) => {
				const { from, to } = range(block(text, name));
				expect(from).toBe(offset + 1);
				return to - from + 1;
			});
		};
		const [app, api] = await sizes(0);
		expect(app).toBeGreaterThan(0);
		expect(await sizes(app)).toEqual([app, api]);
		expect(await sizes(5 * app)).toEqual([app, api]);
		expect(await sizes(1234)).toEqual([app, api]);

		// The multi-repository page promises no stride: its repo-filtered
		// follow-up has a larger page.
		const multi = await tree({});
		expect(multi).not.toContain(
			"Every page of this listing but the last holds",
		);
		expect(multi).toContain(`offset=${app}, repo="example-org/app"`);

		const single = await tree({ repo: "example-org/app" });
		const m = single.match(/holds (\d+) entries/);
		expect(m).not.toBeNull();
		expect(Number(m?.[1])).toBeGreaterThanOrEqual(app);
		const { to } = range(single);
		expect(to).toBe(Number(m?.[1]));
		expect(Number(m?.[1])).toBeGreaterThan(app);
	});
});

/**
 * A rendered entry longer than a repository's whole entry budget used to
 * shrink that listing's page to one entry, and the page holding it rendered
 * nothing, so the repository was reported as "not listed" at that offset
 * and a repo-filtered request could never get past it. Such an entry is now
 * shortened in the middle of its path (Fizzy #2942).
 */
describe("code_tree shortens a path too long for a page", () => {
	const OUTLIER_AT = 1_000;
	const oversized = (length: number, prefix = "") =>
		`${prefix}pkg/${"x".repeat(length)}/target-file.ts`;
	/** `clusteredTree` with one oversized path at entry `OUTLIER_AT`. */
	function withOutlier(length: number, prefix = "") {
		const { paths, structure } = clusteredTree(prefix);
		const outlier = oversized(length, prefix);
		const all = [...paths];
		all.splice(OUTLIER_AT, 0, outlier);
		return {
			paths: all,
			outlier,
			structure: {
				...structure,
				entries: all.map((path) => ({ path, type: "file" as const })),
				totalFiles: all.length,
			},
		};
	}
	const entryLines = (text: string) =>
		text.split("\n").filter((line) => /^(?:📁|📄) /.test(line));

	it("keeps the page size, and every entry reachable by multiples of it", async () => {
		h.listRepositoryStructure.mockResolvedValue(clusteredTree().structure);
		const baseline = range(await tree({})).to;

		const { paths, outlier, structure } = withOutlier(12_000);
		h.listRepositoryStructure.mockResolvedValue(structure);
		const first = await tree({});
		const size = range(first).to;
		// One shortened line of at most 500 characters barely moves it.
		expect(size).toBe(baseline);

		const pages = [first];
		for (let offset = size; offset < paths.length; offset += size) {
			pages.push(await tree({ offset }));
		}
		pages.slice(0, -1).forEach((page) => {
			expect(listedPaths(page)).toHaveLength(size);
		});
		const seen = pages.flatMap(listedPaths);
		expect(seen).toHaveLength(paths.length);
		const shortened = seen[OUTLIER_AT];
		expect(shortened.startsWith("pkg/xxxx")).toBe(true);
		expect(shortened.endsWith("/target-file.ts")).toBe(true);
		expect(shortened).toContain("…");
		expect(shortened.length).toBeLessThan(outlier.length);
		expect(seen.filter((_, i) => i !== OUTLIER_AT)).toEqual(
			paths.filter((_, i) => i !== OUTLIER_AT),
		);
		const page = pages[Math.floor(OUTLIER_AT / size)];
		expect(page).toContain(
			`[path shortened from ${outlier.length} characters]`,
		);
		// Every entry line, the shortened one included, stays within the
		// 500-character line cap.
		for (const text of pages) {
			for (const line of entryLines(text)) {
				expect(line.length).toBeLessThanOrEqual(500);
			}
		}
	});

	it("a repo-filtered request at the oversized entry makes progress", async () => {
		h.repos = [repo("app"), repo("api")];
		h.listRepositoryStructure.mockResolvedValue(
			withOutlier(12_000).structure,
		);
		const text = await tree({
			repo: "example-org/app",
			offset: OUTLIER_AT,
		});
		expect(text).not.toContain("Not listed");
		const { from, to } = range(text);
		expect(from).toBe(OUTLIER_AT + 1);
		expect(to).toBeGreaterThan(OUTLIER_AT + 1);
		expect(listedPaths(text)[0]).toMatch(/^pkg\/x+….*\/target-file\.ts$/);
	});

	it("keeps per-repository page sizes across offsets, and a repo-filtered page no smaller", async () => {
		const names = ["app", "api", "web", "jobs", "docs"];
		h.repos = names.map(repo);
		// About 2,000 characters: longer than a repository's share of a
		// five-repository result, but not than a repo-filtered page.
		h.listRepositoryStructure.mockImplementation(
			async ({ repo: name }: { repo: string }) =>
				name === "app"
					? withOutlier(2_000, "app/").structure
					: clusteredTree(`${name}/`).structure,
		);
		const sizes = async (offset: number) => {
			const text = await tree({ offset });
			expect(text).not.toContain("Not listed");
			return names.map((name) => {
				const { from, to } = range(block(text, name));
				expect(from).toBe(offset + 1);
				return to - from + 1;
			});
		};
		const first = await sizes(0);
		const app = first[0];
		expect(app).toBeGreaterThan(1);
		for (const offset of [
			app,
			5 * app,
			1234,
			OUTLIER_AT,
			Math.floor(OUTLIER_AT / app) * app,
		]) {
			expect(await sizes(offset)).toEqual(first);
		}
		const outlierPage = await tree({ offset: OUTLIER_AT });
		expect(listedPaths(block(outlierPage, "app"))[0]).toMatch(
			/^app\/pkg\/x+….*\/target-file\.ts$/,
		);

		for (const [index, name] of names.entries()) {
			const single = await tree({ repo: `example-org/${name}` });
			const m = single.match(/holds (\d+) entries/);
			expect(m).not.toBeNull();
			expect(Number(m?.[1])).toBeGreaterThanOrEqual(first[index]);
		}
	});
});

describe("code_tree bounds the arguments it echoes", () => {
	it("an overlong directory with no entries", async () => {
		h.listRepositoryStructure.mockResolvedValue({
			entries: [],
			totalFiles: 0,
			totalDirectories: 0,
			truncated: false,
		});
		const text = await tree({ directory: "d".repeat(20_000) });
		expect(text).toContain("No files found under the requested directory");
	});

	it("an overlong directory in the continuation", async () => {
		const directory = `src/${"d".repeat(400)}`;
		const { structure } = clusteredTree(`${directory}/`);
		h.listRepositoryStructure.mockResolvedValue(structure);
		const text = await tree({ directory });
		expect(text).toContain("and the same directory as this request");
		expect(text).not.toContain(`directory="${directory}"`);
		const size = range(text).to;
		expect(text).toContain(`offset=${size}`);
	});

	it.each([
		["an overlong unknown repository", 1, "r".repeat(20_000)],
		["an unknown repository among 400 connected", 400, "missing"],
	])("%s", async (_, count, requested) => {
		h.repos = Array.from({ length: count }, (_, i) =>
			repo(`connected-repository-with-a-long-name-${i}`),
		);
		h.listRepositoryStructure.mockResolvedValue(clusteredTree().structure);
		// The check is shared by every repo-filtered tool and runs before
		// the tool itself; code_search needs more mocks through the catalog
		// adapter than this file sets up, so these two stand for it.
		for (const toolName of ["code_tree", "code_file_get"]) {
			const res = await runFabricCatalogTool({
				toolName,
				args: { repo: requested, path: "a.ts" },
				userId: "user-1",
				organizationId: "org-1",
				projectId: "project-1",
			});
			expect(res.success).toBe(false);
			const error = (res as { error: string }).error;
			expect(error).toContain("is not connected to this project");
			expect(error.length).toBeLessThanOrEqual(BUDGET);
		}
	});
});

describe("code_tree shortens a long line the same way in every view", () => {
	/**
	 * 180 files: eight 12,000-character paths, then a one-character path,
	 * twenty times. When the line cap followed the budget, the larger
	 * repo-filtered budget lengthened the shortened lines and its page held
	 * fewer entries (8) than the multi-repository page (9), so stepping the
	 * multi-repository size with repo-filtered requests skipped entries.
	 */
	function periodicTree(name: string) {
		const paths: string[] = [];
		for (let r = 0; r < 20; r++) {
			for (let i = 0; i < 8; i++) {
				const file = `/${name}-${r}-${i}.ts`;
				paths.push(`${"p".repeat(12_000 - file.length)}${file}`);
			}
			paths.push(String.fromCharCode(97 + r));
		}
		return {
			entries: paths.map((path) => ({ path, type: "file" as const })),
			totalFiles: paths.length,
			totalDirectories: 0,
			truncated: false,
		};
	}

	it("a repo-filtered page is never smaller than the multi-repository page", async () => {
		h.repos = [repo("aaa"), repo("bbb")];
		h.listRepositoryStructure.mockImplementation(
			async ({ repo: name }: { repo: string }) => periodicTree(name),
		);
		const multi = await tree({});
		for (const name of ["aaa", "bbb"]) {
			const { to: multiSize } = range(block(multi, name));
			const single = await tree({ repo: `example-org/${name}` });
			const size = Number(single.match(/holds (\d+) entries/)?.[1]);
			expect(size).toBeGreaterThanOrEqual(multiSize);

			// Step the multi-repository size with repo-filtered requests.
			const seen: string[] = [];
			for (let offset = 0; offset < 180; offset += multiSize) {
				const page = await tree({
					repo: `example-org/${name}`,
					offset,
				});
				const { from, to } = range(page);
				expect(from).toBe(offset + 1);
				expect(to).toBeGreaterThanOrEqual(
					Math.min(180, offset + multiSize),
				);
				seen.push(...listedPaths(page).slice(0, multiSize));
			}
			expect(seen).toHaveLength(180);
			for (let r = 0; r < 20; r++) {
				expect(seen[r * 9 + 8]).toBe(String.fromCharCode(97 + r));
				for (let i = 0; i < 8; i++) {
					expect(
						seen[r * 9 + i].endsWith(`/${name}-${r}-${i}.ts`),
					).toBe(true);
				}
			}
		}
	});

	it("twenty repositories, one with an oversized path: within budget, and the repo-filtered view lists it", async () => {
		const names = Array.from({ length: 20 }, (_, i) => `r${i}`);
		h.repos = names.map(repo);
		const { paths, structure } = clusteredTree("r0/");
		const outlier = `r0/pkg/${"x".repeat(12_000)}/target-file.ts`;
		const withOutlier = {
			...structure,
			entries: [
				...structure.entries.slice(0, 1000),
				{ path: outlier, type: "file" as const },
				...structure.entries.slice(1000),
			],
			totalFiles: paths.length + 1,
		};
		h.listRepositoryStructure.mockImplementation(
			async ({ repo: name }: { repo: string }) =>
				name === "r0"
					? withOutlier
					: clusteredTree(`${name}/`).structure,
		);
		for (const offset of [0, 990, 1000]) {
			await tree({ offset });
		}

		h.listRepositoryStructure.mockResolvedValue(structure);
		const baseline = Number(
			(await tree({ repo: "example-org/r0" })).match(
				/holds (\d+) entries/,
			)?.[1],
		);
		h.listRepositoryStructure.mockResolvedValue(withOutlier);
		const single = await tree({ repo: "example-org/r0", offset: 1000 });
		expect(single).not.toContain("Not listed");
		expect(Number(single.match(/holds (\d+) entries/)?.[1])).toBe(baseline);
		expect(listedPaths(single)[0]).toMatch(
			/^r0\/pkg\/x+….*\/target-file\.ts$/,
		);
		expect(single).toContain(
			`[path shortened from ${outlier.length} characters]`,
		);
	});
});
