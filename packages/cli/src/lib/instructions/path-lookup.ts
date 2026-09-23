/**
 * Is an executable reachable on PATH — answered WITHOUT running anything.
 *
 * `fabric instructions doctor` checks tools a published declaration names and
 * commands a repository's `.mcp.json` names. Both are content somebody else
 * wrote, so "does `pnpm --version` work" is not a question this may ask:
 * running a program because published text named it is remote code execution
 * by whoever can publish. The only operations here are `stat` calls on
 * candidate paths — never `spawn`, `exec`, or a shell.
 *
 * A candidate counts as found when it is a regular file (symlinks are
 * followed, the way a shell follows them) and, on POSIX, carries an execute
 * bit. On Windows the extension decides, so each name is tried with every
 * `PATHEXT` extension unless it already ends in one.
 *
 * Only ABSOLUTE PATH entries are searched. An empty or relative entry means
 * "the current directory" to a shell, and whether that resolves depends on
 * where a coding tool happens to start — not something to report as found.
 */
import { stat } from "node:fs/promises";
import path from "node:path";

/** Generous bounds, so a pathological environment cannot turn a check into thousands of stats. */
const MAX_PATH_ENTRIES = 256;
const MAX_PATHEXT_ENTRIES = 32;
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/** The one filesystem question asked of a candidate. */
export type CandidateStat = (
	candidate: string,
) => Promise<{ isFile(): boolean; mode: number }>;

export interface PathLookupEnvironment {
	env: Readonly<Record<string, string | undefined>>;
	platform: NodeJS.Platform;
	/**
	 * `node:fs/promises` `stat` unless given. Injectable so the Windows rules
	 * (`;`-separated `Path`, `PATHEXT`, no execute bit) can be exercised on a
	 * POSIX machine, where `path.win32` candidates are not real paths.
	 */
	stat?: CandidateStat;
}

/**
 * An environment variable by name — case-insensitively on Windows, where the
 * environment is, and where `Path` is the usual spelling of `PATH`.
 */
function readVariable(
	lookup: PathLookupEnvironment,
	name: string,
): string | undefined {
	if (lookup.platform !== "win32") {
		return lookup.env[name];
	}
	const key = Object.keys(lookup.env).find(
		(candidate) => candidate.toUpperCase() === name,
	);
	return key === undefined ? undefined : lookup.env[key];
}

function pathApi(platform: NodeJS.Platform): typeof path.posix {
	return platform === "win32" ? path.win32 : path.posix;
}

function searchDirectories(lookup: PathLookupEnvironment): string[] {
	const api = pathApi(lookup.platform);
	const raw = readVariable(lookup, "PATH") ?? "";
	const directories: string[] = [];
	for (const entry of raw.split(api.delimiter)) {
		// Windows tolerates quoted entries; POSIX has no such convention.
		const candidate =
			lookup.platform === "win32"
				? entry.replace(/^"(.*)"$/, "$1")
				: entry;
		if (candidate.length === 0 || !api.isAbsolute(candidate)) {
			continue;
		}
		directories.push(candidate);
		if (directories.length >= MAX_PATH_ENTRIES) {
			break;
		}
	}
	return directories;
}

function windowsExtensions(lookup: PathLookupEnvironment): string[] {
	const raw = readVariable(lookup, "PATHEXT") ?? DEFAULT_PATHEXT;
	return raw
		.split(";")
		.map((extension) => extension.trim())
		.filter((extension) => /^\.[A-Za-z0-9]+$/.test(extension))
		.slice(0, MAX_PATHEXT_ENTRIES);
}

/**
 * Is `candidate` something a shell would run? `stat` only — see the module
 * comment. Any error (absent, permission, a loop) is "no".
 */
export async function isExecutableFile(
	candidate: string,
	platform: NodeJS.Platform,
	statCandidate: CandidateStat = stat,
): Promise<boolean> {
	try {
		const stats = await statCandidate(candidate);
		if (!stats.isFile()) {
			return false;
		}
		return platform === "win32" || (stats.mode & 0o111) !== 0;
	} catch {
		return false;
	}
}

/**
 * Is a bare executable name — no separators, validated by the caller —
 * found in any absolute PATH directory?
 */
export async function isOnPath(
	name: string,
	lookup: PathLookupEnvironment,
): Promise<boolean> {
	if (
		name.length === 0 ||
		name.includes("/") ||
		name.includes("\\") ||
		name === "." ||
		name === ".."
	) {
		return false;
	}
	const api = pathApi(lookup.platform);
	let candidates = [name];
	if (lookup.platform === "win32") {
		const extensions = windowsExtensions(lookup);
		const lower = name.toLowerCase();
		const hasKnownExtension = extensions.some((extension) =>
			lower.endsWith(extension.toLowerCase()),
		);
		candidates = hasKnownExtension
			? [name]
			: extensions.map((extension) => `${name}${extension}`);
	}
	for (const directory of searchDirectories(lookup)) {
		for (const candidate of candidates) {
			if (
				await isExecutableFile(
					api.join(directory, candidate),
					lookup.platform,
					lookup.stat,
				)
			) {
				return true;
			}
		}
	}
	return false;
}
