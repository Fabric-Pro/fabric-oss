import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * The content hash `deploy-seeds` stores per seed, so an unchanged seed is
 * skipped on the next deploy: the seed file plus every dependency.
 *
 * A dependency may be a directory of seed data, such as `prisma/skills-seed`,
 * whose folders a seed reads at run time. Every file under it counts, by its
 * path relative to that directory and its bytes, in a fixed order, so adding,
 * editing, renaming or removing a file re-runs the seed. A file dependency is
 * hashed exactly as before, so no other seed's stored hash changes.
 */
export function seedContentHash(
	seedFilePath: string,
	dependencyPaths: readonly string[] = [],
): string {
	const hash = createHash("sha256");
	hash.update(readFileSync(seedFilePath, "utf-8"));
	for (const dependency of dependencyPaths) {
		if (!statSync(dependency).isDirectory()) {
			hash.update(readFileSync(dependency, "utf-8"));
			continue;
		}
		for (const [path, file] of filesUnder(dependency)) {
			hash.update(path);
			hash.update(readFileSync(file));
		}
	}
	return hash.digest("hex").slice(0, 16);
}

/** Every file under `directory`, as [forward-slash relative path, absolute path], sorted by path. */
function filesUnder(directory: string): Array<[string, string]> {
	return readdirSync(directory, { withFileTypes: true, recursive: true })
		.filter((entry) => entry.isFile())
		.map((entry): [string, string] => {
			const file = join(entry.parentPath, entry.name);
			return [relative(directory, file).replaceAll("\\", "/"), file];
		})
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}
