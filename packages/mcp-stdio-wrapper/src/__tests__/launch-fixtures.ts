import assert from "node:assert/strict";
import childProcess, {
	type ChildProcess,
	type ExecFileOptions,
	type SpawnOptions,
} from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import type { MockTracker } from "node:test";

/** Supply a local package directory without running npm or fetching packages. */
export function stubNpmRoot(mock: MockTracker, root: string) {
	const npm = mock.fn(
		(
			file: string,
			args: string[],
			_options: ExecFileOptions,
			callback: (error: null, stdout: string) => void,
		) => {
			assert.equal(file, "npm");
			assert.deepEqual(args, ["root", "-g"]);
			callback(null, root);
			return new childProcess.ChildProcess();
		},
	);
	const method = mock.method(childProcess, "execFile", npm);
	syncBuiltinESMExports();
	return {
		mock: npm.mock,
		restore: () => {
			method.mock.restore();
			syncBuiltinESMExports();
		},
	};
}

export function stubSpawn(
	mock: MockTracker,
	implementation: (
		executable: string,
		args: string[],
		options: SpawnOptions,
	) => ChildProcess,
) {
	const spawn = mock.fn(implementation);
	const method = mock.method(childProcess, "spawn", spawn);
	syncBuiltinESMExports();
	return {
		mock: spawn.mock,
		restore: () => {
			method.mock.restore();
			syncBuiltinESMExports();
		},
	};
}

/** Keep tests offline even if package discovery or launch policy regresses. */
export function allowOnlyNodeSpawns(mock: MockTracker) {
	const spawn = childProcess.spawn;
	stubSpawn(mock, (executable, args, options) => {
		assert.equal(executable, process.execPath);
		return spawn(executable, args, options);
	});
}

export async function writePackageBin(
	root: string,
	name: string,
	version: string,
	script: string,
) {
	const directory = join(root, name);
	await mkdir(directory, { recursive: true });
	await writeFile(
		join(directory, "package.json"),
		JSON.stringify({ version, bin: "cli.cjs" }),
	);
	const bin = join(directory, "cli.cjs");
	await writeFile(bin, script);
	return bin;
}
