import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

// The copy's push needs no database or provider: keep their modules out.
vi.mock("@repo/database", () => ({}));
vi.mock("@repo/integrations", () => ({}));
vi.mock("@repo/integrations/instruction-pull-requests", () => ({}));

import { initBranchWorkspace } from "../instruction-branch-git";
import {
	ConsolidationStepError,
	pushCopiedCommit,
} from "../instruction-consolidation-git";
import {
	buildGitEnv,
	commitTree,
	readBaseTree,
	writeProposalTree,
} from "../instruction-sync-git";

// Real git over file://, in the pattern of instruction-branch-git.real-git.
// Skipped cleanly where git is absent.
let hasGit = true;
try {
	execFileSync("git", ["--version"], { stdio: "ignore" });
} catch {
	hasGit = false;
}

const MAIL = ["dev", "example.com"].join("@");
const PERSON = { name: "Example Person", email: MAIL };
const FABRIC = { name: "Fabric", email: ["noreply", "example.com"].join("@") };
const DATE = "2026-11-04T00:00:00Z";
const BRANCH = "main";

let work: string;
let remote: string;
let base: string;
let counter = 0;

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		env: {
			PATH: process.env.PATH,
			HOME: work,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
		},
		encoding: "utf8",
	}).trim();
}

/** The production env, plus the file protocol for this test only. */
function env(): NodeJS.ProcessEnv {
	return {
		...buildGitEnv({ home: work }),
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: "protocol.file.allow",
		GIT_CONFIG_VALUE_0: "always",
	};
}

async function workspace(): Promise<{ dir: string; env: NodeJS.ProcessEnv }> {
	const run = path.join(work, `run-${counter++}`);
	await mkdir(run, { recursive: true });
	const dir = path.join(run, "target");
	await initBranchWorkspace({
		url: pathToFileURL(remote).href,
		targetRef: BRANCH,
		dir,
		env: env(),
	});
	return { dir, env: env() };
}

/** A commit on `base` in `dir` that adds `file`; returns its SHA and tree. */
async function copyCommit(
	dir: string,
	file: string,
	message: string,
): Promise<{ sha: string; tree: string }> {
	const indexFile = path.join(work, `idx-${counter++}`);
	await readBaseTree({ dir, sha: base, indexFile, env: env() });
	const { tree } = await writeProposalTree({
		dir,
		indexFile,
		env: env(),
		delta: [
			{
				path: file,
				mode: "100644",
				bytes: Buffer.from("copied\n", "utf8"),
			},
		],
	});
	const sha = await commitTree({
		dir,
		tree,
		parent: base,
		author: PERSON,
		committer: FABRIC,
		message,
		date: DATE,
		env: env(),
	});
	return { sha, tree };
}

/** Another writer lands `sha` on the remote branch, outside the code under test. */
function landElsewhere(dir: string, sha: string): void {
	git(dir, [
		"-c",
		"protocol.file.allow=always",
		"push",
		"-q",
		"origin",
		`${sha}:refs/heads/${BRANCH}`,
	]);
}

function remoteTip(): string {
	return git(remote, ["rev-parse", `refs/heads/${BRANCH}`]);
}

describe.skipIf(!hasGit)("consolidation copy push against real git", () => {
	beforeAll(async () => {
		work = await mkdtemp(path.join(tmpdir(), "consolidation-real-git-"));
		const seed = path.join(work, "seed");
		await mkdir(seed, { recursive: true });
		await writeFile(path.join(seed, "README.md"), "initial\n");
		git(seed, ["init", "-q", "-b", BRANCH]);
		git(seed, ["add", "-A"]);
		git(seed, [
			"-c",
			"user.name=Example",
			"-c",
			`user.email=${MAIL}`,
			"commit",
			"-q",
			"-m",
			"Initial commit",
		]);
		remote = path.join(work, "remote.git");
		git(work, ["clone", "-q", "--bare", seed, remote]);
		git(remote, ["config", "uploadpack.allowFilter", "true"]);
		git(remote, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
		base = git(remote, ["rev-parse", `refs/heads/${BRANCH}`]);
		// While `land-then-refuse` exists, the remote writes the pushed
		// commit and then reports the push as failed: a push that landed
		// but whose answer the worker never saw as a success.
		const hook = path.join(remote, "hooks", "update");
		await writeFile(
			hook,
			[
				"#!/bin/sh",
				'if [ -f "$GIT_DIR/land-then-refuse" ]; then',
				'  (unset GIT_QUARANTINE_PATH GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES; git update-ref "$1" "$3")',
				'  echo "answer lost" >&2',
				"  exit 1",
				"fi",
				"exit 0",
				"",
			].join("\n"),
		);
		await chmod(hook, 0o755);
	}, 120_000);

	afterAll(async () => {
		await rm(work, { recursive: true, force: true });
	});

	beforeEach(async () => {
		git(remote, ["update-ref", `refs/heads/${BRANCH}`, base]);
		await rm(path.join(remote, "land-then-refuse"), { force: true });
	});

	it("pushes a fast-forward and returns its own commit", async () => {
		const ws = await workspace();
		const copy = await copyCommit(
			ws.dir,
			"AGENTS.md",
			"Move AI instructions",
		);
		await expect(
			pushCopiedCommit(
				ws,
				{ ...copy, expected: base, branch: BRANCH },
				new AbortController().signal,
			),
		).resolves.toBe(copy.sha);
		expect(remoteTip()).toBe(copy.sha);
	});

	it("counts a refused push as done when the remote already carries the commit", async () => {
		const ws = await workspace();
		const copy = await copyCommit(
			ws.dir,
			"AGENTS.md",
			"Move AI instructions",
		);
		await writeFile(path.join(remote, "land-then-refuse"), "");
		await expect(
			pushCopiedCommit(
				ws,
				{ ...copy, expected: base, branch: BRANCH },
				new AbortController().signal,
			),
		).resolves.toBe(copy.sha);
		expect(remoteTip()).toBe(copy.sha);
	});

	it("returns the remote commit when an equivalent one (same tree) already landed", async () => {
		const ws = await workspace();
		const earlier = await copyCommit(
			ws.dir,
			"AGENTS.md",
			"Move AI instructions (earlier attempt)",
		);
		landElsewhere(ws.dir, earlier.sha);
		const copy = await copyCommit(
			ws.dir,
			"AGENTS.md",
			"Move AI instructions",
		);
		expect(copy.tree).toBe(earlier.tree);
		expect(copy.sha).not.toBe(earlier.sha);
		await expect(
			pushCopiedCommit(
				ws,
				{ ...copy, expected: base, branch: BRANCH },
				new AbortController().signal,
			),
		).resolves.toBe(earlier.sha);
		expect(remoteTip()).toBe(earlier.sha);
	});

	it("stays PUSH_REFUSED when the remote carries a different tree", async () => {
		const ws = await workspace();
		const other = await copyCommit(ws.dir, "OTHER.md", "Someone else");
		landElsewhere(ws.dir, other.sha);
		const copy = await copyCommit(
			ws.dir,
			"AGENTS.md",
			"Move AI instructions",
		);
		const pushed = pushCopiedCommit(
			ws,
			{ ...copy, expected: base, branch: BRANCH },
			new AbortController().signal,
		);
		await expect(pushed).rejects.toBeInstanceOf(ConsolidationStepError);
		await expect(pushed).rejects.toMatchObject({ code: "PUSH_REFUSED" });
		expect(remoteTip()).toBe(other.sha);
	});
});
