import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const script = new URL("../check-declaration-maps.mjs", import.meta.url);

for (const [name, files, offenders] of [
	["clean declarations", { "index.d.ts": "export {};" }, []],
	[
		"top-level declaration",
		{ "index.d.ts": "//# sourceMappingURL=index.d.ts.map" },
		["index.d.ts"],
	],
	[
		"nested CJS declaration",
		{ "nested/index.d.cts": "//# sourceMappingURL=index.d.cts.map" },
		["nested/index.d.cts"],
	],
	[
		"ESM declaration",
		{ "index.d.mts": "//# sourceMappingURL=index.d.mts.map" },
		["index.d.mts"],
	],
	[
		"JavaScript maps",
		{ "index.js": "//# sourceMappingURL=index.js.map" },
		[],
	],
]) {
	test(name, async () => {
		const directory = await mkdtemp(join(tmpdir(), "declaration-maps-"));
		try {
			for (const [file, content] of Object.entries(files)) {
				const path = join(directory, file);
				await mkdir(join(path, ".."), { recursive: true });
				await writeFile(path, content);
			}
			const result = spawnSync(
				process.execPath,
				[script.pathname, directory],
				{ encoding: "utf8" },
			);
			assert.equal(
				result.status,
				offenders.length > 0 ? 1 : 0,
				result.stderr,
			);
			for (const offender of offenders) {
				assert.ok(
					result.stderr.includes(join(directory, offender)),
					result.stderr,
				);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
}

test("requires a dist directory", () => {
	const result = spawnSync(process.execPath, [script.pathname], {
		encoding: "utf8",
	});
	assert.equal(result.status, 1);
	assert.match(result.stderr, /Usage:/);
});
