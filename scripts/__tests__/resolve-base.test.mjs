import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	BaseResolutionError,
	extractBaseArg,
	resolveBase,
} from "../lib/resolve-base.mjs";

/** @param {string} cwd @param {string[]} args */
function git(cwd, args) {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout.trim();
}

/** @param {string} cwd @param {string} name */
function commit(cwd, name) {
	writeFileSync(join(cwd, name), name);
	git(cwd, ["add", name]);
	git(cwd, [
		"-c",
		"user.name=t",
		"-c",
		"user.email=t@example.com",
		"commit",
		"-q",
		"-m",
		name,
	]);
}

/**
 * Builds diverged histories, like the real remotes (master only gets relayed
 * squashes): root -> m1 (origin/master) and root -> s1 -> s2 (origin/staging).
 * HEAD starts at root on branch "work".
 * @param {import("node:test").TestContext} t
 */
function createRepo(t) {
	const dir = mkdtempSync(join(tmpdir(), "resolve-base-"));
	t.after(() => rmSync(dir, { force: true, recursive: true }));
	mkdirSync(dir, { recursive: true });
	git(dir, ["init", "-q", "-b", "work"]);
	commit(dir, "root");
	git(dir, ["checkout", "-q", "-b", "m"]);
	commit(dir, "m1");
	git(dir, ["update-ref", "refs/remotes/origin/master", "HEAD"]);
	git(dir, ["checkout", "-q", "work"]);
	commit(dir, "s1");
	commit(dir, "s2");
	git(dir, ["update-ref", "refs/remotes/origin/staging", "HEAD"]);
	return dir;
}

test("picks origin/staging for a branch cut from staging", (t) => {
	const dir = createRepo(t);
	commit(dir, "mine");
	assert.equal(resolveBase({ cwd: dir }).base, "origin/staging");
});

test("picks origin/master for a branch cut from master", (t) => {
	const dir = createRepo(t);
	git(dir, ["checkout", "-q", "-b", "from-master", "origin/master"]);
	commit(dir, "mine");
	assert.equal(resolveBase({ cwd: dir }).base, "origin/master");
});

test("prefers origin/staging on a tie", (t) => {
	const dir = createRepo(t);
	// Cut from the common ancestor: one commit ahead of each remote.
	git(dir, ["checkout", "-q", "-b", "from-root", "work~2"]);
	commit(dir, "mine");
	assert.equal(resolveBase({ cwd: dir }).base, "origin/staging");
});

test("uses the only candidate that exists", (t) => {
	const dir = createRepo(t);
	git(dir, ["update-ref", "-d", "refs/remotes/origin/staging"]);
	assert.equal(resolveBase({ cwd: dir }).base, "origin/master");
});

test("an explicit base wins over the candidates", (t) => {
	const dir = createRepo(t);
	commit(dir, "mine");
	assert.equal(
		resolveBase({ cwd: dir, explicit: "origin/master" }).base,
		"origin/master",
	);
});

test("an explicit base that does not exist fails", (t) => {
	const dir = createRepo(t);
	assert.throws(
		() => resolveBase({ cwd: dir, explicit: "origin/nope" }),
		BaseResolutionError,
	);
});

test("fails with a --base hint when no candidate exists", (t) => {
	const dir = createRepo(t);
	git(dir, ["update-ref", "-d", "refs/remotes/origin/staging"]);
	git(dir, ["update-ref", "-d", "refs/remotes/origin/master"]);
	assert.throws(
		() => resolveBase({ cwd: dir }),
		(error) =>
			error instanceof BaseResolutionError &&
			/--base=<ref>/.test(error.message),
	);
});

test("extractBaseArg removes --base in both spellings and keeps the rest", () => {
	assert.deepEqual(
		extractBaseArg(["--changed", "--base=origin/x", "--dry=json"]),
		{
			base: "origin/x",
			rest: ["--changed", "--dry=json"],
		},
	);
	assert.deepEqual(extractBaseArg(["--base", "origin/y", "--changed"]), {
		base: "origin/y",
		rest: ["--changed"],
	});
	assert.deepEqual(extractBaseArg(["--changed"]), {
		base: undefined,
		rest: ["--changed"],
	});
	assert.throws(() => extractBaseArg(["--base="]), BaseResolutionError);
	assert.throws(() => extractBaseArg(["--base"]), BaseResolutionError);
});
