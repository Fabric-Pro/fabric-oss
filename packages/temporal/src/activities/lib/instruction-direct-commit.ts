/**
 * A direct commit to a repository-backed project's synced branch (Fizzy #2878
 * §10): one READY `REPOSITORY_COMMIT` snapshot becomes one commit on the
 * branch its frozen destination names, or a typed outcome saying why not.
 *
 * Order of evidence. The snapshot reached READY through the ordinary verify →
 * scan → promote workflow before anything here runs, so the secret scan has
 * decided every byte that can reach the repository. Every git step runs under
 * the recorded integration's credential, in a fresh blobless clone, against
 * the branch's own tip: fetch the tip `T`, work out which paths the change
 * writes relative to `T`, refuse a path someone else changed since the base,
 * build ONE commit on `T` whose diff from `T` is verified to be exactly the
 * plan, and push it with a lease on `T`.
 *
 * Why this does not overwrite a teammate. A path is written only when `T`
 * already holds what the change wants there (nothing to do), or when no
 * commit between the change's base and `T` touched it (history-based, never
 * content-based, as the member branch's per-file rule is). Anything else is
 * `branch-moved`: nothing is written and the editor chooses. A push that
 * loses the lease race is `stale`; the whole step restarts on the new tip, up
 * to three times, and then falls back to a pull request.
 *
 * What a refusal becomes. A branch that refuses the push (protection, a
 * pre-receive hook) or keeps moving under it falls back automatically: the
 * SAME snapshot rows are admitted as a REPOSITORY proposal on the member's
 * branch, and the existing branch machinery opens the pull request.
 *
 * Retries are recovered, not repeated. The commit carries a
 * `Fabric-Commit: <snapshotId>` trailer, and every pass first looks for it in
 * the branch's history since the base: a push whose acknowledgement was lost
 * is found and settled, never pushed twice.
 *
 * Not re-exported from the activities barrel: every export of a module the
 * barrel re-exports becomes a schedulable Temporal activity.
 */
import {
	admitDirectCommitAsProposal,
	canCreateProjectInstructions,
	type DirectCommitSnapshotRow,
	getDirectCommitSnapshot,
	getInstructionRepositorySyncForProposal,
	getProjectInstructionSettings,
	isProjectReadOnly,
	joinProposalBranch,
	listInstructionFiles,
	type ProposalBranchNaming,
	recordDirectCommitPushed,
} from "@repo/database";
import {
	type BranchDestination,
	DIRECT_COMMIT_TRAILER,
	type DirectCommitContext,
	type DirectCommitOutcome,
	directCommitContextSchema,
	directCommitOutcomeSchema,
	type PullRequestContextV2,
	type TreeEntry,
} from "@repo/instructions";
import { memberBranchRef } from "@repo/instructions/proposal-branch-ref";
import {
	repositoryIdentity,
	repositoryKey,
	sameRepository,
} from "@repo/integrations/instruction-pull-requests";
import { logger } from "@repo/logs";
import { ApplicationFailure } from "@temporalio/activity";
import type {
	ConfirmingSyncInput,
	UnrecordedCommitOutcome,
} from "../../lib/instruction-direct-commit-types";
import { safeHeartbeat } from "./activity-liveness";
import {
	hashIntentBlobs,
	type Intent,
	intentsOf,
	toFileRow,
} from "./instruction-branch-append";
import {
	type BranchCredential,
	withBranchRepoCredential,
} from "./instruction-branch-credential";
import {
	fetchSyncedTip,
	initBranchWorkspace,
	isAncestor,
	pushToSyncedRef,
	readTreeEntries,
} from "./instruction-branch-git";
import {
	ensureCommit,
	pathUntouchedSince,
	sameEntry,
} from "./instruction-branch-support";
import { wakeBranchWorkflow } from "./instruction-branch-wake";
import {
	assertMayContinue,
	ProposalStepFailure,
} from "./instruction-proposal-boundary";
import {
	type BranchWritePlanEntry,
	buildBranchCommit,
	computeEffectiveDelta,
	findTreeConflicts,
} from "./instruction-proposal-commit";
import { gitCall } from "./instruction-proposal-operation";
import {
	assertObjectId,
	type GitCallBase,
	listTreeRaw,
	MAX_INVENTORY_ENTRIES,
	type RawTreeEntry,
	runGit,
} from "./instruction-sync-git";

/** Failures are typed in the proposal vocabulary under the phase that names this kind of step. */
const PHASE = "append" as const;

/** Lease losses tolerated before the branch is called busy and the change becomes a pull request. */
const MAX_PASSES = 3;

const NAMING: ProposalBranchNaming = {
	memberBranchRef,
	repositoryIdentity,
	repositoryKey,
};

const fail = (
	code: ProposalStepFailure["code"],
	retryable: boolean,
	params?: Record<string, string | number | boolean>,
) => new ProposalStepFailure({ code, phase: PHASE, retryable, params });

/**
 * The project is in Read-only mode: no commit or revert may be pushed. Its own
 * class rather than a pull request failure code, because the typed codes the
 * branch machinery shares are a closed set about pull requests; the two
 * activities map it to the `READ_ONLY_MODE` failure code, never retried.
 */
export class ReadOnlyModeRefusal extends Error {
	constructor() {
		super("The project is in Read-only mode");
		this.name = "ReadOnlyModeRefusal";
	}
}

// ---------------------------------------------------------------------------
// The shared push loop (a direct commit and a revert both run it)
// ---------------------------------------------------------------------------

export type SyncedCommitSpec = {
	/** The branch to write: exactly the frozen destination's. */
	targetRef: string;
	/**
	 * The branch the live sync row names right now (what
	 * `assertDirectCommitAllowed` just read). It is the ref that reaches the
	 * fetch and the push; `targetRef` is the only value it may equal, so a
	 * live row that no longer names the frozen branch refuses before git runs.
	 */
	liveRef: string;
	rootPath: string;
	author: { name: string; email: string };
	committer: { name: string; email: string };
	/** Plain text; the trailer is appended here. */
	message: string;
	/** ISO 8601 UTC, whole seconds: the commit's author and committer date. */
	committedAt: string;
	/** `Fabric-Commit` trailer value: the snapshot id, or a revert's request id. */
	trailerId: string;
	/** A commit the branch's history contains: the earlier acknowledgement search starts after it. */
	searchFrom: string;
};

/** What `planFor` is handed: the fresh tip and the workspace to read it in. */
export type TipContext = {
	tip: string;
	git: GitCallBase & { dir: string };
	credential: BranchCredential;
	/** Every blob, symlink and gitlink under the root at the tip, listed on first use. */
	listTree: () => Promise<RawTreeEntry[]>;
};

export type PlanDecision =
	| { kind: "plan"; entries: BranchWritePlanEntry[] }
	/** The branch already holds exactly what the change wants. */
	| { kind: "unchanged" }
	/** Someone changed one of these paths on the branch since the base. */
	| { kind: "branch-moved" }
	/** A refusal that is the change's own (`REVERT_CONFLICT`): recorded as `failed`. */
	| { kind: "refused"; code: string };

export type SyncedCommitResult =
	| { kind: "pushed"; sha: string }
	| { kind: "unchanged"; sha: string }
	| { kind: "branch-moved" }
	| { kind: "refused"; code: string }
	/** The branch refused the push: protection, a hook, no write permission. */
	| { kind: "protected" }
	/** The branch moved under every one of three attempts. */
	| { kind: "busy" };

/** The pattern of a trailer value: an id this codebase issues, never free text. */
const TRAILER_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** The commits `findOwnCommit` reads the messages of: a spoofed match is skipped, so a few are enough. */
const OWN_COMMIT_CANDIDATES = 20;

/** The most output the candidates' messages may fill; a larger one is a git failure, never a match. */
const OWN_COMMIT_MAX_STDOUT_BYTES = 1024 * 1024;

/**
 * Whether `message` ends in exactly the trailer of this operation, as the
 * last paragraph and alone in it, as the commit builder writes it
 * (`<message>\n\nFabric-Commit: <id>\n`). A line of that shape anywhere else
 * in a message is somebody else's text, however it got there.
 */
function endsWithOwnTrailer(message: string, trailerId: string): boolean {
	const paragraphs = message.replace(/\s+$/, "").split(/\n[ \t]*\n/);
	const last = paragraphs[paragraphs.length - 1] ?? "";
	return last.trim() === `${DIRECT_COMMIT_TRAILER}: ${trailerId}`;
}

/**
 * The commit of this operation already on the branch, if an earlier attempt
 * pushed it and lost the acknowledgement: the newest commit after
 * `searchFrom` whose message ENDS in this operation's trailer. `--grep`
 * narrows the history to commits that mention it on some line; the message is
 * then parsed, because a teammate's commit that merely quotes the line
 * (a pasted message, a squash of a commit that had it) is not ours, and taking
 * it for ours would settle a commit that was never pushed.
 */
async function findOwnCommit(
	i: GitCallBase & {
		dir: string;
		searchFrom: string;
		tip: string;
		trailerId: string;
	},
): Promise<string | null> {
	assertObjectId(i.searchFrom, "log");
	assertObjectId(i.tip, "log");
	if (!TRAILER_ID.test(i.trailerId)) {
		throw new Error("A direct commit's trailer id is not an issued id");
	}
	const { stdout } = await runGit({
		cwd: i.dir,
		args: [
			"log",
			"--extended-regexp",
			`--grep=^${DIRECT_COMMIT_TRAILER}: ${i.trailerId}$`,
			"-n",
			String(OWN_COMMIT_CANDIDATES),
			"--format=%H%x00%B%x01",
			`${i.searchFrom}..${i.tip}`,
		],
		env: i.env,
		signal: i.signal,
		label: "log",
		maxStdoutBytes: OWN_COMMIT_MAX_STDOUT_BYTES,
	});
	for (const record of stdout.toString("utf8").split("\u0001")) {
		const [sha, message] = record.trim().split("\u0000");
		if (
			sha !== undefined &&
			message !== undefined &&
			endsWithOwnTrailer(message, i.trailerId)
		) {
			assertObjectId(sha, "log");
			return sha;
		}
	}
	return null;
}

/**
 * The commit of this operation already on the synced branch, looked up in a
 * workspace of its own: the same search the push loop opens every pass with,
 * for a retry whose live checks (`assertDirectCommitAllowed`) refuse before
 * the loop can run. A commit that reached the branch is a fact the member's
 * later loss of write rights, a Read-only switch or a reconfiguration does not
 * undo, so it must be found and recorded, never answered with a refusal that
 * leaves the row failed behind a commit the branch holds.
 */
export async function findPushedCommit(
	credential: BranchCredential,
	spec: Pick<SyncedCommitSpec, "targetRef" | "searchFrom" | "trailerId">,
): Promise<string | null> {
	const git = {
		dir: credential.workDir,
		env: credential.env,
		signal: credential.signal,
	};
	await gitCall(PHASE, credential, () =>
		initBranchWorkspace({
			url: credential.url,
			targetRef: spec.targetRef,
			dir: credential.workDir,
			env: credential.env,
			signal: credential.signal,
		}),
	);
	await gitCall(PHASE, credential, () =>
		ensureCommit({ ...git, sha: spec.searchFrom }),
	);
	const fetched = await gitCall(PHASE, credential, () =>
		fetchSyncedTip({
			...git,
			branch: spec.targetRef,
			allowedRef: spec.targetRef,
		}),
	);
	if (fetched.kind === "absent") {
		return null;
	}
	const tip = fetched.sha;
	return gitCall(PHASE, credential, () =>
		findOwnCommit({
			...git,
			searchFrom: spec.searchFrom,
			tip,
			trailerId: spec.trailerId,
		}),
	);
}

/**
 * Whether `error` is the live checks' own refusal, as opposed to a fault of
 * the check itself (an unreachable database): only a refusal is worth looking
 * for an already-pushed commit behind.
 */
export function isLiveCheckRefusal(error: unknown): boolean {
	return (
		error instanceof ProposalStepFailure ||
		error instanceof ReadOnlyModeRefusal
	);
}

/**
 * The loop every commit to the synced branch runs: fetch the tip, recover an
 * earlier attempt's commit, plan against the tip, build and verify one
 * commit, check the member may still write, push with the lease. A lost lease
 * restarts on the new tip; the third loss is `busy`.
 *
 * The workspace must be one `initBranchWorkspace` filled for this credential.
 */
export async function pushPlanToSyncedBranch(i: {
	credential: BranchCredential;
	spec: SyncedCommitSpec;
	planFor: (tip: TipContext) => Promise<PlanDecision>;
	assertStillAllowed: () => Promise<unknown>;
}): Promise<SyncedCommitResult> {
	const { credential, spec } = i;
	const git = {
		dir: credential.workDir,
		env: credential.env,
		signal: credential.signal,
	};
	for (let pass = 0; pass < MAX_PASSES; pass++) {
		safeHeartbeat();
		assertMayContinue(credential.signal);
		const fetched = await gitCall(PHASE, credential, () =>
			fetchSyncedTip({
				...git,
				branch: spec.liveRef,
				allowedRef: spec.targetRef,
			}),
		);
		if (fetched.kind === "absent") {
			throw fail("TARGET_BRANCH_MISSING", false);
		}
		const tip = fetched.sha;

		const own = await gitCall(PHASE, credential, () =>
			findOwnCommit({
				...git,
				searchFrom: spec.searchFrom,
				tip,
				trailerId: spec.trailerId,
			}),
		);
		if (own !== null) {
			return { kind: "pushed", sha: own };
		}

		let listed: RawTreeEntry[] | null = null;
		const decision = await i.planFor({
			tip,
			git,
			credential,
			listTree: async () => {
				if (listed === null) {
					const result = await gitCall(PHASE, credential, () =>
						listTreeRaw({
							...git,
							sha: tip,
							rootPath: spec.rootPath,
							maxEntries: MAX_INVENTORY_ENTRIES,
						}),
					);
					if (!result.ok) {
						throw fail("LIMITS_EXCEEDED", false);
					}
					listed = result.entries;
				}
				return listed;
			},
		});
		if (decision.kind === "unchanged") {
			return { kind: "unchanged", sha: tip };
		}
		if (decision.kind === "branch-moved") {
			return { kind: "branch-moved" };
		}
		if (decision.kind === "refused") {
			return { kind: "refused", code: decision.code };
		}

		const built = await gitCall(PHASE, credential, () =>
			buildBranchCommit({
				...git,
				parent: tip,
				plan: decision.entries,
				author: spec.author,
				committer: spec.committer,
				message: `${spec.message}\n\n${DIRECT_COMMIT_TRAILER}: ${spec.trailerId}\n`,
				date: spec.committedAt,
			}),
		);
		if (!built.ok) {
			throw fail("GIT_FAILED", false);
		}
		safeHeartbeat();

		// The member's authority and the configuration, immediately before the
		// push is committed to.
		await i.assertStillAllowed();
		assertMayContinue(credential.signal);

		const pushed = await gitCall(PHASE, credential, () =>
			pushToSyncedRef({
				...git,
				parentSha: tip,
				sha: built.sha,
				branch: spec.liveRef,
				allowedRef: spec.targetRef,
			}),
		);
		if (pushed.kind === "pushed") {
			return { kind: "pushed", sha: built.sha };
		}
		if (pushed.kind === "refused") {
			return { kind: "protected" };
		}
		// stale: the tip moved under the lease. Start again on the new one.
	}
	return { kind: "busy" };
}

// ---------------------------------------------------------------------------
// The frozen destination and the live checks against it
// ---------------------------------------------------------------------------

/** The member branch machinery's destination record for this commit's frozen context. */
function destinationOf(context: DirectCommitContext): BranchDestination {
	return {
		integrationId: context.integrationId,
		syncId: context.syncId,
		repositoryKey: repositoryKey(context.repository),
		provider: context.provider,
		repository: context.repository,
		targetRef: context.targetRef,
		rootPath: context.rootPath,
	};
}

/**
 * Whether the member may still commit under the configuration the change was
 * admitted against: the sync row is the same one at the same generation, the
 * project is still repository-backed, the integration is active and names the
 * same repository, the member still holds `INSTRUCTION_CREATE`, and the
 * project is not in Read-only mode (`ReadOnlyModeRefusal`: a push is a write
 * against a connected external source, and the mode must stop writes already
 * accepted as well as new ones). Re-read on every call: before the build and
 * again immediately before the push. Readers are never admitted here,
 * whatever the project's proposal opt-in.
 */
export async function assertDirectCommitAllowed(i: {
	projectId: string;
	organizationId: string;
	userId: string;
	destination: Pick<
		BranchDestination,
		"syncId" | "integrationId" | "targetRef" | "rootPath" | "repository"
	>;
	syncGeneration: number;
}): Promise<{ liveRef: string }> {
	const refuse = (
		code:
			| "CONFIGURATION_CHANGED"
			| "REPOSITORY_CHANGED"
			| "AUTHENTICATION_FAILED"
			| "PERMISSION_REVOKED",
	) => fail(code, code === "AUTHENTICATION_FAILED");
	if (await isProjectReadOnly(i.projectId)) {
		throw new ReadOnlyModeRefusal();
	}
	const [sync, settings] = await Promise.all([
		getInstructionRepositorySyncForProposal(i.projectId, i.organizationId),
		getProjectInstructionSettings(i.projectId, i.organizationId),
	]);
	if (
		!sync ||
		settings.sourceOfTruth !== "REPOSITORY" ||
		sync.id !== i.destination.syncId ||
		sync.generation !== i.syncGeneration ||
		sync.repositoryIntegrationId !== i.destination.integrationId ||
		sync.ref !== i.destination.targetRef ||
		sync.rootPath !== i.destination.rootPath ||
		sync.repositoryIntegration.projectId !== i.projectId
	) {
		throw refuse("CONFIGURATION_CHANGED");
	}
	const live = repositoryIdentity(
		sync.repositoryIntegration.provider,
		sync.repositoryIntegration.repositoryUrl,
	);
	if (live === null || !sameRepository(live, i.destination.repository)) {
		throw refuse("REPOSITORY_CHANGED");
	}
	if (sync.repositoryIntegration.status === "TOKEN_EXPIRED") {
		throw refuse("AUTHENTICATION_FAILED");
	}
	if (sync.repositoryIntegration.status !== "ACTIVE") {
		throw refuse("CONFIGURATION_CHANGED");
	}
	if (!(await canCreateProjectInstructions(i.projectId, i.userId))) {
		throw refuse("PERMISSION_REVOKED");
	}
	return { liveRef: sync.ref };
}

// ---------------------------------------------------------------------------
// One snapshot's commit
// ---------------------------------------------------------------------------

export type DirectCommitInput = {
	snapshotId: string;
	organizationId: string;
	signal: AbortSignal;
};

/**
 * What `runDirectCommit` did with the snapshot: it `settled` it with an
 * outcome that is recorded (the pull request a refused push became), it ended
 * without a push and hands the `outcome` back to be recorded, the branch holds
 * its commit (`pushed`: recording that is the next step's job,
 * `settlePushedDirectCommit`), or there was nothing to act on.
 */
export type DirectCommitResult =
	| { kind: "settled"; outcome: DirectCommitOutcome }
	| { kind: "outcome"; outcome: UnrecordedCommitOutcome }
	| { kind: "pushed"; sha: string }
	| { kind: "not_ready" }
	| { kind: "stopped" };

export async function runDirectCommit(
	i: DirectCommitInput,
): Promise<DirectCommitResult> {
	const row = await getDirectCommitSnapshot({
		snapshotId: i.snapshotId,
		organizationId: i.organizationId,
	});
	if (!row) {
		return { kind: "stopped" };
	}
	if (row.proposalDestination === "REPOSITORY") {
		// The change was admitted as a pull request by an earlier attempt: make
		// sure its branch has joined and woken before this attempt ends.
		await startProposal(row);
		return { kind: "stopped" };
	}
	if (row.proposalDestination !== "REPOSITORY_COMMIT") {
		return { kind: "stopped" };
	}
	if (row.commitOutcome !== null) {
		return { kind: "stopped" };
	}
	if (row.status !== "READY") {
		return { kind: "not_ready" };
	}
	const parsed = directCommitContextSchema.safeParse(row.commitContext);
	if (!parsed.success || row.baseSnapshotId === null) {
		throw fail("CONFIGURATION_CHANGED", false);
	}
	const context = parsed.data;
	const destination = destinationOf(context);
	const allowed = () =>
		assertDirectCommitAllowed({
			projectId: row.projectId,
			organizationId: row.organizationId,
			userId: row.userId,
			destination,
			syncGeneration: context.syncGeneration,
		});
	const branch = {
		id: row.id,
		projectId: row.projectId,
		organizationId: row.organizationId,
		userId: row.userId,
		destination,
	};
	let liveRef: string;
	try {
		({ liveRef } = await allowed());
	} catch (refusal) {
		// An earlier attempt may have pushed and lost its acknowledgement
		// before the member lost write rights, Read-only mode was switched on
		// or the sync was reconfigured: the commit on the branch is recorded,
		// whatever the checks say now. A fault of the lookup itself is thrown
		// for a retry rather than answered with the refusal.
		if (!isLiveCheckRefusal(refusal)) {
			throw refusal;
		}
		const own = await withBranchRepoCredential(
			{ branch, phase: PHASE, signal: i.signal },
			(credential) =>
				findPushedCommit(credential, {
					targetRef: context.targetRef,
					searchFrom: context.baseCommitSha,
					trailerId: row.id,
				}),
		);
		if (own === null) {
			throw refusal;
		}
		return settle(row, context, { kind: "pushed", sha: own });
	}
	const baseSnapshotId = row.baseSnapshotId;
	return withBranchRepoCredential(
		{ branch, phase: PHASE, signal: i.signal },
		async (credential) => {
			const git = {
				dir: credential.workDir,
				env: credential.env,
				signal: credential.signal,
			};
			await gitCall(PHASE, credential, () =>
				initBranchWorkspace({
					url: credential.url,
					targetRef: context.targetRef,
					dir: credential.workDir,
					env: credential.env,
					signal: credential.signal,
				}),
			);
			safeHeartbeat();

			const [baseRows, changeRows] = await Promise.all([
				listInstructionFiles(baseSnapshotId, row.organizationId),
				listInstructionFiles(row.id, row.organizationId),
			]);
			const delta = computeEffectiveDelta(
				baseRows.map(toFileRow),
				changeRows.map(toFileRow),
			);
			const blobs = await hashIntentBlobs(credential, delta);
			await gitCall(PHASE, credential, () =>
				ensureCommit({ ...git, sha: context.baseCommitSha }),
			);

			const result = await pushPlanToSyncedBranch({
				credential,
				spec: {
					targetRef: context.targetRef,
					liveRef,
					rootPath: context.rootPath,
					author: context.author,
					committer: context.committer,
					message: context.message,
					committedAt: context.committedAt,
					trailerId: row.id,
					searchFrom: context.baseCommitSha,
				},
				assertStillAllowed: allowed,
				planFor: async (tip) => {
					const listed = await tip.listTree();
					const intents = await intentsOf({
						credential,
						delta,
						blobs,
						entries: listed,
						rootPath: context.rootPath,
						tipSha: tip.tip,
						baseCommitSha: context.baseCommitSha,
						ops: [],
					});
					return planAgainstTip({
						tip,
						intents,
						listed,
						rootPath: context.rootPath,
						baseCommitSha: context.baseCommitSha,
					});
				},
			});
			return settle(row, context, result);
		},
	);
}

/**
 * The write plan of a change against the branch's tip (the member branch
 * append's per-file rule, without its journal): a path the tip already holds
 * as wanted is skipped; a path some commit since the base touched is a
 * conflict, and the change is not written at all.
 */
async function planAgainstTip(i: {
	tip: TipContext;
	intents: readonly Intent[];
	listed: readonly RawTreeEntry[];
	rootPath: string;
	baseCommitSha: string;
}): Promise<PlanDecision> {
	const { tip } = i;
	const { git, credential } = tip;
	const tipEntries = await gitCall(PHASE, credential, () =>
		readTreeEntries({
			...git,
			sha: tip.tip,
			rawPaths: i.intents.map((x) => x.rawPath),
		}),
	);
	const moved = tip.tip !== i.baseCommitSha;
	const ancestry = moved
		? await gitCall(PHASE, credential, () =>
				isAncestor({
					...git,
					ancestor: i.baseCommitSha,
					descendant: tip.tip,
				}),
			)
		: "true";
	const writes: Intent[] = [];
	for (const intent of i.intents) {
		const tipEntry = tipEntries.get(intent.rawPath) ?? null;
		if (sameEntry(tipEntry, intent.after)) {
			continue;
		}
		// A path the change ADDS to Fabric's copy that the branch already holds
		// (differently) is a file Fabric's copy never had: one the sync left out
		// (over the size cap, a symbolic link, an ignored name), so the editor
		// never saw it. Writing over it would destroy a file the change knows
		// nothing about, whether or not the branch moved since the base.
		if (intent.kind === "added" && tipEntry !== null) {
			return { kind: "branch-moved" };
		}
		if (
			moved &&
			!(await gitCall(PHASE, credential, () =>
				pathUntouchedSince({
					...git,
					from: i.baseCommitSha,
					tip: tip.tip,
					known: new Set<string>(),
					rawPath: intent.rawPath,
					ancestry,
				}),
			))
		) {
			return { kind: "branch-moved" };
		}
		writes.push(intent);
	}
	if (writes.length === 0) {
		return { kind: "unchanged" };
	}
	const deltaTip = {
		added: [] as Intent["row"][],
		modified: [] as Intent["row"][],
		deleted: [] as Intent["row"][],
	};
	for (const w of writes) {
		const before = tipEntries.get(w.rawPath) ?? null;
		const bucket =
			w.after === null
				? "deleted"
				: before === null
					? "added"
					: "modified";
		deltaTip[bucket].push(w.row);
	}
	if (findTreeConflicts(i.listed, deltaTip, i.rootPath)) {
		throw fail("TREE_CONFLICT", false);
	}
	return {
		kind: "plan",
		entries: writes.map((w) => ({
			rawPath: w.rawPath,
			after: w.after as TreeEntry | null,
		})),
	};
}

/**
 * Turns what the push loop decided into what is owed: a commit the branch
 * holds, or an outcome that wrote nothing, is handed back for the workflow's
 * own record activity to write (so a database that is briefly unreachable
 * cannot leave the commit pending); the branch's refusal is admitted as a pull
 * request here, which writes its own rows.
 */
async function settle(
	row: DirectCommitSnapshotRow,
	context: DirectCommitContext,
	result: SyncedCommitResult,
): Promise<DirectCommitResult> {
	switch (result.kind) {
		case "pushed":
			return { kind: "pushed", sha: result.sha };
		case "unchanged":
			return {
				kind: "outcome",
				outcome: { outcome: "unchanged", sha: result.sha },
			};
		case "branch-moved":
			return { kind: "outcome", outcome: { outcome: "branch-moved" } };
		case "refused":
			return {
				kind: "outcome",
				outcome: {
					outcome: "failed",
					code: result.code,
					retryable: false,
				},
			};
		case "protected":
		case "busy":
			return fallBackToPullRequest(
				row,
				context,
				result.kind === "protected" ? "protected" : "busy",
			);
		default:
			return unhandledResult(result);
	}
}

function unhandledResult(result: never): never {
	throw new Error(
		`Unhandled direct commit result: ${JSON.stringify(result)}`,
	);
}

/**
 * The branch holds the commit `sha`: record it as the outcome, and name the
 * sync run that takes the new tip (`confirm`, started by the workflow's own
 * activity, `startConfirmingInstructionSync`), which publishes the version
 * from the real tree. The snapshot is never published here: it is the change
 * stated against the base, and a tip that moved past the base carries other
 * people's changes it knows nothing of. Two requirements follow, and the
 * sync's own rules meet both: the run's "unchanged" answer compares against
 * the PUBLISHED version, which still names the previous commit, so it reads
 * the tree; and files whose bytes equal the published version's are adopted
 * from it instead of being copied again.
 *
 * Idempotent, because it is retried (the commit cannot be un-pushed, so a row
 * that stays pending forever would be a lie): an outcome already recorded for
 * this `sha` is success, and anything else already recorded is an anomaly that
 * a retry cannot fix, so it throws a typed non-retryable failure instead of
 * looping. Starting the sync is NOT part of it: a start that is refused
 * because a run is open must be retried until that run has ended, and a
 * record that was retried for it would write the outcome again each time.
 */
export async function settlePushedDirectCommit(i: {
	snapshotId: string;
	organizationId: string;
	sha: string;
}): Promise<ConfirmingSyncInput> {
	const row = await getDirectCommitSnapshot({
		snapshotId: i.snapshotId,
		organizationId: i.organizationId,
	});
	const parsed = directCommitContextSchema.safeParse(row?.commitContext);
	if (!row || !parsed.success) {
		throw ApplicationFailure.nonRetryable(
			"A pushed direct commit's snapshot or its frozen destination is gone",
			"DIRECT_COMMIT_SNAPSHOT_MISSING",
		);
	}
	const context = parsed.data;
	if (committedSha(row.commitOutcome) !== i.sha) {
		const recorded = await recordDirectCommitPushed({
			snapshotId: row.id,
			projectId: row.projectId,
			organizationId: row.organizationId,
			actorUserId: row.userId,
			ref: context.targetRef,
			sha: i.sha,
			fileCount: row.fileCount,
		});
		if (!recorded) {
			const current = await getDirectCommitSnapshot({
				snapshotId: i.snapshotId,
				organizationId: i.organizationId,
			});
			if (committedSha(current?.commitOutcome) !== i.sha) {
				logger.error(
					{
						event: "instruction_direct_commit.outcome_not_recorded",
						snapshotId: row.id,
					},
					"[CodingInstructions] A direct commit was pushed but its snapshot no longer accepts the outcome",
				);
				throw ApplicationFailure.nonRetryable(
					"A pushed direct commit's snapshot no longer accepts its outcome",
					"DIRECT_COMMIT_OUTCOME_REFUSED",
				);
			}
		}
	}
	return {
		projectId: row.projectId,
		organizationId: row.organizationId,
		syncId: context.syncId,
		generation: context.syncGeneration,
	};
}

/** The commit a recorded outcome names, when the outcome is `committed`. */
function committedSha(value: unknown): string | null {
	const parsed = directCommitOutcomeSchema.safeParse(value);
	return parsed.success && parsed.data.outcome === "committed"
		? parsed.data.sha
		: null;
}

// ---------------------------------------------------------------------------
// The fallback: the same rows, as a pull request
// ---------------------------------------------------------------------------

/**
 * The branch refused the push or kept moving: admit the SAME snapshot rows as
 * a REPOSITORY proposal on the member's branch (QUEUED, the commit's own
 * attribution and message as the v2 context), then join and wake the member's
 * branch workflow, which opens the pull request. The rows already passed the
 * scan; nothing is validated again.
 */
async function fallBackToPullRequest(
	row: DirectCommitSnapshotRow,
	context: DirectCommitContext,
	reason: "protected" | "busy",
): Promise<DirectCommitResult> {
	const operationId = `commit-${row.id}`;
	const proposalContext: PullRequestContextV2 = {
		v: 2,
		integrationId: context.integrationId,
		syncId: context.syncId,
		syncGeneration: context.syncGeneration,
		provider: context.provider,
		targetRef: context.targetRef,
		rootPath: context.rootPath,
		baseCommitSha: context.baseCommitSha,
		repository: context.repository,
		author: context.author,
		committer: context.committer,
		message: context.message,
		committedAt: context.committedAt,
	};
	await admitDirectCommitAsProposal({
		snapshotId: row.id,
		projectId: row.projectId,
		organizationId: row.organizationId,
		actorUserId: row.userId,
		operationId,
		context: proposalContext,
		reason,
	});
	const settled = await getDirectCommitSnapshot({
		snapshotId: row.id,
		organizationId: row.organizationId,
	});
	if (settled) {
		await startProposal(settled);
	}
	return {
		kind: "settled",
		outcome: { outcome: "pull-request", operationId, reason },
	};
}

/**
 * Joins the member's accepting branch and wakes its workflow for a snapshot
 * that became a proposal: idempotent, so a retry after the join or the wake
 * failed finishes the hand-off. Never throws for a proposal the join refuses
 * (`not_joinable`, or blocked by the join itself): the branch machinery owns
 * what happens to it from there.
 */
async function startProposal(row: DirectCommitSnapshotRow): Promise<void> {
	if (row.proposalDestination !== "REPOSITORY") {
		return;
	}
	const joined = await joinProposalBranch({
		snapshotId: row.id,
		organizationId: row.organizationId,
		naming: NAMING,
	});
	if (joined.kind !== "joined" && joined.kind !== "already") {
		return;
	}
	await wakeBranchWorkflow({
		branchId: joined.branchId,
		projectId: row.projectId,
		organizationId: row.organizationId,
	});
}
