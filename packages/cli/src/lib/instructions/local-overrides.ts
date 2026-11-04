/**
 * `<dest>/.fabric/local-overrides.json` — a developer's own additions and
 * changes in an instructions checkout, layered on the shared published
 * version.
 *
 * ## What an override does
 *
 * It names paths this machine keeps as its own: a published file edited only
 * here, a published file removed only here, or a file the project never
 * published. `sync` never writes or deletes an overridden path and says so;
 * `push` never sends one, even under `--add`. That is ALL it does. The list
 * only ever REMOVES paths from what a command would otherwise touch: it never
 * makes a command read, write or delete anything it would not have without
 * it, so a tampered file can at worst stop a sync from updating a file.
 *
 * ## Why a file of its own
 *
 * Not a field of the lock: every released CLI reads lock versions 1 to 3 and
 * refuses any other whole, so a lock version 4 would break every older CLI
 * that opens the same checkout. A separate file is invisible to them. It is
 * per machine, so it is kept out of commits through `.git/info/exclude`:
 * `init` excludes the whole `.fabric` folder of a synced copy, and
 * `override add` excludes this file wherever it is written.
 *
 * ## Format
 *
 *     { "version": 1, "paths": ["CLAUDE.md"], "patterns": ["notes/**"] }
 *
 * `paths` are exact relative paths, matched as the filesystem would match
 * them (`collisionKey`: case and Unicode normalisation folded). `patterns`
 * are gitignore-style patterns, for a folder of personal notes.
 */
import ignore from "ignore";
import { LOCK_DIRECTORY } from "./lock.js";
import {
	checkRelativePath,
	collisionKey,
	describeRejection,
	findCollision,
	isReservedPath,
} from "./paths.js";
import { readFileSafely, writeFileSafely } from "./safe-write.js";

const LOCAL_OVERRIDES_FILENAME = "local-overrides.json";

/** The file's path relative to the checkout, in `/` spelling. */
export const LOCAL_OVERRIDES_PATH = `${LOCK_DIRECTORY}/${LOCAL_OVERRIDES_FILENAME}`;

const LOCAL_OVERRIDES_VERSION = 1;

/** A generous bound: the file is a short list a person keeps by hand. */
const MAX_OVERRIDES_BYTES = 256 * 1024;

const MAX_ENTRIES = 1000;

/** Characters that make an entry a pattern rather than one path. */
const GLOB_CHARACTERS = /[*?[\]]/;

export interface LocalOverrides {
	version: typeof LOCAL_OVERRIDES_VERSION;
	paths: string[];
	patterns: string[];
}

export const NO_OVERRIDES: LocalOverrides = {
	version: LOCAL_OVERRIDES_VERSION,
	paths: [],
	patterns: [],
};

/** Whether an entry is a gitignore-style pattern rather than a path. */
function isOverridePattern(entry: string): boolean {
	return GLOB_CHARACTERS.test(entry);
}

function pathProblem(candidate: string): string | null {
	const check = checkRelativePath(candidate);
	if (!check.ok) {
		return describeRejection(check);
	}
	if (isReservedPath(candidate)) {
		return describeRejection({
			ok: false,
			reason: "reserved_path",
			detail: candidate,
		});
	}
	return null;
}

function patternProblem(candidate: string): string | null {
	if (
		candidate.length === 0 ||
		candidate.length > 4096 ||
		/[\n\r\0]/.test(candidate) ||
		candidate.startsWith("!") ||
		candidate.startsWith("#")
	) {
		return `${JSON.stringify(candidate)} is not a pattern this tool accepts`;
	}
	return null;
}

/** Why this value is not an overrides file, or null when it is one. */
function overridesProblem(value: unknown): string | null {
	if (typeof value !== "object" || value === null) {
		return "it is not a JSON object";
	}
	const { version, paths, patterns } = value as Record<string, unknown>;
	if (version !== LOCAL_OVERRIDES_VERSION) {
		return `its version is ${JSON.stringify(version)}, and this build reads only version ${LOCAL_OVERRIDES_VERSION}`;
	}
	if (
		!Array.isArray(paths) ||
		!Array.isArray(patterns) ||
		paths.length + patterns.length > MAX_ENTRIES ||
		!paths.every((p) => typeof p === "string") ||
		!patterns.every((p) => typeof p === "string")
	) {
		return `"paths" and "patterns" must be lists of at most ${MAX_ENTRIES} strings`;
	}
	for (const candidate of paths as string[]) {
		const problem = pathProblem(candidate);
		if (problem !== null) {
			return problem;
		}
	}
	for (const candidate of patterns as string[]) {
		const problem = patternProblem(candidate);
		if (problem !== null) {
			return problem;
		}
	}
	const collision = findCollision(paths as string[]);
	if (collision !== null) {
		return `${collision.first} and ${collision.second} are one file on a case-insensitive filesystem`;
	}
	return null;
}

/**
 * The checkout's overrides, or none when it has no file.
 *
 * A file that exists and does not validate is an ERROR, never "no
 * overrides": treating it as empty would let the next sync overwrite every
 * file the developer meant to keep.
 */
export async function readLocalOverrides(
	root: string,
): Promise<LocalOverrides> {
	const read = await readFileSafely(root, LOCAL_OVERRIDES_PATH, {
		maxBytes: MAX_OVERRIDES_BYTES,
	});
	if (read === null) {
		return NO_OVERRIDES;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(read.bytes).toString("utf8"));
	} catch {
		throw new Error(
			`${LOCAL_OVERRIDES_PATH} is unreadable: it is not valid JSON. Fix it, or remove it to drop every local override.`,
		);
	}
	const problem = overridesProblem(parsed);
	if (problem !== null) {
		throw new Error(
			`${LOCAL_OVERRIDES_PATH} is unreadable: ${problem}. Fix it, or remove it to drop every local override.`,
		);
	}
	const valid = parsed as LocalOverrides;
	return {
		version: LOCAL_OVERRIDES_VERSION,
		paths: [...valid.paths],
		patterns: [...valid.patterns],
	};
}

export async function writeLocalOverrides(
	root: string,
	overrides: LocalOverrides,
): Promise<void> {
	const body = {
		version: LOCAL_OVERRIDES_VERSION,
		paths: [...overrides.paths].sort(),
		patterns: [...overrides.patterns].sort(),
	};
	await writeFileSafely({
		root,
		relativePath: LOCAL_OVERRIDES_PATH,
		bytes: new TextEncoder().encode(`${JSON.stringify(body, null, 2)}\n`),
	});
}

/**
 * `overrides` with `entry` added. A path is refused when it is not one this
 * tool would touch at all, or when it collides with a listed one under
 * another spelling; adding an entry already listed changes nothing.
 */
export function addOverride(
	overrides: LocalOverrides,
	entry: string,
): { overrides: LocalOverrides; changed: boolean } {
	if (isOverridePattern(entry)) {
		const problem = patternProblem(entry);
		if (problem !== null) {
			throw new Error(`Cannot override ${entry}: ${problem}.`);
		}
		if (overrides.patterns.includes(entry)) {
			return { overrides, changed: false };
		}
		return {
			overrides: {
				...overrides,
				patterns: [...overrides.patterns, entry],
			},
			changed: true,
		};
	}
	const problem = pathProblem(entry);
	if (problem !== null) {
		throw new Error(`Cannot override ${entry}: ${problem}.`);
	}
	if (overrides.paths.includes(entry)) {
		return { overrides, changed: false };
	}
	const collision = findCollision([...overrides.paths, entry]);
	if (collision !== null) {
		throw new Error(
			`Cannot override ${entry}: ${collision.first} is already listed, and the two are one file on a case-insensitive filesystem.`,
		);
	}
	return {
		overrides: { ...overrides, paths: [...overrides.paths, entry] },
		changed: true,
	};
}

/** `overrides` without `entry`, matched exactly as it was added. */
export function removeOverride(
	overrides: LocalOverrides,
	entry: string,
): { overrides: LocalOverrides; changed: boolean } {
	const paths = overrides.paths.filter((p) => p !== entry);
	const patterns = overrides.patterns.filter((p) => p !== entry);
	return {
		overrides: { ...overrides, paths, patterns },
		changed:
			paths.length !== overrides.paths.length ||
			patterns.length !== overrides.patterns.length,
	};
}

/** `(path) => whether the developer keeps it as their own`. */
export type OverrideMatcher = (relativePath: string) => boolean;

export function overrideMatcher(overrides: LocalOverrides): OverrideMatcher {
	const keys = new Set(overrides.paths.map(collisionKey));
	const patterns =
		overrides.patterns.length === 0
			? null
			: ignore({ ignorecase: true }).add(overrides.patterns);
	return (relativePath) =>
		keys.has(collisionKey(relativePath)) ||
		(patterns !== null && patterns.ignores(relativePath));
}

/** Says on stderr which local overrides a push left out, when there were any. */
export function reportOverriddenLeftOut(paths: readonly string[]): void {
	if (paths.length === 0) {
		return;
	}
	process.stderr.write(
		`Left out ${paths.length} local override(s), which push never sends: ${paths.join(", ")}\n`,
	);
}
