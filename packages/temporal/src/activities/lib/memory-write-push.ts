/**
 * The git half of a Living Memory write (ADR-022): given a workspace cloned at
 * the sync's branch, the staged files hashed into it and the rendered commit
 * text, land the write on the repository or say why not.
 *
 * DIRECT_PUSH commits to the synced branch itself. Each pass fetches the tip,
 * first looks for a commit of this write already on it (an earlier attempt that
 * pushed and lost the acknowledgement is found and settled, never pushed
 * twice), plans the batch against the tip (`planMemoryWriteAgainstTip`: every
 * path or none), builds one commit on it, re-checks that the write is still
 * allowed and pushes with a lease on the tip. A lost lease redoes the pass on
 * the new tip, up to `MEMORY_WRITE_MAX_PUSH_PASSES` times with a jittered
 * backoff, and then the branch is called busy (a retryable failure). A branch
 * that refuses the push (protection, a hook, no write permission) does not end
 * the write: the commit becomes a pull request, `reason: "protected"`.
 *
 * PULL_REQUEST pushes the commit to a branch of the write's own,
 * `fabric/memory/<writeId>`, create-only behind `assertMemoryWriteBranch`, and
 * opens a pull request from it into the synced branch. A branch that exists
 * already must be this write's (its head carries the write's trailer): then an
 * earlier attempt pushed it, and the pull request is looked up or opened. There
 * is no merge watcher: once the pull request is merged the Living Memory poll
 * or webhook ingests it like any other change.
 *
 * Commits are authored as the member (the display name and the deployment's
 * `noreply@` address) and committed by Fabric, with the write's trailers.
 *
 * Not re-exported from the activities barrel: every export of a module the
 * barrel re-exports becomes a schedulable Temporal activity.
 */
import type { MemoryWriteOutcome } from "../../lib/memory-write/outcome";
import { MEMORY_WRITE_MAX_PUSH_PASSES } from "../../lib/memory-write-types";
import { safeHeartbeat } from "./activity-liveness";
import type { BranchCredential } from "./instruction-branch-credential";
import { fetchSyncedTip, pushToSyncedRef } from "./instruction-branch-git";
import { commitDate } from "./instruction-branch-support";
import {
	assertMayContinue,
	ProposalStepFailure,
} from "./instruction-proposal-boundary";
import { buildBranchCommit } from "./instruction-proposal-commit";
import { gitCall } from "./instruction-proposal-operation";
import {
	endsWithOwnWriteTrailer,
	fetchMemoryWriteBranchHead,
	findLandedWriteCommit,
	memoryWriteBranch,
	pushMemoryWriteBranch,
	readCommitMessage,
} from "./memory-write-git";
import {
	type HashedWriteEntry,
	planMemoryWriteAgainstTip,
} from "./memory-write-plan";
import {
	openMemoryWritePullRequest,
	renderMemoryWritePullRequest,
} from "./memory-write-pull-request";

/** The first delay between direct-push passes, before jitter; it doubles each pass. */
const PUSH_BACKOFF_BASE_MS = 100;

/**
 * The write is no longer allowed: the live checks that run immediately before
 * a push refused it. Carries the REFUSED outcome the write ends with.
 */
export class MemoryWriteRefused extends Error {
	readonly outcome: Extract<MemoryWriteOutcome, { status: "REFUSED" }>;

	constructor(
		code: Extract<MemoryWriteOutcome, { status: "REFUSED" }>["code"],
	) {
		super(`A memory write was refused (${code})`);
		this.name = "MemoryWriteRefused";
		this.outcome = { status: "REFUSED", code };
	}
}

/** Everything the git half needs, resolved by the caller. */
export type MemoryWritePushContext = {
	credential: BranchCredential;
	write: {
		id: string;
		/** The synced branch. */
		ref: string;
		mode: "PULL_REQUEST" | "DIRECT_PUSH";
		createdAt: Date;
	};
	text: {
		author: { name: string; email: string };
		committer: { name: string; email: string };
		subject: string;
		body: string;
		/** The message and the trailers, ending in a newline. */
		commitMessage: string;
	};
	/** The write's paths, their blobs already hashed into the workspace. */
	entries: readonly HashedWriteEntry[];
	/** The sync's selected path the write folder sits in. */
	selected: string;
	/** The member's left-out paths, as they stand now. */
	leftOut: readonly string[];
	/** Throws `MemoryWriteRefused` when the write may no longer go on; called immediately before a push. */
	assertStillAllowed: () => Promise<void>;
	/** Tests only: the first backoff delay, before jitter. */
	backoffBaseMs?: number;
};

const fail = (
	code: ProposalStepFailure["code"],
	retryable: boolean,
	phase: ProposalStepFailure["phase"],
) => new ProposalStepFailure({ code, phase, retryable });

/** A pause that ends early when the attempt is cancelled. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}

/** Between 50% and 150% of `base * 2^pass`: competing writers do not retry in step. */
function jitteredBackoffMs(base: number, pass: number): number {
	return Math.round(base * 2 ** pass * (0.5 + Math.random()));
}

function git(credential: BranchCredential) {
	return {
		dir: credential.workDir,
		env: credential.env,
		signal: credential.signal,
	};
}

type Built =
	| { kind: "built"; sha: string }
	| { kind: "outcome"; outcome: MemoryWriteOutcome };

/** Plans the batch against `tip` and builds one commit on it, or says why not. */
async function buildOnTip(
	ctx: MemoryWritePushContext,
	tip: string,
): Promise<Built> {
	const { credential } = ctx;
	const plan = await gitCall("append", credential, () =>
		planMemoryWriteAgainstTip({
			...git(credential),
			tip,
			selected: ctx.selected,
			leftOut: ctx.leftOut,
			entries: ctx.entries,
		}),
	);
	if (plan.kind === "outcome") {
		return plan;
	}
	const built = await gitCall("append", credential, () =>
		buildBranchCommit({
			...git(credential),
			parent: tip,
			plan: plan.entries,
			author: ctx.text.author,
			committer: ctx.text.committer,
			message: ctx.text.commitMessage,
			date: commitDate(new Date()),
		}),
	);
	if (!built.ok) {
		throw fail("GIT_FAILED", false, "append");
	}
	return { kind: "built", sha: built.sha };
}

async function fetchTip(ctx: MemoryWritePushContext): Promise<string> {
	const { credential } = ctx;
	const fetched = await gitCall("append", credential, () =>
		fetchSyncedTip({
			...git(credential),
			branch: ctx.write.ref,
			allowedRef: ctx.write.ref,
		}),
	);
	if (fetched.kind === "absent") {
		throw fail("TARGET_BRANCH_MISSING", false, "append");
	}
	return fetched.sha;
}

const committed = (
	ctx: MemoryWritePushContext,
	sha: string,
): MemoryWriteOutcome => ({
	status: "COMMITTED",
	sha,
	ref: ctx.write.ref,
	fileCount: ctx.entries.length,
});

/**
 * Lands the write on the repository: a commit on the synced branch
 * (DIRECT_PUSH) or a pull request into it (PULL_REQUEST, or a direct push the
 * branch refused). Never writes the receipt; the caller records the outcome.
 */
export async function pushMemoryWrite(
	ctx: MemoryWritePushContext,
): Promise<MemoryWriteOutcome> {
	return ctx.write.mode === "DIRECT_PUSH"
		? directPush(ctx)
		: viaPullRequest(ctx, { reason: "configured" });
}

async function directPush(
	ctx: MemoryWritePushContext,
): Promise<MemoryWriteOutcome> {
	const { credential } = ctx;
	// A commit cannot predate the write's admission: the search for an earlier
	// attempt's commit starts a minute before it, for clock skew.
	const since = new Date(ctx.write.createdAt.getTime() - 60_000);
	for (let pass = 0; pass < MEMORY_WRITE_MAX_PUSH_PASSES; pass++) {
		safeHeartbeat();
		assertMayContinue(credential.signal);
		const tip = await fetchTip(ctx);

		const landed = await gitCall("append", credential, () =>
			findLandedWriteCommit({
				...git(credential),
				tip,
				writeId: ctx.write.id,
				since,
			}),
		);
		if (landed !== null) {
			return committed(ctx, landed);
		}

		const built = await buildOnTip(ctx, tip);
		if (built.kind === "outcome") {
			return built.outcome;
		}
		safeHeartbeat();

		await ctx.assertStillAllowed();
		assertMayContinue(credential.signal);

		const pushed = await gitCall("push", credential, () =>
			pushToSyncedRef({
				...git(credential),
				parentSha: tip,
				sha: built.sha,
				branch: ctx.write.ref,
				allowedRef: ctx.write.ref,
			}),
		);
		if (pushed.kind === "pushed") {
			return committed(ctx, built.sha);
		}
		if (pushed.kind === "refused") {
			return viaPullRequest(ctx, {
				reason: "protected",
				commit: built.sha,
			});
		}
		// `stale`: the tip moved under the lease. Start again on the new one,
		// after a jittered pause so competing writers do not collide in step.
		if (pass < MEMORY_WRITE_MAX_PUSH_PASSES - 1) {
			await pause(
				jitteredBackoffMs(
					ctx.backoffBaseMs ?? PUSH_BACKOFF_BASE_MS,
					pass,
				),
				credential.signal,
			);
		}
	}
	return { status: "FAILED", code: "BRANCH_BUSY", retryable: true };
}

async function viaPullRequest(
	ctx: MemoryWritePushContext,
	via: { reason: "configured" | "protected"; commit?: string },
): Promise<MemoryWriteOutcome> {
	const { credential } = ctx;
	const branch = memoryWriteBranch(ctx.write.id);
	safeHeartbeat();

	// A branch an earlier attempt pushed is this write's own, recognised by
	// its trailer; any other commit on the name is somebody else's.
	const ownBranchHead = async (): Promise<string | null> => {
		const head = await gitCall("create", credential, () =>
			fetchMemoryWriteBranchHead({ ...git(credential), branch }),
		);
		if (head.kind === "absent") {
			return null;
		}
		const message = await gitCall("create", credential, () =>
			readCommitMessage({ ...git(credential), sha: head.sha }),
		);
		if (!endsWithOwnWriteTrailer(message, ctx.write.id)) {
			throw fail("BRANCH_NAME_UNAVAILABLE", false, "create");
		}
		return head.sha;
	};

	let sha = await ownBranchHead();
	if (sha === null) {
		const built =
			via.commit === undefined
				? await buildOnTip(ctx, await fetchTip(ctx))
				: ({ kind: "built", sha: via.commit } as const);
		if (built.kind === "outcome") {
			return built.outcome;
		}
		const commit = built.sha;
		await ctx.assertStillAllowed();
		assertMayContinue(credential.signal);

		const pushed = await gitCall("push", credential, () =>
			pushMemoryWriteBranch({ ...git(credential), sha: commit, branch }),
		);
		if (pushed.kind === "refused") {
			throw fail("BRANCH_WRITE_REFUSED", false, "push");
		}
		// `exists`: an attempt of this write pushed it between the look above
		// and this push. It is this write's, or the name is taken.
		sha = pushed.kind === "created" ? commit : await ownBranchHead();
		if (sha === null) {
			throw fail("BRANCH_NAME_UNAVAILABLE", false, "create");
		}
	}

	const text = renderMemoryWritePullRequest({
		subject: ctx.text.subject,
		body: ctx.text.body,
		authorName: ctx.text.author.name,
		files: ctx.entries,
	});
	const pullRequest = await openMemoryWritePullRequest({
		credential,
		sourceRef: branch,
		targetRef: ctx.write.ref,
		title: text.title,
		body: text.body,
	});
	return {
		status: "PULL_REQUEST",
		sha,
		ref: ctx.write.ref,
		branch,
		url: pullRequest.url,
		externalId: pullRequest.externalId,
		reason: via.reason,
		fileCount: ctx.entries.length,
	};
}
