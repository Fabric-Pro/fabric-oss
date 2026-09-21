/**
 * The coding-tool SessionStart hook that keeps a checkout current.
 *
 * Claude Code writes `.claude/settings.local.json` and never `settings.json`;
 * Codex writes `.codex/hooks.json`. Both are per-developer, normally
 * untracked files. A hook committed into a repository runs on everybody's
 * machine with whatever credentials they happen to have.
 *
 * The command never carries the key. It names a project and nothing else —
 * the CLI reads its credential from `FABRIC_API_KEY` or from the per-user
 * config file, both outside the repository. `assertKeyStaysOutside` is what
 * makes that a guarantee rather than a habit, and it compares REAL paths:
 * a config directory reached through a symlink into the checkout is inside
 * it however the string is spelled.
 *
 * `matcher` is deliberately omitted so the hook runs on startup, resume,
 * clear and compact alike: a session resumed after a pull is exactly when the
 * published version is most likely to have moved.
 */
import path from "node:path";
import {
	readFileSafely,
	resolvesInside,
	writeFileSafely,
} from "./safe-write.js";

export type InstructionsHookTool = "claude-code" | "codex";

export const CLAUDE_SETTINGS_RELATIVE_PATH = path.join(
	".claude",
	"settings.local.json",
);

export const CODEX_HOOKS_RELATIVE_PATH = path.join(".codex", "hooks.json");

/** The same path in the POSIX spelling the guarded writer expects. */
const CLAUDE_SETTINGS_POSIX_PATH = ".claude/settings.local.json";
const CODEX_HOOKS_POSIX_PATH = ".codex/hooks.json";

/** Seconds. Long enough for a cold start plus one manifest call, short enough to be invisible. */
const HOOK_TIMEOUT_SECONDS = 15;

/** Local hook configuration is small; a bound prevents an untrusted file from consuming memory. */
const MAX_HOOK_CONFIG_BYTES = 1024 * 1024;

/** The subcommands a hook this tool wrote may name. */
const HOOK_SUBCOMMANDS = new Set(["check", "sync"]);

interface CommandHook {
	type: "command";
	command: string;
	timeout?: number;
	[key: string]: unknown;
}

interface HookGroup {
	matcher?: string;
	hooks: CommandHook[];
	[key: string]: unknown;
}

export interface MergeHookResult {
	settingsPath: string;
	command: string;
	/** True when the settings file did not exist before. */
	createdFile: boolean;
	/** How many existing Fabric hooks for this project were replaced or dropped. */
	replacedCount: number;
}

/**
 * The command the session hook runs.
 *
 * An explicit `--org` is carried through when `init` was given one. These
 * commands do not consult a stored default context, so a slug that was
 * supplied once on the command line has nowhere else to live — leaving it out
 * would install a hook that binds differently from the `init` that created
 * it. It still never carries the key.
 */
export function buildHookCommand(
	projectId: string,
	apply: boolean,
	org?: string,
): string {
	const verb = apply ? "sync" : "check";
	const context = org ? ` --org ${org}` : "";
	return `fabric instructions ${verb} --project ${projectId}${context} --hook`;
}

/**
 * Would writing this hook put the API key inside the repository?
 *
 * The hook itself carries no key, so the only way one lands in the tree is
 * the CLI's own config file being stored there — which happens when
 * `XDG_CONFIG_HOME` or `APPDATA` points inside the checkout, including
 * through a symlink. Refuse rather than write a hook whose credential source
 * a `git add -A` would commit.
 */
export async function assertKeyStaysOutside(
	destination: string,
	configPath: string,
): Promise<void> {
	if (await resolvesInside(destination, configPath)) {
		throw new Error(
			`The CLI stores its API key at ${configPath}, which resolves inside ${destination}. Writing a session hook here would leave a live credential in the repository. Move the CLI config outside the project (set XDG_CONFIG_HOME) or export FABRIC_API_KEY instead, then run this again.`,
		);
	}
}

/**
 * Add — or replace — the Fabric SessionStart hook for one project.
 *
 * Idempotent by project id, and idempotent across a file that already has
 * duplicates: EVERY matching entry is removed and exactly one is written
 * back. Matching is on parsed argv tokens, not on a substring — `--project
 * abc` must not match `--project abc-extra`, and `--project=abc` is the same
 * request written differently. Every other key in the file, and every other
 * hook, is preserved exactly.
 */
export async function mergeSessionStartHook(input: {
	/** An already-canonical destination from `resolveDestinationRoot`. */
	root: string;
	projectId: string;
	command: string;
	tool?: InstructionsHookTool;
}): Promise<MergeHookResult> {
	const hookTarget = hookTargetFor(input.tool ?? "claude-code");
	const settingsPath = path.join(input.root, hookTarget.relativePath);

	let existingRaw: string | null;
	try {
		const existing = await readFileSafely(
			input.root,
			hookTarget.posixPath,
			{ maxBytes: MAX_HOOK_CONFIG_BYTES },
		);
		existingRaw =
			existing === null ? null : new TextDecoder().decode(existing.bytes);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`${settingsPath} could not be read safely: ${message}. It was left untouched.`,
		);
	}

	let settings: Record<string, unknown> = {};
	if (existingRaw !== null) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(existingRaw);
		} catch {
			// Refused, never rewritten: this file is the developer's own, and
			// a JSON error in it is nearly always a half-finished edit rather
			// than something to discard.
			throw new Error(
				`${settingsPath} is not valid JSON. Fix or remove it, then run this again — it was left untouched.`,
			);
		}
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			Array.isArray(parsed)
		) {
			throw new Error(
				`${settingsPath} does not contain a JSON object. It was left untouched.`,
			);
		}
		settings = parsed as Record<string, unknown>;
	}

	// Every nested shape is checked before anything is rebuilt. Top-level JSON
	// was refused carefully and these were not: `{"hooks": ["custom"]}` or a
	// `SessionStart` that is not an array used to be replaced with a
	// freshly-built hooks object, discarding whatever the developer had. A
	// shape this tool does not understand is no more ours to normalise than a
	// half-finished edit is.
	if (settings.hooks !== undefined && !isRecord(settings.hooks)) {
		throw refuseShape(settingsPath, '"hooks" is not an object');
	}
	const hooks = isRecord(settings.hooks) ? { ...settings.hooks } : {};
	if (
		hooks.SessionStart !== undefined &&
		!Array.isArray(hooks.SessionStart)
	) {
		throw refuseShape(settingsPath, '"hooks.SessionStart" is not an array');
	}
	const rawGroups = Array.isArray(hooks.SessionStart)
		? hooks.SessionStart
		: [];
	for (const [index, group] of rawGroups.entries()) {
		if (!isRecord(group)) {
			throw refuseShape(
				settingsPath,
				`"hooks.SessionStart[${index}]" is not an object`,
			);
		}
		if (group.hooks !== undefined && !Array.isArray(group.hooks)) {
			throw refuseShape(
				settingsPath,
				`"hooks.SessionStart[${index}].hooks" is not an array`,
			);
		}
	}
	const sessionStart: HookGroup[] = (rawGroups as HookGroup[]).map(
		(group) => ({
			...group,
			hooks: Array.isArray(group?.hooks) ? [...group.hooks] : [],
		}),
	);

	const replacement: CommandHook = {
		type: "command",
		command: input.command,
		timeout: HOOK_TIMEOUT_SECONDS,
	};

	// Remove EVERY entry for this project first, then add one back. Replacing
	// in place and stopping at the first match left duplicates behind, and a
	// file that has accumulated two of our hooks should come out with one.
	let replacedCount = 0;
	const pruned: HookGroup[] = [];
	for (const group of sessionStart) {
		const kept = group.hooks.filter(
			(hook) => !isFabricHookFor(hook, input.projectId),
		);
		const removed = group.hooks.length - kept.length;
		replacedCount += removed;
		// A group we emptied held nothing but our own hook; leaving
		// `{hooks: []}` behind would accumulate one husk per run. A group
		// that was ALREADY empty is somebody else's and is kept untouched,
		// which is why this turns on `removed` rather than on length alone.
		if (kept.length === 0 && removed > 0) {
			continue;
		}
		pruned.push({ ...group, hooks: kept });
	}

	pruned.push({ hooks: [replacement] });

	const next = {
		...settings,
		hooks: { ...hooks, SessionStart: pruned },
	};

	await writeFileSafely({
		root: input.root,
		relativePath: hookTarget.posixPath,
		bytes: new TextEncoder().encode(
			`${JSON.stringify(next, null, 2).replace(/\r\n/g, "\n")}\n`,
		),
	});

	return {
		settingsPath,
		command: input.command,
		createdFile: existingRaw === null,
		replacedCount,
	};
}

function hookTargetFor(tool: InstructionsHookTool): {
	relativePath: string;
	posixPath: string;
} {
	return tool === "codex"
		? {
				relativePath: CODEX_HOOKS_RELATIVE_PATH,
				posixPath: CODEX_HOOKS_POSIX_PATH,
			}
		: {
				relativePath: CLAUDE_SETTINGS_RELATIVE_PATH,
				posixPath: CLAUDE_SETTINGS_POSIX_PATH,
			};
}

/**
 * Is this hook one this tool wrote for this project?
 *
 * Token-exact. The command is split on whitespace — every command this tool
 * generates is a plain, unquoted argv line, so a command that needs shell
 * quoting to parse is by definition not ours.
 */
function isFabricHookFor(hook: unknown, projectId: string): boolean {
	if (!isRecord(hook) || typeof hook.command !== "string") {
		return false;
	}
	const tokens = hook.command.trim().split(/\s+/);
	if (tokens[0] !== "fabric" || tokens[1] !== "instructions") {
		return false;
	}
	if (tokens[2] === undefined || !HOOK_SUBCOMMANDS.has(tokens[2])) {
		return false;
	}
	return readProjectToken(tokens) === projectId;
}

/**
 * The `--project` value, from either `--project X` or `--project=X`, and only
 * when the command names exactly one.
 *
 * `fabric instructions check --project other --project target --hook` is a
 * command Commander resolves to `target`, while reading the first occurrence
 * answers `other`. Either reading makes this matcher wrong about somebody's
 * hook: merging for `other` would delete a hook that syncs `target`, and
 * merging for `target` would leave that entry behind and add a second. A
 * command this tool did not write is not this tool's to rewrite, so an
 * ambiguous one is left exactly as it is.
 */
function readProjectToken(tokens: string[]): string | null {
	let found: string | null = null;
	let occurrences = 0;
	for (let index = 3; index < tokens.length; index++) {
		const token = tokens[index] as string;
		if (token === "--project") {
			occurrences++;
			found = tokens[index + 1] ?? null;
			continue;
		}
		if (token.startsWith("--project=")) {
			occurrences++;
			found = token.slice("--project=".length);
		}
	}
	return occurrences === 1 ? found : null;
}

/** The same refusal shape as an unparseable file: say what, and touch nothing. */
function refuseShape(settingsPath: string, what: string): Error {
	return new Error(
		`${settingsPath} has a shape this tool does not recognise: ${what}. Fix or remove it, then run this again — it was left untouched.`,
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
