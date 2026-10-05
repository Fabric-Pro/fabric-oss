/**
 * `init --clone <folder>`: the folder the repository is cloned into.
 *
 * It is `folder` under the current directory (or `--dest`), made if it is not
 * there. A folder that already holds anything is refused before a request is
 * made: `git clone` would refuse it too, but only after the person has waited
 * for the deployment to say where to clone from.
 */
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { outcomeFailure } from "./outcome.js";

export async function resolveCloneFolder(
	base: string,
	folder: string,
): Promise<string> {
	const target = path.resolve(base, folder);
	const stats = await lstat(target).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") {
			return null;
		}
		throw error;
	});
	if (stats === null) {
		return target;
	}
	if (!stats.isDirectory() || (await readdir(target)).length > 0) {
		throw outcomeFailure("clone-folder-in-use", {});
	}
	return target;
}
