/**
 * What a session hook runs to start this CLI.
 *
 * A person who ran the one npx line has no `fabric` on PATH, and a hook that
 * says `fabric instructions …` then fails at every session start with
 * "command not found". The build a deployment serves is a single file with
 * every dependency inlined, so `init` keeps a copy of it where the hook can
 * find it, in the CLI's own config folder, one per deployment, and the hook
 * runs `node <that file>`. The copy is replaced on every `init`, and by the
 * hook itself once a day when its deployment serves a newer build
 * (`self-update.ts`), which is how a newer build reaches a machine that has the
 * hook already.
 *
 * The npm build is not a single file and cannot be copied. It is started as
 * `fabric`, which exists when that is how it was installed; when it does not,
 * the person is told once, in the line `init` prints.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { CliFailure } from "../command-boundary.js";
import { BUNDLE_COPY_FILE, pathAsCommandWord } from "../launcher.js";
import { isOnPath, type PathLookupEnvironment } from "./path-lookup.js";

export interface HookLauncher {
	/** The words a hook command starts with, before `instructions`. */
	prefix: string;
	/** One line for the person when the hook may not find the CLI, else `null`. */
	warning: string | null;
}

export interface HookLauncherInput {
	/** The deployment the hook is bound to, as an origin. */
	origin: string;
	/** The CLI's config folder, outside any checkout. */
	configDirectory: string;
	lookup: PathLookupEnvironment;
	/** The served build's own file, or `null` for every other build. */
	bundle: { scriptPath: string } | null;
}

/**
 * Points only at the setup line: a global install from the npm registry can be
 * an older build than this deployment's, one that does not know the hook's
 * `--base-url`, and would fail at every session start instead.
 */
const NOT_ON_PATH_WARNING =
	"`fabric` is not on this machine's PATH, so this session hook will not run. Run the setup line from the project's Connect dialog instead: it keeps a copy of this deployment's CLI where the hook finds it.";

const COPY_IN_USE_WARNING =
	"The CLI copy the session hook runs is in use and could not be replaced, so the earlier copy was kept. Run this again when no coding session is starting.";

const UNQUOTABLE_PATH =
	"The CLI's config folder has characters in its path that cannot be written safely into a hook command. Set XDG_CONFIG_HOME (APPDATA on Windows) to a plain path and run this again.";

/** One folder per deployment, so two deployments never share a copy. */
function deploymentFolder(origin: string): string {
	return origin
		.replace(/^(https?):\/\//, "$1-")
		.replace(/[^A-Za-z0-9.-]+/g, "-");
}

/** Where the copy for a deployment lives. */
export function bundleCopyPath(
	configDirectory: string,
	origin: string,
): string {
	return path.join(
		configDirectory,
		"cli",
		deploymentFolder(origin),
		BUNDLE_COPY_FILE,
	);
}

export function samePath(a: string, b: string): boolean {
	const [left, right] = [path.resolve(a), path.resolve(b)];
	return process.platform === "win32"
		? left.toLowerCase() === right.toLowerCase()
		: left === right;
}

/**
 * Write `bytes` to `destination` so a reader never sees half a file: a
 * temporary file beside it, then a rename. Returns false when the destination
 * is held open (Windows will not replace a file a running `node` is reading)
 * and already exists, in which case the earlier copy is left in place.
 */
export async function writeCopy(
	bytes: Uint8Array,
	destination: string,
): Promise<boolean> {
	await mkdir(path.dirname(destination), { recursive: true });
	const temporary = `${destination}.${process.pid}.tmp`;
	await writeFile(temporary, bytes, { mode: 0o644 });
	try {
		await rename(temporary, destination);
		return true;
	} catch (error) {
		await rm(temporary, { force: true });
		const existing = await readFile(destination).catch(() => null);
		if (existing === null) {
			throw error;
		}
		return existing.equals(bytes);
	}
}

export async function resolveHookLauncher(
	input: HookLauncherInput,
): Promise<HookLauncher> {
	if (input.bundle === null) {
		return {
			prefix: "fabric",
			warning: (await isOnPath("fabric", input.lookup))
				? null
				: NOT_ON_PATH_WARNING,
		};
	}

	const destination = bundleCopyPath(input.configDirectory, input.origin);
	const word = pathAsCommandWord(destination);
	if (word === null) {
		throw new CliFailure(UNQUOTABLE_PATH, 7);
	}
	if (samePath(input.bundle.scriptPath, destination)) {
		return { prefix: `node ${word}`, warning: null };
	}
	const current = await writeCopy(
		await readFile(input.bundle.scriptPath),
		destination,
	);
	return {
		prefix: `node ${word}`,
		warning: current ? null : COPY_IN_USE_WARNING,
	};
}
