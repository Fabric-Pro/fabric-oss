import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

async function check(directory) {
	const offenders = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			offenders.push(...(await check(path)));
		} else if (
			/\.d\.[cm]?ts$/.test(entry.name) &&
			(await readFile(path, "utf8")).includes("sourceMappingURL=")
		) {
			offenders.push(path);
		}
	}
	return offenders;
}

const directories = process.argv.slice(2);
if (directories.length === 0) {
	console.error(
		"Usage: node scripts/check-declaration-maps.mjs <dist> [...dist]",
	);
	process.exitCode = 1;
} else {
	for (const directory of directories) {
		const offenders = await check(directory);
		if (offenders.length > 0) {
			console.error(
				`Declaration source map comments:\n${offenders.join("\n")}`,
			);
			process.exitCode = 1;
		}
	}
}
