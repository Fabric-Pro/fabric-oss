/**
 * `fabric instructions render` and `fabric instructions init --plugin`, end to
 * end through the command line, with the SDK client mocked where `getClient`
 * hands it out (the same boundary the other `instructions` command tests use).
 *
 * What is pinned: `render` prints the plugin's folder and nothing else on
 * stdout (a Claude Code `command` source takes that one line), fails with a
 * reason on stderr and a non-zero exit, and never fails a hook; `init --plugin`
 * writes the settings, hooks and marketplace entry the design promises, keeps
 * them out of commits, and leaves the clone mode's files alone.
 */
import { execFileSync } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitBlobOid } from "../src/lib/git-blob.js";
import { serverNameFor } from "../src/lib/instructions/agent-mcp.js";
import { machine } from "../src/lib/instructions/machine.js";
import { projectResource } from "../src/lib/oauth/project-resource.js";
import {
	makeTree,
	resetInstructionsMocks,
	runCli,
	seedLock,
} from "./helpers/instructions-commands.js";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		getPublished: vi.fn(),
		createDownloadUrl: vi.fn(),
		getApiKey: vi.fn<() => string | undefined>(),
		getConfigPath: vi.fn<() => string>(),
		getDefaultContext: vi.fn<() => unknown>(),
		withoutContext: vi.fn(),
		getClient: vi.fn(),
		listRepositoryFiles: vi.fn(),
		readRepositoryFiles: vi.fn(),
		getTargets: vi.fn(),
		run: vi.fn(),
	},
}));

vi.mock("../src/lib/instructions/agent-run.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../src/lib/instructions/agent-run.js")
	>()),
	createAgentRunner: () => mocks.run,
}));

vi.mock("../src/lib/config.js", () => ({
	getApiKey: mocks.getApiKey,
	getOAuth: () => undefined,
	listProjectSignIns: () => [],
	hasStoredApiKey: () => mocks.getApiKey() !== undefined,
	getConfigPath: mocks.getConfigPath,
	getBaseUrl: () => undefined,
	getDefaultContext: mocks.getDefaultContext,
	getOutputFormat: () => "table",
}));

vi.mock("../src/lib/client.js", () => {
	const client = {
		instructions: {
			getPublished: mocks.getPublished,
			createDownloadUrl: mocks.createDownloadUrl,
			listRepositoryFiles: mocks.listRepositoryFiles,
			readRepositoryFiles: mocks.readRepositoryFiles,
		},
		memory: { getTargets: mocks.getTargets },
		withoutContext: () => {
			mocks.withoutContext();
			return client;
		},
	};
	return {
		getClient: (overrides: unknown) => {
			mocks.getClient(overrides);
			return client;
		},
	};
});

const PROJECT = "cm0example0project";
const SERVER = serverNameFor(PROJECT);

let config: string;
let home: string;

const FILES: Record<string, string> = {
	"CLAUDE.md": "# Team rules\nBe kind.\n",
	"AGENTS.md": "# Agents\nUse the tools.\n",
	".claude/skills/deploy/SKILL.md": "---\nname: deploy\n---\nDeploy.\n",
	".claude/agents/reviewer.md": "reviewer\n",
};

function serveRepository(
	files: Record<string, string> = FILES,
	commit = "a".repeat(40),
) {
	mocks.getPublished.mockResolvedValue({
		published: true,
		sourceOfTruth: "REPOSITORY",
		direct: {
			availability: "READY",
			readState: "DIRECT",
			generation: 1,
			currentCommitSha: commit,
		},
	});
	mocks.listRepositoryFiles.mockResolvedValue({
		generation: 1,
		commitSha: commit,
		incomplete: false,
		refusal: null,
		files: Object.keys(files).map((p) => ({
			path: p,
			kind: "OTHER",
			size: files[p]?.length,
			blobId: gitBlobOid(new TextEncoder().encode(files[p] ?? "")),
		})),
	});
	mocks.readRepositoryFiles.mockImplementation(
		async (_project: string, input: { paths: string[] }) => ({
			generation: 1,
			commitSha: commit,
			nextIndex: null,
			files: input.paths.map((filePath) => ({
				path: filePath,
				read: {
					state: "found",
					text: files[filePath] ?? "",
					size: new TextEncoder().encode(files[filePath] ?? "")
						.length,
				},
			})),
		}),
	);
}

beforeEach(async () => {
	resetInstructionsMocks({
		...mocks,
	});
	config = await mkdtemp(path.join(tmpdir(), "fabric-config-"));
	home = await mkdtemp(path.join(tmpdir(), "fabric-home-"));
	mocks.getConfigPath.mockReturnValue(path.join(config, "config.json"));
	mocks.listRepositoryFiles.mockReset();
	mocks.readRepositoryFiles.mockReset();
	mocks.getTargets.mockReset();
	mocks.run.mockReset();
	mocks.run.mockResolvedValue({ kind: "missing" });
	mocks.getTargets.mockResolvedValue({
		sync: {
			ref: "main",
			lastAppliedCommitSha: null,
			ingesting: true,
			repository: { provider: "GITHUB", owner: "o", name: "r" },
		},
		targets: [
			{ id: "t1", folder: "docs/ai", mode: "PULL_REQUEST", version: 1 },
		],
	});
	serveRepository();
	vi.spyOn(machine, "home").mockReturnValue(home);
	vi.spyOn(machine, "env").mockReturnValue({});
	vi.stubEnv("CI", "");
});

afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	await rm(config, { recursive: true, force: true });
	await rm(home, { recursive: true, force: true });
});

describe("fabric instructions render", () => {
	it("prints the plugin's folder and nothing else on stdout", async () => {
		const result = await runCli(["render", "--project", PROJECT]);

		expect(result.code).toBe(0);
		const lines = result.stdout.split("\n").filter((line) => line !== "");
		expect(lines).toHaveLength(1);
		const directory = lines[0] as string;
		expect(path.isAbsolute(directory)).toBe(true);
		expect(
			directory.startsWith(
				path.join(config, "cache", "plugins", PROJECT),
			),
		).toBe(true);
		expect(result.stderr).toBe("");
		const manifest = JSON.parse(
			await readFile(
				path.join(directory, ".claude-plugin", "plugin.json"),
				"utf8",
			),
		);
		expect(manifest.name).toBe("fabric-0project");
		expect(
			await readFile(
				path.join(directory, "instructions", "CLAUDE.md"),
				"utf8",
			),
		).toBe(FILES["CLAUDE.md"]);
		expect(
			(
				await stat(path.join(directory, "skills", "deploy", "SKILL.md"))
			).isFile(),
		).toBe(true);
	});

	it("prints the same folder for the same instructions, and a different one when they change", async () => {
		const first = (await runCli(["render", "--project", PROJECT])).stdout;
		const again = (await runCli(["render", "--project", PROJECT])).stdout;
		serveRepository(
			{ ...FILES, "CLAUDE.md": "# Changed\n" },
			"b".repeat(40),
		);
		const changed = (await runCli(["render", "--project", PROJECT])).stdout;

		expect(again).toBe(first);
		expect(changed).not.toBe(first);
	});

	it("fails with the reason on stderr, a non-zero exit and an empty stdout", async () => {
		mocks.getPublished.mockRejectedValue(new Error("Fabric is down"));

		const result = await runCli(["render", "--project", PROJECT]);

		expect(result.code).not.toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("render failed: Fabric is down");
	});

	it("says it is not signed in, with the line that fixes it, and exits 3", async () => {
		mocks.getApiKey.mockReturnValue(undefined);

		const result = await runCli(["render", "--project", PROJECT]);

		expect(result.code).toBe(3);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("not signed in");
	});

	it("refuses an unknown target and a project that is not an id", async () => {
		expect(
			(await runCli(["render", "--project", PROJECT, "--target", "vim"]))
				.code,
		).toBe(2);
		expect((await runCli(["render", "--project", "a b"])).code).toBe(2);
	});

	it("needs a project", async () => {
		const result = await runCli(["render"]);

		expect(result.code).not.toBe(0);
		expect(result.stdout).toBe("");
	});

	it("puts a render under --out and keeps the CLI's own cache untouched", async () => {
		const out = await mkdtemp(path.join(tmpdir(), "fabric-out-"));
		try {
			const result = await runCli([
				"render",
				"--project",
				PROJECT,
				"--out",
				out,
			]);

			expect(
				result.stdout
					.trim()
					.startsWith(path.join(out, "plugins", PROJECT)),
			).toBe(true);
			await expect(stat(path.join(config, "cache"))).rejects.toThrow();
		} finally {
			await rm(out, { recursive: true, force: true });
		}
	});

	describe("for Codex", () => {
		it("renders into the home folder's .codex/plugins and refreshes AGENTS.override.md", async () => {
			const dest = await makeTree();
			await writeFile(path.join(dest, "AGENTS.md"), "tracked rules\n");

			const result = await runCli([
				"render",
				"--project",
				PROJECT,
				"--target",
				"codex",
				"--dest",
				dest,
			]);

			const directory = result.stdout.trim();
			expect(directory).toBe(
				path.join(home, ".codex", "plugins", "fabric-0project"),
			);
			expect(
				(
					await stat(
						path.join(directory, ".codex-plugin", "plugin.json"),
					)
				).isFile(),
			).toBe(true);
			const override = await readFile(
				path.join(dest, "AGENTS.override.md"),
				"utf8",
			);
			expect(override.indexOf("tracked rules")).toBeLessThan(
				override.indexOf("Use the tools."),
			);
		});

		describe("refreshing Codex's installed copy", () => {
			const addCalls = () =>
				mocks.run.mock.calls.filter(
					([command, args]) =>
						command === "codex" && args[0] === "plugin",
				);

			async function listPlugin(marketplaceName = "personal") {
				const file = path.join(
					home,
					".agents",
					"plugins",
					"marketplace.json",
				);
				await mkdir(path.dirname(file), { recursive: true });
				await writeFile(
					file,
					JSON.stringify({
						name: marketplaceName,
						plugins: [
							{
								name: "fabric-0project",
								source: {
									source: "local",
									path: "./.codex/plugins/fabric-0project",
								},
							},
						],
					}),
				);
			}

			const hookRender = async () =>
				runCli([
					"render",
					"--project",
					PROJECT,
					"--target",
					"codex",
					"--hook",
					"--dest",
					await makeTree(),
				]);

			it("runs codex plugin add with the listing marketplace whenever Codex does not hold the rendered version", async () => {
				await listPlugin("mine");
				// Like Codex: installing copies the plugin's version into its cache.
				mocks.run.mockImplementation(async () => {
					const manifest = JSON.parse(
						await readFile(
							path.join(
								home,
								".codex",
								"plugins",
								"fabric-0project",
								".codex-plugin",
								"plugin.json",
							),
							"utf8",
						),
					) as { version: string };
					await mkdir(
						path.join(
							home,
							".codex",
							"plugins",
							"cache",
							"mine",
							"fabric-0project",
							manifest.version,
						),
						{ recursive: true },
					);
					return { kind: "exited", code: 0, stdout: "", stderr: "" };
				});

				const first = await hookRender();
				const again = await hookRender();
				serveRepository(
					{ ...FILES, "AGENTS.md": "# New\n" },
					"c".repeat(40),
				);
				const changed = await hookRender();

				expect(first).toMatchObject({
					code: 0,
					stdout: "",
					stderr: "",
				});
				expect(again).toMatchObject({
					code: 0,
					stdout: "",
					stderr: "",
				});
				expect(changed).toMatchObject({
					code: 0,
					stdout: "",
					stderr: "",
				});
				expect(addCalls()).toHaveLength(2);
				expect(addCalls()[0]).toEqual([
					"codex",
					["plugin", "add", "fabric-0project@mine"],
					expect.objectContaining({ timeoutMs: expect.any(Number) }),
				]);
				for (const [, , options] of addCalls()) {
					expect(options.timeoutMs).toBeLessThanOrEqual(30_000);
				}
			});

			it("does nothing when the plugin is not listed in a marketplace", async () => {
				const result = await hookRender();

				expect(result).toMatchObject({ code: 0, stdout: "" });
				expect(addCalls()).toHaveLength(0);
			});

			it("never fails or prints when codex is missing, times out or throws", async () => {
				await listPlugin();
				for (const outcome of [
					{ kind: "missing" },
					{ kind: "timed-out" },
				] as const) {
					serveRepository(
						{ ...FILES, "AGENTS.md": `# ${outcome.kind}\n` },
						outcome.kind === "missing"
							? "d".repeat(40)
							: "e".repeat(40),
					);
					mocks.run.mockResolvedValue(outcome);

					const result = await hookRender();

					expect(result).toMatchObject({
						code: 0,
						stdout: "",
						stderr: "",
					});
				}
				serveRepository(
					{ ...FILES, "AGENTS.md": "# boom\n" },
					"f".repeat(40),
				);
				mocks.run.mockRejectedValue(new Error("spawn failed"));

				const thrown = await hookRender();

				expect(thrown).toMatchObject({
					code: 0,
					stdout: "",
					stderr: "",
				});
			});

			it("does not run it for a Claude Code render", async () => {
				await listPlugin();

				await runCli(["render", "--project", PROJECT]);

				expect(addCalls()).toHaveLength(0);
			});
		});

		it("in hook mode prints nothing and never fails", async () => {
			const ok = await runCli([
				"render",
				"--project",
				PROJECT,
				"--target",
				"codex",
				"--hook",
				"--dest",
				await makeTree(),
			]);
			mocks.getPublished.mockRejectedValue(new Error("down"));
			const failing = await runCli([
				"render",
				"--project",
				PROJECT,
				"--target",
				"codex",
				"--hook",
				"--dest",
				await makeTree(),
			]);

			expect(ok).toMatchObject({ code: 0, stdout: "" });
			expect(failing).toMatchObject({ code: 0, stdout: "" });
			expect(failing.stderr).toContain("render failed");
		});
	});
});

async function settings(dest: string): Promise<Record<string, any>> {
	return JSON.parse(
		await readFile(
			path.join(dest, ".claude", "settings.local.json"),
			"utf8",
		),
	);
}

describe("fabric instructions init --plugin", () => {
	it("registers a marketplace folder with a command source that renders the project, as a directory source in the settings", async () => {
		const dest = await makeTree();

		const result = await runCli([
			"init",
			"--plugin",
			"--project",
			PROJECT,
			"--tool",
			"claude-code",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(0);
		const written = await settings(dest);
		const folder = path.join(
			config,
			"cache",
			"marketplaces",
			"fabric-0project",
		);
		expect(written.extraKnownMarketplaces).toEqual({
			"fabric-0project": {
				source: { source: "directory", path: folder },
			},
		});
		expect(written.enabledPlugins).toEqual({
			"fabric-0project@fabric-0project": true,
		});
		const marketplace = JSON.parse(
			await readFile(
				path.join(folder, ".claude-plugin", "marketplace.json"),
				"utf8",
			),
		);
		const plugin = marketplace.plugins[0];
		expect(marketplace.name).toBe("fabric-0project");
		expect(plugin.source).toMatchObject({
			source: "command",
			mode: "copy",
			timeout: 120,
		});
		expect(plugin.source.command).toContain(
			`instructions render --project ${PROJECT}`,
		);
		expect(plugin.source.command).toContain(
			"--base-url https://fabric.pro",
		);
		expect(plugin.source.command.length).toBeLessThanOrEqual(500);
		expect(plugin.source.command).toMatch(/^[ -~]+$/);
		expect(plugin.source.command).not.toMatch(/ {4}/);
		expect(JSON.stringify(written)).not.toContain('"source": "settings"');
	});

	it("adds the hooks: the rules sync and the memory pull at session start, the memory push when a turn ends", async () => {
		const dest = await makeTree();

		await runCli([
			"init",
			"--plugin",
			"--project",
			PROJECT,
			"--tool",
			"claude-code",
			"--dest",
			dest,
		]);

		const written = await settings(dest);
		const start = written.hooks.SessionStart.flatMap((group: any) =>
			group.hooks.map((h: any) => h.command),
		);
		const stop = written.hooks.Stop.flatMap((group: any) =>
			group.hooks.map((h: any) => h.command),
		);
		expect(start).toEqual([
			`fabric instructions rules --project ${PROJECT} --base-url https://fabric.pro --hook`,
			`fabric memory pull --project ${PROJECT} --base-url https://fabric.pro --hook`,
		]);
		expect(stop).toEqual([
			`fabric memory push --project ${PROJECT} --base-url https://fabric.pro --hook`,
		]);
	});

	describe("project rules", () => {
		const RULE = "---\npaths:\n  - src/**\n---\nValidate input.\n";
		const FOLDER = ".claude/rules/fabric-0project";
		const withRules = () =>
			serveRepository({
				...FILES,
				"rules/api.md": RULE,
				".claude/rules/team/naming.md": "Names.\n",
			});
		const initClaude = async (dest: string) =>
			runCli([
				"init",
				"--plugin",
				"--project",
				PROJECT,
				"--tool",
				"claude-code",
				"--dest",
				dest,
			]);

		it("are in the project's rules folder by the end of init, as the instructions hold them, and out of commits", async () => {
			withRules();
			const dest = await makeTree();
			execFileSync("git", ["init", "-q"], { cwd: dest });

			const result = await initClaude(dest);

			expect(result.code).toBe(0);
			expect(
				await readFile(path.join(dest, FOLDER, "api.md"), "utf8"),
			).toBe(RULE);
			expect(
				await readFile(
					path.join(dest, FOLDER, "team", "naming.md"),
					"utf8",
				),
			).toBe("Names.\n");
			expect(result.stdout).toContain(`delivered to ${FOLDER}/`);
			const status = execFileSync(
				"git",
				["status", "--porcelain", "-uall"],
				{
					cwd: dest,
					encoding: "utf8",
				},
			);
			expect(status).not.toContain("api.md");
			expect(status).not.toContain("fabric-0project");
		});

		it("are refreshed by the session hook's command, which prints nothing and exits 0", async () => {
			withRules();
			const dest = await makeTree();
			await initClaude(dest);
			serveRepository({ ...FILES, "rules/api.md": "Changed.\n" });

			const result = await runCli([
				"rules",
				"--project",
				PROJECT,
				"--dest",
				dest,
				"--hook",
			]);

			expect(result.code).toBe(0);
			expect(result.stdout).toBe("");
			expect(
				await readFile(path.join(dest, FOLDER, "api.md"), "utf8"),
			).toBe("Changed.\n");
			await expect(
				stat(path.join(dest, FOLDER, "team", "naming.md")),
			).rejects.toThrow();
		});

		it("never fail the session hook, even when Fabric cannot be reached", async () => {
			const dest = await makeTree();
			mocks.getPublished.mockRejectedValue(new Error("offline"));

			const result = await runCli([
				"rules",
				"--project",
				PROJECT,
				"--dest",
				dest,
				"--hook",
			]);

			expect(result.code).toBe(0);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("rules failed");
		});

		it("a project without rules leaves no rules folder", async () => {
			const dest = await makeTree();

			await initClaude(dest);

			await expect(stat(path.join(dest, FOLDER))).rejects.toThrow();
		});
	});

	it("renders once so a broken setup shows now, and says how to approve the command", async () => {
		const dest = await makeTree();

		const result = await runCli([
			"init",
			"--plugin",
			"--project",
			PROJECT,
			"--tool",
			"claude-code",
			"--dest",
			dest,
		]);

		expect(mocks.getPublished).toHaveBeenCalled();
		expect(result.stdout).toContain("approve the plugin's command once");
		expect(result.stdout).toContain("claude plugin marketplace add");
		expect(result.stdout).toContain(
			"claude plugin install fabric-0project@fabric-0project --scope local",
		);
		expect(result.stdout).toContain("Memory folders are ready");
	});

	it("replaces a clone-mode hook for the project and leaves another project's alone", async () => {
		const dest = await makeTree();
		await mkdir(path.join(dest, ".claude"), { recursive: true });
		await writeFile(
			path.join(dest, ".claude", "settings.local.json"),
			JSON.stringify({
				hooks: {
					SessionStart: [
						{
							hooks: [
								{
									type: "command",
									command: `fabric instructions check --project ${PROJECT} --hook`,
								},
							],
						},
						{
							hooks: [
								{
									type: "command",
									command:
										"fabric instructions check --project other-project --hook",
								},
							],
						},
						{ hooks: [{ type: "command", command: "echo mine" }] },
					],
				},
			}),
		);

		await runCli([
			"init",
			"--plugin",
			"--project",
			PROJECT,
			"--tool",
			"claude-code",
			"--dest",
			dest,
		]);

		const commands = (await settings(dest)).hooks.SessionStart.flatMap(
			(group: any) => group.hooks.map((h: any) => h.command),
		);
		expect(commands).toContain(
			"fabric instructions check --project other-project --hook",
		);
		expect(commands).toContain("echo mine");
		expect(
			commands.some((c: string) =>
				c.includes(`instructions check --project ${PROJECT}`),
			),
		).toBe(false);
		expect(
			commands.some((c: string) => c.startsWith("fabric memory pull")),
		).toBe(true);
	});

	it("is the same file when run again", async () => {
		const dest = await makeTree();
		const argv = [
			"init",
			"--plugin",
			"--project",
			PROJECT,
			"--tool",
			"claude-code",
			"--dest",
			dest,
		];
		await runCli(argv);
		const first = await readFile(
			path.join(dest, ".claude", "settings.local.json"),
			"utf8",
		);

		await runCli(argv);

		expect(
			await readFile(
				path.join(dest, ".claude", "settings.local.json"),
				"utf8",
			),
		).toBe(first);
	});

	it("keeps its files out of commits", async () => {
		const dest = await makeTree();
		execFileSync("git", ["init", "-q"], { cwd: dest });

		await runCli([
			"init",
			"--plugin",
			"--project",
			PROJECT,
			"--tool",
			"claude-code",
			"--dest",
			dest,
		]);

		const status = execFileSync("git", ["status", "--porcelain"], {
			cwd: dest,
			encoding: "utf8",
		});
		expect(status).toBe("");
	});

	it("copies nothing into the project: no instruction files, no lock", async () => {
		const dest = await makeTree();

		await runCli([
			"init",
			"--plugin",
			"--project",
			PROJECT,
			"--tool",
			"claude-code",
			"--dest",
			dest,
		]);

		await expect(stat(path.join(dest, "CLAUDE.md"))).rejects.toThrow();
		await expect(
			stat(path.join(dest, ".fabric", "instructions.lock")),
		).rejects.toThrow();
	});

	it("reports in JSON", async () => {
		const dest = await makeTree();

		const result = await runCli(
			[
				"init",
				"--plugin",
				"--project",
				PROJECT,
				"--tool",
				"claude-code",
				"--dest",
				dest,
			],
			["--format", "json"],
		);

		const report = JSON.parse(result.stdout);
		expect(report).toMatchObject({
			projectId: PROJECT,
			mode: "plugin",
			memory: "ready",
			tools: [{ tool: "claude-code" }],
			pluginApproval: { kind: "manual" },
		});
	});

	it("tells a sign-in without the memory permission to sign in again", async () => {
		const dest = await makeTree();
		const { FabricError } = await import("@fabricorg/sdk");
		mocks.getTargets.mockRejectedValue(
			new FabricError(
				"Missing required scope: memory:write",
				403,
				"MISSING_SCOPE",
			),
		);

		const result = await runCli([
			"init",
			"--plugin",
			"--project",
			PROJECT,
			"--tool",
			"claude-code",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("memory permission");
		expect(result.stdout).toContain("auth login --project");
	});

	it("cannot be combined with the clone mode's options", async () => {
		const dest = await makeTree();
		for (const extra of [
			["--clone"],
			["--apply"],
			["--report-only"],
			["--lessons"],
		]) {
			const result = await runCli([
				"init",
				"--plugin",
				"--project",
				PROJECT,
				"--dest",
				dest,
				...extra,
			]);

			expect(result.code, extra.join(" ")).toBe(2);
			expect(result.stderr).toContain("--plugin");
		}
		await expect(stat(path.join(dest, ".claude"))).rejects.toThrow();
	});

	describe("with Claude Code on the machine", () => {
		function claudeCalls(): string[][] {
			return mocks.run.mock.calls.map((call) => [
				...(call[1] as string[]),
			]);
		}

		beforeEach(() => {
			mocks.run.mockResolvedValue({
				kind: "exited",
				code: 0,
				stdout: "",
				stderr: "",
			});
		});

		it("registers the marketplace folder with Claude Code, then leaves the one approval line", async () => {
			const dest = await makeTree();

			const result = await runCli(
				[
					"init",
					"--project",
					PROJECT,
					"--tool",
					"claude-code",
					"--dest",
					dest,
				],
				[],
				{ bare: true },
			);

			const folder = path
				.join(config, "cache", "marketplaces", "fabric-0project")
				.replaceAll("\\", "/");
			expect(claudeCalls()).toContainEqual([
				"plugin",
				"marketplace",
				"add",
				folder,
				"--scope",
				"local",
			]);
			expect(result.stdout).toContain(
				"claude plugin install fabric-0project@fabric-0project --scope local",
			);
			expect(result.stdout).not.toContain(
				"claude plugin marketplace add",
			);
		});

		it("does not register the gateway a second time: the plugin carries it", async () => {
			const dest = await makeTree();

			await runCli(
				[
					"init",
					"--project",
					PROJECT,
					"--tool",
					"claude-code",
					"--dest",
					dest,
				],
				[],
				{ mcp: true, bare: true },
			);

			expect(
				claudeCalls().some(
					(args) => args[0] === "mcp" && args[1] === "add",
				),
			).toBe(false);
		});

		async function connectedBefore(
			dest: string,
			servers: Record<string, { type: string; url: string }>,
		): Promise<void> {
			await writeFile(
				path.join(home, ".claude.json"),
				JSON.stringify({
					projects: { [dest]: { mcpServers: servers } },
				}),
			);
		}

		it("removes the earlier local registration, by its exact name, and nothing else", async () => {
			const dest = await makeTree();
			const gateway = projectResource(
				"https://fabric.pro",
				"mcp",
				PROJECT,
			);
			await connectedBefore(await realpath(dest), {
				[SERVER]: { type: "http", url: gateway },
				"fabric-other": {
					type: "http",
					url: projectResource(
						"https://fabric.pro",
						"mcp",
						"cm0other0project",
					),
				},
				mine: { type: "http", url: "https://example.com/mcp" },
			});

			const result = await runCli(
				[
					"init",
					"--project",
					PROJECT,
					"--tool",
					"claude-code",
					"--dest",
					dest,
				],
				[],
				{ mcp: true, bare: true },
			);

			const removals = claudeCalls().filter(
				(args) => args[0] === "mcp" && args[1] === "remove",
			);
			expect(removals).toEqual([
				["mcp", "remove", SERVER, "--scope", "local"],
			]);
			expect(result.stdout).toContain(
				`Removed the earlier Claude Code registration ${SERVER}`,
			);
		});

		it("leaves an entry of that name alone when it points somewhere else", async () => {
			const dest = await makeTree();
			await connectedBefore(await realpath(dest), {
				[SERVER]: { type: "http", url: "https://example.com/mcp" },
			});

			await runCli(
				[
					"init",
					"--project",
					PROJECT,
					"--tool",
					"claude-code",
					"--dest",
					dest,
				],
				[],
				{ mcp: true, bare: true },
			);

			expect(
				claudeCalls().some(
					(args) => args[0] === "mcp" && args[1] === "remove",
				),
			).toBe(false);
		});

		it("keeps the earlier registration under --no-mcp", async () => {
			const dest = await makeTree();
			await connectedBefore(await realpath(dest), {
				[SERVER]: {
					type: "http",
					url: projectResource("https://fabric.pro", "mcp", PROJECT),
				},
			});

			await runCli(
				[
					"init",
					"--project",
					PROJECT,
					"--tool",
					"claude-code",
					"--dest",
					dest,
					"--no-mcp",
				],
				[],
				{ bare: true },
			);

			expect(claudeCalls().some((args) => args[0] === "mcp")).toBe(false);
		});
	});

	it("records the folder it ran in, and the git work tree around it, for the memory mirror", async () => {
		const dest = await makeTree();
		execFileSync("git", ["init", "-q"], { cwd: dest });

		await runCli(
			[
				"init",
				"--plugin",
				"--project",
				PROJECT,
				"--tool",
				"claude-code",
				"--dest",
				dest,
			],
			[],
			{ bare: true },
		);

		const marker = JSON.parse(
			await readFile(path.join(dest, ".fabric", "project.json"), "utf8"),
		);
		expect(marker).toMatchObject({ version: 1, projectId: PROJECT });
		expect(path.resolve(marker.gitToplevel).toLowerCase()).toBe(
			(await realpath(dest)).toLowerCase(),
		);
	});

	describe("without --plugin", () => {
		it("sets up the plugin in a folder that is not a clone of the instructions", async () => {
			const dest = await makeTree();

			const result = await runCli(
				[
					"init",
					"--project",
					PROJECT,
					"--tool",
					"claude-code",
					"--dest",
					dest,
				],
				[],
				{ bare: true },
			);

			expect(result.code).toBe(0);
			expect((await settings(dest)).enabledPlugins).toEqual({
				"fabric-0project@fabric-0project": true,
			});
			await expect(
				stat(path.join(dest, ".fabric", "instructions.lock")),
			).rejects.toThrow();
		});

		it("leaves the clone setup to --clone", async () => {
			const dest = await makeTree();

			const result = await runCli(
				[
					"init",
					"--clone",
					"--project",
					PROJECT,
					"--tool",
					"claude-code",
					"--dest",
					dest,
				],
				[],
				{ bare: true },
			);

			expect(result.stdout).not.toContain("as a plugin");
			await expect(
				stat(path.join(dest, ".fabric", "project.json")),
			).rejects.toThrow();
		});

		it("keeps the clone setup in a folder that already has the instructions' lock", async () => {
			const dest = await makeTree();
			await seedLock(dest, "digest-1", {}, PROJECT);

			const result = await runCli(
				[
					"init",
					"--project",
					PROJECT,
					"--tool",
					"claude-code",
					"--dest",
					dest,
				],
				[],
				{ bare: true },
			);

			expect(result.stdout).not.toContain("as a plugin");
			await expect(
				stat(path.join(dest, ".fabric", "project.json")),
			).rejects.toThrow();
		});
	});

	describe("for Codex", () => {
		it("lists a local plugin in the personal marketplace, keeping what was there", async () => {
			const dest = await makeTree();
			const marketplace = path.join(
				home,
				".agents",
				"plugins",
				"marketplace.json",
			);
			await mkdir(path.dirname(marketplace), { recursive: true });
			await writeFile(
				marketplace,
				JSON.stringify({
					name: "mine",
					plugins: [
						{
							name: "other",
							source: { source: "local", path: "./o" },
						},
					],
				}),
			);

			const result = await runCli([
				"init",
				"--plugin",
				"--project",
				PROJECT,
				"--tool",
				"codex",
				"--dest",
				dest,
			]);

			expect(result.code).toBe(0);
			const written = JSON.parse(await readFile(marketplace, "utf8"));
			expect(written.plugins.map((p: any) => p.name)).toEqual([
				"other",
				expect.stringMatching(/^fabric-/),
			]);
			const entry = written.plugins[1];
			expect(entry.source).toEqual({
				source: "local",
				path: `./.codex/plugins/${entry.name}`,
			});
			expect(
				(
					await stat(
						path.join(
							home,
							".codex",
							"plugins",
							entry.name,
							".codex-plugin",
							"plugin.json",
						),
					)
				).isFile(),
			).toBe(true);
		});

		it("re-renders at session start and flushes memory, since Codex has no Stop hook", async () => {
			const dest = await makeTree();

			await runCli([
				"init",
				"--plugin",
				"--project",
				PROJECT,
				"--tool",
				"codex",
				"--dest",
				dest,
			]);

			const hooks = JSON.parse(
				await readFile(path.join(dest, ".codex", "hooks.json"), "utf8"),
			);
			const start = hooks.hooks.SessionStart.flatMap((group: any) =>
				group.hooks.map((h: any) => h.command),
			);
			expect(start).toEqual([
				`fabric instructions render --project ${PROJECT} --target codex --base-url https://fabric.pro --hook`,
				`fabric memory pull --project ${PROJECT} --flush --base-url https://fabric.pro --hook`,
			]);
			expect(hooks.hooks.Stop).toBeUndefined();
		});

		it("writes a merged AGENTS.override.md, kept out of commits, because Codex cannot take it in a plugin", async () => {
			const dest = await makeTree();
			execFileSync("git", ["init", "-q"], { cwd: dest });
			await writeFile(path.join(dest, "AGENTS.md"), "tracked rules\n");

			await runCli([
				"init",
				"--plugin",
				"--project",
				PROJECT,
				"--tool",
				"codex",
				"--dest",
				dest,
			]);

			const override = await readFile(
				path.join(dest, "AGENTS.override.md"),
				"utf8",
			);
			expect(override.indexOf("tracked rules")).toBeLessThan(
				override.indexOf("Use the tools."),
			);
			const status = execFileSync("git", ["status", "--porcelain"], {
				cwd: dest,
				encoding: "utf8",
			});
			expect(status).toContain("AGENTS.md");
			expect(status).not.toContain("AGENTS.override.md");
			expect(status).not.toContain(".codex");
		});

		it("puts the project's rules after the memory file in AGENTS.override.md, with scopes noted, and no rules folder", async () => {
			serveRepository({
				...FILES,
				"rules/api.md":
					"---\npaths:\n  - src/**\n---\nValidate input.\n",
				"rules/style.md": "Use tabs.\n",
			});
			const dest = await makeTree();

			await runCli([
				"init",
				"--plugin",
				"--project",
				PROJECT,
				"--tool",
				"codex",
				"--dest",
				dest,
			]);

			const override = await readFile(
				path.join(dest, "AGENTS.override.md"),
				"utf8",
			);
			expect(override.indexOf("Use the tools.")).toBeLessThan(
				override.indexOf("## Project rules"),
			);
			expect(override).toContain("### Rule: api.md");
			expect(override).toContain("Applies when working on: src/**");
			expect(override).toContain("Validate input.");
			expect(override).toContain("### Rule: style.md\nUse tabs.");
			await expect(
				stat(path.join(dest, ".claude", "rules")),
			).rejects.toThrow();
		});

		describe("installing the plugin in Codex", () => {
			const initCodex = async () =>
				runCli([
					"init",
					"--plugin",
					"--project",
					PROJECT,
					"--tool",
					"codex",
					"--dest",
					await makeTree(),
				]);

			it("runs codex plugin add and says the plugin is installed", async () => {
				mocks.run.mockResolvedValue({
					kind: "exited",
					code: 0,
					stdout: "",
					stderr: "",
				});

				const result = await initCodex();

				expect(result.code).toBe(0);
				expect(mocks.run).toHaveBeenCalledWith(
					"codex",
					["plugin", "add", "fabric-0project@personal"],
					expect.objectContaining({ timeoutMs: 120_000 }),
				);
				expect(result.stdout).toContain(
					"Installed the fabric-0project plugin in Codex.",
				);
				expect(result.stdout).not.toContain("plugin browser");
			});

			it("prints the exact command, with the marketplace's own name, when codex cannot install it", async () => {
				const file = path.join(
					home,
					".agents",
					"plugins",
					"marketplace.json",
				);
				await mkdir(path.dirname(file), { recursive: true });
				await writeFile(
					file,
					JSON.stringify({ name: "mine", plugins: [] }),
				);
				mocks.run.mockResolvedValue({ kind: "missing" });

				const result = await initCodex();

				expect(result.code).toBe(0);
				expect(result.stdout).toContain(
					"Run: codex plugin add fabric-0project@mine",
				);
				expect(result.stdout).not.toContain("Installed the");
			});

			it("prints the command when codex exits with an error", async () => {
				mocks.run.mockResolvedValue({
					kind: "exited",
					code: 1,
					stdout: "",
					stderr: "no",
				});

				const result = await initCodex();

				expect(result.stdout).toContain(
					"Run: codex plugin add fabric-0project@personal",
				);
			});
		});

		it("writes instruction access guidance when the instructions have no root text", async () => {
			serveRepository({ ".claude/agents/reviewer.md": "reviewer\n" });
			const dest = await makeTree();

			await runCli([
				"init",
				"--plugin",
				"--project",
				PROJECT,
				"--tool",
				"codex",
				"--dest",
				dest,
			]);

			const override = await readFile(
				path.join(dest, "AGENTS.override.md"),
				"utf8",
			);
			expect(override).toContain("plugin fabric-0project");
			expect(override).toContain("fabric-instruction-access");
		});
	});
});
