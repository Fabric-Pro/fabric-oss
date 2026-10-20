import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CliFailure } from "../src/lib/command-boundary.js";
import { resolveDestinationRoot } from "../src/lib/instructions/safe-write.js";
import { pathAsCommandWord } from "../src/lib/launcher.js";
import {
	claudeApprovalCommands,
	claudeMarketplaceDirectory,
	commandLineProblem,
	pluginIdFor,
	registerClaudePlugin,
	registerCodexPlugin,
	renderCommandLine,
	withClaudePlugin,
	withCodexPlugin,
	writeAgentsOverride,
	writeClaudeMarketplace,
} from "../src/lib/plugin/register.js";

const PROJECT = "cmexampleproject0123456789";
const ORIGIN = "https://example.com";

let directory: string;
let root: string;

beforeEach(async () => {
	directory = await mkdtemp(path.join(tmpdir(), "fabric-register-"));
	root = await resolveDestinationRoot(path.join(directory, "project"));
	await mkdir(root, { recursive: true });
});

afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

async function json(file: string): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(file, "utf8"));
}

describe("the render command line", () => {
	it("names node by its absolute path and the kept copy of the CLI", () => {
		const command = renderCommandLine({
			launcherPrefix:
				'node "/home/dev/.config/fabric/cli/example/fabric.mjs"',
			nodeWord: "/usr/bin/node",
			projectId: PROJECT,
			baseUrl: "https://example.com",
		});

		expect(command).toBe(
			`/usr/bin/node "/home/dev/.config/fabric/cli/example/fabric.mjs" instructions render --project ${PROJECT} --base-url https://example.com`,
		);
	});

	it("starts fabric by name when the CLI is installed, not a kept copy", () => {
		expect(
			renderCommandLine({
				launcherPrefix: "fabric",
				nodeWord: "/usr/bin/node",
				projectId: PROJECT,
			}),
		).toBe(`fabric instructions render --project ${PROJECT}`);
	});

	it("carries the organization when one was named", () => {
		expect(
			renderCommandLine({
				launcherPrefix: "fabric",
				nodeWord: null,
				projectId: PROJECT,
				org: "example-org",
			}),
		).toContain(" --org example-org");
	});

	it("quotes a path with a space and uses forward slashes on Windows", () => {
		const node = pathAsCommandWord(
			"C:\\Program Files\\nodejs\\node.exe",
			"win32",
		);
		const copy = pathAsCommandWord(
			"C:\\Users\\Example Dev\\AppData\\Roaming\\fabric\\cli\\example\\fabric.mjs",
			"win32",
		);

		const command = renderCommandLine({
			launcherPrefix: `node ${copy}`,
			nodeWord: node,
			projectId: PROJECT,
		});

		expect(command).toBe(
			`"C:/Program Files/nodejs/node.exe" "C:/Users/Example Dev/AppData/Roaming/fabric/cli/example/fabric.mjs" instructions render --project ${PROJECT}`,
		);
		expect(commandLineProblem(command)).toBeNull();
	});

	it("refuses a command Claude Code would refuse, with a way out", () => {
		expect(() =>
			renderCommandLine({
				launcherPrefix: `node "/home/dévéloppeur/fabric.mjs"`,
				nodeWord: null,
				projectId: PROJECT,
			}),
		).toThrow(CliFailure);
		expect(() =>
			renderCommandLine({
				launcherPrefix: `node "/${"a".repeat(480)}/fabric.mjs"`,
				nodeWord: null,
				projectId: PROJECT,
			}),
		).toThrow(/XDG_CONFIG_HOME/);
	});

	it.each([
		["a short ASCII line", "fabric instructions render --project a", null],
		["too long", `fabric ${"x".repeat(500)}`, "500"],
		["not ASCII", "fabric rendér", "ASCII"],
		["a run of four spaces", "fabric    render", "four or more spaces"],
		["a tab", "fabric\trender", "ASCII"],
		["three spaces", "fabric   render", null],
	])("%s", (_name, command, problem) => {
		const found = commandLineProblem(command);

		if (problem === null) {
			expect(found).toBeNull();
		} else {
			expect(found).toContain(problem);
		}
	});
});

describe("Claude Code's marketplace folder", () => {
	const command = `fabric instructions render --project ${PROJECT}`;

	it("holds one plugin with a command source, in the cache's marketplaces folder", async () => {
		const cache = path.join(directory, "cache");

		const folder = await writeClaudeMarketplace({
			cacheDirectory: cache,
			projectId: PROJECT,
			origin: ORIGIN,
			command,
		});

		expect(folder).toBe(
			path.join(cache, "marketplaces", "fabric-23456789"),
		);
		expect(folder).toBe(claudeMarketplaceDirectory(cache, PROJECT));
		expect(
			await json(path.join(folder, ".claude-plugin", "marketplace.json")),
		).toEqual({
			name: "fabric-23456789",
			owner: { name: "Fabric" },
			plugins: [
				{
					name: "fabric-23456789",
					description: `Coding instructions for Fabric project ${PROJECT} on example.com, rendered from its published instructions.`,
					source: {
						source: "command",
						command,
						mode: "copy",
						timeout: 120,
					},
				},
			],
		});
		expect(pluginIdFor(PROJECT)).toBe("fabric-23456789@fabric-23456789");
	});

	it("replaces the command when the launcher changes", async () => {
		const cache = path.join(directory, "cache");
		await writeClaudeMarketplace({
			cacheDirectory: cache,
			projectId: PROJECT,
			origin: ORIGIN,
			command,
		});

		const folder = await writeClaudeMarketplace({
			cacheDirectory: cache,
			projectId: PROJECT,
			origin: ORIGIN,
			command: `node /new/fabric.mjs instructions render --project ${PROJECT}`,
		});

		const text = await readFile(
			path.join(folder, ".claude-plugin", "marketplace.json"),
			"utf8",
		);
		expect(text).toContain("/new/fabric.mjs");
		expect(text).not.toContain(`"command": "${command}"`);
	});

	describe("binding to one project on one deployment", () => {
		const cache = () => path.join(directory, "cache");
		const OTHER_PROJECT = "cmotherproject0123456789";

		function write(overrides: { projectId?: string; origin?: string }) {
			return writeClaudeMarketplace({
				cacheDirectory: cache(),
				projectId: PROJECT,
				origin: ORIGIN,
				command,
				...overrides,
			});
		}

		it("records the project and deployment next to the marketplace file", async () => {
			const folder = await write({});

			expect(
				await json(path.join(folder, ".fabric-binding.json")),
			).toEqual({
				projectId: PROJECT,
				origin: ORIGIN,
			});
		});

		it("accepts the same project on the same deployment", async () => {
			await write({});

			await expect(write({})).resolves.toBeTypeOf("string");
		});

		it("refuses another project that has the same short name, and leaves the folder as it was", async () => {
			const folder = await write({});
			const before = await readFile(
				path.join(folder, ".claude-plugin", "marketplace.json"),
				"utf8",
			);

			const refused = expect(write({ projectId: `x${PROJECT}` })).rejects;

			await refused.toBeInstanceOf(CliFailure);
			await refused.toMatchObject({ exitCode: 7 });
			await refused.toThrow(
				new RegExp(
					`fabric-23456789 is already taken by project ${PROJECT} on ${ORIGIN}`,
				),
			);
			await refused.toThrow(
				"claude plugin uninstall fabric-23456789@fabric-23456789",
			);
			expect(
				await readFile(
					path.join(folder, ".claude-plugin", "marketplace.json"),
					"utf8",
				),
			).toBe(before);
		});

		it("refuses the same project on another deployment", async () => {
			await write({});

			await expect(
				write({ origin: "https://other.example.org" }),
			).rejects.toThrow(
				/already taken by project .* on https:\/\/example.com/,
			);
		});

		it("reads the owner of a folder written before the binding file existed, and refuses a different project", async () => {
			const folder = claudeMarketplaceDirectory(cache(), PROJECT);
			await mkdir(path.join(folder, ".claude-plugin"), {
				recursive: true,
			});
			await writeFile(
				path.join(folder, ".claude-plugin", "marketplace.json"),
				JSON.stringify({
					plugins: [
						{
							source: {
								command: `fabric instructions render --project ${OTHER_PROJECT} --base-url ${ORIGIN}`,
							},
						},
					],
				}),
			);

			await expect(write({})).rejects.toThrow(
				new RegExp(`already taken by project ${OTHER_PROJECT}`),
			);
		});

		it("refuses a legacy folder that names another deployment", async () => {
			const folder = claudeMarketplaceDirectory(cache(), PROJECT);
			await mkdir(path.join(folder, ".claude-plugin"), {
				recursive: true,
			});
			await writeFile(
				path.join(folder, ".claude-plugin", "marketplace.json"),
				JSON.stringify({
					plugins: [
						{
							source: {
								command: `fabric instructions render --project ${PROJECT} --base-url https://other.example.org`,
							},
						},
					],
				}),
			);

			await expect(write({})).rejects.toThrow(
				/on https:\/\/other.example.org/,
			);
		});

		it("takes over a legacy folder it cannot identify, and records the binding", async () => {
			const folder = claudeMarketplaceDirectory(cache(), PROJECT);
			await mkdir(path.join(folder, ".claude-plugin"), {
				recursive: true,
			});
			await writeFile(
				path.join(folder, ".claude-plugin", "marketplace.json"),
				"not json",
			);

			await write({});

			expect(
				await json(path.join(folder, ".fabric-binding.json")),
			).toEqual({
				projectId: PROJECT,
				origin: ORIGIN,
			});
		});

		it("accepts a legacy folder of the same project that names no deployment", async () => {
			const folder = claudeMarketplaceDirectory(cache(), PROJECT);
			await mkdir(path.join(folder, ".claude-plugin"), {
				recursive: true,
			});
			await writeFile(
				path.join(folder, ".claude-plugin", "marketplace.json"),
				JSON.stringify({
					plugins: [
						{
							source: {
								command: `fabric instructions render --project ${PROJECT}`,
							},
						},
					],
				}),
			);

			await expect(write({})).resolves.toBe(folder);
		});
	});

	it("names the two lines a person runs to register it and approve its command", () => {
		const lines = claudeApprovalCommands({
			projectId: PROJECT,
			marketplaceDirectory: "/cache/marketplaces/fabric-23456789",
		});

		expect(lines).toEqual({
			add: "claude plugin marketplace add /cache/marketplaces/fabric-23456789 --scope local",
			install:
				"claude plugin install fabric-23456789@fabric-23456789 --scope local",
		});
	});
});

describe("Claude Code's settings", () => {
	const marketplaceDirectory = path.join(
		"cache",
		"marketplaces",
		"fabric-23456789",
	);

	it("declares the marketplace folder as a directory source, and turns the plugin on", () => {
		const settings = withClaudePlugin({}, "settings.local.json", {
			projectId: PROJECT,
			marketplaceDirectory,
		});

		expect(settings).toEqual({
			extraKnownMarketplaces: {
				"fabric-23456789": {
					source: { source: "directory", path: marketplaceDirectory },
				},
			},
			enabledPlugins: { "fabric-23456789@fabric-23456789": true },
		});
	});

	it("keeps everything else in the file, and other plugins", () => {
		const settings = withClaudePlugin(
			{
				permissions: { allow: ["Bash(ls)"] },
				enabledPlugins: { "other@market": true },
				extraKnownMarketplaces: {
					market: { source: { source: "github" } },
				},
			},
			"settings.local.json",
			{ projectId: PROJECT, marketplaceDirectory },
		);

		expect(settings.permissions).toEqual({ allow: ["Bash(ls)"] });
		expect(settings.enabledPlugins).toMatchObject({
			"other@market": true,
			"fabric-23456789@fabric-23456789": true,
		});
		expect(Object.keys(settings.extraKnownMarketplaces as object)).toEqual([
			"market",
			"fabric-23456789",
		]);
	});

	it("refuses a settings file whose plugin keys are not objects, touching nothing", () => {
		expect(() =>
			withClaudePlugin({ enabledPlugins: [] }, "settings.local.json", {
				projectId: PROJECT,
				marketplaceDirectory,
			}),
		).toThrow(/not an object/);
	});

	it("writes the project's .claude/settings.local.json once and leaves a second run alone", async () => {
		const first = await registerClaudePlugin({
			root,
			projectId: PROJECT,
			marketplaceDirectory,
		});
		const file = path.join(root, ".claude", "settings.local.json");
		const written = await readFile(file, "utf8");
		const second = await registerClaudePlugin({
			root,
			projectId: PROJECT,
			marketplaceDirectory,
		});

		expect(first).toMatchObject({ createdFile: true, changed: true });
		expect(second).toMatchObject({ createdFile: false, changed: false });
		expect(await readFile(file, "utf8")).toBe(written);
		expect((await json(file)).enabledPlugins).toEqual({
			"fabric-23456789@fabric-23456789": true,
		});
	});

	it("keeps the developer's hooks", async () => {
		const file = path.join(root, ".claude", "settings.local.json");
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(
			file,
			JSON.stringify({
				hooks: {
					Stop: [
						{ hooks: [{ type: "command", command: "echo mine" }] },
					],
				},
			}),
		);

		await registerClaudePlugin({
			root,
			projectId: PROJECT,
			marketplaceDirectory,
		});

		expect(JSON.stringify((await json(file)).hooks)).toContain("echo mine");
	});

	it("leaves a file that is not JSON exactly as it was", async () => {
		const file = path.join(root, ".claude", "settings.local.json");
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(file, "{ half an edit");

		await expect(
			registerClaudePlugin({
				root,
				projectId: PROJECT,
				marketplaceDirectory,
			}),
		).rejects.toThrow(/not valid JSON/);
		expect(await readFile(file, "utf8")).toBe("{ half an edit");
	});
});

describe("the Codex personal marketplace", () => {
	const pluginDirectory = () =>
		path.join(directory, "home", ".codex", "plugins", "fabric-23456789");
	const marketplaceFile = () =>
		path.join(directory, "home", ".agents", "plugins", "marketplace.json");

	it("creates the file with a local entry relative to the home folder", async () => {
		const registration = await registerCodexPlugin({
			home: path.join(directory, "home"),
			projectId: PROJECT,
			pluginDirectory: pluginDirectory(),
		});

		expect(registration).toMatchObject({
			marketplaceName: "personal",
			changed: true,
		});
		const written = await json(marketplaceFile());
		expect(written.plugins).toEqual([
			{
				name: "fabric-23456789",
				source: {
					source: "local",
					path: "./.codex/plugins/fabric-23456789",
				},
				policy: {
					installation: "AVAILABLE",
					authentication: "ON_INSTALL",
				},
				category: "Coding",
			},
		]);
	});

	it("merges into a marketplace that lists other plugins, keeping them and the name", async () => {
		await mkdir(path.dirname(marketplaceFile()), { recursive: true });
		await writeFile(
			marketplaceFile(),
			JSON.stringify({
				name: "mine",
				interface: { displayName: "Mine" },
				plugins: [
					{
						name: "keep-me",
						source: { source: "local", path: "./x" },
					},
					{
						name: "fabric-23456789",
						source: { source: "local", path: "./stale" },
					},
				],
			}),
		);

		const registration = await registerCodexPlugin({
			home: path.join(directory, "home"),
			projectId: PROJECT,
			pluginDirectory: pluginDirectory(),
		});

		expect(registration.marketplaceName).toBe("mine");
		const written = await json(marketplaceFile());
		expect(
			(written.plugins as Array<{ name: string }>).map((p) => p.name),
		).toEqual(["keep-me", "fabric-23456789"]);
		expect(JSON.stringify(written)).not.toContain("./stale");
		expect(written.interface).toEqual({ displayName: "Mine" });
	});

	it("does not rewrite a file that already says the same", async () => {
		const input = {
			home: path.join(directory, "home"),
			projectId: PROJECT,
			pluginDirectory: pluginDirectory(),
		};
		await registerCodexPlugin(input);

		expect((await registerCodexPlugin(input)).changed).toBe(false);
	});

	it.each([
		["not JSON", "nope"],
		["not a marketplace", JSON.stringify({ hello: "world" })],
		[
			"plugins that are not objects",
			JSON.stringify({ name: "x", plugins: [1] }),
		],
	])("refuses a file that is %s and leaves it alone", async (_name, text) => {
		await mkdir(path.dirname(marketplaceFile()), { recursive: true });
		await writeFile(marketplaceFile(), text);

		await expect(
			registerCodexPlugin({
				home: path.join(directory, "home"),
				projectId: PROJECT,
				pluginDirectory: pluginDirectory(),
			}),
		).rejects.toThrow(CliFailure);
		expect(await readFile(marketplaceFile(), "utf8")).toBe(text);
	});

	it("adds an entry to an in-memory marketplace without touching the others", () => {
		const next = withCodexPlugin(
			{ name: "m", plugins: [{ name: "a" }] },
			{ name: "b", pluginPathFromHome: "./b" },
		);

		expect(next.plugins.map((plugin) => plugin.name)).toEqual(["a", "b"]);
	});
});

describe("AGENTS.override.md", () => {
	it("is the tracked AGENTS.md and then the instructions", async () => {
		await writeFile(path.join(root, "AGENTS.md"), "tracked rules\n");

		const result = await writeAgentsOverride({
			root,
			instructions: "plugin rules",
		});

		expect(result.kind).toBe("written");
		const text = await readFile(
			path.join(root, "AGENTS.override.md"),
			"utf8",
		);
		expect(text.indexOf("tracked rules")).toBeLessThan(
			text.indexOf("plugin rules"),
		);
	});

	it("is rewritten from the tracked file each time, so it does not grow", async () => {
		await writeFile(path.join(root, "AGENTS.md"), "tracked rules\n");
		await writeAgentsOverride({ root, instructions: "plugin rules" });
		const once = await readFile(
			path.join(root, "AGENTS.override.md"),
			"utf8",
		);

		const again = await writeAgentsOverride({
			root,
			instructions: "plugin rules",
		});
		await writeAgentsOverride({ root, instructions: "newer rules" });

		expect(again.kind).toBe("unchanged");
		const latest = await readFile(
			path.join(root, "AGENTS.override.md"),
			"utf8",
		);
		expect(latest.match(/tracked rules/g)).toHaveLength(1);
		expect(latest).toContain("newer rules");
		expect(latest).not.toContain("plugin rules");
		expect(once).toContain("plugin rules");
	});

	it("never replaces an override the developer wrote", async () => {
		await writeFile(path.join(root, "AGENTS.override.md"), "my own\n");

		const result = await writeAgentsOverride({
			root,
			instructions: "plugin rules",
		});

		expect(result.kind).toBe("left-alone");
		expect(
			await readFile(path.join(root, "AGENTS.override.md"), "utf8"),
		).toBe("my own\n");
	});

	it("writes nothing when the project's own AGENTS.md already says it", async () => {
		await writeFile(path.join(root, "AGENTS.md"), "same rules\n");

		const result = await writeAgentsOverride({
			root,
			instructions: "same rules",
		});

		expect(result.kind).toBe("unchanged");
		await expect(
			readFile(path.join(root, "AGENTS.override.md"), "utf8"),
		).rejects.toThrow();
	});
});
