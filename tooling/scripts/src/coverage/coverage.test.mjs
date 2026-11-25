import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

test("sets the coverage flag in the spawned Vitest environment", () => {
	const dir = mkdtempSync(join(tmpdir(), "coverage-runner-"));
	try {
		writeFileSync(
			join(dir, "pnpm"),
			`#!/usr/bin/env node
const [command, task] = process.argv.slice(2);
if (command === "list") {
	console.log(JSON.stringify([{ name: "example", path: process.cwd() + "/tooling/scripts" }]));
} else if (command === "exec" && task === "vitest") {
	console.log(process.env.FABRIC_COVERAGE_RUN);
} else if (command !== "turbo" || task !== "run") {
	process.exitCode = 1;
}
`,
			{ mode: 0o755 },
		);
		const output = execFileSync(
			process.execPath,
			[
				fileURLToPath(new URL("./coverage.mjs", import.meta.url)),
				"job",
				"rest-1",
				dir,
			],
			{
				encoding: "utf8",
				env: {
					...process.env,
					PATH: `${dir}${delimiter}${process.env.PATH}`,
					FABRIC_COVERAGE_RUN: "0",
				},
			},
		);
		assert.equal(output.trim(), "1");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
