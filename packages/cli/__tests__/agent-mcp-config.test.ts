/**
 * What `doctor` can say about a coding tool's registration of a project's
 * Fabric MCP server comes only from the tool's own files, so these tests write
 * those files, in the forms the tools write them, into a home folder of their
 * own and read them back through the module that `doctor` uses.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentRegistrationFacts } from "../src/lib/instructions/agent-mcp.js";
import {
	readClaudeServers,
	readCodexServers,
} from "../src/lib/instructions/agent-mcp-config.js";
import {
	inspectServers,
	registrationOf,
} from "../src/lib/instructions/agent-mcp-servers.js";
import {
	buildHookCommand,
	mergeSessionStartHook,
} from "../src/lib/instructions/hook.js";
import { resolveDestinationRoot } from "../src/lib/instructions/safe-write.js";

const ORIGIN = "https://deploy.example.com";
const PROJECT = "project-example-one";
const URL = `${ORIGIN}/api/mcp-gateway/projects/${PROJECT}`;
const OTHER_URL = `${ORIGIN}/api/mcp-gateway/projects/project-example-two`;

const folders: string[] = [];

/** What the tool's files say about the project's server, as `doctor` reads them. */
async function readRegistration(input: {
	tool: "claude-code" | "codex";
	name: string;
	url: string;
	cwd: string;
	home: string | null;
	env: Record<string, string | undefined>;
	platform: NodeJS.Platform;
}) {
	const inspected = await inspectServers({
		tool: input.tool,
		origin: ORIGIN,
		projectId: PROJECT,
		cwd: input.cwd,
		home: input.home,
		env: input.env,
		platform: input.platform,
	});
	if (inspected.state !== "read") {
		return inspected.state === "unlocated" ? "missing" : "unreadable";
	}
	return registrationOf(inspected.servers, input.name).state;
}

async function folder(label: string): Promise<string> {
	const made = await mkdtemp(
		path.join(tmpdir(), `fabric-mcp-config-${label}-`),
	);
	folders.push(made);
	return made;
}

afterEach(async () => {
	for (const made of folders.splice(0)) {
		await rm(made, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

async function claudeFiles(options: {
	claudeJson?: unknown;
	mcpJson?: unknown;
	raw?: string;
}): Promise<{ home: string; cwd: string }> {
	const home = await folder("home");
	const cwd = await folder("checkout");
	if (options.raw !== undefined) {
		await writeFile(path.join(home, ".claude.json"), options.raw);
	} else if (options.claudeJson !== undefined) {
		await writeFile(
			path.join(home, ".claude.json"),
			JSON.stringify(options.claudeJson),
		);
	}
	if (options.mcpJson !== undefined) {
		await writeFile(
			path.join(cwd, ".mcp.json"),
			JSON.stringify(options.mcpJson),
		);
	}
	return { home, cwd };
}

function readClaude(
	where: { home: string | null; cwd: string },
	env: Record<string, string | undefined> = {},
	platform: NodeJS.Platform = process.platform,
) {
	return readRegistration({
		tool: "claude-code",
		name: "fabric",
		url: URL,
		cwd: where.cwd,
		home: where.home,
		env,
		platform,
	});
}

describe("readRegistration for Claude Code", () => {
	it("finds the server in the checkout's own (local) scope", async () => {
		const cwd = await folder("checkout");
		const home = await folder("home");
		await writeFile(
			path.join(home, ".claude.json"),
			JSON.stringify({
				projects: {
					[cwd]: {
						mcpServers: { fabric: { type: "http", url: URL } },
					},
				},
			}),
		);

		expect(await readClaude({ home, cwd })).toBe("registered");
	});

	it("finds a local scope that Claude Code keyed with forward slashes", async () => {
		const cwd = await folder("checkout");
		const home = await folder("home");
		await writeFile(
			path.join(home, ".claude.json"),
			JSON.stringify({
				projects: {
					[cwd.replace(/\\/g, "/")]: {
						mcpServers: { fabric: { type: "http", url: URL } },
					},
				},
			}),
		);

		expect(await readClaude({ home, cwd })).toBe("registered");
	});

	it("matches a Windows folder whatever the case of its drive and path", async () => {
		const { home } = await claudeFiles({
			claudeJson: {
				projects: {
					"D:/Work/Checkout": {
						mcpServers: { fabric: { type: "http", url: URL } },
					},
				},
			},
		});

		const state = await readClaude(
			{ home, cwd: "d:\\work\\checkout\\" },
			{},
			"win32",
		);

		expect(state).toBe("registered");
	});

	it("does not take another checkout's local server for this one's", async () => {
		const { home, cwd } = await claudeFiles({
			claudeJson: {
				projects: {
					"/somewhere/else": {
						mcpServers: { fabric: { type: "http", url: URL } },
					},
				},
			},
		});

		expect(await readClaude({ home, cwd })).toBe("missing");
	});

	it("finds the server in the user scope", async () => {
		const { home, cwd } = await claudeFiles({
			claudeJson: { mcpServers: { fabric: { type: "http", url: URL } } },
		});

		expect(await readClaude({ home, cwd })).toBe("registered");
	});

	it("finds the server in the checkout's .mcp.json", async () => {
		const { home, cwd } = await claudeFiles({
			claudeJson: {},
			mcpJson: { mcpServers: { fabric: { type: "http", url: URL } } },
		});

		expect(await readClaude({ home, cwd })).toBe("registered");
	});

	it("finds .mcp.json when the user has no .claude.json at all", async () => {
		const { home, cwd } = await claudeFiles({
			mcpJson: { mcpServers: { fabric: { type: "http", url: URL } } },
		});

		expect(await readClaude({ home, cwd })).toBe("registered");
	});

	it("says the name is registered elsewhere when it points at another URL", async () => {
		const { home, cwd } = await claudeFiles({
			claudeJson: {
				mcpServers: { fabric: { type: "http", url: OTHER_URL } },
			},
		});

		expect(await readClaude({ home, cwd })).toBe("elsewhere");
	});

	it("counts one scope that has the right URL even when another has a different one", async () => {
		const { home, cwd } = await claudeFiles({
			claudeJson: {
				mcpServers: { fabric: { type: "http", url: OTHER_URL } },
			},
			mcpJson: { mcpServers: { fabric: { type: "http", url: URL } } },
		});

		expect(await readClaude({ home, cwd })).toBe("registered");
	});

	it("counts a server of another name at the project's gateway as registered", async () => {
		const { home, cwd } = await claudeFiles({
			claudeJson: { mcpServers: { docs: { type: "http", url: URL } } },
		});

		expect(await readClaude({ home, cwd })).toBe("registered");
	});

	it("ignores a server of another name that points elsewhere", async () => {
		const { home, cwd } = await claudeFiles({
			claudeJson: {
				mcpServers: { docs: { type: "http", url: OTHER_URL } },
			},
		});

		expect(await readClaude({ home, cwd })).toBe("missing");
	});

	it("says missing when there is no file", async () => {
		const { home, cwd } = await claudeFiles({});

		expect(await readClaude({ home, cwd })).toBe("missing");
	});

	it("says missing when there is no home folder to look in", async () => {
		const cwd = await folder("checkout");

		expect(await readClaude({ home: null, cwd })).toBe("missing");
	});

	it("reads CLAUDE_CONFIG_DIR instead of the home folder when it is set", async () => {
		const { home, cwd } = await claudeFiles({});
		const custom = await folder("custom");
		await writeFile(
			path.join(custom, ".claude.json"),
			JSON.stringify({
				mcpServers: { fabric: { type: "http", url: URL } },
			}),
		);

		expect(
			await readClaude({ home, cwd }, { CLAUDE_CONFIG_DIR: custom }),
		).toBe("registered");
	});

	it("says unreadable for a file that is not JSON, and shows nothing of it", async () => {
		const { home, cwd } = await claudeFiles({
			raw: "{ not json, token=abc",
		});

		expect(await readClaude({ home, cwd })).toBe("unreadable");
	});

	it("says unreadable when the path is a folder", async () => {
		const home = await folder("home");
		const cwd = await folder("checkout");
		await mkdir(path.join(home, ".claude.json"));

		expect(await readClaude({ home, cwd })).toBe("unreadable");
	});

	it("does not take a name from an object's prototype", async () => {
		const { home, cwd } = await claudeFiles({
			claudeJson: { mcpServers: {} },
		});

		const state = await readRegistration({
			tool: "claude-code",
			name: "constructor",
			url: URL,
			cwd,
			home,
			env: {},
			platform: process.platform,
		});

		expect(state).toBe("missing");
	});
});

async function codexHome(toml: string | null): Promise<string> {
	const home = await folder("codex");
	if (toml !== null) {
		await writeFile(path.join(home, "config.toml"), toml);
	}
	return home;
}

async function readCodex(
	home: string,
	name = "fabric-pleone",
	env: Record<string, string | undefined> = { CODEX_HOME: home },
) {
	return readRegistration({
		tool: "codex",
		name,
		url: URL,
		cwd: home,
		home: null,
		env,
		platform: process.platform,
	});
}

describe("readRegistration for Codex", () => {
	it("finds a server at the project's gateway under the name init uses", async () => {
		const home = await codexHome(
			`model = "gpt"\n\n[mcp_servers.fabric-pleone]\nurl = "${URL}"\n`,
		);

		expect(await readCodex(home)).toBe("registered");
	});

	it("finds a server at the project's gateway under any other name", async () => {
		const home = await codexHome(
			`[mcp_servers.my-fabric]\nurl = "${URL}"\n`,
		);

		expect(await readCodex(home)).toBe("registered");
	});

	it.each([
		[
			"a quoted name",
			(url: string) => `[mcp_servers."fabric-pleone"]\nurl = "${url}"\n`,
		],
		[
			"a single-quoted name",
			(url: string) => `[mcp_servers.'fabric-pleone']\nurl = '${url}'\n`,
		],
		[
			"a trailing comment",
			(url: string) =>
				`[mcp_servers.fabric-pleone] # ours\nurl = "${url}" # here\n`,
		],
		[
			"Windows line endings",
			(url: string) =>
				`[mcp_servers.fabric-pleone]\r\nurl = "${url}"\r\n`,
		],
	])("reads %s", async (_label, toml) => {
		const home = await codexHome(toml(URL));

		expect(await readCodex(home)).toBe("registered");
	});

	it("says the name is registered elsewhere when it points at another URL", async () => {
		const home = await codexHome(
			`[mcp_servers.fabric-pleone]\nurl = "${OTHER_URL}"\n`,
		);

		expect(await readCodex(home)).toBe("elsewhere");
	});

	it("takes a url that belongs to another table for no server's", async () => {
		const home = await codexHome(
			`[profiles.work]\nurl = "${URL}"\n\n[mcp_servers.docs]\ncommand = "npx"\n`,
		);

		expect(await readCodex(home)).toBe("missing");
	});

	it("says missing for a file without the server, and for no file", async () => {
		const without = await codexHome(
			`[mcp_servers.docs]\nurl = "https://docs.example.net/mcp"\n`,
		);
		const none = await codexHome(null);

		expect(await readCodex(without)).toBe("missing");
		expect(await readCodex(none)).toBe("missing");
	});

	it("looks in ~/.codex when CODEX_HOME is not set", async () => {
		const home = await folder("userhome");
		await mkdir(path.join(home, ".codex"));
		await writeFile(
			path.join(home, ".codex", "config.toml"),
			`[mcp_servers.fabric-pleone]\nurl = "${URL}"\n`,
		);

		const state = await readRegistration({
			tool: "codex",
			name: "fabric-pleone",
			url: URL,
			cwd: home,
			home,
			env: {},
			platform: process.platform,
		});

		expect(state).toBe("registered");
	});

	it("says unreadable when the path is a folder", async () => {
		const home = await folder("codex");
		await mkdir(path.join(home, "config.toml"));

		expect(await readCodex(home)).toBe("unreadable");
	});
});

describe("agentRegistrationFacts", () => {
	async function checkout(tools: Array<"claude-code" | "codex">) {
		const root = await resolveDestinationRoot(await folder("repo"));
		for (const tool of tools) {
			await mergeSessionStartHook({
				root,
				projectId: PROJECT,
				command: buildHookCommand(PROJECT, false, undefined, {
					baseUrl: ORIGIN,
				}),
				tool,
			});
		}
		return root;
	}

	function facts(root: string, home: string, codex: string) {
		return agentRegistrationFacts({
			root,
			cwd: root,
			projectId: PROJECT,
			origin: ORIGIN,
			home,
			env: { CODEX_HOME: codex },
			platform: process.platform,
		});
	}

	it("reports only the tools this project's hook is installed for", async () => {
		const root = await checkout(["codex"]);
		const home = await folder("home");
		const codex = await codexHome(
			`[mcp_servers.fabric-pleone]\nurl = "${URL}"\n`,
		);

		const found = await facts(root, home, codex);

		expect(found).toEqual([
			{
				tool: "codex",
				name: "fabric-pleone",
				state: "registered",
				registerLine: `codex mcp add fabric-pleone --url ${URL}`,
				projectServers: ["fabric-pleone"],
				orgWide: [],
				foreignSameName: false,
			},
		]);
	});

	it("reports a missing registration for each tool with a hook, with the line that fixes it", async () => {
		const root = await checkout(["claude-code", "codex"]);
		const home = await folder("home");
		const codex = await codexHome(null);

		const found = await facts(root, home, codex);

		expect(found).toEqual([
			{
				tool: "claude-code",
				name: "fabric-pleone",
				state: "missing",
				registerLine: `claude mcp add --scope local --transport http fabric-pleone ${URL}`,
				projectServers: [],
				orgWide: [],
				foreignSameName: false,
			},
			{
				tool: "codex",
				name: "fabric-pleone",
				state: "missing",
				registerLine: `codex mcp add fabric-pleone --url ${URL}`,
				projectServers: [],
				orgWide: [],
				foreignSameName: false,
			},
		]);
	});

	it("reports nothing for a checkout with no hook", async () => {
		const root = await checkout([]);
		const home = await folder("home");
		const codex = await codexHome(null);

		expect(await facts(root, home, codex)).toEqual([]);
	});

	it("offers no line to register by hand for an address a command cannot carry, and does not repeat it", async () => {
		const root = await checkout(["claude-code", "codex"]);
		const home = await folder("home");
		const codex = await codexHome(null);
		const address = "https://a.example.com$(id).x";

		const found = await agentRegistrationFacts({
			root,
			cwd: root,
			projectId: PROJECT,
			origin: address,
			home,
			env: { CODEX_HOME: codex },
			platform: process.platform,
		});

		expect(found.map((fact) => fact.registerLine)).toEqual([null, null]);
		expect(found.map((fact) => fact.state)).toEqual(["missing", "missing"]);
		expect(JSON.stringify(found)).not.toContain("a.example.com");
	});
});

describe("readClaudeServers", () => {
	it("lists every server in each scope, whatever it is named, with its URL when it has one", async () => {
		const { home, cwd } = await claudeFiles({
			mcpJson: {
				mcpServers: { fabric: { type: "http", url: OTHER_URL } },
			},
		});
		await writeFile(
			path.join(home, ".claude.json"),
			JSON.stringify({
				projects: {
					[cwd.replace(/\\/g, "/")]: {
						mcpServers: {
							fabric: { type: "http", url: URL },
							docs: { type: "http", url: OTHER_URL },
						},
					},
				},
				mcpServers: {
					fabric: {
						type: "stdio",
						command: "npx",
						args: ["-y", "x"],
					},
				},
			}),
		);

		const read = await readClaudeServers({
			cwd,
			home,
			env: {},
			platform: process.platform,
		});

		expect(read).toEqual({
			state: "read",
			servers: [
				{ name: "fabric", scope: "local", url: URL },
				{ name: "docs", scope: "local", url: OTHER_URL },
				{ name: "fabric", scope: "user", url: null },
				{ name: "fabric", scope: "project", url: OTHER_URL },
			],
		});
	});

	it("sees a repository's own server that runs a command, as data, without anything being started", async () => {
		const { home, cwd } = await claudeFiles({
			mcpJson: {
				mcpServers: {
					fabric: {
						type: "stdio",
						command: "node",
						args: ["steal.js"],
					},
				},
			},
		});

		const read = await readClaudeServers({
			cwd,
			home,
			env: {},
			platform: process.platform,
		});

		expect(read).toEqual({
			state: "read",
			servers: [{ name: "fabric", scope: "project", url: null }],
		});
	});

	it("finds nothing, and says so, when there is no file", async () => {
		const { home, cwd } = await claudeFiles({});

		expect(
			await readClaudeServers({
				cwd,
				home,
				env: {},
				platform: process.platform,
			}),
		).toEqual({ state: "read", servers: [] });
	});

	it("is unreadable for a file that is not JSON, and unlocated with no home to look in", async () => {
		const unreadable = await claudeFiles({ raw: "{ nope" });
		const cwd = await folder("checkout");

		expect(
			await readClaudeServers({
				cwd: unreadable.cwd,
				home: unreadable.home,
				env: {},
				platform: process.platform,
			}),
		).toEqual({ state: "unreadable" });
		expect(
			await readClaudeServers({
				cwd,
				home: null,
				env: {},
				platform: process.platform,
			}),
		).toEqual({ state: "unlocated" });
	});

	it("counts a server of the name that runs a command as registered elsewhere", async () => {
		const { home, cwd } = await claudeFiles({
			claudeJson: {
				mcpServers: { fabric: { type: "stdio", command: "npx" } },
			},
		});

		expect(await readClaude({ home, cwd })).toBe("elsewhere");
	});
});

describe("readCodexServers", () => {
	it("lists every server by name, with its URL when it has one", async () => {
		const home = await codexHome(
			`model = "gpt"\n\n[mcp_servers.fabric-pleone]\nurl = "${URL}"\n\n[mcp_servers.docs]\ncommand = "npx"\n\n[mcp_servers."with space"]\nurl = '${OTHER_URL}'\n`,
		);

		expect(
			await readCodexServers({ home: null, env: { CODEX_HOME: home } }),
		).toEqual({
			state: "read",
			servers: [
				{ name: "fabric-pleone", url: URL },
				{ name: "docs", url: null },
				{ name: "with space", url: OTHER_URL },
			],
		});
	});

	it("keeps a server's own sub-tables from being servers, or from giving it a URL", async () => {
		const home = await codexHome(
			`[mcp_servers.docs]\ncommand = "npx"\n\n[mcp_servers.docs.env]\nurl = "${URL}"\n\n[mcp_servers.docs.http_headers]\nAuthorization = "x"\n`,
		);

		expect(
			await readCodexServers({ home: null, env: { CODEX_HOME: home } }),
		).toEqual({
			state: "read",
			servers: [{ name: "docs", url: null }],
		});
	});

	it.each([
		["an inline table", `mcp_servers = { docs = { url = "${URL}" } }\n`],
		["a dotted key", `mcp_servers.docs.url = "${URL}"\n`],
		["a table of all of them", "[mcp_servers]\n"],
		[
			"a table spelled with spaces",
			`[ mcp_servers . docs ]\nurl = "${URL}"\n`,
		],
		["an array of tables", '[[mcp_servers]]\nname = "docs"\n'],
	])(
		"will not read a file that writes a server as %s",
		async (_label, toml) => {
			const home = await codexHome(`model = "gpt"\n${toml}`);

			expect(
				await readCodexServers({
					home: null,
					env: { CODEX_HOME: home },
				}),
			).toEqual({
				state: "unreadable",
			});
			expect(await readCodex(home)).toBe("unreadable");
		},
	);

	it("finds nothing when there is no file, and nowhere to look with no home", async () => {
		const none = await codexHome(null);

		expect(
			await readCodexServers({ home: null, env: { CODEX_HOME: none } }),
		).toEqual({
			state: "read",
			servers: [],
		});
		expect(await readCodexServers({ home: null, env: {} })).toEqual({
			state: "unlocated",
		});
	});
});
