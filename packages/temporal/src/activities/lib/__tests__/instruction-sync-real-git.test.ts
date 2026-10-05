import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	buildGitEnv,
	cloneTreeless,
	fetchPinnedCommit,
	listTree,
	MAX_INVENTORY_ENTRIES,
	readBlobCapped,
	revParseHead,
	sparseCheckout,
} from "../instruction-sync-git";

// Real git, real partial clone, real sparse checkout. The paths below are
// the ones gitignore syntax treats specially, each next to the neighbour a
// wrong escape would also select.
//
// A backslash is a path separator on Windows: its file systems cannot hold such
// a name and git there refuses it (core.protectNTFS), so that one path is
// present wherever a name can carry it.
const BACKSLASH_PATHS: Record<string, string> =
	process.platform === "win32"
		? {}
		: { "agents/back\\slash.md": "backslash" };
const FILES: Record<string, string> = {
	"agents/x[1].md": "bracket",
	"agents/x1.md": "neighbour of the bracket",
	"agents/#hash.md": "hash",
	"agents/!bang.md": "bang",
	"agents/a b.md": "inner space",
	"agents/ab.md": "neighbour of the space",
	"agents/ lead.md": "leading space",
	...BACKSLASH_PATHS,
	"agents/run.sh": "#!/bin/sh\necho hi\n",
	"outside.md": "not under the root",
};
const KEPT = [
	"agents/x[1].md",
	"agents/#hash.md",
	"agents/!bang.md",
	"agents/a b.md",
	"agents/ lead.md",
	...Object.keys(BACKSLASH_PATHS),
	"agents/run.sh",
];

// Real git only: this suite drives cloneTreeless/sparseCheckout/etc against
// an actual local repository, which a CI image or dev machine without git
// installed cannot provide. Skip cleanly rather than fail so the rest of the
// package's tests stay green; Task 12's smoke run exercises this same path
// against the worker image's git, so a skip here is never the only coverage.
let hasGit = true;
try {
	execFileSync("git", ["--version"], { stdio: "ignore" });
} catch {
	hasGit = false;
}

let work: string;
let source: string;
let firstCommit: string;

function git(cwd: string, args: string[], input?: string): string {
	return execFileSync("git", args, {
		cwd,
		env: {
			PATH: process.env.PATH,
			HOME: work,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
		},
		input,
		encoding: "utf8",
	}).trim();
}

/**
 * The production env, plus permission to use the file protocol for this test
 * only. `host` (review S3, signature change) is the clone URL's own host --
 * empty for a plain filesystem path -- passed for parity with production
 * call sites even though this suite's local `file://` fixture never raises
 * an askpass prompt (no credential is set here, so `buildGitEnv` would not
 * require it either way).
 */
function syncEnv(home: string): NodeJS.ProcessEnv {
	return {
		...buildGitEnv({ home, host: pathToFileURL(source).host }),
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: "protocol.file.allow",
		GIT_CONFIG_VALUE_0: "always",
	};
}

async function walk(dir: string, prefix = ""): Promise<string[]> {
	const out: string[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		if (entry.name === ".git") {
			continue;
		}
		const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
		if (entry.isDirectory()) {
			out.push(...(await walk(path.join(dir, entry.name), rel)));
		} else {
			out.push(rel);
		}
	}
	return out;
}

async function freshClone(
	name: string,
): Promise<{ run: string; dir: string; env: NodeJS.ProcessEnv }> {
	const run = path.join(work, name);
	await mkdir(run);
	const dir = path.join(run, "repo");
	const env = syncEnv(run);
	await cloneTreeless({
		cwd: run,
		url: pathToFileURL(source).href,
		ref: "main",
		dir,
		env,
	});
	return { run, dir, env };
}

describe.skipIf(!hasGit)("repository sync against real git", () => {
	beforeAll(async () => {
		work = await mkdtemp(path.join(tmpdir(), "sync-real-git-"));
		source = path.join(work, "source");
		await mkdir(path.join(source, "agents"), { recursive: true });
		for (const [name, body] of Object.entries(FILES)) {
			await writeFile(path.join(source, name), body);
		}
		git(source, ["init", "-q", "-b", "main"]);
		git(source, ["config", "uploadpack.allowFilter", "true"]);
		git(source, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
		git(source, ["add", "-A"]);
		// The executable bit and the symlink go into the index directly: a
		// Windows file has no executable bit for `add` to read, and a symlink
		// there needs a privilege.
		git(source, ["update-index", "--chmod=+x", "agents/run.sh"]);
		const linkBlob = git(source, ["hash-object", "-w", "--stdin"], "x1.md");
		git(source, [
			"update-index",
			"--add",
			"--cacheinfo",
			`120000,${linkBlob},agents/link.md`,
		]);
		git(source, [
			"-c",
			"user.name=Example",
			"-c",
			"user.email=dev@example.com",
			"commit",
			"-q",
			"-m",
			"one",
		]);
		firstCommit = git(source, ["rev-parse", "HEAD"]);
		await writeFile(
			path.join(source, "agents/x1.md"),
			"changed on the second commit",
		);
		git(source, ["add", "agents/x1.md"]);
		git(source, [
			"-c",
			"user.name=Example",
			"-c",
			"user.email=dev@example.com",
			"commit",
			"-q",
			"-m",
			"two",
		]);
	});

	afterAll(async () => {
		await rm(work, { recursive: true, force: true });
	});

	it("inventories the root without blobs, keeps modes, and drops the symlink", async () => {
		const { dir, env } = await freshClone("inventory");
		const listed = await listTree({
			dir,
			rootPath: "agents",
			env,
			maxEntries: MAX_INVENTORY_ENTRIES,
		});
		expect(listed.ok).toBe(true);
		if (!listed.ok) {
			return;
		}
		const byPath = new Map(
			listed.summary.files.map((f) => [f.repoPath, f]),
		);
		expect([...byPath.keys()].sort()).toEqual(
			Object.keys(FILES)
				.filter((p) => p.startsWith("agents/"))
				.sort(),
		);
		expect(byPath.get("agents/run.sh")?.gitMode).toBe("100755");
		expect(byPath.get("agents/x[1].md")?.relPath).toBe("x[1].md");
		expect(listed.summary.excludedCount).toBe(1);
		expect(await walk(dir)).toEqual([]);
	});

	it("materialises exactly the kept files, never a neighbour a wrong escape would select", async () => {
		const { dir, env } = await freshClone("sparse");
		await sparseCheckout({ dir, repoPaths: KEPT, env });
		expect((await walk(dir)).sort()).toEqual([...KEPT].sort());
	});

	it("reads one blob under a cap and refuses a larger one", async () => {
		const { dir, env } = await freshClone("blob");
		const listed = await listTree({
			dir,
			rootPath: "agents",
			env,
			maxEntries: MAX_INVENTORY_ENTRIES,
		});
		if (!listed.ok) {
			throw new Error("inventory failed");
		}
		const oid = listed.summary.files.find(
			(f) => f.repoPath === "agents/x[1].md",
		)?.oid as string;
		expect(
			(await readBlobCapped({ dir, oid, env, maxBytes: 1024 }))?.toString(
				"utf8",
			),
		).toBe("bracket");
		expect(await readBlobCapped({ dir, oid, env, maxBytes: 3 })).toBeNull();
	});

	it("re-fetches a pinned, no-longer-tip commit for an adopting retry", async () => {
		const { dir, env } = await freshClone("adopt");
		expect(await revParseHead({ dir, env })).not.toBe(firstCommit);
		await fetchPinnedCommit({ dir, sha: firstCommit, env });
		expect(await revParseHead({ dir, env })).toBe(firstCommit);
		await sparseCheckout({ dir, repoPaths: ["agents/x1.md"], env });
		expect(await walk(dir)).toEqual(["agents/x1.md"]);
	});
});
