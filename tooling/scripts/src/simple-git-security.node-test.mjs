import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const owners = ["packages/atlas", "packages/temporal"];

function packageManifest(entry, name) {
	let directory = dirname(entry);
	for (;;) {
		try {
			const manifest = JSON.parse(
				readFileSync(join(directory, "package.json"), "utf8"),
			);
			if (manifest.name === name) {
				return manifest;
			}
		} catch (error) {
			if (error.code !== "ENOENT") {
				throw error;
			}
		}
		const parent = dirname(directory);
		assert.notEqual(parent, directory, `Missing manifest for ${name}`);
		directory = parent;
	}
}

const childSetup = String.raw`
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
const require = createRequire(process.argv[1]);
const { simpleGit, GitPluginError } = require("simple-git");
const parser = createRequire(require.resolve("simple-git"))("@simple-git/argv-parser");
const directory = mkdtempSync(join(tmpdir(), "simple-git-security-"));
const repo = join(directory, "repo");
const helper = join(directory, "example-helper");
const marker = helper + ".marker";
mkdirSync(repo);
// This harmless executable writes only within this disposable directory.
writeFileSync(helper, '#!/bin/sh\nprintf invoked >> "$0.marker"\n', { mode: 0o700 });
const commandEnv = { PATH: process.env.PATH, HOME: directory, XDG_CONFIG_HOME: directory };
const gitCommand = (cwd, ...args) => execFileSync("git", args, { cwd, env: commandEnv, encoding: "utf8", timeout: 3000 });
gitCommand(repo, "init", "--initial-branch=main");
gitCommand(repo, "config", "user.name", "Example Contributor");
gitCommand(repo, "config", "user.email", "dev@example.com");
writeFileSync(join(repo, "example.txt"), "ordinary\n");
gitCommand(repo, "add", "example.txt");
gitCommand(repo, "commit", "-m", "Ordinary initial commit");
const git = () => simpleGit(repo).env(commandEnv);
const rejectUnsafe = (operation) => assert.rejects(operation, error => error instanceof GitPluginError && error.plugin === "unsafe");
try {
`;

function runChild(owner, script) {
	const result = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`${childSetup}\n${script}\n} finally { rmSync(directory, { recursive: true, force: true }); }`,
			join(root, owner, "package.json"),
		],
		{ encoding: "utf8", timeout: 15000, maxBuffer: 65536 },
	);
	assert.ifError(result.error);
	assert.equal(result.signal, null, result.stderr);
	assert.equal(result.status, 0, result.stderr || result.stdout);
}

for (const owner of owners) {
	test(`${owner}: simple-git and its actual parser resolve fixed versions and named exports`, async () => {
		const require = createRequire(join(root, owner, "package.json"));
		const entry = require.resolve("simple-git");
		const parser = createRequire(entry).resolve("@simple-git/argv-parser");
		assert.equal(packageManifest(entry, "simple-git").version, "4.0.2");
		assert.equal(
			packageManifest(parser, "@simple-git/argv-parser").version,
			"2.0.1",
		);
		assert.equal(typeof require("simple-git").simpleGit, "function");
		assert.equal(
			typeof (
				await import(pathToFileURL(join(dirname(entry), "index.mjs")))
			).simpleGit,
			"function",
		);
	});
	test(`${owner}: receive-pack and exec abbreviations cannot execute a helper`, () => {
		runChild(
			owner,
			`
			const remote = join(directory, "remote.git");
			gitCommand(directory, "init", "--bare", remote);
			await git().push([remote, "HEAD:refs/heads/control"]);
			assert.equal(gitCommand(directory, "--git-dir=" + remote, "rev-parse", "refs/heads/control").trim(), gitCommand(repo, "rev-parse", "HEAD").trim());
			for (const flag of ["--receive-p", "--receive-pa", "--receive-pack", "--exe", "--exec"]) {
				for (const args of [[flag + "=" + helper], [flag, helper]]) {
					await assert.rejects(git().push([remote, "HEAD:refs/heads/example", ...args]));
					assert.equal(existsSync(marker), false, flag + " must never execute the helper");
				}
			}
		`,
		);
	});
	test(`${owner}: include and conditional include are blocked in config options, raw arguments and writes`, () => {
		runChild(
			owner,
			String.raw`
			const include = join(directory, "included.gitconfig");
			writeFileSync(include, "[core]\n  sshCommand = " + helper + "\n");
			for (const key of ["include.path", "includeIf.gitdir:" + repo + "/.git/.path"]) {
				await rejectUnsafe(() => simpleGit({ baseDir: repo, config: [key + "=" + include] }).env(commandEnv).raw(["status", "--short"]));
				await rejectUnsafe(() => git().raw(["-c", key + "=" + include, "status", "--short"]));
				await rejectUnsafe(() => git().raw(["config", "--local", key, include]));
			}
			assert.equal(existsSync(marker), false);
		`,
		);
	});
	test(`${owner}: trailer commands are blocked before interpret-trailers executes them`, () => {
		runChild(
			owner,
			String.raw`
			const input = join(directory, "message.txt");
			writeFileSync(input, "Ordinary message\n\n");
			for (const key of ["trailer.audit.cmd", "trailer.audit.command"]) {
				const args = ["interpret-trailers", "--trailer", "audit:ordinary", input];
				await rejectUnsafe(() => simpleGit({ baseDir: repo, config: [key + "=" + helper] }).env(commandEnv).raw(args));
				await rejectUnsafe(() => git().raw(["-c", key + "=" + helper, ...args]));
				await rejectUnsafe(() => git().raw(["config", "--local", key, helper]));
			}
			assert.equal(existsSync(marker), false);
		`,
		);
	});
	test(`${owner}: VISUAL is classified and explicit editor environment values are rejected in every casing`, () => {
		runChild(
			owner,
			`
			for (const key of ["VISUAL", "visual", "ViSuAl", "EDITOR", "GIT_EDITOR"]) {
				assert.ok(parser.parseEnv({ [key]: helper }).vulnerabilities.some(item => item.category === "allowUnsafeEditor"), key);
				await rejectUnsafe(() => simpleGit(repo).env({ ...commandEnv, TERM: "xterm", [key]: helper }).raw(["status", "--short"]));
			}
			assert.equal(existsSync(marker), false);
		`,
		);
	});
	test(`${owner}: ambient Git configuration and editor values are filtered by default`, () => {
		runChild(
			owner,
			`
			process.env.VISUAL = helper;
			process.env.GIT_CONFIG_COUNT = "2";
			process.env.GIT_CONFIG_KEY_0 = "user.name";
			process.env.GIT_CONFIG_VALUE_0 = "Ambient Example";
			process.env.GIT_CONFIG_KEY_1 = "core.editor";
			process.env.GIT_CONFIG_VALUE_1 = helper;
			assert.equal((await simpleGit(repo).raw(["config", "--get", "user.name"])).trim(), "Example Contributor");
			assert.equal(await simpleGit(repo).raw(["status", "--short"]), "");
			assert.equal(existsSync(marker), false);
		`,
		);
	});
	test(`${owner}: ordinary Atlas and Temporal Git operations work without unsafe opt-ins`, () => {
		runChild(
			owner,
			String.raw`
			const source = git();
			const first = (await source.revparse(["HEAD"])).trim();
			writeFileSync(join(repo, "example.txt"), "changed\n");
			mkdirSync(join(repo, "src"));
			writeFileSync(join(repo, "src/example.ts"), "export const ordinary = true;\n");
			await source.addConfig("user.name", "Example Contributor");
			await source.addConfig("user.email", "dev@example.com");
			await source.add(["example.txt", "src/example.ts"]);
			await source.commit("Ordinary second commit");
			const head = (await source.revparse(["HEAD"])).trim();
			const url = pathToFileURL(repo).href;
			assert.match(await source.listRemote(["--symref", url, "HEAD"]), /ref: refs\/heads\/main/);
			const atlasPath = join(directory, "atlas-clone");
			await git().clone(url, atlasPath, ["--depth", "1", "--single-branch", "--branch", "main", "--filter=blob:none", "--no-checkout"]);
			const atlas = simpleGit(atlasPath).env(commandEnv);
			assert.equal((await atlas.revparse(["HEAD"])).trim(), head);
			assert.ok(!Number.isNaN(Date.parse((await atlas.show(["-s", "--format=%cI", "HEAD"])).trim())));
			assert.match(await atlas.raw(["ls-tree", "-r", "--name-only", "HEAD"]), /src\/example.ts/);
			await atlas.raw(["sparse-checkout", "init", "--no-cone"]);
			writeFileSync(join(atlasPath, ".git/info/sparse-checkout"), "/src/example.ts\n");
			await atlas.raw(["checkout"]);
			assert.equal(existsSync(join(atlasPath, "src/example.ts")), true);
			assert.equal(existsSync(join(atlasPath, "example.txt")), false);
			await atlas.raw(["sparse-checkout", "disable"]);
			await atlas.raw(["checkout"]);
			assert.equal(readFileSync(join(atlasPath, "example.txt"), "utf8"), "changed\n");
			const temporalPath = join(directory, "temporal-clone");
			await git().clone(url, temporalPath, ["--depth", "1", "--single-branch", "--branch", "main"]);
			const temporal = simpleGit(temporalPath).env(commandEnv);
			assert.equal((await temporal.log({ maxCount: 1 })).latest.hash, head);
			const pinnedPath = join(directory, "pinned-clone");
			mkdirSync(pinnedPath);
			const pinned = simpleGit(pinnedPath).env(commandEnv);
			await pinned.init();
			await pinned.addRemote("origin", url);
			await pinned.fetch(["--depth", "1", "origin", first]);
			await pinned.checkout("FETCH_HEAD");
			assert.equal((await pinned.revparse(["HEAD"])).trim(), first);
			await temporal.fetch(["--depth", "1", "origin", first]);
			assert.match(await temporal.diff(["--name-only", first + "..HEAD"]), /example.txt/);
			assert.equal((await temporal.raw(["rev-list", "--count", first + "..HEAD"])).trim(), "1");
			const historyPath = join(directory, "history-clone");
			await git().clone(url, historyPath, ["--single-branch", "--branch", "main"]);
			assert.equal((await simpleGit(historyPath).env(commandEnv).raw(["rev-list", "--count", first + "..HEAD"])).trim(), "1");
		`,
		);
	});
	test(`${owner}: abort cancels an actually spawned Git process`, () => {
		runChild(
			owner,
			`
			const fifo = join(repo, "blocked-input");
			execFileSync("mkfifo", [fifo]);
			const controller = new AbortController();
			let started;
			const spawned = new Promise(resolve => { started = resolve; });
			const pending = simpleGit({ baseDir: repo, abort: controller.signal }).env(commandEnv).outputHandler(() => started()).raw(["hash-object", fifo]);
			const rejected = assert.rejects(pending, error => error instanceof GitPluginError && error.plugin === "abort");
			await spawned;
			controller.abort();
			await rejected;
		`,
		);
	});
}
