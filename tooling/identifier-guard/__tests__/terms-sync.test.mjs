import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const MODULE = new URL("../terms-sync.mjs", import.meta.url);
const SYNC = fileURLToPath(MODULE);
const HOOK = fileURLToPath(
	new URL("../../../.githooks/pre-push", import.meta.url),
);
const REPO = fileURLToPath(new URL("../../..", import.meta.url));

// Deliberately synthetic. Real names must never appear in this repo —
// that is the whole point of the thing under test.
const TERMS = ["ZephyrCorp", "NorthWind Systems"].join("\n");
const STAMP_A = "2026-08-03T13:19:11Z";
const STAMP_B = "2026-08-06T09:00:00Z";

let seq = 0;

/**
 * A repo root the module will read. ROOT is captured at module load, so each
 * case imports a fresh copy pointed at its own directory.
 *
 * @param {{ terms?: string, stamp?: string }} [files]
 * @returns {Promise<{ dir: string, mod: any }>}
 */
async function withRoot(files = {}) {
	const dir = mkdtempSync(join(tmpdir(), "terms-sync-"));
	if (files.terms !== undefined) {
		writeFileSync(join(dir, ".blocked-terms"), files.terms);
		if (files.writtenAt) {
			const when = new Date(files.writtenAt);
			utimesSync(join(dir, ".blocked-terms"), when, when);
		}
	}
	if (files.stamp !== undefined) {
		writeFileSync(join(dir, ".blocked-terms.stamp"), files.stamp);
	}
	process.env.FABRIC_REPO_ROOT = dir;
	const mod = await import(`${MODULE.href}?case=${seq++}`);
	return { dir, mod };
}

/**
 * A throwaway git repo with an origin, plus a fake `gh` on PATH. Together these
 * let the CLI run its real code path — including the `gh api` shell-out —
 * without a network or an account.
 *
 * @param {{ stamp?: string, list?: string, failing?: boolean }} opts
 * @returns {{ dir: string, env: Record<string, string> }}
 */
function withFakeGh(opts) {
	const dir = mkdtempSync(join(tmpdir(), "terms-gh-"));
	const bin = mkdtempSync(join(tmpdir(), "terms-bin-"));

	execFileSync("git", ["init", "--quiet"], { cwd: dir });
	execFileSync(
		"git",
		[
			"remote",
			"add",
			"origin",
			"https://github.com/example-org/example-repo.git",
		],
		{ cwd: dir },
	);

	// Answers `secrets/<name>` with a timestamp and `variables/<name>` with the
	// list; anything else, or --failing, exits non-zero like a real denial.
	writeFileSync(
		join(bin, "gh"),
		[
			"#!/usr/bin/env sh",
			opts.failing ? "exit 1" : "",
			'case "$*" in',
			`*actions/secrets/*) echo "${opts.stamp ?? STAMP_A}" ;;`,
			opts.list !== undefined
				? `*actions/variables/*) printf '%s\\n' '${opts.list}' ;;`
				: "",
			"*) exit 1 ;;",
			"esac",
		].join("\n"),
		{ mode: 0o755 },
	);

	return {
		dir,
		env: { FABRIC_REPO_ROOT: dir, PATH: `${bin}:${process.env.PATH}` },
	};
}

/**
 * @param {string[]} args
 * @param {Record<string, string>} env
 * @returns {{ code: number, stderr: string }}
 */
function runCli(args, env) {
	const res = spawnSync(process.execPath, [SYNC, ...args], {
		env: { ...process.env, CI: "", FABRIC_TERMS_SOURCE: "", ...env },
		encoding: "utf8",
	});
	return { code: res.status ?? 1, stderr: String(res.stderr ?? "") };
}

describe("terms-sync — state matrix", () => {
	it("no local list is a silent no-op, never a nag", async () => {
		const { mod } = await withRoot();
		const state = mod.resolveState({ remoteStamp: () => STAMP_A });
		assert.equal(state.state, "absent");
	});

	it("an unreachable shared list is 'unknown', not stale", async () => {
		const { mod } = await withRoot({ terms: TERMS, stamp: STAMP_A });
		const state = mod.resolveState({ remoteStamp: () => null });
		assert.equal(state.state, "unknown");
	});

	it("a matching stamp is fresh", async () => {
		const { mod } = await withRoot({ terms: TERMS, stamp: STAMP_A });
		assert.equal(
			mod.resolveState({ remoteStamp: () => STAMP_A }).state,
			"fresh",
		);
	});

	it("a differing stamp is positively stale", async () => {
		const { mod } = await withRoot({ terms: TERMS, stamp: STAMP_A });
		assert.equal(
			mod.resolveState({ remoteStamp: () => STAMP_B }).state,
			"stale",
		);
	});

	it("with no stamp, a copy written BEFORE the shared list changed is stale", async () => {
		// The case that actually happens: a list handed over months ago and never
		// touched since. It cannot contain changes made after it was written.
		const { mod } = await withRoot({
			terms: TERMS,
			writtenAt: "2026-07-30T16:40:00Z",
		});
		const state = mod.resolveState({ remoteStamp: () => STAMP_A });
		assert.equal(state.state, "stale");
		assert.equal(state.evidence, "mtime");
	});

	it("with no stamp, a copy written AFTER the shared list changed is fresh", async () => {
		const { mod } = await withRoot({
			terms: TERMS,
			writtenAt: "2026-08-05T09:00:00Z",
		});
		const state = mod.resolveState({ remoteStamp: () => STAMP_A });
		assert.equal(state.state, "fresh");
		assert.equal(state.evidence, "mtime");
	});

	it("an empty stamp file falls back to the file's age, not to a free pass", async () => {
		const { mod } = await withRoot({
			terms: TERMS,
			stamp: "  \n",
			writtenAt: "2026-07-30T16:40:00Z",
		});
		assert.equal(
			mod.resolveState({ remoteStamp: () => STAMP_A }).state,
			"stale",
		);
	});

	it("a stamp beats the file's age in both directions", async () => {
		// Freshly written file, but the stamp proves which version it holds.
		const { mod } = await withRoot({
			terms: TERMS,
			stamp: "2026-01-01T00:00:00Z",
			writtenAt: "2026-08-09T09:00:00Z",
		});
		const state = mod.resolveState({ remoteStamp: () => STAMP_A });
		assert.equal(state.state, "stale");
		assert.equal(state.evidence, "stamp");
	});
});

describe("terms-sync — a failed fetch never marks a stale list as current", () => {
	it("leaves the stamp alone when the source yields nothing", async () => {
		const { mod } = await withRoot({ terms: TERMS, stamp: STAMP_A });
		const state = mod.resolveState({ remoteStamp: () => STAMP_B });

		const result = mod.sync(state, {
			source: "variable:LIST",
			fetchList: () => null,
		});

		assert.equal(result.synced, false);
		assert.equal(
			mod.readStamp(),
			STAMP_A,
			"stamp must not advance on a failed fetch",
		);
	});

	it("rejects an empty list as a failed fetch", async () => {
		const { mod } = await withRoot({ terms: TERMS, stamp: STAMP_A });
		const state = mod.resolveState({ remoteStamp: () => STAMP_B });
		assert.equal(
			mod.sync(state, {
				source: "variable:LIST",
				fetchList: () => "  \n",
			}).synced,
			false,
		);
	});

	it("writes list and stamp together on success", async () => {
		const { mod } = await withRoot({ terms: "OldCorp", stamp: STAMP_A });
		const state = mod.resolveState({ remoteStamp: () => STAMP_B });

		assert.equal(
			mod.sync(state, { source: "variable:LIST", fetchList: () => TERMS })
				.synced,
			true,
		);
		assert.equal(mod.readStamp(), STAMP_B);
	});

	it("does nothing without a configured source", async () => {
		const { mod } = await withRoot({ terms: TERMS, stamp: STAMP_A });
		const state = mod.resolveState({ remoteStamp: () => STAMP_B });
		const result = mod.sync(state, { source: undefined });
		assert.equal(result.synced, false);
		assert.match(String(result.reason), /FABRIC_TERMS_SOURCE/);
	});
});

describe("terms-sync — origin parsing decides whether the guard works at all", () => {
	// If a remote form fails to resolve, remoteStamp() returns null, the state is
	// "unknown", and the whole guard fails open forever without saying anything.
	// SSH is what every developer on this repo actually uses.
	const forms = [
		["git@github.example:example-org/example-repo.git", "SSH, with .git"],
		["git@github.example:example-org/example-repo", "SSH, bare"],
		["https://github.com/example-org/example-repo.git", "HTTPS, with .git"],
		["https://github.com/example-org/example-repo", "HTTPS, bare"],
		[
			"ssh://git@github.example/example-org/example-repo.git",
			"ssh:// scheme",
		],
	];

	for (const [url, label] of forms) {
		it(`resolves ${label}`, async () => {
			const { dir, mod } = await withRoot();
			execFileSync("git", ["init", "--quiet"], { cwd: dir });
			execFileSync("git", ["remote", "add", "origin", url], { cwd: dir });
			assert.equal(mod.originSlug(), "example-org/example-repo");
		});
	}

	it("returns null when there is no origin at all", async () => {
		const { dir, mod } = await withRoot();
		execFileSync("git", ["init", "--quiet"], { cwd: dir });
		assert.equal(mod.originSlug(), null);
	});
});

describe("terms-sync — source parsing", () => {
	it("parses a variable source", async () => {
		const { mod } = await withRoot();
		assert.deepEqual(mod.parseSource("variable:TERMS_LIST"), {
			kind: "variable",
			name: "TERMS_LIST",
		});
	});

	it("parses a repo source with and without a ref", async () => {
		const { mod } = await withRoot();
		assert.deepEqual(
			mod.parseSource("repo:example-org/ops:terms/list.txt"),
			{
				kind: "repo",
				slug: "example-org/ops",
				path: "terms/list.txt",
				ref: undefined,
			},
		);
		assert.equal(
			mod.parseSource("repo:example-org/ops:terms/list.txt@main").ref,
			"main",
		);
	});

	it("returns null for anything it does not understand", async () => {
		const { mod } = await withRoot();
		assert.equal(mod.parseSource("https://example.com/list.txt"), null);
		assert.equal(mod.parseSource(""), null);
		assert.equal(mod.parseSource(undefined), null);
	});
});

describe("terms-sync — CLI exit codes, against a fake gh", () => {
	it("exits 0 and stays quiet with no local list", () => {
		const { env } = withFakeGh({});
		const res = runCli([], env);
		assert.equal(res.code, 0);
		assert.equal(res.stderr.trim(), "");
	});

	it("exits 3 and explains itself when known-stale and unfetchable", () => {
		const { dir, env } = withFakeGh({ stamp: STAMP_B });
		writeFileSync(join(dir, ".blocked-terms"), TERMS);
		writeFileSync(join(dir, ".blocked-terms.stamp"), STAMP_A);

		const res = runCli([], env);
		assert.equal(res.code, 3);
		assert.match(res.stderr, /out of date/);
		assert.match(res.stderr, /pnpm terms:sync/);
	});

	it("exits 3 for an un-stamped copy older than the shared list", () => {
		// No stamp exists on any machine yet, so this path is what decides
		// whether the guard does anything at all in practice.
		const { dir, env } = withFakeGh({ stamp: STAMP_A });
		const file = join(dir, ".blocked-terms");
		writeFileSync(file, TERMS);
		const old = new Date("2026-07-30T16:40:00Z");
		utimesSync(file, old, old);

		const res = runCli([], env);
		assert.equal(res.code, 3);
		assert.match(res.stderr, /predates the current list/);
		// Replacing the file IS the fix; the message must lead with that rather
		// than name a command, which would imply a step that does not exist.
		assert.match(res.stderr, /replace \.blocked-terms/);
		assert.match(
			res.stderr,
			/--no-verify/,
			"the escape hatch must be findable",
		);
	});

	it("exits 0 for an un-stamped copy newer than the shared list", () => {
		const { dir, env } = withFakeGh({ stamp: STAMP_A });
		writeFileSync(join(dir, ".blocked-terms"), TERMS); // written just now
		const res = runCli([], env);
		assert.equal(res.code, 0);
		assert.equal(res.stderr.trim(), "");
	});

	it("exits 0 when gh cannot answer at all", () => {
		const { dir, env } = withFakeGh({ failing: true });
		writeFileSync(join(dir, ".blocked-terms"), TERMS);
		writeFileSync(join(dir, ".blocked-terms.stamp"), STAMP_A);

		const res = runCli([], env);
		assert.equal(res.code, 0, "being offline must never block a push");
		assert.match(res.stderr, /could not reach/);
	});

	it("fetches through the real gh code path when a source is configured", () => {
		const { dir, env } = withFakeGh({
			stamp: STAMP_B,
			list: "FetchedCorp",
		});
		writeFileSync(join(dir, ".blocked-terms"), TERMS);
		writeFileSync(join(dir, ".blocked-terms.stamp"), STAMP_A);

		const res = runCli([], {
			...env,
			FABRIC_TERMS_SOURCE: "variable:TERMS_LIST",
		});
		assert.equal(res.code, 0);
		assert.match(res.stderr, /updated/);

		const written = execFileSync("cat", [join(dir, ".blocked-terms")], {
			encoding: "utf8",
		});
		assert.match(written, /FetchedCorp/);
	});

	it("--check reports without writing", () => {
		const { dir, env } = withFakeGh({
			stamp: STAMP_B,
			list: "FetchedCorp",
		});
		writeFileSync(join(dir, ".blocked-terms"), TERMS);
		writeFileSync(join(dir, ".blocked-terms.stamp"), STAMP_A);

		const res = runCli(["--check"], {
			...env,
			FABRIC_TERMS_SOURCE: "variable:TERMS_LIST",
		});
		assert.equal(res.code, 3);
		assert.equal(
			execFileSync("cat", [join(dir, ".blocked-terms.stamp")], {
				encoding: "utf8",
			}).trim(),
			STAMP_A,
			"--check must not write",
		);
	});

	it("--bootstrap installs a missing list, and never fails an install", () => {
		const { dir, env } = withFakeGh({
			stamp: STAMP_A,
			list: "FetchedCorp",
		});

		const res = runCli(["--bootstrap"], {
			...env,
			FABRIC_TERMS_SOURCE: "variable:TERMS_LIST",
		});
		assert.equal(res.code, 0);
		assert.match(
			execFileSync("cat", [join(dir, ".blocked-terms")], {
				encoding: "utf8",
			}),
			/FetchedCorp/,
		);
	});

	it("--accept stamps a hand-placed list, making detection work with no source", () => {
		const { dir, env } = withFakeGh({ stamp: STAMP_B });
		writeFileSync(join(dir, ".blocked-terms"), TERMS);

		assert.equal(runCli(["--accept"], env).code, 0);
		assert.equal(
			execFileSync("cat", [join(dir, ".blocked-terms.stamp")], {
				encoding: "utf8",
			}).trim(),
			STAMP_B,
		);
		// Now current, so the next push is silent — and a later change is caught.
		assert.equal(runCli([], env).code, 0);
	});

	it("--accept refuses when there is no list to accept", () => {
		const { env } = withFakeGh({ stamp: STAMP_A });
		assert.equal(runCli(["--accept"], env).code, 3);
	});

	it("--accept records nothing when the shared list is unreachable", () => {
		const { dir, env } = withFakeGh({ failing: true });
		writeFileSync(join(dir, ".blocked-terms"), TERMS);
		assert.equal(runCli(["--accept"], env).code, 3);
		assert.throws(() =>
			execFileSync("cat", [join(dir, ".blocked-terms.stamp")]),
		);
	});

	it("--bootstrap does nothing in CI", () => {
		const { dir, env } = withFakeGh({
			stamp: STAMP_A,
			list: "FetchedCorp",
		});
		const res = runCli(["--bootstrap"], {
			...env,
			CI: "1",
			FABRIC_TERMS_SOURCE: "variable:TERMS_LIST",
		});
		assert.equal(res.code, 0);
		assert.equal(res.stderr.trim(), "");
		assert.throws(() => execFileSync("cat", [join(dir, ".blocked-terms")]));
	});
});

describe("pre-push hook — refs are checked before anything is published", () => {
	/**
	 * @param {string} stdin  git's `<local ref> <local sha> <remote ref> <remote sha>`
	 * @returns {{ code: number, stderr: string }}
	 */
	function runHook(stdin) {
		const scratch = mkdtempSync(join(tmpdir(), "terms-hook-"));
		const res = spawnSync("sh", [HOOK], {
			cwd: REPO, // git runs hooks from the repo root
			input: stdin,
			encoding: "utf8",
			env: {
				...process.env,
				// Point the freshness check at an empty directory so the hook
				// never touches the real list, and supply terms inline.
				FABRIC_REPO_ROOT: scratch,
				FABRIC_BLOCKED_TERMS: TERMS,
			},
		});
		return { code: res.status ?? 1, stderr: String(res.stderr ?? "") };
	}

	const sha = "a".repeat(40);
	const zero = "0".repeat(40);

	it("aborts the push when a branch name carries a blocked term", () => {
		const res = runHook(
			`refs/heads/x ${sha} refs/heads/feature/zephyr-corp-migration ${zero}\n`,
		);
		assert.equal(res.code, 1);
		assert.match(res.stderr, /Push aborted/);
		assert.doesNotMatch(
			res.stderr,
			/ZephyrCorp/i,
			"the term itself must never be printed",
		);
	});

	it("checks the REMOTE name, not the local one", () => {
		// git push origin HEAD:other-name publishes a name that never existed here.
		const res = runHook(
			`refs/heads/safe-local ${sha} refs/heads/northwind-systems ${zero}\n`,
		);
		assert.equal(res.code, 1);
	});

	it("allows a clean push", () => {
		const res = runHook(
			`refs/heads/x ${sha} refs/heads/feature/example-work ${zero}\n`,
		);
		assert.equal(res.code, 0);
	});

	it("ignores branch deletions — nothing is being published", () => {
		const res = runHook(
			`(delete) ${zero} refs/heads/zephyr-corp ${zero}\n`,
		);
		assert.equal(res.code, 0);
	});

	it("checks every ref in a multi-ref push", () => {
		const res = runHook(
			`refs/heads/a ${sha} refs/heads/feature/fine ${zero}\n` +
				`refs/heads/b ${sha} refs/heads/zephyrcorp-thing ${zero}\n`,
		);
		assert.equal(res.code, 1);
	});

	it("checks tag names too", () => {
		const res = runHook(
			`refs/tags/v1 ${sha} refs/tags/zephyr-corp-v1 ${zero}\n`,
		);
		assert.equal(res.code, 1);
	});

	it("offers the rename only when a ref is what failed", () => {
		const clean = runHook(
			`refs/heads/x ${sha} refs/heads/feature/example-work ${zero}\n`,
		);
		assert.doesNotMatch(clean.stderr, /git branch -m/);

		const bad = runHook(
			`refs/heads/x ${sha} refs/heads/zephyr-corp ${zero}\n`,
		);
		assert.match(bad.stderr, /git branch -m/);
	});
});
