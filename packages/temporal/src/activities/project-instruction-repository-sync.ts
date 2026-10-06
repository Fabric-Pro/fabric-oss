/**
 * Coding Instructions repository sync activities (design 2026-09-23 §5.3,
 * §5.4). The activities barrel re-exports this module, so EVERY export here
 * becomes a schedulable activity: helpers stay unexported or live in ./lib.
 */
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
	type ReadRepositoryBlobSizesInput,
	readRepositoryBlobSizes,
} from "@repo/connectors";
import {
	canCreateProjectInstructions,
	claimInstructionFileStagingKeys,
	clearInstructionSyncPause,
	completeInstructionRepositorySyncRun,
	createInstructionSnapshot,
	getInstructionRepositorySyncForRun,
	getInstructionSnapshotBySyncRunKey,
	getInstructionSnapshotWithPublishedPointer,
	getProjectInstructionSettings,
	getProjectRepoIntegration,
	getPublishedInstructionTree,
	InstructionInheritedSourceError,
	insertInstructionRepositorySyncRun,
	listUnfinishedInstructionRepositorySyncRunReceipts,
	recordAudit,
	rejectAbandonedInstructionSnapshot,
} from "@repo/database";
import {
	ALWAYS_IGNORE_GLOBS,
	classifyPath,
	compileIgnore,
	decodeFabricIgnore,
	type ExcludedPath,
	FABRIC_IGNORE_FILE,
	fileTypingFor,
	type InstructionFileKind,
	instructionSnapshotWorkflowId,
	isStagingKey,
	// The `.fabricignore` read limit, the same 64 KiB `begin` accepts (spec
	// §5.3.2 step 6), shared with the configure dialog's preview (Fizzy #2726).
	MAX_FABRICIGNORE_BYTES,
	mergeExcludedPaths,
	planSnapshotFiles,
	resolveIgnoreGlobs,
	SNAPSHOT_LIMITS,
	snapshotKey,
	stagingKey,
	validateRelativePath,
} from "@repo/instructions";
import { getStorageProvider } from "@repo/storage";
import { ApplicationFailure } from "@temporalio/activity";
import { getTemporalClient } from "../client";
import { runDrainingPool } from "../lib/draining-pool";
import {
	createSyncRunProgress,
	type SyncRunProgress,
} from "../lib/instruction-sync-progress";
import {
	type AcquireTreeResult,
	type AwaitSnapshotSettledInput,
	type AwaitSnapshotSettledResult,
	type BeginSyncRunInput,
	type BeginSyncRunResult,
	type InstructionSyncErrorCode,
	isAutomaticInstructionSyncTrigger,
	type RecordSyncRunInput,
	type RecordSyncRunResult,
	type SnapshotChildResult,
	type SyncFailureDetails,
	type SyncLimitDetail,
	type SyncRunContext,
} from "../lib/instruction-sync-types";
import {
	requestAbortSignal,
	safeHeartbeat,
	withHeartbeatTicker,
} from "./lib/activity-liveness";
import {
	describeSnapshotWorkflow,
	sweepClosedAbandonment,
} from "./lib/instruction-abandonment";
import { settleMigrationAfterSuccessfulRun } from "./lib/instruction-migration-settlement";
import { INSTRUCTIONS_BUCKET } from "./lib/instruction-prune";
import {
	credentialFreeUrl,
	fetchPinnedCommit,
	GitCommandError,
	listTree,
	MAX_CLONE_BYTES,
	MAX_INVENTORY_ENTRIES,
	readBlobCapped,
	revParseHead,
	revParseRootTree,
	sparseCheckout,
} from "./lib/instruction-sync-git";
import {
	deriveSyncRunOutcome,
	type SyncSnapshotState,
} from "./lib/instruction-sync-outcome";
import {
	createSyncRunDir,
	removeSyncRunDir,
} from "./lib/instruction-sync-temp";
import {
	fileModeForGitMode,
	type LsTreeSummary,
	type TreeEntry,
	treesEqual,
	unchangedPublishedFiles,
} from "./lib/instruction-sync-tree";
import {
	cloneWithAuthRecovery as cloneRepositoryWithAuthRecovery,
	gitStepFailureCode,
	logGitFailure,
} from "./lib/repository-sync-clone";

/** Git's share of the 10-minute activity timeout, so a hung transfer dies first. */
const ACQUIRE_GIT_BUDGET_MS = 9 * 60 * 1000;
const UPLOAD_CONCURRENCY = 8;
const STAGING_CLAIM_BATCH_ROWS = 500;
const HEARTBEAT_EVERY_UPLOADS = 50;
const SETTLE_WAIT_MS = 10 * 60 * 1000;
const SETTLE_POLL_MS = 5_000;

/**
 * A typed acquisition failure (spec §5.5, §8.3): a fixed message, the enum
 * as `type`, and details that carry no user content. Never `cause`.
 */
function syncFailure(
	code: InstructionSyncErrorCode,
	details: SyncFailureDetails = {},
	nonRetryable?: boolean,
): ApplicationFailure {
	return ApplicationFailure.create({
		type: code,
		message: `Repository sync failed: ${code}`,
		details: [details],
		...(nonRetryable === undefined ? {} : { nonRetryable }),
	});
}

/**
 * The disk watchdog watches the whole run directory (the blobless clone, its
 * file listing and the checkout), not the folder, so its limit is the sync's
 * download and disk budget.
 */
const REPOSITORY_SIZE_LIMIT: SyncLimitDetail = {
	kind: "repositorySize",
	max: MAX_CLONE_BYTES,
};

/**
 * `syncFailure` for a code a git step produced: LIMITS_EXCEEDED from git can
 * only be the disk watchdog, which carries the repository-size limit.
 */
function gitSyncFailure(
	code: InstructionSyncErrorCode,
	details: SyncFailureDetails,
	nonRetryable?: boolean,
): ApplicationFailure {
	return syncFailure(
		code,
		code === "LIMITS_EXCEEDED"
			? { ...details, limit: REPOSITORY_SIZE_LIMIT }
			: details,
		nonRetryable,
	);
}

// ---------------------------------------------------------------------------
// begin (§5.3.1)
// ---------------------------------------------------------------------------

export async function beginInstructionRepositorySyncRun(
	input: BeginSyncRunInput,
): Promise<BeginSyncRunResult> {
	// Unscoped read, then the tenant check: the row must name the
	// organization the starter resolved, or it is not this run's to act on.
	const row = await getInstructionRepositorySyncForRun(input.projectId);
	if (!row || row.organizationId !== input.organizationId) {
		return { ok: false, error: "NOT_CONFIGURED" };
	}
	// MANUAL acts as whoever pressed the button; automatic runs act as the
	// delegate on the row NOW, so a run queued before a re-configure acts as
	// the new delegate against the new configuration.
	const actingUserId =
		input.trigger === "MANUAL" ? input.requesterUserId : row.userId;
	if (!actingUserId) {
		throw ApplicationFailure.nonRetryable(
			"A manual repository sync needs the requesting member",
			"INSTRUCTION_SYNC_INPUT_INVALID",
		);
	}
	const context: SyncRunContext = {
		projectId: row.projectId,
		organizationId: row.organizationId,
		syncId: row.id,
		generation: row.generation,
		repositoryIntegrationId: row.repositoryIntegrationId,
		ref: row.ref,
		rootPath: row.rootPath,
		actingUserId,
		trigger: input.trigger,
		runKey: `${row.id}:${input.workflowRunId}`,
	};
	// The receipt goes in FIRST (plan Decision 4), so every outcome below,
	// refusals included, has a run row for `record` to complete and the tab
	// to show.
	const receipt = await insertInstructionRepositorySyncRun({
		id: context.runKey,
		syncId: row.id,
		projectId: row.projectId,
		organizationId: row.organizationId,
		userId: actingUserId,
		generation: row.generation,
		trigger: input.trigger,
		startedAt: new Date(),
	});
	if (receipt.generation !== row.generation) {
		// A retry of begin after a re-configure: this run belongs to the
		// configuration it was first recorded under, and must not act for the
		// new one (plan Decision 5).
		return {
			ok: false,
			error: "CONFIGURATION_CHANGED",
			context: { ...context, generation: receipt.generation },
		};
	}
	if (row.automaticPausedReason === "MIGRATING") {
		// The project is being moved from uploads into this repository (Fizzy
		// #2878 §9): the row exists for the move's pull request, and nothing
		// may sync from the folder before that pull request merges, whoever
		// asked and however. A manual run is skipped too: the folder holds
		// nothing yet, and publishing from it would replace the uploads with
		// an empty tree. The move clears the pause itself when the pull
		// request merges.
		return { ok: false, skipped: "paused", context };
	}
	if (isAutomaticInstructionSyncTrigger(input.trigger)) {
		// Eligibility is checked before `expected`: a configure that turns
		// automatic sync off may also re-point the row (a new repository,
		// branch, folder or ignore rules bump the generation; the toggle alone
		// keeps it, Fizzy #2744), and the poll/webhook always pass `expected`
		// from the row they read. Checking `expected` first would turn such a
		// flip after a poll/webhook already started into a warning-severity
		// CONFIGURATION_CHANGED failure instead of the intended SKIPPED
		// outcome (plan Decision 47).
		if (!row.automatic) {
			return { ok: false, skipped: "automatic_disabled", context };
		}
		if (row.automaticPausedReason !== null) {
			return { ok: false, skipped: "paused", context };
		}
	}
	let pausedReason = row.automaticPausedReason;
	if (
		input.trigger === "COMMIT_PUSHED" &&
		(pausedReason === "REF_MISSING" ||
			pausedReason === "PERMISSION_REVOKED") &&
		(input.expected === undefined ||
			(input.expected.syncId === row.id &&
				input.expected.generation === row.generation)) &&
		(pausedReason === "REF_MISSING" ||
			(await canCreateProjectInstructions(row.projectId, actingUserId)))
	) {
		// A commit that has just been pushed to the synced branch with the
		// integration's credential proves what these two pauses doubt: the
		// ref exists and the credential still works. A run that waited for a
		// member to clear them would leave the published version behind a
		// commit the branch holds, and the next member to read it would take
		// the stale copy for the branch. The delegate's own right is not
		// proved by a push (the committer is another member), so a
		// PERMISSION_REVOKED pause lifts only while the delegate can write
		// now. Only for the row the commit was made against, so a pause a
		// re-configure wrote for a newer configuration is never lifted by an
		// older commit; MIGRATING and every later pause stay.
		if (
			await clearInstructionSyncPause({
				syncId: row.id,
				organizationId: row.organizationId,
				generation: row.generation,
				reason: pausedReason,
			})
		) {
			pausedReason = null;
		}
	}
	if (
		(input.trigger === "PULL_REQUEST_MERGED" ||
			input.trigger === "COMMIT_PUSHED") &&
		pausedReason !== null
	) {
		// A merged proposal's sync bypasses the automatic toggle but not a
		// pause (Fizzy #2563 spec §9, plan R3): the pause is a failure a
		// member must clear, and the merge-sync dispatcher retries until the
		// request is acknowledged or given up. A direct commit's confirming
		// sync (Fizzy #2878 §10) is the same, except for the two pauses a
		// pushed commit disproves (above): it is what publishes the new head
		// for the agents and the Files tab, so a pause it cannot lift (the
		// delegate cannot write, the row was re-configured) skips it, and
		// the pause's own remedy is what resumes the sync.
		return { ok: false, skipped: "paused", context };
	}
	if (
		input.expected !== undefined &&
		(input.expected.syncId !== row.id ||
			input.expected.generation !== row.generation)
	) {
		// An automatic start decided on a row that has since been replaced or
		// re-configured (PR 2 Decision 56). The receipt above is this run's
		// row, and `record` completes it FAILED with no scheduling effect. The
		// re-configure made the sync due now, so the next check starts the run
		// for the configuration that is current.
		return { ok: false, error: "CONFIGURATION_CHANGED", context };
	}
	if (
		row.repositoryIntegration.status !== "ACTIVE" ||
		row.repositoryIntegration.projectId !== row.projectId
	) {
		// The `expected` check stays above this one: a mismatch caught here
		// on a broken integration would back off the new generation instead of
		// surfacing the configuration change (plan Decision 56).
		return { ok: false, error: "INTEGRATION_UNAVAILABLE", context };
	}
	if (!(await canCreateProjectInstructions(row.projectId, actingUserId))) {
		return { ok: false, error: "PERMISSION_DENIED", context };
	}
	return { ok: true, context };
}

// ---------------------------------------------------------------------------
// acquire (§5.3.2)
// ---------------------------------------------------------------------------

type AdoptedRow = NonNullable<
	Awaited<ReturnType<typeof getInstructionSnapshotBySyncRunKey>>
>;

type PlannedSyncFile = {
	/** The stored, validated path. */
	path: string;
	/** The byte-exact repository path: sparse pattern and `lstat` use it. */
	repoPath: string;
	mode: number;
	kind: InstructionFileKind;
	mimeType: string;
	isText: boolean;
	/** Adopting only: the row this file already has. */
	adopted?: {
		fileId: string;
		storageKey: string;
		sha256: string;
		/** Inherited from a published row: it has no bytes of its own to stage. */
		inherited: boolean;
	};
};

/** The facts of a published row a new snapshot needs to inherit it. */
type InheritableFile = {
	id: string;
	size: number;
	sha256: string;
	mimeType: string;
	isText: boolean;
	storageKey: string;
};

type MeasuredFile = PlannedSyncFile & {
	size: number;
	sha256: string;
	full: string;
};

type Progress = {
	phase: string;
	entries: number;
	kept: number;
	uploaded: number;
};

export async function acquireInstructionTreeFromRepository(
	context: SyncRunContext,
): Promise<AcquireTreeResult> {
	// Heartbeat details are counters only (spec §5.3.2): the ticker sends
	// this object as it changes.
	const progress: Progress = {
		phase: "start",
		entries: 0,
		kept: 0,
		uploaded: 0,
	};
	const syncProgress = createSyncRunProgress(context);
	return withHeartbeatTicker<AcquireTreeResult>(
		async () => {
			let adopted = await getInstructionSnapshotBySyncRunKey(
				context.runKey,
				context.projectId,
				context.organizationId,
			);
			if (adopted && adopted.status !== "RECEIVING") {
				// Staged already; the child owns the verdict (§5.2 step 3).
				return stagedResult(adopted);
			}
			const integration = await getProjectRepoIntegration(
				context.repositoryIntegrationId,
				context.projectId,
			);
			const url = integration
				? credentialFreeUrl(integration.repositoryUrl)
				: null;
			if (
				!integration ||
				integration.status !== "ACTIVE" ||
				url === null
			) {
				throw syncFailure(
					"INTEGRATION_UNAVAILABLE",
					adoptedDetails(adopted),
					true,
				);
			}
			const runDir = await createSyncRunDir();
			try {
				// At most one restart: losing the create race to a concurrent
				// attempt of this same run turns this attempt into an adoption
				// of the winner's row (plan Decision 12).
				for (let pass = 0; pass < 2; pass++) {
					const step = await acquireOnce({
						context,
						provider: integration.provider,
						repository: {
							provider: integration.provider,
							repositoryUrl: integration.repositoryUrl,
							owner: integration.repositoryOwner,
							repo: integration.repositoryName,
							azureOrganization: integration.azureOrganization,
						},
						url,
						runDir,
						dir: path.join(runDir, `repo-${pass}`),
						adopted,
						progress,
						syncProgress,
					});
					if (step.kind === "done") {
						return step.result;
					}
					adopted = step.adopted;
					if (adopted.status !== "RECEIVING") {
						return stagedResult(adopted);
					}
				}
				throw syncFailure("CLONE_FAILED", adoptedDetails(adopted));
			} finally {
				await removeSyncRunDir(runDir).catch(() => {});
			}
		},
		{ details: progress },
	);
}

function stagedResult(adopted: AdoptedRow): AcquireTreeResult {
	return {
		outcome: "staged",
		snapshotId: adopted.id,
		commitSha: adopted.sourceCommitSha,
		...(adopted.validationAttemptId
			? { validationAttemptId: adopted.validationAttemptId }
			: {}),
	};
}

function adoptedDetails(adopted: AdoptedRow | null): SyncFailureDetails {
	return adopted ? { snapshotId: adopted.id } : {};
}

async function acquireOnce(input: {
	context: SyncRunContext;
	provider: string;
	repository: BlobSizeRepository;
	url: string;
	runDir: string;
	dir: string;
	adopted: AdoptedRow | null;
	progress: Progress;
	syncProgress: SyncRunProgress;
}): Promise<
	| { kind: "done"; result: AcquireTreeResult }
	| { kind: "adopt"; adopted: AdoptedRow }
> {
	const { context, adopted, dir, progress, syncProgress } = input;
	const signal = requestAbortSignal(ACQUIRE_GIT_BUDGET_MS);
	const baseDetails = adoptedDetails(adopted);
	await syncProgress.phase("FETCHING");
	const { env, token } = await cloneWithAuthRecovery({
		...input,
		signal,
		details: baseDetails,
	});
	const git = <T>(fn: () => Promise<T>, details: SyncFailureDetails) =>
		gitStep(fn, details, [token]);

	if (adopted) {
		const pinned = adopted.sourceCommitSha;
		if (!pinned) {
			throw syncFailure("CLONE_FAILED", baseDetails);
		}
		await git(
			() => fetchPinnedCommit({ dir, sha: pinned, env, signal }),
			baseDetails,
		);
	}
	const commitSha = await git(
		() => revParseHead({ dir, env, signal }),
		baseDetails,
	);
	const details: SyncFailureDetails = { commitSha, ...baseDetails };
	progress.phase = "cloned";
	safeHeartbeat(progress);
	await syncProgress.phase("PREPARING");

	const published = adopted
		? null
		: await getPublishedInstructionTree(
				context.projectId,
				context.organizationId,
			);
	if (
		published &&
		published.sourceCommitSha === commitSha &&
		provenanceMatches(published, context) &&
		frozenPairMatches(published.settingsFrozen, context) &&
		!publishedTreeNeedsRepair(published.files)
	) {
		return { kind: "done", result: { outcome: "unchanged", commitSha } };
	}

	const listed = await git(
		() =>
			listTree({
				dir,
				rootPath: context.rootPath,
				env,
				signal,
				maxEntries: MAX_INVENTORY_ENTRIES,
			}),
		details,
	);
	if (!listed.ok) {
		throw syncFailure("LIMITS_EXCEEDED", {
			...details,
			limit: { kind: "inventory", max: MAX_INVENTORY_ENTRIES },
		});
	}
	const inventory = listed.summary;
	if (context.rootPath !== "" && inventory.underRoot === 0) {
		throw syncFailure("ROOT_MISSING", details);
	}
	progress.phase = "inventoried";
	progress.entries = inventory.underRoot;
	safeHeartbeat(progress);

	const planned = adopted
		? {
				plan: planAdopted(adopted, inventory, details),
				excludedCount: 0,
				excludedPaths: [],
				ignore: null,
			}
		: await planFresh({
				context,
				dir,
				env,
				signal,
				inventory,
				details,
				git,
			});

	await checkoutKeptFiles({
		dir,
		plan: planned.plan,
		env,
		signal,
		details,
		git,
		sizes: { repository: input.repository, token, commitSha },
	});
	progress.phase = "checked_out";
	progress.kept = planned.plan.length;
	safeHeartbeat(progress);

	const measured = await measure(dir, planned.plan, details);
	if (adopted && measured.some((f) => f.sha256 !== f.adopted?.sha256)) {
		// The pinned commit did not reproduce the adopted row.
		throw syncFailure("CLONE_FAILED", details);
	}

	let snapshotId: string;
	let validationAttemptId: string | null;
	let rows: Array<{ fileId: string; storageKey: string; file: MeasuredFile }>;
	if (adopted) {
		snapshotId = adopted.id;
		validationAttemptId = adopted.validationAttemptId;
		// An inherited row carries its source's promoted key and needs no
		// bytes staged; only the rows this run uploads are staged.
		rows = measured
			.filter((file) => file.adopted?.inherited !== true)
			.map((file) => ({
				fileId: file.adopted?.fileId as string,
				storageKey: file.adopted?.storageKey as string,
				file,
			}));
	} else {
		if (
			published &&
			provenanceMatches(published, context) &&
			treesEqual(
				measured.map(({ path: p, sha256, mode }) => ({
					path: p,
					sha256,
					mode,
				})),
				published.files,
			)
		) {
			return {
				kind: "done",
				result: { outcome: "unchanged", commitSha },
			};
		}
		const ignore = planned.ignore as NonNullable<typeof planned.ignore>;
		// Files byte-identical to the published version's are INHERITED from it
		// instead of staged, so a sync that changed one file of a thousand
		// uploads one. Only a published version this sync's own source produced
		// is a base (the same provenance the "unchanged" answer above needs).
		const inheritable: Map<string, InheritableFile> =
			published && provenanceMatches(published, context)
				? unchangedPublishedFiles(measured, published.files)
				: new Map();
		const createSnapshot = (inherit: Map<string, InheritableFile>) =>
			createInstructionSnapshot({
				projectId: context.projectId,
				organizationId: context.organizationId,
				userId: context.actingUserId,
				source: "REPOSITORY",
				repositoryIntegrationId: context.repositoryIntegrationId,
				sourceRef: context.ref,
				sourceCommitSha: commitSha,
				syncRunKey: context.runKey,
				// The row is created with the token its child workflow will
				// carry: the acquisition starts the checks itself, so there is
				// no finalize to write one later.
				validationAttemptId: randomUUID(),
				publishOnReady: true,
				excludedCount: planned.excludedCount,
				excludedPaths: planned.excludedPaths,
				settingsFrozen: {
					ignoreGlobs: ignore.globs,
					layer: ignore.layer,
					limits: SNAPSHOT_LIMITS,
					rootPath: context.rootPath,
					syncId: context.syncId,
					syncGeneration: context.generation,
				},
				promotedKeyFor: (sourceSnapshotId, sourceFileId) =>
					snapshotKey(
						context.projectId,
						sourceSnapshotId,
						sourceFileId,
					),
				files: measured.map((f, i) => {
					const source = inherit.get(f.path);
					return source
						? {
								path: f.path,
								size: source.size,
								sha256: source.sha256,
								mimeType: source.mimeType,
								isText: source.isText,
								kind: f.kind,
								storageKey: source.storageKey,
								mode: f.mode,
								inheritedFromFileId: source.id,
							}
						: {
								path: f.path,
								size: f.size,
								sha256: f.sha256,
								mimeType: f.mimeType,
								isText: f.isText,
								kind: f.kind,
								storageKey: stagingKey(
									context.projectId,
									"pending",
									String(i),
								),
								mode: f.mode,
							};
				}),
			});
		// A published row that no longer qualifies as a source by the time the
		// snapshot is written (pruned or replaced between the read and the
		// write) costs the saving, never the sync: the whole tree is staged.
		let inherited = inheritable;
		const created = await createSnapshot(inherited).catch((error) => {
			if (!(error instanceof InstructionInheritedSourceError)) {
				throw error;
			}
			inherited = new Map();
			return createSnapshot(inherited);
		});
		if (created.existing) {
			const winner = await getInstructionSnapshotBySyncRunKey(
				context.runKey,
				context.projectId,
				context.organizationId,
			);
			if (!winner) {
				throw syncFailure("CLONE_FAILED", details);
			}
			return { kind: "adopt", adopted: winner };
		}
		snapshotId = created.id;
		validationAttemptId = created.validationAttemptId;
		const byPath = new Map(measured.map((f) => [f.path, f]));
		rows = created.files
			.filter((row) => !inherited.has(row.path))
			.map((row) => ({
				fileId: row.id,
				storageKey: row.storageKey,
				file: byPath.get(row.path) as MeasuredFile,
			}));
		recordAudit({
			action: "project.instructions.upload_started",
			category: "project",
			actor: { type: "user", userId: context.actingUserId },
			organizationId: context.organizationId,
			projectId: context.projectId,
			resource: {
				type: "project_instruction_snapshot",
				id: created.id,
				name: `v${created.version}`,
			},
			metadata: {
				keptCount: measured.length,
				inheritedCount: inherited.size,
				excludedCount: planned.excludedCount,
				layer: ignore.layer,
				mode: "repository",
				trigger: context.trigger,
			},
		});
	}

	await stageBytes({
		context,
		snapshotId,
		rows,
		signal,
		details: { ...details, snapshotId },
		progress,
		syncProgress,
	});
	return {
		kind: "done",
		result: {
			outcome: "staged",
			snapshotId,
			commitSha,
			...(validationAttemptId ? { validationAttemptId } : {}),
		},
	};
}

/**
 * The always-excluded layer has no version: `settingsFrozen` records the
 * configuration a version was published under, not the built-in list it was
 * filtered through. When that list grows (`.fabric/**`, Fizzy #2704), a
 * version published earlier can hold a path the server no longer publishes,
 * and the same-commit shortcut above would keep it forever, since no new
 * commit ever arrives to force a planning pass. So the shortcut also asks
 * whether the published tree still passes the CURRENT always layer; one
 * planning pass then re-publishes without the path, and the next sync of
 * the same commit is unchanged again (Fizzy #2705).
 *
 * Only the always layer: the project's own rules ARE versioned, through the
 * `(syncId, generation)` pair a re-configure bumps.
 *
 * A repair needs something left to publish. Same commit and same pair mean
 * the planning pass keeps exactly the published set minus the newly
 * excluded paths, so a tree made ONLY of such paths would plan to nothing,
 * be refused (`nothing_kept`), and be refused again on every later sync.
 * That tree stays "unchanged": the stale version is refused by the CLI
 * either way, and only a change to the repository can fix it. This relies on
 * the always list only ever growing, which is its history so far; if a rule
 * is ever removed or narrowed, a planning pass could keep a file the
 * published set lacks, and the excluded-only shortcut must be revisited.
 */
const alwaysExcluded = compileIgnore(ALWAYS_IGNORE_GLOBS);

function publishedTreeNeedsRepair(files: readonly { path: string }[]): boolean {
	let stale = false;
	let kept = false;
	for (const file of files) {
		if (alwaysExcluded(file.path) === null) {
			kept = true;
		} else {
			stale = true;
		}
	}
	return stale && kept;
}

/**
 * Whether the published snapshot was published by a repository sync from
 * THIS sync's integration and branch (Fizzy #2708 review).
 *
 * Identical bytes are not enough to call a run "unchanged": after the sync is
 * re-pointed at another branch or repository, or after an upload is replaced
 * by a sync, the published snapshot's provenance still names the old source,
 * so the API reports it `current: false` (or not repository-built at all) and
 * every checkout of the new branch is told nothing has been published from
 * it. Publishing a new snapshot with the same bytes and the new provenance is
 * what makes that true. `rootPath` is deliberately not compared: a snapshot
 * does not record it, and the published commit is still on the same branch,
 * so `current` stays correct across a root-path change.
 */
function provenanceMatches(
	published: {
		source: string;
		repositoryIntegrationId: string | null;
		sourceRef: string | null;
	},
	context: SyncRunContext,
): boolean {
	return (
		published.source === "REPOSITORY" &&
		published.repositoryIntegrationId === context.repositoryIntegrationId &&
		published.sourceRef === context.ref
	);
}

function frozenPairMatches(
	settingsFrozen: unknown,
	context: SyncRunContext,
): boolean {
	if (settingsFrozen === null || typeof settingsFrozen !== "object") {
		return false;
	}
	const frozen = settingsFrozen as {
		syncId?: unknown;
		syncGeneration?: unknown;
	};
	return (
		frozen.syncId === context.syncId &&
		frozen.syncGeneration === context.generation
	);
}

/** This sync's names for its git failures in the debug log. */
const INSTRUCTION_SYNC_GIT_LOG = {
	event: "instructions.sync.git_failed",
	message: "[InstructionSync] git command failed",
} as const;

/** Git failures after the clone: the watchdog is a limit, everything else is a failed fetch. */
async function gitStep<T>(
	fn: () => Promise<T>,
	details: SyncFailureDetails,
	secrets: readonly string[],
): Promise<T> {
	try {
		return await fn();
	} catch (error) {
		logGitFailure(error, secrets, INSTRUCTION_SYNC_GIT_LOG);
		throw gitSyncFailure(gitStepFailureCode(error), details);
	}
}

/**
 * The clone, with the code-indexing clone's self-heal (spec §5.3.2 step 3):
 * `cloneWithAuthRecovery`, shared with the Living Memory sync.
 */
function cloneWithAuthRecovery(input: {
	context: SyncRunContext;
	provider: string;
	url: string;
	runDir: string;
	dir: string;
	signal: AbortSignal;
	details: SyncFailureDetails;
}): Promise<{ env: NodeJS.ProcessEnv; token: string }> {
	const { context } = input;
	return cloneRepositoryWithAuthRecovery({
		integrationId: context.repositoryIntegrationId,
		projectId: context.projectId,
		userId: context.actingUserId,
		organizationId: context.organizationId,
		ref: context.ref,
		provider: input.provider,
		url: input.url,
		runDir: input.runDir,
		dir: input.dir,
		signal: input.signal,
		log: INSTRUCTION_SYNC_GIT_LOG,
		reauthReason:
			"Repository authentication failed during a coding-instructions sync; reconnect required.",
		// Retrying cannot help once a forced re-exchange failed (plan Decision 16).
		fail: (code, nonRetryable) =>
			gitSyncFailure(code, input.details, nonRetryable),
	});
}

/** Spec §5.3.2 steps 6-7: `.fabricignore` from the inventory, then the shared planner. */
async function planFresh(input: {
	context: SyncRunContext;
	dir: string;
	env: NodeJS.ProcessEnv;
	signal: AbortSignal;
	inventory: LsTreeSummary;
	details: SyncFailureDetails;
	git: <T>(fn: () => Promise<T>, details: SyncFailureDetails) => Promise<T>;
}): Promise<{
	plan: PlannedSyncFile[];
	excludedCount: number;
	/**
	 * The files the ignore rules left out, by name. The count also holds what
	 * the inventory skipped (symlinks, submodules) and a dropped `.fabricignore`,
	 * which have no rule to name, so the list can be shorter than the count.
	 */
	excludedPaths: ExcludedPath[];
	ignore: ReturnType<typeof resolveIgnoreGlobs>;
}> {
	const { context, details } = input;
	let candidates: readonly TreeEntry[] = input.inventory.files;
	let dropped = 0;
	let fabricIgnoreText: string | null = null;
	const ignoreEntry = candidates.find(
		(f) => f.relPath === FABRIC_IGNORE_FILE,
	);
	if (ignoreEntry) {
		const bytes = await input.git(
			() =>
				readBlobCapped({
					dir: input.dir,
					oid: ignoreEntry.oid,
					env: input.env,
					signal: input.signal,
					maxBytes: MAX_FABRICIGNORE_BYTES,
				}),
			details,
		);
		if (bytes === null) {
			// Over the limit: its rules are not applied, so the file must not
			// be stored either, or the gate's provenance check rejects the
			// version as `ignore_mismatch` (plan Decision 9).
			candidates = candidates.filter((f) => f !== ignoreEntry);
			dropped = 1;
		} else {
			// Not valid UTF-8: no rules are frozen from it, and the file stays
			// in the set so the gate refuses it as `ignore_encoding`, the same
			// verdict the browser's upload gets.
			const decoded = decodeFabricIgnore(bytes);
			fabricIgnoreText = decoded.ok ? decoded.text : null;
		}
	}
	const settings = await getProjectInstructionSettings(
		context.projectId,
		context.organizationId,
	);
	const ignore = resolveIgnoreGlobs({
		fabricIgnoreText,
		projectGlobs: settings.ignoreGlobs,
	});
	const result = planSnapshotFiles({
		files: candidates.map((entry) => ({ path: entry.relPath, entry })),
		ignore,
	});
	if (!result.ok) {
		if (result.refusal.code === "too_many_files") {
			throw syncFailure("LIMITS_EXCEEDED", {
				...details,
				keptCount: result.refusal.count,
				limit: {
					kind: "fileCount",
					actual: result.refusal.count,
					max: result.refusal.max,
				},
			});
		}
		throw syncFailure("TREE_REFUSED", {
			...details,
			refusal: result.refusal.code,
		});
	}
	return {
		plan: result.kept.map((k) => ({
			path: k.path,
			repoPath: k.source.entry.repoPath,
			mode: fileModeForGitMode(k.source.entry.gitMode),
			kind: k.kind,
			mimeType: k.mimeType,
			isText: k.isText,
		})),
		excludedCount:
			input.inventory.excludedCount + result.excluded.length + dropped,
		excludedPaths: mergeExcludedPaths(result.excluded),
		ignore,
	};
}

/**
 * Adopting: the plan is the row's own files. Each stored path is mapped back
 * to its repository path through the same `validateRelativePath` the
 * planner used, so a backslash path finds its file again (plan Decision 11).
 */
function planAdopted(
	adopted: AdoptedRow,
	inventory: LsTreeSummary,
	details: SyncFailureDetails,
): PlannedSyncFile[] {
	const byStoredPath = new Map<string, TreeEntry | null>();
	for (const entry of inventory.files) {
		const v = validateRelativePath(entry.relPath);
		if (v.ok) {
			byStoredPath.set(v.path, byStoredPath.has(v.path) ? null : entry);
		}
	}
	return adopted.files.map((row) => {
		const entry = byStoredPath.get(row.path);
		if (!entry) {
			throw syncFailure("CLONE_FAILED", details);
		}
		return {
			path: row.path,
			repoPath: entry.repoPath,
			mode: row.mode ?? fileModeForGitMode(entry.gitMode),
			kind: classifyPath(row.path),
			mimeType: row.mimeType,
			isText: fileTypingFor(row.path).isText,
			adopted: {
				fileId: row.id,
				storageKey: row.storageKey,
				sha256: row.sha256,
				inherited: typeof row.inheritedFromFileId === "string",
			},
		};
	});
}

/**
 * Spec §5.3.2 step 8: check out exactly the kept files.
 *
 * The disk watchdog cannot tell whose bytes it counted: the clone, or the
 * kept files being checked out beside it. A kept set past the snapshot's own
 * limits trips it long before `measure` could judge them, and it was then
 * reported as a `repositorySize` overflow, sending the person to shrink a
 * repository that was never the problem. The listing carries no sizes (a
 * blobless clone would fetch every blob to give them), so when the watchdog
 * trips the kept files that reached the disk are measured instead: a file
 * past the per-file limit, or a total past the total limit, is that limit.
 * `actual` is left out, because the checkout was stopped and the files on
 * disk are a lower bound, not the size. Anything else is a genuine
 * repository-budget overflow and keeps `repositorySize`.
 *
 * The provider's tree API does know every file's size (GitHub's trees and
 * Azure DevOps's `Trees - Get` carry it), so on a trip it is asked first and
 * `actual` is the exact largest file or total. Only when it cannot answer
 * (GitLab, a truncated or failed listing, a kept file it does not list) is
 * the figure the disk's lower bound, and it says so with `atLeast`.
 */
async function checkoutKeptFiles(input: {
	dir: string;
	plan: readonly PlannedSyncFile[];
	env: NodeJS.ProcessEnv;
	signal: AbortSignal;
	details: SyncFailureDetails;
	git: <T>(fn: () => Promise<T>, details: SyncFailureDetails) => Promise<T>;
	sizes: BlobSizeSource;
}): Promise<void> {
	const { dir, plan, details } = input;
	const exceeded: { limit: SyncLimitDetail | null } = { limit: null };
	try {
		await input.git(async () => {
			try {
				await sparseCheckout({
					dir,
					repoPaths: plan.map((f) => f.repoPath),
					env: input.env,
					signal: input.signal,
				});
			} catch (error) {
				if (
					error instanceof GitCommandError &&
					error.kind === "disk_limit"
				) {
					exceeded.limit = await keptSetLimit({
						dir,
						plan,
						env: input.env,
						signal: input.signal,
						sizes: input.sizes,
					});
				}
				throw error;
			}
		}, details);
	} catch (error) {
		if (exceeded.limit) {
			throw syncFailure("LIMITS_EXCEEDED", {
				...details,
				limit: exceeded.limit,
			});
		}
		throw error;
	}
}

type BlobSizeRepository = Omit<
	ReadRepositoryBlobSizesInput,
	"token" | "commitSha" | "rootTreeId"
>;

type BlobSizeSource = {
	repository: BlobSizeRepository;
	token: string;
	commitSha: string;
};

/**
 * The size of every kept file as the provider reports it, or null when it
 * cannot report all of them: an unsupported provider, a failed or truncated
 * listing, or a kept file it does not list.
 */
async function providerKeptSizes(input: {
	dir: string;
	plan: readonly PlannedSyncFile[];
	env: NodeJS.ProcessEnv;
	signal: AbortSignal;
	sizes: BlobSizeSource;
}): Promise<number[] | null> {
	const { repository, token, commitSha } = input.sizes;
	let rootTreeId = "";
	if (repository.provider === "AZURE_DEVOPS") {
		rootTreeId = await revParseRootTree({
			dir: input.dir,
			env: input.env,
			signal: input.signal,
		}).catch(() => "");
		if (rootTreeId === "") {
			return null;
		}
	}
	const listed = await readRepositoryBlobSizes({
		...repository,
		token,
		commitSha,
		rootTreeId,
	});
	if (!listed.ok || !listed.complete) {
		return null;
	}
	const sizes: number[] = [];
	for (const file of input.plan) {
		const size = listed.sizes.get(file.repoPath);
		if (size === undefined) {
			return null;
		}
		sizes.push(size);
	}
	return sizes;
}

function limitOf(
	largest: number,
	total: number,
	exact: boolean,
): SyncLimitDetail | null {
	const kind =
		largest > SNAPSHOT_LIMITS.maxFileBytes
			? ("fileSize" as const)
			: total > SNAPSHOT_LIMITS.maxTotalBytes
				? ("totalSize" as const)
				: null;
	if (kind === null) {
		return null;
	}
	return {
		kind,
		max:
			kind === "fileSize"
				? SNAPSHOT_LIMITS.maxFileBytes
				: SNAPSHOT_LIMITS.maxTotalBytes,
		actual: kind === "fileSize" ? largest : total,
		...(exact ? {} : { atLeast: true as const }),
	};
}

async function keptSetLimit(input: {
	dir: string;
	plan: readonly PlannedSyncFile[];
	env: NodeJS.ProcessEnv;
	signal: AbortSignal;
	sizes: BlobSizeSource;
}): Promise<SyncLimitDetail | null> {
	const reported = await providerKeptSizes(input);
	if (reported !== null) {
		return limitOf(
			Math.max(0, ...reported),
			reported.reduce((sum, size) => sum + size, 0),
			true,
		);
	}
	let total = 0;
	let largest = 0;
	for (const file of input.plan) {
		const stat = await lstat(path.join(input.dir, file.repoPath)).catch(
			() => null,
		);
		if (stat?.isFile()) {
			total += stat.size;
			largest = Math.max(largest, stat.size);
		}
	}
	// What reached the disk before the checkout was stopped is a lower bound.
	return limitOf(largest, total, false);
}

/** Spec §5.3.2 step 9: sizes from `lstat`, byte caps, then hashes. */
async function measure(
	dir: string,
	plan: readonly PlannedSyncFile[],
	details: SyncFailureDetails,
): Promise<MeasuredFile[]> {
	let total = 0;
	let largest = 0;
	const sized: Array<PlannedSyncFile & { size: number; full: string }> = [];
	// Every file is sized before a limit is judged, so the failure can name
	// the largest file and the full total instead of where a scan stopped.
	for (const file of plan) {
		const full = path.join(dir, file.repoPath);
		const stat = await lstat(full).catch(() => null);
		if (!stat) {
			throw syncFailure("CLONE_FAILED", details);
		}
		if (!stat.isFile()) {
			throw syncFailure("TREE_REFUSED", {
				...details,
				refusal: "not_regular_file",
			});
		}
		total += stat.size;
		largest = Math.max(largest, stat.size);
		sized.push({ ...file, size: stat.size, full });
	}
	if (largest > SNAPSHOT_LIMITS.maxFileBytes) {
		throw syncFailure("LIMITS_EXCEEDED", {
			...details,
			limit: {
				kind: "fileSize",
				actual: largest,
				max: SNAPSHOT_LIMITS.maxFileBytes,
			},
		});
	}
	if (total > SNAPSHOT_LIMITS.maxTotalBytes) {
		throw syncFailure("LIMITS_EXCEEDED", {
			...details,
			limit: {
				kind: "totalSize",
				actual: total,
				max: SNAPSHOT_LIMITS.maxTotalBytes,
			},
		});
	}
	const measured: MeasuredFile[] = [];
	for (const file of sized) {
		const sha256 = createHash("sha256")
			.update(await readFile(file.full))
			.digest("hex");
		measured.push({ ...file, sha256 });
	}
	return measured;
}

/**
 * Spec §5.3.2 step 12, the same claim-then-put `submit-change.ts` does:
 * the provisional key becomes `stagingKey(projectId, snapshotId, fileId)`
 * under a compare-and-set, then the bytes go there. Overwrites keyed by
 * `fileId`, so an adopting retry re-uploads deterministically.
 */
async function stageBytes(input: {
	context: SyncRunContext;
	snapshotId: string;
	rows: Array<{ fileId: string; storageKey: string; file: MeasuredFile }>;
	signal: AbortSignal;
	details: SyncFailureDetails;
	progress: Progress;
	syncProgress: SyncRunProgress;
}): Promise<void> {
	const { context, snapshotId, details, progress } = input;
	const storage = getStorageProvider();
	const copying = input.syncProgress.copying(input.rows.length);
	await copying.begin();
	for (
		let start = 0;
		start < input.rows.length;
		start += STAGING_CLAIM_BATCH_ROWS
	) {
		const rows = input.rows.slice(start, start + STAGING_CLAIM_BATCH_ROWS);
		input.signal.throwIfAborted();
		const claims = rows.map((row) => {
			const key = stagingKey(context.projectId, snapshotId, row.fileId);
			if (row.storageKey !== key && !isStagingKey(row.storageKey)) {
				throw syncFailure("STORAGE_FAILED", details);
			}
			return { fileId: row.fileId, from: row.storageKey, to: key };
		});
		const { moved } = await claimInstructionFileStagingKeys({
			snapshotId,
			projectId: context.projectId,
			organizationId: context.organizationId,
			claims,
		});
		if (moved !== claims.length) {
			throw syncFailure("STORAGE_FAILED", details);
		}
		input.signal.throwIfAborted();
		await runDrainingPool(rows, UPLOAD_CONCURRENCY, async (row) => {
			input.signal.throwIfAborted();
			const key = stagingKey(context.projectId, snapshotId, row.fileId);
			input.signal.throwIfAborted();
			const bytes = await readFile(row.file.full);
			input.signal.throwIfAborted();
			try {
				await storage.uploadFile(key, bytes, {
					bucket: INSTRUCTIONS_BUCKET,
					contentType: row.file.mimeType,
				});
			} catch {
				throw syncFailure("STORAGE_FAILED", details);
			}
			input.signal.throwIfAborted();
			progress.uploaded++;
			if (progress.uploaded % HEARTBEAT_EVERY_UPLOADS === 0) {
				safeHeartbeat(progress);
			}
			await copying.advance(progress.uploaded);
		});
	}
}

// ---------------------------------------------------------------------------
// settle (§5.2 step 3)
// ---------------------------------------------------------------------------

/**
 * Waits up to `maxWaitMs` for an adopted child snapshot workflow to close.
 * Decides on the child's EXECUTION, not the row: READY is written one
 * activity before publication (plan Decision 14). `pending` is never a
 * verdict; the workflow loops, and cancels the child only after 3 hours.
 */
export async function awaitInstructionSnapshotSettled(
	input: AwaitSnapshotSettledInput,
): Promise<AwaitSnapshotSettledResult> {
	const maxWaitMs = input.maxWaitMs ?? SETTLE_WAIT_MS;
	const pollMs = input.pollMs ?? SETTLE_POLL_MS;
	const client = await getTemporalClient();
	const signal = requestAbortSignal(maxWaitMs + 60_000);
	const deadline = Date.now() + maxWaitMs;
	for (;;) {
		const liveness = await describeSnapshotWorkflow(
			client,
			input.snapshotId,
		);
		if (liveness === "absent") {
			return { settled: true };
		}
		if (liveness === "closed") {
			// The child's own result, when it completed, carries the publish
			// refusal reason the outcome table names; a failed or cancelled
			// child has none, and `record` reads the row instead.
			const childResult = await client.workflow
				.getHandle(instructionSnapshotWorkflowId(input.snapshotId))
				.result()
				.then(
					(r) => r as SnapshotChildResult,
					() => undefined,
				);
			return childResult
				? { settled: true, childResult }
				: { settled: true };
		}
		if (Date.now() + pollMs > deadline) {
			return { settled: false };
		}
		safeHeartbeat({ phase: "await-settled" });
		await sleep(pollMs, undefined, { signal });
	}
}

// ---------------------------------------------------------------------------
// record (§5.4)
// ---------------------------------------------------------------------------

type UnfinishedSyncRunReceipt = Awaited<
	ReturnType<typeof listUnfinishedInstructionRepositorySyncRunReceipts>
>[number];

/**
 * Completes one receipt that has no snapshot to judge it by, under the
 * acting user, trigger and generation it was inserted with. Through
 * `completeInstructionRepositorySyncRun`, so each receipt gets its own
 * completion audit row and its scheduling effect is fenced on its own
 * `(syncId, generation)`.
 *
 * The caller's `error` rests on a configuration read taken before the
 * completion's transaction, and a disable, re-configure or replacement can
 * commit in between. So the completion classifies under its own lock
 * (`classifyStaleAsConfigurationChanged`): a receipt whose
 * `(syncId, generation)` is not current there is recorded FAILED /
 * CONFIGURATION_CHANGED whatever was passed. Only here, for receipts with no
 * fence of their own; never for the run's own receipt when it has a context.
 */
async function completeReceiptWithoutSnapshot(
	receipt: UnfinishedSyncRunReceipt,
	tenant: { projectId: string; organizationId: string },
	error: InstructionSyncErrorCode | null,
): Promise<RecordSyncRunResult> {
	const outcome = deriveSyncRunOutcome({
		trigger: receipt.trigger,
		skipped: false,
		unchanged: false,
		error,
		commitSha: null,
		snapshot: null,
		publishReason: null,
	});
	const completed = await completeInstructionRepositorySyncRun({
		runKey: receipt.id,
		syncId: receipt.syncId,
		generation: receipt.generation,
		...tenant,
		userId: receipt.userId,
		trigger: receipt.trigger,
		status: outcome.status,
		error: outcome.error,
		note: outcome.note,
		commitSha: null,
		snapshotId: null,
		scheduling: outcome.scheduling,
		classifyStaleAsConfigurationChanged: true,
	});
	return { recorded: completed.completed, status: outcome.status };
}

/**
 * `record` without a context. Either `begin` found no configuration row
 * (NOT_CONFIGURED: nothing was inserted, unless an earlier attempt did),
 * or `begin` threw or was cancelled, possibly AFTER inserting the run
 * receipt (a failed permission read that exhausted its retries, say). This
 * is the fast path: every unfinished receipt this workflow run began is
 * found by its run id and completed as FAILED here. A receipt that commits
 * only after `record` ran (a timed-out `begin` attempt's late insert), or
 * one a terminated workflow never recorded, is the hourly reaper's
 * (`reapStrandedInstructionSyncReceipts`). No snapshot can exist:
 * acquisition never ran without a context.
 *
 * Receipts outlive their configuration (no foreign key, Fizzy #2672), so
 * "no configuration row" is not "nothing to record", and one run can hold
 * two receipts: an attempt that inserted under one configuration and threw,
 * then a retry after the sync was switched off and set up again. A receipt
 * of the current configuration records the run's own error; any other is
 * CONFIGURATION_CHANGED, as when `begin` itself reports it, with no
 * scheduling effect. With no typed error the outcome table's default is an
 * untyped failure (CLONE_FAILED, backing off), the same code the workflow
 * already records for any untyped acquisition failure.
 */
async function completeReceiptWithoutContext(
	input: RecordSyncRunInput,
): Promise<RecordSyncRunResult> {
	const nothing: RecordSyncRunResult = { recorded: false, status: null };
	if (!input.workflowRunId) {
		// A history started before the workflow passed its run id.
		return nothing;
	}
	// Unscoped read, then the tenant check, exactly as `begin` does: the
	// configuration is unique per project, and its id is the run key's prefix.
	// Unlocked, so it only picks the error to pass: the completion re-checks
	// each receipt's fence under its lock (`completeReceiptWithoutSnapshot`).
	const sync = await getInstructionRepositorySyncForRun(input.projectId);
	if (sync && sync.organizationId !== input.organizationId) {
		return nothing;
	}
	const tenant = {
		projectId: input.projectId,
		organizationId: input.organizationId,
	};
	const receipts = await listUnfinishedInstructionRepositorySyncRunReceipts(
		input.workflowRunId,
		tenant.projectId,
		tenant.organizationId,
	);
	// Newest first: the newest receipt's status is the run's answer.
	let result = nothing;
	for (const receipt of receipts) {
		const done = await completeReceiptWithoutSnapshot(
			receipt,
			tenant,
			receipt.syncId === sync?.id ? input.error : "CONFIGURATION_CHANGED",
		);
		result = {
			recorded: result.recorded || done.recorded,
			status: result.status ?? done.status,
		};
	}
	return result;
}

/**
 * The workflow run id `record` sweeps by: passed by the workflow, or, for a
 * history started before it was, the suffix of `begin`'s run key.
 */
function workflowRunIdOf(
	input: RecordSyncRunInput,
	context: SyncRunContext,
): string | null {
	if (input.workflowRunId) {
		return input.workflowRunId;
	}
	const prefix = `${context.syncId}:`;
	return context.runKey.startsWith(prefix)
		? context.runKey.slice(prefix.length)
		: null;
}

export async function recordInstructionRepositorySyncRun(
	input: RecordSyncRunInput,
): Promise<RecordSyncRunResult> {
	const context = input.context;
	if (!context) {
		return completeReceiptWithoutContext(input);
	}
	const tenant = {
		projectId: context.projectId,
		organizationId: context.organizationId,
	};

	// Part A: snapshot cleanup, unfenced and keyed on the snapshot. The
	// workflow may never have learned the id (an acquisition that timed out
	// after creating the row), so the run key finds it (Review Focus 4).
	const snapshotId =
		input.snapshotId ??
		(
			await getInstructionSnapshotBySyncRunKey(
				context.runKey,
				tenant.projectId,
				tenant.organizationId,
			)
		)?.id ??
		null;
	let snapshot: SyncSnapshotState | null = null;
	let commitSha = input.commitSha;
	if (snapshotId) {
		let read = await getInstructionSnapshotWithPublishedPointer(
			snapshotId,
			tenant.projectId,
			tenant.organizationId,
		);
		if (read.snapshot?.status === "RECEIVING") {
			const client = await getTemporalClient().catch(() => null);
			const liveness = client
				? await describeSnapshotWorkflow(client, snapshotId)
				: "unknown";
			if (liveness === "closed" || liveness === "absent") {
				const { changed } = await rejectAbandonedInstructionSnapshot({
					snapshotId,
					...tenant,
					source: "repository_sync",
				});
				if (changed) {
					await sweepClosedAbandonment(
						getStorageProvider(),
						{ id: snapshotId, ...tenant },
						"repository-sync-record",
						{ remaining: SNAPSHOT_LIMITS.maxFiles },
					);
				}
				read = await getInstructionSnapshotWithPublishedPointer(
					snapshotId,
					tenant.projectId,
					tenant.organizationId,
				);
			}
		}
		if (read.snapshot) {
			snapshot = {
				status: read.snapshot.status,
				publishedAt: read.snapshot.publishedAt,
				rejection: read.snapshot.rejection,
				isPublishedPointer: read.publishedPointer?.id === snapshotId,
			};
			commitSha ??= read.snapshot.sourceCommitSha;
		}
	}

	// Part B: bookkeeping, idempotent on the run row, fenced on the
	// generation where it touches the configuration.
	const outcome = deriveSyncRunOutcome({
		trigger: context.trigger,
		skipped: input.skipped,
		unchanged: input.unchanged,
		error: input.error,
		commitSha,
		snapshot,
		publishReason: input.childResult?.publishReason ?? null,
	});
	const completed = await completeInstructionRepositorySyncRun({
		runKey: context.runKey,
		syncId: context.syncId,
		generation: context.generation,
		...tenant,
		userId: context.actingUserId,
		trigger: context.trigger,
		status: outcome.status,
		error: outcome.error,
		note: outcome.note,
		commitSha,
		snapshotId: snapshot ? snapshotId : null,
		scheduling: outcome.scheduling,
		limit: input.limit ?? null,
	});

	// The first sync from the repository after a move from uploads
	// succeeded: the move is complete (Fizzy #2878 §9). Retried with this
	// step, and a run that did not succeed leaves the move switching.
	if (completed.completed) {
		await settleMigrationAfterSuccessfulRun({
			...tenant,
			syncId: context.syncId,
			status: outcome.status,
			snapshotId: snapshot ? snapshotId : null,
		});
	}

	// A `begin` attempt that inserted a receipt under an earlier
	// configuration and threw, before the retry that gave this run its
	// context, left that receipt behind; it outlives its configuration
	// (Fizzy #2672), so the run closes it rather than leave it open. This
	// sees only receipts already committed: one whose insert lands after
	// this sweep is closed by the hourly reaper once the run has ended.
	const workflowRunId = workflowRunIdOf(input, context);
	if (workflowRunId) {
		const receipts =
			await listUnfinishedInstructionRepositorySyncRunReceipts(
				workflowRunId,
				tenant.projectId,
				tenant.organizationId,
			);
		for (const receipt of receipts) {
			if (receipt.syncId !== context.syncId) {
				await completeReceiptWithoutSnapshot(
					receipt,
					tenant,
					"CONFIGURATION_CHANGED",
				);
			}
		}
	}
	return { recorded: completed.completed, status: outcome.status };
}
