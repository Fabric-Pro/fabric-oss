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
 */
import { createHash, randomBytes } from "node:crypto";
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
import type {
	FabricClient,
	MemoryWriteTargets,
	PublishedInstructions,
} from "@fabricorg/sdk";
import { projectResource } from "../oauth/project-resource.js";
import {
	alwaysOnFile,
	buildPlugin,
	type MemoryFolders,
	type PluginFile,
	type PluginTool,
	pluginNameFor,
	RENDER_VERSION,
} from "./layout.js";
import { readInstructions } from "./source.js";

/** Pins kept per project besides the newest: Claude Code may still be copying an older one. */
const KEPT_PINS = 3;

const CODEX_PIN_MARKER = ".fabric-render";

export interface RenderInput {
	client: Pick<FabricClient, "instructions" | "memory">;
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
}

export interface Rendered {
	directory: string;
	pin: string;
	/** The directory was already there. */
	reused: boolean;
	/** The memory file the session context is built from, for Codex's override. */
	alwaysOn: { file: string; text: string } | null;
	files: PluginFile[];
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

function pinOf(
	sourcePin: string,
	memory: MemoryFolders,
	tool: PluginTool,
): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				v: RENDER_VERSION,
				tool,
				sourcePin,
				memory,
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
): Promise<{ directory: string; reused: boolean }> {
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
	const read = await readInstructions({
		client: input.client,
		projectId: input.projectId,
		org: input.org,
		published,
		cacheDirectory: input.cacheDirectory,
		timeoutMs: input.timeoutMs,
		signal: input.signal,
		fetchImpl: input.fetchImpl,
	});
	for (const skipped of read.skipped) {
		input.log?.(`${skipped} is not text, so the plugin leaves it out.`);
	}
	const memory = await readMemoryFolders(input);
	const pin = pinOf(read.pin, memory, input.tool);
	const files = buildPlugin({
		tool: input.tool,
		projectId: input.projectId,
		files: read.files,
		memory,
		gatewayUrl: projectResource(input.origin, "mcp", input.projectId),
		pin,
	});
	const always = alwaysOnFile(read.files, input.tool);
	const installed =
		input.tool === "claude-code"
			? await installClaude(
					path.join(input.cacheDirectory, "plugins", input.projectId),
					pin,
					files,
				)
			: await installCodex(
					path.join(
						input.codexPluginsDirectory,
						pluginNameFor(input.projectId),
					),
					pin,
					files,
				);
	return {
		...installed,
		pin,
		alwaysOn:
			always === null ? null : { file: always.file, text: always.text },
		files,
	};
}
