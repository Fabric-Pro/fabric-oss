#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHECK_TIMEOUTS_MS, effectiveTimeoutMs } from "./lib/gate-timeouts.mjs";
import { leadingCdTarget } from "./lib/git-helpers.mjs";
import { readToolInput } from "./lib/parse-input.mjs";
import { writeAskDecision } from "./lib/permission-decision.mjs";

/**
 * Quality-gate commands run sequentially with fail-fast. Order is
 * cheapest-first to surface the most common failure mode quickly:
 * type errors > lint > format drift.
 *
 * Type-check is SCOPED to the packages changed vs the branch's base (the
 * closer of origin/staging and origin/master, see scripts/lib/resolve-base.mjs)
 * and their dependents via `type-check:changed`, mirroring how CI scopes
 * its tests (`turbo run test --filter=...[origin/<base>]` in
 * unit-tests.yml). A full-repo `tsc` sweep re-checks all ~45 packages
 * — including heavy source packages like `@repo/database` (its ~47MB
 * generated Prisma client is re-checked by every consumer) — which
 * needs >8GB and OOMs on normal machines. Scoping keeps the gate fast
 * and relevant ("is what I changed sound?") without imposing a large
 * memory floor. lint/format stay whole-tree (Biome is cheap, ~2s).
 */
const CHECKS = [
	{
		argv: ["type-check:changed"],
		label: "pnpm type-check:changed",
		timeoutMs: CHECK_TIMEOUTS_MS.typeCheck,
	},
	{
		argv: ["lint"],
		label: "pnpm lint",
		timeoutMs: CHECK_TIMEOUTS_MS.lint,
	},
	{
		argv: ["format:check"],
		label: "pnpm format:check",
		timeoutMs: CHECK_TIMEOUTS_MS.format,
	},
];

/** Only the last 256 KB of a check's output is kept; the reason shows 8 lines. */
const MAX_OUTPUT_BYTES = 256 * 1024;
/** Time between SIGTERM and SIGKILL of a timed-out check's process group. */
const KILL_GRACE_MS = 3000;
/** How long to wait for pipes to close after the check exits (grandchildren may hold them). */
const CLOSE_WAIT_MS = 2000;

const MAX_OUTPUT_LINES = 8;

/**
 * `gh pr edit` is only gated when the call mutates the body via
 * `--body` or `--body-file`. Other flag combinations (labels, title,
 * reviewers, milestones) don't change the PR description, so they pass
 * through untouched.
 *
 * @param {string} command
 */
function isGatedGhPrEdit(command) {
	if (!/\bgh\s+pr\s+edit\b/.test(command)) {
		return false;
	}
	return (
		/(^|\s)--body(\s|=)/.test(command) ||
		/(^|\s)--body-file(\s|=)/.test(command)
	);
}

/**
 * `gh pr create` always triggers the gate (the act of creation
 * implies a body, even via `--fill`).
 *
 * @param {string} command
 */
function isGatedGhPrCreate(command) {
	return /\bgh\s+pr\s+create\b/.test(command);
}

/**
 * Returns the last N non-empty lines of `text`, joined by `\n`. Used
 * to truncate the failing command's output so the block message stays
 * readable in Claude Code's stderr panel.
 *
 * @param {string} text
 * @param {number} n
 */
function tailLines(text, n) {
	const lines = text.split(/\r?\n/);
	// strip trailing blank lines so the tail isn't all whitespace
	while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
		lines.pop();
	}
	if (lines.length <= n) {
		return lines.join("\n");
	}
	return lines.slice(lines.length - n).join("\n");
}

/**
 * @typedef {{output: string, exitCode: number, timedOut: boolean, spawnError: boolean, streamError?: boolean}} CheckFailure
 */

/** Check arguments allowed onto the Windows shell command line (no metacharacters). */
const SAFE_SHELL_ARG = /^[A-Za-z0-9:._-]+$/;

/**
 * Characters refused in the resolved pnpm path on Windows. The path is
 * double-quoted on the cmd.exe line, which makes `&|<>()` and spaces
 * literal, but `"` would end the quoting, `%` is expanded even inside
 * quotes, and `!` is expanded when delayed expansion is on (a registry
 * default /d does not turn off). `^` is literal inside quotes; it is refused
 * anyway because no real install path needs it and refusing costs only a
 * visible "could not be started".
 */
const UNSAFE_CMD_PATH_CHARS = /["%!^]/;

/** A fully qualified Windows path: drive-absolute (`C:\`) or UNC (`\\host`). */
const FULLY_QUALIFIED_WIN_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/;

/**
 * Windows only: the absolute path of the pnpm file to run, or null when none
 * is found. Walks PATH in order and, within each directory, PATHEXT in order
 * (cmd.exe's order), taking the first regular file named `pnpm<ext>`.
 * Entries that are not fully qualified (`.`, `bin`, `\tools`, `C:tools`) are
 * skipped: they depend on a current directory or drive, and cmd.exe would
 * resolve them against the check's cwd (the tree being PR'd) rather than the
 * hook's. runCheck launches this exact file, so the pnpm checked here is the
 * one that runs. With a shell in front a missing pnpm no longer raises
 * ENOENT (cmd prints a localized "is not recognized" message and exits 1),
 * so this lookup is also what reports a missing pnpm as "could not be
 * started".
 *
 * @returns {string | null}
 */
function resolveWindowsPnpm() {
	const exts = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
		.split(";")
		.filter(Boolean);
	for (const raw of (process.env.PATH ?? "").split(";")) {
		const dir = raw.replace(/^"(.*)"$/, "$1");
		if (!FULLY_QUALIFIED_WIN_PATH.test(dir)) {
			continue;
		}
		for (const ext of exts) {
			const candidate = join(dir, `pnpm${ext}`);
			try {
				if (statSync(candidate).isFile()) {
					return candidate;
				}
			} catch {
				// absent or unreadable — try the next extension
			}
		}
	}
	return null;
}

/**
 * Builds the spawn command for one check. POSIX spawns `pnpm` directly with
 * no shell. Windows installs pnpm as `pnpm.cmd`, which Node cannot spawn
 * without a shell, so there the check runs the absolute path from
 * resolveWindowsPnpm as `cmd.exe /d /s /c ""<pnpm path>" <argv>"` — the
 * command-line form Node builds for `shell: true`, written out so no args
 * array is combined with `shell: true` (DEP0190). The argv are the constants
 * in CHECKS and SAFE_SHELL_ARG rejects anything else; the path comes from
 * PATH, not from the gated command, and UNSAFE_CMD_PATH_CHARS rejects the
 * characters cmd.exe would interpret inside its quotes.
 *
 * @param {string[]} argv
 * @param {string | null} pnpmPath  Windows only: from resolveWindowsPnpm
 * @returns {{file: string, args: string[], windowsVerbatimArguments: boolean}}
 */
function checkCommand(argv, pnpmPath) {
	if (process.platform !== "win32") {
		return { file: "pnpm", args: argv, windowsVerbatimArguments: false };
	}
	if (!pnpmPath || UNSAFE_CMD_PATH_CHARS.test(pnpmPath)) {
		throw new Error(`refusing unsafe pnpm path for cmd.exe: ${pnpmPath}`);
	}
	for (const arg of argv) {
		if (!SAFE_SHELL_ARG.test(arg)) {
			throw new Error(
				`refusing unsafe check argument for cmd.exe: ${arg}`,
			);
		}
	}
	return {
		file: process.env.ComSpec || "cmd.exe",
		args: ["/d", "/s", "/c", `""${pnpmPath}" ${argv.join(" ")}"`],
		windowsVerbatimArguments: true,
	};
}

/**
 * Windows only: tries to kill the check's whole process tree (cmd.exe, pnpm
 * and the turbo/tsc/biome processes under it). taskkill runs detached from
 * the hook: its errors are swallowed and the hook never waits on it, so a
 * missing or hung taskkill cannot throw out of the hook or delay its
 * deadline — and a failed kill goes unreported.
 *
 * @param {number} pid
 */
function killWindowsTree(pid) {
	// Test seam: record each kill attempt so a test can prove when none is made.
	if (process.env.FABRIC_GATE_TEST_KILL_LOG) {
		try {
			appendFileSync(process.env.FABRIC_GATE_TEST_KILL_LOG, `${pid}\n`);
		} catch {
			// a seam failure must not change the hook's behaviour
		}
	}
	const taskkill = process.env.SystemRoot
		? join(process.env.SystemRoot, "System32", "taskkill.exe")
		: "taskkill.exe";
	try {
		const killer = spawn(taskkill, ["/pid", String(pid), "/T", "/F"], {
			stdio: "ignore",
			windowsHide: true,
		});
		killer.on("error", () => {
			// nothing more to try; the deadline still settles the hook
		});
		killer.unref();
	} catch {
		// as above
	}
}

/**
 * Runs one quality check and resolves to `null` (pass) or a failure.
 *
 * Captures stdout AND stderr because Biome and `tsc` both write
 * diagnostics to stdout, not stderr, despite being "errors". A
 * non-zero exit + empty stderr would otherwise leave the user with
 * no actionable info.
 *
 * On POSIX the check runs `pnpm` directly, in its own process group, so a
 * timeout can signal pnpm AND the tsc/turbo/biome processes it spawned. On
 * Windows it runs the resolved pnpm file through cmd.exe (see
 * resolveWindowsPnpm and checkCommand), a pnpm that is not found is
 * reported as "could not be started" before launch, and a timeout tries to
 * kill the whole process tree with taskkill (see killWindowsTree) as long
 * as cmd.exe has not exited. Only the last MAX_OUTPUT_BYTES of output are
 * kept, so a chatty check cannot exhaust memory or trip a maxBuffer error.
 *
 * @param {string[]} argv
 * @param {string} cwd
 * @param {number} timeoutMs
 * @returns {Promise<CheckFailure | null>}
 */
function runCheck(argv, cwd, timeoutMs) {
	return new Promise((resolvePromise) => {
		const isWindows = process.platform === "win32";
		const pnpmPath = isWindows ? resolveWindowsPnpm() : null;
		if (isWindows && !pnpmPath) {
			resolvePromise({
				output: "spawn pnpm ENOENT: no pnpm found on PATH under any PATHEXT extension",
				exitCode: 1,
				timedOut: false,
				spawnError: true,
			});
			return;
		}
		let child;
		try {
			const { file, args, windowsVerbatimArguments } = checkCommand(
				argv,
				pnpmPath,
			);
			child = spawn(file, args, {
				cwd,
				stdio: ["ignore", "pipe", "pipe"],
				detached: !isWindows,
				windowsVerbatimArguments,
				windowsHide: true,
				// Mirror CI's Type Check job heap (.github/workflows/type-check.yml:
				// `NODE_OPTIONS: --max-old-space-size=16384`). `turbo type-check`
				// pulls @repo/web's Next production build in via `^build`, and that
				// build's workers OOM at the default heap locally; CI only clears it
				// because of this env. Set gate-local (like CI's job env) so the hook
				// passes iff CI does — NOT baked into the shared `type-check` script.
				env: {
					...process.env,
					NODE_OPTIONS:
						`${process.env.NODE_OPTIONS ?? ""} --max-old-space-size=16384`.trim(),
					// Windows: pnpm itself is launched by absolute path, but npm's
					// pnpm.cmd shim then runs a bare `node`, which cmd.exe would look
					// for in the check's cwd (the tree being PR'd) before PATH. This
					// turns that implicit cwd search off. It does not cover an explicit
					// relative PATH entry such as `.`.
					...(isWindows
						? { NoDefaultCurrentDirectoryInExePath: "1" }
						: {}),
				},
			});
		} catch (err) {
			resolvePromise({
				output: String(err?.message ?? err),
				exitCode: 1,
				timedOut: false,
				spawnError: true,
			});
			return;
		}

		/** @type {Buffer[]} */
		let chunks = [];
		let size = 0;
		/** @param {Buffer} chunk */
		const onData = (chunk) => {
			chunks.push(chunk);
			size += chunk.length;
			if (size > MAX_OUTPUT_BYTES) {
				const tail = Buffer.concat(chunks).subarray(-MAX_OUTPUT_BYTES);
				chunks = [tail];
				size = tail.length;
			}
		};
		child.stdout.on("data", onData);
		child.stderr.on("data", onData);

		let settled = false;
		let timedOut = false;
		let exitCode = 1;
		let exitedOk = false;
		/** @type {NodeJS.Timeout | undefined} */
		let timeoutTimer;
		/** @type {NodeJS.Timeout | undefined} */
		let killTimer;
		/** @type {NodeJS.Timeout | undefined} */
		let closeTimer;

		let treeKilled = false;
		let rootExited = false;
		/** @param {NodeJS.Signals} signal */
		const killGroup = (signal) => {
			// Test seam: make signals no-ops so a test can prove the hook settles
			// even when the child never exits.
			if (process.env.FABRIC_GATE_TEST_IGNORE_KILL === "1") {
				return;
			}
			try {
				if (isWindows) {
					// Windows has no SIGTERM to send a tree, so the first call force-
					// kills it. Later calls, and any call once Node has seen cmd.exe
					// exit, launch no taskkill: Windows may have reused that pid and /T
					// would take down an unrelated tree. A narrow race remains — cmd.exe
					// can exit after this check but before taskkill resolves the pid.
					// Descendants still holding the pipes are then left running; the
					// hook does not wait for them (CLOSE_WAIT_MS).
					const exited =
						rootExited ||
						child.exitCode !== null ||
						child.signalCode !== null;
					if (!treeKilled && !exited && child.pid) {
						treeKilled = true;
						killWindowsTree(child.pid);
					}
				} else {
					process.kill(-child.pid, signal);
				}
			} catch (err) {
				if (err?.code !== "ESRCH") {
					try {
						child.kill(signal);
					} catch {
						// already gone
					}
				}
			}
		};

		/** @param {CheckFailure | null} result */
		const finish = (result) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timeoutTimer);
			clearTimeout(killTimer);
			clearTimeout(closeTimer);
			child.stdout.destroy();
			child.stderr.destroy();
			resolvePromise(result);
		};

		const buildResult = () => {
			if (exitedOk && !timedOut) {
				return null;
			}
			return {
				output: Buffer.concat(chunks).toString("utf8"),
				exitCode,
				timedOut,
				spawnError: false,
			};
		};

		child.on("error", (err) => {
			finish({
				output: String(err?.message ?? err),
				exitCode: 1,
				timedOut: false,
				spawnError: true,
			});
		});

		// Once the limit passes, the hook settles at timeoutMs + KILL_GRACE_MS
		// whether or not the child ever exits: SIGTERM to the group now, SIGKILL
		// to the group at the deadline, then report. No signal is sent after
		// that, which keeps the window for hitting a recycled process-group id
		// to the KILL_GRACE_MS between the two signals. On Windows the first
		// step tries to force-kill the tree and the second only reports.
		timeoutTimer = setTimeout(() => {
			timedOut = true;
			killGroup("SIGTERM");
			killTimer = setTimeout(() => {
				killGroup("SIGKILL");
				finish(buildResult());
			}, KILL_GRACE_MS);
		}, timeoutMs);

		child.on("exit", (code) => {
			rootExited = true;
			// Test seam: a pipe error after the root exited, while a grandchild
			// still holds the pipe open (exercises the guard in killGroup).
			if (process.env.FABRIC_GATE_TEST_STREAM_ERROR === "after-exit") {
				child.stdout.destroy(
					new Error("injected stream error after exit"),
				);
			}
			if (timedOut) {
				return; // the deadline above settles the timed-out path
			}
			exitCode = typeof code === "number" ? code : 1;
			exitedOk = code === 0;
			clearTimeout(timeoutTimer);
			// A grandchild holding the pipes open must not stall the hook.
			closeTimer = setTimeout(() => finish(buildResult()), CLOSE_WAIT_MS);
		});
		child.on("close", () => {
			if (!timedOut) {
				finish(buildResult());
			}
		});

		// A pipe error must not crash the hook before it decides: kill the
		// check and report it as unverified.
		/** @param {Error} err */
		const onStreamError = (err) => {
			// A later error on the other pipe, or one after the deadline, must not
			// signal again.
			if (settled) {
				return;
			}
			killGroup("SIGKILL");
			finish({
				output: `${Buffer.concat(chunks).toString("utf8")}\n(output stream error: ${String(err?.message ?? err)})`,
				exitCode: 1,
				timedOut: false,
				spawnError: false,
				streamError: true,
			});
		};
		child.stdout.on("error", onStreamError);
		child.stderr.on("error", onStreamError);
		// Test seam: inject a stream error to exercise the path above.
		if (process.env.FABRIC_GATE_TEST_STREAM_ERROR === "1") {
			child.stdout.destroy(new Error("injected stream error"));
		}
	});
}

/**
 * Resolve the git worktree the PR command actually runs in, so the gate
 * validates the branch being PR'd rather than whatever directory the session
 * was launched from. `CLAUDE_PROJECT_DIR` is fixed at session start, so a
 * session opened in the main checkout that `cd`s into a worktree would
 * otherwise gate against the wrong tree. Resolution order, each normalized to
 * its git top-level:
 *   1. a leading `cd <dir> &&` in the command (the effective cwd of the gh call),
 *   2. the session cwd from the hook payload,
 *   3. CLAUDE_PROJECT_DIR (legacy behavior / main-worktree fallback).
 * A candidate that isn't a git worktree is skipped; if none resolve we return
 * CLAUDE_PROJECT_DIR verbatim, so running from the main checkout (no `cd`, cwd
 * == project dir) behaves exactly as before.
 *
 * @param {string} command
 * @param {string | undefined} payloadCwd
 * @returns {string | null}
 */
function resolveRepoRoot(command, payloadCwd) {
	const projectDir = process.env.CLAUDE_PROJECT_DIR;
	const candidates = [
		leadingCdTarget(command),
		payloadCwd,
		projectDir,
	].filter(Boolean);
	for (const dir of candidates) {
		try {
			const top = execFileSync(
				"git",
				["-C", String(dir), "rev-parse", "--show-toplevel"],
				{ stdio: ["ignore", "pipe", "ignore"] },
			)
				.toString()
				.trim();
			if (top) {
				return top;
			}
		} catch {
			// not a git worktree (or git unavailable) — try the next candidate
		}
	}
	return projectDir ?? null;
}

/**
 * Blank out single- and double-quoted spans so gate-matching sees the
 * command's shell structure, not string contents. A `gh pr create` that lives
 * inside quotes — a script argument, an echo, regex test-data like
 * `node -e '… "gh pr create" …'` — is thus ignored, while a real invocation
 * (whose own args may be quoted) still matches. Prevents false-positive gate
 * prompts on commands that merely *mention* the trigger text.
 *
 * @param {string} command
 * @returns {string}
 */
function stripQuotedSpans(command) {
	return command
		.replace(/'(?:[^'\\]|\\.)*'/g, " ")
		.replace(/"(?:[^"\\]|\\.)*"/g, " ");
}

/**
 * Splits a shell command into segments on unquoted `&&`, `||`, `;`, `|`, `&`
 * and newlines, and each segment into words. Words keep their unquoted text
 * (quotes removed, escapes resolved), so `echo "gh api x"` is one `echo`
 * segment with one argument. A `&` that is part of a redirection (`2>&1`,
 * `&>`) does not split. This is a gating heuristic, not a full shell parser:
 * heredocs, `$(…)` bodies and similar are not interpreted.
 *
 * @param {string} command
 * @returns {string[][]}
 */
function splitShellSegments(command) {
	/** @type {string[][]} */
	const segments = [];
	/** @type {string[]} */
	let words = [];
	let word = "";
	let inWord = false;
	const endWord = () => {
		if (inWord) {
			words.push(word);
		}
		word = "";
		inWord = false;
	};
	const endSegment = () => {
		endWord();
		if (words.length > 0) {
			segments.push(words);
		}
		words = [];
	};
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (ch === "\\") {
			// Backslash-newline is a line continuation; otherwise escape the next char.
			if (command[i + 1] === "\n") {
				i++;
			} else if (i + 1 < command.length) {
				word += command[i + 1];
				inWord = true;
				i++;
			}
		} else if (ch === "'") {
			inWord = true;
			const end = command.indexOf("'", i + 1);
			if (end === -1) {
				word += command.slice(i + 1);
				i = command.length;
			} else {
				word += command.slice(i + 1, end);
				i = end;
			}
		} else if (ch === '"') {
			inWord = true;
			i++;
			while (i < command.length && command[i] !== '"') {
				if (command[i] === "\\" && i + 1 < command.length) {
					const next = command[i + 1];
					// Inside double quotes a backslash only escapes these.
					if (
						next === '"' ||
						next === "\\" ||
						next === "$" ||
						next === "`"
					) {
						word += next;
						i += 2;
						continue;
					}
					if (next === "\n") {
						i += 2;
						continue;
					}
				}
				word += command[i];
				i++;
			}
		} else if (ch === "\n" || ch === ";" || ch === "|") {
			endSegment();
		} else if (ch === "&") {
			const prev = command[i - 1];
			const next = command[i + 1];
			if (prev === ">" || prev === "<" || next === ">") {
				word += ch;
				inWord = true;
			} else {
				endSegment();
			}
		} else if (ch === " " || ch === "\t" || ch === "\r") {
			endWord();
		} else {
			word += ch;
			inWord = true;
		}
	}
	endSegment();
	return segments;
}

/** `gh api` flags that consume a value: short letter -> true, long names. */
const GH_API_VALUE_SHORT = new Set(["X", "H", "f", "F", "q", "t", "p"]);
const GH_API_VALUE_LONG = new Set([
	"method",
	"header",
	"raw-field",
	"field",
	"input",
	"jq",
	"template",
	"hostname",
	"cache",
	"preview",
]);
const GH_API_FIELD_FLAGS = new Set(["f", "F", "raw-field", "field"]);

/**
 * Parses the args after `gh api` into method, endpoint and fields.
 *
 * @param {string[]} args
 * @returns {{method: string, endpoint: string, fieldKeys: string[], hasInput: boolean, hasFileField: boolean}}
 */
function parseGhApiArgs(args) {
	let explicitMethod = "";
	let endpoint = "";
	let hasInput = false;
	let hasField = false;
	/** @type {string[]} */
	const fieldKeys = [];
	let hasFileField = false;
	/** @param {string} flag @param {string} value */
	const record = (flag, value) => {
		if (flag === "X" || flag === "method") {
			explicitMethod = value.toUpperCase();
		} else if (flag === "input") {
			hasInput = true;
		} else if (GH_API_FIELD_FLAGS.has(flag)) {
			hasField = true;
			// -F/--field read a value starting with `@` from a file or stdin.
			if (
				(flag === "F" || flag === "field") &&
				value.slice(value.indexOf("=") + 1).startsWith("@") &&
				value.includes("=")
			) {
				hasFileField = true;
			}
			fieldKeys.push(value.split(/[=@]/, 1)[0]);
		}
	};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg.startsWith("--") && arg.length > 2) {
			const eq = arg.indexOf("=");
			const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
			if (GH_API_VALUE_LONG.has(name)) {
				if (eq !== -1) {
					record(name, arg.slice(eq + 1));
				} else {
					record(name, args[i + 1] ?? "");
					i++;
				}
			}
		} else if (arg.startsWith("-") && arg.length > 1) {
			// pflag short cluster: boolean letters are consumed one by one; the
			// first value letter takes the rest of the cluster (minus one
			// leading `=`) or, if nothing is left, the next argument.
			for (let j = 1; j < arg.length; j++) {
				const letter = arg[j];
				if (!GH_API_VALUE_SHORT.has(letter)) {
					continue;
				}
				let rest = arg.slice(j + 1);
				if (rest.startsWith("=")) {
					rest = rest.slice(1);
				}
				if (j + 1 < arg.length) {
					record(letter, rest);
				} else {
					record(letter, args[i + 1] ?? "");
					i++;
				}
				break;
			}
		} else if (!endpoint) {
			endpoint = arg;
		}
	}
	const method = explicitMethod || (hasField || hasInput ? "POST" : "GET");
	return { method, endpoint, fieldKeys, hasInput, hasFileField };
}

/**
 * Decides whether one `gh api` invocation creates a PR or edits a PR body.
 *
 * @param {string[]} args  words after `gh api`
 */
function isGatedGhApiCall(args) {
	const { method, endpoint, fieldKeys, hasInput, hasFileField } =
		parseGhApiArgs(args);
	const path = endpoint
		.replace(/^https?:\/\/[^/]+\//, "")
		.replace(/^\/+/, "")
		.replace(/[?#].*$/, "")
		.replace(/\/+$/, "");
	if (path === "graphql") {
		// A query that arrives opaquely (request body, or a file/stdin field)
		// cannot be inspected, so gate it.
		if (hasInput || hasFileField) {
			return true;
		}
		return args.some(
			(a) =>
				a.includes("createPullRequest") ||
				a.includes("updatePullRequest"),
		);
	}
	if (method === "POST" && /^repos\/[^/]+\/[^/]+\/pulls$/.test(path)) {
		return true;
	}
	if (
		method === "PATCH" &&
		/^repos\/[^/]+\/[^/]+\/pulls\/[^/]+$/.test(path)
	) {
		// --input contents are unknown, so gate conservatively.
		return hasInput || fieldKeys.includes("body");
	}
	return false;
}

/** Strips shell grouping prefixes (`(`, `$(`, `{`, backtick) from a word. */
function bareWord(word) {
	return word.replace(/^[$({`]+/, "");
}

/**
 * True when the command contains a `gh api` call that creates a PR or edits a
 * PR body. Tolerates prefixes (`GH_TOKEN=x`, `timeout 60`, `env`, `command`)
 * by matching `gh` followed by `api` anywhere in a segment, and looks inside
 * `bash -c '<script>'` strings. Over-matching only costs a check run.
 *
 * @param {string} command
 * @param {number} [depth]
 * @returns {boolean}
 */
function isGatedGhApi(command, depth = 0) {
	for (const words of splitShellSegments(command)) {
		for (let i = 0; i < words.length; i++) {
			const word = bareWord(words[i]);
			if (
				depth < 2 &&
				/^(?:.*\/)?(?:ba|z|da|k)?sh$/.test(word) &&
				words.slice(i + 1).includes("-c")
			) {
				const script = words[words.indexOf("-c", i + 1) + 1];
				if (script && isGatedGhApi(script, depth + 1)) {
					return true;
				}
			}
			const base = word.split("/").pop();
			if (base === "gh" && words[i + 1] === "api") {
				if (isGatedGhApiCall(words.slice(i + 2))) {
					return true;
				}
			}
		}
	}
	return false;
}

async function main() {
	let toolCall;
	try {
		toolCall = readToolInput();
	} catch (err) {
		writeFileSync(2, `pr-quality-gate: ${err.message}\n`);
		process.exit(0);
	}

	if (toolCall.tool_name !== "Bash") {
		process.exit(0);
	}
	const command = String(toolCall.tool_input?.command ?? "");
	if (!command) {
		process.exit(0);
	}

	// Match on the command with quoted spans blanked out, so a *mention* of
	// `gh pr create` inside a string / script arg / test-data doesn't trip the
	// gate — only a real, unquoted invocation does.
	const gateCommand = stripQuotedSpans(command);
	if (
		!isGatedGhPrCreate(gateCommand) &&
		!isGatedGhPrEdit(gateCommand) &&
		!isGatedGhApi(command)
	) {
		process.exit(0);
	}

	const repoRoot = resolveRepoRoot(command, toolCall.cwd);
	// Without a repo root we can't run the checks reliably; fail open
	// rather than blocking on an environment quirk.
	if (!repoRoot) {
		writeFileSync(
			2,
			"pr-quality-gate: CLAUDE_PROJECT_DIR not set and no runnable cwd; skipping checks (fail open)\n",
		);
		process.exit(0);
	}

	for (const { argv, label, timeoutMs } of CHECKS) {
		const limitMs = effectiveTimeoutMs(timeoutMs);
		const failure = await runCheck(argv, repoRoot, limitMs);
		if (!failure) {
			continue;
		}
		const tail = tailLines(failure.output, MAX_OUTPUT_LINES);
		// Kept short on purpose: the user reads this in a permission prompt and
		// needs only what failed, what to look at, and what Yes/No do.
		const [headline, review] = failure.timedOut
			? [
					`PR check timed out: \`${label}\` did not finish within ${Number((limitMs / 1000).toFixed(1))}s`,
					"To review: this check ran past its time limit, so its result is unverified.",
				]
			: failure.streamError
				? [
						`PR check unverified: \`${label}\` hit an output stream error`,
						"To review: this check's result is unknown, so treat it as not run.",
					]
				: failure.spawnError
					? [
							`PR check could not start: \`${label}\``,
							"To review: this check did not run; the error below says why.",
						]
					: [
							`PR check failed: \`${label}\` (exit code ${failure.exitCode})`,
							"To review: this check failed; inspect its output below and fix the cause.",
						];
		const reason = [
			headline,
			review,
			"Yes = go ahead with the PR anyway   No = cancel and fix first",
			tail && `\n${tail}`,
		]
			.filter(Boolean)
			.join("\n");
		// Don't hard-block: escalate to the user. They see the findings and
		// decide whether to fix or create the PR anyway. Exit 0 so the "ask"
		// decision JSON is authoritative.
		writeAskDecision(reason);
		process.exit(0);
	}

	process.exit(0);
}

await main();
