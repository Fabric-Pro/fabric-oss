/**
 * Git process plumbing for the Coding Instructions repository sync (design
 * 2026-09-23 §5.3.2, §8).
 *
 * `node:child_process` rather than `simple-git`: every git command here runs
 * in its own process group so a watchdog can kill git AND the transport
 * helpers it forks (`git-remote-https`, the lazy-fetch `git fetch`), which
 * `simple-git` cannot do (its `spawnOptions` pass only uid/gid). The same
 * runner feeds stdin to `sparse-checkout set --stdin` and caps `cat-file`
 * output.
 *
 * Nothing here is exported from the activities barrel: every export of a
 * module the barrel re-exports becomes a schedulable Temporal activity.
 */
import { type ChildProcess, spawn } from "node:child_process";
import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { SNAPSHOT_LIMITS } from "@repo/instructions";
import {
	createLsTreeParser,
	type LsTreeSummary,
	sparsePatternFor,
} from "./instruction-sync-tree";

/** Inventory cap, checked while `ls-tree` streams (spec §5.3.2 step 5). */
export const MAX_INVENTORY_ENTRIES = 200_000;
/** Disk cap for one clone directory (spec §8.4): two snapshots' worth plus 64 MiB of metadata. */
export const MAX_CLONE_BYTES =
	2 * SNAPSHOT_LIMITS.maxTotalBytes + 64 * 1024 * 1024;
/** How often the watchdog measures the clone directory (spec §8.4). */
const WATCHDOG_SAMPLE_MS = 250;
/** The `.fabricignore` read limit, the same 64 KiB `begin` accepts (spec §5.3.2 step 6). */
export const MAX_FABRICIGNORE_BYTES = 64 * 1024;
/** Stderr kept for classification and debug logs; never returned. */
const STDERR_TAIL_BYTES = 8 * 1024;

export const GIT_ASKPASS_PATH = path.join(__dirname, "git-askpass.sh");

/** On every git invocation (spec §8.1). */
export const GIT_SAFE_CONFIG: readonly string[] = [
	"-c",
	"credential.helper=",
	"-c",
	"protocol.allow=never",
	"-c",
	"protocol.https.allow=always",
];

/** Worker variables a git child may see. Everything else is left behind. */
const PASSTHROUGH_ENV = [
	"PATH",
	"HTTPS_PROXY",
	"https_proxy",
	"NO_PROXY",
	"no_proxy",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"GIT_SSL_CAINFO",
	"GIT_SSL_CAPATH",
] as const;

type GitCommandErrorKind =
	| "exit"
	| "disk_limit"
	| "output_limit"
	| "cancelled"
	| "timeout"
	| "spawn"
	/** A caller-supplied argument failed validation before anything spawned (review S1/S2). */
	| "invalid_argument";

/**
 * A failed git (or test) process. The message names the command label and
 * the kind only: never argv, which holds the URL, and never stderr, which can
 * quote it. `stderrTail` is for classification and redacted debug logs.
 */
export class GitCommandError extends Error {
	constructor(
		readonly kind: GitCommandErrorKind,
		readonly exitCode: number | null,
		readonly stderrTail: string,
		readonly label: string,
	) {
		super(`git ${label} failed (${kind})`);
		this.name = "GitCommandError";
	}
}

type BoundedProcessOptions = {
	cwd: string;
	args: readonly string[];
	env: NodeJS.ProcessEnv;
	/** Short name for errors and logs, e.g. "clone". Never argv. */
	label: string;
	/** Directory the disk watchdog measures, with its cap. */
	watchDir?: string;
	maxDirBytes?: number;
	sampleMs?: number;
	stdin?: string;
	/** Collected stdout cap; passing it kills the group with `output_limit`. */
	maxStdoutBytes?: number;
	/** Streaming consumer instead of collection; "stop" ends the command early and resolves. */
	onStdout?: (chunk: Buffer) => "continue" | "stop";
	signal?: AbortSignal;
	/** Redacted out of `stderrTail` at error construction (review N1). Never the message, which never carries stderr. */
	secrets?: readonly string[];
};

type BoundedProcessResult = { stdout: Buffer; stoppedEarly: boolean };

/**
 * Spawn `command` in its own process group and bound it: disk (sampled, and
 * once more at exit), stdout size, cancellation and timeout each SIGKILL the
 * whole group.
 */
export function runBoundedProcess(
	options: BoundedProcessOptions & { command: string },
): Promise<BoundedProcessResult> {
	return new Promise((resolve, reject) => {
		let child: ChildProcess;
		try {
			child = spawn(options.command, [...options.args], {
				cwd: options.cwd,
				env: options.env,
				detached: true,
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch {
			reject(new GitCommandError("spawn", null, "", options.label));
			return;
		}
		const stdout: Buffer[] = [];
		let stdoutBytes = 0;
		let stderr: Buffer = Buffer.alloc(0);
		let verdict: GitCommandErrorKind | "stopped" | null = null;
		let settled = false;

		const killGroup = (why: GitCommandErrorKind | "stopped"): void => {
			// A watchdog sample or an abort can still fire after `finish` has
			// already settled (a reaped process's pid can be reused); guard
			// against sending SIGKILL to a stranger's process group (review N2).
			if (settled) {
				return;
			}
			verdict ??= why;
			try {
				if (child.pid !== undefined) {
					process.kill(-child.pid, "SIGKILL");
				}
			} catch {
				// The group is already gone.
			}
		};
		const onAbort = (): void => {
			const reason = options.signal?.reason as
				| { name?: unknown }
				| undefined;
			killGroup(
				reason?.name === "TimeoutError" ? "timeout" : "cancelled",
			);
		};

		child.stdout?.on("data", (chunk: Buffer) => {
			if (verdict !== null) {
				return;
			}
			if (options.onStdout) {
				if (options.onStdout(chunk) === "stop") {
					killGroup("stopped");
				}
				return;
			}
			stdoutBytes += chunk.length;
			if (
				options.maxStdoutBytes !== undefined &&
				stdoutBytes > options.maxStdoutBytes
			) {
				killGroup("output_limit");
				return;
			}
			stdout.push(chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = Buffer.concat([stderr, chunk]);
			if (stderr.length > STDERR_TAIL_BYTES) {
				stderr = stderr.subarray(stderr.length - STDERR_TAIL_BYTES);
			}
		});
		// EPIPE when the process exits before reading all of stdin.
		child.stdin?.on("error", () => {});
		child.stdin?.end(options.stdin ?? "");

		if (options.signal?.aborted) {
			onAbort();
		} else {
			options.signal?.addEventListener("abort", onAbort, { once: true });
		}

		const watchDir = options.watchDir;
		const maxDirBytes = options.maxDirBytes;
		let sampling = false;
		const watchdog =
			watchDir !== undefined && maxDirBytes !== undefined
				? setInterval(() => {
						if (sampling || verdict !== null) {
							return;
						}
						sampling = true;
						directorySizeBytes(watchDir, maxDirBytes)
							.then((size) => {
								if (size > maxDirBytes) {
									killGroup("disk_limit");
								}
							})
							.catch(() => {})
							.finally(() => {
								sampling = false;
							});
					}, options.sampleMs ?? WATCHDOG_SAMPLE_MS)
				: null;
		watchdog?.unref?.();

		const finish = async (code: number | null): Promise<void> => {
			if (settled) {
				return;
			}
			settled = true;
			if (watchdog) {
				clearInterval(watchdog);
			}
			options.signal?.removeEventListener("abort", onAbort);
			// Redacted before it ever reaches a GitCommandError (review N1): a
			// consumer that logs `stderrTail` directly (console.error(err),
			// util.inspect, a structured-logger dump) must not print a raw
			// credential, even though today's design keeps one out of stderr
			// in the first place (no userinfo in argv, askpass instead of a
			// URL-embedded token).
			const tail = redactSecrets(
				stderr.toString("utf8"),
				options.secrets ?? [],
			);
			if (verdict === "stopped") {
				resolve({ stdout: Buffer.concat(stdout), stoppedEarly: true });
				return;
			}
			if (
				verdict === null &&
				watchDir !== undefined &&
				maxDirBytes !== undefined
			) {
				// A burst that landed between two samples is still over the cap.
				const size = await directorySizeBytes(
					watchDir,
					maxDirBytes,
				).catch(() => 0);
				if (size > maxDirBytes) {
					verdict = "disk_limit";
				}
			}
			if (verdict !== null) {
				reject(new GitCommandError(verdict, code, tail, options.label));
				return;
			}
			if (code !== 0) {
				reject(new GitCommandError("exit", code, tail, options.label));
				return;
			}
			resolve({ stdout: Buffer.concat(stdout), stoppedEarly: false });
		};
		child.on("error", () => {
			verdict ??= "spawn";
			void finish(null);
		});
		child.on("close", (code) => {
			void finish(code);
		});
	});
}

function runGit(options: BoundedProcessOptions): Promise<BoundedProcessResult> {
	// Derived from the child env rather than threaded through every one of
	// this file's exported git operations (review N1): `FABRIC_GIT_CREDENTIAL`
	// is already carried on `options.env` by `buildGitEnv`, so every call
	// site gets redaction for free and cannot forget to pass it.
	const credential = options.env.FABRIC_GIT_CREDENTIAL;
	return runBoundedProcess({
		...options,
		command: "git",
		args: [...GIT_SAFE_CONFIG, ...options.args],
		secrets: credential ? [credential] : [],
	});
}

/**
 * The git child's whole environment, built from scratch (spec §8.1): the
 * worker's own variables (database URL, API keys, a stray GIT_DIR) never
 * reach git or anything it runs. The credential travels here and nowhere
 * else, for `git-askpass.sh` to print.
 *
 * `host` (review S3) is the `URL.host` of the credential-free clone URL, and
 * is REQUIRED whenever `credential` is given: `git-askpass.sh` answers a
 * credential prompt only when the prompt names this host, so a cross-host
 * redirect or an `HTTPS_PROXY` that itself demands auth cannot receive the
 * token. Callers with no credential (anonymous or local access) may omit it.
 *
 * SIGNATURE CHANGE (review fix round 1): `host` is new. Task 5's callers,
 * which always have a credential, must now also pass `host`.
 */
export function buildGitEnv(input: {
	home: string;
	username?: string;
	credential?: string;
	host?: string;
	source?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
	// `!input.host` (not `=== undefined`) so an empty string is refused too
	// (fix round 2 nit): `git-askpass.sh` matches `//$FABRIC_GIT_HOST': `, and
	// an empty host makes every prompt ending in `//'` or `@'` match.
	if (input.credential !== undefined && !input.host) {
		throw new Error(
			"buildGitEnv: host is required whenever credential is given",
		);
	}
	const source = input.source ?? process.env;
	// `{} as` rather than an annotation: apps/web type-checks this file with
	// Next.js typings, where `NODE_ENV` is a required property of ProcessEnv.
	const env = {} as NodeJS.ProcessEnv;
	for (const key of PASSTHROUGH_ENV) {
		const value = source[key];
		if (value !== undefined) {
			env[key] = value;
		}
	}
	Object.assign(env, {
		HOME: input.home,
		LC_ALL: "C",
		GIT_TERMINAL_PROMPT: "0",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_LITERAL_PATHSPECS: "1",
		GIT_ASKPASS: GIT_ASKPASS_PATH,
	});
	if (input.credential !== undefined) {
		env.FABRIC_GIT_USERNAME = input.username ?? "";
		env.FABRIC_GIT_CREDENTIAL = input.credential;
		env.FABRIC_GIT_HOST = input.host;
	}
	return env;
}

/** The HTTPS username `buildAuthCloneUrl` (`@repo/integrations`) uses per provider. */
export function gitUsernameFor(provider: string): string {
	if (provider === "AZURE_DEVOPS") {
		return "pat";
	}
	if (provider === "GITLAB") {
		return "oauth2";
	}
	return "x-access-token";
}

/**
 * The integration's URL as `origin + pathname` with any userinfo stripped, or
 * null when it is not HTTPS or carries a query or a fragment.
 *
 * Userinfo is stripped, not refused: Azure DevOps' own "Clone" button hands
 * out `https://<org>@<ado host>/<org>/<project>/_git/<repo>` (the host is
 * dev.azure.com; it is not spelled out beside the `@` so the publication
 * scan does not read the pair as an email address), and members
 * connect with exactly that URL. The credential git uses always comes from
 * the askpass helper, never from the URL. A query or fragment
 * (`…/repo.git?access_token=…`, `…/_git/repo#token`) is not part of a
 * repository URL and may carry a secret, so it is refused and the run fails
 * closed (INTEGRATION_UNAVAILABLE). The result has no component other than
 * origin and path, so nothing else can reach git's argv, `.git/config` on
 * disk, or git's own stderr; `assertNoUrlCredentials` re-checks that at the
 * sink.
 */
export function credentialFreeUrl(repositoryUrl: string): string | null {
	let url: URL;
	try {
		url = new URL(repositoryUrl);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" || url.search !== "" || url.hash !== "") {
		return null;
	}
	// `origin` never includes userinfo, so this also strips it.
	return `${url.origin}${url.pathname}`;
}

export function cloneArgs(input: {
	url: string;
	ref: string;
	dir: string;
}): string[] {
	return [
		"clone",
		"--quiet",
		"--filter=blob:none",
		"--depth",
		"1",
		"--single-branch",
		"--branch",
		input.ref,
		"--no-tags",
		"--no-checkout",
		"--",
		input.url,
		input.dir,
	];
}

/**
 * What a failed clone or fetch means, from stderr. Authentication is NOT
 * classified here: the activity asks `isGitAuthError` from
 * `@repo/integrations`, the one list of auth wordings the code-indexing
 * clone already uses.
 */
export function classifyGitFailure(
	stderrTail: string,
): "ref_missing" | "repo_not_found" | "commit_missing" | "other" {
	const s = stderrTail.toLowerCase();
	if (
		(s.includes("remote branch") && s.includes("not found in upstream")) ||
		s.includes("could not find remote branch")
	) {
		return "ref_missing";
	}
	if (
		s.includes("repository not found") ||
		s.includes("tf401019") ||
		s.includes("does not appear to be a git repository") ||
		s.includes("the project you were looking for could not be found")
	) {
		return "repo_not_found";
	}
	if (
		s.includes("not our ref") ||
		s.includes("couldn't find remote ref") ||
		s.includes("no such remote ref")
	) {
		return "commit_missing";
	}
	return "other";
}

/** For debug logs only: removes the given secrets and any URL userinfo. */
export function redactSecrets(
	text: string,
	secrets: readonly string[],
): string {
	let out = text;
	for (const secret of secrets) {
		if (secret.length > 0) {
			out = out.split(secret).join("***");
		}
	}
	return out.replace(/\/\/[^/@\s]+@/g, "//***@");
}

/** Bytes under `dir`, not following symlinks; stops counting once past `stopAbove`. */
async function directorySizeBytes(
	dir: string,
	stopAbove = Number.POSITIVE_INFINITY,
): Promise<number> {
	let total = 0;
	const stack = [dir];
	while (stack.length > 0 && total <= stopAbove) {
		const current = stack.pop() as string;
		let entries: Dirent[];
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) {
				stack.push(full);
				continue;
			}
			try {
				total += (await lstat(full)).size;
			} catch {
				// Removed mid-walk (a pack temp file renamed): not counted.
			}
		}
	}
	return total;
}

type GitCallBase = { env: NodeJS.ProcessEnv; signal?: AbortSignal };
const watched = (dir: string) => ({
	watchDir: dir,
	maxDirBytes: MAX_CLONE_BYTES,
});

/**
 * A git object id: exactly a SHA-1 (40 hex) or SHA-256 (64 hex) hash, never
 * anything option-like (review S1). git's parse-options keeps reading options
 * after a non-option argument, so an unvalidated `sha`/`oid` starting with
 * `-` is a proven injection sink for `fetch`, `update-ref` and `cat-file`.
 */
const OBJECT_ID_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

function assertObjectId(value: string, label: string): void {
	if (!OBJECT_ID_PATTERN.test(value)) {
		throw new GitCommandError("invalid_argument", null, "", label);
	}
}

/**
 * Refuses a clone URL with any URL component other than origin and path —
 * userinfo, a query or a fragment — or one that does not round-trip through
 * `URL` (review S2), so a caller that did not pass `credentialFreeUrl`'s
 * output cannot put a credential in argv, in `.git/config` on disk, or in
 * git's own stderr.
 *
 * Deliberately narrower than `credentialFreeUrl(url) !== url`, which the
 * review's fix text names directly: that check also refuses every protocol
 * but HTTPS, and this file's own real-git test (Review Focus 1) exercises
 * `cloneTreeless` against a local `file://` fixture, which is the only way to
 * prove sparse-checkout/ls-tree behaviour against a real repository without a
 * network. Scheme restriction already exists at the git layer via
 * `GIT_SAFE_CONFIG` (`protocol.allow=never`, `protocol.https.allow=always`),
 * and Task 5's only caller passes `credentialFreeUrl`'s own (https) output,
 * so production behaviour is identical either way.
 */
function assertNoUrlCredentials(url: string, label: string): void {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new GitCommandError("invalid_argument", null, "", label);
	}
	if (
		parsed.username !== "" ||
		parsed.password !== "" ||
		parsed.search !== "" ||
		parsed.hash !== "" ||
		parsed.toString() !== url
	) {
		throw new GitCommandError("invalid_argument", null, "", label);
	}
}

/**
 * Spec §5.3.2 step 3: treeless, shallow, single-branch, no checkout. `dir`
 * must not exist. `url` must be `credentialFreeUrl`'s output: origin and
 * path only, which `assertNoUrlCredentials` re-checks before git runs.
 */
export async function cloneTreeless(
	input: GitCallBase & { cwd: string; url: string; ref: string; dir: string },
): Promise<void> {
	assertNoUrlCredentials(input.url, "clone");
	await runGit({
		cwd: input.cwd,
		args: cloneArgs({ url: input.url, ref: input.ref, dir: input.dir }),
		env: input.env,
		signal: input.signal,
		label: "clone",
		...watched(input.cwd),
	});
}

/** Spec §5.3.2 step 3, adopting: move HEAD to the pinned commit, still without a checkout. */
export async function fetchPinnedCommit(
	input: GitCallBase & { dir: string; sha: string },
): Promise<void> {
	assertObjectId(input.sha, "fetch");
	await runGit({
		cwd: input.dir,
		args: [
			"fetch",
			"--quiet",
			"--depth",
			"1",
			"--no-tags",
			"origin",
			input.sha,
		],
		env: input.env,
		signal: input.signal,
		label: "fetch",
		...watched(input.dir),
	});
	await runGit({
		cwd: input.dir,
		args: ["update-ref", "--no-deref", "HEAD", input.sha],
		env: input.env,
		signal: input.signal,
		label: "update-ref",
	});
}

export async function revParseHead(
	input: GitCallBase & { dir: string },
): Promise<string> {
	const { stdout } = await runGit({
		cwd: input.dir,
		args: ["rev-parse", "--verify", "HEAD^{commit}"],
		env: input.env,
		signal: input.signal,
		label: "rev-parse",
		maxStdoutBytes: 256,
	});
	return stdout.toString("utf8").trim();
}

/** Spec §5.3.2 step 5: no `-l`, because sizes would fetch every blob. */
export async function listTree(
	input: GitCallBase & { dir: string; rootPath: string; maxEntries: number },
): Promise<{ ok: true; summary: LsTreeSummary } | { ok: false }> {
	const parser = createLsTreeParser({
		rootPath: input.rootPath,
		maxEntries: input.maxEntries,
	});
	let limited = false;
	await runGit({
		cwd: input.dir,
		args: [
			"ls-tree",
			"-r",
			"-z",
			"HEAD",
			...(input.rootPath === "" ? [] : ["--", input.rootPath]),
		],
		env: input.env,
		signal: input.signal,
		label: "ls-tree",
		onStdout: (chunk) => {
			if (parser.push(chunk) === "limit") {
				limited = true;
				return "stop";
			}
			return "continue";
		},
	});
	return limited ? { ok: false } : { ok: true, summary: parser.finish() };
}

/** One blob, or null when it is larger than `maxBytes` (the process is killed at the cap). */
export async function readBlobCapped(
	input: GitCallBase & { dir: string; oid: string; maxBytes: number },
): Promise<Buffer | null> {
	assertObjectId(input.oid, "cat-file");
	try {
		const { stdout } = await runGit({
			cwd: input.dir,
			args: ["cat-file", "blob", input.oid],
			env: input.env,
			signal: input.signal,
			label: "cat-file",
			maxStdoutBytes: input.maxBytes,
			...watched(input.dir),
		});
		return stdout;
	} catch (error) {
		if (error instanceof GitCommandError && error.kind === "output_limit") {
			return null;
		}
		throw error;
	}
}

/**
 * Spec §5.3.2 step 8: materialise exactly the kept files. Non-cone, because
 * cone mode also checks out every file in each ancestor directory.
 */
export async function sparseCheckout(
	input: GitCallBase & { dir: string; repoPaths: readonly string[] },
): Promise<void> {
	await runGit({
		cwd: input.dir,
		args: ["sparse-checkout", "set", "--no-cone", "--stdin"],
		stdin: `${input.repoPaths.map(sparsePatternFor).join("\n")}\n`,
		env: input.env,
		signal: input.signal,
		label: "sparse-checkout",
		...watched(input.dir),
	});
	await runGit({
		cwd: input.dir,
		args: ["checkout", "--quiet", "HEAD"],
		env: input.env,
		signal: input.signal,
		label: "checkout",
		...watched(input.dir),
	});
}
