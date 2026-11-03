/**
 * Readable plugin names: `/slotik:be-testing` instead of
 * `/fabric-l86wzlqn:be-testing`.
 *
 * A project's plugin name is chosen once on this machine, when the plugin is
 * first set up (`fabric instructions init`), from the project's name, and kept
 * in `plugin-names.json` beside the CLI's config. Every later use (the
 * session-start render, registration, the Codex install) reads the same entry,
 * so renaming the project in Fabric never renames an installed plugin. Two
 * projects with the same name get `-2`, `-3`.
 *
 * A project without an entry keeps the id-based name (`fabric-<id tail>`), so
 * plugins installed before this keep working unchanged.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

type NameMap = Record<string, string>;

let fileOverride: string | null = null;
let cache: { file: string; names: NameMap } | null = null;

/** Tests point the store at a temporary file. */
export function setPluginNamesFile(file: string | null): void {
	fileOverride = file;
	cache = null;
}

function storeFile(): string | null {
	if (fileOverride !== null) {
		return fileOverride;
	}
	try {
		const dir = configDirectory();
		return dir === null ? null : path.join(dir, "plugin-names.json");
	} catch {
		return null;
	}
}

let configDirectoryResolver: (() => string | null) | null = null;

/** Wired by the CLI at start-up so this module stays free of the config store. */
export function setPluginNamesDirectory(resolve: () => string | null): void {
	configDirectoryResolver = resolve;
	cache = null;
}

function configDirectory(): string | null {
	return configDirectoryResolver ? configDirectoryResolver() : null;
}

function load(): NameMap {
	const file = storeFile();
	if (file === null) {
		return {};
	}
	if (cache?.file === file) {
		return cache.names;
	}
	let names: NameMap = {};
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			names = Object.fromEntries(
				Object.entries(parsed as Record<string, unknown>).filter(
					(entry): entry is [string, string] =>
						typeof entry[1] === "string" && isPluginName(entry[1]),
				),
			);
		}
	} catch {
		names = {};
	}
	cache = { file, names };
	return names;
}

/** Lowercase letters, digits and single dashes, 2–40 long: a name every tool accepts. */
function isPluginName(value: string): boolean {
	return (
		/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])$/.test(value) &&
		!value.includes("--")
	);
}

/** The project's name as a plugin name, or null when nothing usable is left. */
export function slugForPlugin(projectName: string): string | null {
	const slug = projectName
		.normalize("NFKD")
		.replace(/\p{M}+/gu, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 32)
		.replace(/-+$/g, "");
	return slug.length >= 2 && isPluginName(slug) ? slug : null;
}

/** The chosen name for a project on this machine, if one was chosen. */
export function assignedPluginName(projectId: string): string | null {
	return load()[projectId] ?? null;
}

/**
 * Chooses (once) and stores the project's plugin name. `keep` is the name
 * already installed for the project, when there is one: it is recorded as is,
 * so an existing install is never renamed under the person.
 */
export function assignPluginName(input: {
	projectId: string;
	projectName: string | null;
	keep: string | null;
}): string | null {
	const names = load();
	const current = names[input.projectId];
	if (current) {
		return current;
	}
	let chosen: string | null = input.keep;
	if (chosen === null) {
		const base = input.projectName
			? slugForPlugin(input.projectName)
			: null;
		if (base === null) {
			return null;
		}
		const taken = new Set(
			Object.entries(names)
				.filter(([id]) => id !== input.projectId)
				.map(([, name]) => name),
		);
		chosen = base;
		for (let n = 2; taken.has(chosen); n++) {
			chosen = `${base}-${n}`;
		}
	}
	const file = storeFile();
	if (file === null) {
		return null;
	}
	const next = { ...names, [input.projectId]: chosen };
	if (!existsSync(path.dirname(file))) {
		mkdirSync(path.dirname(file), { recursive: true });
	}
	writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
	cache = { file, names: next };
	return chosen;
}

/**
 * `--rename`: gives the project its readable name even when it already has
 * one (an id-based name kept for an existing install). Returns the old and
 * new names, or null when the name would not change or cannot be made.
 */
export function renamePluginName(input: {
	projectId: string;
	projectName: string | null;
	previous: string;
}): { from: string; to: string } | null {
	const names = load();
	const base = input.projectName ? slugForPlugin(input.projectName) : null;
	if (base === null) {
		return null;
	}
	const taken = new Set(
		Object.entries(names)
			.filter(([id]) => id !== input.projectId)
			.map(([, name]) => name),
	);
	let chosen = base;
	for (let n = 2; taken.has(chosen); n++) {
		chosen = `${base}-${n}`;
	}
	if (chosen === input.previous) {
		return null;
	}
	const file = storeFile();
	if (file === null) {
		return null;
	}
	const next = { ...names, [input.projectId]: chosen };
	if (!existsSync(path.dirname(file))) {
		mkdirSync(path.dirname(file), { recursive: true });
	}
	writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
	cache = { file, names: next };
	return { from: input.previous, to: chosen };
}
