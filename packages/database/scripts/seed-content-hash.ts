import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	openSync,
	readdirSync,
	readFileSync,
} from "node:fs";
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
	hash.update(readSeedFile(seedFilePath).toString("utf8"));
	for (const dependency of dependencyPaths) {
		const descriptor = openSync(
			dependency,
			constants.O_RDONLY | constants.O_NONBLOCK,
		);
		try {
			const info = fstatSync(descriptor);
			if (info.isFile()) {
				hash.update(readFileSync(descriptor, "utf-8"));
				continue;
			}
			if (!info.isDirectory()) {
				throw new Error(
					"Seed dependency is not a regular file or directory.",
				);
			}
			for (const [path, file] of filesUnder(dependency)) {
				hash.update(path);
				hash.update(readSeedFile(file));
			}
		} finally {
			closeSync(descriptor);
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

/** Metadata and content must describe the same opened file. */
function readSeedFile(file: string): Buffer {
	const descriptor = openSync(
		file,
		constants.O_RDONLY | constants.O_NONBLOCK,
	);
	try {
		if (!fstatSync(descriptor).isFile()) {
			throw new Error("Seed input is not a regular file.");
		}
		return readFileSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}
