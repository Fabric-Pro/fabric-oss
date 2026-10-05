/**
 * Reverting a commit on a repository-backed project's synced branch (Fizzy
 * #2878 §10): "rollback is a revert commit". The commit's own change, within
 * the sync's folder, is undone by ONE new commit on the branch tip, built and
 * pushed by the same loop a direct commit uses (`pushPlanToSyncedBranch`):
 * fetch the tip, recover an earlier attempt's commit, plan, build and verify
 * one commit, re-check the member's authority, push with the lease.
 *
 * The inverse is read from git, not from Fabric's copy: the paths
 * `diff-tree <parent> <commit>` lists under the folder, restored to the entry
 * the parent held (or removed, when the commit added them). Nothing outside
 * the folder is touched, and no byte is re-hashed: the restored blobs are the
 * repository's own.
 *
 * What it refuses, each as its own code and with nothing pushed:
 *  - `REVERT_UNSUPPORTED`: the commit is a merge or a root commit (no single
 *    parent to restore), or it changed a path the rules of a version leave out
 *    (`.fabricignore`, the always-excluded globs, the published version's own
 *    ignore rules): a file Fabric's copy never held, which `snapshotRulesLeaveOut`
 *    names with the same rules the inline editor applies;
 *  - `REVERT_EMPTY`: the commit changed nothing under the folder;
 *  - `REVERT_TOO_LARGE`: more than `MAX_REVERT_ENTRIES` paths, or a restored
 *    file past the per-file limit;
 *  - `REVERT_REJECTED`: a file it would restore has a credential-shaped name or
 *    holds a credential. The secret gate runs on what a revert writes exactly
 *    as on what a person types: reverting the removal of a leaked secret must
 *    not put it back;
 *  - `COMMIT_NOT_ON_BRANCH`: the commit is not part of the tip's history;
 *  - `REVERT_CONFLICT`: the tip's entry at one of the paths is neither the
 *    commit's own nor already the restored one, so someone changed it since.
 *    A path the tip already holds restored is skipped; if every path is, the
 *    revert is `unchanged`.
 *
 * Not exported through the activities barrel: every export of a module the
 * barrel re-exports is a schedulable activity.
 */
import {
	getInstructionRepositorySyncForProposal,
	getProjectInstructionSettings,
	getPublishedInstructionSnapshot,
	recordRevertCommitted,
} from "@repo/database";
import {
	type BranchDestination,
	isSecretFileName,
	renderRevertCommitMessage,
	SNAPSHOT_LIMITS,
	scanTextForSecrets,
	snapshotRulesLeaveOut,
} from "@repo/instructions";
import {
	repositoryIdentity,
	repositoryKey,
} from "@repo/integrations/instruction-pull-requests";
import type {
	ConfirmingSyncInput,
	RevertCommitWorkflowInput,
	RevertCommitWorkflowResult,
} from "../../lib/instruction-direct-commit-types";
import { safeHeartbeat } from "./activity-liveness";
import {
	type BranchCredential,
	withBranchRepoCredential,
} from "./instruction-branch-credential";
import {
	initBranchWorkspace,
	isAncestor,
	readTreeEntries,
} from "./instruction-branch-git";
import { ensureCommit, sameEntry } from "./instruction-branch-support";
import {
	assertDirectCommitAllowed,
	findPushedCommit,
	isLiveCheckRefusal,
	type PlanDecision,
	pushPlanToSyncedBranch,
	type TipContext,
} from "./instruction-direct-commit";
import { ProposalStepFailure } from "./instruction-proposal-boundary";
import type { BranchWritePlanEntry } from "./instruction-proposal-commit";
import { gitCall } from "./instruction-proposal-operation";
import {
	assertObjectId,
	diffTreeEntries,
	type GitCallBase,
	MAX_INVENTORY_ENTRIES,
	readBlobCapped,
	runGit,
} from "./instruction-sync-git";

const PHASE = "append" as const;

/** The most paths one revert restores: a revert is for a change a person can review, not a bulk rewrite. */
export const MAX_REVERT_ENTRIES = 500;

/** How the revert ended, short of an infrastructure fault (those are thrown). */
export type RevertCommitResult = Exclude<
	RevertCommitWorkflowResult,
	{ kind: "failed" }
>;

const fail = (code: ProposalStepFailure["code"], retryable: boolean) =>
	new ProposalStepFailure({ code, phase: PHASE, retryable });

function unhandledResult(result: never): never {
	throw new Error(`Unhandled revert result: ${JSON.stringify(result)}`);
}

/** The commit's parents, in order. */
async function parentsOf(
	i: GitCallBase & { dir: string; sha: string },
): Promise<string[]> {
	assertObjectId(i.sha, "rev-parse");
	const { stdout } = await runGit({
		cwd: i.dir,
		args: ["rev-parse", `${i.sha}^@`],
		env: i.env,
		signal: i.signal,
		label: "rev-parse",
		maxStdoutBytes: 4096,
	});
	const parents = stdout
		.toString("utf8")
		.split("\n")
		.filter((line) => line !== "");
	for (const parent of parents) {
		assertObjectId(parent, "rev-parse");
	}
	return parents;
}

/** The commit's first line, for the revert's own subject. */
async function subjectOf(
	i: GitCallBase & { dir: string; sha: string },
): Promise<string> {
	assertObjectId(i.sha, "log");
	const { stdout } = await runGit({
		cwd: i.dir,
		args: ["log", "-1", "--format=%s", i.sha],
		env: i.env,
		signal: i.signal,
		label: "log",
		maxStdoutBytes: 8192,
	});
	return stdout.toString("utf8");
}

/** Whether `text` is a UTF-8 file with no NUL: the files Fabric scans for credentials. */
function decodeText(bytes: Uint8Array): string | null {
	if (bytes.includes(0)) {
		return null;
	}
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
}

/**
 * Whether restoring `writes` over the tip's tree would put a file where the
 * tip holds a directory, or a file below one the tip holds as a file: the
 * conflicts git itself cannot represent as one entry per path.
 */
function treeConflicts(
	listed: ReadonlyArray<{ path: string | null }>,
	writes: ReadonlyArray<BranchWritePlanEntry>,
): boolean {
	const files = new Set<string>();
	const directories = new Set<string>();
	for (const entry of listed) {
		if (entry.path === null) {
			continue;
		}
		files.add(entry.path);
		const parts = entry.path.split("/");
		for (let n = 1; n < parts.length; n++) {
			directories.add(parts.slice(0, n).join("/"));
		}
	}
	for (const write of writes) {
		if (write.after === null) {
			continue;
		}
		if (directories.has(write.rawPath)) {
			return true;
		}
		const parts = write.rawPath.split("/");
		for (let n = 1; n < parts.length; n++) {
			if (files.has(parts.slice(0, n).join("/"))) {
				return true;
			}
		}
	}
	return false;
}

const pathInRoot = (rootPath: string, path: string) =>
	rootPath === "" || path.startsWith(`${rootPath}/`);

/**
 * The revert of `input.sha` that an earlier attempt already pushed, as the
 * answer that attempt lost: the commit carrying this request's trailer, and
 * the number of paths the reverted commit changed under the folder (what a
 * fresh run records as `fileCount`). Null when the branch holds none.
 */
async function recoverPushedRevert(
	credential: BranchCredential,
	input: RevertCommitWorkflowInput,
	destination: BranchDestination,
): Promise<RevertCommitResult | null> {
	const own = await findPushedCommit(credential, {
		targetRef: destination.targetRef,
		searchFrom: input.sha,
		trailerId: input.requestId,
	});
	if (own === null) {
		return null;
	}
	const git = {
		dir: credential.workDir,
		env: credential.env,
		signal: credential.signal,
	};
	const [parent, ...others] = await gitCall(PHASE, credential, () =>
		parentsOf({ ...git, sha: input.sha }),
	);
	const changed =
		parent === undefined || others.length > 0
			? []
			: (
					await gitCall(PHASE, credential, () =>
						diffTreeEntries({
							...git,
							from: parent,
							to: input.sha,
						}),
					)
				).filter((entry) =>
					pathInRoot(destination.rootPath, entry.path),
				);
	return {
		kind: "reverted",
		sha: own,
		ref: destination.targetRef,
		fileCount: changed.length,
	};
}

export type RevertDestinationFrozen = {
	destination: BranchDestination;
	syncGeneration: number;
};

/** The configuration a revert is made against, read once at the start: the live sync row. */
async function liveDestination(
	i: RevertCommitWorkflowInput,
): Promise<RevertDestinationFrozen> {
	const [sync, settings] = await Promise.all([
		getInstructionRepositorySyncForProposal(i.projectId, i.organizationId),
		getProjectInstructionSettings(i.projectId, i.organizationId),
	]);
	if (
		!sync ||
		settings.sourceOfTruth !== "REPOSITORY" ||
		sync.repositoryIntegration.projectId !== i.projectId
	) {
		throw fail("CONFIGURATION_CHANGED", false);
	}
	const repository = repositoryIdentity(
		sync.repositoryIntegration.provider,
		sync.repositoryIntegration.repositoryUrl,
	);
	if (repository === null) {
		throw fail("REPOSITORY_CHANGED", false);
	}
	return {
		syncGeneration: sync.generation,
		destination: {
			integrationId: sync.repositoryIntegrationId,
			syncId: sync.id,
			repositoryKey: repositoryKey(repository),
			provider: repository.provider,
			repository,
			targetRef: sync.ref,
			rootPath: sync.rootPath,
		},
	};
}

/**
 * The branch holds the revert (`reverted`): record the commit in the audit
 * trail, transactionally and awaited, and name the sync run that takes the
 * new head so the published version follows it (`confirm`: the live sync row,
 * or null when the project has none now; the run is started by the
 * workflow's own activity, `startConfirmingInstructionSync`). Run by its own
 * activity, retried with a bound: the commit cannot be un-pushed, so an audit
 * row that failed to write must not be dropped, and the run's `failed` answer
 * must not be given for a revert the branch holds. Idempotent (the audit
 * write skips a commit it already recorded).
 */
export async function settlePushedRevert(
	input: RevertCommitWorkflowInput,
	reverted: { sha: string; ref: string; fileCount: number },
): Promise<ConfirmingSyncInput | null> {
	await recordRevertCommitted({
		projectId: input.projectId,
		organizationId: input.organizationId,
		actorUserId: input.userId,
		sha: reverted.sha,
		ref: reverted.ref,
		fileCount: reverted.fileCount,
		revertOf: input.sha,
	});
	const sync = await getInstructionRepositorySyncForProposal(
		input.projectId,
		input.organizationId,
	);
	return sync
		? {
				projectId: input.projectId,
				organizationId: input.organizationId,
				syncId: sync.id,
				generation: sync.generation,
			}
		: null;
}

/**
 * Reverts `input.sha` on the synced branch. Throws a `ProposalStepFailure`
 * for infrastructure faults (the activity retries them, then reports a typed
 * `failed`); every outcome that is the revert's own is returned.
 */
export async function runRevertCommit(
	input: RevertCommitWorkflowInput,
	signal: AbortSignal,
): Promise<RevertCommitResult> {
	assertObjectId(input.sha, "rev-parse");
	const { destination, syncGeneration } = await liveDestination(input);
	const { rootPath, targetRef } = destination;
	const allowed = () =>
		assertDirectCommitAllowed({
			projectId: input.projectId,
			organizationId: input.organizationId,
			userId: input.userId,
			destination,
			syncGeneration,
		});
	const branch = {
		id: input.requestId,
		projectId: input.projectId,
		organizationId: input.organizationId,
		userId: input.userId,
		destination,
	};
	let liveRef: string;
	try {
		({ liveRef } = await allowed());
	} catch (refusal) {
		// A retry after a lost acknowledgement: the revert the branch already
		// holds is the answer, whatever the member's rights or the project's
		// mode are now (see `findPushedCommit`).
		if (!isLiveCheckRefusal(refusal)) {
			throw refusal;
		}
		const recovered = await withBranchRepoCredential(
			{ branch, phase: PHASE, signal },
			(credential) => recoverPushedRevert(credential, input, destination),
		);
		if (recovered === null) {
			throw refusal;
		}
		return recovered;
	}

	return withBranchRepoCredential(
		{ branch, phase: PHASE, signal },
		async (credential): Promise<RevertCommitResult> => {
			const git = {
				dir: credential.workDir,
				env: credential.env,
				signal: credential.signal,
			};
			await gitCall(PHASE, credential, () =>
				initBranchWorkspace({
					url: credential.url,
					targetRef,
					dir: credential.workDir,
					env: credential.env,
					signal: credential.signal,
				}),
			);
			await gitCall(PHASE, credential, () =>
				ensureCommit({ ...git, sha: input.sha }),
			);
			safeHeartbeat();

			const parents = await gitCall(PHASE, credential, () =>
				parentsOf({ ...git, sha: input.sha }),
			);
			const parent = parents[0];
			if (parents.length !== 1 || parent === undefined) {
				return { kind: "refused", code: "REVERT_UNSUPPORTED" };
			}

			const changed = (
				await gitCall(PHASE, credential, () =>
					diffTreeEntries({ ...git, from: parent, to: input.sha }),
				)
			).filter((entry) => pathInRoot(rootPath, entry.path));
			if (changed.length === 0) {
				return { kind: "refused", code: "REVERT_EMPTY" };
			}
			if (changed.length > MAX_REVERT_ENTRIES) {
				return { kind: "refused", code: "REVERT_TOO_LARGE" };
			}
			// The rules a version of the instructions is admitted under apply to
			// what a revert touches, as they do to what a person edits inline
			// (`validateInstructionChanges`): `.fabricignore`, the always-excluded
			// globs and the published version's own frozen ignore rules name paths
			// Fabric's copy never held, and restoring or deleting one would change
			// a file the member never saw in Fabric.
			const published = await getPublishedInstructionSnapshot(
				input.projectId,
			);
			const frozen =
				published?.organizationId === input.organizationId
					? published.settingsFrozen
					: null;
			if (
				changed.some((entry) =>
					snapshotRulesLeaveOut(
						rootPath === ""
							? entry.path
							: entry.path.slice(rootPath.length + 1),
						frozen,
					),
				)
			) {
				return { kind: "refused", code: "REVERT_UNSUPPORTED" };
			}
			const rawPaths = changed.map((entry) => entry.path);
			const [committed, restored] = await Promise.all([
				gitCall(PHASE, credential, () =>
					readTreeEntries({ ...git, sha: input.sha, rawPaths }),
				),
				gitCall(PHASE, credential, () =>
					readTreeEntries({ ...git, sha: parent, rawPaths }),
				),
			]);

			// The secret gate on what the revert would write, before anything is
			// built: a credential-shaped name, or a text file with a credential in
			// it. Entries the revert deletes write nothing.
			for (const rawPath of rawPaths) {
				const after = restored.get(rawPath) ?? null;
				if (after === null) {
					continue;
				}
				const relative =
					rootPath === ""
						? rawPath
						: rawPath.slice(rootPath.length + 1);
				if (isSecretFileName(relative) !== null) {
					return { kind: "refused", code: "REVERT_REJECTED" };
				}
				if (after.type !== "blob") {
					continue;
				}
				const bytes = await gitCall(PHASE, credential, () =>
					readBlobCapped({
						...git,
						oid: after.oid,
						maxBytes: SNAPSHOT_LIMITS.maxFileBytes,
					}),
				);
				if (bytes === null) {
					return { kind: "refused", code: "REVERT_TOO_LARGE" };
				}
				const text = decodeText(bytes);
				if (
					text !== null &&
					scanTextForSecrets(text, { limit: 0 }).total > 0
				) {
					return { kind: "refused", code: "REVERT_REJECTED" };
				}
				safeHeartbeat();
			}

			const message = renderRevertCommitMessage({
				subject: await gitCall(PHASE, credential, () =>
					subjectOf({ ...git, sha: input.sha }),
				),
				sha: input.sha,
			});

			const planFor = async (tip: TipContext): Promise<PlanDecision> => {
				const ancestry = await gitCall(PHASE, credential, () =>
					isAncestor({
						...git,
						ancestor: input.sha,
						descendant: tip.tip,
					}),
				);
				if (ancestry === "error") {
					throw fail("GIT_FAILED", false);
				}
				if (ancestry === "false") {
					return { kind: "refused", code: "COMMIT_NOT_ON_BRANCH" };
				}
				const atTip = await gitCall(PHASE, credential, () =>
					readTreeEntries({ ...git, sha: tip.tip, rawPaths }),
				);
				const writes: BranchWritePlanEntry[] = [];
				for (const rawPath of rawPaths) {
					const now = atTip.get(rawPath) ?? null;
					const before = restored.get(rawPath) ?? null;
					if (sameEntry(now, before)) {
						continue;
					}
					if (!sameEntry(now, committed.get(rawPath) ?? null)) {
						return { kind: "refused", code: "REVERT_CONFLICT" };
					}
					writes.push({ rawPath, after: before });
				}
				if (writes.length === 0) {
					return { kind: "unchanged" };
				}
				const listed = await tip.listTree();
				if (listed.length > MAX_INVENTORY_ENTRIES) {
					throw fail("LIMITS_EXCEEDED", false);
				}
				if (treeConflicts(listed, writes)) {
					throw fail("TREE_CONFLICT", false);
				}
				return { kind: "plan", entries: writes };
			};

			const result = await pushPlanToSyncedBranch({
				credential,
				spec: {
					targetRef,
					liveRef,
					rootPath,
					author: input.author,
					committer: input.committer,
					message,
					committedAt: input.committedAt,
					trailerId: input.requestId,
					searchFrom: input.sha,
				},
				assertStillAllowed: allowed,
				planFor,
			});
			switch (result.kind) {
				case "pushed":
					return {
						kind: "reverted",
						sha: result.sha,
						ref: targetRef,
						fileCount: rawPaths.length,
					};
				case "unchanged":
				case "refused":
				case "protected":
				case "busy":
					return result;
				case "branch-moved":
					// The plan never asks for the overlap rule; a conflict is the
					// revert's own `REVERT_CONFLICT`.
					return { kind: "refused", code: "REVERT_CONFLICT" };
				default:
					return unhandledResult(result);
			}
		},
	);
}
