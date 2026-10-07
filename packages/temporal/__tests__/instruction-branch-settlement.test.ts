/**
 * Observation, classification, rehome, settlement, start over,
 * confirmations and merge sync of a member proposal branch (Fizzy #2738
 * spec §6.6, §6.7, Decisions 11, 14, 19; plan Task 9).
 *
 * Git is real: an origin repository under `os.tmpdir()` over `file://`,
 * where a provider's pull-request head ref is `refs/pull/<n>/head`. The
 * provider adapter is a mock; the query layer is the in-memory fake of
 * `helpers/instruction-branch-fake-db.ts`, whose decisions are the REAL
 * pure code (`decideBranchWork`, `planBranchClassification`,
 * `rehomableProposals`, the transition tables). Every identifier is
 * synthetic.
 *
 * Two plan Task 9 cases are the database commands', tested against Postgres
 * in `packages/database/__tests__/instruction-proposal-branch-commands.integration.test.ts`:
 * Close returning a CLOSE_REQUESTED proposal with no issued revert to OPEN
 * with `branch` intent, and Propose again transferring with a new intent
 * order. Here the Close's rows are laid down as that command leaves them
 * (`requestClose`).
 */
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { InstructionPullRequestError } from "@repo/integrations/instruction-pull-requests";
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
	beforeDelete: null as null | (() => void),
	credentialPhases: [] as string[],
	beforeTransition: null as null | (() => void),
	wake: vi.fn(),
	startSync: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => {
	const real = await importOriginal<typeof import("@repo/database")>();
	const { createFakeDatabase } = await import(
		"./helpers/instruction-branch-fake-db"
	);
	h.fake = createFakeDatabase(real);
	return {
		...h.fake.module,
		transitionBranch: async (
			...args: Parameters<typeof real.transitionBranch>
		) => {
			h.beforeTransition?.();
			return h.fake.module.transitionBranch(args[0]);
		},
		recordBranchConfirmation: (
			...args: Parameters<typeof real.recordBranchConfirmation>
		) => h.fake.module.recordBranchConfirmation(...args),
		instructionRepositoryImportAllowed:
			real.instructionRepositoryImportAllowed,
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
vi.mock("@repo/integrations", () => ({
	resolveFreshRepoToken: vi.fn(),
	forceReExchangeRepoCredentials: vi.fn(),
	markRepoReauthRequired: vi.fn(),
	REPO_REAUTH_STEP_BOUND_MS: 20_000,
	isGitAuthError: () => false,
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
			deleteBranch: async (
				i: Parameters<typeof real.deleteBranch>[0],
			) => {
				h.beforeDelete?.();
				return real.deleteBranch(i);
			},
		};
	},
);
vi.mock(
	"../src/activities/lib/instruction-branch-wake",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../src/activities/lib/instruction-branch-wake")
		>()),
		wakeBranchWorkflow: h.wake,
	}),
);
vi.mock("../src/client", () => ({
	// The merge-sync dispatcher's client: calls run under the signal as is;
	// a run it asks about has completed.
	getTemporalClient: async () => ({
		withAbortSignal: (_signal: AbortSignal, fn: () => unknown) => fn(),
		workflow: {
			getHandle: () => ({
				describe: async () => ({ status: { name: "COMPLETED" } }),
			}),
		},
	}),
}));
vi.mock(
	"../src/activities/lib/instruction-sync-start",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../src/activities/lib/instruction-sync-start")
		>()),
		startAutomaticInstructionSync: h.startSync,
	}),
);

import { recordOperationOutcome } from "@repo/database";
import {
	appendBranchProposal,
	classifyBranch,
	createBranchPullRequest,
	dispatchBranchMergeSync,
	lookupBranchPullRequest,
	nextBranchWorkItem,
	reconcileInstructionProposalBranch,
	recoverBranchOperation,
	rehomeBranchProposals,
	revertBranchProposal,
	runBranchConfirmations,
	settleBranch,
} from "../src/activities/instruction-proposal-branches";
import { createOrigin, hasGit } from "./helpers/instruction-branch-origin";
import {
	appendInput,
	BASE_FILES,
	BRANCH_ID,
	branch,
	ORG,
	opsOf,
	PROJECT,
	proposal,
	refFor,
	type Scenario,
	SYNC,
	seedBranch,
	seedProposal,
	seedWorld,
	withdraw,
} from "./helpers/instruction-branch-scenario";

let s: Scenario;

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const PR_HEAD_REF = "refs/pull/7/head";

const ids = () => ({ branchId: BRANCH_ID, organizationId: ORG });
const tip = () => h.origin.refSha(refFor(1)) as string;

function observation(
	state: "OPEN" | "MERGED" | "CLOSED",
	headSha: string,
	externalId = "7",
) {
	return {
		externalId,
		url: `https://example.com/example-org/example-repo/pull/${externalId}`,
		state,
		sourceRef: refFor(1),
		targetRef: "main",
		sourceRepository: {
			provider: "GITHUB",
			owner: "example-org",
			repo: "example-repo",
		},
		headSha,
	};
}

/**
 * The append's receipt check (spec §6.3) reads an open pull request once:
 * it is still open, at the branch's head.
 */
function stillOpen(): void {
	if (branch(s).pullRequestExternalId !== null) {
		h.adapter.get.mockResolvedValueOnce(
			observation("OPEN", branch(s).headSha as string),
		);
	}
}

async function append(
	snapshotId: string,
	changes: Record<string, string | null>,
): Promise<string> {
	seedProposal(s, snapshotId, changes);
	stillOpen();
	expect(await appendBranchProposal(appendInput(s, snapshotId))).toEqual({
		outcome: "appended",
	});
	return tip();
}

/** P1 appended, and the branch's pull request #7 opened on it. */
async function opened(): Promise<string> {
	seedBranch(s);
	const head = await append("snap_p1", { "rules/a.md": "alpha v2\n" });
	h.adapter.open.mockResolvedValueOnce(observation("OPEN", head));
	expect(
		await createBranchPullRequest({
			...ids(),
			branchAttempt: branch(s).attempt,
		}),
	).toEqual({ outcome: "opened" });
	expect(branch(s).state).toBe("OPEN");
	return head;
}

/** The sweeper's Observe sees the pull request ended at `headSha`. */
async function observed(state: "MERGED" | "CLOSED", headSha: string) {
	h.adapter.get.mockResolvedValueOnce(observation(state, headSha));
	expect(
		await reconcileInstructionProposalBranch({
			...ids(),
			expectedAttempt: branch(s).attempt,
		}),
	).toEqual({ state });
	expect(branch(s).membership).toMatchObject({ status: "pending" });
}

const classify = () =>
	classifyBranch({ ...ids(), factsRevision: branch(s).factsRevision });
const settle = () =>
	settleBranch({ ...ids(), branchAttempt: branch(s).attempt });
const confirm = () => runBranchConfirmations(ids());
const work = async () => (await nextBranchWorkItem(ids())).work;
const prHead = (sha: string) => h.origin.git(["update-ref", PR_HEAD_REF, sha]);
const membershipOf = (snapshotId: string) =>
	opsOf(s, snapshotId).map((op) => op.membership);
const later = (ms: number) => {
	s.fake.state.now = new Date(s.fake.state.now.getTime() + ms);
};
const reconciled = () =>
	s.fake.state.audits.filter(
		(a) => a.action === "project.instructions.pull_request_reconciled",
	);

/** The member's Close (as `closeProposalBranch` leaves the rows). */
function requestClose(intent: "WITHDRAW" | "START_OVER" = "WITHDRAW") {
	const b = branch(s);
	b.state = "CLOSE_REQUESTED";
	b.closeIntent = intent;
	b.attempt++;
	b.nextAttemptAt = null;
	if (intent === "WITHDRAW") {
		for (const p of s.fake.state.proposals.values()) {
			if (
				p.proposalBranchId === BRANCH_ID &&
				p.pullRequestState !== null &&
				[
					"QUEUED",
					"OPENING",
					"OPEN",
					"BLOCKED",
					"CLOSE_REQUESTED",
				].includes(p.pullRequestState)
			) {
				p.withdrawRequestedAt = new Date(s.fake.state.now);
				p.withdrawScope = "branch";
				p.pendingCommand = null;
				p.pendingCommandSeq = null;
				if (p.pullRequestState === "QUEUED") {
					p.pullRequestState = "CANCELED";
				}
			}
		}
	}
}

/** A branch BLOCKED non-retryable CREATE_OUTCOME_UNKNOWN, as Start over requires. */
async function unknownCreate(): Promise<string> {
	seedBranch(s);
	const head = await append("snap_p1", { "rules/a.md": "alpha v2\n" });
	const b = branch(s);
	b.state = "BLOCKED";
	b.createIssuedAt = new Date(s.fake.state.now.getTime() - 25 * HOUR_MS);
	b.failure = {
		phase: "recover",
		code: "CREATE_OUTCOME_UNKNOWN",
		retryable: false,
		at: s.fake.state.now.toISOString(),
		params: {},
	};
	return head;
}

describe.skipIf(!hasGit())("member branch settlement (spec §6.6, §6.7)", () => {
	beforeEach(() => {
		h.origin = createOrigin(BASE_FILES);
		h.storage.clear();
		h.beforePush = null;
		h.beforeDelete = null;
		h.beforeTransition = null;
		h.credentialPhases.length = 0;
		for (const fn of Object.values(h.adapter)) {
			fn.mockReset();
		}
		h.adapter.findOperation.mockResolvedValue({ kind: "ABSENT" });
		h.adapter.pullRequestHeadRef.mockReturnValue(null);
		h.wake.mockReset();
		h.wake.mockResolvedValue(undefined);
		h.startSync.mockReset();
		h.startSync.mockResolvedValue({ runId: "run_example_1" });
		s = { fake: h.fake, origin: h.origin, storage: h.storage };
		s.fake.reset();
		seedWorld(s);
	});
	afterEach(() => {
		h.origin.cleanup();
	});

	// -----------------------------------------------------------------------
	// Observation (spec §6.6)
	// -----------------------------------------------------------------------

	describe("reconcileInstructionProposalBranch", () => {
		it("records the final head, membership pending and one reconciled row for a merged pull request", async () => {
			const head = await opened();
			s.fake.state.audits.length = 0;
			await observed("MERGED", head);
			expect(branch(s)).toMatchObject({
				state: "MERGED",
				pullRequestObservation: expect.objectContaining({
					headSha: head,
				}),
			});
			expect(reconciled()).toHaveLength(1);
		});

		it("is fenced on the attempt the sweeper read", async () => {
			const head = await opened();
			h.adapter.get.mockResolvedValue(observation("MERGED", head));
			expect(
				await reconcileInstructionProposalBranch({
					...ids(),
					expectedAttempt: branch(s).attempt - 1,
				}),
			).toEqual({ state: "OPEN" });
			expect(h.adapter.get).not.toHaveBeenCalled();
			expect(branch(s).state).toBe("OPEN");
		});

		it("records an open pull request's check, and a provider failure failure-only with a backoff", async () => {
			const head = await opened();
			later(HOUR_MS);
			h.adapter.get.mockResolvedValueOnce(observation("OPEN", head));
			expect(await reconcileInstructionProposalBranch(ids())).toEqual({
				state: "OPEN",
			});
			expect(branch(s).lastCheckedAt).toEqual(s.fake.state.now);
			h.adapter.get.mockRejectedValueOnce(
				new InstructionPullRequestError({
					code: "PROVIDER_RATE_LIMITED",
					retryable: true,
					cause: "rate_limit",
					retryAfterSeconds: 120,
				}),
			);
			expect(await reconcileInstructionProposalBranch(ids())).toEqual({
				state: "OPEN",
			});
			expect(branch(s)).toMatchObject({
				state: "OPEN",
				failure: expect.objectContaining({ phase: "reconcile" }),
			});
			expect(branch(s).nextAttemptAt?.getTime()).toBeGreaterThan(
				s.fake.state.now.getTime(),
			);
		});

		it("keeps a newer provider backoff recorded after an OPEN reread", async () => {
			const head = await opened();
			const deadline = new Date(s.fake.state.now.getTime() + 120_000);
			h.adapter.get.mockResolvedValueOnce(observation("OPEN", head));
			h.beforeTransition = () => {
				branch(s).failure = {
					code: "PROVIDER_RATE_LIMITED",
					phase: "reconcile",
					retryable: true,
				};
				branch(s).nextAttemptAt = deadline;
				h.beforeTransition = null;
			};
			expect(await reconcileInstructionProposalBranch(ids())).toEqual({
				state: "OPEN",
			});
			expect(branch(s)).toMatchObject({
				failure: expect.objectContaining({
					code: "PROVIDER_RATE_LIMITED",
				}),
				nextAttemptAt: deadline,
			});
		});
	});

	// -----------------------------------------------------------------------
	// Classification (spec §6.6, Decision 14)
	// -----------------------------------------------------------------------

	describe("classifyBranch", () => {
		it("reads the final history from the provider's head ref (GitHub/GitLab): included, MERGED, merge sync requested once", async () => {
			const head = await opened();
			await observed("MERGED", head);
			prHead(head);
			h.origin.deleteRef(refFor(1)); // the branch ref is gone after the merge
			h.adapter.pullRequestHeadRef.mockReturnValue(PR_HEAD_REF);
			s.fake.state.audits.length = 0;
			expect(await classify()).toEqual({ outcome: "done" });
			expect(membershipOf("snap_p1")).toEqual(["included"]);
			expect(proposal(s, "snap_p1").pullRequestState).toBe("MERGED");
			expect(reconciled()[0]?.metadata).toMatchObject({
				reason: "outcome",
			});
			expect(branch(s).membership).toMatchObject({ status: "done" });
			expect(branch(s).mergeSyncRequestedAt).toEqual(s.fake.state.now);
			expect((await work()).kind).toBe("idle");
		});

		it("includes an operation at the observed head without a fetch, even after the branch ref is gone (Azure DevOps: no head ref)", async () => {
			const head = await opened();
			await observed("CLOSED", head);
			h.origin.deleteRef(refFor(1));
			expect(await classify()).toEqual({ outcome: "done" });
			expect(membershipOf("snap_p1")).toEqual(["included"]);
			expect(proposal(s, "snap_p1").pullRequestState).toBe("CLOSED");
		});

		it("falls back on the branch ref when its tip is the observed head (Azure DevOps: no head ref)", async () => {
			const head = await opened();
			await observed("CLOSED", head);
			expect(await classify()).toEqual({ outcome: "done" });
			expect(membershipOf("snap_p1")).toEqual(["included"]);
			expect(proposal(s, "snap_p1").pullRequestState).toBe("CLOSED");
			expect(branch(s).mergeSyncRequestedAt).toBeNull();
		});

		it("a descendant hand commit in the pull request keeps Fabric's commit included", async () => {
			const head = await opened();
			const hand = h.origin.commit({
				parents: [head],
				changes: { "CLAUDE.md": "# Hand\n" },
			});
			h.origin.setRef(refFor(1), hand);
			await observed("MERGED", hand);
			expect(await classify()).toEqual({ outcome: "done" });
			expect(membershipOf("snap_p1")).toEqual(["included"]);
			expect(proposal(s, "snap_p1").pullRequestState).toBe("MERGED");
		});

		it("a push after the merge is unverified: the pull request's outcome, never resubmitted", async () => {
			const h1 = await opened();
			await append("snap_p2", { "rules/b.md": "beta v2\n" });
			await observed("MERGED", h1);
			prHead(h1);
			h.adapter.pullRequestHeadRef.mockReturnValue(PR_HEAD_REF);
			s.fake.state.audits.length = 0;
			expect(await classify()).toEqual({ outcome: "done" });
			expect(membershipOf("snap_p1")).toEqual(["included"]);
			expect(membershipOf("snap_p2")).toEqual(["unverified"]);
			expect(proposal(s, "snap_p2").pullRequestState).toBe("MERGED");
			expect(
				reconciled().find((a) => a.metadata?.reason === "unverified"),
			).toBeTruthy();
			// Nothing is resubmitted: no rehome, no append.
			expect(await work()).toMatchObject({ kind: "idle" });
		});

		it("a hand reset that dropped a Fabric commit: that commit unverified, the one kept included", async () => {
			const h1 = await opened();
			await append("snap_p2", { "rules/b.md": "beta v2\n" });
			// Reset to P1's commit, then a hand commit: P2's commit is gone.
			const hand = h.origin.commit({
				parents: [h1],
				changes: { "CLAUDE.md": "# Hand\n" },
			});
			h.origin.setRef(refFor(1), hand);
			await observed("CLOSED", hand);
			expect(await classify()).toEqual({ outcome: "done" });
			expect(membershipOf("snap_p1")).toEqual(["included"]);
			expect(membershipOf("snap_p2")).toEqual(["unverified"]);
			expect(proposal(s, "snap_p1").pullRequestState).toBe("CLOSED");
			expect(proposal(s, "snap_p2").pullRequestState).toBe("CLOSED");
			expect(
				reconciled().find(
					(a) =>
						a.metadata?.reason === "unverified" &&
						a.metadata?.outcome === "closed",
				),
			).toBeTruthy();
		});

		it("a rebase onto foreign history leaves every Fabric commit unverified, never included", async () => {
			await opened();
			await append("snap_p2", { "rules/b.md": "beta v2\n" });
			// Both changes re-made by hand on another parent, then merged.
			const rebased = h.origin.commit({
				parents: [h.origin.base],
				changes: {
					"rules/a.md": "alpha v2\n",
					"rules/b.md": "beta v2\n",
					"rules/c.md": "gamma\n",
				},
			});
			h.origin.setRef(refFor(1), rebased);
			await observed("MERGED", rebased);
			expect(await classify()).toEqual({ outcome: "done" });
			expect(membershipOf("snap_p1")).toEqual(["unverified"]);
			expect(membershipOf("snap_p2")).toEqual(["unverified"]);
			expect(proposal(s, "snap_p1").pullRequestState).toBe("MERGED");
			expect(proposal(s, "snap_p2").pullRequestState).toBe("MERGED");
		});

		it("an unavailable history retries with backoff (1, then 5 min), and after 24 h is unverified, never included", async () => {
			await opened();
			// The pull request's head is a commit Fabric did not push, so only
			// its history could prove the operation included.
			await observed("MERGED", "e".repeat(40));
			h.origin.deleteRef(refFor(1));
			expect(await classify()).toEqual({ outcome: "retry_later" });
			expect(branch(s).membership).toMatchObject({
				status: "pending",
				attempts: 1,
				nextAttemptAt: new Date(
					s.fake.state.now.getTime() + MINUTE_MS,
				).toISOString(),
			});
			expect((await work()).kind).toBe("idle");
			later(MINUTE_MS);
			expect(await work()).toEqual({
				kind: "classify",
				factsRevision: branch(s).factsRevision,
			});
			expect(await classify()).toEqual({ outcome: "retry_later" });
			expect(branch(s).membership).toMatchObject({
				attempts: 2,
				nextAttemptAt: new Date(
					s.fake.state.now.getTime() + 5 * MINUTE_MS,
				).toISOString(),
			});
			expect(membershipOf("snap_p1")).toEqual([null]);
			later(24 * HOUR_MS);
			expect(await classify()).toEqual({ outcome: "unverified" });
			expect(membershipOf("snap_p1")).toEqual(["unverified"]);
			expect(branch(s).membership).toMatchObject({
				status: "unverified",
			});
			expect(proposal(s, "snap_p1").pullRequestState).toBe("MERGED");
		});

		it("an issued operation blocks classification: the loop recovers first", async () => {
			const head = await opened();
			await observed("MERGED", head);
			const [op] = opsOf(s, "snap_p1");
			Object.assign(op as object, { outcome: null, pushAckedAt: null });
			expect(await work()).toEqual({
				kind: "recover",
				operationId: op?.id,
			});
			expect(await classify()).toEqual({ outcome: "stale_revision" });
			expect(proposal(s, "snap_p1").pullRequestState).toBe("OPEN");
		});

		it("a stale facts revision answers stale_revision and writes nothing", async () => {
			const head = await opened();
			await observed("MERGED", head);
			expect(
				await classifyBranch({
					...ids(),
					factsRevision: branch(s).factsRevision - 1,
				}),
			).toEqual({ outcome: "stale_revision" });
			expect(membershipOf("snap_p1")).toEqual([null]);
			expect(branch(s).membership).toMatchObject({ status: "pending" });
		});

		it("an append established late while OPENING on a terminal branch is classified; a late establishment after classification re-pends it", async () => {
			const h1 = await opened();
			// P2's push reached the remote, but its answer was lost: the
			// operation issued with no outcome, the head still P1's, P2 still
			// OPENING (as the recovery test's `issuedAppend`).
			seedProposal(s, "snap_p2", { "rules/b.md": "beta v2\n" });
			const attempt = proposal(s, "snap_p2").pullRequestAttempt;
			stillOpen();
			expect(
				await appendBranchProposal(appendInput(s, "snap_p2")),
			).toEqual({
				outcome: "appended",
			});
			const h2 = tip();
			const [op2] = opsOf(s, "snap_p2");
			Object.assign(op2 as object, { outcome: null, pushAckedAt: null });
			Object.assign(branch(s), { headSha: h1, headExecutionSeq: 1 });
			Object.assign(proposal(s, "snap_p2"), {
				pullRequestState: "OPENING",
				pullRequestAttempt: attempt,
			});
			// The member merges the pull request at P2's commit.
			await observed("MERGED", h2);
			expect(await work()).toEqual({
				kind: "recover",
				operationId: op2?.id,
			});
			expect(await classify()).toEqual({ outcome: "stale_revision" });
			expect(
				await recoverBranchOperation({
					...ids(),
					operationId: op2?.id as string,
				}),
			).toEqual({ outcome: "observed" });
			expect(await work()).toEqual({
				kind: "classify",
				factsRevision: branch(s).factsRevision,
			});
			expect(await classify()).toEqual({ outcome: "done" });
			expect(membershipOf("snap_p1")).toEqual(["included"]);
			expect(membershipOf("snap_p2")).toEqual(["included"]);
			expect(proposal(s, "snap_p2").pullRequestState).toBe("MERGED");

			// A fact arriving after classification: membership back to pending.
			seedProposal(
				s,
				"snap_p3",
				{ "rules/c.md": "gamma\n" },
				{
					pullRequestState: "OPEN",
				},
			);
			s.fake.state.ops.push({
				...(opsOf(
					s,
					"snap_p2",
				)[0] as (typeof s.fake.state.ops)[number]),
				id: "op_late",
				snapshotId: "snap_p3",
				executionSeq: 9,
				outcome: "unknown",
				membership: null,
				sha: h2,
			});
			await recordOperationOutcome({
				operationId: "op_late",
				organizationId: ORG,
				outcome: "observed",
			});
			expect(branch(s).membership).toMatchObject({ status: "pending" });
			expect((await work()).kind).toBe("classify");
			expect(await classify()).toEqual({ outcome: "done" });
			expect(proposal(s, "snap_p3").pullRequestState).toBe("MERGED");
		});

		it("never changes the lifecycle of a proposal that left the branch: only its operation's membership", async () => {
			const head = await opened();
			await observed("MERGED", head);
			const p1 = proposal(s, "snap_p1");
			p1.proposalBranchId = "branch_elsewhere";
			p1.proposalAssignment = 2;
			p1.pullRequestState = "QUEUED";
			expect(await classify()).toEqual({ outcome: "done" });
			expect(membershipOf("snap_p1")).toEqual(["included"]);
			expect(proposal(s, "snap_p1").pullRequestState).toBe("QUEUED");
		});

		it("a current append unknown on a terminal branch takes the pull request's outcome, unverified, and is never rehomed", async () => {
			const head = await opened();
			await append("snap_p2", { "rules/b.md": "beta v2\n" });
			const [op2] = opsOf(s, "snap_p2");
			Object.assign(op2 as object, { outcome: "unknown" });
			proposal(s, "snap_p2").pullRequestState = "BLOCKED";
			proposal(s, "snap_p2").pullRequestFailure = {
				phase: "recover",
				code: "PUSH_OUTCOME_UNKNOWN",
				retryable: false,
				at: s.fake.state.now.toISOString(),
				params: {},
			};
			// The pull request closed at P1's commit (its head ref), before P2.
			await observed("CLOSED", head);
			prHead(head);
			h.adapter.pullRequestHeadRef.mockReturnValue(PR_HEAD_REF);
			s.fake.state.audits.length = 0;
			expect(await classify()).toEqual({ outcome: "done" });
			// Only established operations are classified: the unknown one
			// keeps no membership; its proposal is decided by its outcome.
			expect(membershipOf("snap_p1")).toEqual(["included"]);
			expect(membershipOf("snap_p2")).toEqual([null]);
			expect(proposal(s, "snap_p1").pullRequestState).toBe("CLOSED");
			expect(proposal(s, "snap_p2").pullRequestState).toBe("CLOSED");
			expect(
				reconciled().find(
					(a) =>
						a.metadata?.reason === "unverified" &&
						a.metadata?.outcome === "closed",
				),
			).toBeTruthy();
			// Never rehomed, never resubmitted.
			expect((await work()).kind).toBe("idle");
			expect(proposal(s, "snap_p2").proposalBranchId).toBe(BRANCH_ID);
		});

		/** P1 and P2 appended on the open pull request, then P1 withdrawn by an established revert. */
		async function revertedAfterTwo(): Promise<{
			h2: string;
			reverted: string;
		}> {
			await opened();
			const h2 = await append("snap_p2", { "rules/b.md": "beta v2\n" });
			withdraw(s, "snap_p1");
			expect(
				await revertBranchProposal({
					...ids(),
					snapshotId: "snap_p1",
					proposalAttempt: proposal(s, "snap_p1").pullRequestAttempt,
				}),
			).toEqual({ outcome: "reverted" });
			expect(proposal(s, "snap_p1").pullRequestState).toBe("CANCELED");
			return { h2, reverted: tip() };
		}

		it("a revert included with its append: the proposal stays CANCELED, the rest take the outcome", async () => {
			const { reverted } = await revertedAfterTwo();
			await observed("MERGED", reverted);
			expect(await classify()).toEqual({ outcome: "done" });
			// The append and the revert, both on the merged head.
			expect(membershipOf("snap_p1")).toEqual(["included", "included"]);
			expect(proposal(s, "snap_p1").pullRequestState).toBe("CANCELED");
			expect(proposal(s, "snap_p2").pullRequestState).toBe("MERGED");
		});

		/**
		 * Classification of the raced revert, as the observer saw the pull
		 * request end at P2's commit (its head ref), before P1's revert.
		 */
		async function racedRevert(state: "MERGED" | "CLOSED"): Promise<{
			h2: string;
			reverted: string;
		}> {
			const raced = await revertedAfterTwo();
			await observed(state, raced.h2);
			prHead(raced.h2);
			h.adapter.pullRequestHeadRef.mockReturnValue(PR_HEAD_REF);
			s.fake.state.audits.length = 0;
			expect(await classify()).toEqual({ outcome: "done" });
			return raced;
		}

		it("a revert not included (the merge raced it): the revert is unverified and the CANCELED proposal takes the merge (Decision 14)", async () => {
			const { reverted } = await racedRevert("MERGED");
			const [appendOp, revertOp] = opsOf(s, "snap_p1");
			expect(appendOp).toMatchObject({
				kind: "APPEND",
				membership: "included",
			});
			expect(revertOp).toMatchObject({
				kind: "REVERT",
				sha: reverted,
				membership: "unverified",
			});
			expect(proposal(s, "snap_p1").pullRequestState).toBe("MERGED");
			expect(proposal(s, "snap_p2").pullRequestState).toBe("MERGED");
			expect(s.fake.state.trace).toContain(
				"proposal:snap_p1:branch_settled:MERGED",
			);
			// One reconciled row each, as Decision 14's first outcome.
			expect(reconciled()).toEqual([
				expect.objectContaining({
					metadata: expect.objectContaining({
						outcome: "merged",
						reason: "outcome",
						branchId: BRANCH_ID,
					}),
				}),
				expect.objectContaining({
					metadata: expect.objectContaining({
						outcome: "merged",
						reason: "outcome",
						branchId: BRANCH_ID,
					}),
				}),
			]);
		});

		it("a revert pushed after the pull request closed: the CANCELED proposal ends CLOSED", async () => {
			await racedRevert("CLOSED");
			expect(membershipOf("snap_p1")).toEqual(["included", "unverified"]);
			expect(proposal(s, "snap_p1").pullRequestState).toBe("CLOSED");
			expect(proposal(s, "snap_p2").pullRequestState).toBe("CLOSED");
			expect(
				reconciled().filter(
					(a) =>
						a.metadata?.outcome === "closed" &&
						a.metadata?.reason === "outcome",
				),
			).toHaveLength(2);
		});

		it("a late fact after the raced revert re-pends classification but never moves the proposal back", async () => {
			const { h2 } = await racedRevert("MERGED");
			expect(proposal(s, "snap_p1").pullRequestState).toBe("MERGED");
			const attempt = proposal(s, "snap_p1").pullRequestAttempt;
			// Even a revert now counted included cannot reopen a MERGED
			// proposal: only a CANCELED one is ever classified again.
			const revertOp = opsOf(s, "snap_p1")[1] as { membership: string };
			revertOp.membership = "included";

			// A fact arriving after classification (the re-pends pattern).
			seedProposal(
				s,
				"snap_p3",
				{ "rules/c.md": "gamma\n" },
				{ pullRequestState: "OPEN" },
			);
			s.fake.state.ops.push({
				...(opsOf(
					s,
					"snap_p2",
				)[0] as (typeof s.fake.state.ops)[number]),
				id: "op_late",
				snapshotId: "snap_p3",
				executionSeq: 9,
				outcome: "unknown",
				membership: null,
				sha: h2,
			});
			await recordOperationOutcome({
				operationId: "op_late",
				organizationId: ORG,
				outcome: "observed",
			});
			expect(branch(s).membership).toMatchObject({ status: "pending" });
			expect((await work()).kind).toBe("classify");
			expect(await classify()).toEqual({ outcome: "done" });
			expect(proposal(s, "snap_p3").pullRequestState).toBe("MERGED");
			expect(proposal(s, "snap_p1")).toMatchObject({
				pullRequestState: "MERGED",
				pullRequestAttempt: attempt,
			});
		});

		describe("a move from uploads into the repository (Fizzy #2878 §9)", () => {
			const MOVE_SYNC = "sync_move_example";

			function openMove(over: { branchId?: string | null } = {}) {
				s.fake.state.settings = {
					sourceOfTruth: "UPLOAD",
					migration: {
						v: 1,
						state: "PROPOSING",
						branchId: over.branchId ?? branch(s).id,
						snapshotId: "snap_p1",
						syncId: MOVE_SYNC,
						pullRequestUrl: null,
						startedAt: "2026-09-26T12:00:00.000Z",
						userId: "user_example",
					},
				};
			}

			const moveTrace = () =>
				s.fake.state.trace.filter((entry) =>
					entry.startsWith("migration:"),
				);

			it("switches the project over BEFORE the classification asks for the merge sync, when the pull request merged where the sync reads", async () => {
				const head = await opened();
				openMove();
				await observed("MERGED", head);
				prHead(head);
				h.adapter.pullRequestHeadRef.mockReturnValue(PR_HEAD_REF);

				expect(await classify()).toEqual({ outcome: "done" });

				expect(moveTrace()).toEqual([
					`migration:complete:${BRANCH_ID}`,
				]);
				const trace = s.fake.state.trace;
				expect(
					trace.indexOf(`migration:complete:${BRANCH_ID}`),
				).toBeLessThan(trace.indexOf(`classified:${BRANCH_ID}:done`));
				expect(branch(s).mergeSyncRequestedAt).toEqual(
					s.fake.state.now,
				);
			});

			it("ends the move when the pull request was closed without merging", async () => {
				const head = await opened();
				openMove();
				await observed("CLOSED", head);

				expect(await classify()).toEqual({ outcome: "done" });

				expect(moveTrace()).toEqual([
					`migration:abandon:${MOVE_SYNC}:pull_request_closed`,
				]);
			});

			it("does not end the move for a close that is a START OVER's: the proposal is rehomed and its pull request opens again", async () => {
				const head = await opened();
				openMove();
				await observed("CLOSED", head);
				branch(s).closeIntent = "START_OVER";

				expect(await classify()).toEqual({ outcome: "done" });

				expect(
					moveTrace(),
					"abandoning here would delete the sync row under a move that carries on",
				).toEqual([]);
			});

			it("still ends the move for a close the member asked for, which is a withdrawal", async () => {
				const head = await opened();
				openMove();
				await observed("CLOSED", head);
				branch(s).closeIntent = "WITHDRAW";

				expect(await classify()).toEqual({ outcome: "done" });

				expect(moveTrace()).toEqual([
					`migration:abandon:${MOVE_SYNC}:pull_request_closed`,
				]);
			});

			it("never mistakes a merge for a start over's close: a merge where the sync reads switches the project whatever the intent was", async () => {
				const head = await opened();
				openMove();
				await observed("MERGED", head);
				prHead(head);
				h.adapter.pullRequestHeadRef.mockReturnValue(PR_HEAD_REF);
				branch(s).closeIntent = "START_OVER";

				expect(await classify()).toEqual({ outcome: "done" });

				expect(moveTrace()).toEqual([
					`migration:complete:${BRANCH_ID}`,
				]);
			});

			it("leaves the sync row alone and says so when the project was flipped to the repository behind the move's back", async () => {
				const head = await opened();
				openMove();
				s.fake.state.settings = {
					...s.fake.state.settings,
					sourceOfTruth: "REPOSITORY",
				};
				await observed("CLOSED", head);

				expect(await classify()).toEqual({ outcome: "done" });

				expect(moveTrace()).toEqual([
					`migration:abandon:${MOVE_SYNC}:pull_request_closed`,
				]);
				const { logger } = await import("@repo/logs");
				expect(logger.warn).toHaveBeenCalledWith(
					expect.objectContaining({
						event: "instruction_migration.source_flipped",
						syncId: MOVE_SYNC,
					}),
					expect.any(String),
				);
			});

			it("ends the move, and never switches the project, when the pull request merged into a branch the sync does not read", async () => {
				const head = await opened();
				openMove();
				await observed("MERGED", head);
				const b = branch(s);
				b.pullRequestObservation = {
					...(b.pullRequestObservation as object),
					targetMismatch: true,
				};

				expect(await classify()).toEqual({ outcome: "done" });

				expect(moveTrace()).toEqual([
					`migration:abandon:${MOVE_SYNC}:pull_request_closed`,
				]);
			});

			it("touches nothing for a branch that carries no move, however it ended", async () => {
				const head = await opened();
				openMove({ branchId: "another_branch" });
				await observed("MERGED", head);

				expect(await classify()).toEqual({ outcome: "done" });

				expect(moveTrace()).toEqual([]);
			});

			it("touches nothing when the project has no move", async () => {
				const head = await opened();
				await observed("MERGED", head);

				expect(await classify()).toEqual({ outcome: "done" });

				expect(moveTrace()).toEqual([]);
			});

			it("is safe to repeat: a later classification of the same branch asks the writers again, which are idempotent", async () => {
				const head = await opened();
				openMove();
				await observed("MERGED", head);
				prHead(head);
				h.adapter.pullRequestHeadRef.mockReturnValue(PR_HEAD_REF);
				await classify();
				const b = branch(s);
				b.membership = {
					status: "pending",
					at: s.fake.state.now.toISOString(),
					attempts: 0,
				};

				await classify();

				expect(moveTrace()).toEqual([
					`migration:complete:${BRANCH_ID}`,
					`migration:complete:${BRANCH_ID}`,
				]);
			});
		});

		it("merge sync is requested once per branch, and never on a target mismatch", async () => {
			const head = await opened();
			await observed("MERGED", head);
			const b = branch(s);
			b.pullRequestObservation = {
				...(b.pullRequestObservation as object),
				targetMismatch: true,
			};
			expect(await classify()).toEqual({ outcome: "done" });
			expect(branch(s).mergeSyncRequestedAt).toBeNull();
			// Once per branch: a later re-classification asks nothing again.
			b.pullRequestObservation = {
				...(b.pullRequestObservation as object),
				targetMismatch: false,
			};
			b.mergeSyncRunId = "run_done";
			b.membership = {
				status: "pending",
				at: s.fake.state.now.toISOString(),
				attempts: 0,
			};
			expect(await classify()).toEqual({ outcome: "done" });
			expect(branch(s).mergeSyncRequestedAt).toBeNull();
		});
	});

	// -----------------------------------------------------------------------
	// Rehome (spec §6.6, §4.3, carry-forward: the rehome loop)
	// -----------------------------------------------------------------------

	describe("rehomeBranchProposals", () => {
		it("transfers a proposal waiting its turn on a merged branch to the member's next branch, keeping its intent order, and wakes it", async () => {
			const head = await opened();
			seedProposal(
				s,
				"snap_q",
				{ "rules/c.md": "gamma\n" },
				{
					pullRequestState: "QUEUED",
				},
			);
			const order = proposal(s, "snap_q").proposalIntentOrder;
			await observed("MERGED", head);
			expect(await classify()).toEqual({ outcome: "done" });
			expect(await work()).toEqual({
				kind: "rehome",
				snapshotIds: ["snap_q"],
			});
			const moved = await rehomeBranchProposals({
				...ids(),
				snapshotIds: ["snap_q"],
			});
			const target = proposal(s, "snap_q").proposalBranchId as string;
			expect(moved).toEqual({ moved: 1, wakeBranchIds: [target] });
			expect(target).not.toBe(BRANCH_ID);
			expect(proposal(s, "snap_q")).toMatchObject({
				pullRequestState: "QUEUED",
				proposalAssignment: 2,
				proposalIntentOrder: order,
			});
			expect(h.wake).toHaveBeenCalledWith(
				{ branchId: target, projectId: PROJECT, organizationId: ORG },
				expect.anything(),
			);
			expect((await work()).kind).toBe("idle");
		});

		it("a proposal the transfer will not move is blocked CONFIGURATION_CHANGED, so the loop never offers it again", async () => {
			const head = await opened();
			seedProposal(
				s,
				"snap_q",
				{ "rules/c.md": "gamma\n" },
				{
					pullRequestState: "QUEUED",
				},
			);
			await observed("MERGED", head);
			await classify();
			s.fake.state.transferAnswers.set("snap_q", "not_joinable");
			expect(
				await rehomeBranchProposals({
					...ids(),
					snapshotIds: ["snap_q"],
				}),
			).toEqual({ moved: 0, wakeBranchIds: [] });
			expect(proposal(s, "snap_q")).toMatchObject({
				pullRequestState: "BLOCKED",
				proposalBranchId: BRANCH_ID,
				pullRequestFailure: expect.objectContaining({
					code: "CONFIGURATION_CHANGED",
					phase: "admission",
					retryable: false,
				}),
			});
			expect((await work()).kind).toBe("idle");
			expect(h.wake).not.toHaveBeenCalled();
		});
	});

	// -----------------------------------------------------------------------
	// Close and deletion (spec §6.7, Review Focus 2)
	// -----------------------------------------------------------------------

	describe("settleBranch: Close", () => {
		it("closes the open pull request, deletes what Fabric alone made, and records CLOSED to classify", async () => {
			const head = await opened();
			h.adapter.get.mockResolvedValueOnce(observation("OPEN", head));
			h.adapter.get.mockResolvedValue(observation("CLOSED", head));
			requestClose();
			const order: string[] = [];
			h.beforeDelete = () => order.push("delete");
			h.adapter.close.mockImplementationOnce(async () => {
				order.push("close");
				return observation("CLOSED", head);
			});
			expect(await settle()).toEqual({ outcome: "closed" });
			expect(order).toEqual(["close", "delete"]);
			expect(h.origin.refSha(refFor(1))).toBeNull();
			expect(branch(s)).toMatchObject({
				state: "CLOSED",
				closeIntent: "WITHDRAW",
				settledAt: s.fake.state.now,
				settlementPhase: "recorded",
				deletedAt: s.fake.state.now,
				confirmationDueAt: new Date(
					s.fake.state.now.getTime() + HOUR_MS,
				),
				membership: expect.objectContaining({ status: "pending" }),
			});
			// The withdrawn change was in the pull request: Decision 14 decides.
			expect(await work()).toMatchObject({ kind: "classify" });
			prHead(head);
			h.adapter.pullRequestHeadRef.mockReturnValue(PR_HEAD_REF);
			expect(await classify()).toEqual({ outcome: "done" });
			expect(proposal(s, "snap_p1").pullRequestState).toBe("CLOSED");
			expect((await work()).kind).toBe("idle");
			expect(h.wake).not.toHaveBeenCalled();
		});

		it("Azure DevOps (no head ref): a close that deletes the branch still classifies at once", async () => {
			const head = await opened();
			h.adapter.get.mockResolvedValueOnce(observation("OPEN", head));
			h.adapter.get.mockResolvedValue(observation("CLOSED", head));
			h.adapter.close.mockResolvedValueOnce(observation("CLOSED", head));
			requestClose();
			expect(await settle()).toEqual({ outcome: "closed" });
			expect(h.origin.refSha(refFor(1))).toBeNull();
			expect(membershipOf("snap_p1")).toEqual(["included"]);
			expect(await work()).toMatchObject({ kind: "classify" });
			expect(await classify()).toEqual({ outcome: "done" });
			expect(proposal(s, "snap_p1").pullRequestState).toBe("CLOSED");
			expect(branch(s).membership).toMatchObject({
				status: "done",
				attempts: 0,
			});
		});

		it("MERGED wins: a pull request merged before the close is recorded MERGED, with no deletion", async () => {
			const head = await opened();
			h.adapter.get.mockResolvedValue(observation("MERGED", head));
			requestClose();
			expect(await settle()).toEqual({ outcome: "merged" });
			expect(h.origin.refSha(refFor(1))).toBe(head);
			expect(branch(s)).toMatchObject({
				state: "MERGED",
				deletedAt: null,
			});
		});

		it("with no pull request: CANCELED, withdrawn proposals CANCELED, a queued one withdrawn by the close, nothing rehomed", async () => {
			seedBranch(s);
			await append("snap_p1", { "rules/a.md": "alpha v2\n" });
			seedProposal(
				s,
				"snap_q",
				{ "rules/c.md": "gamma\n" },
				{
					pullRequestState: "QUEUED",
				},
			);
			requestClose();
			expect(proposal(s, "snap_q").pullRequestState).toBe("CANCELED");
			expect(await settle()).toEqual({ outcome: "canceled" });
			expect(branch(s)).toMatchObject({
				state: "CANCELED",
				deletedAt: s.fake.state.now,
			});
			expect(proposal(s, "snap_p1").pullRequestState).toBe("CANCELED");
			expect((await work()).kind).toBe("idle");
			expect(h.wake).not.toHaveBeenCalled();
		});

		it("with no pull request: a withdrawal that carried a move from uploads ends the move (Fizzy #2878 §9)", async () => {
			seedBranch(s);
			await append("snap_p1", { "rules/a.md": "alpha v2\n" });
			s.fake.state.settings = {
				sourceOfTruth: "UPLOAD",
				migration: {
					v: 1,
					state: "PROPOSING",
					branchId: BRANCH_ID,
					snapshotId: "snap_p1",
					syncId: "sync_move_example",
					pullRequestUrl: null,
					startedAt: "2026-09-26T12:00:00.000Z",
					userId: "user_example",
				},
			};
			requestClose();

			expect(await settle()).toEqual({ outcome: "canceled" });

			expect(
				s.fake.state.trace.filter((entry) =>
					entry.startsWith("migration:"),
				),
			).toEqual(["migration:abandon:sync_move_example:canceled"]);
		});

		it("with no pull request: a withdrawal of a branch that carries no move leaves moves alone", async () => {
			seedBranch(s);
			await append("snap_p1", { "rules/a.md": "alpha v2\n" });
			requestClose();

			expect(await settle()).toEqual({ outcome: "canceled" });

			expect(
				s.fake.state.trace.filter((entry) =>
					entry.startsWith("migration:"),
				),
			).toEqual([]);
		});

		it.each([
			[
				"an observed operation (no deletion authority)",
				() => {
					Object.assign(opsOf(s, "snap_p1")[0] as object, {
						outcome: "observed",
					});
				},
			],
			[
				"a foreign tip ever seen",
				() => {
					branch(s).foreignTipAt = new Date(s.fake.state.now);
				},
			],
			[
				"a tip that is not headSha",
				() => {
					const hand = h.origin.commit({
						parents: [tip()],
						changes: { "CLAUDE.md": "# Hand\n" },
					});
					h.origin.setRef(refFor(1), hand);
				},
			],
		])("keeps the ref on %s, and still settles", async (_name, arrange) => {
			seedBranch(s);
			await append("snap_p1", { "rules/a.md": "alpha v2\n" });
			arrange();
			const before = tip();
			requestClose();
			expect(await settle()).toEqual({ outcome: "canceled" });
			expect(h.origin.refSha(refFor(1))).toBe(before);
			expect(branch(s)).toMatchObject({
				state: "CANCELED",
				deletedAt: null,
			});
		});

		it("a lookup that cannot answer is failure-only with a backoff, the branch still CLOSE_REQUESTED", async () => {
			seedBranch(s);
			await append("snap_p1", { "rules/a.md": "alpha v2\n" });
			requestClose();
			h.adapter.findOperation.mockResolvedValue({
				kind: "INCONCLUSIVE",
				cause: "transient",
			});
			expect(await settle()).toEqual({ outcome: "retry_later" });
			expect(branch(s)).toMatchObject({
				state: "CLOSE_REQUESTED",
				failure: expect.objectContaining({ phase: "close" }),
			});
			expect(branch(s).nextAttemptAt?.getTime()).toBeGreaterThan(
				s.fake.state.now.getTime(),
			);
			expect(tip()).not.toBeNull();
			expect((await work()).kind).toBe("idle");
		});
	});

	// -----------------------------------------------------------------------
	// Start over (spec §6.7 steps 0-4, Decision 11)
	// -----------------------------------------------------------------------

	describe("settleBranch: Start over", () => {
		it("deletes leased at headSha and rehomes the live proposals, keeping their intent order", async () => {
			const head = await unknownCreate();
			const order = proposal(s, "snap_p1").proposalIntentOrder;
			requestClose("START_OVER");
			const seen: Array<string | null> = [];
			h.beforeDelete = () => seen.push(h.origin.refSha(refFor(1)));
			expect(await settle()).toEqual({ outcome: "rehomed" });
			expect(seen).toEqual([head]);
			expect(h.origin.refSha(refFor(1))).toBeNull();
			expect(branch(s)).toMatchObject({
				state: "CANCELED",
				closeIntent: "START_OVER",
				settlementPhase: "recorded",
				deletedAt: s.fake.state.now,
			});
			const moved = proposal(s, "snap_p1");
			expect(moved).toMatchObject({
				pullRequestState: "QUEUED",
				proposalIntentOrder: order,
				proposalAssignment: 2,
			});
			expect(moved.proposalBranchId).not.toBe(BRANCH_ID);
			expect(h.wake).toHaveBeenCalledWith(
				expect.objectContaining({ branchId: moved.proposalBranchId }),
				expect.anything(),
			);
		});

		it("keeps a move from uploads alive: its proposal is rehomed, not withdrawn (Fizzy #2878 §9)", async () => {
			await unknownCreate();
			s.fake.state.settings = {
				sourceOfTruth: "UPLOAD",
				migration: {
					v: 1,
					state: "PROPOSING",
					branchId: BRANCH_ID,
					snapshotId: "snap_p1",
					syncId: "sync_move_example",
					pullRequestUrl: null,
					startedAt: "2026-09-26T12:00:00.000Z",
					userId: "user_example",
				},
			};
			requestClose("START_OVER");

			expect(await settle()).toEqual({ outcome: "rehomed" });

			expect(
				s.fake.state.trace.filter((entry) =>
					entry.startsWith("migration:"),
				),
			).toEqual([]);
		});

		it("step 0 refuses a hand push nobody observed: START_OVER_REFUSED, foreignTipAt set, ref and proposals untouched", async () => {
			const head = await unknownCreate();
			const hand = h.origin.commit({
				parents: [head],
				changes: { "CLAUDE.md": "# Hand\n" },
			});
			h.origin.setRef(refFor(1), hand);
			requestClose("START_OVER");
			expect(await settle()).toEqual({ outcome: "start_over_refused" });
			expect(h.adapter.findOperation).not.toHaveBeenCalled();
			expect(h.origin.refSha(refFor(1))).toBe(hand);
			expect(branch(s)).toMatchObject({
				state: "BLOCKED",
				closeIntent: null,
				foreignTipAt: s.fake.state.now,
				failure: expect.objectContaining({
					code: "START_OVER_REFUSED",
					retryable: false,
				}),
			});
			expect(proposal(s, "snap_p1")).toMatchObject({
				pullRequestState: "OPEN",
				proposalBranchId: BRANCH_ID,
			});
		});

		it("adopts a pull request the lookup finds: OPEN, the intent cleared, nothing deleted", async () => {
			const head = await unknownCreate();
			h.adapter.findOperation.mockResolvedValue({
				kind: "FOUND",
				value: observation("OPEN", head),
			});
			requestClose("START_OVER");
			expect(await settle()).toEqual({ outcome: "adopted" });
			expect(h.origin.refSha(refFor(1))).toBe(head);
			expect(branch(s)).toMatchObject({
				state: "OPEN",
				closeIntent: null,
				settlementPhase: null,
				pullRequestExternalId: "7",
			});
			expect(proposal(s, "snap_p1").proposalBranchId).toBe(BRANCH_ID);
		});

		it("a hand push between step 0 and the delete: the fresh tip refuses, nothing rehomed", async () => {
			const head = await unknownCreate();
			h.adapter.findOperation.mockImplementation(async () => {
				if (h.origin.refSha(refFor(1)) === head) {
					h.origin.setRef(
						refFor(1),
						h.origin.commit({
							parents: [head],
							changes: { "CLAUDE.md": "# Hand\n" },
						}),
					);
				}
				return { kind: "ABSENT" };
			});
			requestClose("START_OVER");
			expect(await settle()).toEqual({ outcome: "start_over_refused" });
			expect(h.origin.refSha(refFor(1))).not.toBeNull();
			expect(branch(s)).toMatchObject({
				state: "BLOCKED",
				deletedAt: null,
			});
			expect(proposal(s, "snap_p1").proposalBranchId).toBe(BRANCH_ID);
			expect(h.wake).not.toHaveBeenCalled();
		});

		it("a hand push racing the delete itself: the lease refuses, START_OVER_REFUSED, nothing rehomed", async () => {
			const head = await unknownCreate();
			h.beforeDelete = () => {
				h.origin.setRef(
					refFor(1),
					h.origin.commit({
						parents: [head],
						changes: { "CLAUDE.md": "# Hand\n" },
					}),
				);
			};
			requestClose("START_OVER");
			expect(await settle()).toEqual({ outcome: "start_over_refused" });
			expect(h.origin.refSha(refFor(1))).not.toBe(head);
			expect(h.origin.refSha(refFor(1))).not.toBeNull();
			expect(branch(s)).toMatchObject({
				state: "BLOCKED",
				deletedAt: null,
				failure: expect.objectContaining({
					code: "START_OVER_REFUSED",
				}),
			});
			expect(proposal(s, "snap_p1").proposalBranchId).toBe(BRANCH_ID);
		});

		it("resumes at settlementPhase deleted after a crash: steps 0-2 are skipped", async () => {
			await unknownCreate();
			requestClose("START_OVER");
			h.origin.deleteRef(refFor(1));
			branch(s).deletedAt = new Date(s.fake.state.now);
			branch(s).settlementPhase = "deleted";
			expect(await settle()).toEqual({ outcome: "rehomed" });
			expect(h.adapter.findOperation).toHaveBeenCalledTimes(1); // step 3 only
			expect(proposal(s, "snap_p1").proposalBranchId).not.toBe(BRANCH_ID);
		});

		it("a lost delete acknowledgment aborts safely: the ref's absence never stands in for the checkpoint", async () => {
			await unknownCreate();
			requestClose("START_OVER");
			h.origin.deleteRef(refFor(1));
			expect(await settle()).toEqual({ outcome: "start_over_refused" });
			expect(branch(s)).toMatchObject({
				state: "BLOCKED",
				deletedAt: null,
				failure: expect.objectContaining({
					code: "START_OVER_REFUSED",
				}),
			});
			expect(proposal(s, "snap_p1").proposalBranchId).toBe(BRANCH_ID);
		});

		it("the refused restart's card stays: the marker's lookup keeps START_OVER_REFUSED", async () => {
			const head = await unknownCreate();
			h.origin.setRef(
				refFor(1),
				h.origin.commit({
					parents: [head],
					changes: { "CLAUDE.md": "# H\n" },
				}),
			);
			requestClose("START_OVER");
			await settle();
			expect(await work()).toEqual({ kind: "lookup" });
			expect(await lookupBranchPullRequest(ids())).toEqual({
				outcome: "absent",
			});
			expect(branch(s)).toMatchObject({
				failure: expect.objectContaining({
					code: "START_OVER_REFUSED",
				}),
				nextAttemptAt: new Date(s.fake.state.now.getTime() + HOUR_MS),
			});
		});
	});

	// -----------------------------------------------------------------------
	// The loop's precedence around an outstanding create marker
	// -----------------------------------------------------------------------

	it("an outstanding create marker never delays close, Start over, Retry opening or a confirmation", async () => {
		await unknownCreate();
		const b = branch(s);
		requestClose("START_OVER");
		expect(await work()).toEqual({ kind: "close" });
		b.state = "BLOCKED";
		b.closeIntent = null;
		b.failure = {
			phase: "create",
			code: "PR_CREATION_REFUSED",
			retryable: false,
			at: s.fake.state.now.toISOString(),
			params: {},
		};
		b.retryRequestedAt = new Date(s.fake.state.now);
		expect(await work()).toEqual({ kind: "retry" });
		b.retryRequestedAt = null;
		b.state = "CANCELED";
		b.settledAt = new Date(s.fake.state.now.getTime() - HOUR_MS);
		b.confirmationDueAt = new Date(s.fake.state.now);
		expect(await work()).toEqual({ kind: "confirm" });
		expect(b.createIssuedAt).not.toBeNull();
	});

	// -----------------------------------------------------------------------
	// Confirmations (spec §6.7 step 4)
	// -----------------------------------------------------------------------

	it("confirmations at 1 h and 24 h close a late pull request on the ref, then clear the marker", async () => {
		seedBranch(s);
		await append("snap_p1", { "rules/a.md": "alpha v2\n" });
		branch(s).createIssuedAt = new Date(s.fake.state.now);
		requestClose();
		expect(await settle()).toEqual({ outcome: "canceled" });
		const settledAt = branch(s).settledAt as Date;
		expect(await confirm()).toEqual({ outcome: "not_due" });

		later(HOUR_MS);
		expect(await work()).toEqual({ kind: "confirm" });
		const late = observation("OPEN", "d".repeat(40), "9");
		h.adapter.findOperation.mockResolvedValueOnce({
			kind: "FOUND",
			value: late,
		});
		h.adapter.close.mockResolvedValueOnce({ ...late, state: "CLOSED" });
		expect(await confirm()).toEqual({ outcome: "confirmed" });
		expect(h.adapter.close).toHaveBeenCalledWith(
			expect.objectContaining({ externalId: "9" }),
		);
		expect(branch(s)).toMatchObject({
			state: "CLOSED",
			confirmations: 1,
			pullRequestExternalId: "9",
			confirmationDueAt: new Date(settledAt.getTime() + 24 * HOUR_MS),
			membership: expect.objectContaining({ status: "pending" }),
		});

		later(23 * HOUR_MS);
		expect(await confirm()).toEqual({ outcome: "confirmed" });
		expect(branch(s)).toMatchObject({
			confirmations: 2,
			confirmationDueAt: null,
			createIssuedAt: null,
		});
	});

	it("a late pull request closed by an attempt that died before recording: the retry finds it closed, the branch still becomes CLOSED and is classified", async () => {
		seedBranch(s);
		const head = await append("snap_p1", { "rules/a.md": "alpha v2\n" });
		requestClose();
		expect(await settle()).toEqual({ outcome: "canceled" });
		later(HOUR_MS);
		const late = observation("OPEN", head, "9");
		h.adapter.findOperation.mockResolvedValueOnce({
			kind: "FOUND",
			value: late,
		});
		h.adapter.close.mockResolvedValueOnce({ ...late, state: "CLOSED" });
		// The provider closed it; the attempt then dies before its recording
		// commits, so the activity fails with nothing written.
		const lost = vi
			.spyOn(h.fake.module, "recordBranchConfirmation")
			.mockRejectedValueOnce(new Error("connection lost"));
		await expect(confirm()).rejects.toThrow();
		expect(lost).toHaveBeenCalledTimes(1);
		lost.mockRestore();
		expect(h.adapter.close).toHaveBeenCalledTimes(1);
		expect(branch(s)).toMatchObject({
			state: "CANCELED",
			confirmations: 0,
		});

		// Temporal's retry: the lookup now answers the pull request CLOSED.
		h.adapter.findOperation.mockResolvedValueOnce({
			kind: "FOUND",
			value: { ...late, state: "CLOSED" },
		});
		expect(await confirm()).toEqual({ outcome: "confirmed" });
		expect(h.adapter.close).toHaveBeenCalledTimes(1);
		expect(branch(s)).toMatchObject({
			state: "CLOSED",
			confirmations: 1,
			pullRequestExternalId: "9",
			membership: expect.objectContaining({ status: "pending" }),
		});
		expect(reconciled().at(-1)?.metadata).toMatchObject({
			outcome: "closed",
			externalId: "9",
		});

		// Exact membership classification runs on the pull request's history.
		expect(await work()).toMatchObject({ kind: "classify" });
		prHead(head);
		h.adapter.pullRequestHeadRef.mockReturnValue(PR_HEAD_REF);
		expect(await classify()).toEqual({ outcome: "done" });
		expect(membershipOf("snap_p1")).toEqual(["included"]);
		expect(branch(s).membership).toMatchObject({ status: "done" });
	});

	it("a confirmation that cannot look moves only its due time", async () => {
		seedBranch(s);
		await append("snap_p1", { "rules/a.md": "alpha v2\n" });
		requestClose();
		await settle();
		later(HOUR_MS);
		h.adapter.findOperation.mockResolvedValueOnce({
			kind: "INCONCLUSIVE",
			cause: "transient",
		});
		expect(await confirm()).toEqual({ outcome: "deferred" });
		expect(branch(s)).toMatchObject({
			confirmations: 0,
			confirmationDueAt: new Date(
				s.fake.state.now.getTime() + 15 * MINUTE_MS,
			),
		});
	});

	// -----------------------------------------------------------------------
	// Merge sync (spec §6.6, #2563 §9.1)
	// -----------------------------------------------------------------------

	describe("dispatchBranchMergeSync", () => {
		function retainMigrationImport(): void {
			s.fake.state.settings = {
				sourceOfTruth: "REPOSITORY",
				migration: {
					v: 1,
					state: "SWITCHING",
					branchId: "branch_move",
					snapshotId: "snap_move",
					syncId: SYNC,
					pullRequestUrl: null,
					startedAt: "2026-10-03T10:00:00.000Z",
					userId: "user_example",
				},
			};
		}

		async function mergedAndClassified(): Promise<void> {
			const head = await opened();
			await observed("MERGED", head);
			expect(await classify()).toEqual({ outcome: "done" });
			expect(branch(s).mergeSyncRequestedAt).not.toBeNull();
		}

		it("dispatches the current tuple once, then acknowledges a consuming receipt", async () => {
			retainMigrationImport();
			await mergedAndClassified();
			expect(await dispatchBranchMergeSync(ids())).toEqual({
				outcome: "dispatched",
			});
			expect(h.startSync).toHaveBeenCalledWith({
				projectId: PROJECT,
				organizationId: ORG,
				trigger: "PULL_REQUEST_MERGED",
				expected: { syncId: SYNC, generation: 1 },
			});
			expect(branch(s)).toMatchObject({
				mergeSyncRunId: "run_example_1",
				mergeSyncExpected: { syncId: SYNC, generation: 1 },
			});
			s.fake.state.syncRuns.push({
				id: "sync_run_1",
				runId: "run_example_1",
				projectId: PROJECT,
				syncId: SYNC,
				generation: 1,
				trigger: "PULL_REQUEST_MERGED",
				startedAt: new Date(s.fake.state.now),
				status: "SUCCEEDED",
				error: null,
			});
			expect(await dispatchBranchMergeSync(ids())).toEqual({
				outcome: "acknowledged",
			});
			expect(branch(s).mergeSyncRequestedAt).toBeNull();
			expect(h.startSync).toHaveBeenCalledTimes(1);
			expect(
				s.fake.state.audits.filter(
					(a) =>
						a.action ===
						"project.instructions.pull_request_merge_sync_requested",
				),
			).toEqual([
				expect.objectContaining({
					metadata: { branchId: BRANCH_ID, syncRunKey: "sync_run_1" },
				}),
			]);
		});

		it("acknowledges an admitted branch in direct mode without a legacy import", async () => {
			await mergedAndClassified();

			expect(await dispatchBranchMergeSync(ids())).toEqual({
				outcome: "acknowledged",
			});
			expect(h.startSync).not.toHaveBeenCalled();
			expect(branch(s).mergeSyncRequestedAt).toBeNull();
			expect(s.fake.state.audits).toContainEqual(
				expect.objectContaining({
					action: "project.instructions.pull_request_merge_observed",
					metadata: expect.objectContaining({ readState: "DIRECT" }),
				}),
			);
		});

		it.each([
			[
				"CONFIGURATION_CHANGED when the destination changed",
				"CONFIGURATION_CHANGED",
				() => {
					(s.fake.state.sync as { ref: string }).ref = "develop";
				},
			],
			[
				"MERGE_SYNC_FAILED 24 h after the request",
				"MERGE_SYNC_FAILED",
				() => later(24 * HOUR_MS),
			],
		])("gives up %s, dispatching nothing", async (_name, code, arrange) => {
			await mergedAndClassified();
			arrange();
			expect(await dispatchBranchMergeSync(ids())).toEqual({
				outcome: "gave_up",
			});
			expect(branch(s)).toMatchObject({
				mergeSyncRequestedAt: null,
				failure: expect.objectContaining({
					phase: "merge_sync",
					code,
					retryable: false,
				}),
			});
			expect(h.startSync).not.toHaveBeenCalled();
		});

		it("does nothing for a branch without a request", async () => {
			const head = await opened();
			await observed("CLOSED", head);
			await classify();
			expect(await dispatchBranchMergeSync(ids())).toEqual({
				outcome: "idle",
			});
		});
	});
});
