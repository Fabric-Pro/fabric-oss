/**
 * How this CLI spawns `git`: one bounded, quiet child process at a time, with
 * an environment that cannot redirect git or inherit a Fabric credential.
 * The gateway transport is the sole exception: it injects one URL-scoped
 * Authorization header into that child process only.
 *
 * Callers outside `git.ts` and `git-write.ts` never see this module; the
 * exported verbs of those two files are the whole vocabulary, and no caller
 * can run an arbitrary git command.
 */
import { spawn, spawnSync } from "node:child_process";
import { taskkillPath } from "./taskkill-path.js";

export type GitResult<T> =
	| { kind: "ok"; value: T }
	| { kind: "absent" }
	| { kind: "unavailable"; reason: string };

/** An absolute point in time, in epoch milliseconds, that no call may pass. */
export type GitDeadline = number;

const STDOUT_CAP_BYTES = 64 * 1024;
const STDERR_CAP_BYTES = 8 * 1024;
const KILL_GRACE_MS = 1_000;
/**
 * How long a hook's git process group has between SIGTERM and SIGKILL: less
 * than `KILL_GRACE_MS` because the hook's own margin after the git deadline is
 * under a second.
 */
const GROUP_KILL_GRACE_MS = 500;
/** What a read of file bytes (`binary`) may return. */
const BINARY_STDOUT_CAP_BYTES = 1024 * 1024;

/**
 * Removed from the inherited environment, alongside every `FABRIC_*` and
 * every `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>`. Compared in upper
 * case, because Windows environment names are case-insensitive.
 *
 * The first group redirects git at a different repository; the
 * `GIT_CONFIG_*` group injects or relocates configuration — an `insteadOf`
 * there would change which URL a remote fetches from, and so which
 * repository this checkout is taken to be.
 */
const STRIPPED_VARIABLES = new Set([
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_NAMESPACE",
	"GIT_COMMON_DIR",
	"GIT_ASKPASS",
	"SSH_ASKPASS",
	"GIT_CONFIG_COUNT",
	"GIT_CONFIG_PARAMETERS",
	"GIT_CONFIG_GLOBAL",
	"GIT_CONFIG_SYSTEM",
	"GIT_CONFIG_NOSYSTEM",
]);

const STRIPPED_PATTERN = /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/;

/** The two askpass programs a read-only question never runs, and the write may. */
const CREDENTIAL_PROGRAMS = new Set(["GIT_ASKPASS", "SSH_ASKPASS"]);

/** The two ways a developer chooses the program git runs for ssh. */
const SSH_PROGRAM_CHOICES = new Set(["GIT_SSH_COMMAND", "GIT_SSH"]);

/**
 * The environment every git call runs with, derived from `source`.
 *
 * `write` is for the call that talks to a remote with the developer's own
 * credentials, where a person is at the keyboard (`init --clone`). It keeps
 * `GIT_ASKPASS` and `SSH_ASKPASS` ON PURPOSE: that is how a helper such as
 * `gh` or a credential manager answers git, and it may ask the person in its
 * own window, so the call is interactive by design and bounded by its
 * deadline. git's own terminal prompt is off, Git Credential Manager is told
 * not to be interactive, and ssh runs in batch mode unless the developer
 * already chose an ssh command (`GIT_SSH_COMMAND` or `GIT_SSH`).
 *
 * `unattended` is for a write nobody is there to answer: it strips both
 * askpass programs as a read does. Everything that redirects git or carries a
 * Fabric credential is stripped in every mode.
 */
export function gitEnvironment(
	source: NodeJS.ProcessEnv = process.env,
	options: { write?: boolean; unattended?: boolean } = {},
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(source)) {
		const upper = name.toUpperCase();
		if (
			options.write &&
			!options.unattended &&
			CREDENTIAL_PROGRAMS.has(upper)
		) {
			env[name] = value;
			continue;
		}
		if (
			STRIPPED_VARIABLES.has(upper) ||
			upper.startsWith("FABRIC_") ||
			upper.startsWith("GIT_TRACE") ||
			STRIPPED_PATTERN.test(upper)
		) {
			continue;
		}
		env[name] = value;
	}
	env.GIT_TERMINAL_PROMPT = "0";
	env.GIT_OPTIONAL_LOCKS = "0";
	env.GIT_NO_LAZY_FETCH = "1";
	env.LC_ALL = "C";
	if (options.write) {
		env.GCM_INTERACTIVE = "never";
		if (
			!Object.keys(source).some((name) =>
				SSH_PROGRAM_CHOICES.has(name.toUpperCase()),
			)
		) {
			env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes";
		}
	}
	return env;
}

/**
 * The environment for a write that runs unattended, such as the session
 * hook's fetch (P3): the write environment without the developer's askpass
 * programs, so nothing can open a prompt nobody is there to answer. No caller
 * yet.
 */
export function hookWriteEnvironment(
	source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	return gitEnvironment(source, { write: true, unattended: true });
}

export type Spawned =
	| { kind: "exited"; code: number; stdout: string; stderr: string }
	| { kind: "unavailable"; reason: string; missing?: boolean };

/**
 * A Fabric access token scoped to one HTTPS Git gateway base. The caller never
 * puts it in command arguments, a remote URL, or repository configuration.
 */
export type GitHttpAuthorization = {
	url: string;
	authorization: string;
};

function gatewayConfig(
	authorization: GitHttpAuthorization | undefined,
): { args: string[]; env: NodeJS.ProcessEnv } | null {
	if (authorization === undefined) {
		return { args: [], env: {} };
	}
	try {
		const url = new URL(authorization.url);
		if (
			url.protocol !== "https:" ||
			url.username !== "" ||
			url.password !== "" ||
			url.search !== "" ||
			url.hash !== "" ||
			authorization.authorization === "" ||
			/[\r\n]/.test(authorization.authorization)
		) {
			return null;
		}
		const base = url.toString().replace(/\/$/, "");
		return {
			args: [
				"-c",
				`http.${base}.extraHeader=`,
				`--config-env=http.${base}.extraHeader=FABRIC_GIT_AUTH_HEADER`,
				"-c",
				"http.followRedirects=false",
				"-c",
				"credential.helper=",
			],
			env: {
				FABRIC_GIT_AUTH_HEADER: `Authorization: ${authorization.authorization}`,
			},
		};
	} catch {
		return null;
	}
}

/**
 * Run one read-only git command. Private on purpose: the exported functions
 * below are the whole vocabulary.
 */
export function runGit(
	cwd: string,
	args: readonly string[],
	deadline: GitDeadline,
	options: {
		write?: boolean;
		unattended?: boolean;
		httpAuthorization?: GitHttpAuthorization;
		/**
		 * The output is file content: up to 1 MiB, returned as `latin1` (one
		 * character per byte, so two different byte strings never read as
		 * equal) instead of as UTF-8 text.
		 */
		binary?: boolean;
		/** Text written to git's standard input, which is closed after it. */
		input?: string;
		/** Cap on what a `binary` read may return, in bytes. */
		binaryCapBytes?: number;
	} = {},
): Promise<Spawned> {
	const remaining = deadline - Date.now();
	if (remaining <= 0) {
		return Promise.resolve({
			kind: "unavailable",
			reason: "git timed out",
		});
	}
	return new Promise((resolve) => {
		const gateway = gatewayConfig(options.httpAuthorization);
		if (gateway === null) {
			resolve({
				kind: "unavailable",
				reason: "invalid Fabric Git transport",
			});
			return;
		}
		// Only the unattended hook is run to a deadline that must also end
		// its descendants; a person's `init --clone` stays in the terminal's
		// own process group, where Ctrl-C reaches git.
		const grouped = Boolean(options.write && options.unattended);
		let escalate: ReturnType<typeof setTimeout> | undefined;
		let settled = false;
		const finish = (result: Spawned): void => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				resolve(result);
			}
		};
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(
				"git",
				[
					...gateway.args,
					// Windows Git can report modified long-path files from its file
					// system cache even when Git's diff is empty. This command-local
					// setting keeps inspection truthful without changing the user's
					// checkout configuration.
					...(process.platform === "win32"
						? ["-c", "core.fscache=false"]
						: []),
					"-c",
					"core.fsmonitor=false",
					...(options.write
						? ["-c", "credential.interactive=never"]
						: []),
					...args,
				],
				{
					cwd,
					env: {
						...(options.write && options.unattended
							? hookWriteEnvironment(process.env)
							: gitEnvironment(process.env, options)),
						...gateway.env,
					},
					stdio: [
						options.input === undefined ? "ignore" : "pipe",
						"pipe",
						"pipe",
					],
					shell: false,
					windowsHide: true,
					// Its own process group, so the deadline can take the
					// transport children with it (`killTree`).
					detached: grouped && process.platform !== "win32",
				},
			);
		} catch (error) {
			resolve(spawnFailure(error));
			return;
		}
		const out: Buffer[] = [];
		let outBytes = 0;
		let outOverflow = false;
		const err: Buffer[] = [];
		let errBytes = 0;
		const stdoutCap = options.binary
			? (options.binaryCapBytes ?? BINARY_STDOUT_CAP_BYTES)
			: STDOUT_CAP_BYTES;
		if (options.input !== undefined) {
			child.stdin?.on("error", () => undefined);
			child.stdin?.end(options.input);
		}
		child.stdout?.on("data", (chunk: Buffer) => {
			if (chunk.length > stdoutCap - outBytes) {
				outOverflow = true;
			}
			if (outBytes < stdoutCap) {
				const room = stdoutCap - outBytes;
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
		// A grouped git being stopped on POSIX: SIGTERM went to the group, and
		// SIGKILL follows after the grace whether or not the leader has gone,
		// because a transport child can outlive it.
		let stoppingGroup = false;
		const releaseGroup = (): void => {
			// A descendant that survives still holds these pipes: let go of
			// them so they cannot keep this process alive.
			child.stdout?.destroy();
			child.stderr?.destroy();
			child.unref();
		};
		const timer = setTimeout(() => {
			if (grouped) {
				stopTree(child, "SIGTERM");
				if (process.platform !== "win32") {
					stoppingGroup = true;
					escalate = setTimeout(() => {
						stopTree(child, "SIGKILL");
						releaseGroup();
						finish({
							kind: "unavailable",
							reason: "git timed out",
						});
					}, GROUP_KILL_GRACE_MS);
					return;
				}
				releaseGroup();
			} else {
				child.kill("SIGTERM");
				// Fires unless the process has exited by then, so a git that
				// ignores SIGTERM does not outlive the grace period.
				escalate = setTimeout(() => {
					child.kill("SIGKILL");
				}, KILL_GRACE_MS);
			}
			finish({ kind: "unavailable", reason: "git timed out" });
		}, remaining);
		timer.unref();
		child.on("error", (error) => {
			finish(spawnFailure(error));
		});
		child.on("close", (code) => {
			if (stoppingGroup) {
				return;
			}
			clearTimeout(escalate);
			if (outOverflow) {
				finish({
					kind: "unavailable",
					reason: "git output exceeded the supported size",
				});
				return;
			}
			finish({
				kind: "exited",
				code: code ?? -1,
				stdout: Buffer.concat(out).toString(
					options.binary ? "latin1" : "utf8",
				),
				stderr: Buffer.concat(err).toString("utf8"),
			});
		});
	});
}

/**
 * Stop git and everything it started. Killing only the `git` the CLI spawned
 * is not enough: git runs its transport (`git-remote-https`, ssh, a
 * credential helper) as children, and on Windows they outlive their parent
 * and keep the output pipes open, so a hung fetch holds the whole process
 * (and the session that is waiting for it) long after the deadline. On Windows
 * that is `taskkill /T`, on POSIX the process group the child was started as
 * the leader of (`detached`). Best effort and synchronous: it runs on the
 * deadline, when nothing may wait.
 *
 * `SIGTERM` first on POSIX: git removes its `index.lock` when it is asked to
 * stop and leaves it behind when it is killed outright. Windows has no such
 * request, and `taskkill` is only aimed at a PID this process still owns: once
 * git has exited the number may belong to something else.
 */
function stopTree(
	child: ReturnType<typeof spawn>,
	signal: "SIGTERM" | "SIGKILL",
): void {
	const pid = child.pid;
	if (pid === undefined) {
		child.kill(signal);
		return;
	}
	try {
		if (process.platform === "win32") {
			if (child.exitCode === null && child.signalCode === null) {
				spawnSync(taskkillPath(), ["/PID", String(pid), "/T", "/F"], {
					stdio: "ignore",
					windowsHide: true,
					timeout: 2_000,
				});
			}
		} else {
			process.kill(-pid, signal);
		}
	} catch {
		// Already gone, or not ours to signal.
	}
	child.kill(signal);
}

function spawnFailure(error: unknown): Spawned {
	const code = (error as NodeJS.ErrnoException | null)?.code;
	if (code === "ENOENT") {
		return {
			kind: "unavailable",
			reason: "git is not installed",
			missing: true,
		};
	}
	if (code === "EACCES" || code === "EPERM") {
		return { kind: "unavailable", reason: "git could not be run" };
	}
	return { kind: "unavailable", reason: "git could not be run" };
}

/**
 * git's refusal as a fixed reason. Only the SHAPE of stderr is read (with
 * `LC_ALL=C` it is English); none of it is ever returned.
 */
export function exitReason(result: { code: number; stderr: string }): string {
	const text = result.stderr;
	if (/dubious ownership/i.test(text)) {
		return "git does not trust this repository's owner (safe.directory)";
	}
	if (/must be run in a work tree/i.test(text)) {
		return "not a working tree (a bare repository, or inside .git)";
	}
	if (/not a git repository/i.test(text)) {
		return "its .git points to a repository that does not exist";
	}
	if (/permission denied/i.test(text)) {
		return "permission denied";
	}
	return `git exited with status ${result.code}`;
}

/** `not a git repository (or any of the parent directories)` — and only that. */
export function isNotARepository(stderr: string): boolean {
	return /not a git repository \(or any/i.test(stderr);
}

export function lines(stdout: string): string[] {
	const trimmed = stdout.replace(/\r?\n$/, "");
	return trimmed === "" ? [] : trimmed.split(/\r?\n/);
}

export async function simple(
	root: string,
	args: readonly string[],
	deadline: GitDeadline,
): Promise<GitResult<{ code: number; stdout: string }>> {
	const result = await runGit(root, args, deadline);
	if (result.kind === "unavailable") {
		return { kind: "unavailable", reason: result.reason };
	}
	if (result.code === 128 && isNotARepository(result.stderr)) {
		return { kind: "absent" };
	}
	return {
		kind: "ok",
		value: { code: result.code, stdout: result.stdout },
	};
}
