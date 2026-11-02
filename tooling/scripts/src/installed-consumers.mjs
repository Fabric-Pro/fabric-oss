import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));

export function installedDependency(require, name) {
	const entry = require.resolve(name);
	let directory = dirname(entry);
	while (dirname(directory) !== directory) {
		const path = join(directory, "package.json");
		if (existsSync(path)) {
			const manifest = JSON.parse(readFileSync(path, "utf8"));
			if (
				manifest.name &&
				directory.endsWith(
					join("node_modules", ...manifest.name.split("/")),
				)
			) {
				return { entry, path, manifest, require: createRequire(path) };
			}
		}
		directory = dirname(directory);
	}
	assert.fail(`Missing installed manifest for ${name} at ${entry}`);
}

export function installedConsumers(name, version) {
	const store = join(root, "node_modules/.pnpm");
	// pnpm shortens long Windows store names; trust the package manifest,
	// rather than requiring the directory to contain its complete name/version.
	const prefix = name.replaceAll("/", "+").slice(0, 20);
	const entries = readdirSync(store).filter((value) =>
		value.startsWith(prefix),
	);
	const consumers = entries.flatMap((entry) => {
		const manifestPath = join(
			store,
			entry,
			"node_modules",
			name,
			"package.json",
		);
		if (!existsSync(manifestPath)) {
			return [];
		}
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		return manifest.name === name && manifest.version === version
			? [
					{
						require: createRequire(manifestPath),
						manifest,
					},
				]
			: [];
	});
	assert.ok(
		consumers.length > 0,
		`Missing installed ${name}@${version}; run pnpm install --frozen-lockfile`,
	);
	return consumers;
}
