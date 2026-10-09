import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPTS = fileURLToPath(new URL("..", import.meta.url));

/** @param {string} cwd @param {string[]} args */
function git(cwd, args) {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout.trim();
}

/**
 * A git repo with the gate copied in and a fake `pnpm` first on PATH. The fake
 * records what the gate gave it and writes the status JSON named by the
 * FAKE_STATUS env var ("none" writes no file; "garbage" writes bad JSON).
 * It reports whether the untracked changeset was visible through
 * GIT_INDEX_FILE, which is how the tests see the intent-to-add.
 * @param {import("node:test").TestContext} t
 */
function createFixture(t) {
	const dir = mkdtempSync(join(tmpdir(), "changeset-gate-test-"));
	t.after(() => rmSync(dir, { force: true, recursive: true }));
	git(dir, ["init", "-q", "-b", "work"]);
	mkdirSync(join(dir, ".changeset"));
	writeFileSync(join(dir, ".changeset/README.md"), "readme");
	writeFileSync(join(dir, "a.txt"), "a");
	git(dir, ["add", "."]);
	git(dir, [
		"-c",
		"user.name=t",
		"-c",
		"user.email=t@example.com",
		"commit",
		"-q",
		"-m",
		"root",
	]);
	git(dir, ["update-ref", "refs/remotes/origin/staging", "HEAD"]);

	mkdirSync(join(dir, "scripts/lib"), { recursive: true });
	copyFileSync(
		join(SCRIPTS, "changeset-gate.mjs"),
		join(dir, "scripts/changeset-gate.mjs"),
	);
	copyFileSync(
		join(SCRIPTS, "lib/resolve-base.mjs"),
		join(dir, "scripts/lib/resolve-base.mjs"),
	);

	const bin = join(dir, "fake-bin");
	mkdirSync(bin);
	const fake = join(bin, "pnpm");
	writeFileSync(
		fake,
		[
			"#!/usr/bin/env node",
			'const fs = require("node:fs");',
			'const { spawnSync } = require("node:child_process");',
			"const args = process.argv.slice(2);",
			'const outArg = args.find((a) => a.startsWith("--output="));',
			'const ls = spawnSync("git", ["ls-files", "--", ".changeset"], { encoding: "utf8" });',
			"fs.writeFileSync(process.env.FAKE_RECORD, JSON.stringify({",
			"\targs, indexFile: process.env.GIT_INDEX_FILE, tracked: ls.stdout.split('\\n').filter(Boolean),",
			"}));",
			'const mode = process.env.FAKE_STATUS ?? "ok";',
			'const out = outArg.slice("--output=".length);',
			'if (mode === "ok") fs.writeFileSync(out, JSON.stringify({ changesets: [{}], releases: [{ name: "fabric-app", type: "patch" }] }));',
			'if (mode === "empty") fs.writeFileSync(out, JSON.stringify({ changesets: [], releases: [] }));',
			'if (mode === "garbage") fs.writeFileSync(out, "{nope");',
			"if (process.env.FAKE_SLEEP) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_SLEEP));",
			'if (process.env.FAKE_EXIT) { console.error("fake changeset stderr"); process.exit(Number(process.env.FAKE_EXIT)); }',
		].join("\n"),
	);
	chmodSync(fake, 0o755);
	return { dir, record: join(dir, "record.json") };
}

/**
 * @param {{ dir: string, record: string }} fixture
 * @param {string[]} args
 * @param {Record<string, string>} [env]
 */
function gate(fixture, args = [], env = {}) {
	const result = spawnSync(
		process.execPath,
		[join(fixture.dir, "scripts/changeset-gate.mjs"), ...args],
		{
			cwd: fixture.dir,
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${join(fixture.dir, "fake-bin")}:${process.env.PATH}`,
				FAKE_RECORD: fixture.record,
				...env,
			},
		},
	);
	return {
		code: result.status,
		stdout: result.stdout,
		stderr: result.stderr,
	};
}

test("exits 0 and lists releases when .releases is non-empty", (t) => {
	const fixture = createFixture(t);
	const result = gate(fixture);
	assert.equal(result.code, 0, result.stderr);
	assert.match(result.stdout, /Base: origin\/staging/);
	assert.match(result.stdout, /^fabric-app: patch$/m);
	assert.match(result.stderr, /Base: origin\/staging/);
	const { args } = JSON.parse(readFileSync(fixture.record, "utf8"));
	assert.ok(args.includes("--since=origin/staging"));
});

test("exits 1 when .releases is empty", (t) => {
	const fixture = createFixture(t);
	const result = gate(fixture, [], { FAKE_STATUS: "empty" });
	assert.equal(result.code, 1);
	assert.match(result.stderr, /FAILED/);
});

test("a missing output file is a failure and changeset's stderr is printed", (t) => {
	const fixture = createFixture(t);
	const result = gate(fixture, [], { FAKE_STATUS: "none", FAKE_EXIT: "1" });
	assert.equal(result.code, 1);
	assert.match(result.stderr, /wrote no output file/);
	assert.match(result.stderr, /fake changeset stderr/);
});

test("unparseable output is a failure", (t) => {
	const fixture = createFixture(t);
	const result = gate(fixture, [], { FAKE_STATUS: "garbage" });
	assert.equal(result.code, 1);
	assert.match(result.stderr, /not valid JSON/);
});

test("a nonzero changeset exit fails even when releases are present", (t) => {
	const fixture = createFixture(t);
	const result = gate(fixture, [], { FAKE_EXIT: "1" });
	assert.equal(result.code, 1);
	assert.match(result.stderr, /exited 1/);
});

test("an explicit --base is used and an unknown argument is a usage error", (t) => {
	const fixture = createFixture(t);
	git(fixture.dir, ["update-ref", "refs/remotes/origin/other", "HEAD"]);
	const ok = gate(fixture, ["--base=origin/other"]);
	assert.equal(ok.code, 0, ok.stderr);
	assert.ok(
		JSON.parse(readFileSync(fixture.record, "utf8")).args.includes(
			"--since=origin/other",
		),
	);
	assert.equal(gate(fixture, ["--bogus"]).code, 2);
});

test("exits 2 when no base can be resolved", (t) => {
	const fixture = createFixture(t);
	git(fixture.dir, ["update-ref", "-d", "refs/remotes/origin/staging"]);
	const result = gate(fixture);
	assert.equal(result.code, 2);
	assert.match(result.stderr, /--base=<ref>/);
});

test("untracked changesets are visible to changeset only through a temp index, and the real index is untouched", (t) => {
	const fixture = createFixture(t);
	writeFileSync(join(fixture.dir, ".changeset/new-one.md"), "---\n---\nx\n");
	const indexPath = join(
		fixture.dir,
		git(fixture.dir, ["rev-parse", "--git-path", "index"]),
	);
	const before = readFileSync(indexPath);

	const result = gate(fixture);
	assert.equal(result.code, 0, result.stderr);

	const record = JSON.parse(readFileSync(fixture.record, "utf8"));
	assert.notEqual(record.indexFile, indexPath);
	assert.ok(
		record.tracked.includes(".changeset/new-one.md"),
		"temp index lacked the intent-to-add",
	);
	assert.deepEqual(readFileSync(indexPath), before, "real index changed");
	assert.equal(
		git(fixture.dir, ["ls-files", "--", ".changeset"]).includes(
			"new-one.md",
		),
		false,
	);
	assert.equal(existsSync(record.indexFile), false, "temp index leaked");
});

test("cleans up temp files on a failure path too", (t) => {
	const fixture = createFixture(t);
	const countGates = () =>
		readdirSync(tmpdir()).filter(
			(n) => n.startsWith("changeset-gate-") && !n.includes("test"),
		).length;
	const before = countGates();
	gate(fixture, [], { FAKE_STATUS: "empty" });
	assert.equal(countGates(), before);
});

test("rejects changeset names that git quotes, naming them", (t) => {
	const fixture = createFixture(t);
	writeFileSync(join(fixture.dir, ".changeset/café.md"), "---\n---\nx\n");
	const result = gate(fixture);
	assert.equal(result.code, 2);
	assert.match(result.stderr, /café\.md/);
	assert.match(result.stderr, /letters, digits/);
	assert.match(result.stderr, /Rename/);
	assert.equal(existsSync(fixture.record), false, "changeset must not run");
});

test("an interrupt during changeset exits 130 and leaves no temp files", async (t) => {
	const fixture = createFixture(t);
	const tmp = mkdtempSync(join(tmpdir(), "gate-tmp-"));
	t.after(() => rmSync(tmp, { force: true, recursive: true }));
	const child = spawn(
		process.execPath,
		[join(fixture.dir, "scripts/changeset-gate.mjs")],
		{
			cwd: fixture.dir,
			env: {
				...process.env,
				PATH: `${join(fixture.dir, "fake-bin")}:${process.env.PATH}`,
				FAKE_RECORD: fixture.record,
				FAKE_SLEEP: "1500",
				TMPDIR: tmp,
			},
			stdio: "ignore",
		},
	);
	const exited = new Promise((resolve) =>
		child.on("exit", (code, signal) => resolve({ code, signal })),
	);
	for (let i = 0; i < 100 && !existsSync(fixture.record); i++) {
		await new Promise((r) => setTimeout(r, 50));
	}
	assert.equal(existsSync(fixture.record), true, "fake pnpm never started");
	assert.equal(readdirSync(tmp).length, 1, "temp dir should exist mid-run");
	child.kill("SIGINT");
	const result = await exited;
	assert.deepEqual(result, { code: 130, signal: null });
	assert.deepEqual(readdirSync(tmp), []);
});

/** @param {{ dir: string }} fixture @param {string} name */
function addChangeset(fixture, name, body = "x") {
	const file = join(fixture.dir, ".changeset", name);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `---\n---\n${body}\n`);
	return file;
}

test("a deleted odd-named changeset does not fail the name check", (t) => {
	const fixture = createFixture(t);
	const odd = addChangeset(fixture, "café.md");
	git(fixture.dir, ["add", "-A"]);
	git(fixture.dir, [
		"-c",
		"user.name=t",
		"-c",
		"user.email=t@example.com",
		"commit",
		"-q",
		"-m",
		"odd",
	]);
	git(fixture.dir, ["update-ref", "refs/remotes/origin/staging", "HEAD"]);
	rmSync(odd);
	// Different body, or git pairs the deletion with this file as a rename.
	addChangeset(fixture, "normal.md", "something else entirely");
	const result = gate(fixture);
	assert.equal(result.code, 0, result.stderr);
});

test("odd names outside what Changesets reads are ignored", (t) => {
	const fixture = createFixture(t);
	addChangeset(fixture, "archive/café.md");
	addChangeset(fixture, ".café.md");
	const result = gate(fixture);
	assert.equal(result.code, 0, result.stderr);
});

test("an odd name under .changeset/pre is still rejected", (t) => {
	const fixture = createFixture(t);
	addChangeset(fixture, "pre/café.md");
	assert.equal(gate(fixture).code, 2);
});
