/**
 * Branch-relative native proposals on a member's proposal branch: a delete
 * of a file only the branch holds, a restore of one file to its published
 * version, and a withdrawal of such a change. The per-file rule and the
 * foreign-commit fence are the append's own and are unchanged: a commit made
 * outside Fabric on the path still ends BLOCKED BRANCH_CONFLICT.
 *
 * Git is real: an origin repository under `os.tmpdir()` over `file://`. The
 * query layer is the in-memory fake of `helpers/instruction-branch-fake-db.ts`.
 * Every identifier is synthetic.
 */
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	fake: null as unknown as import("./helpers/instruction-branch-fake-db").FakeDatabase,
	origin: null as unknown as import("./helpers/instruction-branch-origin").Origin,
	storage: new Map<string, Buffer>(),
	adapter: {
		findOperation: vi.fn(),
		open: vi.fn(),
		get: vi.fn(),
		close: vi.fn(),
		pullRequestHeadRef: vi.fn(),
	},
}));

vi.mock("@repo/database", async (importOriginal) => {
	const real = await importOriginal<typeof import("@repo/database")>();
	const { createFakeDatabase } = await import(
		"./helpers/instruction-branch-fake-db"
	);
	h.fake = createFakeDatabase(real);
	return h.fake.module;
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
vi.mock("@repo/integrations", () => ({
	resolveFreshRepoToken: vi.fn(),
	forceReExchangeRepoCredentials: vi.fn(),
	markRepoReauthRequired: vi.fn(),
	REPO_REAUTH_STEP_BOUND_MS: 20_000,
	isGitAuthError: (e: unknown) =>
		String((e as Error)?.message)
			.toLowerCase()
			.includes("authentication failed"),
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
						adapter: h.adapter as never,
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

import {
	appendBranchProposal,
	revertBranchProposal,
} from "../src/activities/instruction-proposal-branches";
import { createOrigin, hasGit } from "./helpers/instruction-branch-origin";
import {
	appendInput,
	BASE_FILES,
	BRANCH_ID,
	branch,
	ORG,
	opsOf,
	proposal,
	refFor,
	type Scenario,
	seedBranch,
	seedGitIntentProposal,
	seedProposal,
	seedWorld,
	withdraw,
} from "./helpers/instruction-branch-scenario";

let s: Scenario;

function append(snapshotId: string) {
	return appendBranchProposal(appendInput(s, snapshotId));
}

const tip = () => h.origin.refSha(refFor(1)) as string;

/** The member adds `rules/new.md` and a 100755 `scripts/tool.sh` on their branch; the published version has neither. */
async function branchOnlyFiles(): Promise<string> {
	seedBranch(s);
	seedProposal(s, "snap_add", {
		"rules/new.md": "new on the branch\n",
		"scripts/tool.sh": "#!/bin/sh\necho tool\n",
	});
	expect(await append("snap_add")).toEqual({ outcome: "appended" });
	return tip();
}

describe.skipIf(!hasGit())(
	"branch-relative proposals on a member branch",
	() => {
		beforeEach(async () => {
			h.origin = createOrigin(BASE_FILES);
			h.storage.clear();
			for (const fn of Object.values(h.adapter)) {
				fn.mockReset();
			}
			await import("@repo/database");
			s = { fake: h.fake, origin: h.origin, storage: h.storage };
			s.fake.reset();
			seedWorld(s);
		});
		afterEach(() => {
			h.origin.cleanup();
		});

		it("deletes a file that exists only on the branch", async () => {
			const added = await branchOnlyFiles();
			const target = h.origin.entry(added, "rules/new.md");
			seedGitIntentProposal(s, "snap_rm", {
				"rules/new.md": { content: null, branchObjectId: target?.oid },
			});
			expect(await append("snap_rm")).toEqual({ outcome: "appended" });
			expect(h.origin.parents(tip())).toEqual([added]);
			expect(h.origin.entry(tip(), "rules/new.md")).toBeNull();
			expect(h.origin.content(tip(), "scripts/tool.sh")).toBe(
				"#!/bin/sh\necho tool",
			);
			expect(opsOf(s, "snap_rm")[0]?.entries).toEqual([
				expect.objectContaining({
					path: "rules/new.md",
					before: expect.objectContaining({ oid: target?.oid }),
					beforeSource: "snap_add",
					after: null,
				}),
			]);
			expect(proposal(s, "snap_rm").pullRequestState).toBe("OPEN");
		});

		it("edits a branch-only 100755 file as a modification: the tip's mode is kept", async () => {
			const added = await branchOnlyFiles();
			expect(h.origin.entry(added, "scripts/tool.sh")?.mode).toBe(
				"100755",
			);
			seedGitIntentProposal(s, "snap_edit", {
				"scripts/tool.sh": {
					content: "#!/bin/sh\necho edited\n",
					branchObjectId: h.origin.entry(added, "scripts/tool.sh")
						?.oid,
					mode: 0o100644,
				},
			});
			expect(await append("snap_edit")).toEqual({ outcome: "appended" });
			expect(h.origin.entry(tip(), "scripts/tool.sh")?.mode).toBe(
				"100755",
			);
			expect(h.origin.content(tip(), "scripts/tool.sh")).toBe(
				"#!/bin/sh\necho edited",
			);
		});

		it("restores one changed file to its published bytes", async () => {
			seedBranch(s);
			seedProposal(s, "snap_p1", {
				"rules/a.md": "alpha v2\n",
				"rules/b.md": "beta v2\n",
			});
			expect(await append("snap_p1")).toEqual({ outcome: "appended" });
			seedGitIntentProposal(s, "snap_restore", {
				"rules/a.md": { content: BASE_FILES["rules/a.md"] },
			});
			expect(await append("snap_restore")).toEqual({
				outcome: "appended",
			});
			expect(h.origin.content(tip(), "rules/a.md")).toBe("alpha");
			expect(h.origin.content(tip(), "rules/b.md")).toBe("beta v2");
		});

		it("a restore after a commit made outside Fabric on that path is BLOCKED BRANCH_CONFLICT and writes nothing", async () => {
			seedBranch(s);
			seedProposal(s, "snap_p1", { "rules/a.md": "alpha v2\n" });
			expect(await append("snap_p1")).toEqual({ outcome: "appended" });
			const hand = h.origin.commit({
				parents: [tip()],
				changes: { "rules/a.md": "alpha by hand\n" },
			});
			h.origin.setRef(refFor(1), hand);
			seedGitIntentProposal(s, "snap_restore", {
				"rules/a.md": { content: BASE_FILES["rules/a.md"] },
			});
			expect(await append("snap_restore")).toEqual({
				outcome: "blocked",
			});
			expect(
				proposal(s, "snap_restore").pullRequestFailure,
			).toMatchObject({
				code: "BRANCH_CONFLICT",
				params: { paths: "rules/a.md", count: 1 },
			});
			expect(opsOf(s, "snap_restore")).toEqual([]);
			expect(tip()).toBe(hand);
			expect(branch(s).foreignTipAt).not.toBeNull();
		});

		it("a branch-only delete after a commit made outside Fabric on that path is BLOCKED BRANCH_CONFLICT", async () => {
			const added = await branchOnlyFiles();
			const target = h.origin.entry(added, "rules/new.md");
			const hand = h.origin.commit({
				parents: [added],
				changes: { "rules/new.md": "edited by hand\n" },
			});
			h.origin.setRef(refFor(1), hand);
			seedGitIntentProposal(s, "snap_rm", {
				"rules/new.md": { content: null, branchObjectId: target?.oid },
			});
			expect(await append("snap_rm")).toEqual({ outcome: "blocked" });
			expect(proposal(s, "snap_rm").pullRequestFailure).toMatchObject({
				code: "BRANCH_CONFLICT",
				params: { paths: "rules/new.md", count: 1 },
			});
			expect(h.origin.content(tip(), "rules/new.md")).toBe(
				"edited by hand",
			);
		});

		it("withdrawing a branch-only delete restores the file, and the branch projects it as written again", async () => {
			const added = await branchOnlyFiles();
			const target = h.origin.entry(added, "rules/new.md");
			seedGitIntentProposal(s, "snap_rm", {
				"rules/new.md": { content: null, branchObjectId: target?.oid },
			});
			expect(await append("snap_rm")).toEqual({ outcome: "appended" });
			withdraw(s, "snap_rm");
			expect(
				await revertBranchProposal({
					branchId: BRANCH_ID,
					organizationId: ORG,
					snapshotId: "snap_rm",
					proposalAttempt: proposal(s, "snap_rm").pullRequestAttempt,
				}),
			).toEqual({ outcome: "reverted" });
			expect(h.origin.entry(tip(), "rules/new.md")).toMatchObject({
				oid: target?.oid,
			});

			const { projectEntries } =
				await vi.importActual<typeof import("@repo/database")>(
					"@repo/database",
				);
			const projected = projectEntries(
				s.fake.state.ops.map((op) => ({
					kind: op.kind,
					executionSeq: op.executionSeq,
					outcome: op.outcome,
					entries: op.entries,
				})),
			);
			expect(projected.find((e) => e.path === "rules/new.md")).toEqual({
				path: "rules/new.md",
				state: "written",
				sha256: expect.any(String),
				snapshotId: "snap_add",
				objectId: target?.oid,
				mode: "100644",
			});
		});
	},
);
