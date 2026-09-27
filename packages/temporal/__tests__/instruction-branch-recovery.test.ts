/**
 * Recovery of issued member-branch operations and re-observation (Fizzy
 * #2738 spec §6.2; plan Task 7 "recovery table").
 *
 * Git is real: an origin repository under `os.tmpdir()` over `file://`. The
 * query layer is the in-memory fake of `helpers/instruction-branch-fake-db.ts`,
 * whose lifecycle decisions are the real pure reducer and transition table.
 * Every identifier is synthetic.
 */
import { mkdtempSync, renameSync, rmSync } from "node:fs";
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
	beforePush: null as null | (() => void),
	diff: null as null | ((entries: unknown[]) => unknown[]),
	credentialPhases: [] as string[],
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
				h.credentialPhases.push(input.phase);
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
vi.mock(
	"../src/activities/lib/instruction-branch-git",
	async (importOriginal) => {
		const real =
			await importOriginal<
				typeof import("../src/activities/lib/instruction-branch-git")
			>();
		return {
			...real,
			pushFastForward: async (
				i: Parameters<typeof real.pushFastForward>[0],
			) => {
				h.beforePush?.();
				return real.pushFastForward(i);
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

import {
	appendBranchProposal,
	recoverBranchOperation,
	reobserveProposalOperations,
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
	seedProposal,
	seedWorld,
	withdraw,
} from "./helpers/instruction-branch-scenario";

let s: Scenario;

async function append(snapshotId: string) {
	return appendBranchProposal(appendInput(s, snapshotId));
}

function recover(operationId: string) {
	return recoverBranchOperation({
		branchId: BRANCH_ID,
		organizationId: ORG,
		operationId,
	});
}

/**
 * P1 appended (C1), then P2 pushed but its acknowledgement lost: the
 * operation issued with no outcome, the head still C1, P2 still OPENING.
 */
async function issuedAppend(): Promise<{
	c1: string;
	sha: string;
	opId: string;
}> {
	seedBranch(s);
	seedProposal(s, "snap_p1", { "rules/a.md": "alpha v2\n" });
	expect(await append("snap_p1")).toEqual({ outcome: "appended" });
	const c1 = h.origin.refSha(refFor(1)) as string;
	seedProposal(s, "snap_p2", { "rules/b.md": "beta v2\n" });
	const attempt = proposal(s, "snap_p2").pullRequestAttempt;
	expect(await append("snap_p2")).toEqual({ outcome: "appended" });
	const [op] = opsOf(s, "snap_p2");
	Object.assign(op as object, { outcome: null, pushAckedAt: null });
	Object.assign(branch(s), { headSha: c1, headExecutionSeq: 1 });
	Object.assign(proposal(s, "snap_p2"), {
		pullRequestState: "OPENING",
		pullRequestAttempt: attempt,
	});
	s.fake.state.audits.length = 0;
	return { c1, sha: op?.sha as string, opId: op?.id as string };
}

function recoveredAudit(opId: string) {
	return s.fake.state.audits.find(
		(a) =>
			a.action === "project.instructions.pull_request_branch_updated" &&
			a.metadata?.operationId === opId,
	);
}

describe.skipIf(!hasGit())("recoverBranchOperation (spec §6.2)", () => {
	beforeEach(() => {
		h.origin = createOrigin(BASE_FILES);
		h.storage.clear();
		h.beforePush = null;
		h.diff = null;
		h.credentialPhases.length = 0;
		for (const fn of Object.values(h.adapter)) {
			fn.mockReset();
		}
		s = { fake: h.fake, origin: h.origin, storage: h.storage };
		s.fake.reset();
		seedWorld(s);
	});
	afterEach(() => {
		h.origin.cleanup();
	});

	describe("observed: proven ancestry establishes the push", () => {
		it("tip == sha", async () => {
			const { sha, opId } = await issuedAppend();
			expect(await recover(opId)).toEqual({ outcome: "observed" });
			expect(opsOf(s, "snap_p2")[0]?.outcome).toBe("observed");
			expect(recoveredAudit(opId)?.metadata).toMatchObject({
				recovered: true,
			});
			expect(proposal(s, "snap_p2").pullRequestState).toBe("OPEN");
			expect(branch(s)).toMatchObject({
				headSha: sha,
				foreignTipAt: null,
			});
		});

		it("the tip a descendant of sha (a hand commit on top)", async () => {
			const { sha, opId } = await issuedAppend();
			const hand = h.origin.commit({
				parents: [sha],
				changes: { "CLAUDE.md": "# Hand\n" },
			});
			h.origin.setRef(refFor(1), hand);
			expect(await recover(opId)).toEqual({ outcome: "observed" });
			expect(recoveredAudit(opId)?.metadata).toMatchObject({
				recovered: true,
			});
			expect(branch(s).headSha).toBe(sha);
			expect(branch(s).foreignTipAt).not.toBeNull();
			expect(proposal(s, "snap_p2").pullRequestState).toBe("OPEN");
		});

		it("a rewrite that keeps sha as an ancestor", async () => {
			const { sha, opId } = await issuedAppend();
			const main = h.origin.commit({
				parents: [h.origin.base],
				changes: { "CLAUDE.md": "# Main moved\n" },
			});
			const merge = h.origin.commit({
				parents: [main, sha],
				treeFrom: main,
				message: "rebuilt on main",
			});
			h.origin.setRef(refFor(1), merge);
			expect(await recover(opId)).toEqual({ outcome: "observed" });
			expect(recoveredAudit(opId)?.metadata).toMatchObject({
				recovered: true,
			});
			expect(proposal(s, "snap_p2").pullRequestState).toBe("OPEN");
		});
	});

	describe("unknown: anything else, never not_pushed", () => {
		async function expectUnknown(opId: string) {
			expect(await recover(opId)).toEqual({ outcome: "unknown" });
			expect(opsOf(s, "snap_p2")[0]?.outcome).toBe("unknown");
			expect(proposal(s, "snap_p2")).toMatchObject({
				pullRequestState: "BLOCKED",
				pullRequestFailure: expect.objectContaining({
					code: "PUSH_OUTCOME_UNKNOWN",
					retryable: false,
				}),
			});
			expect(branch(s).foreignTipAt).not.toBeNull();
			expect(recoveredAudit(opId)).toBeUndefined();
			expect(
				s.fake.state.ops.some((op) => op.outcome === "not_pushed"),
			).toBe(false);
		}

		it("the ref absent", async () => {
			const { opId } = await issuedAppend();
			h.origin.deleteRef(refFor(1));
			await expectUnknown(opId);
		});

		it("the tip at the parent", async () => {
			const { c1, opId } = await issuedAppend();
			h.origin.setRef(refFor(1), c1);
			await expectUnknown(opId);
		});

		it("a descendant of the parent without sha", async () => {
			const { c1, opId } = await issuedAppend();
			const hand = h.origin.commit({
				parents: [c1],
				changes: { "rules/b.md": "beta by hand\n" },
			});
			h.origin.setRef(refFor(1), hand);
			await expectUnknown(opId);
		});

		it("an isAncestor error (an object the history does not have)", async () => {
			const { opId } = await issuedAppend();
			Object.assign(opsOf(s, "snap_p2")[0] as object, {
				sha: "f".repeat(40),
			});
			await expectUnknown(opId);
		});
	});

	it("a history that cannot be fetched writes nothing: retry_later, never a verdict", async () => {
		const { opId } = await issuedAppend();
		renameSync(h.origin.dir, `${h.origin.dir}-unreachable`);
		expect(await recover(opId)).toEqual({ outcome: "retry_later" });
		expect(opsOf(s, "snap_p2")[0]?.outcome).toBeNull();
		expect(proposal(s, "snap_p2").pullRequestState).toBe("OPENING");
	});

	it("an operation that already has an outcome is reported as it stands", async () => {
		const { opId } = await issuedAppend();
		Object.assign(opsOf(s, "snap_p2")[0] as object, { outcome: "acked" });
		const trace = s.fake.state.trace.length;
		expect(await recover(opId)).toEqual({ outcome: "observed" });
		expect(s.fake.state.trace.length).toBe(trace);
		expect(h.credentialPhases.filter((p) => p === "recover")).toEqual([]);
	});

	describe("a revert", () => {
		/** P1 appended and withdrawn; the revert pushed but its acknowledgement lost. */
		async function issuedRevert(): Promise<{ c1: string; opId: string }> {
			seedBranch(s);
			seedProposal(s, "snap_p1", { "rules/a.md": "alpha v2\n" });
			seedProposal(s, "snap_p2", { "rules/b.md": "beta v2\n" });
			expect(await append("snap_p1")).toEqual({ outcome: "appended" });
			expect(await append("snap_p2")).toEqual({ outcome: "appended" });
			const c1 = h.origin.refSha(refFor(1)) as string;
			withdraw(s, "snap_p1");
			const attempt = proposal(s, "snap_p1").pullRequestAttempt;
			expect(
				await revertBranchProposal({
					branchId: BRANCH_ID,
					organizationId: ORG,
					snapshotId: "snap_p1",
					proposalAttempt: attempt,
				}),
			).toEqual({ outcome: "reverted" });
			const revert = opsOf(s, "snap_p1").find(
				(op) => op.kind === "REVERT",
			);
			Object.assign(revert as object, {
				outcome: null,
				pushAckedAt: null,
			});
			Object.assign(branch(s), { headSha: c1, headExecutionSeq: 2 });
			Object.assign(proposal(s, "snap_p1"), {
				pullRequestState: "CLOSE_REQUESTED",
				pullRequestAttempt: attempt,
				pullRequestFailure: null,
			});
			s.fake.state.audits.length = 0;
			return { c1, opId: revert?.id as string };
		}

		it("observed completes the withdrawal", async () => {
			const { opId } = await issuedRevert();
			expect(await recover(opId)).toEqual({ outcome: "observed" });
			expect(proposal(s, "snap_p1").pullRequestState).toBe("CANCELED");
			expect(recoveredAudit(opId)?.metadata).toMatchObject({
				recovered: true,
				kind: "REVERT",
			});
		});

		it("unknown returns the proposal OPEN with WITHDRAW_OUTCOME_UNKNOWN", async () => {
			const { c1, opId } = await issuedRevert();
			h.origin.setRef(refFor(1), c1);
			expect(await recover(opId)).toEqual({ outcome: "unknown" });
			expect(proposal(s, "snap_p1")).toMatchObject({
				pullRequestState: "OPEN",
				pullRequestFailure: expect.objectContaining({
					code: "WITHDRAW_OUTCOME_UNKNOWN",
				}),
				pendingCommand: null,
				withdrawScope: null,
			});
			expect(branch(s).foreignTipAt).not.toBeNull();
		});
	});

	describe("reobserveProposalOperations (spec §6.2 step 5)", () => {
		it("upgrades an unknown operation proven present and reports the lifecycle change", async () => {
			const { opId } = await issuedAppend();
			Object.assign(opsOf(s, "snap_p2")[0] as object, {
				outcome: "unknown",
			});
			Object.assign(proposal(s, "snap_p2"), {
				pullRequestState: "BLOCKED",
				pullRequestFailure: {
					phase: "append",
					code: "PUSH_OUTCOME_UNKNOWN",
					retryable: false,
					at: "2026-09-26T12:00:00.000Z",
					params: {},
				},
			});
			expect(
				await reobserveProposalOperations({
					branchId: BRANCH_ID,
					organizationId: ORG,
					snapshotId: "snap_p2",
				}),
			).toEqual({ changed: true });
			expect(opsOf(s, "snap_p2")[0]?.outcome).toBe("observed");
			expect(recoveredAudit(opId)?.metadata).toMatchObject({
				recovered: true,
			});
			expect(proposal(s, "snap_p2").pullRequestState).toBe("OPEN");
		});

		it("leaves an operation that is not in the history unknown", async () => {
			const { c1 } = await issuedAppend();
			Object.assign(opsOf(s, "snap_p2")[0] as object, {
				outcome: "unknown",
			});
			h.origin.setRef(refFor(1), c1);
			expect(
				await reobserveProposalOperations({
					branchId: BRANCH_ID,
					organizationId: ORG,
					snapshotId: "snap_p2",
				}),
			).toEqual({ changed: false });
			expect(opsOf(s, "snap_p2")[0]?.outcome).toBe("unknown");
		});
	});
});
