/**
 * The direct commit to a repository-backed project's synced branch (Fizzy
 * #2878 §10): one READY `REPOSITORY_COMMIT` snapshot becomes one commit on the
 * branch, or a typed outcome saying why not.
 *
 * Git is real: an origin repository under `os.tmpdir()` over `file://`,
 * edited by the test with plumbing to play a teammate's commits, a branch
 * that moves under the push and a refusing hook. The database is a handful of
 * mocked queries over one mutable snapshot row; the storage is a map. Every
 * identifier is synthetic.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import type { InstructionMigrationPointer } from "@repo/database/prisma/queries/instruction-migration-pointer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = {
	contentKind?: "FULL_SNAPSHOT" | "GIT_INTENT";
	id: string;
	projectId: string;
	organizationId: string;
	userId: string;
	version: number;
	status: string;
	source: string;
	proposalDestination: string;
	proposalStatus: string | null;
	commitContext: unknown;
	commitOutcome: unknown;
	baseSnapshotId: string | null;
	fileCount: number;
	publishedAt: Date | null;
	createdAt: Date;
};

type FileRow = {
	path: string;
	sha256: string;
	mode: number | null;
	storageKey: string;
};

const h = vi.hoisted(() => {
	const settings: {
		sourceOfTruth: string;
		migration: InstructionMigrationPointer | null;
	} = {
		sourceOfTruth: "REPOSITORY",
		migration: {
			v: 1,
			state: "SWITCHING",
			branchId: "branch_example",
			snapshotId: "snap_move",
			syncId: "sync_example",
			pullRequestUrl: null,
			startedAt: "2026-10-03T10:00:00.000Z",
			userId: "user_example_member",
		},
	};
	return {
		origin: null as unknown as import("./helpers/instruction-branch-origin").Origin,
		storage: new Map<string, Buffer>(),
		row: null as Row | null,
		nativeIntent: null as {
			status: string;
			gitIntentEntries: Array<{
				path: string;
				operation: "PUT" | "DELETE";
				sha256: string | null;
				storageKey: string | null;
				mode: number | null;
				baseMode: number | null;
				baseObjectId: string | null;
			}>;
		} | null,
		files: new Map<string, FileRow[]>(),
		sync: null as unknown,
		settings,
		/** The published snapshot the revert reads the frozen ignore rules from. */
		published: {
			organizationId: "org_example",
			settingsFrozen: { layer: "default", ignoreGlobs: [] as string[] },
		} as unknown,
		canCreate: true,
		/** Read-only mode turns on at this check (1 = the first), or never. */
		readOnlyFromCheck: null as number | null,
		readOnlyChecks: 0,
		/** Runs once before the next push, to move the branch under it. */
		beforePush: null as null | (() => void),
		/** Replaces the verifier's diff. */
		diff: null as null | ((entries: unknown[]) => unknown[]),
		credentialRequests: 0,
		/** What a start of the sync answers: a new run, or the one already open. */
		startOutcome: "started" as "started" | "already_running",
		/** Thrown by every write that records an outcome, while set. */
		writeError: null as Error | null,
		recordPushedFailures: 0,
		auditFailures: 0,
		pushAttempts: 0,
		recordPushed: vi.fn(),
		recordOutcome: vi.fn(),
		admit: vi.fn(),
		join: vi.fn(),
		publish: vi.fn(),
		startSync: vi.fn(),
		wake: vi.fn(),
		warm: vi.fn(),
		audit: vi.fn(),
	};
});

vi.mock("@repo/database", async (importOriginal) => {
	const real = await importOriginal<typeof import("@repo/database")>();
	return {
		...real,
		recordRevertCommitted: async (i: unknown) => {
			h.audit(i);
			if (h.writeError) {
				throw h.writeError;
			}
			if (h.auditFailures > 0) {
				h.auditFailures--;
				throw new Error("the database is unreachable");
			}
		},
		getDirectCommitSnapshot: async () =>
			h.row && { contentKind: "FULL_SNAPSHOT", ...h.row },
		loadGitIntent: async () => h.nativeIntent,
		recordDirectCommitOutcome: async (i: { outcome: unknown }) => {
			h.recordOutcome(i);
			if (h.writeError) {
				throw h.writeError;
			}
			if (h.row && h.row.commitOutcome === null) {
				h.row.commitOutcome = i.outcome;
				return true;
			}
			return false;
		},
		recordDirectCommitPushed: async (i: { sha: string; ref: string }) => {
			h.recordPushed(i);
			if (h.writeError) {
				throw h.writeError;
			}
			if (h.recordPushedFailures > 0) {
				h.recordPushedFailures--;
				throw new Error("the database is unreachable");
			}
			if (h.row && h.row.commitOutcome === null) {
				h.row.commitOutcome = {
					outcome: "committed",
					sha: i.sha,
					ref: i.ref,
				};
				return true;
			}
			return false;
		},
		admitDirectCommitAsProposal: async (i: {
			reason: string;
			operationId: string;
		}) => {
			h.admit(i);
			if (h.row && h.row.commitOutcome === null) {
				h.row.proposalDestination = "REPOSITORY";
				h.row.proposalStatus = "PENDING";
				h.row.commitOutcome = {
					outcome: "pull-request",
					operationId: i.operationId,
					reason: i.reason,
				};
				return true;
			}
			return false;
		},
		joinProposalBranch: async (i: unknown) => {
			h.join(i);
			return {
				kind: "joined",
				branchId: "branch_example",
				sequence: 1,
				assignment: 1,
			};
		},
		listInstructionFiles: async (snapshotId: string) =>
			h.files.get(snapshotId) ?? [],
		publishInstructionSnapshot: async (i: unknown) => {
			h.publish(i);
			return { published: true, changed: true };
		},
		getInstructionRepositorySyncForProposal: async () => h.sync,
		getPublishedInstructionSnapshot: async () => h.published,
		getProjectInstructionSettings: async () => h.settings,
		canCreateProjectInstructions: async () => h.canCreate,
		isProjectReadOnly: async () => {
			h.readOnlyChecks++;
			return (
				h.readOnlyFromCheck !== null &&
				h.readOnlyChecks >= h.readOnlyFromCheck
			);
		},
	};
});
vi.mock("@repo/storage", () => ({
	getStorageProvider: () => ({
		downloadFile: async (key: string) => {
			const data = h.storage.get(key);
			if (!data) {
				throw new Error("missing object");
			}
			return { data };
		},
	}),
}));
vi.mock("@repo/config", () => ({
	config: { storage: { bucketNames: { skills: "skills" } } },
}));
vi.mock("@repo/logs", () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@repo/instructions/export", () => ({
	warmInstructionSnapshotExport: async (i: unknown) => {
		h.warm(i);
	},
}));
vi.mock("@repo/integrations", () => ({
	resolveFreshRepoToken: vi.fn(),
	forceReExchangeRepoCredentials: vi.fn(),
	markRepoReauthRequired: vi.fn(),
	REPO_REAUTH_STEP_BOUND_MS: 20_000,
	isGitAuthError: () => false,
}));
vi.mock("../src/activities/lib/instruction-sync-start", () => ({
	startAutomaticInstructionSync: async (i: unknown) => {
		h.startSync(i);
		return { outcome: h.startOutcome, workflowId: "wf", runId: "run" };
	},
}));
vi.mock("../src/activities/lib/instruction-branch-wake", () => ({
	wakeBranchWorkflow: async (i: unknown) => {
		h.wake(i);
	},
}));
vi.mock(
	"../src/activities/lib/instruction-branch-credential",
	async (importOriginal) => {
		const real =
			await importOriginal<
				typeof import("../src/activities/lib/instruction-branch-credential")
			>();
		return {
			...real,
			withBranchRepoCredential: async (
				input: Parameters<typeof real.withBranchRepoCredential>[0],
				fn: Parameters<typeof real.withBranchRepoCredential>[1],
			) => {
				h.credentialRequests++;
				const destination = real.destinationOf(
					input.branch,
					input.phase,
				);
				const runDir = mkdtempSync(path.join(h.origin.root, "run-"));
				try {
					return await fn({
						destination,
						url: h.origin.url,
						env: h.origin.env,
						secrets: [],
						runDir,
						workDir: path.join(runDir, "repo"),
						signal: input.signal,
						adapter: {} as never,
						target: {
							auth: { token: "placeholder", authMethod: "OAUTH" },
							repository: destination.repository,
							signal: input.signal,
						},
						integrationId: destination.integrationId,
					});
				} finally {
					rmSync(runDir, { recursive: true, force: true });
				}
			},
		};
	},
);
vi.mock(
	"../src/activities/lib/instruction-branch-git",
	async (importOriginal) => {
		const real =
			await importOriginal<
				typeof import("../src/activities/lib/instruction-branch-git")
			>();
		return {
			...real,
			pushToSyncedRef: async (
				i: Parameters<typeof real.pushToSyncedRef>[0],
			) => {
				h.pushAttempts++;
				const before = h.beforePush;
				h.beforePush = null;
				before?.();
				return real.pushToSyncedRef(i);
			},
		};
	},
);
vi.mock(
	"../src/activities/lib/instruction-sync-git",
	async (importOriginal) => {
		const real =
			await importOriginal<
				typeof import("../src/activities/lib/instruction-sync-git")
			>();
		return {
			...real,
			diffTreeEntries: async (
				i: Parameters<typeof real.diffTreeEntries>[0],
			) => {
				const entries = await real.diffTreeEntries(i);
				return h.diff ? (h.diff(entries) as typeof entries) : entries;
			},
		};
	},
);

import { logger } from "@repo/logs";
import {
	checkDirectCommitReadiness,
	commitToSyncedBranch,
	recordDirectCommitSettlement,
	recordPushedDirectCommit,
	recordRevertedCommit,
	reportDirectCommitSettleFailed,
	reportRevertRecordFailed,
	revertCommitOnSyncedBranch,
	startConfirmingInstructionSync,
} from "../src/activities/instruction-direct-commit";
import { withBranchRepoCredential } from "../src/activities/lib/instruction-branch-credential";
import { initBranchWorkspace } from "../src/activities/lib/instruction-branch-git";
import {
	pushPlanToSyncedBranch,
	ReadOnlyModeRefusal,
	runDirectCommit,
	settlePushedDirectCommit,
} from "../src/activities/lib/instruction-direct-commit";
import {
	runRevertCommit,
	settlePushedRevert,
} from "../src/activities/lib/instruction-revert-commit";
import { createOrigin, hasGit } from "./helpers/instruction-branch-origin";

const ORG = "org_example";
const PROJECT = "proj_example";
const USER = "user_example_member";
const SNAPSHOT = "snap_commit_example";
const BASE_SNAPSHOT = "snap_base_example";
const SYNC = "sync_example";
const INTEGRATION = "int_example";
const NOREPLY = ["noreply", "example.com"].join("@");
const REPOSITORY = {
	provider: "GITHUB" as const,
	owner: "example-org",
	repo: "example-repo",
};

const BASE_FILES: Record<string, string> = {
	"CLAUDE.md": "# Example rules\n",
	"rules/a.md": "alpha\n",
	"rules/b.md": "beta\n",
	"scripts/run.sh": "#!/bin/sh\necho run\n",
};

const sha256 = (content: string) =>
	createHash("sha256").update(Buffer.from(content)).digest("hex");

function seedFiles(snapshotId: string, files: Record<string, string>) {
	h.files.set(
		snapshotId,
		Object.entries(files).map(([filePath, content]) => {
			const storageKey = `instructions/${snapshotId}/${filePath}`;
			h.storage.set(storageKey, Buffer.from(content));
			return {
				path: filePath,
				sha256: sha256(content),
				mode: content.startsWith("#!") ? 0o755 : null,
				storageKey,
			};
		}),
	);
}

/** The base snapshot, and a READY direct commit snapshot with `changes` applied (`null` deletes). */
function seedCommit(
	changes: Record<string, string | null>,
	over: Partial<Row> = {},
	context: Record<string, unknown> = {},
) {
	const files: Record<string, string> = { ...BASE_FILES };
	for (const [filePath, content] of Object.entries(changes)) {
		if (content === null) {
			delete files[filePath];
		} else {
			files[filePath] = content;
		}
	}
	seedFiles(BASE_SNAPSHOT, BASE_FILES);
	seedFiles(SNAPSHOT, files);
	h.row = {
		id: SNAPSHOT,
		projectId: PROJECT,
		organizationId: ORG,
		userId: USER,
		version: 8,
		status: "READY",
		source: "UPLOAD",
		proposalDestination: "REPOSITORY_COMMIT",
		proposalStatus: null,
		commitContext: {
			v: 1,
			integrationId: INTEGRATION,
			syncId: SYNC,
			syncGeneration: 1,
			provider: "GITHUB",
			targetRef: "main",
			rootPath: "",
			baseCommitSha: h.origin.base,
			repository: REPOSITORY,
			author: { name: "Example Member", email: NOREPLY },
			committer: { name: "Fabric", email: NOREPLY },
			message: "Tighten the rules",
			committedAt: "2026-10-02T10:00:00Z",
			...context,
		},
		commitOutcome: null,
		baseSnapshotId: BASE_SNAPSHOT,
		fileCount: Object.keys(files).length,
		publishedAt: null,
		createdAt: new Date("2026-10-02T09:59:00Z"),
		...over,
	};
}

function run() {
	return runDirectCommit({
		snapshotId: SNAPSHOT,
		organizationId: ORG,
		signal: new AbortController().signal,
	});
}

/** Lets the test origin take a push to the branch it has checked out, as a bare repository does. */
function acceptPushesToMain(): void {
	h.origin.git(["config", "receive.denyCurrentBranch", "ignore"]);
}

// A lost lease costs another clone, fetch, build and push; three of them on a
// busy machine outlast the default 5 s, so these suites state their own bound.
const GIT_TEST_TIMEOUT_MS = 60_000;

describe.skipIf(!hasGit())(
	"runDirectCommit (Fizzy #2878 §10)",
	{ timeout: GIT_TEST_TIMEOUT_MS },
	() => {
		beforeEach(() => {
			h.origin = createOrigin(BASE_FILES);
			acceptPushesToMain();
			h.storage.clear();
			h.files.clear();
			h.row = null;
			h.nativeIntent = null;
			h.beforePush = null;
			h.diff = null;
			h.canCreate = true;
			h.readOnlyFromCheck = null;
			h.readOnlyChecks = 0;
			h.credentialRequests = 0;
			h.recordPushedFailures = 0;
			h.pushAttempts = 0;
			for (const fn of [
				h.recordPushed,
				h.recordOutcome,
				h.admit,
				h.join,
				h.publish,
				h.startSync,
				h.wake,
				h.warm,
			]) {
				fn.mockClear();
			}
			h.sync = {
				id: SYNC,
				organizationId: ORG,
				generation: 1,
				repositoryIntegrationId: INTEGRATION,
				ref: "main",
				rootPath: "",
				allowReaderProposals: false,
				repositoryIntegration: {
					projectId: PROJECT,
					status: "ACTIVE",
					provider: "GITHUB",
					repositoryUrl:
						"https://github.com/example-org/example-repo",
				},
			};
		});
		afterEach(() => {
			h.origin.cleanup();
		});

		it("pushes one commit on the tip, authored as the member, and leaves recording and publishing to what follows", async () => {
			seedCommit({ "rules/a.md": "alpha v2\n" });

			const result = await run();

			const sha = h.origin.refSha("main") as string;
			expect(sha).not.toBe(h.origin.base);
			expect(result).toEqual({ kind: "pushed", sha });
			expect(h.origin.parents(sha)).toEqual([h.origin.base]);
			expect(h.origin.content(sha, "rules/a.md")).toBe("alpha v2");
			expect(h.origin.content(sha, "rules/b.md")).toBe("beta");
			expect(h.origin.message(sha)).toBe(
				`Tighten the rules\n\nFabric-Commit: ${SNAPSHOT}`,
			);
			expect(
				h.origin.git([
					"log",
					"-1",
					"--format=%an <%ae>|%cn <%ce>",
					sha,
				]),
			).toBe(`Example Member <${NOREPLY}>|Fabric <${NOREPLY}>`);
			expect(h.publish).not.toHaveBeenCalled();
			expect(h.startSync).not.toHaveBeenCalled();
			expect(h.row?.commitOutcome).toBeNull();
		});

		it("applies a native changed-path PUT and DELETE with no full snapshot tree", async () => {
			seedCommit(
				{ "rules/a.md": "native alpha\n", "rules/b.md": null },
				{ contentKind: "GIT_INTENT", baseSnapshotId: null },
			);
			const put = h.files
				.get(SNAPSHOT)
				?.find((file) => file.path === "rules/a.md");
			if (!put) throw new Error("Native test PUT is missing");
			h.nativeIntent = {
				status: "READY",
				gitIntentEntries: [
					{
						...put,
						operation: "PUT",
						mode: 0o100644,
						baseMode: 0o100644,
						baseObjectId: "a".repeat(40),
					},
					{
						path: "rules/b.md",
						operation: "DELETE",
						storageKey: null,
						sha256: null,
						mode: null,
						baseMode: 0o100644,
						baseObjectId: "b".repeat(40),
					},
				],
			};
			h.files.clear();
			const result = await run();
			expect(result.kind).toBe("pushed");
			const sha = h.origin.refSha("main");
			if (!sha) throw new Error("Git tip is missing");
			expect(h.origin.content(sha, "rules/a.md")).toBe("native alpha");
			expect(
				h.origin.git(["ls-tree", "--name-only", sha, "rules/b.md"]),
			).toBe("");
			expect(h.publish).not.toHaveBeenCalled();
		});

		it("never publishes the derived snapshot: on a tip that moved past the base it is a stale copy, and the sync publishes the real tree", async () => {
			seedCommit({ "rules/a.md": "alpha v2\n" });
			const teammate = h.origin.commit({
				parents: [h.origin.base],
				changes: { "rules/b.md": "beta from a teammate\n" },
			});
			h.origin.setRef("main", teammate);

			const result = await run();
			const pushed = result.kind === "pushed" ? result.sha : "";
			await settlePushedDirectCommit({
				snapshotId: SNAPSHOT,
				organizationId: ORG,
				sha: pushed,
			});

			expect(pushed).toBe(h.origin.refSha("main"));
			expect(h.origin.content(pushed, "rules/a.md")).toBe("alpha v2");
			expect(h.origin.content(pushed, "rules/b.md")).toBe(
				"beta from a teammate",
			);
			const derived = h.files.get(SNAPSHOT) ?? [];
			expect(
				derived.find((f) => f.path === "rules/b.md")?.sha256,
				"the derived rows still hold the base's version of the teammate's file",
			).toBe(sha256(BASE_FILES["rules/b.md"] as string));
			expect(h.publish).not.toHaveBeenCalled();
			expect(h.warm).not.toHaveBeenCalled();
			expect(h.row).toMatchObject({
				source: "UPLOAD",
				publishedAt: null,
				commitOutcome: { outcome: "committed", sha: pushed },
			});
		});

		it("applies an add and a delete in the same commit, keeping the file's own mode", async () => {
			seedCommit({
				"rules/new.md": "new\n",
				"rules/b.md": null,
				"scripts/run.sh": "#!/bin/sh\necho run v2\n",
			});

			await run();

			const sha = h.origin.refSha("main") as string;
			expect(h.origin.content(sha, "rules/new.md")).toBe("new");
			expect(h.origin.entry(sha, "rules/b.md")).toBeNull();
			expect(h.origin.entry(sha, "scripts/run.sh")?.mode).toBe("100755");
			expect(h.origin.entry(sha, "rules/new.md")?.mode).toBe("100644");
		});

		it("writes on top of a tip a teammate moved, without touching what they changed", async () => {
			seedCommit({ "rules/a.md": "alpha v2\n" });
			const teammate = h.origin.commit({
				parents: [h.origin.base],
				changes: { "rules/b.md": "beta from a teammate\n" },
			});
			h.origin.setRef("main", teammate);

			const result = await run();

			const sha = h.origin.refSha("main") as string;
			expect(result).toEqual({ kind: "pushed", sha });
			expect(h.origin.parents(sha)).toEqual([teammate]);
			expect(h.origin.content(sha, "rules/a.md")).toBe("alpha v2");
			expect(h.origin.content(sha, "rules/b.md")).toBe(
				"beta from a teammate",
			);
		});

		it("is BRANCH_MOVED, writing nothing, when a teammate changed one of its files since the base", async () => {
			seedCommit({ "rules/a.md": "alpha v2\n" });
			const teammate = h.origin.commit({
				parents: [h.origin.base],
				changes: { "rules/a.md": "alpha from a teammate\n" },
			});
			h.origin.setRef("main", teammate);

			const result = await run();

			expect(result).toEqual({
				kind: "outcome",
				outcome: { outcome: "branch-moved" },
			});
			expect(h.origin.refSha("main")).toBe(teammate);
			expect(h.pushAttempts).toBe(0);
			expect(
				h.recordOutcome,
				"the workflow records it, with the activity that is retried for hours",
			).not.toHaveBeenCalled();
			expect(h.row?.commitOutcome).toBeNull();
			expect(h.publish).not.toHaveBeenCalled();
			expect(h.startSync).not.toHaveBeenCalled();
		});

		describe("a path the change adds that the branch already holds", () => {
			/** The branch holds `rules/big.md`; Fabric's copy never had it (the sync left it out). */
			function branchWithAFileFabricNeverHad() {
				h.origin.cleanup();
				h.origin = createOrigin({
					...BASE_FILES,
					"rules/big.md": "a file the sync left out\n",
				});
				acceptPushesToMain();
				seedCommit({ "rules/big.md": "a new file by the same name\n" });
			}

			it("is branch-moved, writing nothing, rather than overwriting a file the editor never saw", async () => {
				branchWithAFileFabricNeverHad();

				const result = await run();

				expect(result).toEqual({
					kind: "outcome",
					outcome: { outcome: "branch-moved" },
				});
				expect(h.origin.refSha("main")).toBe(h.origin.base);
				expect(h.pushAttempts).toBe(0);
				expect(h.origin.content(h.origin.base, "rules/big.md")).toBe(
					"a file the sync left out",
				);
			});

			it("is branch-moved on a tip that moved elsewhere too, even though nobody touched that path since the base", async () => {
				branchWithAFileFabricNeverHad();
				const teammate = h.origin.commit({
					parents: [h.origin.base],
					changes: { "rules/b.md": "beta from a teammate\n" },
				});
				h.origin.setRef("main", teammate);

				const result = await run();

				expect(result).toEqual({
					kind: "outcome",
					outcome: { outcome: "branch-moved" },
				});
				expect(h.origin.refSha("main")).toBe(teammate);
				expect(h.pushAttempts).toBe(0);
			});

			it("still commits when the branch already holds exactly the wanted content there", async () => {
				branchWithAFileFabricNeverHad();
				const same = h.origin.commit({
					parents: [h.origin.base],
					changes: {
						"rules/big.md": "a new file by the same name\n",
					},
				});
				h.origin.setRef("main", same);

				const result = await run();

				expect(result).toEqual({
					kind: "outcome",
					outcome: { outcome: "unchanged", sha: same },
				});
			});
		});

		it("commits nothing when the branch already holds exactly the content", async () => {
			seedCommit({ "rules/a.md": "alpha v2\n" });
			const same = h.origin.commit({
				parents: [h.origin.base],
				changes: { "rules/a.md": "alpha v2\n" },
			});
			h.origin.setRef("main", same);

			const result = await run();

			expect(result).toEqual({
				kind: "outcome",
				outcome: { outcome: "unchanged", sha: same },
			});
			expect(h.origin.refSha("main")).toBe(same);
			expect(h.pushAttempts).toBe(0);
		});

		it("restarts on the new tip when the push loses the lease, and then succeeds", async () => {
			seedCommit({ "rules/a.md": "alpha v2\n" });
			let teammate = "";
			h.beforePush = () => {
				teammate = h.origin.commit({
					parents: [h.origin.base],
					changes: { "rules/b.md": "beta from a teammate\n" },
				});
				h.origin.setRef("main", teammate);
			};

			const result = await run();

			const sha = h.origin.refSha("main") as string;
			expect(result).toEqual({ kind: "pushed", sha });
			expect(h.pushAttempts).toBe(2);
			expect(h.origin.parents(sha)).toEqual([teammate]);
			expect(h.origin.content(sha, "rules/b.md")).toBe(
				"beta from a teammate",
			);
		});

		it("falls back to a pull request after the branch moves under three attempts", async () => {
			seedCommit({ "rules/a.md": "alpha v2\n" });
			let tip = h.origin.base;
			const move = () => {
				tip = h.origin.commit({
					parents: [tip],
					changes: { "rules/b.md": `beta ${tip.slice(0, 7)}\n` },
				});
				h.origin.setRef("main", tip);
				h.beforePush = move;
			};
			h.beforePush = move;

			const result = await run();

			expect(h.pushAttempts).toBe(3);
			expect(result).toMatchObject({
				kind: "settled",
				outcome: {
					outcome: "pull-request",
					operationId: `commit-${SNAPSHOT}`,
					reason: "busy",
				},
			});
			expect(h.admit).toHaveBeenCalledWith(
				expect.objectContaining({
					reason: "busy",
					snapshotId: SNAPSHOT,
				}),
			);
			expect(h.row?.source).toBe("UPLOAD");
			expect(h.publish).not.toHaveBeenCalled();
		});

		it("falls back to a pull request, with the same attribution, when the branch refuses the push", async () => {
			seedCommit({ "rules/a.md": "alpha v2\n" });
			h.origin.refusePushes(true);

			const result = await run();

			expect(result).toMatchObject({
				kind: "settled",
				outcome: { outcome: "pull-request", reason: "protected" },
			});
			expect(h.origin.refSha("main")).toBe(h.origin.base);
			const admitted = h.admit.mock.calls[0]?.[0] as {
				context: Record<string, unknown>;
				operationId: string;
			};
			expect(admitted.context).toEqual({
				v: 2,
				integrationId: INTEGRATION,
				syncId: SYNC,
				syncGeneration: 1,
				provider: "GITHUB",
				targetRef: "main",
				rootPath: "",
				baseCommitSha: h.origin.base,
				repository: REPOSITORY,
				author: { name: "Example Member", email: NOREPLY },
				committer: { name: "Fabric", email: NOREPLY },
				message: "Tighten the rules",
				committedAt: "2026-10-02T10:00:00Z",
			});
			expect(h.join).toHaveBeenCalledWith(
				expect.objectContaining({ snapshotId: SNAPSHOT }),
			);
			expect(h.wake).toHaveBeenCalledWith({
				branchId: "branch_example",
				projectId: PROJECT,
				organizationId: ORG,
			});
			expect(h.publish).not.toHaveBeenCalled();
			expect(h.startSync).not.toHaveBeenCalled();
		});

		it("finishes the pull request's hand-off on a retry after the join failed", async () => {
			seedCommit({ "rules/a.md": "alpha v2\n" });
			h.origin.refusePushes(true);
			await run();
			h.join.mockClear();
			h.wake.mockClear();

			const again = await run();

			expect(again).toEqual({ kind: "stopped" });
			expect(h.join).toHaveBeenCalledTimes(1);
			expect(h.wake).toHaveBeenCalledTimes(1);
			expect(h.admit).toHaveBeenCalledTimes(1);
		});

		it("recovers its own commit after a lost acknowledgement instead of pushing a second", async () => {
			seedCommit({ "rules/a.md": "alpha v2\n" });
			const first = await run();
			const pushed = h.origin.refSha("main") as string;
			expect(first).toEqual({ kind: "pushed", sha: pushed });
			expect(pushed).not.toBe(h.origin.base);

			const result = await run();

			expect(result).toEqual({ kind: "pushed", sha: pushed });
			expect(h.origin.refSha("main")).toBe(pushed);
			expect(h.pushAttempts).toBe(1);
			expect(h.origin.parents(pushed)).toEqual([h.origin.base]);
		});

		describe("a retry whose live checks refuse after the commit already reached the branch", () => {
			async function pushedThenLostAck(): Promise<string> {
				seedCommit({ "rules/a.md": "alpha v2\n" });
				const first = await run();
				const pushed = h.origin.refSha("main") as string;
				expect(first).toEqual({ kind: "pushed", sha: pushed });
				h.pushAttempts = 0;
				h.credentialRequests = 0;
				return pushed;
			}

			it.each([
				[
					"the member lost write rights",
					() => {
						h.canCreate = false;
					},
				],
				[
					"the project was switched to Read-only mode",
					() => {
						h.readOnlyFromCheck = 1;
						h.readOnlyChecks = 0;
					},
				],
				[
					"the sync was reconfigured",
					() => {
						(h.sync as { generation: number }).generation = 2;
					},
				],
				[
					"the integration now names another repository",
					() => {
						(
							h.sync as {
								repositoryIntegration: {
									repositoryUrl: string;
								};
							}
						).repositoryIntegration.repositoryUrl =
							"https://github.com/example-org/another-repo";
					},
				],
			])(
				"still finds its own commit, so it is recorded committed, when %s",
				async (_label, change) => {
					const pushed = await pushedThenLostAck();
					change();

					const result = await run();

					expect(result).toEqual({ kind: "pushed", sha: pushed });
					expect(h.pushAttempts).toBe(0);
					expect(h.origin.refSha("main")).toBe(pushed);
				},
			);

			it("still refuses when the branch holds no commit of its own", async () => {
				seedCommit({ "rules/a.md": "alpha v2\n" });
				h.canCreate = false;

				await expect(run()).rejects.toMatchObject({
					code: "PERMISSION_REVOKED",
				});

				expect(h.credentialRequests).toBe(1);
				expect(h.pushAttempts).toBe(0);
				expect(h.origin.refSha("main")).toBe(h.origin.base);
			});

			it("does not take a teammate's commit that merely quotes the trailer for its own", async () => {
				seedCommit({ "rules/a.md": "alpha v2\n" });
				const lookalike = h.origin.commit({
					parents: [h.origin.base],
					changes: { "rules/b.md": "beta from a teammate\n" },
					message: `Pasted notes\n\nFabric-Commit: ${SNAPSHOT}\n\nmore text`,
				});
				h.origin.setRef("main", lookalike);
				h.readOnlyFromCheck = 1;

				await expect(run()).rejects.toBeInstanceOf(ReadOnlyModeRefusal);
			});
		});

		it.each([
			[
				"quotes the trailer in the middle of its message",
				(id: string) =>
					`Pasted notes\n\nFabric-Commit: ${id}\n\nmore text`,
			],
			[
				"ends in the trailer but not alone in its last paragraph",
				(id: string) =>
					`Update\n\nSigned-off-by: Teammate <t@example.com>\nFabric-Commit: ${id}`,
			],
		])(
			"does not take a teammate's commit that %s for its own",
			async (_label, messageFor) => {
				seedCommit({ "rules/a.md": "alpha v2\n" });
				const lookalike = h.origin.commit({
					parents: [h.origin.base],
					changes: { "rules/b.md": "beta from a teammate\n" },
					message: messageFor(SNAPSHOT),
				});
				h.origin.setRef("main", lookalike);

				const result = await run();

				const sha = h.origin.refSha("main") as string;
				expect(result).toEqual({ kind: "pushed", sha });
				expect(sha).not.toBe(lookalike);
				expect(h.pushAttempts).toBe(1);
				expect(h.origin.parents(sha)).toEqual([lookalike]);
				expect(h.origin.content(sha, "rules/a.md")).toBe("alpha v2");
			},
		);

		it("still finds its own commit when other commits mention the trailer first", async () => {
			seedCommit({ "rules/a.md": "alpha v2\n" });
			await run();
			const own = h.origin.refSha("main") as string;
			const later = h.origin.commit({
				parents: [own],
				changes: { "rules/b.md": "beta later\n" },
				message: `Quote\n\nFabric-Commit: ${SNAPSHOT}\n\nin the middle`,
			});
			h.origin.setRef("main", later);

			const again = await run();

			expect(again).toEqual({ kind: "pushed", sha: own });
			expect(h.pushAttempts).toBe(1);
			expect(h.origin.refSha("main")).toBe(later);
		});

		it("never builds a commit whose diff is not exactly the plan", async () => {
			seedCommit({ "rules/a.md": "alpha v2\n" });
			h.diff = (entries) => [
				...entries,
				{
					status: "A",
					path: "extra.md",
					oldMode: "000000",
					newMode: "100644",
					newOid: "a".repeat(40),
				},
			];

			await expect(run()).rejects.toMatchObject({ code: "GIT_FAILED" });

			expect(h.pushAttempts).toBe(0);
			expect(h.origin.refSha("main")).toBe(h.origin.base);
		});

		it("is CONFIGURATION_CHANGED when the sync was reconfigured since admission", async () => {
			seedCommit({ "rules/a.md": "alpha v2\n" });
			(h.sync as { generation: number }).generation = 2;

			await expect(run()).rejects.toMatchObject({
				code: "CONFIGURATION_CHANGED",
				retryable: false,
			});

			expect(h.credentialRequests).toBe(1);
			expect(h.pushAttempts).toBe(0);
			expect(h.origin.refSha("main")).toBe(h.origin.base);
		});

		it("refuses to fetch or push a live branch that is not the frozen one, before git runs", async () => {
			seedCommit({ "rules/a.md": "alpha v2\n" });
			const destination = {
				integrationId: INTEGRATION,
				syncId: SYNC,
				repositoryKey: "github:example-org/example-repo",
				provider: "GITHUB" as const,
				repository: REPOSITORY,
				targetRef: "main",
				rootPath: "",
			};
			const plan = vi.fn(async () => ({ kind: "unchanged" as const }));

			await expect(
				withBranchRepoCredential(
					{
						branch: {
							id: SNAPSHOT,
							projectId: PROJECT,
							organizationId: ORG,
							userId: USER,
							destination,
						},
						phase: "append",
						signal: new AbortController().signal,
					},
					async (credential) => {
						// A real workspace, so everything up to the branch check
						// would succeed and only that check can refuse.
						await initBranchWorkspace({
							url: credential.url,
							targetRef: "main",
							dir: credential.workDir,
							env: credential.env,
							signal: credential.signal,
						});
						return pushPlanToSyncedBranch({
							credential,
							spec: {
								targetRef: "main",
								liveRef: "release/next",
								rootPath: "",
								author: {
									name: "Example Member",
									email: NOREPLY,
								},
								committer: { name: "Fabric", email: NOREPLY },
								message: "Tighten the rules",
								committedAt: "2026-10-02T10:00:00Z",
								trailerId: SNAPSHOT,
								searchFrom: h.origin.base,
							},
							planFor: plan,
							assertStillAllowed: async () => ({}),
						});
					},
				),
			).rejects.toMatchObject({ code: "GIT_FAILED" });

			expect(plan).not.toHaveBeenCalled();
			expect(h.pushAttempts).toBe(0);
			expect(h.origin.refSha("main")).toBe(h.origin.base);
		});

		it("is refused in Read-only mode, pushing nothing, after looking only for a commit of its own", async () => {
			seedCommit({ "rules/a.md": "alpha v2\n" });
			h.readOnlyFromCheck = 1;

			await expect(run()).rejects.toBeInstanceOf(ReadOnlyModeRefusal);

			expect(h.credentialRequests).toBe(1);
			expect(h.pushAttempts).toBe(0);
			expect(h.origin.refSha("main")).toBe(h.origin.base);
		});

		it("stops a commit already accepted when Read-only mode is switched on before its push", async () => {
			seedCommit({ "rules/a.md": "alpha v2\n" });
			h.readOnlyFromCheck = 2;

			await expect(run()).rejects.toBeInstanceOf(ReadOnlyModeRefusal);

			expect(h.pushAttempts).toBe(0);
			expect(h.origin.refSha("main")).toBe(h.origin.base);
		});

		it("is PERMISSION_REVOKED when the member no longer holds write rights, even with the reader opt-in", async () => {
			seedCommit({ "rules/a.md": "alpha v2\n" });
			h.canCreate = false;
			(h.sync as { allowReaderProposals: boolean }).allowReaderProposals =
				true;

			await expect(run()).rejects.toMatchObject({
				code: "PERMISSION_REVOKED",
			});

			expect(h.origin.refSha("main")).toBe(h.origin.base);
		});

		it("is REPOSITORY_CHANGED when the integration now names another repository", async () => {
			seedCommit({ "rules/a.md": "alpha v2\n" });
			(
				h.sync as { repositoryIntegration: { repositoryUrl: string } }
			).repositoryIntegration.repositoryUrl =
				"https://github.com/example-org/another-repo";

			await expect(run()).rejects.toMatchObject({
				code: "REPOSITORY_CHANGED",
			});
		});

		it("touches nothing for a snapshot the secret scan rejected", async () => {
			seedCommit({ "rules/a.md": "alpha v2\n" }, { status: "REJECTED" });

			const result = await run();

			expect(result).toEqual({ kind: "not_ready" });
			expect(h.credentialRequests).toBe(0);
			expect(h.pushAttempts).toBe(0);
			expect(h.origin.refSha("main")).toBe(h.origin.base);
		});

		it("touches nothing for a snapshot that is still validating", async () => {
			seedCommit(
				{ "rules/a.md": "alpha v2\n" },
				{ status: "VALIDATING" },
			);

			expect(await run()).toEqual({ kind: "not_ready" });
			expect(h.credentialRequests).toBe(0);
		});

		it("does nothing for a commit that was settled already", async () => {
			seedCommit(
				{ "rules/a.md": "alpha v2\n" },
				{ commitOutcome: { outcome: "branch-moved" } },
			);

			expect(await run()).toEqual({ kind: "stopped" });
			expect(h.credentialRequests).toBe(0);
		});

		it("does nothing for a snapshot that is not a direct commit", async () => {
			seedCommit(
				{ "rules/a.md": "alpha v2\n" },
				{ proposalDestination: "FABRIC" },
			);

			expect(await run()).toEqual({ kind: "stopped" });
			expect(h.credentialRequests).toBe(0);
		});
	},
);

describe.skipIf(!hasGit())(
	"runRevertCommit (Fizzy #2878 §10)",
	{ timeout: GIT_TEST_TIMEOUT_MS },
	() => {
		const REQUEST = "req_revert_example";
		// Assembled at run time: no token-shaped literal in the tree.
		const LEAKED = `${"gh"}${"p_"}${"A".repeat(36)}`;

		function revertInput(sha: string, over: Record<string, unknown> = {}) {
			return {
				projectId: PROJECT,
				organizationId: ORG,
				userId: USER,
				sha,
				requestId: REQUEST,
				author: { name: "Example Member", email: NOREPLY },
				committer: { name: "Fabric", email: NOREPLY },
				committedAt: "2026-10-02T11:00:00Z",
				...over,
			};
		}

		function revert(sha: string, over: Record<string, unknown> = {}) {
			return runRevertCommit(
				revertInput(sha, over),
				new AbortController().signal,
			);
		}

		/** One commit S on top of the base that changes, adds and deletes files, inside and outside `rules/`. */
		function reworkRules(): string {
			const s = h.origin.commit({
				parents: [h.origin.base],
				changes: {
					"rules/a.md": "alpha v2\n",
					"rules/new.md": "new\n",
					"rules/b.md": null,
					"CLAUDE.md": "# Changed outside the folder\n",
				},
				message: "Rework the rules\n\nA longer explanation.",
			});
			h.origin.setRef("main", s);
			return s;
		}

		beforeEach(() => {
			h.origin = createOrigin(BASE_FILES);
			acceptPushesToMain();
			h.canCreate = true;
			h.readOnlyFromCheck = null;
			h.readOnlyChecks = 0;
			h.credentialRequests = 0;
			h.pushAttempts = 0;
			h.beforePush = null;
			h.diff = null;
			h.auditFailures = 0;
			h.published = {
				organizationId: ORG,
				settingsFrozen: { layer: "default", ignoreGlobs: [] },
			};
			for (const fn of [h.audit, h.startSync]) {
				fn.mockClear();
			}
			h.sync = {
				id: SYNC,
				organizationId: ORG,
				generation: 1,
				repositoryIntegrationId: INTEGRATION,
				ref: "main",
				rootPath: "rules",
				allowReaderProposals: false,
				repositoryIntegration: {
					projectId: PROJECT,
					status: "ACTIVE",
					provider: "GITHUB",
					repositoryUrl:
						"https://github.com/example-org/example-repo",
				},
			};
		});
		afterEach(() => {
			h.origin.cleanup();
		});

		it("restores the parent's tree under the folder with one commit on the tip, and leaves what is outside it", async () => {
			const s = reworkRules();

			const result = await revert(s);

			const sha = h.origin.refSha("main") as string;
			expect(result).toEqual({
				kind: "reverted",
				sha,
				ref: "main",
				fileCount: 3,
			});
			expect(h.origin.parents(sha)).toEqual([s]);
			expect(h.origin.git(["rev-parse", `${sha}:rules`])).toBe(
				h.origin.git(["rev-parse", `${h.origin.base}:rules`]),
			);
			expect(h.origin.content(sha, "CLAUDE.md")).toBe(
				"# Changed outside the folder",
			);
			expect(h.origin.message(sha)).toBe(
				`Revert "Rework the rules"\n\nThis reverts commit ${s}.\n\nFabric-Commit: ${REQUEST}`,
			);
			expect(
				h.origin.git([
					"log",
					"-1",
					"--format=%an <%ae>|%cn <%ce>",
					sha,
				]),
			).toBe(`Example Member <${NOREPLY}>|Fabric <${NOREPLY}>`);
			expect(
				h.audit,
				"recording is the next activity's job",
			).not.toHaveBeenCalled();
			expect(h.startSync).not.toHaveBeenCalled();
		});

		it("records a revert the branch holds in the audit trail, and names the live sync row the confirming run is for", async () => {
			const s = reworkRules();
			const result = await revert(s);
			const reverted = result.kind === "reverted" ? result : null;

			const confirm = await settlePushedRevert(revertInput(s), {
				sha: reverted?.sha ?? "",
				ref: "main",
				fileCount: 3,
			});

			expect(h.audit).toHaveBeenCalledWith({
				projectId: PROJECT,
				organizationId: ORG,
				actorUserId: USER,
				sha: reverted?.sha,
				ref: "main",
				fileCount: 3,
				revertOf: s,
			});
			expect(confirm).toEqual({
				projectId: PROJECT,
				organizationId: ORG,
				syncId: SYNC,
				generation: 1,
			});
			expect(
				h.startSync,
				"starting the run is the workflow's own, retried, activity",
			).not.toHaveBeenCalled();
		});

		it("names no run when the project has no sync row any more", async () => {
			h.sync = null;

			await expect(
				settlePushedRevert(revertInput("f".repeat(40)), {
					sha: "a".repeat(40),
					ref: "main",
					fileCount: 1,
				}),
			).resolves.toBeNull();
			expect(h.audit).toHaveBeenCalledTimes(1);
		});

		it("fails when the audit row cannot be written, so the activity is retried", async () => {
			h.auditFailures = 1;

			await expect(
				settlePushedRevert(revertInput("f".repeat(40)), {
					sha: "a".repeat(40),
					ref: "main",
					fileCount: 1,
				}),
			).rejects.toThrow("the database is unreachable");
		});

		it("restores the whole tree when the folder is the repository root", async () => {
			(h.sync as { rootPath: string }).rootPath = "";
			const s = reworkRules();

			await revert(s);

			const sha = h.origin.refSha("main") as string;
			expect(h.origin.git(["rev-parse", `${sha}^{tree}`])).toBe(
				h.origin.git(["rev-parse", `${h.origin.base}^{tree}`]),
			);
		});

		it("keeps a teammate's later change to another file", async () => {
			const s = reworkRules();
			const teammate = h.origin.commit({
				parents: [s],
				changes: { "rules/other.md": "from a teammate\n" },
			});
			h.origin.setRef("main", teammate);

			const result = await revert(s);

			const sha = h.origin.refSha("main") as string;
			expect(result).toMatchObject({ kind: "reverted" });
			expect(h.origin.parents(sha)).toEqual([teammate]);
			expect(h.origin.content(sha, "rules/other.md")).toBe(
				"from a teammate",
			);
			expect(h.origin.content(sha, "rules/a.md")).toBe("alpha");
			expect(h.origin.entry(sha, "rules/new.md")).toBeNull();
			expect(h.origin.content(sha, "rules/b.md")).toBe("beta");
		});

		it("is REVERT_CONFLICT, pushing nothing, when a later commit changed one of the files", async () => {
			const s = reworkRules();
			const teammate = h.origin.commit({
				parents: [s],
				changes: { "rules/a.md": "alpha v3 from a teammate\n" },
			});
			h.origin.setRef("main", teammate);

			const result = await revert(s);

			expect(result).toEqual({
				kind: "refused",
				code: "REVERT_CONFLICT",
			});
			expect(h.origin.refSha("main")).toBe(teammate);
			expect(h.audit).not.toHaveBeenCalled();
			expect(h.startSync).not.toHaveBeenCalled();
		});

		it("skips a path someone already restored, and is unchanged when every path is", async () => {
			const s = reworkRules();
			const partial = h.origin.commit({
				parents: [s],
				changes: { "rules/a.md": "alpha\n" },
			});
			h.origin.setRef("main", partial);

			const some = await revert(s, { requestId: "req_revert_some_01" });
			const afterSome = h.origin.refSha("main") as string;

			expect(some).toMatchObject({ kind: "reverted", fileCount: 3 });
			expect(h.origin.git(["rev-parse", `${afterSome}:rules`])).toBe(
				h.origin.git(["rev-parse", `${h.origin.base}:rules`]),
			);

			const none = await revert(s, { requestId: "req_revert_none_01" });

			expect(none).toEqual({ kind: "unchanged", sha: afterSome });
			expect(h.origin.refSha("main")).toBe(afterSome);
		});

		it("refuses to restore a file that holds a credential, even though the repository's history has it", async () => {
			h.origin.cleanup();
			h.origin = createOrigin({
				...BASE_FILES,
				"rules/leak.md": `token ${LEAKED}\n`,
			});
			acceptPushesToMain();
			const s = h.origin.commit({
				parents: [h.origin.base],
				changes: { "rules/leak.md": null },
				message: "Remove the leaked token",
			});
			h.origin.setRef("main", s);

			const result = await revert(s);

			expect(result).toEqual({
				kind: "refused",
				code: "REVERT_REJECTED",
			});
			expect(h.origin.refSha("main")).toBe(s);
			expect(h.pushAttempts).toBe(0);
		});

		it("refuses to restore a credential-shaped file name", async () => {
			h.origin.cleanup();
			h.origin = createOrigin({ ...BASE_FILES, "rules/.env": "A=1\n" });
			acceptPushesToMain();
			const s = h.origin.commit({
				parents: [h.origin.base],
				changes: { "rules/.env": null },
			});
			h.origin.setRef("main", s);

			expect(await revert(s)).toEqual({
				kind: "refused",
				code: "REVERT_REJECTED",
			});
			expect(h.origin.refSha("main")).toBe(s);
		});

		it("will remove a credential file the commit added", async () => {
			const s = h.origin.commit({
				parents: [h.origin.base],
				changes: { "rules/.env": `A=${LEAKED}\n` },
			});
			h.origin.setRef("main", s);

			const result = await revert(s);

			expect(result).toMatchObject({ kind: "reverted" });
			expect(
				h.origin.entry(h.origin.refSha("main") as string, "rules/.env"),
			).toBeNull();
		});

		it.each([
			[
				"a merge commit",
				(): string => {
					const side = h.origin.commit({
						parents: [h.origin.base],
						changes: { "rules/side.md": "side\n" },
					});
					const merge = h.origin.commit({
						parents: [h.origin.base, side],
						changes: { "rules/side.md": "side\n" },
						message: "Merge side",
					});
					h.origin.setRef("main", merge);
					return merge;
				},
				"REVERT_UNSUPPORTED",
			],
			[
				"a root commit",
				(): string => h.origin.base,
				"REVERT_UNSUPPORTED",
			],
			[
				"a commit that changed nothing in the folder",
				(): string => {
					const s = h.origin.commit({
						parents: [h.origin.base],
						changes: { "CLAUDE.md": "# elsewhere\n" },
					});
					h.origin.setRef("main", s);
					return s;
				},
				"REVERT_EMPTY",
			],
		])("refuses %s", async (_label, make, code) => {
			const s = make();
			const tip = h.origin.refSha("main");

			expect(await revert(s)).toEqual({ kind: "refused", code });
			expect(h.origin.refSha("main")).toBe(tip);
		});

		it("refuses a commit that is not in the branch's history", async () => {
			const side = h.origin.commit({
				parents: [h.origin.base],
				changes: { "rules/side.md": "from a pull request\n" },
			});
			h.origin.setRef("some/pull-request", side);

			const result = await revert(side);

			expect(result).toEqual({
				kind: "refused",
				code: "COMMIT_NOT_ON_BRANCH",
			});
			expect(h.origin.refSha("main")).toBe(h.origin.base);
		});

		it("restarts on the new tip when the push loses the lease", async () => {
			const s = reworkRules();
			let teammate = "";
			h.beforePush = () => {
				teammate = h.origin.commit({
					parents: [s],
					changes: { "rules/other.md": "late\n" },
				});
				h.origin.setRef("main", teammate);
			};

			const result = await revert(s);

			const sha = h.origin.refSha("main") as string;
			expect(result).toMatchObject({ kind: "reverted", sha });
			expect(h.pushAttempts).toBe(2);
			expect(h.origin.parents(sha)).toEqual([teammate]);
		});

		it("is protected when the branch refuses the push, and busy after three lost leases", async () => {
			const s = reworkRules();
			h.origin.refusePushes(true);

			expect(await revert(s)).toEqual({ kind: "protected" });
			expect(h.origin.refSha("main")).toBe(s);
			expect(h.audit).not.toHaveBeenCalled();

			h.origin.refusePushes(false);
			let tip = s;
			const move = () => {
				tip = h.origin.commit({
					parents: [tip],
					changes: { "rules/other.md": `late ${tip.slice(0, 7)}\n` },
				});
				h.origin.setRef("main", tip);
				h.beforePush = move;
			};
			h.beforePush = move;
			h.pushAttempts = 0;

			expect(
				await revert(s, { requestId: "req_revert_busy_01" }),
			).toEqual({
				kind: "busy",
			});
			expect(h.pushAttempts).toBe(3);
		});

		it("finds its own commit again after a lost acknowledgement instead of pushing a second", async () => {
			const s = reworkRules();
			const first = await revert(s);
			const pushed = h.origin.refSha("main") as string;
			h.audit.mockClear();

			const again = await revert(s);

			expect(first).toMatchObject({ kind: "reverted", sha: pushed });
			expect(again).toMatchObject({ kind: "reverted", sha: pushed });
			expect(h.origin.refSha("main")).toBe(pushed);
			expect(h.pushAttempts).toBe(1);
		});

		describe("a retry whose live checks refuse after the revert already reached the branch", () => {
			it.each([
				[
					"the member lost write rights",
					() => {
						h.canCreate = false;
					},
				],
				[
					"the project was switched to Read-only mode",
					() => {
						h.readOnlyFromCheck = 1;
						h.readOnlyChecks = 0;
					},
				],
			])(
				"still finds its own commit, so the revert is recorded, when %s",
				async (_label, change) => {
					const s = reworkRules();
					const first = await revert(s);
					const pushed = h.origin.refSha("main") as string;
					expect(first).toMatchObject({
						kind: "reverted",
						sha: pushed,
					});
					h.pushAttempts = 0;
					change();

					const again = await revert(s);

					expect(again).toEqual({
						kind: "reverted",
						sha: pushed,
						ref: "main",
						fileCount: 3,
					});
					expect(h.pushAttempts).toBe(0);
					expect(h.origin.refSha("main")).toBe(pushed);
				},
			);

			it("still refuses when the branch holds no revert of its own", async () => {
				const s = reworkRules();
				h.canCreate = false;

				await expect(revert(s)).rejects.toMatchObject({
					code: "PERMISSION_REVOKED",
				});

				expect(h.pushAttempts).toBe(0);
				expect(h.origin.refSha("main")).toBe(s);
			});
		});

		it("quotes no credential from the reverted commit's subject", async () => {
			const s = h.origin.commit({
				parents: [h.origin.base],
				changes: { "rules/a.md": "alpha v2\n" },
				message: `Use ${LEAKED} for the deploy`,
			});
			h.origin.setRef("main", s);

			await revert(s);

			const message = h.origin.message(h.origin.refSha("main") as string);
			expect(message).not.toContain(LEAKED);
			expect(message.startsWith(`Revert commit ${s.slice(0, 7)}\n`)).toBe(
				true,
			);
		});

		it("is PERMISSION_REVOKED, pushing nothing, when the member lost write rights", async () => {
			const s = reworkRules();
			h.canCreate = false;

			await expect(revert(s)).rejects.toMatchObject({
				code: "PERMISSION_REVOKED",
			});

			expect(h.credentialRequests).toBe(1);
			expect(h.pushAttempts).toBe(0);
			expect(h.origin.refSha("main")).toBe(s);
		});

		it("is CONFIGURATION_CHANGED when the project is no longer repository-backed", async () => {
			const s = reworkRules();
			h.sync = null;

			await expect(revert(s)).rejects.toMatchObject({
				code: "CONFIGURATION_CHANGED",
			});

			expect(h.credentialRequests).toBe(0);
		});

		it("takes only a full object id", async () => {
			await expect(revert("main")).rejects.toBeDefined();

			expect(h.credentialRequests).toBe(0);
		});

		describe("paths the rules of a version leave out", () => {
			function commitTouching(changes: Record<string, string | null>) {
				const s = h.origin.commit({
					parents: [h.origin.base],
					changes,
					message: "Touch a file Fabric leaves out",
				});
				h.origin.setRef("main", s);
				return s;
			}

			it.each([
				[
					"the .fabricignore file, which decides the exclusion rules",
					{ "rules/.fabricignore": "drafts/**\n" },
					{ layer: "default", ignoreGlobs: [] as string[] },
				],
				[
					"a path the published version's own ignore rules exclude",
					{ "rules/drafts/notes.md": "draft\n" },
					{ layer: "project", ignoreGlobs: ["drafts/**"] },
				],
				[
					"a path the always-excluded globs name",
					{ "rules/CLAUDE.local.md": "personal\n" },
					{ layer: "default", ignoreGlobs: [] as string[] },
				],
			])(
				"answers REVERT_UNSUPPORTED, pushing nothing, for a commit that changed %s",
				async (_label, changes, frozen) => {
					h.published = {
						organizationId: ORG,
						settingsFrozen: frozen,
					};
					const s = commitTouching(changes);

					const result = await revert(s);

					expect(result).toEqual({
						kind: "refused",
						code: "REVERT_UNSUPPORTED",
					});
					expect(h.origin.refSha("main")).toBe(s);
					expect(h.pushAttempts).toBe(0);
				},
			);

			it("refuses when ONE of several changed paths is one the rules leave out", async () => {
				h.published = {
					organizationId: ORG,
					settingsFrozen: { layer: "default", ignoreGlobs: [] },
				};
				const s = commitTouching({
					"rules/a.md": "alpha v2\n",
					"rules/.fabricignore": "x\n",
				});

				expect(await revert(s)).toEqual({
					kind: "refused",
					code: "REVERT_UNSUPPORTED",
				});
			});

			it("still reverts an ordinary commit when the published version froze some ignore rules", async () => {
				h.published = {
					organizationId: ORG,
					settingsFrozen: {
						layer: "project",
						ignoreGlobs: ["drafts/**"],
					},
				};
				const s = commitTouching({ "rules/a.md": "alpha v2\n" });

				expect(await revert(s)).toMatchObject({ kind: "reverted" });
			});

			it("applies the always-excluded globs even when no published version is readable", async () => {
				h.published = null;
				const s = commitTouching({
					"rules/CLAUDE.local.md": "personal\n",
				});

				expect(await revert(s)).toEqual({
					kind: "refused",
					code: "REVERT_UNSUPPORTED",
				});
			});
		});
	},
);

describe("settlePushedDirectCommit (a commit the branch already holds)", () => {
	const PUSHED_SHA = "d".repeat(40);
	const ids = { snapshotId: SNAPSHOT, organizationId: ORG };

	function pending(over: Partial<Row> = {}): Row {
		return {
			id: SNAPSHOT,
			projectId: PROJECT,
			organizationId: ORG,
			userId: USER,
			version: 8,
			status: "READY",
			source: "UPLOAD",
			proposalDestination: "REPOSITORY_COMMIT",
			proposalStatus: null,
			commitContext: {
				v: 1,
				integrationId: INTEGRATION,
				syncId: SYNC,
				syncGeneration: 1,
				provider: "GITHUB",
				targetRef: "main",
				rootPath: "",
				baseCommitSha: "a".repeat(40),
				repository: REPOSITORY,
				author: { name: "Example Member", email: NOREPLY },
				committer: { name: "Fabric", email: NOREPLY },
				message: "Tighten the rules",
				committedAt: "2026-10-02T10:00:00Z",
			},
			commitOutcome: null,
			baseSnapshotId: BASE_SNAPSHOT,
			fileCount: 4,
			publishedAt: null,
			createdAt: new Date("2026-10-02T09:59:00Z"),
			...over,
		};
	}

	beforeEach(() => {
		h.row = pending();
		h.recordPushedFailures = 0;
		for (const fn of [h.recordPushed, h.startSync, h.publish]) {
			fn.mockReset();
		}
		h.startSync.mockImplementation(() => undefined);
	});

	it("records the outcome and names the run that takes the head, and publishes nothing", async () => {
		const confirm = await settlePushedDirectCommit({
			...ids,
			sha: PUSHED_SHA,
		});

		expect(h.recordPushed).toHaveBeenCalledWith({
			snapshotId: SNAPSHOT,
			projectId: PROJECT,
			organizationId: ORG,
			actorUserId: USER,
			ref: "main",
			sha: PUSHED_SHA,
			fileCount: 4,
		});
		expect(h.row?.commitOutcome).toEqual({
			outcome: "committed",
			sha: PUSHED_SHA,
			ref: "main",
		});
		expect(confirm).toEqual({
			projectId: PROJECT,
			organizationId: ORG,
			syncId: SYNC,
			generation: 1,
		});
		expect(
			h.startSync,
			"starting the run is the workflow's own, retried, activity",
		).not.toHaveBeenCalled();
		expect(h.publish).not.toHaveBeenCalled();
		expect(h.row?.source).toBe("UPLOAD");
	});

	it("is idempotent: an outcome already recorded for this commit is success, and the run is still named", async () => {
		h.row = pending({
			commitOutcome: {
				outcome: "committed",
				sha: PUSHED_SHA,
				ref: "main",
			},
		});

		const confirm = await settlePushedDirectCommit({
			...ids,
			sha: PUSHED_SHA,
		});

		expect(h.recordPushed).not.toHaveBeenCalled();
		expect(confirm).toMatchObject({ syncId: SYNC, generation: 1 });
	});

	it("throws a plain, retryable error while the database is unreachable and records the commit once it is back", async () => {
		h.recordPushedFailures = 4;
		for (let attempt = 1; attempt <= 4; attempt++) {
			await expect(
				settlePushedDirectCommit({ ...ids, sha: PUSHED_SHA }),
			).rejects.toThrow("the database is unreachable");
		}
		expect(h.row?.commitOutcome, "still pending, never failed").toBeNull();

		await settlePushedDirectCommit({ ...ids, sha: PUSHED_SHA });

		expect(h.row?.commitOutcome).toMatchObject({
			outcome: "committed",
			sha: PUSHED_SHA,
		});
	});

	it("is an error, not a quiet success, when the snapshot no longer accepts the outcome", async () => {
		h.row = pending({ commitOutcome: { outcome: "branch-moved" } });

		await expect(
			settlePushedDirectCommit({ ...ids, sha: PUSHED_SHA }),
		).rejects.toMatchObject({
			type: "DIRECT_COMMIT_OUTCOME_REFUSED",
			nonRetryable: true,
		});
	});

	it("is a non-retryable failure when the snapshot is gone", async () => {
		h.row = null;

		await expect(
			settlePushedDirectCommit({ ...ids, sha: PUSHED_SHA }),
		).rejects.toMatchObject({
			type: "DIRECT_COMMIT_SNAPSHOT_MISSING",
			nonRetryable: true,
		});
	});
});

describe("startConfirmingInstructionSync (the run that takes a pushed head)", () => {
	const confirm = {
		projectId: PROJECT,
		organizationId: ORG,
		syncId: SYNC,
		generation: 2,
	};

	beforeEach(() => {
		h.startSync.mockReset();
		h.startOutcome = "started";
		h.settings = {
			sourceOfTruth: "REPOSITORY",
			migration: {
				v: 1,
				state: "SWITCHING",
				branchId: "branch_example",
				snapshotId: "snap_move",
				syncId: SYNC,
				pullRequestUrl: null,
				startedAt: "2026-10-03T10:00:00.000Z",
				userId: USER,
			},
		};
	});

	it("starts a COMMIT_PUSHED run for the row the commit was made against", async () => {
		h.startSync.mockImplementation(() => undefined);

		await expect(
			startConfirmingInstructionSync(confirm),
		).resolves.toBeUndefined();

		expect(h.startSync).toHaveBeenCalledTimes(1);
		expect(h.startSync).toHaveBeenCalledWith({
			projectId: PROJECT,
			organizationId: ORG,
			trigger: "COMMIT_PUSHED",
			expected: { syncId: SYNC, generation: 2 },
		});
	});

	it("does not schedule a retired import for an ordinary direct repository", async () => {
		h.settings = { sourceOfTruth: "REPOSITORY", migration: null };

		await expect(
			startConfirmingInstructionSync(confirm),
		).resolves.toBeUndefined();
		expect(h.startSync).not.toHaveBeenCalled();
	});

	it("fails retryably while a run is open: that run may have read the branch before the push", async () => {
		h.startSync.mockImplementation(() => undefined);
		h.startOutcome = "already_running";

		const failure = await startConfirmingInstructionSync(confirm).catch(
			(error) => error,
		);

		expect(failure).toMatchObject({
			type: "SYNC_RUN_OPEN",
			nonRetryable: false,
		});
	});

	it("throws any other failure of the start, to be retried", async () => {
		h.startSync.mockImplementation(() => {
			throw new Error("temporal is unreachable");
		});

		await expect(startConfirmingInstructionSync(confirm)).rejects.toThrow(
			"temporal is unreachable",
		);
	});
});

describe("checkDirectCommitReadiness", () => {
	beforeEach(() => {
		h.row = null;
		h.recordOutcome.mockClear();
	});

	const ids = { snapshotId: SNAPSHOT, organizationId: ORG };

	function row(over: Partial<Row>): Row {
		return {
			id: SNAPSHOT,
			projectId: PROJECT,
			organizationId: ORG,
			userId: USER,
			version: 8,
			status: "VALIDATING",
			source: "UPLOAD",
			proposalDestination: "REPOSITORY_COMMIT",
			proposalStatus: null,
			commitContext: {},
			commitOutcome: null,
			baseSnapshotId: BASE_SNAPSHOT,
			fileCount: 1,
			publishedAt: null,
			createdAt: new Date(),
			...over,
		};
	}

	it.each([
		["RECEIVING", "pending"],
		["VALIDATING", "pending"],
		["FAILED", "pending"],
		["READY", "ready"],
		["REJECTED", "stop"],
	])("answers %s as %s", async (status, kind) => {
		h.row = row({ status });

		expect(await checkDirectCommitReadiness(ids)).toEqual({ kind });
	});

	it("records nothing for a rejected snapshot: its findings are the verdict", async () => {
		h.row = row({ status: "REJECTED" });

		await checkDirectCommitReadiness(ids);

		expect(h.recordOutcome).not.toHaveBeenCalled();
		expect(h.row?.commitOutcome).toBeNull();
	});

	it("stops for a settled commit and for a row that is not one", async () => {
		h.row = row({
			status: "READY",
			commitOutcome: { outcome: "branch-moved" },
		});
		expect(await checkDirectCommitReadiness(ids)).toEqual({ kind: "stop" });
		h.row = row({ proposalDestination: "REPOSITORY" });
		expect(await checkDirectCommitReadiness(ids)).toEqual({ kind: "stop" });
		h.row = null;
		expect(await checkDirectCommitReadiness(ids)).toEqual({ kind: "stop" });
	});
});

describe("commitToSyncedBranch (the activity's boundary)", () => {
	beforeEach(() => {
		h.recordOutcome.mockClear();
	});

	it("hands back a non-retryable failure as the outcome on its one attempt, for the workflow to record", async () => {
		h.origin = createOrigin(BASE_FILES);
		acceptPushesToMain();
		try {
			seedCommit({ "rules/a.md": "alpha v2\n" });
			h.sync = {
				id: SYNC,
				generation: 7,
				repositoryIntegrationId: INTEGRATION,
				ref: "main",
				rootPath: "",
				repositoryIntegration: {
					projectId: PROJECT,
					status: "ACTIVE",
					provider: "GITHUB",
					repositoryUrl:
						"https://github.com/example-org/example-repo",
				},
			};

			const result = await commitToSyncedBranch({
				snapshotId: SNAPSHOT,
				organizationId: ORG,
			});

			expect(result).toEqual({
				kind: "outcome",
				outcome: {
					outcome: "failed",
					code: "CONFIGURATION_CHANGED",
					retryable: false,
				},
			});
			expect(h.recordOutcome).not.toHaveBeenCalled();
		} finally {
			h.origin.cleanup();
		}
	});

	it("hands back READ_ONLY_MODE as the outcome of a commit in a project switched to Read-only mode, and pushes nothing", async () => {
		h.origin = createOrigin(BASE_FILES);
		acceptPushesToMain();
		h.readOnlyChecks = 0;
		h.readOnlyFromCheck = 1;
		try {
			seedCommit({ "rules/a.md": "alpha v2\n" });

			const result = await commitToSyncedBranch({
				snapshotId: SNAPSHOT,
				organizationId: ORG,
			});

			expect(result).toEqual({
				kind: "outcome",
				outcome: {
					outcome: "failed",
					code: "READ_ONLY_MODE",
					retryable: false,
				},
			});
			expect(h.recordOutcome).not.toHaveBeenCalled();
			expect(h.origin.refSha("main")).toBe(h.origin.base);
		} finally {
			h.readOnlyFromCheck = null;
			h.origin.cleanup();
		}
	});
});

describe("revertCommitOnSyncedBranch (the activity's boundary)", () => {
	it("answers a revert in a project switched to Read-only mode as failed READ_ONLY_MODE, never retried", async () => {
		h.origin = createOrigin(BASE_FILES);
		acceptPushesToMain();
		const reverted = h.origin.commit({
			parents: [h.origin.base],
			changes: { "rules/a.md": "alpha v2\n" },
			message: "Rework the rules",
		});
		h.origin.setRef("main", reverted);
		h.sync = {
			id: SYNC,
			organizationId: ORG,
			generation: 1,
			repositoryIntegrationId: INTEGRATION,
			ref: "main",
			rootPath: "rules",
			allowReaderProposals: false,
			repositoryIntegration: {
				projectId: PROJECT,
				status: "ACTIVE",
				provider: "GITHUB",
				repositoryUrl: "https://github.com/example-org/example-repo",
			},
		};
		h.readOnlyChecks = 0;
		h.readOnlyFromCheck = 1;
		try {
			const result = await revertCommitOnSyncedBranch({
				projectId: PROJECT,
				organizationId: ORG,
				userId: USER,
				sha: reverted,
				requestId: "req_revert_readonly",
				author: { name: "Example Member", email: NOREPLY },
				committer: { name: "Fabric", email: NOREPLY },
				committedAt: "2026-10-03T11:00:00Z",
			});

			expect(result).toEqual({ kind: "failed", code: "READ_ONLY_MODE" });
		} finally {
			h.readOnlyFromCheck = null;
			h.origin.cleanup();
		}
	});
});

/** An error as Prisma throws one: the name and code are what a classifier may read. */
function databaseError(name: string, code?: string, meta?: unknown): Error {
	return Object.assign(new Error("the database refused the write"), {
		name,
		code,
		meta,
	});
}

describe("the activities that record what the commit step decided", () => {
	const ids = { snapshotId: SNAPSHOT, organizationId: ORG };
	const SHA = "d".repeat(40);

	beforeEach(() => {
		h.writeError = null;
		h.recordOutcome.mockClear();
		h.recordPushed.mockClear();
		h.audit.mockClear();
		vi.mocked(logger.error).mockClear();
		h.row = {
			id: SNAPSHOT,
			projectId: PROJECT,
			organizationId: ORG,
			userId: USER,
			version: 8,
			status: "READY",
			source: "UPLOAD",
			proposalDestination: "REPOSITORY_COMMIT",
			proposalStatus: null,
			commitContext: {
				v: 1,
				integrationId: INTEGRATION,
				syncId: SYNC,
				syncGeneration: 1,
				provider: "GITHUB",
				targetRef: "main",
				rootPath: "",
				baseCommitSha: "a".repeat(40),
				repository: REPOSITORY,
				author: { name: "Example Member", email: NOREPLY },
				committer: { name: "Fabric", email: NOREPLY },
				message: "Tighten the rules",
				committedAt: "2026-10-02T10:00:00Z",
			},
			commitOutcome: null,
			baseSnapshotId: BASE_SNAPSHOT,
			fileCount: 4,
			publishedAt: null,
			createdAt: new Date("2026-10-02T09:59:00Z"),
		};
		h.sync = { id: SYNC, generation: 1 };
	});

	afterEach(() => {
		h.writeError = null;
	});

	describe("recordDirectCommitSettlement", () => {
		it.each([
			["unchanged", { outcome: "unchanged" as const, sha: SHA }],
			["branch-moved", { outcome: "branch-moved" as const }],
			[
				"failed",
				{
					outcome: "failed" as const,
					code: "READ_ONLY_MODE",
					retryable: false,
				},
			],
		])("records a %s outcome that wrote nothing", async (name, outcome) => {
			const result = await recordDirectCommitSettlement({
				...ids,
				outcome,
			});

			expect(result).toEqual({ kind: "settled", outcome: name });
			expect(h.row?.commitOutcome).toEqual(outcome);
		});

		it("leaves a row an earlier attempt or the reaper settled as it is, and still succeeds", async () => {
			h.row = {
				...(h.row as Row),
				commitOutcome: { outcome: "branch-moved" },
			};

			await expect(
				recordDirectCommitSettlement({
					...ids,
					outcome: { outcome: "unchanged", sha: SHA },
				}),
			).resolves.toEqual({ kind: "settled", outcome: "unchanged" });
			expect(h.row?.commitOutcome).toEqual({ outcome: "branch-moved" });
		});

		it("throws a fault that can pass as it is, to be retried", async () => {
			h.writeError = databaseError(
				"PrismaClientKnownRequestError",
				"P2024",
			);

			await expect(
				recordDirectCommitSettlement({
					...ids,
					outcome: { outcome: "branch-moved" },
				}),
			).rejects.toMatchObject({ name: "PrismaClientKnownRequestError" });
		});

		it.each([
			[
				"a foreign key that names nothing",
				"PrismaClientKnownRequestError",
				"P2003",
				undefined,
			],
			[
				"an enum value the column refuses",
				"PrismaClientKnownRequestError",
				"P2010",
				{ code: "22P02" },
			],
			[
				"a validation error",
				"PrismaClientValidationError",
				undefined,
				undefined,
			],
		])(
			"turns %s into a non-retryable RECORD_REJECTED",
			async (_label, name, code, meta) => {
				h.writeError = databaseError(name, code, meta);

				await expect(
					recordDirectCommitSettlement({
						...ids,
						outcome: { outcome: "branch-moved" },
					}),
				).rejects.toMatchObject({
					type: "RECORD_REJECTED",
					nonRetryable: true,
				});
			},
		);
	});

	describe("recordPushedDirectCommit", () => {
		it("records the commit and names the run that takes the head", async () => {
			const result = await recordPushedDirectCommit({ ...ids, sha: SHA });

			expect(result).toEqual({
				kind: "settled",
				outcome: "committed",
				confirm: {
					projectId: PROJECT,
					organizationId: ORG,
					syncId: SYNC,
					generation: 1,
				},
			});
			expect(h.row?.commitOutcome).toMatchObject({
				outcome: "committed",
				sha: SHA,
			});
		});

		it("throws a fault that can pass as it is, so the commit is still recorded once it has", async () => {
			h.writeError = databaseError("PrismaClientInitializationError");

			await expect(
				recordPushedDirectCommit({ ...ids, sha: SHA }),
			).rejects.toMatchObject({
				name: "PrismaClientInitializationError",
			});
			expect(
				h.row?.commitOutcome,
				"still pending, never failed",
			).toBeNull();
		});

		it("turns a write the database will always refuse into a non-retryable RECORD_REJECTED", async () => {
			h.writeError = databaseError(
				"PrismaClientKnownRequestError",
				"P2003",
			);

			await expect(
				recordPushedDirectCommit({ ...ids, sha: SHA }),
			).rejects.toMatchObject({
				type: "RECORD_REJECTED",
				nonRetryable: true,
			});
		});
	});

	describe("recordRevertedCommit", () => {
		const input = {
			projectId: PROJECT,
			organizationId: ORG,
			userId: USER,
			sha: "c".repeat(40),
			requestId: "req_example_revert",
			author: { name: "Example Member", email: NOREPLY },
			committer: { name: "Fabric", email: NOREPLY },
			committedAt: "2026-10-03T10:00:00Z",
		};

		it("turns an audit write the database will always refuse into a non-retryable RECORD_REJECTED", async () => {
			h.writeError = databaseError(
				"PrismaClientKnownRequestError",
				"P2003",
			);

			await expect(
				recordRevertedCommit(input, {
					sha: SHA,
					ref: "main",
					fileCount: 1,
				}),
			).rejects.toMatchObject({
				type: "RECORD_REJECTED",
				nonRetryable: true,
			});
		});

		it("names the live sync row for the confirming run", async () => {
			await expect(
				recordRevertedCommit(input, {
					sha: SHA,
					ref: "main",
					fileCount: 1,
				}),
			).resolves.toEqual({
				projectId: PROJECT,
				organizationId: ORG,
				syncId: SYNC,
				generation: 1,
			});
		});
	});

	describe("reportDirectCommitSettleFailed", () => {
		it("logs one error and marks the row failed SETTLE_FAILED, retryable, so it is not pending forever", async () => {
			await reportDirectCommitSettleFailed({ ...ids, sha: SHA });

			expect(logger.error).toHaveBeenCalledTimes(1);
			expect(h.row?.commitOutcome).toEqual({
				outcome: "failed",
				code: "SETTLE_FAILED",
				retryable: true,
			});
		});

		it("says so when nothing was pushed", async () => {
			await reportDirectCommitSettleFailed({ ...ids, sha: null });

			expect(logger.error).toHaveBeenCalledTimes(1);
			expect(vi.mocked(logger.error).mock.calls[0]?.[1]).not.toMatch(
				/reached the branch/,
			);
			expect(h.row?.commitOutcome).toMatchObject({
				code: "SETTLE_FAILED",
			});
		});

		it("never overwrites an outcome that was recorded after all", async () => {
			h.row = {
				...(h.row as Row),
				commitOutcome: { outcome: "committed", sha: SHA, ref: "main" },
			};

			await reportDirectCommitSettleFailed({ ...ids, sha: SHA });

			expect(h.row?.commitOutcome).toMatchObject({
				outcome: "committed",
			});
		});
	});

	describe("reportRevertRecordFailed", () => {
		it("logs one error naming the request and the commit, and writes nothing", async () => {
			await reportRevertRecordFailed(
				{
					projectId: PROJECT,
					organizationId: ORG,
					userId: USER,
					sha: "c".repeat(40),
					requestId: "req_example_revert",
					author: { name: "Example Member", email: NOREPLY },
					committer: { name: "Fabric", email: NOREPLY },
					committedAt: "2026-10-03T10:00:00Z",
				},
				{ sha: SHA },
			);

			expect(logger.error).toHaveBeenCalledTimes(1);
			expect(vi.mocked(logger.error).mock.calls[0]?.[0]).toMatchObject({
				requestId: "req_example_revert",
				sha: SHA,
			});
			expect(h.recordOutcome).not.toHaveBeenCalled();
		});
	});
});
