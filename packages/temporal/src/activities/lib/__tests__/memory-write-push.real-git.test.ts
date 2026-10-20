/**
 * The git half of a Living Memory write against real git (ADR-022): a local
 * bare repository stands in for the remote, so the pushes, the lease, the
 * create-only branch and a pre-receive hook that refuses a protected branch
 * are git's own, in the pattern of instruction-branch-git.real-git.test.ts.
 * The provider is a fake adapter that records what it is asked to open.
 *
 * What is pinned: a direct push lands one commit with the member as author,
 * Fabric as committer and the write's trailers; a create-only PUT of a path
 * that exists, a stale `ifMatchOid` and a DELETE of an absent path settle
 * `CONFLICT` with the blob now at the path and write NOTHING (the batch is
 * atomic); the folder's `.contextignore` AT THE TIP leaves a path out
 * (`REFUSED`); a lost lease is redone on the new tip and then lands, and a
 * branch that keeps moving is `BRANCH_BUSY`; a re-run finds the commit an
 * earlier attempt pushed by its trailer instead of pushing twice, and ignores
 * a commit that merely quotes the trailer; a branch that refuses the push
 * becomes a pull request; and the write's own branch is pushed create-only and
 * recognised on a retry. Skipped cleanly where git is absent.
 */
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { renderMemoryWriteText } from "@repo/instructions/pull-request-text";
import type {
	InstructionPullRequestAdapter,
	PullRequestObservation,
} from "@repo/integrations/instruction-pull-requests";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import type { MemoryWriteOutcome } from "../../../lib/memory-write/outcome";
import type { BranchCredential } from "../instruction-branch-credential";
import { initBranchWorkspace } from "../instruction-branch-git";
import { hashBlob } from "../instruction-branch-support";
import { buildGitEnv } from "../instruction-sync-git";
import {
	assertMemoryWriteBranch,
	endsWithOwnWriteTrailer,
	memoryWriteBranch,
	pushMemoryWriteBranch,
} from "../memory-write-git";
import type { HashedWriteEntry } from "../memory-write-plan";
import {
	type MemoryWritePushContext,
	MemoryWriteRefused,
	pushMemoryWrite,
} from "../memory-write-push";

let hasGit = true;
try {
	execFileSync("git", ["--version"], { stdio: "ignore" });
} catch {
	hasGit = false;
}

const MAIL = ["dev", "example.com"].join("@");
const MAIL_FROM = "Fabric <noreply@example.com>";

let work: string;
let remote: string;
let competitor: string;
let base: string;
let counter = 0;

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

/** The production env, plus the file protocol for this test only. */
function fileEnv(): NodeJS.ProcessEnv {
	return {
		...buildGitEnv({ home: work }),
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: "protocol.file.allow",
		GIT_CONFIG_VALUE_0: "always",
	};
}

function remoteTip(branch = "main"): string {
	return git(remote, ["rev-parse", `refs/heads/${branch}`]);
}

function remoteBranches(): string[] {
	return git(remote, ["for-each-ref", "--format=%(refname:short)"])
		.split("\n")
		.filter(Boolean);
}

function remoteFile(rev: string, file: string): string {
	return git(remote, ["show", `${rev}:${file}`]);
}

function remoteMessage(rev: string): string {
	return execFileSync(
		"git",
		["-C", remote, "log", "-n", "1", "--format=%B", rev],
		{
			encoding: "utf8",
		},
	);
}

/** A teammate's commit on top of the remote's `main`, pushed to `ref` (`main` unless told otherwise). */
async function teammatePush(
	file: string,
	content: string,
	ref = "main",
): Promise<string> {
	git(competitor, ["fetch", "-q", "origin"]);
	git(competitor, ["reset", "-q", "--hard", "origin/main"]);
	const full = path.join(competitor, ...file.split("/"));
	await mkdir(path.dirname(full), { recursive: true });
	await writeFile(full, content);
	git(competitor, ["add", "-A"]);
	git(competitor, [
		"-c",
		"user.name=Teammate",
		"-c",
		`user.email=${MAIL}`,
		"commit",
		"-q",
		"-m",
		`teammate ${file}`,
	]);
	git(competitor, ["push", "-q", "origin", `HEAD:${ref}`]);
	return git(competitor, ["rev-parse", "HEAD"]);
}

function fakeAdapter() {
	const open = vi.fn(
		async (input: {
			sourceRef: string;
			targetRef: string;
			title: string;
			body: string;
		}): Promise<PullRequestObservation> => ({
			externalId: "42",
			url: "https://example.com/pull/42",
			state: "OPEN",
			sourceRef: input.sourceRef,
			targetRef: input.targetRef,
			sourceRepository: {
				provider: "GITHUB",
				owner: "example",
				repo: "example",
			},
			headSha: "a".repeat(40),
		}),
	);
	let found: PullRequestObservation | null = null;
	const adapter: InstructionPullRequestAdapter = {
		findOperation: vi.fn(async () =>
			found === null
				? ({ kind: "ABSENT" } as const)
				: ({ kind: "FOUND", value: found } as const),
		),
		open: open as unknown as InstructionPullRequestAdapter["open"],
		get: vi.fn(),
		close: vi.fn(),
		pullRequestHeadRef: () => null,
	};
	return {
		adapter,
		open,
		/** From now on a lookup finds this pull request, as after an earlier attempt opened it. */
		found(observation: PullRequestObservation) {
			found = observation;
		},
	};
}

type Workspace = {
	credential: BranchCredential;
	adapter: ReturnType<typeof fakeAdapter>;
};

async function workspace(name: string): Promise<Workspace> {
	const runDir = path.join(work, `${name}-${counter++}`);
	await mkdir(runDir, { recursive: true });
	const workDir = path.join(runDir, "repo");
	const env = fileEnv();
	const signal = new AbortController().signal;
	const url = pathToFileURL(remote).href;
	await initBranchWorkspace({
		url,
		targetRef: "main",
		dir: workDir,
		env,
		signal,
	});
	const adapter = fakeAdapter();
	const repository = {
		provider: "GITHUB",
		owner: "example",
		repo: "example",
	} as const;
	return {
		adapter,
		credential: {
			destination: {
				integrationId: "int-1",
				syncId: "sync-1",
				repositoryKey: "github:example/example",
				provider: "GITHUB",
				repository,
				targetRef: "main",
				rootPath: "",
			},
			url,
			env,
			secrets: [],
			runDir,
			workDir,
			signal,
			adapter: adapter.adapter,
			target: {
				auth: { token: "t", authMethod: "PAT" },
				repository,
				signal,
			},
			integrationId: "int-1",
		},
	};
}

async function put(
	ws: Workspace,
	filePath: string,
	content: string,
	ifMatchOid: string | null = null,
): Promise<HashedWriteEntry> {
	const blobOid = await hashBlob({
		dir: ws.credential.workDir,
		bytes: Buffer.from(content, "utf8"),
		env: ws.credential.env,
		signal: ws.credential.signal,
	});
	return { path: filePath, op: "PUT", ifMatchOid, blobOid };
}

const del = (filePath: string, ifMatchOid: string): HashedWriteEntry => ({
	path: filePath,
	op: "DELETE",
	ifMatchOid,
	blobOid: null,
});

function context(
	ws: Workspace,
	input: {
		id: string;
		mode: "PULL_REQUEST" | "DIRECT_PUSH";
		entries: HashedWriteEntry[];
		selected?: string;
		message?: string;
		assertStillAllowed?: () => Promise<void>;
	},
): MemoryWritePushContext {
	const text = renderMemoryWriteText({
		message: input.message ?? "Add notes\n\nAn agent's notes.",
		proposerName: "Example Member",
		mailFrom: MAIL_FROM,
		writeId: input.id,
		agentId: "client_example-1",
	});
	if (!text.ok) {
		throw new Error("the test message did not render");
	}
	return {
		credential: ws.credential,
		write: {
			id: input.id,
			ref: "main",
			mode: input.mode,
			createdAt: new Date(Date.now() - 5_000),
		},
		text,
		entries: input.entries,
		selected: input.selected ?? "docs",
		leftOut: ["docs/drafts"],
		assertStillAllowed: input.assertStillAllowed ?? (async () => {}),
		backoffBaseMs: 1,
	};
}

function nextId(): string {
	return `cmemwrite${String(counter++).padStart(8, "0")}`;
}

function committed(outcome: MemoryWriteOutcome) {
	expect(outcome.status).toBe("COMMITTED");
	return outcome as Extract<MemoryWriteOutcome, { status: "COMMITTED" }>;
}

describe.skipIf(!hasGit)(
	"a Living Memory write against real git (ADR-022)",
	() => {
		beforeAll(async () => {
			work = await mkdtemp(path.join(tmpdir(), "memory-write-real-git-"));
			const seed = path.join(work, "seed");
			await mkdir(path.join(seed, "docs", "ai"), { recursive: true });
			await mkdir(path.join(seed, "docs", "private"), {
				recursive: true,
			});
			await mkdir(path.join(seed, "docs2"), { recursive: true });
			await writeFile(path.join(seed, "docs", "README.md"), "# Docs\n");
			await writeFile(
				path.join(seed, "docs", "ai", "existing.md"),
				"existing\n",
			);
			await writeFile(
				path.join(seed, "docs", ".contextignore"),
				"private/\n",
			);
			await writeFile(
				path.join(seed, "docs", "private", "secret.md"),
				"private\n",
			);
			await writeFile(path.join(seed, "docs2", "a.md"), "a\n");
			await writeFile(path.join(seed, "other.md"), "keep\n");
			git(seed, ["init", "-q", "-b", "main"]);
			git(seed, ["add", "-A"]);
			// An ignore file the sync cannot evaluate, as a symbolic link: plumbing,
			// because a Windows file system makes a link only with a privilege.
			const target = git(
				seed,
				["hash-object", "-w", "--stdin"],
				"README.md",
			);
			git(seed, [
				"update-index",
				"--add",
				"--cacheinfo",
				`120000,${target},docs2/.contextignore`,
			]);
			git(seed, [
				"-c",
				"user.name=Example",
				"-c",
				`user.email=${MAIL}`,
				"commit",
				"-q",
				"-m",
				"base",
			]);
			remote = path.join(work, "remote.git");
			git(work, ["clone", "-q", "--bare", seed, remote]);
			git(remote, ["config", "uploadpack.allowFilter", "true"]);
			git(remote, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
			base = git(remote, ["rev-parse", "refs/heads/main"]);
			// A remote that refuses `main` the way a hosting provider refuses a
			// protected branch, while the marker file exists. While `race-main`
			// exists, the hook instead moves `main` to the commit it names once,
			// as a writer whose push lands while ours is in flight: receive-pack
			// then fails to lock the ref. The quarantine forbids ref updates from
			// the hook itself, so the move runs outside it.
			const hook = path.join(remote, "hooks", "pre-receive");
			await writeFile(
				hook,
				[
					"#!/bin/sh",
					"while read old new ref; do",
					'  if [ "$ref" = "refs/heads/main" ] && [ -f "$GIT_DIR/protect-main" ]; then',
					'    echo "protected branch" >&2',
					"    exit 1",
					"  fi",
					'  if [ "$ref" = "refs/heads/main" ] && [ -f "$GIT_DIR/race-main" ]; then',
					'    sha=$(cat "$GIT_DIR/race-main")',
					'    rm -f "$GIT_DIR/race-main"',
					'    (unset GIT_QUARANTINE_PATH GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES; git update-ref refs/heads/main "$sha")',
					"  fi",
					"done",
					"exit 0",
					"",
				].join("\n"),
			);
			await chmod(hook, 0o755);
			competitor = path.join(work, "competitor");
			git(work, ["clone", "-q", remote, competitor]);
		}, 120_000);

		afterAll(async () => {
			await rm(work, { recursive: true, force: true });
		});

		beforeEach(async () => {
			await rm(path.join(remote, "protect-main"), { force: true });
			await rm(path.join(remote, "race-main"), { force: true });
			git(remote, ["update-ref", "refs/heads/main", base]);
			for (const branch of remoteBranches()) {
				if (branch.startsWith("fabric/") || branch === "race-side") {
					git(remote, ["update-ref", "-d", `refs/heads/${branch}`]);
				}
			}
		});

		describe("a direct push", () => {
			it("lands one commit, authored as the member and committed by Fabric, with the write's trailers", async () => {
				const ws = await workspace("direct");
				const id = nextId();
				const outcome = committed(
					await pushMemoryWrite(
						context(ws, {
							id,
							mode: "DIRECT_PUSH",
							entries: [
								await put(ws, "docs/ai/new.md", "# New\n"),
								await put(ws, "docs/ai/other.md", "other\n"),
							],
						}),
					),
				);

				expect(remoteTip()).toBe(outcome.sha);
				expect(git(remote, ["rev-parse", `${outcome.sha}^`])).toBe(
					base,
				);
				expect(outcome).toMatchObject({ ref: "main", fileCount: 2 });
				expect(remoteFile(outcome.sha, "docs/ai/new.md")).toBe("# New");
				expect(remoteFile(outcome.sha, "docs/ai/existing.md")).toBe(
					"existing",
				);
				const message = remoteMessage(outcome.sha);
				expect(message).toContain("Add notes\n\nAn agent's notes.");
				expect(message.trimEnd().split("\n").slice(-2)).toEqual([
					`Fabric-Memory-Write: ${id}`,
					"Fabric-Agent: client_example-1",
				]);
				expect(
					git(remote, [
						"log",
						"-n",
						"1",
						"--format=%an <%ae>|%cn",
						outcome.sha,
					]),
				).toBe("Example Member <noreply@example.com>|Fabric");
			});

			it("replaces a file whose blob the caller saw, keeping its mode, and deletes a file by its blob", async () => {
				const ws = await workspace("replace");
				const seen = git(remote, [
					"rev-parse",
					`${base}:docs/ai/existing.md`,
				]);
				const outcome = committed(
					await pushMemoryWrite(
						context(ws, {
							id: nextId(),
							mode: "DIRECT_PUSH",
							entries: [
								await put(
									ws,
									"docs/ai/existing.md",
									"replaced\n",
									seen,
								),
								del(
									"docs/README.md",
									git(remote, [
										"rev-parse",
										`${base}:docs/README.md`,
									]),
								),
							],
						}),
					),
				);

				expect(remoteFile(outcome.sha, "docs/ai/existing.md")).toBe(
					"replaced",
				);
				expect(
					git(remote, [
						"ls-tree",
						"-r",
						"--name-only",
						outcome.sha,
						"docs/README.md",
					]),
				).toBe("");
			});
		});

		describe("the tip checks (the batch is atomic)", () => {
			it("settles CONFLICT for a create-only PUT of a path that exists, with the blob there, and writes nothing", async () => {
				const ws = await workspace("exists");
				const outcome = await pushMemoryWrite(
					context(ws, {
						id: nextId(),
						mode: "DIRECT_PUSH",
						entries: [
							await put(ws, "docs/ai/fine.md", "fine\n"),
							await put(ws, "docs/ai/existing.md", "clobber\n"),
						],
					}),
				);

				expect(outcome).toEqual({
					status: "CONFLICT",
					paths: [
						{
							path: "docs/ai/existing.md",
							code: "PATH_EXISTS",
							currentOid: git(remote, [
								"rev-parse",
								`${base}:docs/ai/existing.md`,
							]),
						},
					],
				});
				expect(remoteTip()).toBe(base);
				expect(remoteBranches()).toEqual(["main"]);
			});

			it("settles CONFLICT for a stale ifMatchOid, and for a PUT or DELETE of a path that is gone", async () => {
				const ws = await workspace("stale");
				const outcome = await pushMemoryWrite(
					context(ws, {
						id: nextId(),
						mode: "DIRECT_PUSH",
						entries: [
							await put(
								ws,
								"docs/ai/existing.md",
								"x\n",
								"b".repeat(40),
							),
							await put(
								ws,
								"docs/ai/gone.md",
								"x\n",
								"c".repeat(40),
							),
							del("docs/ai/never.md", "d".repeat(40)),
						],
					}),
				);

				expect(outcome).toMatchObject({ status: "CONFLICT" });
				const paths = (
					outcome as Extract<
						MemoryWriteOutcome,
						{ status: "CONFLICT" }
					>
				).paths;
				expect(paths).toEqual([
					{
						path: "docs/ai/existing.md",
						code: "IF_MATCH_MISMATCH",
						currentOid: git(remote, [
							"rev-parse",
							`${base}:docs/ai/existing.md`,
						]),
					},
					{
						path: "docs/ai/gone.md",
						code: "PATH_MISSING",
						currentOid: null,
					},
					{
						path: "docs/ai/never.md",
						code: "PATH_MISSING",
						currentOid: null,
					},
				]);
				expect(remoteTip()).toBe(base);
			});

			it("refuses a path the folder's .contextignore AT THE TIP leaves out, though the defaults keep it", async () => {
				const ws = await workspace("ignore");
				const outcome = await pushMemoryWrite(
					context(ws, {
						id: nextId(),
						mode: "DIRECT_PUSH",
						entries: [
							await put(ws, "docs/ai/fine.md", "fine\n"),
							await put(ws, "docs/private/new.md", "hidden\n"),
						],
					}),
				);

				expect(outcome).toEqual({
					status: "REFUSED",
					code: "PATH_REFUSED",
					paths: [
						{ path: "docs/private/new.md", code: "PATH_EXCLUDED" },
					],
				});
				expect(remoteTip()).toBe(base);
			});

			it("applies the ignore file as it is at the tip now, not as it was when the write was admitted", async () => {
				const ws = await workspace("ignore-moved");
				// A teammate adds a rule after the clone was made but before the tip is read.
				await teammatePush(
					"docs/.contextignore",
					"private/\nai/blocked/\n",
				);
				const outcome = await pushMemoryWrite(
					context(ws, {
						id: nextId(),
						mode: "DIRECT_PUSH",
						entries: [await put(ws, "docs/ai/blocked/a.md", "a\n")],
					}),
				);

				expect(outcome).toMatchObject({
					status: "REFUSED",
					code: "PATH_REFUSED",
					paths: [
						{ path: "docs/ai/blocked/a.md", code: "PATH_EXCLUDED" },
					],
				});
			});

			it("refuses every write when the folder's ignore policy cannot be evaluated", async () => {
				const ws = await workspace("ignore-link");
				const outcome = await pushMemoryWrite(
					context(ws, {
						id: nextId(),
						mode: "DIRECT_PUSH",
						selected: "docs2",
						entries: [await put(ws, "docs2/new.md", "n\n")],
					}),
				);

				expect(outcome).toEqual({
					status: "REFUSED",
					code: "IGNORE_POLICY_UNREADABLE",
				});
				expect(remoteTip()).toBe(base);
			});

			it("refuses a path that is a folder, or lies under a file, and a write that changes nothing", async () => {
				const ws = await workspace("shape");
				const folder = await pushMemoryWrite(
					context(ws, {
						id: nextId(),
						mode: "DIRECT_PUSH",
						entries: [
							await put(ws, "docs/ai", "now a file?\n"),
							// Under the same folder: the folder is still a folder.
							await put(ws, "docs/ai/extra.md", "extra\n"),
							await put(ws, "docs/README.md/inside.md", "x\n"),
						],
					}),
				);
				expect(folder).toEqual({
					status: "REFUSED",
					code: "PATH_REFUSED",
					paths: [
						{ path: "docs/ai", code: "PATH_NOT_A_FILE" },
						{
							path: "docs/README.md/inside.md",
							code: "PATH_NOT_A_FILE",
						},
					],
				});

				const seen = git(remote, [
					"rev-parse",
					`${base}:docs/ai/existing.md`,
				]);
				const same = await pushMemoryWrite(
					context(ws, {
						id: nextId(),
						mode: "DIRECT_PUSH",
						entries: [
							await put(
								ws,
								"docs/ai/existing.md",
								"existing\n",
								seen,
							),
						],
					}),
				);
				expect(same).toEqual({ status: "REFUSED", code: "NO_CHANGE" });
				expect(remoteTip()).toBe(base);
			});
		});

		describe("the lease and retries", () => {
			it("redoes the pass on the new tip after a lost lease and lands both changes", async () => {
				const ws = await workspace("lease");
				let checks = 0;
				const outcome = committed(
					await pushMemoryWrite(
						context(ws, {
							id: nextId(),
							mode: "DIRECT_PUSH",
							entries: [
								await put(ws, "docs/ai/mine.md", "mine\n"),
							],
							// Immediately before the first push, a teammate pushes: the lease is lost.
							assertStillAllowed: async () => {
								checks++;
								if (checks === 1) {
									await teammatePush(
										"docs/ai/theirs.md",
										"theirs\n",
									);
								}
							},
						}),
					),
				);

				expect(checks).toBe(2);
				expect(remoteTip()).toBe(outcome.sha);
				expect(remoteFile(outcome.sha, "docs/ai/mine.md")).toBe("mine");
				expect(remoteFile(outcome.sha, "docs/ai/theirs.md")).toBe(
					"theirs",
				);
				expect(
					git(remote, [
						"rev-list",
						"--count",
						`${base}..${outcome.sha}`,
					]),
				).toBe("2");
			});

			it("redoes the pass when the server loses the race mid-push, instead of opening a pull request", async () => {
				const theirs = await teammatePush(
					"docs/ai/theirs.md",
					"theirs\n",
					"race-side",
				);
				await writeFile(path.join(remote, "race-main"), theirs);
				const ws = await workspace("server-race");
				const outcome = committed(
					await pushMemoryWrite(
						context(ws, {
							id: nextId(),
							mode: "DIRECT_PUSH",
							entries: [
								await put(ws, "docs/ai/mine.md", "mine\n"),
							],
						}),
					),
				);

				expect(ws.adapter.open).not.toHaveBeenCalled();
				expect(remoteTip()).toBe(outcome.sha);
				expect(git(remote, ["rev-parse", `${outcome.sha}^`])).toBe(
					theirs,
				);
				expect(remoteFile(outcome.sha, "docs/ai/mine.md")).toBe("mine");
				expect(remoteFile(outcome.sha, "docs/ai/theirs.md")).toBe(
					"theirs",
				);
			});

			it("reports a conflict that the new tip brings, instead of overwriting the teammate", async () => {
				const ws = await workspace("lease-conflict");
				let checks = 0;
				const outcome = await pushMemoryWrite(
					context(ws, {
						id: nextId(),
						mode: "DIRECT_PUSH",
						entries: [await put(ws, "docs/ai/race.md", "mine\n")],
						assertStillAllowed: async () => {
							checks++;
							if (checks === 1) {
								await teammatePush(
									"docs/ai/race.md",
									"theirs\n",
								);
							}
						},
					}),
				);

				expect(outcome).toMatchObject({
					status: "CONFLICT",
					paths: [{ path: "docs/ai/race.md", code: "PATH_EXISTS" }],
				});
				expect(remoteFile("main", "docs/ai/race.md")).toBe("theirs");
			});

			it("calls the branch busy after five lost leases, retryable, with nothing of the write on it", async () => {
				const ws = await workspace("busy");
				let checks = 0;
				const outcome = await pushMemoryWrite(
					context(ws, {
						id: nextId(),
						mode: "DIRECT_PUSH",
						entries: [await put(ws, "docs/ai/mine.md", "mine\n")],
						assertStillAllowed: async () => {
							checks++;
							await teammatePush(
								`docs/ai/theirs-${checks}.md`,
								"theirs\n",
							);
						},
					}),
				);

				expect(outcome).toEqual({
					status: "FAILED",
					code: "BRANCH_BUSY",
					retryable: true,
				});
				expect(checks).toBe(5);
				expect(
					git(remote, [
						"ls-tree",
						"-r",
						"--name-only",
						"main",
						"docs/ai/mine.md",
					]),
				).toBe("");
			});

			it("stops when the live checks refuse immediately before the push", async () => {
				const ws = await workspace("refused");
				await expect(
					pushMemoryWrite(
						context(ws, {
							id: nextId(),
							mode: "DIRECT_PUSH",
							entries: [
								await put(ws, "docs/ai/mine.md", "mine\n"),
							],
							assertStillAllowed: async () => {
								throw new MemoryWriteRefused(
									"PERMISSION_REVOKED",
								);
							},
						}),
					),
				).rejects.toMatchObject({
					outcome: { status: "REFUSED", code: "PERMISSION_REVOKED" },
				});
				expect(remoteTip()).toBe(base);
			});

			it("finds the commit an earlier attempt pushed by its trailer, and pushes nothing twice", async () => {
				const id = nextId();
				const first = await workspace("rerun-1");
				const pushed = committed(
					await pushMemoryWrite(
						context(first, {
							id,
							mode: "DIRECT_PUSH",
							entries: [
								await put(first, "docs/ai/once.md", "once\n"),
							],
						}),
					),
				);

				// The retry's workspace: the same write, and now the path exists, which
				// would be a conflict if the retry did not recognise its own commit.
				const second = await workspace("rerun-2");
				const again = committed(
					await pushMemoryWrite(
						context(second, {
							id,
							mode: "DIRECT_PUSH",
							entries: [
								await put(second, "docs/ai/once.md", "once\n"),
							],
						}),
					),
				);

				expect(again.sha).toBe(pushed.sha);
				expect(remoteTip()).toBe(pushed.sha);
				expect(
					git(remote, ["rev-list", "--count", `${base}..main`]),
				).toBe("1");
			});

			it("does not take a teammate's commit that quotes the trailer for its own", async () => {
				const id = nextId();
				const ws = await workspace("quoted");
				// A commit whose message quotes the trailer line, but does not end in it.
				git(competitor, ["fetch", "-q", "origin"]);
				git(competitor, ["reset", "-q", "--hard", "origin/main"]);
				await writeFile(path.join(competitor, "quote.md"), "q\n");
				git(competitor, ["add", "-A"]);
				git(competitor, [
					"-c",
					"user.name=Teammate",
					"-c",
					`user.email=${MAIL}`,
					"commit",
					"-q",
					"-m",
					`quoting\n\nFabric-Memory-Write: ${id}\n\nand then more text`,
				]);
				git(competitor, ["push", "-q", "origin", "HEAD:main"]);

				const outcome = committed(
					await pushMemoryWrite(
						context(ws, {
							id,
							mode: "DIRECT_PUSH",
							entries: [
								await put(ws, "docs/ai/real.md", "real\n"),
							],
						}),
					),
				);

				expect(remoteFile(outcome.sha, "docs/ai/real.md")).toBe("real");
				expect(remoteMessage(outcome.sha)).toContain(
					`Fabric-Memory-Write: ${id}`,
				);
			});
		});

		describe("a pull request", () => {
			it("pushes the write's own branch create-only and opens a pull request into the synced branch", async () => {
				const ws = await workspace("pr");
				const id = nextId();
				const outcome = await pushMemoryWrite(
					context(ws, {
						id,
						mode: "PULL_REQUEST",
						entries: [
							await put(ws, "docs/ai/new.md", "# New\n"),
							del(
								"docs/ai/existing.md",
								git(remote, [
									"rev-parse",
									`${base}:docs/ai/existing.md`,
								]),
							),
						],
					}),
				);

				const branch = `fabric/memory/${id}`;
				expect(outcome).toMatchObject({
					status: "PULL_REQUEST",
					branch,
					url: "https://example.com/pull/42",
					externalId: "42",
					reason: "configured",
					ref: "main",
					fileCount: 2,
				});
				expect(remoteTip()).toBe(base);
				expect(remoteTip(branch)).toBe(
					(
						outcome as Extract<
							MemoryWriteOutcome,
							{ status: "PULL_REQUEST" }
						>
					).sha,
				);
				expect(remoteFile(branch, "docs/ai/new.md")).toBe("# New");
				expect(ws.adapter.open).toHaveBeenCalledTimes(1);
				const opened = ws.adapter.open.mock.calls[0]?.[0];
				expect(opened).toMatchObject({
					sourceRef: branch,
					targetRef: "main",
				});
				expect(opened?.title).toBe("Add notes");
				expect(opened?.body).toContain("An agent's notes.");
				expect(opened?.body).toContain("Writes docs/ai/new.md");
				expect(opened?.body).toContain("Deletes docs/ai/existing.md");
				expect(opened?.body).toContain(
					"Opened from Fabric by Example Member",
				);
			});

			it("recognises its own branch on a retry and opens nothing twice", async () => {
				const id = nextId();
				const first = await workspace("pr-1");
				const opened = await pushMemoryWrite(
					context(first, {
						id,
						mode: "PULL_REQUEST",
						entries: [
							await put(first, "docs/ai/new.md", "# New\n"),
						],
					}),
				);
				expect(opened).toMatchObject({ status: "PULL_REQUEST" });

				const second = await workspace("pr-2");
				second.adapter.found({
					externalId: "42",
					url: "https://example.com/pull/42",
					state: "OPEN",
					sourceRef: `fabric/memory/${id}`,
					targetRef: "main",
					sourceRepository: {
						provider: "GITHUB",
						owner: "example",
						repo: "example",
					},
					headSha: "a".repeat(40),
				});
				const again = await pushMemoryWrite(
					context(second, {
						id,
						mode: "PULL_REQUEST",
						// The path exists on the branch only; against the tip it is still free,
						// but a retry must not even look: its branch is already pushed.
						entries: [
							await put(second, "docs/ai/new.md", "# New\n"),
						],
					}),
				);

				expect(again).toMatchObject({
					status: "PULL_REQUEST",
					externalId: "42",
				});
				expect((again as { sha: string }).sha).toBe(
					(opened as { sha: string }).sha,
				);
				expect(second.adapter.open).not.toHaveBeenCalled();
			});

			it("refuses to use a branch of that name that is not this write's", async () => {
				const id = nextId();
				const branch = `fabric/memory/${id}`;
				git(remote, ["update-ref", `refs/heads/${branch}`, base]);
				const ws = await workspace("pr-taken");

				await expect(
					pushMemoryWrite(
						context(ws, {
							id,
							mode: "PULL_REQUEST",
							entries: [
								await put(ws, "docs/ai/new.md", "# New\n"),
							],
						}),
					),
				).rejects.toMatchObject({
					code: "BRANCH_NAME_UNAVAILABLE",
					retryable: false,
				});
				expect(remoteTip(branch)).toBe(base);
				expect(ws.adapter.open).not.toHaveBeenCalled();
			});

			it("settles a conflict as a conflict in pull request mode too, pushing no branch", async () => {
				const ws = await workspace("pr-conflict");
				const id = nextId();
				const outcome = await pushMemoryWrite(
					context(ws, {
						id,
						mode: "PULL_REQUEST",
						entries: [
							await put(ws, "docs/ai/existing.md", "clobber\n"),
						],
					}),
				);

				expect(outcome).toMatchObject({ status: "CONFLICT" });
				expect(remoteBranches()).toEqual(["main"]);
				expect(ws.adapter.open).not.toHaveBeenCalled();
			});
		});

		describe("a branch that refuses the push", () => {
			it("becomes a pull request for the same commit, reason protected", async () => {
				await writeFile(path.join(remote, "protect-main"), "");
				const ws = await workspace("protected");
				const id = nextId();
				const outcome = await pushMemoryWrite(
					context(ws, {
						id,
						mode: "DIRECT_PUSH",
						entries: [await put(ws, "docs/ai/new.md", "# New\n")],
					}),
				);

				const branch = `fabric/memory/${id}`;
				expect(outcome).toMatchObject({
					status: "PULL_REQUEST",
					branch,
					reason: "protected",
				});
				expect(remoteTip()).toBe(base);
				expect(remoteFile(branch, "docs/ai/new.md")).toBe("# New");
				expect(remoteMessage(branch)).toContain(
					`Fabric-Memory-Write: ${id}`,
				);
				expect(ws.adapter.open).toHaveBeenCalledTimes(1);
			});
		});

		describe("the write's branch", () => {
			it("accepts only fabric/memory/<id> and pushes it create-only", async () => {
				const ws = await workspace("branch");
				const id = nextId();
				const branch = memoryWriteBranch(id);
				const args = {
					dir: ws.credential.workDir,
					sha: base,
					branch,
					env: ws.credential.env,
				};

				expect(await pushMemoryWriteBranch(args)).toEqual({
					kind: "created",
				});
				expect(await pushMemoryWriteBranch(args)).toEqual({
					kind: "exists",
				});
				expect(remoteTip(branch)).toBe(base);

				for (const bad of [
					"main",
					"fabric/instructions/members/dev-a1b2/1",
					"fabric/memory/",
					"fabric/memory/short",
					"fabric/memory/../main",
					"fabric/memory/has space abc",
					"refs/heads/fabric/memory/abcdefgh12",
					"-fabric/memory/abcdefgh12",
				]) {
					expect(() => assertMemoryWriteBranch(bad), bad).toThrow();
					await expect(
						pushMemoryWriteBranch({ ...args, branch: bad }),
						bad,
					).rejects.toMatchObject({ kind: "invalid_argument" });
				}
				expect(remoteBranches().sort()).toEqual(
					["main", branch].sort(),
				);
			});

			it("recognises its own trailer only as the last paragraph", () => {
				const id = "cmemwrite00000001";
				expect(
					endsWithOwnWriteTrailer(
						`s\n\nbody\n\nFabric-Memory-Write: ${id}\n`,
						id,
					),
				).toBe(true);
				expect(
					endsWithOwnWriteTrailer(
						`s\n\nFabric-Memory-Write: ${id}\nFabric-Agent: client_1\n`,
						id,
					),
				).toBe(true);
				expect(
					endsWithOwnWriteTrailer(
						`s\n\nFabric-Memory-Write: ${id}\n\nmore\n`,
						id,
					),
				).toBe(false);
				expect(
					endsWithOwnWriteTrailer(
						`Fabric-Memory-Write: ${id}\n\nmore text\n`,
						id,
					),
				).toBe(false);
				expect(
					endsWithOwnWriteTrailer(
						`s\n\nFabric-Memory-Write: ${id}x\n`,
						id,
					),
				).toBe(false);
			});
		});
	},
);
