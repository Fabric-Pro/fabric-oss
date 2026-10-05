/**
 * Stand-ins for the coding tools, for the tests of how `init` registers a
 * project's MCP server.
 *
 * Two halves, because `init` uses the tools in two ways. What is registered is
 * read from the tools' own files, as data, so a test writes those files into a
 * home folder and a checkout of its own (`toolFiles`, `writeClaudeFiles`,
 * `writeCodexConfig`). What is written goes through the tools' command lines,
 * so a test gets a runner (`simulateAgentTools`) that answers the way each does
 * and writes down every call. It answers nothing else: a call to `mcp get` or
 * `mcp list` throws, since `init` must never ask a tool what it already holds.
 *
 * The runner refuses an argument that is not plain, as the real one does, and
 * reports a tool that is not installed before it looks at the arguments.
 *
 * The servers the files hold carry a header with a secret in it, as a real one
 * can, so a test can show that nothing read from them reaches a line.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
	AgentCommand,
	AgentRun,
	AgentRunner,
} from "../../src/lib/instructions/agent-run.js";
import { isSafeArgument } from "../../src/lib/shell-words.js";

export const SECRET = "sk_live_must_never_be_printed";

export interface Call {
	command: AgentCommand;
	args: readonly string[];
	cwd: string;
	timeoutMs: number;
	interactive: boolean;
}

export interface Tools {
	/** The tool's command is not on PATH. */
	claude?: "missing";
	codex?: "missing";
	claudeAdd?: "ok" | "fails";
	claudeRemove?: "ok" | "fails";
	/**
	 * How `codex mcp add` ends. It registers the server and then signs in, which
	 * waits for a browser, so: `ok` registers and returns; `fails` registers
	 * nothing; `blocks` registers and then waits until the runner gives up on
	 * it; `signin-fails` registers and then exits non-zero.
	 */
	codexAdd?: "ok" | "fails" | "blocks" | "signin-fails";
	/** How a sign-in ends. */
	login?: "ok" | "fails" | "timed-out";
}

function exited(code: number, stdout = "", stderr = ""): AgentRun {
	return { kind: "exited", code, stdout, stderr };
}

/** What `codex mcp add` writes to `config.toml` when it registers a server. */
async function registerCodexServer(
	files: ToolFiles,
	name: string,
	url: string,
): Promise<void> {
	const directory = path.join(files.home, ".codex");
	const file = path.join(directory, "config.toml");
	await mkdir(directory, { recursive: true });
	const before = await readFile(file, "utf8").catch(() => "");
	await writeFile(file, `${before}${codexTable(name, url)}`);
}

/**
 * The tools' command lines. With `files`, a `codex mcp add` that registers a
 * server writes it into Codex's `config.toml` there, as the real one does, so
 * what `init` reads after a failed or abandoned add is what was written.
 */
export function simulateAgentTools(
	tools: Tools,
	files?: ToolFiles,
): {
	run: AgentRunner;
	calls: Call[];
} {
	const calls: Call[] = [];
	const run: AgentRunner = async (command, args, options) => {
		calls.push({
			command,
			args: [...args],
			cwd: options.cwd,
			timeoutMs: options.timeoutMs,
			interactive: options.interactive === true,
		});
		if (tools[command === "claude" ? "claude" : "codex"] === "missing") {
			return { kind: "missing" };
		}
		if (!args.every(isSafeArgument)) {
			return { kind: "refused" };
		}
		const verb = args.slice(0, 2).join(" ");
		if (verb === "mcp login") {
			if (tools.login === "timed-out") {
				return { kind: "timed-out" };
			}
			return tools.login === "fails" ? exited(1) : exited(0);
		}
		if (command === "claude") {
			if (verb === "mcp remove") {
				return tools.claudeRemove === "fails" ? exited(1) : exited(0);
			}
			if (verb === "mcp add") {
				return tools.claudeAdd === "fails"
					? exited(1, "", "boom")
					: exited(0);
			}
		} else if (verb === "mcp add") {
			const behavior = tools.codexAdd ?? "ok";
			if (behavior !== "fails" && files !== undefined) {
				await registerCodexServer(files, args[2] ?? "", args[4] ?? "");
			}
			if (behavior === "blocks") {
				return { kind: "timed-out" };
			}
			return behavior === "ok" ? exited(0) : exited(1);
		}
		throw new Error(`unexpected call: ${command} ${args.join(" ")}`);
	};
	return { run, calls };
}

/** `claude mcp add` and `codex mcp login`, as two short words each, per call. */
export function verbs(calls: readonly Call[]): string[] {
	return calls.map(
		(call) => `${call.command} ${call.args.slice(0, 2).join(" ")}`,
	);
}

export interface ToolFiles {
	/** Where the tools keep their files; Claude Code's `.claude.json` and `.codex/config.toml` are in it. */
	home: string;
	/** The checkout, where Claude Code's local scope is the project and `.mcp.json` is the team's. */
	cwd: string;
	/** What the tools' locations are read from: nothing is set, so `home` is it. */
	env: Record<string, string | undefined>;
}

const made: string[] = [];

export async function toolFiles(): Promise<ToolFiles> {
	const root = await mkdtemp(path.join(tmpdir(), "fabric-agent-files-"));
	made.push(root);
	const home = path.join(root, "home");
	const cwd = path.join(root, "checkout");
	await mkdir(home);
	await mkdir(cwd);
	return { home, cwd, env: {} };
}

export async function removeToolFiles(): Promise<void> {
	for (const root of made.splice(0)) {
		await rm(root, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
}

export interface ClaudeEntry {
	scope: "local" | "user" | "project";
	/** `null` for a server that runs a command and has no URL. */
	url: string | null;
}

function claudeServer(url: string | null): object {
	return url === null
		? { type: "stdio", command: "npx", args: ["-y", "some-mcp-server"] }
		: {
				type: "http",
				url,
				headers: { Authorization: `Bearer ${SECRET}` },
			};
}

/** The servers named `fabric`, in the scopes Claude Code keeps them in. */
export async function writeClaudeFiles(
	files: ToolFiles,
	entries: readonly ClaudeEntry[],
	name = "fabric",
): Promise<void> {
	const pick = (scope: ClaudeEntry["scope"]) =>
		Object.fromEntries(
			entries
				.filter((entry) => entry.scope === scope)
				.map((entry) => [name, claudeServer(entry.url)]),
		);
	await writeFile(
		path.join(files.home, ".claude.json"),
		JSON.stringify({
			projects: {
				[files.cwd.replace(/\\/g, "/")]: { mcpServers: pick("local") },
			},
			mcpServers: pick("user"),
		}),
	);
	if (entries.some((entry) => entry.scope === "project")) {
		await writeFile(
			path.join(files.cwd, ".mcp.json"),
			JSON.stringify({ mcpServers: pick("project") }),
		);
	}
}

/** Codex's `config.toml`, as written. */
export async function writeCodexConfig(
	files: ToolFiles,
	toml: string,
): Promise<void> {
	await mkdir(path.join(files.home, ".codex"), { recursive: true });
	await writeFile(path.join(files.home, ".codex", "config.toml"), toml);
}

/** A server table as `codex mcp add` writes it, with a header that is a secret. */
export function codexTable(name: string, url: string | null): string {
	const header = /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);
	return url === null
		? `[mcp_servers.${header}]\ncommand = "npx"\nargs = ["-y", "some-mcp-server"]\n`
		: `[mcp_servers.${header}]\nurl = "${url}"\n\n[mcp_servers.${header}.http_headers]\nAuthorization = "Bearer ${SECRET}"\n`;
}
