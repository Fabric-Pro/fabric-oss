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

/**
 * Every subcommand a hook this tool wrote may name, across every event.
 * `isFabricHookFor`'s default: a caller that does not need to distinguish
 * `check`/`sync` from `lesson-prompt` still matches anything this tool wrote.
 */
const HOOK_SUBCOMMANDS = new Set(["check", "sync", "lesson-prompt"]);

/**
 * The event this feature writes hooks under, and the subcommands each event
 * may hold. A `lesson-prompt` entry must never be matched (and so never
 * removed) by a `SessionStart` merge, and a `check`/`sync` entry must never be
 * matched by the `Stop` merge — even though today the two events already live
 * under different JSON keys and so cannot collide in practice, matching is
 * scoped explicitly rather than resting on that.
 */
export type HookEvent = "SessionStart" | "Stop";

const SESSION_START_SUBCOMMANDS: ReadonlySet<string> = new Set([
	"check",
	"sync",
]);
const STOP_SUBCOMMANDS: ReadonlySet<string> = new Set(["lesson-prompt"]);

function subcommandsForEvent(event: HookEvent): ReadonlySet<string> {
	return event === "Stop" ? STOP_SUBCOMMANDS : SESSION_START_SUBCOMMANDS;
}

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

export interface RemoveHookResult {
	settingsPath: string;
	/**
	 * Whether any Fabric-authored entry for this project and subcommand was
	 * removed. `false` means the file was left byte-for-byte untouched — this
	 * function never creates the settings file and never writes when there is
	 * nothing to remove.
	 */
	changed: boolean;
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
 * The command the Stop hook runs for lesson capture. Same shape as
 * {@link buildHookCommand} — no key, an explicit `--org` carried through when
 * `init` was given one — but a fixed subcommand, because there is no
 * apply/report distinction for a hook that only ever asks a question.
 */
export function buildLessonPromptCommand(
	projectId: string,
	org?: string,
): string {
	const context = org ? ` --org ${org}` : "";
	return `fabric instructions lesson-prompt --project ${projectId}${context} --hook`;
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
 * Read and shape-check the hook config file, returning the parsed top-level
 * object (`{}` when the file does not exist) and the raw text that was read
 * (`null` when it does not exist). Shared by every reader below so a refusal
 * reads the same regardless of which event it was checking.
 */
async function readHookConfig(
	root: string,
	hookTarget: { relativePath: string; posixPath: string },
): Promise<{ settings: Record<string, unknown>; existingRaw: string | null }> {
	const settingsPath = path.join(root, hookTarget.relativePath);

	let existingRaw: string | null;
	try {
		const existing = await readFileSafely(root, hookTarget.posixPath, {
			maxBytes: MAX_HOOK_CONFIG_BYTES,
		});
		existingRaw =
			existing === null ? null : new TextDecoder().decode(existing.bytes);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`${settingsPath} could not be read safely: ${message}. It was left untouched.`,
		);
	}

	if (existingRaw === null) {
		return { settings: {}, existingRaw: null };
	}

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
	return { settings: parsed as Record<string, unknown>, existingRaw };
}

/**
 * Shape-check `hooks[event]` and return it as deep-cloned, well-formed
 * groups. Every nested shape is checked before anything is rebuilt: top-level
 * JSON is refused carefully above, and these were not — `{"hooks": ["custom"]}`
 * or a `SessionStart` that is not an array used to be replaced with a
 * freshly-built hooks object, discarding whatever the developer had. A shape
 * this tool does not understand is no more ours to normalise than a
 * half-finished edit is. Every event OTHER than `event` is left in `hooks` as
 * an opaque, untouched value — this function only looks at the one key it was
 * asked about.
 */
function readEventGroups(
	settingsPath: string,
	settings: Record<string, unknown>,
	event: HookEvent,
): { hooks: Record<string, unknown>; groups: HookGroup[] } {
	if (settings.hooks !== undefined && !isRecord(settings.hooks)) {
		throw refuseShape(settingsPath, '"hooks" is not an object');
	}
	const hooks = isRecord(settings.hooks) ? { ...settings.hooks } : {};
	if (hooks[event] !== undefined && !Array.isArray(hooks[event])) {
		throw refuseShape(settingsPath, `"hooks.${event}" is not an array`);
	}
	const rawGroups = Array.isArray(hooks[event]) ? hooks[event] : [];
	for (const [index, group] of rawGroups.entries()) {
		if (!isRecord(group)) {
			throw refuseShape(
				settingsPath,
				`"hooks.${event}[${index}]" is not an object`,
			);
		}
		if (group.hooks !== undefined && !Array.isArray(group.hooks)) {
			throw refuseShape(
				settingsPath,
				`"hooks.${event}[${index}].hooks" is not an array`,
			);
		}
	}
	const groups: HookGroup[] = (rawGroups as HookGroup[]).map((group) => ({
		...group,
		hooks: Array.isArray(group?.hooks) ? [...group.hooks] : [],
	}));
	return { hooks, groups };
}

/**
 * Remove every hook matching `projectId` and `subcommands` from `groups`,
 * dropping a group that held nothing else. Shared pruning step behind both
 * the merge (which adds one entry back) and the remove (which does not).
 */
function pruneMatching(
	groups: HookGroup[],
	projectId: string,
	subcommands: ReadonlySet<string>,
): { pruned: HookGroup[]; removedCount: number } {
	let removedCount = 0;
	const pruned: HookGroup[] = [];
	for (const group of groups) {
		const kept = group.hooks.filter(
			(hook) => !isFabricHookFor(hook, projectId, subcommands),
		);
		const removed = group.hooks.length - kept.length;
		removedCount += removed;
		// A group we emptied held nothing but our own hook; leaving
		// `{hooks: []}` behind would accumulate one husk per run. A group
		// that was ALREADY empty is somebody else's and is kept untouched,
		// which is why this turns on `removed` rather than on length alone.
		if (kept.length === 0 && removed > 0) {
			continue;
		}
		pruned.push({ ...group, hooks: kept });
	}
	return { pruned, removedCount };
}

/**
 * Add — or replace — the Fabric hook for one project under one event
 * (`SessionStart` or `Stop`).
 *
 * Idempotent by project id, and idempotent across a file that already has
 * duplicates: EVERY matching entry for that event is removed and exactly one
 * is written back. Matching is on parsed argv tokens, not on a substring —
 * `--project abc` must not match `--project abc-extra`, and `--project=abc`
 * is the same request written differently. Every other key in the file,
 * every other event's array, and every other hook, is preserved exactly.
 */
export async function mergeCommandHook(input: {
	/** An already-canonical destination from `resolveDestinationRoot`. */
	root: string;
	projectId: string;
	command: string;
	tool?: InstructionsHookTool;
	event: HookEvent;
}): Promise<MergeHookResult> {
	const hookTarget = hookTargetFor(input.tool ?? "claude-code");
	const settingsPath = path.join(input.root, hookTarget.relativePath);
	const { settings, existingRaw } = await readHookConfig(
		input.root,
		hookTarget,
	);
	const { hooks, groups } = readEventGroups(
		settingsPath,
		settings,
		input.event,
	);

	const replacement: CommandHook = {
		type: "command",
		command: input.command,
		timeout: HOOK_TIMEOUT_SECONDS,
	};

	// Remove EVERY entry for this project first, then add one back. Replacing
	// in place and stopping at the first match left duplicates behind, and a
	// file that has accumulated two of our hooks should come out with one.
	const { pruned, removedCount } = pruneMatching(
		groups,
		input.projectId,
		subcommandsForEvent(input.event),
	);
	pruned.push({ hooks: [replacement] });

	const next = {
		...settings,
		hooks: { ...hooks, [input.event]: pruned },
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
		replacedCount: removedCount,
	};
}

/**
 * `mergeCommandHook`, fixed to the `SessionStart` event — the shape every
 * existing caller of this module already depends on. Kept as its own export,
 * with its exact original signature, so nothing that already calls it has to
 * change.
 */
export async function mergeSessionStartHook(input: {
	/** An already-canonical destination from `resolveDestinationRoot`. */
	root: string;
	projectId: string;
	command: string;
	tool?: InstructionsHookTool;
}): Promise<MergeHookResult> {
	return mergeCommandHook({ ...input, event: "SessionStart" });
}

/**
 * Remove every Fabric-authored hook for one project AND one subcommand,
 * under one event. `init` uses this to describe the DESIRED state: re-running
 * it without `--lessons` uninstalls a Stop hook a previous run installed.
 *
 * Never creates the settings file, and never writes to it when nothing
 * matches — the file is left byte-for-byte untouched, which is what lets a
 * plain `init` (no lesson hook ever installed) keep producing exactly the
 * bytes it always has.
 */
export async function removeCommandHook(input: {
	/** An already-canonical destination from `resolveDestinationRoot`. */
	root: string;
	projectId: string;
	subcommand: string;
	tool?: InstructionsHookTool;
	event: HookEvent;
}): Promise<RemoveHookResult> {
	const hookTarget = hookTargetFor(input.tool ?? "claude-code");
	const settingsPath = path.join(input.root, hookTarget.relativePath);
	const { settings, existingRaw } = await readHookConfig(
		input.root,
		hookTarget,
	);

	if (existingRaw === null) {
		return { settingsPath, changed: false };
	}

	const { hooks, groups } = readEventGroups(
		settingsPath,
		settings,
		input.event,
	);
	const { pruned, removedCount } = pruneMatching(
		groups,
		input.projectId,
		new Set([input.subcommand]),
	);

	if (removedCount === 0) {
		// Nothing matched: leave the file exactly as it was read, not even a
		// round-tripped re-serialisation of it.
		return { settingsPath, changed: false };
	}

	const next = {
		...settings,
		hooks: { ...hooks, [input.event]: pruned },
	};

	await writeFileSafely({
		root: input.root,
		relativePath: hookTarget.posixPath,
		bytes: new TextEncoder().encode(
			`${JSON.stringify(next, null, 2).replace(/\r\n/g, "\n")}\n`,
		),
	});

	return { settingsPath, changed: true };
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
 * Is this hook one this tool wrote for this project (and, when given, one of
 * `subcommands`)?
 *
 * Token-exact. The command is split on whitespace — every command this tool
 * generates is a plain, unquoted argv line, so a command that needs shell
 * quoting to parse is by definition not ours.
 *
 * `subcommands` defaults to every subcommand this tool has ever written
 * (`HOOK_SUBCOMMANDS`) rather than narrowing automatically, so a caller that
 * needs `check`/`sync` kept apart from `lesson-prompt` passes the narrower set
 * explicitly — see `subcommandsForEvent`.
 */
function isFabricHookFor(
	hook: unknown,
	projectId: string,
	subcommands: ReadonlySet<string> = HOOK_SUBCOMMANDS,
): boolean {
	if (!isRecord(hook) || typeof hook.command !== "string") {
		return false;
	}
	const tokens = hook.command.trim().split(/\s+/);
	if (tokens[0] !== "fabric" || tokens[1] !== "instructions") {
		return false;
	}
	if (tokens[2] === undefined || !subcommands.has(tokens[2])) {
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
