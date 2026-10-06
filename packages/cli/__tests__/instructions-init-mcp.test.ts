/**
 * `fabric instructions init` registers the project's own MCP server with the
 * coding tool it sets up, and signs the tool in when a person is at the
 * terminal. The tools' command lines are the stand-ins from
 * `helpers/agent-tools.ts` behind a mocked runner, and what they already hold is
 * written as files into a home folder of the test's own, which is where `init`
 * reads it from. Nothing here reaches the machine's real Claude Code or Codex;
 * what is asserted is what `init` asked them and what it printed.
 */
import { access, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { machine } from "../src/lib/instructions/machine.js";
import { NO_LINE_FOR_ADDRESS } from "../src/lib/shell-words.js";
import {
	type Call,
	type ClaudeEntry,
	codexTable,
	removeToolFiles,
	SECRET,
	simulateAgentTools,
	type Tools,
	toolFiles,
	verbs,
	writeClaudeFiles,
	writeCodexConfig,
} from "./helpers/agent-tools.js";
import { fakeGit } from "./helpers/git-fake.js";
import {
	makeTree,
	resetInstructionsMocks,
	runCli,
} from "./helpers/instructions-commands.js";

const { mocks, agent } = vi.hoisted(() => ({
	mocks: {
		getPublished: vi.fn(),
		createDownloadUrl: vi.fn(),
		createFileDownloadUrls: vi.fn(),
		getApiKey: vi.fn<() => string | undefined>(),
		getConfigPath: vi.fn<() => string>(),
		getDefaultContext: vi.fn<() => unknown>(),
		withoutContext: vi.fn(),
		getClient: vi.fn(),
	},
	agent: { runner: vi.fn() },
}));

vi.mock("../src/lib/config.js", () => ({
	getApiKey: mocks.getApiKey,
	getOAuth: () => undefined,
	hasStoredApiKey: () => mocks.getApiKey() !== undefined,
	getConfigPath: mocks.getConfigPath,
	getBaseUrl: () => undefined,
	getDefaultContext: mocks.getDefaultContext,
	getOutputFormat: () => "table",
}));

vi.mock("../src/lib/instructions/git.js", async (importOriginal) => ({
	...(await importOriginal<object>()),
	...(await import("./helpers/git-fake.js")).gitFake,
}));

vi.mock("../src/lib/client.js", () => {
	const client = {
		instructions: {
			getPublished: mocks.getPublished,
			createDownloadUrl: mocks.createDownloadUrl,
			createFileDownloadUrls: mocks.createFileDownloadUrls,
		},
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

vi.mock("../src/lib/instructions/agent-run.js", () => ({
	createAgentRunner: () => agent.runner,
}));

const ORIGIN = "https://deploy.example.com";
const URL = `${ORIGIN}/api/mcp-gateway/projects/project-1`;
const OTHER_URL = `${ORIGIN}/api/mcp-gateway/projects/project-2`;
const ADD_CLAUDE = `claude mcp add --scope local --transport http fabric ${URL}`;

const TERMINAL_STREAMS = ["stdin", "stdout", "stderr"] as const;
const savedTerminal = new Map<string, PropertyDescriptor | undefined>();
let savedCi: string | undefined;

function atTerminal(): void {
	for (const name of TERMINAL_STREAMS) {
		savedTerminal.set(
			name,
			Object.getOwnPropertyDescriptor(process[name], "isTTY"),
		);
		Object.defineProperty(process[name], "isTTY", {
			value: true,
			configurable: true,
		});
	}
	delete process.env.CI;
}

beforeEach(() => {
	resetInstructionsMocks(mocks);
	fakeGit.reset();
	agent.runner.mockReset();
	savedCi = process.env.CI;
	mocks.getPublished.mockResolvedValue({
		published: false,
		sourceOfTruth: "UPLOAD",
	});
});

afterEach(async () => {
	for (const spy of machineSpies.splice(0)) {
		spy.mockRestore();
	}
	await removeToolFiles();
	for (const [name, descriptor] of savedTerminal) {
		const stream = process[name as (typeof TERMINAL_STREAMS)[number]];
		if (descriptor === undefined) {
			Reflect.deleteProperty(stream, "isTTY");
		} else {
			Object.defineProperty(stream, "isTTY", descriptor);
		}
	}
	savedTerminal.clear();
	if (savedCi === undefined) {
		delete process.env.CI;
	} else {
		process.env.CI = savedCi;
	}
	vi.unstubAllGlobals();
});

const machineSpies: Array<{ mockRestore: () => void }> = [];

interface State {
	/** What Claude Code's files hold under the name `fabric`, for the checkout. */
	claude?: ClaudeEntry[];
	/** What Codex's `config.toml` holds, as written. */
	codex?: string;
}

async function init(
	tools: Tools,
	extra: string[] = [],
	options: {
		tool?: string;
		globals?: string[];
		state?: State;
		origin?: string;
	} = {},
) {
	const dest = await makeTree();
	const files = await toolFiles();
	files.cwd = await realpath(dest);
	if (options.state?.claude !== undefined) {
		await writeClaudeFiles(files, options.state.claude);
	}
	if (options.state?.codex !== undefined) {
		await writeCodexConfig(files, options.state.codex);
	}
	machineSpies.push(
		vi.spyOn(machine, "home").mockReturnValue(files.home),
		vi.spyOn(machine, "env").mockReturnValue({}),
	);
	const simulated = simulateAgentTools(tools, files);
	agent.runner.mockImplementation(simulated.run);
	const result = await runCli(
		[
			"init",
			"--project",
			"project-1",
			"--tool",
			options.tool ?? "claude-code",
			"--base-url",
			options.origin ?? ORIGIN,
			"--dest",
			dest,
			...extra,
		],
		options.globals ?? [],
		{ mcp: true },
	);
	return { dest, result, calls: simulated.calls };
}

function sameFolder(actual: string, expected: string): boolean {
	return (
		path.resolve(actual).toLowerCase() ===
		path.resolve(expected).toLowerCase()
	);
}

function login(calls: readonly Call[]): Call | undefined {
	return calls.find((call) => call.args[1] === "login");
}

describe("fabric instructions init and the tool's MCP server", () => {
	it("registers the project's gateway with Claude Code in the checkout's own scope and says how to sign in", async () => {
		const { dest, result, calls } = await init({});

		expect(result.code).toBe(0);
		expect(verbs(calls)).toEqual(["claude mcp add"]);
		expect(`claude ${calls[0]?.args.join(" ")}`).toBe(ADD_CLAUDE);
		expect(sameFolder(calls[0]?.cwd ?? "", await realpath(dest))).toBe(
			true,
		);
		expect(result.stdout).toContain(
			'Registered the Fabric MCP server for Claude Code as "fabric".',
		);
		expect(result.stdout).toContain(
			"To finish, sign Claude Code in to it: claude mcp login fabric",
		);
		expect(
			result.stdout.indexOf("Registered the Fabric MCP server"),
		).toBeLessThan(result.stdout.indexOf("Set up."));
	});

	it("does not run Codex's add with nobody at the terminal, since it signs in as part of adding and would wait for a browser", async () => {
		const { result, calls } = await init({ codexAdd: "blocks" }, [], {
			tool: "codex",
		});

		expect(result.code).toBe(7);
		expect(calls).toEqual([]);
		expect(agent.runner).not.toHaveBeenCalled();
		expect(result.stdout).toContain(
			`Codex signs in as part of adding the Fabric MCP server, which opens your browser and waits for you, so init did not run it. Run: codex mcp add fabric-oject1 --url ${URL}`,
		);
		expect(result.stdout).not.toContain("Set up.");
		expect(result.stdout).toContain(
			"The session hook was set up, but the Fabric MCP server was not registered for every selected tool.",
		);
		expect(result.stderr).toContain("Coding tool setup is incomplete");
	});

	it("registers the project's gateway with Codex at a terminal, under the project's own name, with the terminal handed over", async () => {
		atTerminal();

		const { result, calls } = await init({}, [], { tool: "codex" });

		expect(result.code).toBe(0);
		expect(verbs(calls)).toEqual(["codex mcp add"]);
		expect(calls[0]).toMatchObject({
			args: ["mcp", "add", "fabric-oject1", "--url", URL],
			interactive: true,
		});
		expect(login(calls)).toBeUndefined();
		expect(result.stdout).toContain(
			'Registered the Fabric MCP server for Codex as "fabric-oject1".',
		);
		expect(result.stdout).not.toContain("To finish, sign");
	});

	it("still succeeds, saying Codex is registered and not signed in, when its add is cut off while it waits for the sign-in", async () => {
		atTerminal();

		const { result } = await init({ codexAdd: "blocks" }, [], {
			tool: "codex",
		});

		expect(result.code).toBe(0);
		expect(result.stdout).toContain(
			'Registered the Fabric MCP server for Codex as "fabric-oject1".',
		);
		expect(result.stdout).toContain(
			"The Codex sign-in did not finish. Run: codex mcp login fabric-oject1",
		);
		expect(result.stdout).not.toContain("Could not register");
		expect(result.stdout).toContain("Set up.");
	});

	it("says a Codex server that was registered before may not be signed in, and runs nothing", async () => {
		atTerminal();

		const { result, calls } = await init({}, [], {
			tool: "codex",
			state: { codex: codexTable("fabric-oject1", URL) },
		});

		expect(result.code).toBe(0);
		expect(calls).toEqual([]);
		expect(result.stdout).toContain(
			"The Fabric MCP server is already registered for Codex.",
		);
		expect(result.stdout).toContain(
			"If Codex has not signed in to it yet, run: codex mcp login fabric-oject1",
		);
	});

	it("does nothing the second time, when the same URL is already registered", async () => {
		const { result, calls } = await init({}, [], {
			state: { claude: [{ scope: "local", url: URL }] },
		});

		expect(result.code).toBe(0);
		expect(calls).toEqual([]);
		expect(result.stdout).toContain(
			"The Fabric MCP server is already registered for Claude Code.",
		);
		expect(result.stdout).not.toContain("To finish, sign");
	});

	it("replaces a server of ours for another project, and leaves another vendor's alone", async () => {
		const replaced = await init({}, [], {
			state: { claude: [{ scope: "local", url: OTHER_URL }] },
		});
		const left = await init({}, [], {
			state: {
				claude: [
					{
						scope: "local",
						url: "https://mcp.vendor.example.net/mcp",
					},
				],
			},
		});

		expect(verbs(replaced.calls)).toEqual([
			"claude mcp remove",
			"claude mcp add",
		]);
		expect(left.result.code).toBe(7);
		expect(left.calls).toEqual([]);
		expect(left.result.stdout).toContain(
			`Claude Code already has a server named "fabric" that is not a Fabric gateway, so it was left alone. Remove it, then run: ${ADD_CLAUDE}`,
		);
	});

	it("leaves the tools alone under --no-mcp", async () => {
		const { dest, result, calls } = await init({}, ["--no-mcp"]);

		expect(result.code).toBe(0);
		expect(calls).toEqual([]);
		expect(agent.runner).not.toHaveBeenCalled();
		expect(result.stdout).not.toContain("MCP server");
		await expect(
			access(path.join(dest, ".claude", "settings.local.json")),
		).resolves.toBeUndefined();
	});

	it("says the tool is not installed, with the line to run once it is, and still sets the hook up", async () => {
		const { dest, result } = await init({ claude: "missing" });

		expect(result.code).toBe(7);
		expect(result.stdout).toContain(
			`Skipped the Claude Code MCP server: claude is not on PATH. Once it is, run: ${ADD_CLAUDE}`,
		);
		expect(
			JSON.parse(
				await readFile(
					path.join(dest, ".claude", "settings.local.json"),
					"utf8",
				),
			).hooks.SessionStart,
		).toHaveLength(1);
	});

	it("reports incomplete setup, with the line to run, when the tool cannot register the server", async () => {
		const { dest, result } = await init({ claudeAdd: "fails" });

		expect(result.code).toBe(7);
		expect(result.stdout).toContain(
			`Could not register the Fabric MCP server for Claude Code. Run: ${ADD_CLAUDE}`,
		);
		await expect(
			access(path.join(dest, ".claude", "settings.local.json")),
		).resolves.toBeUndefined();
	});

	it("prints the sign-in line and runs nothing when no one is at the terminal", async () => {
		const { calls, result } = await init({});

		expect(login(calls)).toBeUndefined();
		expect(result.stdout).toContain(
			"To finish, sign Claude Code in to it: claude mcp login fabric",
		);
	});

	it("walks the tool through its own sign-in, with the terminal, when a person is there", async () => {
		atTerminal();

		const { result, calls } = await init({ login: "ok" });

		expect(result.code).toBe(0);
		expect(login(calls)).toMatchObject({
			command: "claude",
			args: ["mcp", "login", "fabric"],
			interactive: true,
			timeoutMs: 5 * 60_000,
		});
		expect(result.stdout).not.toContain("To finish, sign");
		expect(result.stdout).not.toContain("did not finish");
	});

	it("succeeds and prints the line to run by hand when the sign-in does not finish", async () => {
		atTerminal();

		const { result } = await init({ login: "fails" });

		expect(result.code).toBe(0);
		expect(result.stdout).toContain(
			"The Claude Code sign-in did not finish. Run: claude mcp login fabric",
		);
		expect(result.stdout).toContain("Set up.");
	});

	it("runs no sign-in in CI, even at a terminal", async () => {
		atTerminal();
		process.env.CI = "true";

		const { calls, result } = await init({ login: "ok" });

		expect(login(calls)).toBeUndefined();
		expect(result.stdout).toContain(
			"To finish, sign Claude Code in to it: claude mcp login fabric",
		);
	});

	it("reports the registration in the JSON output and runs no sign-in", async () => {
		atTerminal();

		const { result, calls } = await init({ login: "ok" }, [], {
			globals: ["--format", "json"],
		});

		expect(result.code).toBe(0);
		expect(login(calls)).toBeUndefined();
		const output = JSON.parse(result.stdout);
		expect(output.mcpRequested).toBe(true);
		expect(output.mcpComplete).toBe(true);
		expect(output.mcpAuthenticationPending).toBe(true);
		expect(output.mcp).toEqual([
			{
				tool: "claude-code",
				name: "fabric",
				url: URL,
				outcome: "registered",
				login: "printed",
				registerLine: ADD_CLAUDE,
				loginLine: "claude mcp login fabric",
			},
		]);
	});

	it("reports a Codex server left for the person to add as manual, with the line to run", async () => {
		atTerminal();

		const { result, calls } = await init({ codexAdd: "blocks" }, [], {
			tool: "codex",
			globals: ["--format", "json"],
		});

		expect(result.code).toBe(7);
		expect(calls).toEqual([]);
		expect(JSON.parse(result.stdout).mcp).toEqual([
			{
				tool: "codex",
				name: "fabric-oject1",
				url: URL,
				outcome: "manual",
				login: "unneeded",
				registerLine: `codex mcp add fabric-oject1 --url ${URL}`,
				loginLine: "codex mcp login fabric-oject1",
			},
		]);
	});

	it("prints nothing a tool said, including a header with a secret in it", async () => {
		const { result } = await init({}, [], {
			state: { claude: [{ scope: "local", url: OTHER_URL }] },
		});

		expect(result.stdout + result.stderr).not.toContain(SECRET);
		expect(result.stdout + result.stderr).not.toContain("Bearer");
	});

	it("never asks a tool what it holds, in a checkout whose own .mcp.json runs a command", async () => {
		const { result, calls } = await init({}, [], {
			state: { claude: [{ scope: "project", url: null }] },
		});

		expect(result.code).toBe(7);
		expect(calls).toEqual([]);
		expect(result.stdout).toContain(
			'Claude Code already has a server named "fabric" that is not a Fabric gateway, so it was left alone.',
		);
	});

	it("is told, not handed a line, when the deployment address cannot be written into a command", async () => {
		const { result, calls } = await init({}, [], {
			origin: "http://[::1]:3001",
		});

		expect(result.code).toBe(7);
		expect(verbs(calls)).toEqual(["claude mcp add"]);
		expect(result.stdout).toContain(
			`Could not register the Fabric MCP server for Claude Code. ${NO_LINE_FOR_ADDRESS}`,
		);
		expect(result.stdout).not.toContain("claude mcp add");
		expect(result.stdout).not.toContain("Set up.");
		expect(result.stderr).toContain("Coding tool setup is incomplete");
	});
});

describe("fabric instructions init and a deployment address a shell would read", () => {
	it.each([
		"https://a.example.com$(id).x",
		"https://a.example.com&calc.exe",
		"https://a.example.com;ls",
		"https://a.example.com`id`",
	])(
		"refuses %s before it writes a hook that would carry it",
		async (origin) => {
			const { dest, result, calls } = await init({}, [], { origin });

			expect(result.code).toBe(2);
			expect(result.stderr).toBe(
				"✗ The deployment address has characters a shell reads, so init will not write a session hook that carries it. Use an address of letters, digits, '.', '-' and a port.\n",
			);
			expect(calls).toEqual([]);
			await expect(
				access(path.join(dest, ".claude", "settings.local.json")),
			).rejects.toThrow();
			expect(mocks.getPublished).not.toHaveBeenCalled();
		},
	);

	it("still writes a hook for an address that is a plain host, a port, or a bracketed IPv6 one", async () => {
		for (const origin of [
			"http://localhost:3001",
			"https://deploy.example.com",
			"http://[::1]:3001",
		]) {
			const { dest, result } = await init({}, ["--no-mcp"], { origin });

			expect(result.code).toBe(0);
			await expect(
				access(path.join(dest, ".claude", "settings.local.json")),
			).resolves.toBeUndefined();
		}
	});
});
