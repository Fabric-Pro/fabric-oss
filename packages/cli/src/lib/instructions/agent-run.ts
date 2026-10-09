/**
 * How this CLI runs a coding tool's own command line (`claude mcp ...`,
 * `codex mcp ...`): one bounded child process at a time, found on PATH by name,
 * started without a shell, with an environment that carries no Fabric
 * credential.
 *
 * Only the two tools `init` writes hooks for, and only the arguments `init`
 * builds, ever reach this module. Each argument is checked against a short list
 * of safe characters before anything starts, because on Windows the npm shim a
 * tool is installed as (`codex.cmd`) can only be started by the command
 * interpreter, and an argument that is not plain text must never get there.
 */
import { spawn } from "node:child_process";
import { isSafeArgument } from "../shell-words.js";
import { findOnPath, type PathLookupEnvironment } from "./path-lookup.js";
import { taskkillPath } from "./taskkill-path.js";

export type AgentCommand = "claude" | "codex";

export type AgentRun =
	| { kind: "exited"; code: number; stdout: string; stderr: string }
	| { kind: "timed-out" }
	/** The command is not on PATH. */
	| { kind: "missing" }
	/** An argument, or the path found, was not plain text; nothing was started. */
	| { kind: "refused" }
	| { kind: "failed" };

interface AgentRunOptions {
	/** Where the command runs: for Claude Code, the project it registers for. */
	cwd: string;
	timeoutMs: number;
	/** Hand the person's terminal to the command, for a sign-in it walks through. */
	interactive?: boolean;
}

/** What `init` runs a tool's command line with; a test stands in for it. */
export type AgentRunner = (
	command: AgentCommand,
	args: readonly string[],
	options: AgentRunOptions,
) => Promise<AgentRun>;

const STDOUT_CAP_BYTES = 256 * 1024;
const STDERR_CAP_BYTES = 8 * 1024;
const KILL_GRACE_MS = 1_000;

/** A path the Windows command interpreter may be handed inside quotes; `~` is a short folder name's (`IVANV~1`). */
const SAFE_SHIM_PATH = /^[A-Za-z]:[\\/][A-Za-z0-9 ._()~\\/@+-]+$/;

const COMMAND_SCRIPT_EXTENSION = /\.(?:cmd|bat)$/i;

/** The environment a tool's command line runs with: the caller's, without any Fabric setting. */
function environment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(source)) {
		if (!name.toUpperCase().startsWith("FABRIC_")) {
			env[name] = value;
		}
	}
	return env;
}

/**
 * How to start `file` with `args` without a shell: the file itself, or for a
 * Windows `.cmd` shim the command interpreter with one verbatim command line
 * made only of text already checked as plain.
 */
function launch(
	file: string,
	args: readonly string[],
	platform: NodeJS.Platform,
	env: NodeJS.ProcessEnv,
): { file: string; args: string[]; verbatim: boolean } | null {
	if (!args.every(isSafeArgument)) {
		return null;
	}
	if (platform === "win32" && COMMAND_SCRIPT_EXTENSION.test(file)) {
		if (!SAFE_SHIM_PATH.test(file)) {
			return null;
		}
		// `/s` removes the outer pair of quotes, so a shim path with a space in
		// it keeps its own.
		return {
			file: env.ComSpec ?? env.COMSPEC ?? "cmd.exe",
			args: ["/d", "/s", "/c", `""${file}" ${args.join(" ")}"`],
			verbatim: true,
		};
	}
	return { file, args: [...args], verbatim: false };
}

/**
 * Stop a command that ran out of time. A Windows `.cmd` shim is the command
 * interpreter with the tool as its child, and ending the interpreter alone
 * leaves the tool running, so there the whole tree is ended.
 */
function stop(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
	if (process.platform === "win32" && child.pid !== undefined) {
		try {
			const killer = spawn(
				taskkillPath(),
				["/pid", String(child.pid), "/t", "/f"],
				{ stdio: "ignore", windowsHide: true },
			);
			killer.on("error", () => {
				child.kill(signal);
			});
			killer.unref();
			return;
		} catch {
			// Fall through to ending the process itself.
		}
	}
	child.kill(signal);
}

export function createAgentRunner(input: {
	lookup: PathLookupEnvironment;
}): AgentRunner {
	return async (command, args, options) => {
		const found = await findOnPath(command, input.lookup);
		if (found === null) {
			return { kind: "missing" };
		}
		const env = environment(input.lookup.env);
		const launched = launch(found, args, input.lookup.platform, env);
		if (launched === null) {
			return { kind: "refused" };
		}
		return new Promise<AgentRun>((resolve) => {
			let settled = false;
			let escalate: ReturnType<typeof setTimeout> | undefined;
			const finish = (result: AgentRun): void => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					resolve(result);
				}
			};
			let child: ReturnType<typeof spawn>;
			try {
				child = spawn(launched.file, launched.args, {
					cwd: options.cwd,
					env,
					stdio: options.interactive
						? "inherit"
						: ["ignore", "pipe", "pipe"],
					shell: false,
					windowsHide: !options.interactive,
					windowsVerbatimArguments: launched.verbatim,
				});
			} catch {
				resolve({ kind: "failed" });
				return;
			}
			const out: Buffer[] = [];
			let outBytes = 0;
			const err: Buffer[] = [];
			let errBytes = 0;
			child.stdout?.on("data", (chunk: Buffer) => {
				if (outBytes < STDOUT_CAP_BYTES) {
					const room = STDOUT_CAP_BYTES - outBytes;
					out.push(chunk.subarray(0, room));
					outBytes += Math.min(room, chunk.length);
				}
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				if (errBytes < STDERR_CAP_BYTES) {
					const room = STDERR_CAP_BYTES - errBytes;
					err.push(chunk.subarray(0, room));
					errBytes += Math.min(room, chunk.length);
				}
			});
			const timer = setTimeout(() => {
				stop(child, "SIGTERM");
				escalate = setTimeout(() => {
					stop(child, "SIGKILL");
				}, KILL_GRACE_MS);
				escalate.unref();
				// Something the tool started may outlive it and keep its end of the
				// pipes open (an `.exe` the shim started, when `taskkill` could not
				// end the tree). Open pipes keep this process running, so they are
				// let go of: what was read so far is all there is.
				child.stdout?.destroy();
				child.stderr?.destroy();
				child.unref();
				finish({ kind: "timed-out" });
			}, options.timeoutMs);
			timer.unref();
			child.on("error", () => {
				finish({ kind: "failed" });
			});
			child.on("close", (code) => {
				clearTimeout(escalate);
				finish({
					kind: "exited",
					code: code ?? -1,
					stdout: Buffer.concat(out).toString("utf8"),
					stderr: Buffer.concat(err).toString("utf8"),
				});
			});
		});
	};
}
