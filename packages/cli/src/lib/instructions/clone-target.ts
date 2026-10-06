/**
 * `init --clone <folder>`: the folder the repository is cloned into.
 *
 * It is `folder` under the current directory (or `--dest`), made if it is not
 * there. An existing directory remains eligible for normal checkout
 * classification after the deployment identifies its repository: a matching
 * clone is reused, while a non-Git or foreign folder is refused without Git
 * being asked to overwrite it.
 */
import { lstat } from "node:fs/promises";
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
	if (!stats.isDirectory()) {
		throw outcomeFailure("clone-folder-in-use", {});
	}
	return target;
}
