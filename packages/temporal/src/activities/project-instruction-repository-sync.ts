/**
 * Coding Instructions repository sync activities (design 2026-09-23 §5.3,
 * §5.4). The activities barrel re-exports this module, so EVERY export here
 * becomes a schedulable activity: helpers stay unexported or live in ./lib.
 */
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
	canCreateProjectInstructions,
	claimInstructionFileStagingKey,
	completeInstructionRepositorySyncRun,
	createInstructionSnapshot,
	getInstructionRepositorySyncForRun,
	getInstructionRepositorySyncRunReceipt,
	getInstructionSnapshotBySyncRunKey,
	getInstructionSnapshotWithPublishedPointer,
	getProjectInstructionSettings,
	getProjectRepoIntegration,
	getPublishedInstructionTree,
	insertInstructionRepositorySyncRun,
	recordAudit,
	rejectAbandonedInstructionSnapshot,
} from "@repo/database";
import {
	classifyPath,
	FABRIC_IGNORE_FILE,
	fileTypingFor,
	type InstructionFileKind,
	instructionSnapshotWorkflowId,
	isStagingKey,
	planSnapshotFiles,
	resolveIgnoreGlobs,
	SNAPSHOT_LIMITS,
	stagingKey,
	validateRelativePath,
} from "@repo/instructions";
import { getStorageProvider } from "@repo/storage";
import { ApplicationFailure } from "@temporalio/activity";
import { getTemporalClient } from "../client";
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
import { INSTRUCTIONS_BUCKET } from "./lib/instruction-prune";
import {
	credentialFreeUrl,
	fetchPinnedCommit,
	listTree,
	MAX_FABRICIGNORE_BYTES,
	MAX_INVENTORY_ENTRIES,
	readBlobCapped,
	revParseHead,
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
} from "./lib/instruction-sync-tree";
import {
	cloneWithAuthRecovery as cloneRepositoryWithAuthRecovery,
	gitStepFailureCode,
	logGitFailure,
} from "./lib/repository-sync-clone";

/** Git's share of the 10-minute activity timeout, so a hung transfer dies first. */
const ACQUIRE_GIT_BUDGET_MS = 9 * 60 * 1000;
const UPLOAD_CONCURRENCY = 8;
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
	if (isAutomaticInstructionSyncTrigger(input.trigger)) {
		// Eligibility is checked before `expected`: every writer of `automatic`
		// bumps the generation, and the poll/webhook always pass `expected`
		// from the row they read. Checking `expected` first would turn a
		// member's automatic-off flip after a poll/webhook already started
		// into a warning-severity CONFIGURATION_CHANGED failure instead of the
		// intended SKIPPED outcome (plan Decision 47).
		if (!row.automatic) {
			return { ok: false, skipped: "automatic_disabled", context };
		}
		if (row.automaticPausedReason !== null) {
			return { ok: false, skipped: "paused", context };
		}
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
	adopted?: { fileId: string; storageKey: string; sha256: string };
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
	return withHeartbeatTicker<AcquireTreeResult>(
		async () => {
			let adopted = await getInstructionSnapshotBySyncRunKey(
				context.runKey,
				context.projectId,
				context.organizationId,
			);
			if (adopted && adopted.status !== "RECEIVING") {
				// Staged already; the child owns the verdict (§5.2 step 3).
				return {
					outcome: "staged",
					snapshotId: adopted.id,
					commitSha: adopted.sourceCommitSha,
				};
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
						url,
						runDir,
						dir: path.join(runDir, `repo-${pass}`),
						adopted,
						progress,
					});
					if (step.kind === "done") {
						return step.result;
					}
					adopted = step.adopted;
					if (adopted.status !== "RECEIVING") {
						return {
							outcome: "staged",
							snapshotId: adopted.id,
							commitSha: adopted.sourceCommitSha,
						};
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

function adoptedDetails(adopted: AdoptedRow | null): SyncFailureDetails {
	return adopted ? { snapshotId: adopted.id } : {};
}

async function acquireOnce(input: {
	context: SyncRunContext;
	provider: string;
	url: string;
	runDir: string;
	dir: string;
	adopted: AdoptedRow | null;
	progress: Progress;
}): Promise<
	| { kind: "done"; result: AcquireTreeResult }
	| { kind: "adopt"; adopted: AdoptedRow }
> {
	const { context, adopted, dir, progress } = input;
	const signal = requestAbortSignal(ACQUIRE_GIT_BUDGET_MS);
	const baseDetails = adoptedDetails(adopted);
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

	const published = adopted
		? null
		: await getPublishedInstructionTree(
				context.projectId,
				context.organizationId,
			);
	if (
		published &&
		published.sourceCommitSha === commitSha &&
		frozenPairMatches(published.settingsFrozen, context)
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
		throw syncFailure("LIMITS_EXCEEDED", details);
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

	await git(
		() =>
			sparseCheckout({
				dir,
				repoPaths: planned.plan.map((f) => f.repoPath),
				env,
				signal,
			}),
		details,
	);
	progress.phase = "checked_out";
	progress.kept = planned.plan.length;
	safeHeartbeat(progress);

	const measured = await measure(dir, planned.plan, details);
	if (adopted && measured.some((f) => f.sha256 !== f.adopted?.sha256)) {
		// The pinned commit did not reproduce the adopted row.
		throw syncFailure("CLONE_FAILED", details);
	}

	let snapshotId: string;
	let rows: Array<{ fileId: string; storageKey: string; file: MeasuredFile }>;
	if (adopted) {
		snapshotId = adopted.id;
		rows = measured.map((file) => ({
			fileId: file.adopted?.fileId as string,
			storageKey: file.adopted?.storageKey as string,
			file,
		}));
	} else {
		if (
			published &&
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
		const created = await createInstructionSnapshot({
			projectId: context.projectId,
			organizationId: context.organizationId,
			userId: context.actingUserId,
			source: "REPOSITORY",
			repositoryIntegrationId: context.repositoryIntegrationId,
			sourceRef: context.ref,
			sourceCommitSha: commitSha,
			syncRunKey: context.runKey,
			publishOnReady: true,
			excludedCount: planned.excludedCount,
			settingsFrozen: {
				ignoreGlobs: ignore.globs,
				layer: ignore.layer,
				limits: SNAPSHOT_LIMITS,
				rootPath: context.rootPath,
				syncId: context.syncId,
				syncGeneration: context.generation,
			},
			files: measured.map((f, i) => ({
				path: f.path,
				size: f.size,
				sha256: f.sha256,
				mimeType: f.mimeType,
				isText: f.isText,
				kind: f.kind,
				storageKey: stagingKey(context.projectId, "pending", String(i)),
				mode: f.mode,
			})),
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
		const byPath = new Map(measured.map((f) => [f.path, f]));
		rows = created.files.map((row) => ({
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
		details: { ...details, snapshotId },
		progress,
	});
	return {
		kind: "done",
		result: { outcome: "staged", snapshotId, commitSha },
	};
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
		throw syncFailure(gitStepFailureCode(error), details);
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
			syncFailure(code, input.details, nonRetryable),
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
			fabricIgnoreText = bytes.toString("utf8");
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
			},
		};
	});
}

/** Spec §5.3.2 step 9: sizes from `lstat`, byte caps, then hashes. */
async function measure(
	dir: string,
	plan: readonly PlannedSyncFile[],
	details: SyncFailureDetails,
): Promise<MeasuredFile[]> {
	let total = 0;
	const sized: Array<PlannedSyncFile & { size: number; full: string }> = [];
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
		if (stat.size > SNAPSHOT_LIMITS.maxFileBytes) {
			throw syncFailure("LIMITS_EXCEEDED", details);
		}
		total += stat.size;
		if (total > SNAPSHOT_LIMITS.maxTotalBytes) {
			throw syncFailure("LIMITS_EXCEEDED", details);
		}
		sized.push({ ...file, size: stat.size, full });
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
	details: SyncFailureDetails;
	progress: Progress;
}): Promise<void> {
	const { context, snapshotId, details, progress } = input;
	const storage = getStorageProvider();
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < input.rows.length) {
			const row = input.rows[next++] as (typeof input.rows)[number];
			const key = stagingKey(context.projectId, snapshotId, row.fileId);
			if (row.storageKey !== key) {
				if (!isStagingKey(row.storageKey)) {
					throw syncFailure("STORAGE_FAILED", details);
				}
				const { moved } = await claimInstructionFileStagingKey({
					fileId: row.fileId,
					snapshotId,
					projectId: context.projectId,
					organizationId: context.organizationId,
					from: row.storageKey,
					to: key,
				});
				if (!moved) {
					throw syncFailure("STORAGE_FAILED", details);
				}
			}
			try {
				await storage.uploadFile(key, await readFile(row.file.full), {
					bucket: INSTRUCTIONS_BUCKET,
					contentType: row.file.mimeType,
				});
			} catch {
				throw syncFailure("STORAGE_FAILED", details);
			}
			progress.uploaded++;
			if (progress.uploaded % HEARTBEAT_EVERY_UPLOADS === 0) {
				safeHeartbeat(progress);
			}
		}
	};
	await Promise.all(
		Array.from(
			{ length: Math.min(UPLOAD_CONCURRENCY, input.rows.length) },
			() => worker(),
		),
	);
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

/**
 * `record` without a context. Either `begin` found no configuration row
 * (NOT_CONFIGURED: nothing was inserted), or `begin` threw or was cancelled,
 * possibly AFTER inserting the run receipt (a failed permission read that
 * exhausted its retries, say). The reaper does not cover receipts, so the
 * run key is rebuilt from the workflow's own identifiers and an unfinished
 * receipt is completed as FAILED here. No snapshot can exist: acquisition
 * never ran without a context.
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
	const sync = await getInstructionRepositorySyncForRun(input.projectId);
	if (!sync || sync.organizationId !== input.organizationId) {
		return nothing;
	}
	const runKey = `${sync.id}:${input.workflowRunId}`;
	const receipt = await getInstructionRepositorySyncRunReceipt(
		runKey,
		input.projectId,
		input.organizationId,
	);
	if (!receipt || receipt.finishedAt !== null) {
		// `begin` failed before inserting, or the receipt is already complete.
		return nothing;
	}
	// No snapshot and no typed error: the outcome table's default for an
	// untyped failure (CLONE_FAILED, backing off), the same code the workflow
	// already records for any untyped acquisition failure.
	const outcome = deriveSyncRunOutcome({
		trigger: receipt.trigger,
		skipped: false,
		unchanged: false,
		error: input.error,
		commitSha: null,
		snapshot: null,
		publishReason: null,
	});
	const completed = await completeInstructionRepositorySyncRun({
		runKey,
		syncId: receipt.syncId,
		generation: receipt.generation,
		projectId: input.projectId,
		organizationId: input.organizationId,
		userId: receipt.userId,
		trigger: receipt.trigger,
		status: outcome.status,
		error: outcome.error,
		note: outcome.note,
		commitSha: null,
		snapshotId: null,
		scheduling: outcome.scheduling,
	});
	return { recorded: completed.completed, status: outcome.status };
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
	});
	return { recorded: completed.completed, status: outcome.status };
}
