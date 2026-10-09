/**
 * The session hook's fast-forward, end to end (Fizzy #2878): read what the
 * gate needs, take the checkout's lock, fetch the branch, move to its tip when
 * that is a fast-forward, and say what happened once.
 *
 * Everything that decides is in `fast-forward.ts` and is pure; this module is
 * the part that runs git, the lock, the notice memory and the trace, in that
 * order, inside the hook's clock:
 *
 *   - the fetch has the budget minus a merge reserve (`MERGE_RESERVE_MS`), and
 *     the merge runs only if that reserve is still there, so a slow remote can
 *     never leave the hook mid-merge when its deadline passes;
 *   - the lock is `<common dir>/fabric/ff.lock`, taken without waiting: the
 *     loser re-reads where HEAD is and reports either the active holder or an
 *     abandoned lock that needs explicit recovery;
 *   - the gate is asked again under the lock, because the checkout may have
 *     changed since it was first read.
 *
 * It never throws for anything git, the disk or the lock does: every such
 * failure is an outcome.
 */
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import type {
	PublishedInstructionRepository,
	PublishedInstructionSnapshot,
} from "@fabricorg/sdk";
import { describeDuration } from "../command-boundary.js";
import {
	ExclusiveLockBusyError,
	withExclusiveLock,
} from "../exclusive-lock.js";
import { providerLoginCommand } from "./adoption.js";
import {
	type CheckoutClassification,
	type CheckoutReport,
	repositoryName,
	shellQuote,
} from "./checkout.js";
import { sanitizeDisplayText } from "./checks.js";
import {
	type DeadlineStage,
	type FastForwardContext,
	type FastForwardFacts,
	type FfOutcome,
	fabricCopyLag,
	fastForwardEligibility,
	fastForwardLines,
} from "./fast-forward.js";
import {
	forgetNotice,
	isNewNotice,
	noticeFile,
	rememberNotice,
} from "./fast-forward-memory.js";
import * as git from "./git.js";
import { hookTiming, sinceProcessStart } from "./hook-timing.js";
import { appendTrace } from "./hook-trace.js";
import { isUserActionableMergeFailure } from "./outcome.js";

/**
 * What the fetch leaves for the local steps after it (re-reading the checkout,
 * the merge) and the notice, out of the git budget. Git on a slow disk spends
 * most of this re-reading, so it is not also the bar the merge must clear.
 */
export const MERGE_RESERVE_MS = 1_500;

/**
 * What must still be left to START the merge: one `git merge --ff-only`, which
 * the git budget kills if it overruns. Smaller than the reserve on purpose: a
 * fetch that used its whole budget leaves the reserve, the re-reads spend part
 * of it, and the merge (the fast-forward the fetch was for) still goes ahead.
 */
export const MERGE_FLOOR_MS = 500;

/** Age after which a fast-forward lock with no live owner is reported abandoned. */
const FF_LOCK_STALE_MS = 30_000;

type MatchingClassification = Extract<
	CheckoutClassification,
	{ class: "matching" }
>;

export interface FastForwardRun {
	classification: MatchingClassification;
	repository: PublishedInstructionRepository;
	snapshot: PublishedInstructionSnapshot | undefined;
	/** The immutable direct-read commit, when this project has no snapshot. */
	directCommitSha?: string;
	/** Fabric's one-shot Git transport for a direct repository hook, asked for when a fetch needs it. */
	gitTransport?: () => Promise<git.GitHttpAuthorization>;
	/** The checkout as `check` found it: its state and the line it would print. */
	report: CheckoutReport;
	projectId: string;
	/** Where the git budget ends, in epoch milliseconds. */
	deadline: number;
	/** `--no-fast-forward`: report only. */
	optedOut: boolean;
	/** Where the trace goes, or `undefined` for none. */
	traceFile?: string;
	/** Milliseconds the caller already spent, by phase, for the trace. */
	timings?: Record<string, number>;
}

export interface FastForwardResult {
	outcome: FfOutcome;
	stdout: string[];
	stderr: string[];
}

/** Milliseconds spent in each named phase of the run, for the trace. */
class Phases {
	readonly totals: Record<string, number> = {};

	async time<T>(name: string, work: () => Promise<T>): Promise<T> {
		const started = Date.now();
		try {
			return await work();
		} finally {
			this.totals[name] =
				(this.totals[name] ?? 0) + (Date.now() - started);
		}
	}
}

/** The run plus what its steps share. */
interface Session extends FastForwardRun {
	phases: Phases;
	/** Asked for once, at the start, while the first facts are read. */
	commonDir: Promise<Awaited<ReturnType<typeof git.commonDir>>>;
}

interface Decision {
	outcome: FfOutcome;
	/** HEAD as last read, for what is said afterwards. */
	head: string | null;
}

const show = (value: string, max = 200): string =>
	sanitizeDisplayText(value, max);

async function samePath(a: string, b: string): Promise<boolean> {
	const resolve = async (value: string): Promise<string> =>
		realpath(value).catch(() => path.resolve(value));
	const [left, right] = await Promise.all([resolve(a), resolve(b)]);
	return process.platform === "win32"
		? left.toLowerCase() === right.toLowerCase()
		: left === right;
}

/**
 * Everything the gate reads, fresh; `null` when git could not answer. The
 * independent reads run together (each is a process spawn, and on Windows a
 * spawn is the cost); the upstream waits only for the branch name. Whether the
 * tree has content changes is not read: eligibility does not use it, and git
 * itself says so, naming the files, if a change is in the merge's way.
 */
async function readFacts(
	run: Session,
	deadline: number,
): Promise<FastForwardFacts | null> {
	const { classification, repository } = run;
	const root = classification.toplevel;
	const [branch, head, operation, locks, holders] = await Promise.all([
		git.currentBranch(root, deadline),
		git.headSha(root, deadline),
		git.operationInProgress(root, deadline),
		git.lockFilesPresent(root, deadline),
		git.worktreesOnBranch(root, repository.ref, deadline),
	]);
	if (
		branch.kind !== "ok" ||
		head.kind !== "ok" ||
		operation.kind !== "ok" ||
		locks.kind !== "ok" ||
		holders.kind !== "ok"
	) {
		return null;
	}
	const upstream =
		branch.value === null
			? { kind: "ok" as const, value: null }
			: await git.upstreamOf(root, branch.value, deadline);
	if (upstream.kind !== "ok") {
		return null;
	}
	const elsewhere = await Promise.all(
		holders.value.map(async (holder) => !(await samePath(holder, root))),
	);
	return {
		ref: repository.ref,
		remote: classification.remote,
		state: {
			branch: branch.value,
			head: head.value,
			operation: operation.value,
			traits: classification.traits,
		},
		upstream: upstream.value,
		lockFiles: locks.value,
		heldElsewhere: elsewhere.some(Boolean),
	};
}

/** What git not answering means: the budget ran out, or something is in the way. */
function unanswered(
	deadline: number,
	head: string | null,
	stage: DeadlineStage,
): Decision {
	return Date.now() >= deadline
		? { outcome: { kind: "deadline", stage }, head }
		: { outcome: { kind: "not-safe", reason: "git-busy" }, head };
}

/**
 * How the fetched tip stands to HEAD. `ahead` is the one a merge can move to;
 * ahead of the tip is current (the developer has commits to push); neither is
 * a diverged branch, which is theirs to settle. A git that cannot answer is
 * `ahead`: `merge --ff-only` is the check that cannot be wrong.
 */
async function tipRelation(
	root: string,
	head: string,
	tip: string,
	deadline: number,
): Promise<"current" | "ahead" | "diverged"> {
	if (tip === head) {
		return "current";
	}
	const forward = await git.isAncestor(root, head, tip, deadline);
	if (forward.kind !== "ok" || forward.value) {
		return "ahead";
	}
	const behind = await git.isAncestor(root, tip, head, deadline);
	return behind.kind === "ok" && behind.value ? "current" : "diverged";
}

async function underLock(
	run: Session,
	first: FastForwardFacts,
): Promise<Decision> {
	const { classification, repository, deadline } = run;
	const root = classification.toplevel;
	const remote = classification.remote;
	const ref = repository.ref;

	// The checkout may have changed since the gate first looked.
	const facts = await run.phases.time("facts", () =>
		readFacts(run, deadline),
	);
	if (facts === null) {
		return unanswered(deadline, first.state.head, "read");
	}
	const gate = fastForwardEligibility(facts);
	if (!gate.eligible) {
		return {
			outcome: { kind: "not-safe", reason: gate.reason },
			head: facts.state.head,
		};
	}
	const head = facts.state.head;
	if (head === null) {
		return {
			outcome: { kind: "not-safe", reason: "no-upstream" },
			head,
		};
	}

	const fetchDeadline = deadline - MERGE_RESERVE_MS;
	if (Date.now() >= fetchDeadline) {
		return { outcome: { kind: "deadline", stage: "fetch" }, head };
	}
	let transport: git.GitHttpAuthorization | undefined;
	if (run.gitTransport) {
		try {
			transport = await run.gitTransport();
		} catch {
			return { outcome: { kind: "fetch-failed", reason: "auth" }, head };
		}
	}
	const fetched = await run.phases.time("fetch", () =>
		transport
			? git.fetchRefFromUrl(
					root,
					transport.url,
					remote,
					ref,
					fetchDeadline,
					transport,
				)
			: git.fetchRef(root, remote, ref, fetchDeadline),
	);
	switch (fetched.kind) {
		case "timed-out":
			return { outcome: { kind: "deadline", stage: "fetch" }, head };
		case "unavailable":
			return {
				outcome: { kind: "fetch-failed", reason: "other" },
				head,
			};
		case "failed":
			return fetched.reason === "diverged"
				? {
						outcome: { kind: "merge-failed", reason: "diverged" },
						head,
					}
				: {
						outcome: {
							kind: "fetch-failed",
							reason: fetched.reason,
						},
						head,
					};
		case "fetched":
			break;
		default:
			return fetched satisfies never;
	}
	const tip = fetched.tip;

	// Everything from here on is local: the fetch has finished, so the merge is
	// not held to the network's budget. It may start whenever `MERGE_FLOOR_MS`
	// is left, however much of the reserve the checks below spent. The
	// checkout is re-read once, right before the merge.
	const relation = await run.phases.time("relate", () =>
		tipRelation(root, head, tip, deadline),
	);
	switch (relation) {
		case "current":
			return { outcome: { kind: "already-current" }, head };
		case "diverged":
			return {
				outcome: { kind: "merge-failed", reason: "diverged" },
				head,
			};
		case "ahead":
			break;
		default:
			return relation satisfies never;
	}
	const changed = await run.phases.time("facts", () =>
		factsStillMatch(run, facts, deadline),
	);
	if (changed !== null) {
		return changed;
	}
	if (deadline - Date.now() < MERGE_FLOOR_MS) {
		return { outcome: { kind: "deadline", stage: "merge" }, head };
	}
	const merged = await run.phases.time("merge", () =>
		git.fastForwardTo(root, tip, deadline),
	);
	switch (merged.kind) {
		case "merged":
			return {
				outcome: {
					kind: "fast-forwarded",
					from: head,
					to: merged.head,
				},
				head: merged.head,
			};
		case "timed-out":
			return {
				outcome: { kind: "merge-failed", reason: "timeout" },
				head,
			};
		case "unavailable":
			return { outcome: { kind: "merge-failed", reason: "other" }, head };
		case "failed":
			if (merged.reason === "busy") {
				return {
					outcome: { kind: "not-safe", reason: "git-busy" },
					head,
				};
			}
			return {
				outcome:
					merged.reason === "local-changes"
						? {
								kind: "merge-failed",
								reason: merged.reason,
								files: merged.files,
							}
						: { kind: "merge-failed", reason: merged.reason },
				head,
			};
		default:
			return merged satisfies never;
	}
}

/**
 * Fetch updates a remote-tracking ref but does not own the checkout. Read all
 * gate facts again before relying on the branch and HEAD captured under our
 * lock: a person using Git outside Fabric does not hold that lock.
 */
async function factsStillMatch(
	run: Session,
	expected: FastForwardFacts,
	deadline: number,
): Promise<Decision | null> {
	const facts = await readFacts(run, deadline);
	if (facts === null) {
		return unanswered(deadline, expected.state.head, "merge");
	}
	const gate = fastForwardEligibility(facts);
	if (!gate.eligible) {
		return {
			outcome: { kind: "not-safe", reason: gate.reason },
			head: facts.state.head,
		};
	}
	if (
		facts.state.branch !== expected.state.branch ||
		facts.state.head !== expected.state.head
	) {
		return {
			outcome: { kind: "not-safe", reason: "git-busy" },
			head: facts.state.head,
		};
	}
	return null;
}

async function decide(run: Session): Promise<Decision> {
	const { classification, deadline, report, phases } = run;
	const root = classification.toplevel;
	const head = report.state?.head ?? null;
	if (run.optedOut) {
		return { outcome: { kind: "opted-out" }, head };
	}
	const facts = await phases.time("facts", () => readFacts(run, deadline));
	if (facts === null) {
		return unanswered(deadline, head, "read");
	}
	const gate = fastForwardEligibility(facts);
	if (!gate.eligible) {
		return {
			outcome: { kind: "not-safe", reason: gate.reason },
			head: facts.state.head,
		};
	}

	// A direct-repository project's server read the branch tip itself, so a
	// HEAD that already holds that commit is current with no network at all.
	// (A project with a snapshot does not skip: its commit is the last
	// one Fabric copied, and git, not that copy, is the authority on the tip.)
	if (run.directCommitSha !== undefined && facts.state.head !== null) {
		const holds = await phases.time("contains", () =>
			git.isAncestor(
				root,
				run.directCommitSha as string,
				facts.state.head as string,
				deadline,
			),
		);
		if (holds.kind === "ok" && holds.value) {
			return {
				outcome: { kind: "already-current" },
				head: facts.state.head,
			};
		}
	}

	const common = await run.commonDir;
	if (common.kind !== "ok") {
		return unanswered(deadline, head, "read");
	}
	const directory = path.join(common.value, "fabric");
	try {
		await mkdir(directory, { recursive: true });
		return await withExclusiveLock(() => underLock(run, facts), {
			lockPath: path.join(directory, "ff.lock"),
			staleMs: FF_LOCK_STALE_MS,
			waitMs: 0,
		});
	} catch (error) {
		if (error instanceof ExclusiveLockBusyError) {
			const now = await git.headSha(root, deadline);
			return {
				outcome: error.abandoned
					? {
							kind: "abandoned-lock",
							lockPath: path.join(directory, "ff.lock"),
						}
					: { kind: "locked" },
				head: now.kind === "ok" ? now.value : head,
			};
		}
		// The lock could not be made (a read-only git directory, say): leave
		// the checkout alone.
		return { outcome: { kind: "not-safe", reason: "git-busy" }, head };
	}
}

function reasonOf(outcome: FfOutcome): string | null {
	switch (outcome.kind) {
		case "not-safe":
		case "fetch-failed":
		case "merge-failed":
			return outcome.reason;
		case "deadline":
			return outcome.stage;
		default:
			return null;
	}
}

/** The memory key of a result that is said once per version, or `null` when it is always said. */
function noticeReason(outcome: FfOutcome, lag: string | null): string | null {
	if (outcome.kind === "not-safe") {
		return `not-safe:${outcome.reason}`;
	}
	if (
		outcome.kind === "merge-failed" &&
		isUserActionableMergeFailure(outcome.reason)
	) {
		return `merge-failed:${outcome.reason}`;
	}
	if (outcome.kind === "fetch-failed" && outcome.reason === "old-git") {
		return "fetch-failed:old-git";
	}
	if (
		(outcome.kind === "fast-forwarded" ||
			outcome.kind === "already-current") &&
		lag !== null
	) {
		return `fabric-lags:${lag}`;
	}
	return null;
}

function commandsFor(remote: string, ref: string) {
	const quotedRemote = shellQuote(remote);
	const quotedRef = shellQuote(ref);
	return {
		pull: `git pull --ff-only ${quotedRemote} ${quotedRef}`,
		rebase: `git pull --rebase ${quotedRemote} ${quotedRef}`,
		setUpstream: `git branch ${shellQuote(`--set-upstream-to=${remote}/${ref}`)} ${quotedRef}`,
		unshallow: `git fetch --unshallow ${quotedRemote}`,
		fetch: `git fetch ${quotedRemote} ${quotedRef}`,
	};
}

/**
 * Fast-forward the checkout when that is safe and say what happened. The only
 * entry point; `sync --hook` in a checkout of a repository-sourced project is
 * its only caller.
 */
export async function runFastForward(
	run: FastForwardRun,
): Promise<FastForwardResult> {
	const started = Date.now();
	const { repository, snapshot, classification } = run;
	const root = classification.toplevel;
	const phases = new Phases();
	const commonDir = git.commonDir(root, run.deadline);
	const decision = await decide({ ...run, phases, commonDir });
	const { outcome } = decision;

	const source = snapshot?.source;
	const snapshotSha =
		source?.kind === "REPOSITORY" &&
		source.current &&
		git.isCommitSha(source.commitSha)
			? source.commitSha
			: null;
	const publishedSha = run.directCommitSha ?? snapshotSha;
	const moved =
		outcome.kind === "fast-forwarded" || outcome.kind === "already-current";
	const head = outcome.kind === "fast-forwarded" ? outcome.to : decision.head;

	let publishedInHistory: boolean | null = null;
	if (
		moved &&
		snapshot !== undefined &&
		publishedSha !== null &&
		head !== null &&
		publishedSha !== head
	) {
		const answer = await git.isAncestor(
			root,
			publishedSha,
			head,
			run.deadline,
		);
		publishedInHistory = answer.kind === "ok" ? answer.value : null;
	}
	const lag =
		moved && snapshot !== undefined
			? fabricCopyLag({
					headSha: head,
					publishedSha,
					publishedInHistory,
					sync: repository.sync,
				})
			: null;

	const remote = show(classification.remote, 100);
	const ref = show(repository.ref);
	const commands = commandsFor(classification.remote, repository.ref);
	const context: FastForwardContext = {
		repo: repositoryName(repository),
		host: show(repository.host, 253),
		ref,
		remote,
		login: providerLoginCommand(repository.provider, commands.fetch),
		commands,
		report: { kind: run.report.reportKind ?? null, line: run.report.line },
		version:
			outcome.kind === "fast-forwarded" &&
			publishedSha === outcome.to &&
			snapshot
				? Number(snapshot.version)
				: null,
		lag,
		head,
		gaveUpAfter: describeDuration(
			hookTiming.processStartedAt === undefined
				? hookTiming.deadlineMs
				: Math.round(sinceProcessStart() / 100) * 100,
		),
	};
	let { stdout, stderr } = fastForwardLines(outcome, context);

	// Said once per published version and reason; a fast-forward ends whatever
	// was said before it.
	const early = await commonDir;
	const common =
		early.kind === "ok"
			? early
			: await git.commonDir(
					root,
					Math.max(run.deadline, Date.now() + 500),
				);
	const notices = common.kind === "ok" ? noticeFile(common.value) : null;
	if (notices !== null) {
		if (outcome.kind === "fast-forwarded") {
			await forgetNotice(notices);
		}
		const reason = noticeReason(outcome, lag);
		if (reason !== null && stdout.length > 0) {
			const key = {
				projectId: run.projectId,
				publishedVersion: snapshot ? Number(snapshot.version) : 0,
				...(run.directCommitSha === undefined
					? {}
					: { directCommitSha: run.directCommitSha }),
				reason,
			};
			if (await isNewNotice(notices, key)) {
				await rememberNotice(notices, key);
			} else {
				stdout = [];
			}
		}
	}

	if (run.traceFile !== undefined) {
		await appendTrace(run.traceFile, {
			at: new Date().toISOString(),
			projectId: run.projectId,
			outcome: outcome.kind,
			reason: reasonOf(outcome),
			ms: Date.now() - started,
			totalMs: sinceProcessStart(),
			phases: { ...run.timings, ...phases.totals },
		});
	}
	return { outcome, stdout, stderr };
}
