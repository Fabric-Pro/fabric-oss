/**
 * Seeds one member, one project, one repository and one member branch into
 * the fake query layer (`instruction-branch-fake-db.ts`), with snapshot
 * files whose bytes live in a fake storage map, for the member proposal
 * branch activity tests. Every identifier is synthetic.
 */
import { createHash } from "node:crypto";
import { memberBranchRef } from "@repo/instructions/proposal-branch-ref";
import type {
	FakeBranch,
	FakeDatabase,
	FakeFile,
	FakeProposal,
} from "./instruction-branch-fake-db";
import type { Origin } from "./instruction-branch-origin";

export const ORG = "org_example";
export const PROJECT = "proj_example";
export const USER = "user_example_member";
export const MEMBER_NAME = "Example Member";
export const INTEGRATION = "int_example";
export const SYNC = "sync_example";
export const REPOSITORY_KEY = "GITHUB:example-org/example-repo";
export const BRANCH_ID = "branch_example";
const NOREPLY = ["noreply", "example.com"].join("@");
const REPOSITORY = {
	provider: "GITHUB" as const,
	owner: "example-org",
	repo: "example-repo",
};

/** The files `main` holds at the base commit. */
export const BASE_FILES = {
	"CLAUDE.md": "# Example rules\n",
	"rules/a.md": "alpha\n",
	"rules/b.md": "beta\n",
	"scripts/run.sh": "#!/bin/sh\necho run\n",
};

export const refFor = (n: number) =>
	memberBranchRef({ displayName: MEMBER_NAME, userId: USER, n });

const sha256 = (content: string) =>
	createHash("sha256").update(Buffer.from(content)).digest("hex");

export type Scenario = {
	fake: FakeDatabase;
	origin: Origin;
	storage: Map<string, Buffer>;
};

/** The published snapshot's files: `BASE_FILES`, `run.sh` recorded 0755. */
export function seedBase(s: Scenario): void {
	seedFiles(s, "snap_base", BASE_FILES);
}

/** A snapshot's file rows, with their bytes in storage. */
export function seedFiles(
	s: Scenario,
	snapshotId: string,
	files: Record<string, string>,
): FakeFile[] {
	const rows = Object.entries(files).map(([path, content]) => {
		const storageKey = `instructions/${snapshotId}/${path}`;
		s.storage.set(storageKey, Buffer.from(content));
		return {
			path,
			sha256: sha256(content),
			mode: content.startsWith("#!") ? 0o755 : null,
			storageKey,
		};
	});
	s.fake.state.files.set(snapshotId, rows);
	return rows;
}

export function seedWorld(s: Scenario): void {
	const { state } = s.fake;
	state.userNames.set(USER, MEMBER_NAME);
	state.sync = {
		id: SYNC,
		projectId: PROJECT,
		organizationId: ORG,
		userId: USER,
		repositoryIntegrationId: INTEGRATION,
		ref: "main",
		rootPath: "",
		automatic: true,
		generation: 1,
		automaticPausedReason: null,
		allowReaderProposals: false,
		repositoryIntegration: {
			id: INTEGRATION,
			projectId: PROJECT,
			status: "ACTIVE",
			provider: "GITHUB",
			repositoryUrl: "https://github.com/example-org/example-repo",
		},
	};
	seedBase(s);
}

export function destination() {
	return {
		integrationId: INTEGRATION,
		syncId: SYNC,
		repositoryKey: REPOSITORY_KEY,
		provider: "GITHUB" as const,
		repository: REPOSITORY,
		targetRef: "main",
		rootPath: "",
	};
}

export function seedBranch(
	s: Scenario,
	over: Partial<FakeBranch> = {},
): FakeBranch {
	const now = s.fake.state.now;
	const branch: FakeBranch = {
		id: BRANCH_ID,
		organizationId: ORG,
		projectId: PROJECT,
		userId: USER,
		repositoryKey: REPOSITORY_KEY,
		number: 1,
		ref: refFor(1),
		state: "PENDING",
		attempt: 1,
		destination: destination(),
		presentation: {
			title: `Coding instruction changes from ${MEMBER_NAME}`,
			body: "body",
		},
		startSha: null,
		headSha: null,
		foreignTipAt: null,
		nextSequence: 1,
		nextExecutionSeq: 1,
		headExecutionSeq: 0,
		factsRevision: 0,
		closeIntent: null,
		createIssuedAt: null,
		pullRequestUrl: null,
		pullRequestExternalId: null,
		pullRequestObservation: null,
		membership: null,
		failure: null,
		lastCheckedAt: null,
		nextAttemptAt: null,
		refreshAdmittedAt: null,
		settledAt: null,
		confirmations: 0,
		confirmationDueAt: null,
		mergeSyncRequestedAt: null,
		mergeSyncDispatchedAt: null,
		mergeSyncRunId: null,
		mergeSyncExpected: null,
		retiredAt: null,
		retiredReason: null,
		retryRequestedAt: null,
		untracked: false,
		settlementPhase: null,
		deletedAt: null,
		createdAt: now,
		updatedAt: now,
		...over,
	};
	s.fake.state.branches.set(branch.id, branch);
	s.fake.state.reservations.push({
		repositoryKey: REPOSITORY_KEY,
		ref: branch.ref,
		branchId: branch.id,
		status: "current",
	});
	return branch;
}

let sequence = 0;

/**
 * A claimed (OPENING) v2 proposal on the branch: the published files with
 * `changes` applied (`null` deletes a file).
 */
export function seedProposal(
	s: Scenario,
	id: string,
	changes: Record<string, string | null>,
	over: Partial<FakeProposal> = {},
): FakeProposal {
	const files: Record<string, string> = { ...BASE_FILES };
	for (const [path, content] of Object.entries(changes)) {
		if (content === null) {
			delete files[path as keyof typeof files];
		} else {
			files[path] = content;
		}
	}
	seedFiles(s, id, files);
	sequence++;
	const proposal: FakeProposal = {
		id,
		contentKind: "FULL_SNAPSHOT",
		projectId: PROJECT,
		organizationId: ORG,
		userId: USER,
		version: sequence,
		status: "READY",
		proposalStatus: "PENDING",
		proposalDestination: "REPOSITORY",
		pullRequestOperationId: `pr_op_${id}`,
		pullRequestState: "OPENING",
		pullRequestAttempt: 1,
		pullRequestContext: {
			v: 2,
			integrationId: INTEGRATION,
			syncId: SYNC,
			syncGeneration: 1,
			provider: "GITHUB",
			targetRef: "main",
			rootPath: "",
			baseCommitSha: s.origin.base,
			repository: REPOSITORY,
			author: { name: MEMBER_NAME, email: NOREPLY },
			committer: { name: "Fabric", email: NOREPLY },
			message: `Update rules (${id})`,
			committedAt: "2026-09-26T10:00:00Z",
		},
		pullRequestFailure: null,
		pullRequestNextAttemptAt: null,
		proposalBranchId: BRANCH_ID,
		proposalBranchSequence: sequence,
		proposalAssignment: 1,
		proposalIntentOrder: BigInt(sequence * 10),
		withdrawRequestedAt: null,
		withdrawScope: null,
		pendingCommand: null,
		pendingCommandSeq: null,
		baseSnapshotId: "snap_base",
		...over,
	};
	s.fake.state.proposals.set(id, proposal);
	return proposal;
}

/** What the loop hands the append: the ids and the attempts claimed. */
export function appendInput(s: Scenario, snapshotId: string) {
	const p = s.fake.state.proposals.get(snapshotId) as FakeProposal;
	const b = s.fake.state.branches.get(BRANCH_ID) as FakeBranch;
	return {
		branchId: BRANCH_ID,
		organizationId: ORG,
		snapshotId,
		proposalAttempt: p.pullRequestAttempt,
		branchAttempt: b.attempt,
	};
}

/** A member's Try again, as the procedure then the claim leave the row. */
export function tryAgain(s: Scenario, snapshotId: string, intentOrder: bigint) {
	const p = s.fake.state.proposals.get(snapshotId) as FakeProposal;
	const b = s.fake.state.branches.get(BRANCH_ID) as FakeBranch;
	p.pullRequestState = "OPENING";
	p.pullRequestAttempt += 2;
	p.pullRequestFailure = null;
	p.pullRequestNextAttemptAt = null;
	p.proposalIntentOrder = intentOrder;
	p.pendingCommand = "APPEND";
	p.pendingCommandSeq = b.nextExecutionSeq;
}

/** A member's withdrawal of an appended change (spec §6.8 "Request"). */
export function withdraw(
	s: Scenario,
	snapshotId: string,
	scope: "change" | "branch" = "change",
) {
	const p = s.fake.state.proposals.get(snapshotId) as FakeProposal;
	const b = s.fake.state.branches.get(BRANCH_ID) as FakeBranch;
	p.pullRequestState = "CLOSE_REQUESTED";
	p.pullRequestAttempt += 1;
	p.withdrawRequestedAt = new Date(s.fake.state.now);
	p.withdrawScope = scope;
	p.pendingCommand = "WITHDRAW";
	p.pendingCommandSeq = b.nextExecutionSeq;
}

export function branch(s: Scenario): FakeBranch {
	return s.fake.state.branches.get(BRANCH_ID) as FakeBranch;
}

export function proposal(s: Scenario, id: string): FakeProposal {
	return s.fake.state.proposals.get(id) as FakeProposal;
}

export function opsOf(s: Scenario, snapshotId: string) {
	return s.fake.state.ops.filter((op) => op.snapshotId === snapshotId);
}
