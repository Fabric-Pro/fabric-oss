/**
 * Every regular file under the pushed folder that the ignore rules leave in,
 * found without following a single symlink.
 *
 * `lstat` on every entry, never `stat`: a link is reported as a link and not
 * descended into or read, whatever it points at. A folder of notes that
 * happens to hold `secrets -> ~/.ssh` must not upload the key. Ignored paths
 * are dropped before anything else is asked of them, so a link inside
 * `node_modules/` is not reported, and an ignored directory is never walked.
 *
 * The file reads that follow go through `readFileSafely`, which walks the
 * path again segment by segment and refuses a symlinked component, so a
 * directory swapped for a link between this walk and the read is refused
 * there rather than followed.
 */
import type { Stats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import type { ContextIgnoreRules } from "./ignore.js";

interface WalkedFile {
	/** Relative to the folder, `/`-separated whatever the platform. */
	path: string;
	size: number;
}

export interface ContextWalk {
	files: WalkedFile[];
	/** Links, reported and never followed. */
	symlinks: string[];
	/** Fifos, sockets, devices: not files, never opened. */
	special: string[];
	/**
	 * Paths the ignore matcher cannot evaluate (a segment made only of dots,
	 * such as `...`, reads to it as a relative-path escape).
	 */
	unmatchable: string[];
	/**
	 * Entries the ignore rules dropped, as the listing spelled them: files,
	 * links, and directories (which are not descended into, so what is
	 * beneath one is ignored with it). With `files` and the lists above, this
	 * is everything the walk saw, which is how a lock path is told apart as
	 * "still here but excluded" or "gone" without asking the filesystem about
	 * a spelling it may match case-insensitively.
	 */
	ignored: IgnoredEntry[];
}

interface IgnoredEntry {
	path: string;
	directory: boolean;
}

function byPath(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

export async function walkContextDirectory(
	root: string,
	rules: ContextIgnoreRules,
): Promise<ContextWalk> {
	const walk: ContextWalk = {
		files: [],
		symlinks: [],
		special: [],
		unmatchable: [],
		ignored: [],
	};
	const pending: string[] = [""];
	while (pending.length > 0) {
		const relativeDirectory = pending.pop() as string;
		const names = await readdir(path.join(root, relativeDirectory));
		for (const name of names) {
			const relative = relativeDirectory
				? `${relativeDirectory}/${name}`
				: name;
			let stats: Stats;
			try {
				stats = await lstat(path.join(root, relative));
			} catch (error) {
				// Deleted between the listing and the look: nothing to send.
				if ((error as NodeJS.ErrnoException).code === "ENOENT") {
					continue;
				}
				throw error;
			}

			let ignored: boolean;
			try {
				// A link is matched as both a file and a directory: it is
				// never followed either way, and `node_modules -> ../x` in a
				// workspace package is the ignored directory, not a link
				// worth reporting.
				ignored = stats.isDirectory()
					? rules.ignoresDirectory(relative)
					: stats.isSymbolicLink()
						? rules.ignoresFile(relative) ||
							rules.ignoresDirectory(relative)
						: rules.ignoresFile(relative);
			} catch {
				walk.unmatchable.push(relative);
				continue;
			}
			if (ignored) {
				walk.ignored.push({
					path: relative,
					// A link was matched as a directory too, so what would sit
					// beneath it counts as ignored with it.
					directory: stats.isDirectory() || stats.isSymbolicLink(),
				});
				continue;
			}

			if (stats.isSymbolicLink()) {
				walk.symlinks.push(relative);
			} else if (stats.isDirectory()) {
				pending.push(relative);
			} else if (stats.isFile()) {
				walk.files.push({ path: relative, size: stats.size });
			} else {
				walk.special.push(relative);
			}
		}
	}
	walk.files.sort((a, b) => byPath(a.path, b.path));
	walk.symlinks.sort(byPath);
	walk.special.sort(byPath);
	walk.unmatchable.sort(byPath);
	walk.ignored.sort((a, b) => byPath(a.path, b.path));
	return walk;
}
