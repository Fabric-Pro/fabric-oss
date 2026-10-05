/**
 * `createAgentRunner` is the only thing that starts a coding tool's command
 * line, so what it will and will not start is pinned against real child
 * processes: a stand-in `claude` and `codex` the test writes into a folder it
 * puts first on `PATH`. On Windows the stand-in is a `.cmd`, the form an npm
 * install of Codex takes, which is the case that needs the command interpreter.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import {
	access,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createAgentRunner,
	taskkillPath,
} from "../src/lib/instructions/agent-run.js";

const CLI_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const DRIVER = path.join(CLI_ROOT, "__tests__", "helpers", "runner-driver.ts");

// The setup file replaces the runner for every test; this file is about the
// real one. Hoisted above the import, like `vi.mock`.
vi.unmock("../src/lib/instructions/agent-run.js");

const FAKE_TOOL = `
const fs = require("node:fs");
const record = process.env.FAKE_TOOL_RECORD;
if (record) {
	fs.writeFileSync(
		record,
		JSON.stringify({
			pid: process.pid,
			args: process.argv.slice(2),
			cwd: process.cwd(),
			fabricVariables: Object.keys(process.env).filter((name) =>
				name.toUpperCase().startsWith("FABRIC_"),
			),
			other: process.env.FAKE_TOOL_OTHER ?? null,
		}),
	);
}
switch (process.env.FAKE_TOOL_BEHAVIOR) {
	case "fail":
		process.stderr.write("it went wrong");
		process.exitCode = 3;
		break;
	case "hang":
		setTimeout(() => {}, 20000);
		break;
	case "flood":
		process.stdout.write("x".repeat(1000000));
		break;
	default:
		process.stdout.write(process.env.FAKE_TOOL_STDOUT ?? "");
}
`;

interface Recorded {
	pid: number;
	args: string[];
	cwd: string;
	fabricVariables: string[];
	other: string | null;
}

const roots: string[] = [];

async function toolsFolder(
	name = "tools",
): Promise<{ root: string; bin: string }> {
	const root = await mkdtemp(path.join(tmpdir(), "fabric-agent-run-"));
	roots.push(root);
	const bin = path.join(root, name);
	await mkdir(bin);
	await writeFile(path.join(bin, "fake-tool.js"), FAKE_TOOL);
	for (const command of ["claude", "codex"]) {
		if (process.platform === "win32") {
			await writeFile(
				path.join(bin, `${command}.cmd`),
				`@"${process.execPath}" "%~dp0fake-tool.js" %*\r\n`,
			);
		} else {
			await writeFile(
				path.join(bin, command),
				`#!/bin/sh\nexec "${process.execPath}" "${path.join(bin, "fake-tool.js")}" "$@"\n`,
				{ mode: 0o755 },
			);
		}
	}
	return { root, bin };
}

/** What the orphaning `codex` leaves running: it notes its pid and waits. */
const SLEEPER = `
require("node:fs").writeFileSync(process.env.FAKE_TOOL_RECORD + ".grandchild", String(process.pid));
setTimeout(() => {}, 30000);
`;

/**
 * Make `codex` a shim that starts a process in the background and is gone at
 * once, the way a shim's tool outlives the shim: the process keeps the shim's
 * standard output and error open, its parent is dead, and nothing that ends the
 * shim's tree reaches it.
 */
async function orphaningCodex(bin: string): Promise<void> {
	await writeFile(path.join(bin, "sleeper.js"), SLEEPER);
	if (process.platform === "win32") {
		await writeFile(
			path.join(bin, "codex.cmd"),
			`@echo off\r\nstart "" /b "${process.execPath}" "%~dp0sleeper.js"\r\nexit /b 0\r\n`,
		);
	} else {
		await writeFile(
			path.join(bin, "codex"),
			`#!/bin/sh\n"${process.execPath}" "${path.join(bin, "sleeper.js")}" &\nexit 0\n`,
			{ mode: 0o755 },
		);
	}
}

function lookupWith(
	bin: string,
	extra: Record<string, string> = {},
): { env: Record<string, string | undefined>; platform: NodeJS.Platform } {
	const env: Record<string, string | undefined> = {};
	for (const [name, value] of Object.entries(process.env)) {
		if (name.toUpperCase() !== "PATH") {
			env[name] = value;
		}
	}
	env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
	return { env: { ...env, ...extra }, platform: process.platform };
}

async function recorded(file: string): Promise<Recorded> {
	return JSON.parse(await readFile(file, "utf8"));
}

beforeEach(() => {
	delete process.env.FAKE_TOOL_RECORD;
});

afterEach(async () => {
	for (const root of roots.splice(0)) {
		await rm(root, {
			recursive: true,
			force: true,
			maxRetries: 20,
			retryDelay: 250,
		});
	}
});

function isRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function untilGone(pid: number): Promise<boolean> {
	for (let waited = 0; waited < 5000; waited += 100) {
		if (!isRunning(pid)) {
			return true;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return !isRunning(pid);
}

/** The process the "orphan" stand-in left running, when it ran at all. */
function grandchildPid(record: string): number {
	try {
		return Number(readFileSync(`${record}.grandchild`, "utf8"));
	} catch {
		return Number.NaN;
	}
}

async function untilGrandchildPid(record: string): Promise<number> {
	for (let waited = 0; waited < 15_000; waited += 100) {
		const pid = grandchildPid(record);
		if (!Number.isNaN(pid)) {
			return pid;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return Number.NaN;
}

async function killGrandchild(record: string): Promise<void> {
	try {
		process.kill(grandchildPid(record));
	} catch {
		// It never started, or it is gone.
	}
}

describe("taskkillPath", () => {
	it("is taskkill.exe in the System32 folder of the environment's own SystemRoot", () => {
		expect(taskkillPath({ SystemRoot: "D:\\Windows" })).toBe(
			"D:\\Windows\\System32\\taskkill.exe",
		);
		expect(taskkillPath({ SYSTEMROOT: "E:\\WinNT" })).toBe(
			"E:\\WinNT\\System32\\taskkill.exe",
		);
		expect(taskkillPath({ windir: "F:\\Win" })).toBe(
			"F:\\Win\\System32\\taskkill.exe",
		);
	});

	it("falls back to C:\\Windows when the environment names none, and is never a bare name looked up on PATH", () => {
		expect(taskkillPath({})).toBe("C:\\Windows\\System32\\taskkill.exe");
		expect(path.win32.isAbsolute(taskkillPath({ PATH: "C:\\x" }))).toBe(
			true,
		);
	});
});

describe("createAgentRunner", () => {
	it("runs the tool found on PATH with the arguments and the folder it is given, and returns what it said", async () => {
		const { root, bin } = await toolsFolder();
		const record = path.join(root, "record.json");
		const run = createAgentRunner({
			lookup: lookupWith(bin, {
				FAKE_TOOL_RECORD: record,
				FAKE_TOOL_STDOUT: "[]",
			}),
		});

		const result = await run("codex", ["mcp", "list", "--json"], {
			cwd: root,
			timeoutMs: 8000,
		});

		expect(result).toEqual({
			kind: "exited",
			code: 0,
			stdout: "[]",
			stderr: "",
		});
		const seen = await recorded(record);
		expect(seen.args).toEqual(["mcp", "list", "--json"]);
		expect(path.resolve(seen.cwd).toLowerCase()).toBe(
			path.resolve(root).toLowerCase(),
		);
	});

	it("starts a tool installed in a folder whose path has a space in it", async () => {
		const { root, bin } = await toolsFolder("my tools");
		const record = path.join(root, "record.json");
		const run = createAgentRunner({
			lookup: lookupWith(bin, { FAKE_TOOL_RECORD: record }),
		});

		const result = await run("codex", ["mcp", "login", "fabric-pleone"], {
			cwd: root,
			timeoutMs: 8000,
		});

		expect(result.kind).toBe("exited");
		expect((await recorded(record)).args).toEqual([
			"mcp",
			"login",
			"fabric-pleone",
		]);
	});

	it("reports a non-zero exit with its code and what it wrote to stderr", async () => {
		const { root, bin } = await toolsFolder();
		const run = createAgentRunner({
			lookup: lookupWith(bin, { FAKE_TOOL_BEHAVIOR: "fail" }),
		});

		const result = await run("claude", ["mcp", "get", "fabric"], {
			cwd: root,
			timeoutMs: 8000,
		});

		expect(result).toEqual({
			kind: "exited",
			code: 3,
			stdout: "",
			stderr: "it went wrong",
		});
	});

	it("never hands a Fabric setting to the tool, whatever the case of its name", async () => {
		const { root, bin } = await toolsFolder();
		const record = path.join(root, "record.json");
		const run = createAgentRunner({
			lookup: lookupWith(bin, {
				FAKE_TOOL_RECORD: record,
				FAKE_TOOL_OTHER: "kept",
				FABRIC_API_KEY: "fab_must_not_reach_the_tool",
				fabric_base_url: "https://deploy.example.com",
			}),
		});

		await run("claude", ["mcp", "get", "fabric"], {
			cwd: root,
			timeoutMs: 8000,
		});

		const seen = await recorded(record);
		expect(seen.fabricVariables).toEqual([]);
		expect(seen.other).toBe("kept");
	});

	it("gives up on a tool that does not finish, after the time it was given, and ends it", async () => {
		const { root, bin } = await toolsFolder();
		const record = path.join(root, "record.json");
		const run = createAgentRunner({
			lookup: lookupWith(bin, {
				FAKE_TOOL_RECORD: record,
				FAKE_TOOL_BEHAVIOR: "hang",
			}),
		});

		const result = await run("codex", ["mcp", "login", "fabric-pleone"], {
			cwd: root,
			timeoutMs: 5000,
		});

		expect(result).toEqual({ kind: "timed-out" });
		expect(await untilGone((await recorded(record)).pid)).toBe(true);
	}, 30_000);

	it("returns when something the tool started keeps the pipes open after the tool is gone", async () => {
		const { root, bin } = await toolsFolder();
		await orphaningCodex(bin);
		const record = path.join(root, "record.json");
		const run = createAgentRunner({
			lookup: lookupWith(bin, { FAKE_TOOL_RECORD: record }),
		});

		const started = Date.now();
		let result: Awaited<ReturnType<typeof run>>;
		try {
			result = await run("codex", ["mcp", "login", "fabric-pleone"], {
				cwd: root,
				timeoutMs: 3000,
			});
		} finally {
			await killGrandchild(record);
		}

		expect(result).toEqual({ kind: "timed-out" });
		expect(Date.now() - started).toBeLessThan(20_000);
	});

	it("lets the process exit when something the tool started holds the pipes, instead of waiting for it", async () => {
		const { root, bin } = await toolsFolder();
		await orphaningCodex(bin);
		const record = path.join(root, "record.json");
		const driver = spawn(process.execPath, ["--import", "tsx", DRIVER], {
			cwd: CLI_ROOT,
			env: {
				...lookupWith(bin, { FAKE_TOOL_RECORD: record }).env,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		driver.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		const started = Date.now();

		try {
			const code = await new Promise<number | null>((resolve) => {
				const giveUp = setTimeout(() => {
					driver.kill();
					resolve(null);
				}, 25_000);
				driver.on("close", (exit) => {
					clearTimeout(giveUp);
					resolve(exit);
				});
			});

			expect(JSON.parse(stdout.trim())).toEqual({ kind: "timed-out" });
			expect(code).toBe(0);
			expect(Date.now() - started).toBeLessThan(25_000);
			// It holds the pipes from the moment it is created, but only notes its
			// pid once it has started, which a busy machine can put after the exit.
			expect(isRunning(await untilGrandchildPid(record))).toBe(true);
		} finally {
			await killGrandchild(record);
		}
	}, 60_000);

	it("keeps no more of a flood of output than its cap", async () => {
		const { root, bin } = await toolsFolder();
		const run = createAgentRunner({
			lookup: lookupWith(bin, { FAKE_TOOL_BEHAVIOR: "flood" }),
		});

		const result = await run("claude", ["mcp", "get", "fabric"], {
			cwd: root,
			timeoutMs: 8000,
		});

		if (result.kind !== "exited") {
			throw new Error(`expected the tool to exit, got ${result.kind}`);
		}
		expect(result.stdout.length).toBe(256 * 1024);
	});

	it("says the tool is missing when it is nowhere on PATH", async () => {
		const { root, bin } = await toolsFolder();
		const empty = path.join(root, "empty");
		await mkdir(empty);
		const lookup = lookupWith(bin);
		lookup.env.PATH = empty;
		const run = createAgentRunner({ lookup });

		const result = await run("codex", ["mcp", "list", "--json"], {
			cwd: root,
			timeoutMs: 8000,
		});

		expect(result).toEqual({ kind: "missing" });
	});

	it.each([
		["a space", "my server"],
		["a semicolon", "a;b"],
		["an ampersand", "a&b"],
		["a pipe", "a|b"],
		["a command substitution", "$(whoami)"],
		["a backtick", "`whoami`"],
		["a quote", 'a"b'],
		["a percent variable", "%PATH%"],
		["a caret", "a^b"],
		["a newline", "a\nb"],
		["a redirect", "a>b"],
	])(
		"starts nothing when an argument has %s in it",
		async (_label, argument) => {
			const { root, bin } = await toolsFolder();
			const record = path.join(root, "record.json");
			const run = createAgentRunner({
				lookup: lookupWith(bin, { FAKE_TOOL_RECORD: record }),
			});

			const result = await run("codex", ["mcp", "add", argument], {
				cwd: root,
				timeoutMs: 8000,
			});

			expect(result).toEqual({ kind: "refused" });
			await expect(access(record)).rejects.toThrow();
		},
	);

	it("starts the tool with the person's terminal when the step is a sign-in, and returns its exit code", async () => {
		const { root, bin } = await toolsFolder();
		const record = path.join(root, "record.json");
		const run = createAgentRunner({
			lookup: lookupWith(bin, {
				FAKE_TOOL_RECORD: record,
				FAKE_TOOL_BEHAVIOR: "fail",
			}),
		});

		const result = await run("codex", ["mcp", "login", "fabric-pleone"], {
			cwd: root,
			timeoutMs: 8000,
			interactive: true,
		});

		expect(result).toEqual({
			kind: "exited",
			code: 3,
			stdout: "",
			stderr: "",
		});
		expect((await recorded(record)).args).toEqual([
			"mcp",
			"login",
			"fabric-pleone",
		]);
	});

	it.runIf(process.platform === "win32")(
		"refuses a Windows shim whose path has a character the command interpreter reads",
		async () => {
			const { root, bin } = await toolsFolder("tools&more");
			const record = path.join(root, "record.json");
			const run = createAgentRunner({
				lookup: lookupWith(bin, { FAKE_TOOL_RECORD: record }),
			});

			const result = await run("codex", ["mcp", "list", "--json"], {
				cwd: root,
				timeoutMs: 8000,
			});

			expect(result).toEqual({ kind: "refused" });
			await expect(access(record)).rejects.toThrow();
		},
	);
});
