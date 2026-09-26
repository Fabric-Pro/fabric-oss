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
import { lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { SNAPSHOT_LIMITS } from "@repo/instructions";
import { isGitAuthError } from "@repo/integrations";
import {
	createLsTreeParser,
	createRawLsTreeParser,
	type LsTreeSummary,
	type RawTreeEntry,
	sparsePatternFor,
} from "./instruction-sync-tree";

export type { RawTreeEntry } from "./instruction-sync-tree";

/** Inventory cap, checked while `ls-tree` streams (spec §5.3.2 step 5). */
export const MAX_INVENTORY_ENTRIES = 200_000;
/** Disk cap for one clone directory (spec §8.4): two snapshots' worth plus 64 MiB of metadata. */
export const MAX_CLONE_BYTES =
	2 * SNAPSHOT_LIMITS.maxTotalBytes + 64 * 1024 * 1024;
/** How often the watchdog measures the clone directory (spec §8.4). */
const WATCHDOG_SAMPLE_MS = 250;
/** Stderr kept for classification and debug logs; never returned. */
const STDERR_TAIL_BYTES = 8 * 1024;
/** Stdout kept on a failed exit, for `push --porcelain` (Fizzy #2563). */
const STDOUT_TAIL_BYTES = 8 * 1024;

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
	/**
	 * The last 8 KiB of collected stdout, redacted like `stderrTail`, set by
	 * `runBoundedProcess` after construction on a non-zero exit only (Fizzy
	 * #2563: `git push --porcelain` reports a refused ref on stdout and exits
	 * 1). Never part of the message.
	 */
	stdoutTail?: string;

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
	/** Bytes are written as given, never decoded (Fizzy #2563 spec §7: file bytes reach `hash-object`). */
	stdin?: string | Buffer | Uint8Array;
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
				const error = new GitCommandError(
					"exit",
					code,
					tail,
					options.label,
				);
				const collected = Buffer.concat(stdout);
				error.stdoutTail = redactSecrets(
					collected
						.subarray(
							Math.max(0, collected.length - STDOUT_TAIL_BYTES),
						)
						.toString("utf8"),
					options.secrets ?? [],
				);
				reject(error);
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
 * The integration's URL as `origin + pathname`, userinfo stripped, or null
 * when it is not HTTPS or carries a query or a fragment. Defined beside the
 * repository identity parsed from it, so the sync, the proposal activities
 * and proposal admission share one reading of a stored URL.
 */
export { credentialFreeUrl } from "@repo/integrations/instruction-pull-requests";

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

/**
 * Wordings with which a provider refuses a push for want of write permission
 * at the HTTP level, before git reports any ref (Fizzy #2563). Matched on the
 * lower-cased, redacted `stderrTail`.
 */
const PUSH_WRITE_REFUSAL_WORDINGS: readonly RegExp[] = [
	// GitHub: an App installation whose Contents permission is read-only.
	/write access to repository not granted/,
	// GitHub: a user or token without push rights ("Permission to o/r.git denied to u").
	/permission to \S+ denied to/,
	// GitLab: no push rights on the project, or a protected branch.
	/you are not allowed to push code to this project/,
	/you are not allowed to push code to protected branches/,
	// Azure DevOps: TF401027 names the missing Git permission
	// ('GenericContribute' to push, 'ForcePush' to delete a branch); TF402455
	// is a branch policy that allows updates only through a pull request.
	/\btf401027\b/,
	/\btf402455\b/,
];

/**
 * Whether a failed push was refused for want of write permission rather than
 * failing to run (Fizzy #2563). Such a refusal arrives as an HTTP error before
 * any ref negotiation, so `git push --porcelain` prints no ref line and only
 * stderr says why; the ref was never touched.
 *
 * Authentication is excluded first: an error carrying `isGitAuthError`
 * wording is a credential failure (a re-exchange can cure it), even beside a
 * 403. Only a provider's explicit write-refusal wording then counts; a bare
 * `returned error: 403` does not. A 403 also answers a GitHub organization's
 * SAML SSO wall (a credential the user must re-authorize), a rate limit, or
 * wording a provider may add later, and reading any of those as a refusal
 * would block the proposal with BRANCH_WRITE_REFUSED instead of routing it
 * to credential recovery or a retry. An unrecognised 403 is rethrown.
 */
export function isPushWriteRefusal(error: GitCommandError): boolean {
	if (error.kind !== "exit" || isGitAuthError(new Error(error.stderrTail))) {
		return false;
	}
	const s = error.stderrTail.toLowerCase();
	return PUSH_WRITE_REFUSAL_WORDINGS.some((wording) => wording.test(s));
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

/** Spec §6.1: the poll's head check is bounded to 30 s. */
export const LS_REMOTE_TIMEOUT_MS = 30_000;
/** One line per ref ending in the pattern; tail matching can list several. */
const LS_REMOTE_MAX_STDOUT_BYTES = 64 * 1024;

export type RemoteHead = { kind: "found"; sha: string } | { kind: "missing" };

/**
 * Spec §6.1: the head of `refs/heads/<ref>` on the remote, without cloning.
 * Same process-group runner, safe config and askpass env as the clone, so
 * the credential never reaches argv. `url` must be `credentialFreeUrl`'s
 * output, and the clone's own sink, `assertNoUrlCredentials`, re-checks it:
 * userinfo, a password, a query or a fragment is refused before git spawns.
 *
 * `ls-remote` matches patterns from the TAIL: `refs/heads/main` also lists
 * `refs/heads/x/refs/heads/main`. Only the line whose name is exactly the
 * wanted ref counts, and no exact line means `missing`, even when a
 * look-alike was listed. Every other failure (auth, repository not found,
 * network, timeout, unparseable output) throws `GitCommandError`, which the
 * poll treats as transient.
 */
export async function lsRemoteHead(
	input: GitCallBase & {
		cwd: string;
		url: string;
		ref: string;
		timeoutMs?: number;
	},
): Promise<RemoteHead> {
	assertNoUrlCredentials(input.url, "ls-remote");
	const wanted = `refs/heads/${input.ref}`;
	const timeout = AbortSignal.timeout(
		input.timeoutMs ?? LS_REMOTE_TIMEOUT_MS,
	);
	const signal = input.signal
		? AbortSignal.any([timeout, input.signal])
		: timeout;
	const { stdout } = await runGit({
		cwd: input.cwd,
		args: ["ls-remote", "--", input.url, wanted],
		env: input.env,
		signal,
		label: "ls-remote",
		maxStdoutBytes: LS_REMOTE_MAX_STDOUT_BYTES,
	});
	for (const line of stdout.toString("utf8").split("\n")) {
		const tab = line.indexOf("\t");
		if (tab === -1 || line.slice(tab + 1).trimEnd() !== wanted) {
			continue;
		}
		const sha = line.slice(0, tab);
		if (!OBJECT_ID_PATTERN.test(sha)) {
			throw new GitCommandError("exit", 0, "", "ls-remote");
		}
		return { kind: "found", sha };
	}
	return { kind: "missing" };
}

// ---------------------------------------------------------------------------
// Proposal pull requests (Fizzy #2563 spec §7 table). Every command below runs
// through `runGit`: the safe config, the askpass env, redaction and the
// process-group watchdog of the sync. Every object id is `assertObjectId`'d,
// every URL `assertNoUrlCredentials`'d and every branch
// `assertOperationBranch`'d before anything spawns.
// ---------------------------------------------------------------------------

/**
 * The only refs Fabric ever writes (spec §2.7, §13.3; plan Decision 13):
 * `fabric/instructions/<cuid2>` for attempt 1 and `-<n>` (n >= 2) for a
 * re-issue. A cuid2 id is 24 lowercase characters starting with a letter
 * (R20). Anything else, including a leading `-`, `..` or a full `refs/`
 * name, is refused before git runs.
 */
const OPERATION_BRANCH_PATTERN =
	/^fabric\/instructions\/[a-z][a-z0-9]{23}(?:-[2-9]|-[1-9][0-9]{1,3})?$/;

export function assertOperationBranch(branch: string): void {
	if (!OPERATION_BRANCH_PATTERN.test(branch)) {
		throw new GitCommandError("invalid_argument", null, "", "branch");
	}
}

/**
 * A repository path for `update-index -z --index-info`: non-empty, relative,
 * no empty, `.` or `..` segment, and no NUL (the record terminator). git's own
 * `verify_path` also refuses `.git` components; this guard keeps the framing
 * and the tree's shape out of a caller's hands.
 */
function assertTreePath(value: string): void {
	if (
		value === "" ||
		value.includes("\0") ||
		value.split("/").some((s) => s === "" || s === "." || s === "..")
	) {
		throw new GitCommandError("invalid_argument", null, "", "update-index");
	}
}

/** Bounded `ls-tree` output: the inventory cap bounds the entry count, this the bytes of a diff. */
const DIFF_TREE_MAX_STDOUT_BYTES = 16 * 1024 * 1024;

/**
 * Spec §7 step 2: `ls-tree -r -z <sha>` under `rootPath`, keeping mode, type,
 * object id and the byte-exact path of every blob, symlink and gitlink.
 * `listTree` beside it is unchanged. Over `maxEntries` entries is
 * `{ ok: false }` (LIMITS_EXCEEDED); a record git should never print with
 * `-r` throws.
 */
export async function listTreeRaw(
	input: GitCallBase & {
		dir: string;
		sha: string;
		rootPath: string;
		maxEntries: number;
	},
): Promise<{ ok: true; entries: RawTreeEntry[] } | { ok: false }> {
	assertObjectId(input.sha, "ls-tree");
	const parser = createRawLsTreeParser({
		rootPath: input.rootPath,
		maxEntries: input.maxEntries,
	});
	// Assigned in the stdout callback, so declared wide: TS would narrow a
	// plain initialiser to "ok" for the checks below.
	let verdict = "ok" as "ok" | "limit" | "invalid";
	await runGit({
		cwd: input.dir,
		args: [
			"ls-tree",
			"-r",
			"-z",
			input.sha,
			...(input.rootPath === "" ? [] : ["--", input.rootPath]),
		],
		env: input.env,
		signal: input.signal,
		label: "ls-tree",
		onStdout: (chunk) => {
			verdict = parser.push(chunk);
			return verdict === "ok" ? "continue" : "stop";
		},
	});
	const { entries, invalid } = parser.finish();
	if (verdict === "invalid" || invalid) {
		throw new GitCommandError("exit", 0, "", "ls-tree");
	}
	if (verdict === "limit" || entries.length > input.maxEntries) {
		return { ok: false };
	}
	return { ok: true, entries };
}

/** Spec §7 step 6: the base commit's tree into a private index file. */
export async function readBaseTree(
	input: GitCallBase & { dir: string; sha: string; indexFile: string },
): Promise<void> {
	assertObjectId(input.sha, "read-tree");
	await runGit({
		cwd: input.dir,
		args: ["read-tree", input.sha],
		env: { ...input.env, GIT_INDEX_FILE: input.indexFile },
		signal: input.signal,
		label: "read-tree",
		...watched(input.dir),
	});
}

export type TreeDeltaEntry =
	| { path: string; mode: "100644" | "100755"; bytes: Buffer }
	| { path: string; delete: true };

/**
 * Spec §7 step 6: one `hash-object -w --no-filters --stdin` per changed blob
 * (the bytes as a Buffer, never decoded), one `update-index -z --index-info`
 * applying the whole delta to the index `readBaseTree` filled (a deletion is
 * a mode-0 entry), then `write-tree --missing-ok`: the inherited entries come
 * from the base commit's own tree, so their blobs need not be local, and the
 * new blobs were just written. `blobIds` maps each written path to its blob id.
 */
export async function writeProposalTree(
	input: GitCallBase & {
		dir: string;
		indexFile: string;
		delta: readonly TreeDeltaEntry[];
	},
): Promise<{ tree: string; blobIds: Map<string, string> }> {
	for (const entry of input.delta) {
		assertTreePath(entry.path);
		if (
			!("delete" in entry) &&
			entry.mode !== "100644" &&
			entry.mode !== "100755"
		) {
			throw new GitCommandError(
				"invalid_argument",
				null,
				"",
				"update-index",
			);
		}
	}
	const env = { ...input.env, GIT_INDEX_FILE: input.indexFile };
	const call = { cwd: input.dir, env, signal: input.signal };
	const { stdout: format } = await runGit({
		...call,
		args: ["rev-parse", "--show-object-format"],
		label: "rev-parse",
		maxStdoutBytes: 64,
	});
	const zeroOid = "0".repeat(
		format.toString("utf8").trim() === "sha256" ? 64 : 40,
	);
	const blobIds = new Map<string, string>();
	const records: Buffer[] = [];
	for (const entry of input.delta) {
		if ("delete" in entry) {
			records.push(Buffer.from(`0 ${zeroOid}\t${entry.path}\0`, "utf8"));
			continue;
		}
		const { stdout } = await runGit({
			...call,
			args: ["hash-object", "-w", "--no-filters", "--stdin"],
			stdin: entry.bytes,
			label: "hash-object",
			maxStdoutBytes: 256,
			...watched(input.dir),
		});
		const oid = stdout.toString("utf8").trim();
		assertObjectId(oid, "hash-object");
		blobIds.set(entry.path, oid);
		records.push(
			Buffer.from(`${entry.mode} ${oid}\t${entry.path}\0`, "utf8"),
		);
	}
	await runGit({
		...call,
		args: ["update-index", "-z", "--index-info"],
		stdin: Buffer.concat(records),
		label: "update-index",
		...watched(input.dir),
	});
	const { stdout } = await runGit({
		...call,
		args: ["write-tree", "--missing-ok"],
		label: "write-tree",
		maxStdoutBytes: 256,
		...watched(input.dir),
	});
	const tree = stdout.toString("utf8").trim();
	assertObjectId(tree, "write-tree");
	return { tree, blobIds };
}

/**
 * Spec §7 step 7: the commit, reproducible from frozen metadata (author,
 * committer, date and message all come from the context), unsigned whatever
 * the environment says, with the message on stdin.
 */
export async function commitTree(
	input: GitCallBase & {
		dir: string;
		tree: string;
		parent: string;
		author: { name: string; email: string };
		committer: { name: string; email: string };
		message: string;
		date: string;
	},
): Promise<string> {
	assertObjectId(input.tree, "commit-tree");
	assertObjectId(input.parent, "commit-tree");
	const { stdout } = await runGit({
		cwd: input.dir,
		args: [
			"-c",
			"commit.gpgSign=false",
			"commit-tree",
			input.tree,
			"-p",
			input.parent,
			"-F",
			"-",
		],
		env: {
			...input.env,
			GIT_AUTHOR_NAME: input.author.name,
			GIT_AUTHOR_EMAIL: input.author.email,
			GIT_AUTHOR_DATE: input.date,
			GIT_COMMITTER_NAME: input.committer.name,
			GIT_COMMITTER_EMAIL: input.committer.email,
			GIT_COMMITTER_DATE: input.date,
		},
		stdin: input.message,
		signal: input.signal,
		label: "commit-tree",
		maxStdoutBytes: 256,
		...watched(input.dir),
	});
	const sha = stdout.toString("utf8").trim();
	assertObjectId(sha, "commit-tree");
	return sha;
}

export type DiffTreeEntry = {
	status: "A" | "M" | "D";
	path: string;
	oldMode: string;
	newMode: string;
	newOid: string;
};

const DIFF_RAW_HEADER =
	/^:(\d{6}) (\d{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) ([A-Z])$/;

/**
 * Spec §7 step 8, the verifier: `diff-tree -r -z --raw --no-renames`. Any
 * status other than added, modified or deleted (a type change, say) throws,
 * because the builder never produces one and the verifier must not
 * silently accept it.
 */
export async function diffTreeEntries(
	input: GitCallBase & { dir: string; from: string; to: string },
): Promise<DiffTreeEntry[]> {
	assertObjectId(input.from, "diff-tree");
	assertObjectId(input.to, "diff-tree");
	const { stdout } = await runGit({
		cwd: input.dir,
		args: [
			"diff-tree",
			"-r",
			"-z",
			"--raw",
			"--no-renames",
			input.from,
			input.to,
		],
		env: input.env,
		signal: input.signal,
		label: "diff-tree",
		maxStdoutBytes: DIFF_TREE_MAX_STDOUT_BYTES,
	});
	const fields = stdout.toString("utf8").split("\0");
	const out: DiffTreeEntry[] = [];
	for (let i = 0; i + 1 < fields.length; i += 2) {
		const header = DIFF_RAW_HEADER.exec(fields[i] as string);
		const status = header?.[5];
		if (!header || (status !== "A" && status !== "M" && status !== "D")) {
			throw new GitCommandError("exit", 0, "", "diff-tree");
		}
		out.push({
			status,
			path: fields[i + 1] as string,
			oldMode: header[1] as string,
			newMode: header[2] as string,
			newOid: header[4] as string,
		});
	}
	if (fields.length % 2 !== 1 || fields[fields.length - 1] !== "") {
		throw new GitCommandError("exit", 0, "", "diff-tree");
	}
	return out;
}

/** `git push --porcelain` prints `<flag>\t<from>:<to>\t<summary>` per ref. */
function porcelainFlag(
	stdout: Buffer,
	ref: string,
): { flag: string; summary: string } | null {
	for (const line of stdout.toString("utf8").split("\n")) {
		const [flag, spec, summary = ""] = line.split("\t");
		if (
			flag !== undefined &&
			spec !== undefined &&
			spec.endsWith(`:${ref}`)
		) {
			return { flag: flag.trim(), summary };
		}
	}
	return null;
}

/** Runs a push and returns its stdout whether or not git exited 0; any other failure rethrows. */
async function runPush(
	options: BoundedProcessOptions,
): Promise<{ stdout: Buffer; error: GitCommandError | null }> {
	try {
		const { stdout } = await runGit(options);
		return { stdout, error: null };
	} catch (error) {
		if (!(error instanceof GitCommandError) || error.kind !== "exit") {
			throw error;
		}
		return { stdout: Buffer.from(error.stdoutTail ?? "", "utf8"), error };
	}
}

/**
 * Spec §6.1 step 6: push `sha` to `refs/heads/<branch>` only if the ref does
 * not exist (an empty lease). `created` only on git's own `*` for exactly
 * that ref. A ref that already exists, even at our own SHA, is `exists`: git
 * reports an equal ref as up to date (`=`) before it checks the lease (R21;
 * git 2.39 prints `=`, Task 1), and ownership never comes from a matching SHA.
 * Any other refused ref is `refused`, and so is a push the remote refused
 * for want of write permission before reporting any ref
 * (`isPushWriteRefusal`, Fizzy #2563): in both the ref was never written. Any
 * other failure that reports no ref at all (authentication, an unreachable
 * remote) rethrows the original error.
 */
export async function pushCreateOnly(
	input: GitCallBase & { dir: string; sha: string; branch: string },
): Promise<{ kind: "created" } | { kind: "exists" } | { kind: "refused" }> {
	assertObjectId(input.sha, "push");
	assertOperationBranch(input.branch);
	const ref = `refs/heads/${input.branch}`;
	const { stdout, error } = await runPush({
		cwd: input.dir,
		env: input.env,
		signal: input.signal,
		label: "push",
		...watched(input.dir),
		args: [
			"push",
			"--porcelain",
			"--no-follow-tags",
			`--force-with-lease=${ref}:`,
			"origin",
			`${input.sha}:${ref}`,
		],
	});
	const line = porcelainFlag(stdout, ref);
	if (line?.flag === "*" && error === null) {
		return { kind: "created" };
	}
	if (
		line?.flag === "=" ||
		(line?.flag === "!" &&
			/stale info|already exists|fetch first/.test(line.summary))
	) {
		return { kind: "exists" };
	}
	if (line?.flag === "!") {
		return { kind: "refused" };
	}
	if (line === null && error !== null && isPushWriteRefusal(error)) {
		return { kind: "refused" };
	}
	throw error ?? new GitCommandError("exit", 0, "", "push");
}

/**
 * Spec §6.2 step 2 (R9): delete `refs/heads/<branch>` on `url` only while its
 * tip is `sha`, from a fresh bare repository under `cwd` (a push needs a
 * repository; a temporary directory has no `origin`). git reports a lease
 * mismatch and an absent ref alike as `stale info`, so a refusal of that kind
 * is resolved by one exact `ls-remote`: absent is `absent`, present is
 * `stale`. Any other refusal is `refused`; `activePullRequest` says the
 * remote named a pull request as the reason (Azure DevOps refuses deleting a
 * branch an active pull request uses), which settlement answers with a
 * lookup rather than a failure. A push the remote refused for want of write
 * permission before reporting any ref (`isPushWriteRefusal`, Fizzy #2563) is
 * `refused` without an active pull request: closing one would not grant the
 * permission.
 */
export async function deleteBranch(
	input: GitCallBase & {
		cwd: string;
		url: string;
		branch: string;
		sha: string;
	},
): Promise<
	| { kind: "deleted" }
	| { kind: "absent" }
	| { kind: "stale" }
	| { kind: "refused"; activePullRequest: boolean }
> {
	assertNoUrlCredentials(input.url, "push");
	assertOperationBranch(input.branch);
	assertObjectId(input.sha, "push");
	const ref = `refs/heads/${input.branch}`;
	const bare = await mkdtemp(path.join(input.cwd, "delete-"));
	try {
		await runGit({
			cwd: bare,
			args: ["init", "--bare", "-q"],
			env: input.env,
			signal: input.signal,
			label: "init",
		});
		const { stdout, error } = await runPush({
			cwd: bare,
			env: input.env,
			signal: input.signal,
			label: "push",
			args: [
				"push",
				"--porcelain",
				`--force-with-lease=${ref}:${input.sha}`,
				"--",
				input.url,
				`:${ref}`,
			],
		});
		const line = porcelainFlag(stdout, ref);
		if (line?.flag === "-" && error === null) {
			return { kind: "deleted" };
		}
		if (line?.flag === "!" && /stale info/.test(line.summary)) {
			const now = await lsRemoteRef({
				cwd: input.cwd,
				url: input.url,
				branch: input.branch,
				env: input.env,
				signal: input.signal,
			});
			return now.kind === "missing"
				? { kind: "absent" }
				: { kind: "stale" };
		}
		if (line?.flag === "!") {
			const reason = `${line.summary}\n${error?.stderrTail ?? ""}`;
			return {
				kind: "refused",
				activePullRequest: /\bpull request\b/i.test(reason),
			};
		}
		if (line === null && error !== null && isPushWriteRefusal(error)) {
			return { kind: "refused", activePullRequest: false };
		}
		throw error ?? new GitCommandError("exit", 0, "", "push");
	} finally {
		await rm(bare, { recursive: true, force: true });
	}
}

/**
 * Spec §6.1 step 3 (c), §6.2 step 2 (R10): the tip of exactly
 * `refs/heads/<branch>` on `url`, without a clone. `--refs` drops peeled
 * tags; `ls-remote` still matches from the tail, so only the exact line
 * counts, as in `lsRemoteHead`. Bounded to 30 s.
 */
export async function lsRemoteRef(
	input: GitCallBase & {
		cwd: string;
		url: string;
		branch: string;
		timeoutMs?: number;
	},
): Promise<RemoteHead> {
	assertNoUrlCredentials(input.url, "ls-remote");
	assertOperationBranch(input.branch);
	const wanted = `refs/heads/${input.branch}`;
	const timeout = AbortSignal.timeout(
		input.timeoutMs ?? LS_REMOTE_TIMEOUT_MS,
	);
	const { stdout } = await runGit({
		cwd: input.cwd,
		args: ["ls-remote", "--refs", "--", input.url, wanted],
		env: input.env,
		signal: input.signal
			? AbortSignal.any([timeout, input.signal])
			: timeout,
		label: "ls-remote",
		maxStdoutBytes: LS_REMOTE_MAX_STDOUT_BYTES,
	});
	for (const line of stdout.toString("utf8").split("\n")) {
		const tab = line.indexOf("\t");
		if (tab === -1 || line.slice(tab + 1).trimEnd() !== wanted) {
			continue;
		}
		const sha = line.slice(0, tab);
		if (!OBJECT_ID_PATTERN.test(sha)) {
			throw new GitCommandError("exit", 0, "", "ls-remote");
		}
		return { kind: "found", sha };
	}
	return { kind: "missing" };
}
