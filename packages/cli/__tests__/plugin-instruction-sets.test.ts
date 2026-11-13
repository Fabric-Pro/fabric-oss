/**
 * Coding Instructions sets in the CLI: which files a set holds (and the paths
 * its plugin gives them), which set `init` chooses for a checkout, and the
 * identity of a set's plugin, which must leave the default set's (and a
 * project without sets') plugin exactly as it was.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
	FabricClient,
	InstructionSet,
	ProjectCodeRepository,
} from "@fabricorg/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CliFailure } from "../src/lib/command-boundary.js";
import { gitBlobOid } from "../src/lib/git-blob.js";
import { desiredHooks } from "../src/lib/memory/hooks.js";
import {
	assertLocationFree,
	BINDING_FILE,
	bindingText,
} from "../src/lib/plugin/binding.js";
import {
	loadRenderSet,
	pathInInstructionSet,
	pluginCacheKey,
	REPOSITORIES_FILE,
	remoteNamesRepository,
	repositoriesMarkdown,
	resolveInstructionSet,
} from "../src/lib/plugin/instruction-sets.js";
import { idPluginName, pluginNameFor } from "../src/lib/plugin/layout.js";
import { setPluginNamesFile } from "../src/lib/plugin/plugin-names.js";
import {
	claudeMarketplaceDirectory,
	pluginIdFor,
	renderCommandLine,
} from "../src/lib/plugin/register.js";
import { renderPlugin } from "../src/lib/plugin/render.js";
import { rulesFolderFor } from "../src/lib/plugin/rules-sync.js";
import { readInstructions } from "../src/lib/plugin/source.js";

vi.mock("../src/lib/oauth/mcp-token.js", () => ({
	hasMcpSignIn: () => false,
}));

const PROJECT = "cmexampleproject0123456789";
const ORIGIN = "https://example.com";
const BASE = idPluginName(PROJECT);
const encode = (text: string) => new TextEncoder().encode(text);

function set(overrides: Partial<InstructionSet> & { slug: string }) {
	const isDefault = overrides.isDefault ?? overrides.slug === "default";
	return {
		id: `set-${overrides.slug}`,
		name: overrides.slug,
		isDefault,
		repositoryIntegrationIds: [],
		folder: isDefault ? "" : `instructions/${overrides.slug}/`,
		excludedFolders: [],
		...overrides,
	} satisfies InstructionSet;
}

function repository(
	overrides: Partial<ProjectCodeRepository> & { id: string; name: string },
): ProjectCodeRepository {
	return {
		provider: "GITHUB",
		cloneUrl: `https://github.com/${overrides.name}.git`,
		defaultBranch: "main",
		roleTag: null,
		folder: overrides.name.split("/").pop() as string,
		...overrides,
	};
}

const MOBILE = set({
	slug: "mobile",
	name: "Mobile",
	repositoryIntegrationIds: ["repo-app"],
});
const WEB = set({ slug: "web", repositoryIntegrationIds: ["repo-web"] });
const DEFAULT = set({
	slug: "default",
	repositoryIntegrationIds: ["repo-api"],
	excludedFolders: ["instructions/mobile/", "instructions/web/"],
});
const REPOSITORIES = [
	repository({ id: "repo-app", name: "example-org/app", roleTag: "mobile" }),
	repository({ id: "repo-web", name: "example-org/web" }),
	repository({ id: "repo-api", name: "example-org/api" }),
];

const SOURCE: Record<string, string> = {
	"CLAUDE.md": "# Root memory\n",
	".claude/skills/shared/SKILL.md": "---\nname: shared\n---\nShared.\n",
	"rules/style.md": "Tabs.\n",
	"instructions/mobile/CLAUDE.md": "# Mobile memory\n",
	"instructions/mobile/skills/release/SKILL.md":
		"---\nname: release\n---\nShip it.\n",
	"instructions/mobile/rules/naming.md": "Names.\n",
	"instructions/mobile/notes.txt": "not a plugin file\n",
	"instructions/web/CLAUDE.md": "# Web memory\n",
};

function fakeClient(files: Record<string, string> = SOURCE) {
	const commit = "a".repeat(40);
	const reads: string[][] = [];
	const client = {
		instructions: {
			getPublished: vi.fn(async () => ({
				published: true,
				sourceOfTruth: "REPOSITORY",
				direct: {
					availability: "READY",
					readState: "DIRECT",
					generation: 3,
					currentCommitSha: commit,
				},
			})),
			listRepositoryFiles: vi.fn(async () => ({
				generation: 3,
				commitSha: commit,
				incomplete: false,
				refusal: null,
				files: Object.entries(files).map(([filePath, text]) => ({
					path: filePath,
					kind: "OTHER",
					size: encode(text).length,
					blobId: gitBlobOid(encode(text)),
				})),
			})),
			readRepositoryFiles: vi.fn(
				async (_project: string, input: { paths: string[] }) => {
					reads.push(input.paths);
					return {
						generation: 3,
						commitSha: commit,
						nextIndex: null,
						files: input.paths.map((filePath) => {
							const text = files[filePath] ?? "";
							return {
								path: filePath,
								read: {
									state: "found",
									text,
									size: encode(text).length,
								},
							};
						}),
					};
				},
			),
		},
		memory: {
			getTargets: vi.fn(async () => ({ sync: null, targets: [] })),
		},
		knowledge: { getProjectTypes: vi.fn(async () => ({ types: [] })) },
	};
	return {
		client: client as unknown as Pick<
			FabricClient,
			"instructions" | "memory" | "knowledge"
		>,
		reads,
	};
}

let cache: string;

beforeEach(async () => {
	cache = await mkdtemp(path.join(tmpdir(), "fabric-sets-"));
	setPluginNamesFile(path.join(cache, "plugin-names.json"));
});

afterEach(async () => {
	setPluginNamesFile(null);
	await rm(cache, { recursive: true, force: true });
});

describe("pathInInstructionSet", () => {
	it("strips a set's folder, drops other folders, and keeps every path without a set", () => {
		const mobile = { folder: "instructions/mobile/", excludedFolders: [] };
		expect(
			pathInInstructionSet(
				"instructions/mobile/skills/a/SKILL.md",
				mobile,
			),
		).toBe("skills/a/SKILL.md");
		expect(pathInInstructionSet("CLAUDE.md", mobile)).toBeNull();
		expect(
			pathInInstructionSet("instructions/mobile-old/x.md", mobile),
		).toBeNull();
		expect(pathInInstructionSet("instructions/web/x.md", DEFAULT)).toBe(
			null,
		);
		expect(pathInInstructionSet("rules/style.md", DEFAULT)).toBe(
			"rules/style.md",
		);
		expect(pathInInstructionSet("instructions/web/x.md", null)).toBe(
			"instructions/web/x.md",
		);
	});
});

describe("readInstructions with a set", () => {
	const read = (scope: InstructionSet | null, setup = fakeClient()) =>
		readInstructions({
			client: setup.client,
			projectId: PROJECT,
			published: {
				published: true,
				sourceOfTruth: "REPOSITORY",
				direct: { availability: "READY" },
			} as never,
			cacheDirectory: cache,
			timeoutMs: 5_000,
			set: scope,
		});

	it("reads only the set's files, by their source path, and returns them relative to the set's folder", async () => {
		const setup = fakeClient();
		const result = await read(MOBILE, setup);

		expect(result.files.map((file) => file.path).sort()).toEqual([
			"CLAUDE.md",
			"rules/naming.md",
			"skills/release/SKILL.md",
		]);
		expect(
			new TextDecoder().decode(
				result.files.find((file) => file.path === "CLAUDE.md")?.bytes,
			),
		).toBe("# Mobile memory\n");
		expect(setup.reads.flat().sort()).toEqual([
			"instructions/mobile/CLAUDE.md",
			"instructions/mobile/rules/naming.md",
			"instructions/mobile/skills/release/SKILL.md",
		]);
		expect(result.listed.map((entry) => entry.path).sort()).toEqual([
			"CLAUDE.md",
			"notes.txt",
			"rules/naming.md",
			"skills/release/SKILL.md",
		]);
	});

	it("gives the default set the root without the other sets' folders", async () => {
		const result = await read(DEFAULT);

		expect(result.files.map((file) => file.path).sort()).toEqual([
			".claude/skills/shared/SKILL.md",
			"CLAUDE.md",
			"rules/style.md",
		]);
		expect(
			result.listed.some((entry) =>
				entry.path.startsWith("instructions/"),
			),
		).toBe(false);
	});

	it("reads the whole source without a set", async () => {
		const result = await read(null);

		expect(result.listed).toHaveLength(Object.keys(SOURCE).length);
		// Paths stay source paths; a set's folder is not a plugin path then.
		expect(result.listed.map((entry) => entry.path)).toContain(
			"instructions/mobile/CLAUDE.md",
		);
		expect(result.files.map((file) => file.path)).toContain("CLAUDE.md");
	});
});

describe("resolveInstructionSet", () => {
	const deps = (
		input: {
			sets?: InstructionSet[];
			remotes?: string[];
			choose?: (sets: InstructionSet[]) => Promise<number | null>;
		} = {},
	) => ({
		listSets: async () => input.sets ?? [DEFAULT, MOBILE, WEB],
		listCodeRepositories: async () => REPOSITORIES,
		remoteUrls: async () => input.remotes ?? [],
		choose: input.choose,
	});

	it("is no set for a project without sets", async () => {
		expect(
			await resolveInstructionSet(undefined, deps({ sets: [] })),
		).toBeNull();
	});

	it("takes the one set that covers the checkout's repository, whatever the remote's spelling", async () => {
		for (const remote of [
			"git@github.com:example-org/app.git",
			"https://GitHub.com/Example-Org/App/",
			"ssh://git@github.com/example-org/app",
		]) {
			expect(
				(
					await resolveInstructionSet(
						undefined,
						deps({ remotes: [remote] }),
					)
				)?.slug,
			).toBe("mobile");
		}
	});

	it("asks when several sets cover the repository, and fails listing them when nobody can answer", async () => {
		const both = [
			DEFAULT,
			MOBILE,
			{ ...WEB, repositoryIntegrationIds: ["repo-app"] },
		];
		const choose = vi.fn(async () => 1);
		expect(
			(
				await resolveInstructionSet(
					undefined,
					deps({
						sets: both,
						remotes: ["git@github.com:example-org/app.git"],
						choose,
					}),
				)
			)?.slug,
		).toBe("web");
		expect(choose).toHaveBeenCalledOnce();

		const failure = await resolveInstructionSet(
			undefined,
			deps({
				sets: both,
				remotes: ["git@github.com:example-org/app.git"],
			}),
		).catch((error) => error);
		expect(failure).toBeInstanceOf(CliFailure);
		expect(failure.message).toContain("mobile, web");
		expect(failure.message).toContain("--set");
	});

	it("fails, naming the sets, when no set covers the repository", async () => {
		const failure = await resolveInstructionSet(
			undefined,
			deps({
				sets: [DEFAULT, MOBILE],
				remotes: ["https://github.com/example-org/web"],
			}),
		).catch((error) => error);
		expect(failure).toBeInstanceOf(CliFailure);
		expect(failure.message).toContain(
			"No Coding Instructions set covers example-org/web",
		);
		expect(failure.message).toContain("default, mobile");
	});

	it("uses the default set for a folder that is no checkout of a code repository", async () => {
		expect(
			(
				await resolveInstructionSet(
					undefined,
					deps({ remotes: ["https://github.com/example-org/other"] }),
				)
			)?.slug,
		).toBe("default");
		expect(
			(await resolveInstructionSet(undefined, deps({ remotes: [] })))
				?.slug,
		).toBe("default");
	});

	it("takes --set as named, and refuses an unknown slug listing the valid ones", async () => {
		expect((await resolveInstructionSet("web", deps()))?.slug).toBe("web");
		const failure = await resolveInstructionSet("desktop", deps()).catch(
			(error) => error,
		);
		expect(failure).toBeInstanceOf(CliFailure);
		expect(failure.message).toContain("default, mobile, web");
		const none = await resolveInstructionSet(
			"web",
			deps({ sets: [] }),
		).catch((error) => error);
		expect(none.message).toContain("no Coding Instructions sets");
	});
});

describe("remoteNamesRepository", () => {
	it("compares GitLab paths exactly and Azure DevOps by its identity", () => {
		const gitlab = {
			provider: "GITLAB" as const,
			cloneUrl: "https://gitlab.com/Example/app.git",
		};
		expect(
			remoteNamesRepository("git@gitlab.com:Example/app.git", gitlab),
		).toBe(true);
		expect(
			remoteNamesRepository("git@gitlab.com:example/app.git", gitlab),
		).toBe(false);
		expect(
			remoteNamesRepository(
				"git@ssh.dev.azure.com:v3/example-org/Proj/app",
				{
					provider: "AZURE_DEVOPS",
					cloneUrl: "https://dev.azure.com/example-org/proj/_git/app",
				},
			),
		).toBe(true);
	});
});

describe("loadRenderSet", () => {
	const client = (sets: InstructionSet[] | Error) =>
		({
			projects: {
				listInstructionSets: async () => {
					if (sets instanceof Error) {
						throw sets;
					}
					return { sets };
				},
				listCodeRepositories: async () => ({
					repositories: REPOSITORIES,
				}),
			},
		}) as unknown as Pick<FabricClient, "projects">;

	it("renders the default set without --set, a named one with it, and none for a project without sets or a deployment without them", async () => {
		const sets = [DEFAULT, MOBILE];
		expect(
			(await loadRenderSet({ client: client(sets), projectId: PROJECT }))
				?.set.slug,
		).toBe("default");
		const mobile = await loadRenderSet({
			client: client(sets),
			projectId: PROJECT,
			set: "mobile",
			withRepositories: true,
		});
		expect(mobile?.repositories.map((entry) => entry.id)).toEqual([
			"repo-app",
		]);
		expect(
			await loadRenderSet({ client: client([]), projectId: PROJECT }),
		).toBeNull();
		const notFound = Object.assign(new Error("not found"), {
			status: 404,
		});
		expect(
			await loadRenderSet({
				client: client(notFound),
				projectId: PROJECT,
			}),
		).toBeNull();
		await expect(
			loadRenderSet({
				client: client(notFound),
				projectId: PROJECT,
				set: "mobile",
			}),
		).rejects.toThrow("not found");
	});
});

describe("a set's plugin identity", () => {
	it("keeps the project's names and folders for no set and the default set", () => {
		for (const scope of [undefined, null, "default"]) {
			expect(pluginNameFor(PROJECT, scope)).toBe(BASE);
			expect(pluginIdFor(PROJECT, scope)).toBe(`${BASE}@${BASE}`);
			expect(pluginCacheKey(PROJECT, scope)).toBe(PROJECT);
			expect(rulesFolderFor(PROJECT, scope)).toBe(
				`.claude/rules/${BASE}`,
			);
			expect(claudeMarketplaceDirectory(cache, PROJECT, scope)).toBe(
				path.join(cache, "marketplaces", BASE),
			);
		}
	});

	it("gives a non-default set a plugin, cache folder and rules folder of its own", () => {
		expect(pluginNameFor(PROJECT, "mobile")).toBe(`${BASE}-mobile`);
		expect(pluginIdFor(PROJECT, "mobile")).toBe(
			`${BASE}-mobile@${BASE}-mobile`,
		);
		expect(pluginCacheKey(PROJECT, "mobile")).toBe(`${PROJECT}--mobile`);
		expect(rulesFolderFor(PROJECT, "mobile")).toBe(
			`.claude/rules/${BASE}-mobile`,
		);
	});

	it("keeps --set in the render command and the hooks for a non-default set only", () => {
		const line = (scope?: string) =>
			renderCommandLine({
				launcherPrefix: "fabric",
				nodeWord: null,
				projectId: PROJECT,
				baseUrl: ORIGIN,
				set: scope,
			});
		expect(line()).toBe(
			`fabric instructions render --project ${PROJECT} --base-url ${ORIGIN}`,
		);
		expect(line("default")).toBe(line());
		expect(line("mobile")).toBe(`${line()} --set mobile`);

		const codex = desiredHooks({
			tool: "codex",
			projectId: PROJECT,
			launcher: "fabric",
			set: "mobile",
		});
		expect(codex[0]?.command).toContain(
			`--project ${PROJECT} --set mobile --target codex`,
		);
		const claude = desiredHooks({
			tool: "claude-code",
			projectId: PROJECT,
			launcher: "fabric",
			set: "mobile",
		});
		expect(claude[0]?.command).toBe(
			`fabric instructions rules --project ${PROJECT} --set mobile --hook`,
		);
		expect(
			desiredHooks({
				tool: "claude-code",
				projectId: PROJECT,
				launcher: "fabric",
				set: "default",
			}),
		).toEqual(
			desiredHooks({
				tool: "claude-code",
				projectId: PROJECT,
				launcher: "fabric",
			}),
		);
	});
});

describe("binding of a set's plugin", () => {
	const write = async (text: string) => {
		const directory = path.join(cache, "location");
		await mkdir(directory, { recursive: true });
		await writeFile(path.join(directory, BINDING_FILE), text);
		return directory;
	};

	it("records a non-default set only, and refuses a location bound to another set of the project", async () => {
		expect(
			JSON.parse(
				bindingText({
					projectId: PROJECT,
					origin: ORIGIN,
					set: "default",
				}),
			),
		).toEqual({ projectId: PROJECT, origin: ORIGIN });
		const directory = await write(
			bindingText({ projectId: PROJECT, origin: ORIGIN, set: "mobile" }),
		);

		await expect(
			assertLocationFree({
				directory,
				location: "codex-plugin",
				wanted: { projectId: PROJECT, origin: ORIGIN, set: "mobile" },
			}),
		).resolves.toBeUndefined();
		for (const other of ["web", null]) {
			await expect(
				assertLocationFree({
					directory,
					location: "codex-plugin",
					wanted: { projectId: PROJECT, origin: ORIGIN, set: other },
				}),
			).rejects.toThrow("Coding Instructions set mobile");
		}
	});

	it("takes the default set's plugin as the project's own", async () => {
		const directory = await write(
			bindingText({ projectId: PROJECT, origin: ORIGIN }),
		);
		await expect(
			assertLocationFree({
				directory,
				location: "claude-marketplace",
				wanted: { projectId: PROJECT, origin: ORIGIN, set: "default" },
			}),
		).resolves.toBeUndefined();
	});
});

describe("repositoriesMarkdown", () => {
	it("lists the set's repositories, sorted and credential-free, under a do-not-edit header", () => {
		const text = repositoriesMarkdown(MOBILE, [
			repository({
				id: "repo-z",
				name: "example-org/zeta",
				cloneUrl:
					"https://user:secret@example.com/example-org/zeta.git",
				defaultBranch: "develop",
			}),
			repository({
				id: "repo-app",
				name: "example-org/app",
				roleTag: "mobile",
			}),
		]);

		expect(text.split("\n")[0]).toContain(
			"Generated by Fabric. Do not edit",
		);
		expect(text).not.toContain("secret");
		expect(text).toContain(
			"- Clone URL: https://example.com/example-org/zeta.git",
		);
		expect(text.indexOf("## example-org/app")).toBeLessThan(
			text.indexOf("## example-org/zeta"),
		);
		expect(text).toContain(
			[
				"## example-org/app",
				"",
				"- Clone URL: https://github.com/example-org/app.git",
				"- Default branch: main",
				"- Role: mobile",
				"- Workspace folder: `repos/app`",
			].join("\n"),
		);
		expect(text).toContain("- Default branch: develop");
		expect(text).toContain("- Role: none");
	});
});

describe("renderPlugin with a set", () => {
	const render = (
		scope: {
			set: InstructionSet;
			repositories: ProjectCodeRepository[];
		} | null,
		tool: "claude-code" | "codex" = "claude-code",
	) =>
		renderPlugin({
			client: fakeClient().client,
			projectId: PROJECT,
			origin: ORIGIN,
			tool,
			cacheDirectory: cache,
			codexPluginsDirectory: path.join(cache, "codex"),
			timeoutMs: 5_000,
			set: scope,
		});

	it("renders a non-default set as its own plugin with its files and REPOSITORIES.md", async () => {
		const rendered = await render({
			set: MOBILE,
			repositories: [REPOSITORIES[0] as ProjectCodeRepository],
		});

		expect(path.dirname(rendered.directory)).toBe(
			path.join(cache, "plugins", `${PROJECT}--mobile`),
		);
		const manifest = JSON.parse(
			await readFile(
				path.join(rendered.directory, ".claude-plugin", "plugin.json"),
				"utf8",
			),
		);
		expect(manifest.name).toBe(`${BASE}-mobile`);
		expect(
			await readFile(
				path.join(rendered.directory, "instructions", "CLAUDE.md"),
				"utf8",
			),
		).toBe("# Mobile memory\n");
		const paths = rendered.files.map((file) => file.path);
		expect(paths).toContain("skills/release/SKILL.md");
		expect(paths).not.toContain("skills/shared/SKILL.md");
		expect(
			await readFile(
				path.join(rendered.directory, ...REPOSITORIES_FILE.split("/")),
				"utf8",
			),
		).toBe(repositoriesMarkdown(MOBILE, [REPOSITORIES[0] as never]));
		const context = JSON.parse(
			await readFile(
				path.join(rendered.directory, "hooks", "session-context.json"),
				"utf8",
			),
		).hookSpecificOutput.additionalContext as string;
		expect(context).toContain(REPOSITORIES_FILE);
		expect(context).toContain("instructions/mobile/");
	});

	it("keeps the default set in the project's folder, and changes the pin with the set", async () => {
		const plain = await render(null);
		const byDefault = await render({ set: DEFAULT, repositories: [] });
		const mobile = await render({ set: MOBILE, repositories: [] });

		expect(path.dirname(plain.directory)).toBe(
			path.join(cache, "plugins", PROJECT),
		);
		expect(path.dirname(byDefault.directory)).toBe(
			path.join(cache, "plugins", PROJECT),
		);
		expect(new Set([plain.pin, byDefault.pin, mobile.pin]).size).toBe(3);
		expect(plain.files.map((file) => file.path)).not.toContain(
			REPOSITORIES_FILE,
		);
		const again = await render({ set: DEFAULT, repositories: [] });
		expect(again.pin).toBe(byDefault.pin);
		expect(again.reused).toBe(true);
	});

	it("installs a non-default set's Codex plugin in a folder of its own, bound to the set", async () => {
		const rendered = await render(
			{ set: MOBILE, repositories: [] },
			"codex",
		);

		expect(rendered.directory).toBe(
			path.join(cache, "codex", `${BASE}-mobile`),
		);
		expect(
			JSON.parse(
				await readFile(
					path.join(rendered.directory, BINDING_FILE),
					"utf8",
				),
			),
		).toEqual({ projectId: PROJECT, origin: ORIGIN, set: "mobile" });
	});
});
