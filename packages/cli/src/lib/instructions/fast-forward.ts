/**
 * Whether the session hook may fast-forward a checkout, what happened when it
 * tried, and the lines each result prints (Fizzy #2878). Pure: nothing here
 * runs git or touches the disk, so every rule is a table a test can read.
 *
 * The hook fast-forwards a repository-sourced project's checkout when that is
 * safe, to the tip of the branch the project follows: git is the authority on
 * where that is, Fabric's published copy only mirrors it. "Safe" is a gate over
 * facts the checkout already reports plus a few the write itself needs: the
 * right branch, tracking the right upstream, no operation in
 * progress, nothing else writing, nobody else holding the branch. Anything
 * else leaves the checkout exactly as it was and says so once.
 *
 * `FfOutcome` is the closed set of results. Each has one fixed line and one
 * next action in `outcome.ts`; none carries a URL or any of git's own words.
 * An abandoned lock carries its local path so its owner can recover it
 * explicitly.
 */
import type { PublishedInstructionRepositorySync } from "@fabricorg/sdk";
import type { CheckoutState } from "./checkout.js";
import type {
	FabricLag,
	FastForwardCommands,
	FastForwardFetchFailure,
	FastForwardMergeFailure,
	FastForwardNotSafe,
} from "./outcome.js";
import {
	HOOK_PREFIX,
	isUserActionableMergeFailure,
	outcomeLine,
} from "./outcome.js";

/** The reasons `behind` already has words for: the report line is the line. */
type BehindReason = "wrong-branch" | "detached" | "operation";

export type NotSafeReason = BehindReason | FastForwardNotSafe;

/**
 * Where the hook's budget ran out: reading the checkout before any fetch,
 * the fetch itself, or the local steps (re-reading the checkout, the merge)
 * after a fetch that finished.
 */
export type DeadlineStage = "read" | "fetch" | "merge";

export type FfOutcome =
	| { kind: "fast-forwarded"; from: string; to: string }
	| { kind: "already-current" }
	| { kind: "not-safe"; reason: NotSafeReason }
	| { kind: "fetch-failed"; reason: FastForwardFetchFailure }
	| ({ kind: "merge-failed" } & FastForwardMergeFailure)
	| { kind: "locked" }
	| { kind: "abandoned-lock"; lockPath: string }
	| { kind: "opted-out" }
	| { kind: "deadline"; stage: DeadlineStage };

/** What the gate reads: the checkout's own report plus what the write needs. */
export interface FastForwardFacts {
	/** The branch the project follows. */
	ref: string;
	/** The remote the checkout fetches the repository from. */
	remote: string;
	state: Omit<CheckoutState, "clean">;
	/** The branch's upstream as `<remote>/<branch>`, or `null`. */
	upstream: string | null;
	/** An `index.lock` or `HEAD.lock` exists. */
	lockFiles: boolean;
	/** Another work tree of this repository has the branch checked out. */
	heldElsewhere: boolean;
}

export type Eligibility =
	| { eligible: true }
	| { eligible: false; reason: NotSafeReason };

/**
 * The gate. The order is the order a person would explain it in: an operation
 * first (a rebase detaches HEAD, and "check out the branch" would be the wrong
 * advice in the middle of one), then where HEAD is, what it tracks, what kind
 * of checkout it is, and last whether something else is touching it. A sparse
 * checkout passes. The tree is not asked about: git's own refusal, naming the
 * files, is the check for local changes.
 */
export function fastForwardEligibility(facts: FastForwardFacts): Eligibility {
	const { state, ref, remote } = facts;
	const no = (reason: NotSafeReason): Eligibility => ({
		eligible: false,
		reason,
	});
	if (state.operation !== null) {
		return no("operation");
	}
	if (state.branch === null) {
		return no("detached");
	}
	if (state.branch !== ref) {
		return no("wrong-branch");
	}
	if (state.head === null) {
		return no("no-upstream");
	}
	if (state.traits.shallow) {
		return no("shallow");
	}
	if (state.traits.superproject) {
		return no("submodule");
	}
	if (facts.upstream === null) {
		return no("no-upstream");
	}
	if (facts.upstream !== `${remote}/${ref}`) {
		return no("upstream-mismatch");
	}
	if (facts.lockFiles) {
		return no("git-busy");
	}
	if (facts.heldElsewhere) {
		return no("branch-busy");
	}
	return { eligible: true };
}

/**
 * Why Fabric's published copy is behind HEAD, or `null` when it is not: the
 * published commit is HEAD, or is not in HEAD's history at all (then the
 * report line, not this, says where the checkout stands). The reason is the
 * sync's own state.
 */
export function fabricCopyLag(input: {
	headSha: string | null;
	publishedSha: string | null;
	/** `isAncestor(publishedSha, headSha)`; `null` when git could not say. */
	publishedInHistory: boolean | null;
	sync: PublishedInstructionRepositorySync | undefined;
}): FabricLag | null {
	const { headSha, publishedSha, sync } = input;
	if (
		headSha === null ||
		publishedSha === null ||
		headSha === publishedSha ||
		input.publishedInHistory !== true
	) {
		return null;
	}
	const run = sync?.lastRun;
	if (run?.error === "TREE_REFUSED" || run?.status === "REJECTED") {
		return "refused";
	}
	if (run && run.status === null) {
		return "running";
	}
	if (run?.status === "FAILED") {
		return "failed";
	}
	if (sync && sync.pausedReason !== null) {
		return "paused";
	}
	if (sync && !sync.automatic) {
		return "off";
	}
	return "pending";
}

function isBehindReason(reason: NotSafeReason): reason is BehindReason {
	return (
		reason === "wrong-branch" ||
		reason === "detached" ||
		reason === "operation"
	);
}

export interface FastForwardContext {
	repo: string;
	host: string;
	ref: string;
	remote: string;
	/** The command that gives git credentials for the host. */
	login: string;
	commands: FastForwardCommands;
	/** What `check --hook` would print for this checkout, and what it is about. */
	report: {
		kind: "current" | "behind" | "other" | null;
		line: string | null;
	};
	/** The published version when the commit fast-forwarded to is the one it was published from. */
	version: number | null;
	/** Why Fabric's copy is behind where the checkout now is, when it is. */
	lag: FabricLag | null;
	/** Where the checkout is now, for the line that says Fabric's copy lags. */
	head: string | null;
	/** How long the hook's whole budget is, for the line that says it ran out. */
	gaveUpAfter: string;
}

export interface FastForwardLines {
	/** For the person or agent: the session reads it. */
	stdout: string[];
	/** For the log only, behind `fabric: coding instructions sync skipped:`. */
	stderr: string[];
}

function skipped(text: string): string {
	return `${HOOK_PREFIX} sync skipped: ${text}`;
}

/**
 * The lines a result prints. The report line (`behind`, `nothing-published`,
 * `earlier-source`) is what `check --hook` would say about the checkout as it
 * was found; it is kept where it is still true and dropped where the update
 * made it stale.
 */
export function fastForwardLines(
	outcome: FfOutcome,
	context: FastForwardContext,
): FastForwardLines {
	const { report } = context;
	const stdout: string[] = [];
	const stderr: string[] = [];
	const reportLine = (): void => {
		if (report.line !== null) {
			stdout.push(report.line);
		}
	};
	const otherLine = (): void => {
		if (report.kind === "other" && report.line !== null) {
			stdout.push(report.line);
		}
	};
	const lag = (): void => {
		if (context.lag !== null && context.head !== null) {
			stdout.push(
				outcomeLine("ff-fabric-lags", {
					reason: context.lag,
					ref: context.ref,
					sha7: context.head.slice(0, 7),
				}),
			);
		}
	};

	switch (outcome.kind) {
		case "fast-forwarded":
			stdout.push(
				outcomeLine("ff-fast-forwarded", {
					ref: context.ref,
					from7: outcome.from.slice(0, 7),
					sha7: outcome.to.slice(0, 7),
					version: context.version,
				}),
			);
			otherLine();
			lag();
			break;
		case "already-current":
			otherLine();
			lag();
			break;
		case "opted-out":
			reportLine();
			break;
		case "not-safe":
			if (isBehindReason(outcome.reason)) {
				reportLine();
			} else if (report.kind === "behind") {
				stdout.push(
					outcomeLine("ff-not-safe", {
						reason: outcome.reason,
						ref: context.ref,
						remote: context.remote,
						commands: context.commands,
					}),
				);
			} else {
				otherLine();
			}
			break;
		case "fetch-failed": {
			const text = outcomeLine("ff-fetch-failed", {
				reason: outcome.reason,
				repo: context.repo,
				host: context.host,
				ref: context.ref,
				login: context.login,
				commands: context.commands,
			});
			if (outcome.reason === "auth" || outcome.reason === "old-git") {
				stdout.push(text);
			} else {
				stderr.push(skipped(text));
			}
			reportLine();
			break;
		}
		case "merge-failed": {
			const text = outcomeLine("ff-merge-failed", {
				failure: outcome,
				ref: context.ref,
				remote: context.remote,
				commands: context.commands,
			});
			if (isUserActionableMergeFailure(outcome.reason)) {
				stdout.push(text);
				otherLine();
			} else {
				stderr.push(skipped(text));
				reportLine();
			}
			break;
		}
		case "locked":
			stdout.push(outcomeLine("ff-locked", {}));
			otherLine();
			break;
		case "abandoned-lock":
			stdout.push(
				outcomeLine("ff-abandoned-lock", {
					lockPath: outcome.lockPath,
				}),
			);
			otherLine();
			break;
		case "deadline":
			stderr.push(
				skipped(outcomeLine("gave-up", { after: context.gaveUpAfter })),
			);
			reportLine();
			break;
		default:
			return outcome satisfies never;
	}
	return { stdout, stderr };
}
