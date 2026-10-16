/**
 * Registering a rendered plugin with a coding tool.
 *
 * Claude Code: a marketplace folder of one plugin, with a `command` source, is
 * written to the CLI's cache; the project's `.claude/settings.local.json`
 * declares it as a `directory` marketplace and turns the plugin on. Claude Code
 * runs the command (our `render`) when the plugin installs and once per
 * session, so nothing about the instructions is stored in the settings; only
 * how to get them. The person approves that exact command once, in their own
 * terminal; Claude Code refuses the approval from anywhere else.
 *
 * Codex: the personal marketplace file (`~/.agents/plugins/marketplace.json`)
 * gets a `local` entry for the rendered folder. The file belongs to the person
 * and may list other plugins, so it is merged, never replaced, and one written
 * by something else that is not the shape expected is left alone.
 *
 * Codex has no plugin slot for an always-on memory file, so the text goes in a
 * git-excluded `AGENTS.override.md` at the project root: the tracked
 * `AGENTS.md`, then the instructions, so the override never hides the tracked
 * file's own words.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { CliFailure } from "../command-boundary.js";
import { objectAt, updateHookConfig } from "../instructions/hook.js";
import {
	isFabricAgentsOverride,
	mergedAgentsOverride,
	pluginNameFor,
} from "./layout.js";

/** Claude Code's limits on a `command` plugin source's command line. */
const COMMAND_MAX_LENGTH = 500;

/** Seconds Claude Code gives the render command: a cold start fetches every file. */
const RENDER_TIMEOUT_SECONDS = 120;

function marketplaceNameFor(projectId: string): string {
	return pluginNameFor(projectId);
}

/** The id of the plugin in settings: `<plugin>@<marketplace>`. */
export function pluginIdFor(projectId: string): string {
	return `${pluginNameFor(projectId)}@${marketplaceNameFor(projectId)}`;
}

/**
 * Is this command line one Claude Code accepts for a `command` source? It must
 * be printable ASCII, at most 500 characters, with no run of four spaces: the
 * person is shown the whole string to approve, and a line that hides text in
 * whitespace or non-ASCII characters is refused.
 */
export function commandLineProblem(command: string): string | null {
	if (command.length > COMMAND_MAX_LENGTH) {
		return `is ${command.length} characters, and Claude Code accepts at most ${COMMAND_MAX_LENGTH}`;
	}
	if (!/^[\x20-\x7e]+$/.test(command)) {
		return "has characters other than printable ASCII";
	}
	if (/ {4,}/.test(command)) {
		return "has a run of four or more spaces";
	}
	return null;
}

/**
 * The command Claude Code runs to render the plugin. `launcherPrefix` is how
 * hooks start this CLI (`fabric`, or `node <kept copy>`); where it is a node
 * script, node is named by its absolute path so the command does not depend on
 * what a shell finds on its PATH. Windows runs it through `cmd.exe` from the
 * home directory, so paths are quoted when they hold a space and written with
 * forward slashes (`pathAsCommandWord`).
 */
export function renderCommandLine(input: {
	launcherPrefix: string;
	/** The node binary's absolute path as a command word, or `null` to use `node`. */
	nodeWord: string | null;
	projectId: string;
	baseUrl?: string;
	org?: string;
}): string {
	const prefix =
		input.nodeWord !== null && input.launcherPrefix.startsWith("node ")
			? `${input.nodeWord} ${input.launcherPrefix.slice("node ".length)}`
			: input.launcherPrefix;
	const parts = [
		prefix,
		"instructions",
		"render",
		"--project",
		input.projectId,
	];
	if (input.baseUrl) {
		parts.push("--base-url", input.baseUrl);
	}
	if (input.org) {
		parts.push("--org", input.org);
	}
	const command = parts.join(" ");
	const problem = commandLineProblem(command);
	if (problem !== null) {
		throw new CliFailure(
			`The command that renders the plugin ${problem}. Claude Code would refuse it. Move the CLI's config folder to a plain path (set XDG_CONFIG_HOME, or APPDATA on Windows) and run this again.`,
			7,
		);
	}
	return command;
}

/** Where the project's one-plugin marketplace is written: a folder of its own in the CLI's cache. */
export function claudeMarketplaceDirectory(
	cacheDirectory: string,
	projectId: string,
): string {
	return path.join(
		cacheDirectory,
		"marketplaces",
		marketplaceNameFor(projectId),
	);
}

/**
 * The marketplace file for the project: one plugin, built by `command` at
 * install and once per session. Nothing about the instructions is in it, only
 * how to get them.
 */
function claudeMarketplace(input: {
	projectId: string;
	command: string;
}): Record<string, unknown> {
	return {
		name: marketplaceNameFor(input.projectId),
		owner: { name: "Fabric" },
		plugins: [
			{
				name: pluginNameFor(input.projectId),
				description:
					"Coding instructions for a Fabric project, rendered on demand.",
				source: {
					source: "command",
					command: input.command,
					mode: "copy",
					timeout: RENDER_TIMEOUT_SECONDS,
				},
			},
		],
	};
}

/**
 * Write the marketplace folder (`.claude-plugin/marketplace.json`) and return
 * it. Rewritten on every `init`, so a moved CLI or a changed deployment
 * updates the command the person is asked to approve.
 */
export async function writeClaudeMarketplace(input: {
	cacheDirectory: string;
	projectId: string;
	command: string;
}): Promise<string> {
	const directory = claudeMarketplaceDirectory(
		input.cacheDirectory,
		input.projectId,
	);
	await writeAtomically(
		path.join(directory, ".claude-plugin", "marketplace.json"),
		`${JSON.stringify(claudeMarketplace(input), null, 2)}
`,
	);
	return directory;
}

interface ClaudeRegistration {
	projectId: string;
	marketplaceDirectory: string;
}

/**
 * The settings with the marketplace declared as a `directory` source (what
 * `claude plugin marketplace add <dir> --scope local` writes) and the plugin
 * turned on; everything else untouched.
 */
export function withClaudePlugin(
	settings: Record<string, unknown>,
	settingsPath: string,
	registration: ClaudeRegistration,
): Record<string, unknown> {
	const marketplaces = objectAt(
		settings,
		"extraKnownMarketplaces",
		settingsPath,
	);
	const enabled = objectAt(settings, "enabledPlugins", settingsPath);
	marketplaces[marketplaceNameFor(registration.projectId)] = {
		source: {
			source: "directory",
			path: registration.marketplaceDirectory,
		},
	};
	enabled[pluginIdFor(registration.projectId)] = true;
	return {
		...settings,
		extraKnownMarketplaces: marketplaces,
		enabledPlugins: enabled,
	};
}

export async function registerClaudePlugin(input: {
	root: string;
	projectId: string;
	marketplaceDirectory: string;
}) {
	return updateHookConfig({
		root: input.root,
		tool: "claude-code",
		update: (settings, settingsPath) =>
			withClaudePlugin(settings, settingsPath, input),
	});
}

/** The lines that make Claude Code read the marketplace and accept the command, for a person to run. */
export function claudeApprovalCommands(input: {
	projectId: string;
	marketplaceDirectory: string;
}): { add: string; install: string } {
	return {
		add: `claude plugin marketplace add ${input.marketplaceDirectory} --scope local`,
		install: `claude plugin install ${pluginIdFor(input.projectId)} --scope local`,
	};
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

const CODEX_MARKETPLACE_RELATIVE = path.join(
	".agents",
	"plugins",
	"marketplace.json",
);

const CODEX_MARKETPLACE_NAME = "personal";

interface CodexMarketplace {
	name: string;
	interface?: unknown;
	plugins: Array<Record<string, unknown>>;
	[key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The personal marketplace with a `local` entry for the plugin; other entries are kept as they are. */
export function withCodexPlugin(
	marketplace: CodexMarketplace,
	input: { name: string; pluginPathFromHome: string },
): CodexMarketplace {
	const entry = {
		name: input.name,
		source: { source: "local", path: input.pluginPathFromHome },
		policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
		category: "Coding",
	};
	const others = marketplace.plugins.filter(
		(plugin) => plugin.name !== input.name,
	);
	return { ...marketplace, plugins: [...others, entry] };
}

/** The marketplace as written, or a new one; a file of another shape is refused rather than replaced. */
async function readCodexMarketplace(
	file: string,
): Promise<{ marketplace: CodexMarketplace; existed: boolean }> {
	let raw: string;
	try {
		raw = await readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return {
				marketplace: {
					name: CODEX_MARKETPLACE_NAME,
					interface: { displayName: "Personal" },
					plugins: [],
				},
				existed: false,
			};
		}
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new CliFailure(
			`${file} is not valid JSON. Fix or remove it, then run this again; it was left untouched.`,
			7,
		);
	}
	if (
		!isRecord(parsed) ||
		typeof parsed.name !== "string" ||
		!Array.isArray(parsed.plugins) ||
		!parsed.plugins.every(isRecord)
	) {
		throw new CliFailure(
			`${file} does not look like a plugin marketplace (a "name" and a "plugins" list). It was left untouched.`,
			7,
		);
	}
	return { marketplace: parsed as CodexMarketplace, existed: true };
}

async function writeAtomically(file: string, text: string): Promise<void> {
	await mkdir(path.dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.tmp`;
	try {
		await writeFile(temporary, text, "utf8");
		await rename(temporary, file);
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => undefined);
		throw error;
	}
}

export interface CodexRegistration {
	marketplaceFile: string;
	marketplaceName: string;
	changed: boolean;
}

export async function registerCodexPlugin(input: {
	home: string;
	projectId: string;
	pluginDirectory: string;
}): Promise<CodexRegistration> {
	const file = path.join(input.home, CODEX_MARKETPLACE_RELATIVE);
	const { marketplace } = await readCodexMarketplace(file);
	const relative = path
		.relative(input.home, input.pluginDirectory)
		.split(path.sep)
		.join("/");
	const next = withCodexPlugin(marketplace, {
		name: pluginNameFor(input.projectId),
		pluginPathFromHome: `./${relative}`,
	});
	const before = JSON.stringify(marketplace);
	const changed = JSON.stringify(next) !== before;
	if (
		changed ||
		!(await readFile(file).then(
			() => true,
			() => false,
		))
	) {
		await writeAtomically(file, `${JSON.stringify(next, null, 2)}\n`);
	}
	return {
		marketplaceFile: file,
		marketplaceName: marketplace.name,
		changed,
	};
}

export type AgentsOverrideResult =
	| { kind: "written"; file: string }
	| { kind: "unchanged"; file: string }
	| { kind: "left-alone"; file: string };

/**
 * Write the project's `AGENTS.override.md`: tracked `AGENTS.md` then the
 * instructions. A file at that path that Fabric did not write is the
 * developer's own and is never replaced.
 */
export async function writeAgentsOverride(input: {
	root: string;
	instructions: string;
}): Promise<AgentsOverrideResult> {
	const file = path.join(input.root, "AGENTS.override.md");
	const existing = await readFile(file, "utf8").catch(() => null);
	if (existing !== null && !isFabricAgentsOverride(existing)) {
		return { kind: "left-alone", file };
	}
	const tracked = await readFile(
		path.join(input.root, "AGENTS.md"),
		"utf8",
	).catch(() => null);
	// The project's own AGENTS.md already says it: an override would repeat it.
	if (
		existing === null &&
		tracked !== null &&
		tracked.trim() === input.instructions.trim()
	) {
		return { kind: "unchanged", file };
	}
	const merged = mergedAgentsOverride(tracked, input.instructions);
	if (existing === merged) {
		return { kind: "unchanged", file };
	}
	await writeAtomically(file, merged);
	return { kind: "written", file };
}
