#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";
import { writeBlockMessage } from "./lib/block-message.mjs";
import {
	currentBranch,
	isProtectedBranch,
	resolveEffectiveCwd,
} from "./lib/git-helpers.mjs";
import { readToolInput } from "./lib/parse-input.mjs";

/**
 * Sanctioned branch-name prefixes from CONTRIBUTING.md:50-57. Any
 * branch that doesn't start with one of these (followed by `/` and a
 * lowercase token) is blocked from `git push`.
 */
const BRANCH_PATTERN = /^(feature|fix|docs|refactor)\/[a-z0-9._-]+$/;

/**
 * Tag-like positional refs (`v1.2.3`, `v0.0.0-rc.1`). A `git push
 * origin v1.2.3` is a tag push, not a branch push — allow even from a
 * dirty branch name. The destructive-bash hook still gates force-pushes
 * to main/master independently.
 */
const TAG_REF_PATTERN = /^v\d+(\.\d+)*([.-][\w.-]+)?$/;

/**
 * Returns true when the command is unambiguously a tag push and not a
 * branch push. Two signals:
 *  - explicit `--tags` flag
 *  - any positional arg that looks like a semver tag (`v1.2.3`)
 *
 * @param {string} command
 */
function isTagPush(command) {
	if (/\s--tags(\s|$)/.test(command) || /\s--tags=/.test(command)) {
		return true;
	}
	// crude positional scan: anything starting with `v<digit>`
	const tokens = command.split(/\s+/);
	for (const tok of tokens) {
		if (TAG_REF_PATTERN.test(tok)) {
			return true;
		}
	}
	return false;
}

/**
 * Every `git push` / `git -C <dir> push` in a command. Group 1 is the `-C`
 * directory when there is one.
 */
const PUSH_RE = /\bgit\s+(?:-C\s+("[^"]+"|'[^']+'|\S+)\s+)?push\b/;

/**
 * Restrict to `git push` invocations — defense-in-depth in case the
 * `if` pre-filter in settings.json is misconfigured or a test invokes
 * the hook directly.
 *
 * @param {string} command
 */
function isGitPush(command) {
	const trimmed = command.trimStart();
	if (trimmed.startsWith("git push")) {
		return true;
	}
	// chained / wrapped: `bash -c "git push"`, `cd x && git push`
	// also `git -C <dir> push`
	return PUSH_RE.test(command);
}

function main() {
	let toolCall;
	try {
		toolCall = readToolInput();
	} catch (err) {
		process.stderr.write(`enforce-branch-naming: ${err.message}\n`);
		process.exit(0);
	}

	if (toolCall.tool_name !== "Bash") {
		process.exit(0);
	}
	const command = String(toolCall.tool_input?.command ?? "");
	if (!command || !isGitPush(command)) {
		process.exit(0);
	}

	if (isTagPush(command)) {
		process.exit(0);
	}

	// Judge every push by the repo it runs in. The session's directory, moved
	// by a leading literal `cd <dir> &&`, is the default; `git -C <dir> push`
	// is judged by <dir> instead. A -C directory that is not a plain literal
	// path (variable, substitution, `..`) or a leading `cd` target that does
	// not exist says nothing about where the push runs, so those are judged by
	// the session directory exactly as before.
	let base = resolveEffectiveCwd(command, toolCall.cwd);
	if (base && !existsSync(base)) {
		base = toolCall.cwd || undefined;
	}
	let offending = null;
	for (const push of command.matchAll(new RegExp(PUSH_RE.source, "g"))) {
		const raw = push[1]?.replace(/^(["'])(.*)\1$/, "$2");
		const literal = raw && !/[$`()~\\]|(^|\/)\.\.(\/|$)/.test(raw);
		const dir = literal ? path.resolve(base ?? process.cwd(), raw) : base;
		const branch = currentBranch(dir && existsSync(dir) ? dir : base);
		// detached HEAD / non-git context (null) fails open; protected branches
		// are allowed (force-push is handled by block-destructive-bash.mjs)
		if (
			branch !== null &&
			!isProtectedBranch(branch) &&
			!BRANCH_PATTERN.test(branch)
		) {
			offending = branch;
			break;
		}
	}
	if (offending === null) {
		process.exit(0);
	}
	const branch = offending;

	writeBlockMessage({
		command,
		reason: `branch '${branch}' does not match required prefix (feature|fix|docs|refactor)/<name>`,
		sourceRef: "CONTRIBUTING.md:50-57",
		proceedHint:
			"rename the branch (`git branch -m feature/<name>`) and push, " +
			'or set "disableAllHooks": true in .claude/settings.local.json',
	});
	process.exit(2);
}

main();
