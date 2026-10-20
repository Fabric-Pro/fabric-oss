import { createHash } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FabricClient } from "@fabricorg/sdk";
import { FabricError } from "@fabricorg/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitBlobOid } from "../src/lib/git-blob.js";
import { mergedAgentsOverride } from "../src/lib/plugin/layout.js";
import { renderPlugin } from "../src/lib/plugin/render.js";
import { agentsInstructions } from "../src/lib/plugin/rules.js";

const PROJECT = "cmexampleproject0123456789";
const ORIGIN = "https://example.com";
const encode = (text: string) => new TextEncoder().encode(text);

interface RepoFile {
	path: string;
	text: string;
	state?: "found" | "binary";
}

const sha256 = (text: string) =>
	createHash("sha256").update(text).digest("hex");

function fakeClient(options: {
	repo?: { commit: string; files: RepoFile[]; incomplete?: boolean };
	upload?: { digest: string; files: Array<{ path: string; text: string }> };
	targets?: Array<{
		id: string;
		folder: string;
		mode: "PULL_REQUEST" | "DIRECT_PUSH";
	}>;
	targetsFail?: boolean;
	available?: boolean;
}) {
	const calls = { readFile: 0, listFiles: 0, downloadUrls: 0 };
	const repo = options.repo;
	const upload = options.upload;
	const client = {
		instructions: {
			getPublished: vi.fn(async () =>
				repo
					? {
							published: true,
							sourceOfTruth: "REPOSITORY",
							direct:
								options.available === false
									? {
											availability: "UNAVAILABLE",
											readState: "DIRECT",
										}
									: {
											availability: "READY",
											readState: "DIRECT",
											generation: 3,
											currentCommitSha: repo.commit,
										},
						}
					: upload
						? {
								published: true,
								sourceOfTruth: "UPLOAD",
								snapshot: { digest: upload.digest },
								manifest: upload.files.map((file) => ({
									path: file.path,
									sha256: sha256(file.text),
									size: encode(file.text).length,
									mode: null,
									kind: "OTHER",
								})),
							}
						: { published: false, sourceOfTruth: "UPLOAD" },
			),
			listRepositoryFiles: vi.fn(async () => {
				calls.listFiles++;
				return {
					generation: 3,
					commitSha: repo?.commit,
					incomplete: repo?.incomplete ?? false,
					refusal: null,
					files: (repo?.files ?? []).map((file) => ({
						path: file.path,
						kind: "OTHER",
						blobId: gitBlobOid(encode(file.text)),
						size: encode(file.text).length,
					})),
				};
			}),
			readRepositoryFiles: vi.fn(
				async (_project: string, input: { paths: string[] }) => ({
					generation: 3,
					commitSha: repo?.commit,
					nextIndex: null,
					files: input.paths.map((filePath) => {
						calls.readFile++;
						const found = repo?.files.find(
							(file) => file.path === filePath,
						);
						return {
							path: filePath,
							read:
								found === undefined || found.state === "binary"
									? { state: "binary", size: 0 }
									: {
											state: "found",
											text: found.text,
											size: encode(found.text).length,
											textLength: Array.from(found.text)
												.length,
										},
						};
					}),
				}),
			),
			createFileDownloadUrls: vi.fn(
				async (
					_project: string,
					input: { digest: string; paths: string[] },
				) => {
					calls.downloadUrls++;
					return {
						snapshotId: "snap",
						digest: input.digest,
						expiresInSeconds: 60,
						files: input.paths.map((p) => ({
							path: p,
							sha256: "",
							size: 0,
							mode: null,
							url: `https://files.example.com/${encodeURIComponent(p)}`,
						})),
					};
				},
			),
		},
		memory: {
			getTargets: vi.fn(async () => {
				if (options.targetsFail) {
					throw new FabricError(
						"Missing required scope: memory:write",
						403,
						"MISSING_SCOPE",
					);
				}
				return {
					sync: {
						ref: "main",
						lastAppliedCommitSha: null,
						ingesting: true,
						repository: {
							provider: "GITHUB",
							owner: "o",
							name: "r",
						},
					},
					targets: (options.targets ?? []).map((target) => ({
						...target,
						version: 1,
					})),
				};
			}),
		},
	};
	const fetchImpl: typeof fetch = async (url) => {
		const requested = decodeURIComponent(
			String(url).split("/").pop() ?? "",
		);
		const found = upload?.files.find((file) => file.path === requested);
		return new Response(found === undefined ? "missing" : found.text, {
			status: found === undefined ? 404 : 200,
		});
	};
	return {
		client: client as unknown as Pick<
			FabricClient,
			"instructions" | "memory"
		>,
		calls,
		fetchImpl,
	};
}

let cache: string;
let codex: string;

beforeEach(async () => {
	cache = await mkdtemp(path.join(tmpdir(), "fabric-render-"));
	codex = path.join(cache, "codex-plugins");
});

afterEach(async () => {
	await rm(cache, { recursive: true, force: true });
});

function render(
	setup: ReturnType<typeof fakeClient>,
	overrides: Partial<Parameters<typeof renderPlugin>[0]> = {},
) {
	return renderPlugin({
		client: setup.client,
		projectId: PROJECT,
		origin: ORIGIN,
		tool: "claude-code",
		cacheDirectory: cache,
		codexPluginsDirectory: codex,
		timeoutMs: 5_000,
		fetchImpl: setup.fetchImpl,
		...overrides,
	});
}

async function tree(directory: string): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	const walk = async (relative: string) => {
		for (const entry of await readdir(path.join(directory, relative), {
			withFileTypes: true,
		})) {
			const next =
				relative === "" ? entry.name : `${relative}/${entry.name}`;
			if (entry.isDirectory()) {
				await walk(next);
			} else {
				out[next] = await readFile(path.join(directory, next), "utf8");
			}
		}
	};
	await walk("");
	return out;
}

const REPO = {
	commit: "a".repeat(40),
	files: [
		{ path: "CLAUDE.md", text: "# Rules\n" },
		{
			path: ".claude/skills/deploy/SKILL.md",
			text: "---\nname: deploy\n---\n",
		},
		{ path: "docs/unrelated.md", text: "not carried" },
	] as RepoFile[],
};

describe("rendering a repository project", () => {
	it("keeps the existing plugin and Living Memory files when a batch fails blob verification", async () => {
		const first = await render(fakeClient({ repo: REPO }));
		const before = await tree(first.directory);
		const commit = "b".repeat(40);
		const next = fakeClient({
			repo: {
				commit,
				files: REPO.files.map((file) => ({
					...file,
					text: `${file.text}changed\n`,
				})),
			},
		});
		vi.spyOn(
			next.client.instructions,
			"readRepositoryFiles",
		).mockImplementation(async (_project, input) => ({
			generation: 3,
			commitSha: commit,
			nextIndex: null,
			files: input.paths.map((path) => ({
				path,
				read: { state: "found", text: "wrong", size: 5, textLength: 5 },
			})),
		}));
		await expect(render(next)).rejects.toThrow("different bytes");
		expect(await tree(first.directory)).toEqual(before);
		expect(before["skills/fabric-living-memory/SKILL.md"]).toBeDefined();
	});

	it("writes the plugin under <cache>/plugins/<project>/<pin> and reads only what a plugin carries", async () => {
		const setup = fakeClient({
			repo: REPO,
			targets: [{ id: "t1", folder: "docs/ai", mode: "PULL_REQUEST" }],
		});

		const rendered = await render(setup);

		expect(rendered.directory).toBe(
			path.join(cache, "plugins", PROJECT, rendered.pin),
		);
		expect(rendered.pin).toMatch(/^[0-9a-f]{12}$/);
		const files = await tree(rendered.directory);
		expect(Object.keys(files).sort()).toEqual([
			".claude-plugin/plugin.json",
			".mcp.json",
			"hooks/hooks.json",
			"hooks/session-context.json",
			"instructions/CLAUDE.md",
			"skills/deploy/SKILL.md",
			"skills/fabric-instruction-access/SKILL.md",
			"skills/fabric-instruction-access/catalog.json",
			"skills/fabric-living-memory/SKILL.md",
		]);
		expect(files["skills/fabric-living-memory/SKILL.md"]).toContain(
			"`docs/ai/`",
		);
		// The unrelated file was never read.
		expect(setup.calls.readFile).toBe(2);
		expect(rendered.alwaysOn?.file).toBe("CLAUDE.md");
	});

	describe("project rules", () => {
		const WITH_RULES = {
			commit: "d".repeat(40),
			files: [
				...REPO.files,
				{
					path: "rules/style.md",
					text: "---\npaths:\n  - src/**\n---\nTabs.\n",
				},
				{ path: ".claude/rules/team/naming.md", text: "Names." },
			] as RepoFile[],
		};

		it("hands the rules back for automatic delivery and preserves passive copies at original paths", async () => {
			const rendered = await render(fakeClient({ repo: WITH_RULES }));

			expect(
				rendered.rules.map((rule) => [rule.path, rule.source]),
			).toEqual([
				["style.md", "rules/style.md"],
				["team/naming.md", ".claude/rules/team/naming.md"],
			]);
			const files = await tree(rendered.directory);
			expect(files["instructions/source/rules/style.md"]).toBe(
				WITH_RULES.files.find((file) => file.path === "rules/style.md")
					?.text,
			);
			expect(
				files["instructions/source/.claude/rules/team/naming.md"],
			).toBe("Names.");
		});

		it("does not count the rules among the files the plugin leaves out", async () => {
			const logs: string[] = [];

			await render(fakeClient({ repo: WITH_RULES }), {
				log: (line) => logs.push(line),
			});

			expect(logs.join("\n")).toContain("1 instruction file is not part");
			expect(logs.join("\n")).not.toContain("rules/");
		});

		it("keeps native component bytes unchanged when rules change", async () => {
			const without = await render(fakeClient({ repo: REPO }));
			const withRules = await render(
				fakeClient({
					repo: WITH_RULES,
				}),
			);

			const digest = (rendered: typeof without) =>
				rendered.files
					.filter(
						(file) =>
							!file.path.startsWith("instructions/source/") &&
							file.path !==
								"skills/fabric-instruction-access/catalog.json",
					)
					.map((file) => [
						file.path,
						createHash("sha256").update(file.bytes).digest("hex"),
					]);

			expect(digest(withRules)).toEqual(digest(without));
			expect(withRules.pin).not.toBe(without.pin);
		});

		it("for Codex, the rules reach the override text, after the memory file, scoped rules noted", async () => {
			const rendered = await render(fakeClient({ repo: WITH_RULES }), {
				tool: "codex",
			});
			const text = agentsInstructions(
				rendered.alwaysOn?.text ?? null,
				rendered.rules,
			);

			expect(text).toContain("# Rules");
			expect(text).toContain("### Rule: style.md");
			expect(text).toContain("Applies when working on: src/**");
			expect(text?.indexOf("# Rules")).toBeLessThan(
				text?.indexOf("### Rule: style.md") ?? -1,
			);
		});
	});

	it("is the same directory, untouched, when nothing changed, and reads nothing from the network", async () => {
		const setup = fakeClient({ repo: REPO });
		const first = await render(setup);
		const readBefore = setup.calls.readFile;
		const marker = path.join(first.directory, "marker");
		await writeFile(marker, "kept");

		const second = await render(setup);

		expect(second.directory).toBe(first.directory);
		expect(second.reused).toBe(true);
		expect(await readFile(marker, "utf8")).toBe("kept");
		expect(setup.calls.readFile).toBe(readBefore);
	});

	it("reads an unchanged file from the cache when only another file changed", async () => {
		await render(fakeClient({ repo: REPO }));
		const next = fakeClient({
			repo: {
				commit: "b".repeat(40),
				files: [
					{ path: "CLAUDE.md", text: "# Rules, edited\n" },
					REPO.files[1] as RepoFile,
				],
			},
		});

		const rendered = await render(next);

		expect(next.calls.readFile).toBe(1);
		expect((await tree(rendered.directory))["instructions/CLAUDE.md"]).toBe(
			"# Rules, edited\n",
		);
	});

	it("builds the same bytes into a different cache, and a new pin when the memory folders change", async () => {
		const withFolder = (folder: string) =>
			fakeClient({
				repo: REPO,
				targets: [{ id: "t1", folder, mode: "PULL_REQUEST" }],
			});
		const a = await render(withFolder("docs/ai"));
		const otherCache = await mkdtemp(
			path.join(tmpdir(), "fabric-render-b-"),
		);
		try {
			const b = await render(withFolder("docs/ai"), {
				cacheDirectory: otherCache,
			});
			const c = await render(withFolder("docs/notes"));

			expect(b.pin).toBe(a.pin);
			expect(await tree(b.directory)).toEqual(await tree(a.directory));
			expect(c.pin).not.toBe(a.pin);
		} finally {
			await rm(otherCache, { recursive: true, force: true });
		}
	});

	it("still renders when the memory folders cannot be read, and the skill says so", async () => {
		const logs: string[] = [];

		const rendered = await render(
			fakeClient({ repo: REPO, targetsFail: true }),
			{
				log: (line) => logs.push(line),
			},
		);

		expect(
			(await tree(rendered.directory))[
				"skills/fabric-living-memory/SKILL.md"
			],
		).toContain("fabric_memory_targets");
		expect(logs.join("\n")).toContain("memory folders could not be read");
	});

	it("says how many instruction files the plugin leaves out, names the first few and points at the tab", async () => {
		const logs: string[] = [];
		const extra = ["a", "b", "c", "d", "e"].map((name) => ({
			path: `docs/${name}.md`,
			text: name,
		}));

		await render(
			fakeClient({
				repo: { ...REPO, files: [...REPO.files, ...extra] },
			}),
			{ log: (line) => logs.push(line) },
		);

		const line = logs.find((entry) =>
			entry.includes("not part of the plugin"),
		);
		expect(line).toContain("6 instruction files");
		expect(line).toContain("docs/a.md, docs/b.md, docs/c.md");
		expect(line).not.toContain("docs/d.md");
		expect(line).toContain("and 3 more");
		expect(line).toContain("Coding Instructions tab");
	});

	it("says the same for an uploaded project, and nothing when every file has a place", async () => {
		const uploaded: string[] = [];
		const clean: string[] = [];

		await render(
			fakeClient({
				upload: {
					digest: "d".repeat(64),
					files: [
						{ path: "CLAUDE.md", text: "# Rules\n" },
						{ path: "notes/todo.md", text: "x" },
					],
				},
			}),
			{ log: (line) => uploaded.push(line) },
		);
		await render(
			fakeClient({
				upload: {
					digest: "e".repeat(64),
					files: [
						{ path: "CLAUDE.md", text: "# Rules\n" },
						{ path: "skills/deploy/SKILL.md", text: "---\n---\n" },
						{ path: "rules/style.md", text: "rule" },
					],
				},
			}),
			{ log: (line) => clean.push(line) },
		);

		expect(uploaded.join("\n")).toContain("1 instruction file is not part");
		expect(uploaded.join("\n")).toContain("notes/todo.md");
		expect(clean.join("\n")).not.toContain("not part of the plugin");
	});

	it("leaves out a file that is not text and says so", async () => {
		const logs: string[] = [];
		const setup = fakeClient({
			repo: {
				commit: "c".repeat(40),
				files: [
					...REPO.files,
					{
						path: ".claude/skills/deploy/logo.png",
						text: "png",
						state: "binary",
					},
				],
			},
		});

		const rendered = await render(setup, {
			log: (line) => logs.push(line),
		});

		expect(await tree(rendered.directory)).not.toHaveProperty(
			"skills/deploy/logo.png",
		);
		expect(logs.join("\n")).toContain(
			".claude/skills/deploy/logo.png is unavailable as inline text",
		);
	});

	it("refuses to render from a partial file list rather than drop a skill silently", async () => {
		await expect(
			render(fakeClient({ repo: { ...REPO, incomplete: true } })),
		).rejects.toThrow(/incomplete/);
		await expect(readdir(path.join(cache, "plugins"))).rejects.toThrow();
	});

	it("fails when the repository is not available, leaving what was there", async () => {
		const first = await render(fakeClient({ repo: REPO }));

		await expect(
			render(fakeClient({ repo: REPO, available: false })),
		).rejects.toThrow(/not available/);
		expect((await stat(first.directory)).isDirectory()).toBe(true);
	});

	it("ignores a damaged cache file", async () => {
		await render(fakeClient({ repo: REPO }));
		const blob = path.join(
			cache,
			"blobs",
			`git-${gitBlobOid(encode("# Rules\n"))}`,
		);
		await writeFile(blob, "planted");
		const next = fakeClient({ repo: { ...REPO, commit: "d".repeat(40) } });

		const rendered = await render(next);

		expect((await tree(rendered.directory))["instructions/CLAUDE.md"]).toBe(
			"# Rules\n",
		);
	});

	it("leaves no temporary directory behind and keeps only the newest pins", async () => {
		let last = "";
		for (let i = 0; i < 6; i++) {
			const rendered = await render(
				fakeClient({
					repo: {
						...REPO,
						commit: i.toString(16).repeat(40).slice(0, 40),
					},
				}),
			);
			const when = new Date(Date.now() + i * 10_000);
			await utimes(rendered.directory, when, when);
			last = rendered.directory;
		}

		const names = await readdir(path.join(cache, "plugins", PROJECT));

		expect(names.filter((name) => name.includes(".tmp-"))).toEqual([]);
		expect(names.length).toBeLessThanOrEqual(3);
		expect(names).toContain(path.basename(last));
	});
});

describe("rendering an uploaded project", () => {
	const UPLOAD = {
		digest: "digest-one",
		files: [
			{ path: "CLAUDE.md", text: "# Uploaded rules\n" },
			{ path: ".claude/agents/reviewer.md", text: "reviewer" },
			{ path: "notes.md", text: "not carried" },
		],
	};

	it("downloads only what a plugin carries and caches it by hash", async () => {
		const setup = fakeClient({ upload: UPLOAD });

		const rendered = await render(setup);
		const again = await render(setup, { tool: "claude-code" });

		expect(Object.keys(await tree(rendered.directory))).toContain(
			"agents/reviewer.md",
		);
		expect(setup.calls.downloadUrls).toBe(1);
		expect(again.reused).toBe(true);
		const catalog = JSON.parse(
			(await tree(rendered.directory))[
				"skills/fabric-instruction-access/catalog.json"
			] ?? "",
		);
		expect(catalog.source).toEqual({
			kind: "upload",
			digest: UPLOAD.digest,
		});
		expect(catalog.entries).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					path: "notes.md",
					sha256: sha256("not carried"),
					localPath: null,
				}),
			]),
		);
	});

	it("refuses bytes that are not the manifest's", async () => {
		const setup = fakeClient({ upload: UPLOAD });
		const lying: typeof fetch = async () =>
			new Response("tampered", { status: 200 });

		await expect(render(setup, { fetchImpl: lying })).rejects.toThrow(
			/does not match the manifest|Nothing was written/,
		);
	});

	it("provides discovery and memory guidance when nothing is published", async () => {
		const rendered = await render(fakeClient({}));

		expect(Object.keys(await tree(rendered.directory)).sort()).toEqual([
			".claude-plugin/plugin.json",
			".mcp.json",
			"hooks/hooks.json",
			"hooks/session-context.json",
			"skills/fabric-instruction-access/SKILL.md",
			"skills/fabric-instruction-access/catalog.json",
			"skills/fabric-living-memory/SKILL.md",
		]);
		expect(rendered.alwaysOn?.text).toContain("fabric-instruction-access");
		const files = await tree(rendered.directory);
		const catalog = JSON.parse(
			files["skills/fabric-instruction-access/catalog.json"] ?? "",
		);
		expect(catalog.source).toEqual({ kind: "upload", digest: null });
	});
});

describe("rendering for Codex", () => {
	it("puts discovery into the managed override when the instruction tree has no root file", async () => {
		const rendered = await render(
			fakeClient({
				repo: {
					commit: "f".repeat(40),
					files: [
						{
							path: "engineers/guide.md",
							text: "Read me on demand.",
						},
					],
				},
			}),
			{ tool: "codex" },
		);
		const instructions = agentsInstructions(
			rendered.alwaysOn?.text ?? null,
			rendered.rules,
		);
		expect(instructions).toContain("fabric-instruction-access");
		expect(instructions).toContain("plugin fabric-23456789");
		expect(
			mergedAgentsOverride(
				"Tracked project guidance.",
				instructions ?? "",
			),
		).toContain("fabric-instruction-access");
	});

	it("replaces one fixed folder, and leaves it alone when the pin is unchanged", async () => {
		const first = await render(fakeClient({ repo: REPO }), {
			tool: "codex",
		});
		await writeFile(path.join(first.directory, "stale-marker"), "x");
		const unchanged = await render(fakeClient({ repo: REPO }), {
			tool: "codex",
		});
		const next = await render(
			fakeClient({ repo: { ...REPO, commit: "e".repeat(40) } }),
			{ tool: "codex" },
		);

		expect(first.directory).toBe(path.join(codex, "fabric-23456789"));
		expect(unchanged.reused).toBe(true);
		expect(next.directory).toBe(first.directory);
		expect(next.reused).toBe(false);
		const files = await tree(next.directory);
		expect(files).not.toHaveProperty("stale-marker");
		expect(Object.keys(files)).toEqual(
			expect.arrayContaining([
				".codex-plugin/plugin.json",
				".mcp.json",
				".fabric-render",
			]),
		);
		expect(files[".fabric-render"]).toBe(`${next.pin}\n`);
		expect(
			(await readdir(codex)).filter((name) => /\.(tmp|old)-/.test(name)),
		).toEqual([]);
	});

	describe("binding to one project on one deployment", () => {
		const folder = () => path.join(codex, "fabric-23456789");
		const OTHER_PROJECT = "cmotherproject0123456789";

		async function seedLegacy(url: string) {
			await mkdir(folder(), { recursive: true });
			await writeFile(
				path.join(folder(), ".mcp.json"),
				JSON.stringify({
					mcpServers: { "fabric-23456789": { type: "http", url } },
				}),
			);
			await writeFile(path.join(folder(), ".fabric-render"), "stale\n");
		}

		it("records the project and deployment in the plugin folder", async () => {
			await render(fakeClient({ repo: REPO }), { tool: "codex" });

			expect(
				JSON.parse(
					await readFile(
						path.join(folder(), ".fabric-binding.json"),
						"utf8",
					),
				),
			).toEqual({ projectId: PROJECT, origin: ORIGIN });
		});

		it("renders again for the same project on the same deployment", async () => {
			await render(fakeClient({ repo: REPO }), { tool: "codex" });

			const next = await render(
				fakeClient({ repo: { ...REPO, commit: "e".repeat(40) } }),
				{ tool: "codex" },
			);

			expect(next.reused).toBe(false);
		});

		it("refuses another project with the same short name and keeps the folder", async () => {
			await render(fakeClient({ repo: REPO }), { tool: "codex" });
			const before = await tree(folder());

			const refused = expect(
				render(fakeClient({ repo: REPO }), {
					tool: "codex",
					projectId: OTHER_PROJECT,
				}),
			).rejects;

			await refused.toMatchObject({ exitCode: 7 });
			await refused.toThrow(
				new RegExp(
					`fabric-23456789 is already taken by project ${PROJECT} on ${ORIGIN}`,
				),
			);
			expect(await tree(folder())).toEqual(before);
		});

		it("refuses the same project on another deployment", async () => {
			await render(fakeClient({ repo: REPO }), { tool: "codex" });

			await expect(
				render(fakeClient({ repo: REPO }), {
					tool: "codex",
					origin: "https://other.example.org",
				}),
			).rejects.toThrow(/on https:\/\/example.com/);
		});

		it("reads the owner of a folder written before the binding file existed, and refuses a different project", async () => {
			await seedLegacy(
				`${ORIGIN}/api/mcp-gateway/projects/${OTHER_PROJECT}`,
			);

			await expect(
				render(fakeClient({ repo: REPO }), { tool: "codex" }),
			).rejects.toThrow(
				new RegExp(
					`already taken by project ${OTHER_PROJECT} on ${ORIGIN}`,
				),
			);
		});

		it("refuses a legacy folder of the same project on another deployment", async () => {
			await seedLegacy(
				`https://other.example.org/api/mcp-gateway/projects/${PROJECT}`,
			);

			await expect(
				render(fakeClient({ repo: REPO }), { tool: "codex" }),
			).rejects.toThrow(/on https:\/\/other.example.org/);
		});

		it("takes over a legacy folder it cannot identify and records the binding", async () => {
			await mkdir(folder(), { recursive: true });
			await writeFile(path.join(folder(), ".mcp.json"), "not json");

			await render(fakeClient({ repo: REPO }), { tool: "codex" });

			expect(
				JSON.parse(
					await readFile(
						path.join(folder(), ".fabric-binding.json"),
						"utf8",
					),
				),
			).toEqual({ projectId: PROJECT, origin: ORIGIN });
		});
	});

	it("hands back the AGENTS.md text, since Codex has no slot for it", async () => {
		const rendered = await render(
			fakeClient({
				repo: {
					...REPO,
					files: [
						{ path: "AGENTS.md", text: "agents rules" },
						...REPO.files,
					],
				},
			}),
			{ tool: "codex" },
		);

		expect(rendered.alwaysOn?.file).toBe("AGENTS.md");
		expect(rendered.alwaysOn?.text).toContain("agents rules");
		expect(
			rendered.alwaysOn?.text.indexOf("fabric-instruction-access"),
		).toBeLessThan(rendered.alwaysOn?.text.indexOf("agents rules") ?? -1);
	});
});
