#!/usr/bin/env node
import { writeBlockMessage } from "./lib/block-message.mjs";
import {
	isDirty,
	isProtectedBranch,
	resolveEffectiveCwd,
} from "./lib/git-helpers.mjs";
import { readToolInput } from "./lib/parse-input.mjs";

/**
 * Tokenize a command roughly like a POSIX shell. Treats whitespace as
 * the token delimiter both inside and outside quotes — so
 * `bash -c "git clean -fd"` tokenizes to
 * `["bash", "-c", "git", "clean", "-fd"]`. That's intentional: we want
 * the inner `git` command to be inspectable just like an unwrapped one
 * (spec §3.1 footer: shell wrappers must hit the same regex).
 *
 * @param {string} command
 * @returns {string[]}
 */
function tokenize(command) {
	const tokens = [];
	let buf = "";
	for (const ch of command) {
		if (ch === '"' || ch === "'") {
			continue;
		}
		if (/\s/.test(ch)) {
			if (buf) {
				tokens.push(buf);
				buf = "";
			}
			continue;
		}
		buf += ch;
	}
	if (buf) {
		tokens.push(buf);
	}
	return tokens;
}

/**
 * Find every contiguous run of `git` invocations inside the command.
 * Handles plain `git clean -fd`, wrapped `bash -c "git clean -fd"`,
 * and chained `cd foo && git clean -fd` by treating each `git` token
 * as the start of a subcommand window.
 *
 * @param {string[]} tokens
 * @returns {{argv: string[]}[]}
 */
function findGitInvocations(tokens) {
	const STOPS = new Set(["&&", "||", ";", "|", "&"]);
	const out = [];
	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i] !== "git") {
			continue;
		}
		const argv = [];
		for (let j = i + 1; j < tokens.length; j++) {
			if (STOPS.has(tokens[j])) {
				break;
			}
			argv.push(tokens[j]);
		}
		out.push({ argv });
	}
	return out;
}

/**
 * `git clean` with both `-f` (or `--force`) AND `-d` present.
 * Detects combined flags like `-fd`, `-fdx`, `-df`, etc.
 *
 * @param {string[]} argv
 */
function isDestructiveGitClean(argv) {
	if (argv[0] !== "clean") {
		return false;
	}
	let hasForce = false;
	let hasDir = false;
	for (const tok of argv.slice(1)) {
		if (tok === "--force") {
			hasForce = true;
			continue;
		}
		if (tok.startsWith("--")) {
			continue;
		}
		if (tok.startsWith("-") && !tok.startsWith("--")) {
			const flags = tok.slice(1);
			if (flags.includes("f")) {
				hasForce = true;
			}
			if (flags.includes("d")) {
				hasDir = true;
			}
		}
	}
	return hasForce && hasDir;
}

/**
 * `git push` against a protected branch with any `--force` variant.
 *
 * @param {string[]} argv
 */
function isForcePushToProtected(argv) {
	if (argv[0] !== "push") {
		return false;
	}
	const hasForce = argv.some(
		(t) =>
			t === "--force" ||
			t === "-f" ||
			t === "--force-with-lease" ||
			t.startsWith("--force-with-lease="),
	);
	if (!hasForce) {
		return false;
	}
	for (const tok of argv.slice(1)) {
		if (tok.startsWith("-")) {
			continue;
		}
		const bare = tok.replace(/^(origin\/|refs\/heads\/)/, "");
		if (isProtectedBranch(bare)) {
			return true;
		}
	}
	return false;
}

/**
 * @param {string[]} argv
 */
function isGitResetHard(argv) {
	if (argv[0] !== "reset") {
		return false;
	}
	return argv.includes("--hard");
}

/**
 * `git checkout .` or `git restore .` — any positional `.` argument
 * after the subcommand.
 *
 * @param {string[]} argv
 */
function isWholeTreeRevert(argv) {
	const sub = argv[0];
	if (sub !== "checkout" && sub !== "restore") {
		return false;
	}
	for (const tok of argv.slice(1)) {
		if (tok === ".") {
			return true;
		}
	}
	return false;
}

/**
 * `git branch -D main|master` (or other protected names).
 *
 * @param {string[]} argv
 */
function isDeleteProtectedBranch(argv) {
	if (argv[0] !== "branch") {
		return false;
	}
	if (!argv.includes("-D") && !argv.includes("--delete")) {
		return false;
	}
	for (const tok of argv.slice(1)) {
		if (tok.startsWith("-")) {
			continue;
		}
		if (isProtectedBranch(tok)) {
			return true;
		}
	}
	return false;
}

/**
 * @param {string[]} tokens
 */
function isCatastrophicRm(tokens) {
	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i] !== "rm") {
			continue;
		}
		const flagBlob = [];
		const positional = [];
		for (const tok of tokens.slice(i + 1)) {
			if (tok === "&&" || tok === "||" || tok === ";") {
				break;
			}
			if (tok.startsWith("-")) {
				flagBlob.push(tok);
			} else {
				positional.push(tok);
			}
		}
		const flags = flagBlob.join("");
		const recursive =
			flags.includes("r") ||
			flags.includes("R") ||
			flagBlob.includes("--recursive");
		const force = flags.includes("f") || flagBlob.includes("--force");
		if (!recursive || !force) {
			continue;
		}
		for (const p of positional) {
			if (
				p === "/" ||
				p === "/*" ||
				p === "~" ||
				p === "$HOME" ||
				p === "${HOME}" ||
				p === "."
			) {
				return true;
			}
		}
	}
	return false;
}

/**
 * `chmod -R 777` against anything.
 *
 * @param {string[]} tokens
 */
function isWorldWritableChmod(tokens) {
	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i] !== "chmod") {
			continue;
		}
		const rest = tokens.slice(i + 1);
		const recursive = rest.includes("-R") || rest.includes("--recursive");
		if (!recursive) {
			continue;
		}
		if (rest.some((t) => t === "777")) {
			return true;
		}
	}
	return false;
}

/**
 * `curl ... | sh|bash` or `wget ... | sh|bash`.
 *
 * @param {string} command
 */
function isPipeToShell(command) {
	return /\b(curl|wget)\b[^|]*\|\s*(sh|bash)\b/.test(command);
}

/**
 * @typedef {Object} BlockHit
 * @property {string} reason
 * @property {string} sourceRef
 */

/**
 * @param {string} command
 * @returns {BlockHit | null}
 */
function evaluate(command, cwd) {
	const tokens = tokenize(command);
	const gitInvocations = findGitInvocations(tokens);

	for (const { argv } of gitInvocations) {
		if (isDestructiveGitClean(argv)) {
			return {
				reason: "git clean wipes untracked files including the agents/ tree — use `pnpm clean` or remove specific dirs",
				sourceRef: "CLAUDE.md:45",
			};
		}
		if (isForcePushToProtected(argv)) {
			return {
				reason: "force-push against main/master is forbidden",
				sourceRef: "CLAUDE.md (protected branches)",
			};
		}
		if (isGitResetHard(argv) && isDirty(cwd)) {
			return {
				reason: "`git reset --hard` would discard uncommitted work in the current tree",
				sourceRef: "CLAUDE.md (destructive git operations)",
			};
		}
		if (isWholeTreeRevert(argv) && isDirty(cwd)) {
			return {
				reason: "`git checkout .` / `git restore .` would discard uncommitted work",
				sourceRef: "CLAUDE.md (destructive git operations)",
			};
		}
		if (isDeleteProtectedBranch(argv)) {
			return {
				reason: "deleting the local copy of main/master is forbidden",
				sourceRef: "CLAUDE.md (protected branches)",
			};
		}
	}

	if (isCatastrophicRm(tokens)) {
		return {
			reason: "`rm -rf` of $HOME, /, /*, ~, or the working tree is catastrophic",
			sourceRef: "CLAUDE.md (destructive bash)",
		};
	}

	if (isWorldWritableChmod(tokens)) {
		return {
			reason: "`chmod -R 777` makes paths world-writable — almost never the intent",
			sourceRef: "CLAUDE.md (destructive bash)",
		};
	}

	if (isPipeToShell(command)) {
		return {
			reason: "piping curl/wget output into a shell executes opaque remote code",
			sourceRef: "CLAUDE.md (destructive bash)",
		};
	}

	return null;
}

function main() {
	let toolCall;
	try {
		toolCall = readToolInput();
	} catch (err) {
		process.stderr.write(`block-destructive-bash: ${err.message}\n`);
		process.exit(0);
	}

	if (toolCall.tool_name !== "Bash") {
		process.exit(0);
	}
	const command = String(toolCall.tool_input?.command ?? "");
	if (!command) {
		process.exit(0);
	}

	const hit = evaluate(command, resolveEffectiveCwd(command, toolCall.cwd));
	if (!hit) {
		process.exit(0);
	}

	writeBlockMessage({
		command,
		reason: hit.reason,
		sourceRef: hit.sourceRef,
	});
	process.exit(2);
}

main();
