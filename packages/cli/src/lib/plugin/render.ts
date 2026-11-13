/**
 * `fabric instructions render`: build a project's instructions into a plugin
 * directory and say where it is.
 *
 * Claude Code runs this as a `command` plugin source at install and once per
 * session, and takes the one line it prints as the plugin's directory. Each
 * pin renders to a directory of its own (`<cache>/plugins/<project>/<pin>`),
 * written whole in a temporary directory and renamed into place, so a reader
 * sees all of a version or none of it, and the same pin is the same directory:
 * a re-run that finds it present prints it without writing anything.
 *
 * A Codex plugin is installed from a fixed home-relative path, so it is the
 * one render that replaces a directory instead of adding one.
 *
 * A Coding Instructions set renders only the set's files, with its folder
 * taken off their paths, plus a generated `REPOSITORIES.md`. A non-default
 * set is a plugin of its own (`<name>-<slug>`, `plugins/<project>--<slug>`);
 * the default set keeps the project's plugin and folders.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import {
	chmod,
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
	type FabricClient,
	type MemoryWriteTargets,
	type PublishedInstructions,
	planPluginFiles,
} from "@fabricorg/sdk";
import { getConfigPath } from "../config.js";
import { bundleCopyPath } from "../instructions/hook-launcher.js";
import { isServedBundle, pathAsCommandWord } from "../launcher.js";
import { hasMcpSignIn } from "../oauth/mcp-token.js";
import { isProjectId, projectResource } from "../oauth/project-resource.js";
import { isSafeArgument } from "../shell-words.js";
import {
	assertLocationFree,
	BINDING_FILE,
	bindingText,
	originOf,
	type PluginBinding,
} from "./binding.js";
import { instructionAccessBootstrap } from "./instruction-access.js";
import {
	pluginCacheKey,
	pluginSetSlug,
	type RenderSet,
	repositoriesMarkdown,
} from "./instruction-sets.js";
import type { KnowledgeTypes } from "./knowledge.js";
import {
	alwaysOnFile,
	buildPlugin,
	type MemoryFolders,
	type PluginFile,
	type PluginTool,
	pluginNameFor,
	RENDER_VERSION,
	setGuidanceOf,
} from "./layout.js";
import { commandLineProblem } from "./register.js";
import { type ProjectRule, selectRules, tierRules } from "./rules.js";
import { readInstructions } from "./source.js";

/** Pins kept per project besides the newest: Claude Code may still be copying an older one. */
const KEPT_PINS = 3;

const CODEX_PIN_MARKER = ".fabric-render";

export interface RenderInput {
	client: Pick<FabricClient, "instructions" | "memory" | "knowledge">;
	projectId: string;
	org?: string;
	/** The deployment, as an origin. */
	origin: string;
	tool: PluginTool;
	/** The CLI's cache folder, outside any checkout. */
	cacheDirectory: string;
	/** Where a Codex plugin goes: `<home>/.codex/plugins`. */
	codexPluginsDirectory: string;
	timeoutMs: number;
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
	/** Progress and warnings; never stdout. */
	log?: (line: string) => void;
	/** The Coding Instructions set to render (`loadRenderSet`); absent or `null` for a project without sets. */
	set?: RenderSet | null;
}

export interface Rendered {
	directory: string;
	pin: string;
	/** The directory was already there. */
	reused: boolean;
	/** Access guidance and optional root text, for Codex's override. */
	alwaysOn: { file: string; text: string } | null;
	/** The project rules for automatic delivery by the caller. */
	rules: ProjectRule[];
	files: PluginFile[];
	/** Claude Code only: the plugin's MCP server asks this CLI for its Authorization header. */
	mcpHeadersHelper: boolean;
}

/** Files named in the line about what the plugin leaves out. */
const LEFT_OUT_NAMED = 3;

/**
 * One line about the instruction files the plugin has no place for: how many,
 * the first few, and where the whole list and the reasons are. `null` when the
 * plugin carries everything.
 */
function leftOutLine(paths: readonly string[]): string | null {
	if (paths.length === 0) {
		return null;
	}
	const named = paths.slice(0, LEFT_OUT_NAMED).join(", ");
	const more =
		paths.length > LEFT_OUT_NAMED
			? ` and ${paths.length - LEFT_OUT_NAMED} more`
			: "";
	const count =
		paths.length === 1
			? "1 instruction file is"
			: `${paths.length} instruction files are`;
	return `${count} not part of the plugin (${named}${more}). Their paths remain in the fabric-instruction-access skill's catalog; use the project's Fabric MCP tools to read available text on demand. The Coding Instructions tab lists the layout reasons.`;
}

function memoryFoldersOf(targets: MemoryWriteTargets): MemoryFolders {
	return {
		state: "known",
		ref: targets.sync?.ref ?? null,
		folders: targets.targets.map((target) => ({
			folder: target.folder,
			mode: target.mode,
		})),
	};
}

async function readMemoryFolders(input: RenderInput): Promise<MemoryFolders> {
	try {
		return memoryFoldersOf(
			await input.client.memory.getTargets(input.projectId),
		);
	} catch (error) {
		input.log?.(
			`The memory folders could not be read (${error instanceof Error ? error.message : "unknown error"}); the plugin will say so.`,
		);
		return { state: "unavailable" };
	}
}

async function readKnowledgeTypes(input: RenderInput): Promise<KnowledgeTypes> {
	try {
		const { types } = await input.client.knowledge.getProjectTypes(
			input.projectId,
		);
		return { state: "known", types };
	} catch (error) {
		input.log?.(
			`The knowledge types could not be read (${error instanceof Error ? error.message : "unknown error"}); the plugin will say so.`,
		);
		return { state: "unavailable" };
	}
}

/**
 * The `fabric mcp header` command line for the plugin's MCP server
 * (Claude Code's `headersHelper`), when the project has an MCP gateway
 * sign-in on this machine (`mcp-token.ts`); otherwise none, and Claude Code
 * signs in through `/mcp`.
 */
function mcpHeadersHelperFor(
	origin: string,
	projectId: string,
): string | undefined {
	const deployment = originOf(origin);
	if (deployment === null || !hasMcpSignIn(deployment, projectId)) {
		return undefined;
	}
	const script = cliScriptPath(deployment);
	return script === undefined
		? undefined
		: mcpHeadersHelperCommand({
				nodePath: process.execPath,
				scriptPath: script,
				projectId,
				origin: deployment,
			});
}

/**
 * The file that starts this CLI for a coding tool: the served build's kept copy
 * (`hook-launcher.ts`), the one session hooks run, so a render from `init` and
 * one at session start agree on the command; otherwise the file this process
 * runs.
 */
function cliScriptPath(deployment: string): string | undefined {
	if (isServedBundle()) {
		const copy = bundleCopyPath(path.dirname(getConfigPath()), deployment);
		if (existsSync(copy)) {
			return copy;
		}
	}
	return process.argv[1] || undefined;
}

/**
 * The helper command, spelled like the plugin's render command
 * (`renderCommandLine`): forward slashes, and quotes only around a path that
 * needs them, so the shell Claude Code runs it through on Windows reads it
 * as written. `undefined` when a part cannot be written safely.
 */
export function mcpHeadersHelperCommand(input: {
	nodePath: string;
	scriptPath: string;
	projectId: string;
	origin: string;
	platform?: NodeJS.Platform;
}): string | undefined {
	const node = pathAsCommandWord(input.nodePath, input.platform);
	const script = pathAsCommandWord(input.scriptPath, input.platform);
	if (
		node === null ||
		script === null ||
		!isProjectId(input.projectId) ||
		!isSafeArgument(input.origin)
	) {
		return undefined;
	}
	const command = [
		node,
		script,
		"mcp header --project",
		input.projectId,
		"--base-url",
		input.origin,
	].join(" ");
	return commandLineProblem(command) === null ? command : undefined;
}

/** What names a set's render: which files it holds and its `REPOSITORIES.md`. */
interface SetPin {
	slug: string;
	folder: string;
	excludedFolders: readonly string[];
	repositories: string;
}

function pinOf(
	sourcePin: string,
	memory: MemoryFolders,
	knowledge: KnowledgeTypes,
	tool: PluginTool,
	mcpHeadersHelper?: string,
	set?: SetPin,
): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				v: RENDER_VERSION,
				tool,
				sourcePin,
				memory,
				knowledge,
				...(mcpHeadersHelper ? { mcpHeadersHelper } : {}),
				...(set ? { set } : {}),
			}),
		)
		.digest("hex")
		.slice(0, 12);
}

async function exists(file: string): Promise<boolean> {
	return stat(file).then(
		() => true,
		() => false,
	);
}

async function writeTree(
	directory: string,
	files: readonly PluginFile[],
): Promise<void> {
	for (const file of files) {
		const target = path.join(directory, ...file.path.split("/"));
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, file.bytes);
		await chmod(target, file.mode).catch(() => undefined);
	}
}

function temporaryNameFor(directory: string): string {
	return `${directory}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
}

/** Remove all but the newest pins of a project, ignoring any that cannot be removed. */
async function prune(projectDirectory: string, keep: string): Promise<void> {
	try {
		const entries = await readdir(projectDirectory, {
			withFileTypes: true,
		});
		const dated = await Promise.all(
			entries
				.filter((entry) => entry.isDirectory() && entry.name !== keep)
				.map(async (entry) => ({
					name: entry.name,
					modified: (
						await stat(path.join(projectDirectory, entry.name))
					).mtimeMs,
				})),
		);
		dated.sort((a, b) => b.modified - a.modified);
		for (const old of dated.slice(KEPT_PINS - 1)) {
			await rm(path.join(projectDirectory, old.name), {
				recursive: true,
				force: true,
			}).catch(() => undefined);
		}
	} catch {
		// Pruning is housekeeping.
	}
}

async function installClaude(
	projectDirectory: string,
	pin: string,
	files: readonly PluginFile[],
): Promise<{ directory: string; reused: boolean }> {
	const directory = path.join(projectDirectory, pin);
	if (await exists(path.join(directory, ".claude-plugin", "plugin.json"))) {
		return { directory, reused: true };
	}
	await mkdir(projectDirectory, { recursive: true });
	const temporary = temporaryNameFor(directory);
	try {
		await writeTree(temporary, files);
		await rm(directory, { recursive: true, force: true });
		await rename(temporary, directory);
	} catch (error) {
		await rm(temporary, { recursive: true, force: true }).catch(
			() => undefined,
		);
		// A second render of the same pin won the rename: its directory is ours.
		if (
			await exists(path.join(directory, ".claude-plugin", "plugin.json"))
		) {
			return { directory, reused: true };
		}
		throw error;
	}
	await prune(projectDirectory, pin);
	return { directory, reused: false };
}

async function installCodex(
	directory: string,
	pin: string,
	files: readonly PluginFile[],
	binding: PluginBinding,
): Promise<{ directory: string; reused: boolean }> {
	await assertLocationFree({
		directory,
		location: "codex-plugin",
		wanted: binding,
	});
	const marker = await readFile(
		path.join(directory, CODEX_PIN_MARKER),
		"utf8",
	).catch(() => null);
	if (marker?.trim() === pin) {
		return { directory, reused: true };
	}
	await mkdir(path.dirname(directory), { recursive: true });
	const temporary = temporaryNameFor(directory);
	const retired = temporaryNameFor(directory).replace(".tmp-", ".old-");
	try {
		await writeTree(temporary, [
			...files,
			{
				path: BINDING_FILE,
				bytes: new TextEncoder().encode(bindingText(binding)),
				mode: 0o644,
			},
			{
				path: CODEX_PIN_MARKER,
				bytes: new TextEncoder().encode(`${pin}\n`),
				mode: 0o644,
			},
		]);
		if (await exists(directory)) {
			await rename(directory, retired);
		}
		await rename(temporary, directory);
		await rm(retired, { recursive: true, force: true }).catch(
			() => undefined,
		);
	} catch (error) {
		await rm(temporary, { recursive: true, force: true }).catch(
			() => undefined,
		);
		if (!(await exists(directory)) && (await exists(retired))) {
			await rename(retired, directory).catch(() => undefined);
		}
		throw error;
	}
	return { directory, reused: false };
}

export async function renderPlugin(input: RenderInput): Promise<Rendered> {
	const published: PublishedInstructions =
		await input.client.instructions.getPublished(input.projectId, {
			org: input.org,
		});
	const chosen = input.set ?? null;
	const read = await readInstructions({
		client: input.client,
		projectId: input.projectId,
		org: input.org,
		published,
		cacheDirectory: input.cacheDirectory,
		timeoutMs: input.timeoutMs,
		signal: input.signal,
		fetchImpl: input.fetchImpl,
		set: chosen?.set ?? null,
	});
	const setPin: SetPin | undefined =
		chosen === null
			? undefined
			: {
					slug: chosen.set.slug,
					folder: chosen.set.folder,
					excludedFolders: [...chosen.set.excludedFolders].sort(),
					repositories: repositoriesMarkdown(
						chosen.set,
						chosen.repositories,
					),
				};
	const setSlug = pluginSetSlug(setPin?.slug);
	const pluginName = pluginNameFor(input.projectId, setSlug);
	for (const skipped of read.skipped) {
		input.log?.(
			`${skipped} is unavailable as inline text, so the plugin leaves its bytes out. Its path remains in the fabric-instruction-access catalog; MCP reads may report a binary or size refusal.`,
		);
	}
	// The other tool's memory file is not left out: CLAUDE.md serves Claude
	// Code and AGENTS.md Codex.
	const notPartOfPlugin = leftOutLine(
		planPluginFiles(read.listed, input.tool)
			.leftOut.filter((entry) => entry.reason !== "always-on-shadowed")
			.map((entry) => entry.path),
	);
	if (notPartOfPlugin !== null) {
		input.log?.(notPartOfPlugin);
	}
	const memory = await readMemoryFolders(input);
	const knowledge = await readKnowledgeTypes(input);
	const mcpHeadersHelper =
		input.tool === "claude-code"
			? mcpHeadersHelperFor(input.origin, input.projectId)
			: undefined;
	const tiers = tierRules(selectRules(read, input.tool));
	const pin = pinOf(
		read.pin,
		memory,
		knowledge,
		input.tool,
		mcpHeadersHelper,
		setPin,
	);
	const pluginSet =
		setPin === undefined
			? undefined
			: {
					slug: setPin.slug,
					folder: setPin.folder,
					repositories: setPin.repositories,
				};
	const files = buildPlugin({
		mcpHeadersHelper,
		onDemandRules: tiers.onDemand,
		tool: input.tool,
		projectId: input.projectId,
		files: read.files,
		memory,
		knowledge,
		gatewayUrl: projectResource(input.origin, "mcp", input.projectId),
		pin,
		instructionAccess: { listed: read.listed, source: read.source },
		set: pluginSet,
	});
	const always = alwaysOnFile(read.files, input.tool);
	const guidance = instructionAccessBootstrap(
		pluginName,
		input.tool,
		setGuidanceOf(pluginSet),
	);
	const installed =
		input.tool === "claude-code"
			? await installClaude(
					path.join(
						input.cacheDirectory,
						"plugins",
						pluginCacheKey(input.projectId, setSlug),
					),
					pin,
					files,
				)
			: await installCodex(
					path.join(input.codexPluginsDirectory, pluginName),
					pin,
					files,
					{
						projectId: input.projectId,
						origin: originOf(input.origin),
						set: setSlug,
					},
				);
	return {
		...installed,
		pin,
		alwaysOn: {
			file: always?.file ?? "Fabric instruction access",
			text: `${guidance}${always === null ? "" : `\n${always.text}`}`,
		},
		rules: tiers.delivered,
		files,
		mcpHeadersHelper: mcpHeadersHelper !== undefined,
	};
}
