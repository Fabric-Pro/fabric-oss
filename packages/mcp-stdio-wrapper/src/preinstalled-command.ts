/**
 * Runs an `npx` catalog command from the package the image already installed
 * globally, when that installed copy is the one npx would run anyway.
 *
 * npx loads npm and resolves the package tree on every spawn. On the wrapper's
 * 0.5 vCPU, three concurrent cold starts of `npx -y @azure-devops/mcp@2.8.0`
 * took 30–40 s — past the 30 s initialize deadline, so every hourly PM poll
 * lost its Azure DevOps connections. The same installed binary started in ~5 s.
 *
 * Only an unversioned spec or an exact version equal to the installed one is
 * resolved; a tag or range could mean a different version, so it stays on npx.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

export interface ResolvedCommand {
	executable: string;
	args: string[];
	packageName: string;
	version: string;
}

/** npx options that do not change which package runs. */
const NPX_PASSTHROUGH_FLAGS = new Set(["-y", "--yes"]);

const EXACT_VERSION =
	/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

let globalNodeModules: Promise<string | null> | undefined;

function getGlobalNodeModules(): Promise<string | null> {
	globalNodeModules ??= promisify(execFile)("npm", ["root", "-g"]).then(
		({ stdout }) => stdout.trim() || null,
		() => null,
	);
	return globalNodeModules;
}

function parsePackageSpec(spec: string): { name: string; version?: string } {
	const at = spec.lastIndexOf("@");
	return at > 0
		? { name: spec.slice(0, at), version: spec.slice(at + 1) }
		: { name: spec };
}

function pickBin(bin: unknown, packageName: string): string | undefined {
	if (typeof bin === "string") {
		return bin;
	}
	if (!bin || typeof bin !== "object") {
		return undefined;
	}
	const entries = Object.entries(bin).filter(
		(entry): entry is [string, string] => typeof entry[1] === "string",
	);
	if (entries.length === 1) {
		return entries[0][1];
	}
	const unscopedName = packageName.split("/").pop();
	return entries.find(([name]) => name === unscopedName)?.[1];
}

export async function resolvePreinstalledCommand(
	commandParts: readonly string[],
	globalRoot?: string | null,
): Promise<ResolvedCommand | null> {
	if (commandParts[0] !== "npx") {
		return null;
	}
	let index = 1;
	while (NPX_PASSTHROUGH_FLAGS.has(commandParts[index] ?? "")) {
		index++;
	}
	const spec = commandParts[index];
	if (!spec || spec.startsWith("-")) {
		return null;
	}

	const { name, version } = parsePackageSpec(spec);
	if (version !== undefined && !EXACT_VERSION.test(version)) {
		return null;
	}

	const root =
		globalRoot === undefined ? await getGlobalNodeModules() : globalRoot;
	if (!root) {
		return null;
	}
	const packageDir = join(root, name);
	let manifest: { version?: unknown; bin?: unknown };
	try {
		manifest = JSON.parse(
			await readFile(join(packageDir, "package.json"), "utf8"),
		);
	} catch {
		return null;
	}
	if (typeof manifest.version !== "string") {
		return null;
	}
	if (version !== undefined && manifest.version !== version) {
		return null;
	}
	const binPath = pickBin(manifest.bin, name);
	if (!binPath) {
		return null;
	}

	return {
		executable: process.execPath,
		args: [join(packageDir, binPath), ...commandParts.slice(index + 1)],
		packageName: name,
		version: manifest.version,
	};
}
