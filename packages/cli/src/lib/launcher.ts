/**
 * How this CLI is started, as the words a person types.
 *
 * Every line the CLI prints that tells someone to run a fabric command goes
 * through `fabricCommand`, because the right words depend on how this process
 * got here:
 *
 *   `fabric`                        the build npm publishes: `fabric` is on PATH
 *                                   when that is how it was installed
 *   `npx -y <origin>/cli/<file>`    the copy a deployment serves, wherever it
 *                                   runs from (its tarball, or the file a
 *                                   session hook keeps): nothing is installed,
 *                                   so `fabric` does not exist, and the URL
 *                                   keeps working after the deployment moves
 *                                   on, because an old name redirects to the
 *                                   current one
 *   `node <path>`                   that same copy, from the file it runs from:
 *                                   only when the build never learned its
 *                                   tarball's name
 *
 * A deployment's copy is told which it is when it is packed
 * (`scripts/pack-deployment.mjs` defines `__FABRIC_BUNDLE__` and
 * `__FABRIC_BUNDLE_TARBALL__`); every other build, and every test, reads as the
 * first.
 */
import { fileURLToPath } from "node:url";
import { bakedOrigin, DEFAULT_ORIGIN } from "./origin.js";
import { isSafeArgument, NO_COMMAND } from "./shell-words.js";

/** `true` in the self-contained build a deployment serves; undefined everywhere else. */
declare const __FABRIC_BUNDLE__: boolean | undefined;
/** Where that build is served, origin-relative; undefined when the pack step did not say. */
declare const __FABRIC_BUNDLE_TARBALL__: string | undefined;

/**
 * Where a deployment serves its copy. The pack step names the tarball after
 * its content, `/cli/fabric-<version>-<id>.tgz`, so a changed build is a new
 * URL and `npx` cannot keep running the old one from its cache.
 */
const TARBALL_PATH = /^\/cli\/fabric-\d+\.\d+\.\d+-[0-9a-f]{10}\.tgz$/;

/** The name a copy of the served build keeps in the CLI's config folder. */
export const BUNDLE_COPY_FILE = "fabric.mjs";

const SAFE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;
/** What no quoting makes safe across bash and PowerShell. */
const UNQUOTABLE = /["$`\\!]/;

function hasControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code < 0x20 || code === 0x7f) {
			return true;
		}
	}
	return false;
}

/** The deployment a printed line is about, once a command knows it. */
let launcherOrigin: string | undefined;

export function setLauncherOrigin(origin: string | undefined): void {
	launcherOrigin = origin;
}

/** Is this the self-contained build a deployment serves? */
export function isServedBundle(): boolean {
	return typeof __FABRIC_BUNDLE__ === "boolean" && __FABRIC_BUNDLE__;
}

/** Is this the path a deployment serves a build at, `/cli/fabric-<version>-<id>.tgz`? */
export function isBundleTarballPath(value: string): boolean {
	return TARBALL_PATH.test(value);
}

/** Where this build is served from its deployment, or `undefined` when it does not know. */
export function bundleTarballPath(): string | undefined {
	return isServedBundle() &&
		typeof __FABRIC_BUNDLE_TARBALL__ === "string" &&
		isBundleTarballPath(__FABRIC_BUNDLE_TARBALL__)
		? __FABRIC_BUNDLE_TARBALL__
		: undefined;
}

/** The file this process is running, for a build that is a single file. */
export function bundleScriptPath(): string {
	return fileURLToPath(import.meta.url);
}

/**
 * A path as one word of a command a shell will run, or `null` when there is no
 * spelling of it that bash, PowerShell and a Windows path all read the same.
 * Forward slashes on Windows (a backslash is an escape to bash); double quotes
 * only when the path has something a shell would split or interpret, such as a
 * space in a user's name.
 */
export function pathAsCommandWord(
	file: string,
	platform: NodeJS.Platform = process.platform,
): string | null {
	const normalised = platform === "win32" ? file.replace(/\\/g, "/") : file;
	if (SAFE_WORD.test(normalised)) {
		return normalised;
	}
	if (
		normalised.length === 0 ||
		UNQUOTABLE.test(normalised) ||
		hasControlCharacter(normalised)
	) {
		return null;
	}
	return `"${normalised}"`;
}

/**
 * The words that start this CLI again, before the arguments.
 *
 * The served build is started with `npx` from its URL whenever it knows its
 * tarball's name, including when it runs from the copy a session hook keeps: a
 * line a person pastes is short, and it keeps working after the deployment
 * ships a newer build, because the old name redirects to the current one. A
 * build that never learned its name can only be started from the file it runs
 * from. `origin` is the deployment the tarball is served from.
 */
export function launcherWords(
	origin: string = launcherOrigin ?? implicitOrigin(),
	script?: string,
): string[] {
	if (!isServedBundle()) {
		return ["fabric"];
	}
	const tarball = bundleTarballPath();
	if (tarball !== undefined) {
		return ["npx", "-y", `${origin}${tarball}`];
	}
	const word = pathAsCommandWord(script ?? bundleScriptPath());
	return word === null ? ["fabric"] : ["node", word];
}

/**
 * `launcherWords`, for a line a person will paste: `null` when they carry the
 * deployment's address and it is not plain, since an address may hold `$ ( ) ;
 * & ` ' " ! ~ ,` and no command can carry those (see `shell-words.ts`).
 */
export function printableLauncherWords(
	origin: string = launcherOrigin ?? implicitOrigin(),
): string[] | null {
	const words = launcherWords(origin);
	return words[0] === "npx" && !isSafeArgument(words[2] ?? "") ? null : words;
}

/**
 * The words `fabricCommand` starts with, as printed, when they carry a file
 * path, and `undefined` when they do not. For a caller that has to leave them
 * untouched while it takes a home folder out of the rest of a message: a
 * `node <path>` that named `~` would not run.
 */
export function launcherPathText(): string | undefined {
	const words = launcherWords();
	return words[0] === "node" ? words.join(" ") : undefined;
}

/** The deployment a bare command would talk to, when none is named. */
function implicitOrigin(): string {
	return bakedOrigin() ?? DEFAULT_ORIGIN;
}

/**
 * `fabric <args>` spelled the way this install runs it, bound to `origin` (the
 * run's own deployment unless given) with `--base-url` when a bare command would
 * not talk to it. `args` is already shell-safe text: the caller quotes any
 * value it takes from a person. When the deployment's address is not plain
 * enough to be written into a command, what comes back is `NO_COMMAND` and not
 * a line, and the address is not repeated.
 */
export function fabricCommand(
	args: string,
	origin: string | undefined = launcherOrigin,
): string {
	const deployment = origin ?? implicitOrigin();
	const words = printableLauncherWords(deployment);
	const bound =
		deployment !== implicitOrigin() && !args.includes("--base-url")
			? ` --base-url ${deployment}`
			: "";
	if (words === null || (bound !== "" && !isSafeArgument(deployment))) {
		return NO_COMMAND;
	}
	return `${[...words, args].join(" ")}${bound}`;
}
