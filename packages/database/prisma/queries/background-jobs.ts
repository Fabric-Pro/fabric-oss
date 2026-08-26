/**
 * BackgroundJob writers + readers — the Job Hub's data layer.
 *
 * Lives in `@repo/database` (not `@repo/api`) so Temporal activities can write
 * job progress: `@repo/api` depends on `@repo/temporal`, so an activity cannot
 * import an API-side helper without a circular dependency. Same reasoning as
 * `agent-reply-notifications.ts`.
 *
 * Progress is written from ACTIVITIES, never from workflow code — activities
 * are not replayed, so instrumenting them keeps the Temporal replay-validation
 * CI green without `patched()` sentinels, and in-flight monitor executions pick
 * the writes up at their next activity invocation.
 *
 * Every writer here is best-effort: it swallows its own errors so a telemetry
 * write can never fail an ingestion pipeline. Callers do not need try/catch.
 *
 * Concurrency model: at most one OPEN (RUNNING) row per `(workflowId,
 * sourceId)`, enforced by the partial unique index
 * `background_job_workflow_source_running_uq`. `workflowId` alone is not
 * unique — channel monitors reuse a stable workflow id across ticks and
 * per-repo code indexing reuses its id across runs (TERMINATE_EXISTING) — so
 * every writer keys on the pair and closes rows by compare-and-set.
 */

import { db, Prisma } from "../client";
import type {
	BackgroundJobKind,
	BackgroundJobStatus,
} from "../generated/client";

// =============================================================================
// Types
// =============================================================================

export type BackgroundJobStepStatus =
	| "pending"
	| "running"
	| "completed"
	| "failed"
	/**
	 * Never reached, and never will be — the job finished without it. Distinct
	 * from `completed` (which would claim work that did not happen) and from
	 * `pending` (which on a finished job reads as "still queued", forever).
	 */
	| "skipped";

export interface BackgroundJobStep {
	/** Stable machine key, e.g. "clone" — the UI maps it to a localized label. */
	key: string;
	status: BackgroundJobStepStatus;
	startedAt?: string;
	completedAt?: string;
	error?: string;
}

/** Counter map: label → count, e.g. `{ threadsAnalyzed: 3, proposalsCreated: 1 }`. */
export type BackgroundJobCounts = Record<string, number>;

export interface BackgroundJobKey {
	workflowId: string;
	/**
	 * Which of the workflow's open rows to target:
	 *   string    — that source's row (channel monitors fan out per channel)
	 *   null      — the row whose sourceId IS NULL
	 *   undefined — any open row of this workflow
	 *
	 * The `undefined` form exists for single-source workflows such as code
	 * indexing, whose id already encodes the repo (`code-index-{project}-{repo}`)
	 * and which therefore have exactly one open row: activities deep in the
	 * pipeline can report progress without being handed the integration id.
	 */
	sourceId?: string | null;
}

/** Prisma `where` fragment for the sourceId part of a job key. */
function sourceIdWhere(sourceId: string | null | undefined) {
	return sourceId === undefined ? {} : { sourceId };
}

/** Raw-SQL predicate for the sourceId part of a job key. */
function sourceIdSql(sourceId: string | null | undefined): Prisma.Sql {
	if (sourceId === undefined) {
		return Prisma.sql`TRUE`;
	}
	return sourceId === null
		? Prisma.sql`"sourceId" IS NULL`
		: Prisma.sql`"sourceId" = ${sourceId}`;
}

export interface CreateBackgroundJobArgs {
	kind: BackgroundJobKind;
	title: string;
	projectId: string;
	userId: string;
	organizationId?: string | null;
	workflowId: string;
	runId?: string | null;
	sourceType?: string | null;
	sourceId?: string | null;
	counts?: BackgroundJobCounts;
	steps?: BackgroundJobStep[];
}

// =============================================================================
// Step helpers
// =============================================================================

/** Seed an ordered step list in `pending` state from machine keys. */
export function seedSteps(keys: string[]): BackgroundJobStep[] {
	return keys.map((key) => ({ key, status: "pending" as const }));
}

function applyStepTransition(
	steps: BackgroundJobStep[],
	key: string,
	status: BackgroundJobStepStatus,
	error?: string,
	nowIso: string = new Date().toISOString(),
): BackgroundJobStep[] {
	const next = [...steps];
	const index = next.findIndex((step) => step.key === key);
	const previous: BackgroundJobStep =
		index >= 0 ? next[index] : { key, status: "pending" };

	const updated: BackgroundJobStep = {
		...previous,
		status,
		// Idempotent across continueAsNew: a step re-entering `running` keeps
		// its original start time rather than restarting the clock.
		startedAt:
			status === "running"
				? (previous.startedAt ?? nowIso)
				: previous.startedAt,
		completedAt:
			status === "completed" || status === "failed"
				? nowIso
				: previous.completedAt,
		...(error ? { error } : {}),
	};

	if (index >= 0) {
		next[index] = updated;
	} else {
		next.push(updated);
	}
	return next;
}

function parseSteps(value: unknown): BackgroundJobStep[] {
	return Array.isArray(value) ? (value as BackgroundJobStep[]) : [];
}

/**
 * Undo a close sweep's `skipped` marks, so a row that reopens does not claim to
 * have finished before it restarts.
 *
 * `skipUnreachedSteps` is the ONLY writer of `skipped` — no activity ever marks
 * a step skipped itself — so mapping it back to `pending` is an exact undo of
 * the close and cannot overwrite anything an activity decided. Genuine
 * `completed` / `failed` steps are preserved: a retry that resumes keeps the
 * progress it really made.
 *
 * WHY IT MATTERS: the Job Hub card counts `skipped` as settled, because a
 * FINISHED run showing "2/3" would imply a step still to come. A reopened row
 * whose steps are all `skipped` therefore renders "3/3 steps" on a RUNNING job
 * that has not started, every step reading "Skipped" — and RUNNING cards open
 * expanded, so it is the first thing a reader sees.
 *
 * Returns null when there is nothing to undo. That also covers the caller who
 * forgets to select `steps`: writing the empty list back would ERASE the row's
 * steps rather than restore them.
 */
function unskipSteps(value: unknown): Prisma.InputJsonValue | null {
	const steps = parseSteps(value);
	if (!steps.some((step) => step.status === "skipped")) {
		return null;
	}
	return steps.map((step) =>
		step.status === "skipped"
			? { ...step, status: "pending" as const }
			: step,
	) as unknown as Prisma.InputJsonValue;
}

// =============================================================================
// Writers
// =============================================================================

/**
 * Create a job row up front, from the API procedure that starts the workflow —
 * so the Job Hub shows the job the instant the user clicks, before the worker
 * has picked anything up.
 *
 * An already-open row for the same `(workflowId, sourceId)` is adopted, not
 * replaced — see the inline note below.
 *
 * Returns the new row's id, or null when the write failed (best-effort).
 */
export async function createBackgroundJob(
	args: CreateBackgroundJobArgs,
): Promise<string | null> {
	const sourceId = args.sourceId ?? null;
	try {
		// Adopt an open row rather than superseding it. The caller creates this
		// row just after `workflow.start` returns, by which time the worker may
		// already have run an activity that opened one via `ensureRunning...`.
		// Replacing that row would flag a perfectly healthy run as failed. Refresh its metadata instead — a leftover row
		// from a terminated run is equally well served, since the new run's
		// terminal write overwrites the counts with authoritative totals.
		const open = await db.backgroundJob.findFirst({
			where: { workflowId: args.workflowId, sourceId, status: "RUNNING" },
			select: { id: true },
		});
		if (open) {
			await db.backgroundJob.update({
				where: { id: open.id },
				data: {
					kind: args.kind,
					title: args.title,
					runId: args.runId ?? null,
					sourceType: args.sourceType ?? null,
					heartbeatAt: new Date(),
				},
			});
			return open.id;
		}

		const job = await db.backgroundJob.create({
			data: {
				kind: args.kind,
				title: args.title,
				projectId: args.projectId,
				userId: args.userId,
				organizationId: args.organizationId ?? null,
				workflowId: args.workflowId,
				runId: args.runId ?? null,
				sourceType: args.sourceType ?? null,
				sourceId,
				counts: (args.counts ?? {}) as Prisma.InputJsonValue,
				steps: (args.steps ?? []) as unknown as Prisma.InputJsonValue,
			},
			select: { id: true },
		});
		return job.id;
	} catch {
		// Best-effort: never block the workflow start on job bookkeeping.
		return null;
	}
}

/**
 * Activity-side upsert: return the open row for this `(workflowId, sourceId)`,
 * creating it when the activity is the first to report work.
 *
 * This is what makes zero-workflow-edit instrumentation possible — the first
 * activity that finds real work opens the row, so ticks that scan nothing never
 * create one (an idle 15-minute monitor would otherwise emit ~96 empty rows a
 * day).
 *
 * `reopenFailedWithClass` is for one-shot activities that Temporal retries: on
 * attempt 2 the row this activity failed on attempt 1 is no longer RUNNING, so
 * without it every attempt opens a fresh row and one run ends up as several
 * cards — three "Failed", or a stale "Failed" beside the "Completed" of the
 * attempt that recovered. Reopening keeps one row per source whose terminal
 * state is the run's real outcome. Deliberately opt-in: continuous monitors
 * reuse a workflow id across ticks and DO want one row per tick.
 *
 * Reopening also restores the steps the close swept to `skipped` — see
 * `unskipSteps`. A reopened row is about to do the work again, and a card that
 * reads "Skipped" on every step while the run is RUNNING says the opposite.
 */
export async function ensureRunningBackgroundJob(
	args: CreateBackgroundJobArgs & { reopenFailedWithClass?: string },
): Promise<string | null> {
	const sourceId = args.sourceId ?? null;
	try {
		const existing = await db.backgroundJob.findFirst({
			where: {
				workflowId: args.workflowId,
				sourceId,
				status: "RUNNING",
			},
			select: { id: true },
		});
		if (existing) {
			// Adopting counts as progress: an activity that reached this point
			// is alive, and the watchdog must not fail its job for going quiet
			// while a long step runs.
			await db.backgroundJob
				.update({
					where: { id: existing.id },
					data: { heartbeatAt: new Date() },
				})
				.catch(() => undefined);
			return existing.id;
		}

		if (args.reopenFailedWithClass) {
			const retryable = await db.backgroundJob.findFirst({
				where: {
					workflowId: args.workflowId,
					sourceId,
					status: "FAILED",
					errorClass: args.reopenFailedWithClass,
				},
				orderBy: { createdAt: "desc" },
				// `steps` is selected because the close that failed this row swept
				// them to `skipped`; reopening without undoing that leaves a RUNNING
				// card reading "Skipped" on every step.
				select: { id: true, steps: true },
			});
			if (retryable) {
				const restored = unskipSteps(retryable.steps);
				await db.backgroundJob.update({
					where: { id: retryable.id },
					data: {
						status: "RUNNING",
						error: null,
						errorClass: null,
						completedAt: null,
						heartbeatAt: new Date(),
						...(restored ? { steps: restored } : {}),
					},
				});
				return retryable.id;
			}
		}

		const created = await db.backgroundJob.create({
			data: {
				kind: args.kind,
				title: args.title,
				projectId: args.projectId,
				userId: args.userId,
				organizationId: args.organizationId ?? null,
				workflowId: args.workflowId,
				runId: args.runId ?? null,
				sourceType: args.sourceType ?? null,
				sourceId,
				counts: (args.counts ?? {}) as Prisma.InputJsonValue,
				steps: (args.steps ?? []) as unknown as Prisma.InputJsonValue,
			},
			select: { id: true },
		});
		return created.id;
	} catch (error) {
		// Lost the race to a concurrent activity — the partial unique index
		// rejected the duplicate open row, so adopt the winner's row.
		const code = (error as { code?: string } | null)?.code;
		if (code === "P2002") {
			const winner = await db.backgroundJob
				.findFirst({
					where: {
						workflowId: args.workflowId,
						sourceId,
						status: "RUNNING",
					},
					select: { id: true },
				})
				.catch(() => null);
			return winner?.id ?? null;
		}
		return null;
	}
}

/**
 * Add to the job's counters atomically.
 *
 * Uses a single jsonb-merge UPDATE rather than read-modify-write: per-batch
 * indexing progress and per-thread monitor counts are written concurrently from
 * retried activities, and a read-modify-write would silently drop increments.
 */
export async function incrementBackgroundJobCounts(
	key: BackgroundJobKey,
	deltas: BackgroundJobCounts,
): Promise<void> {
	const entries = Object.entries(deltas).filter(([, value]) =>
		Number.isFinite(value),
	);
	if (entries.length === 0) {
		return;
	}

	// Chain one jsonb_build_object per counter so the whole merge is one
	// statement (`counts || a || b || ...`).
	const merge = entries.reduce<Prisma.Sql>(
		(acc, [label, delta]) =>
			Prisma.sql`${acc} || jsonb_build_object(${label}::text, COALESCE((counts->>${label}::text)::numeric, 0) + ${delta}::numeric)`,
		Prisma.sql`counts`,
	);

	try {
		await db.$executeRaw(Prisma.sql`
			UPDATE "background_job"
			SET counts = ${merge},
				"heartbeatAt" = now(),
				"updatedAt" = now()
			WHERE "workflowId" = ${key.workflowId}
				AND ${sourceIdSql(key.sourceId)}
				AND status = 'RUNNING'
		`);
	} catch {
		// Best-effort telemetry.
	}
}

/** Overwrite counters outright (totals known up front, e.g. `totalFiles`). */
export async function setBackgroundJobCounts(
	key: BackgroundJobKey,
	counts: BackgroundJobCounts,
): Promise<void> {
	const entries = Object.entries(counts).filter(([, value]) =>
		Number.isFinite(value),
	);
	if (entries.length === 0) {
		return;
	}

	const merge = entries.reduce<Prisma.Sql>(
		(acc, [label, value]) =>
			Prisma.sql`${acc} || jsonb_build_object(${label}::text, ${value}::numeric)`,
		Prisma.sql`counts`,
	);

	try {
		await db.$executeRaw(Prisma.sql`
			UPDATE "background_job"
			SET counts = ${merge},
				"heartbeatAt" = now(),
				"updatedAt" = now()
			WHERE "workflowId" = ${key.workflowId}
				AND ${sourceIdSql(key.sourceId)}
				AND status = 'RUNNING'
		`);
	} catch {
		// Best-effort telemetry.
	}
}

/**
 * Move one subtask to a new state. Step writes are low-frequency and sequential
 * per workflow, so a read-modify-write inside a short transaction is fine here
 * (unlike counters, which fan out per batch/thread).
 */
export async function setBackgroundJobStep(
	key: BackgroundJobKey,
	stepKey: string,
	status: BackgroundJobStepStatus,
	error?: string,
): Promise<void> {
	try {
		await db.$transaction(async (tx) => {
			const job = await tx.backgroundJob.findFirst({
				where: {
					workflowId: key.workflowId,
					...sourceIdWhere(key.sourceId),
					status: "RUNNING",
				},
				select: { id: true, steps: true },
			});
			if (!job) {
				return;
			}
			const nextSteps = applyStepTransition(
				parseSteps(job.steps),
				stepKey,
				status,
				error,
			);
			await tx.backgroundJob.update({
				where: { id: job.id },
				data: {
					steps: nextSteps as unknown as Prisma.InputJsonValue,
					heartbeatAt: new Date(),
				},
			});
		});
	} catch {
		// Best-effort telemetry.
	}
}

/** Bump the heartbeat so the watchdog does not fail a slow-but-alive job. */
export async function touchBackgroundJobHeartbeat(
	key: BackgroundJobKey,
): Promise<void> {
	try {
		await db.backgroundJob.updateMany({
			where: {
				workflowId: key.workflowId,
				...sourceIdWhere(key.sourceId),
				status: "RUNNING",
			},
			data: { heartbeatAt: new Date() },
		});
	} catch {
		// Best-effort telemetry.
	}
}

/**
 * Settle every step a finished job left open — never reached, or interrupted
 * mid-flight.
 *
 * A step is only advanced by the activity that performs it, and some are
 * conditional: code indexing's symbol extraction sits behind a language check
 * and a swallowing catch. Without this a finished job renders a middle step as
 * "QUEUED" with the steps after it "COMPLETE" and a header reading "6/7"
 * forever — and a job that failed mid-step leaves a spinner running on a dead
 * row, which is ambient motion on something that is over.
 *
 * This is the only writer of `skipped`, which is what lets `unskipSteps` undo
 * it exactly when a failed row is reopened for a retry. Keep the two together:
 * a second producer of `skipped` would make that undo overreach.
 */
async function skipUnreachedSteps(where: Prisma.BackgroundJobWhereInput) {
	const rows = await db.backgroundJob.findMany({
		where,
		select: { id: true, steps: true },
	});
	for (const row of rows) {
		const steps = (row.steps ?? []) as unknown as BackgroundJobStep[];
		if (!Array.isArray(steps) || steps.length === 0) {
			continue;
		}
		let changed = false;
		const swept = steps.map((step) => {
			if (step.status === "pending" || step.status === "running") {
				changed = true;
				return { ...step, status: "skipped" as const };
			}
			return step;
		});
		if (!changed) {
			continue;
		}
		await db.backgroundJob.update({
			where: { id: row.id },
			data: { steps: swept as unknown as Prisma.InputJsonValue },
		});
	}
}

/**
 * Which rows a success is allowed to close.
 *
 * Normally only RUNNING. A watchdog close (`TimedOut`) is additionally
 * repairable, because the watchdog merely *guesses* that a quiet job died — if
 * the work then finishes, the truth is that it succeeded, and a RUNNING-only
 * compare-and-set would leave the row wrongly failed forever.
 *
 * That repair is only safe when the caller speaks for exactly one row, which is
 * why it is gated on an explicit `sourceId`. Workflow-scoped closes must NOT
 * get it: channel monitors reuse a stable workflow id across ticks and per-repo
 * indexing reuses one across runs, so a later tick would otherwise resurrect an
 * earlier tick's genuinely-dead job as a green "Completed" and erase its error.
 * A failure with any other errorClass is never overwritten either way.
 */
function completableStatus(sourceId: string | null | undefined) {
	if (sourceId === undefined) {
		return { status: "RUNNING" as const };
	}
	return {
		OR: [
			{ status: "RUNNING" as const },
			{ status: "FAILED" as const, errorClass: "TimedOut" },
		],
	};
}

/**
 * Close every open row for a workflow (compare-and-set on RUNNING, so a job
 * already closed as FAILED is never resurrected as COMPLETED).
 *
 * Channel monitors call this from their per-tick "stamp last run" activity: one
 * call closes all the per-channel rows the tick opened. Ticks that opened
 * nothing are a no-op.
 */
export async function completeBackgroundJobs(
	workflowId: string,
	opts?: { counts?: BackgroundJobCounts },
): Promise<void> {
	try {
		// Counts BEFORE the status flip: `setBackgroundJobCounts` only matches
		// rows that are still RUNNING, so writing them afterwards would
		// silently discard them.
		if (opts?.counts) {
			await setBackgroundJobCounts({ workflowId }, opts.counts);
		}
		const now = new Date();
		await db.backgroundJob.updateMany({
			where: { workflowId, status: "RUNNING" },
			data: {
				status: "COMPLETED",
				completedAt: now,
				heartbeatAt: now,
				error: null,
				errorClass: null,
			},
		});
		await skipUnreachedSteps({
			workflowId,
			status: "COMPLETED",
			completedAt: now,
		});
	} catch {
		// Best-effort telemetry.
	}
}

/** Close a single job (one source) as COMPLETED. */
export async function completeBackgroundJob(
	key: BackgroundJobKey,
	opts?: { counts?: BackgroundJobCounts },
): Promise<void> {
	try {
		if (opts?.counts) {
			await setBackgroundJobCounts(key, opts.counts);
		}
		const now = new Date();
		await db.backgroundJob.updateMany({
			where: {
				workflowId: key.workflowId,
				...sourceIdWhere(key.sourceId),
				...completableStatus(key.sourceId),
			},
			data: {
				status: "COMPLETED",
				completedAt: now,
				heartbeatAt: now,
				error: null,
				errorClass: null,
			},
		});
		await skipUnreachedSteps({
			workflowId: key.workflowId,
			...sourceIdWhere(key.sourceId),
			status: "COMPLETED",
			completedAt: now,
		});
	} catch {
		// Best-effort telemetry.
	}
}

/**
 * Mark whichever step is currently `running` as `failed`, before the job closes.
 *
 * WHY THIS EXISTS: `skipUnreachedSteps` maps `pending` and `running` alike to
 * `skipped` on close, which is right for a step the run never entered and wrong
 * for the one it died in — "never reached" is the opposite of what happened, on
 * the card where a reader most needs to know where it broke. An activity that
 * owns its own step marks it itself; this covers the case where the failure is
 * raised OUTSIDE the step's activity (a fan-out whose callers all failed, say),
 * so no single activity is in a position to.
 *
 * No-op when nothing is running. Best-effort, like every writer here.
 */
export async function failRunningBackgroundJobStep(
	key: BackgroundJobKey,
	error: string,
): Promise<void> {
	try {
		const rows = await db.backgroundJob.findMany({
			where: {
				workflowId: key.workflowId,
				...sourceIdWhere(key.sourceId),
				status: "RUNNING",
			},
			select: { id: true, steps: true },
		});
		for (const row of rows) {
			const steps = parseSteps(row.steps);
			const running = steps.find((step) => step.status === "running");
			if (!running) {
				continue;
			}
			await db.backgroundJob.update({
				where: { id: row.id },
				data: {
					steps: applyStepTransition(
						steps,
						running.key,
						"failed",
						error,
					) as unknown as Prisma.InputJsonValue,
				},
			});
		}
	} catch {
		// Best-effort telemetry.
	}
}

/**
 * Close a job as FAILED with a human-readable reason.
 *
 * `error` is rendered verbatim in the Job Hub, so callers should pass the
 * message a user can act on ("Authentication token expired. Re-connect to
 * retry."), not a stack trace.
 */
export async function failBackgroundJob(
	key: BackgroundJobKey,
	args: { error: string; errorClass?: string },
): Promise<void> {
	try {
		const now = new Date();
		await db.backgroundJob.updateMany({
			where: {
				workflowId: key.workflowId,
				...sourceIdWhere(key.sourceId),
				status: "RUNNING",
			},
			data: {
				status: "FAILED",
				error: args.error,
				errorClass: args.errorClass ?? null,
				completedAt: now,
				heartbeatAt: now,
			},
		});
		// A failed job is just as finished as a completed one: without this the
		// step it died on keeps spinning and the ones after it read "Queued"
		// forever, on a row that is over.
		await skipUnreachedSteps({
			workflowId: key.workflowId,
			...sourceIdWhere(key.sourceId),
			status: "FAILED",
			completedAt: now,
		});
	} catch {
		// Best-effort telemetry.
	}
}

// =============================================================================
// Readers (used by the oRPC `jobs` module)
// =============================================================================

export interface BackgroundJobTenantFilter {
	userId: string;
	/** null ⇒ personal context (organizationId IS NULL AND userId = me). */
	organizationId: string | null;
}

export interface BackgroundJobListItem {
	id: string;
	kind: BackgroundJobKind;
	status: BackgroundJobStatus;
	title: string;
	sourceType: string | null;
	sourceId: string | null;
	counts: BackgroundJobCounts;
	steps: BackgroundJobStep[];
	error: string | null;
	errorClass: string | null;
	projectId: string;
	projectName: string;
	startedAt: Date;
	completedAt: Date | null;
	createdAt: Date;
}

/**
 * Tenant-scoped project-access predicate, matching `listProjects`: a job is
 * visible when its project is owned by the user or they hold a live accepted
 * membership. Job visibility must never exceed project visibility.
 */
function projectAccessFilter(
	filter: BackgroundJobTenantFilter,
): Prisma.ProjectWhereInput {
	return {
		OR: [
			{ userId: filter.userId },
			{
				members: {
					some: {
						userId: filter.userId,
						acceptedAt: { not: null },
						OR: [
							{ expiresAt: null },
							{ expiresAt: { gt: new Date() } },
						],
					},
				},
			},
		],
	};
}

function tenantWhere(
	filter: BackgroundJobTenantFilter,
): Prisma.BackgroundJobWhereInput {
	// XOR tenancy: the explicit `organizationId: null` is required so personal
	// jobs never leak into an org workspace and vice versa.
	return filter.organizationId
		? { organizationId: filter.organizationId }
		: { organizationId: null, userId: filter.userId };
}

/**
 * One indexed query backing the Job Hub panel: everything still running, plus
 * anything that finished inside the retention window.
 *
 * Running jobs are always included regardless of age — a long-running index
 * must not vanish from the panel mid-run. The watchdog bounds that set.
 */
export async function listBackgroundJobsForUser(args: {
	filter: BackgroundJobTenantFilter;
	retentionDays: number;
	limit: number;
}): Promise<BackgroundJobListItem[]> {
	const cutoff = new Date(
		Date.now() - args.retentionDays * 24 * 60 * 60 * 1000,
	);

	const rows = await db.backgroundJob.findMany({
		where: {
			...tenantWhere(args.filter),
			OR: [{ status: "RUNNING" }, { createdAt: { gte: cutoff } }],
			project: projectAccessFilter(args.filter),
		},
		select: {
			id: true,
			kind: true,
			status: true,
			title: true,
			sourceType: true,
			sourceId: true,
			counts: true,
			steps: true,
			error: true,
			errorClass: true,
			projectId: true,
			startedAt: true,
			completedAt: true,
			createdAt: true,
			project: { select: { name: true } },
		},
		orderBy: { createdAt: "desc" },
		take: args.limit,
	});

	return rows.map((row) => ({
		id: row.id,
		kind: row.kind,
		status: row.status,
		title: row.title,
		sourceType: row.sourceType,
		sourceId: row.sourceId,
		counts: (row.counts ?? {}) as BackgroundJobCounts,
		steps: parseSteps(row.steps),
		error: row.error,
		errorClass: row.errorClass,
		projectId: row.projectId,
		projectName: row.project.name,
		startedAt: row.startedAt,
		completedAt: row.completedAt,
		createdAt: row.createdAt,
	}));
}

/** Badge count: how many jobs are running right now for this tenant. */
export async function countActiveBackgroundJobs(
	filter: BackgroundJobTenantFilter,
): Promise<number> {
	return db.backgroundJob.count({
		where: {
			...tenantWhere(filter),
			status: "RUNNING",
			project: projectAccessFilter(filter),
		},
	});
}

// =============================================================================
// Retention + watchdog (called from Temporal scheduled activities)
// =============================================================================

/**
 * Delete finished jobs older than the retention window, in batches.
 *
 * Also sweeps ancient RUNNING rows: the watchdog normally fails them long
 * before this, but a row orphaned while the watchdog schedule was down must not
 * pin the table open forever.
 */
export async function purgeExpiredBackgroundJobs(args: {
	retentionDays: number;
	batchSize?: number;
	maxBatches?: number;
}): Promise<{ deleted: number; batches: number }> {
	const batchSize = args.batchSize ?? 5_000;
	const maxBatches = args.maxBatches ?? 1_000;
	const cutoff = new Date(
		Date.now() - args.retentionDays * 24 * 60 * 60 * 1000,
	);

	let deleted = 0;
	let batches = 0;

	while (batches < maxBatches) {
		const doomed = await db.backgroundJob.findMany({
			where: { createdAt: { lt: cutoff } },
			select: { id: true },
			take: batchSize,
		});
		if (doomed.length === 0) {
			break;
		}
		const result = await db.backgroundJob.deleteMany({
			where: { id: { in: doomed.map((row) => row.id) } },
		});
		deleted += result.count;
		batches++;
		if (doomed.length < batchSize) {
			break;
		}
	}

	return { deleted, batches };
}

/**
 * Fail jobs whose heartbeat went stale — the worker died mid-run, so nothing
 * will ever close them. Without this a crashed job sticks in ACTIVE forever and
 * the badge count never returns to zero.
 */
export async function failStaleBackgroundJobs(args: {
	staleMinutes: number;
}): Promise<number> {
	const threshold = new Date(Date.now() - args.staleMinutes * 60 * 1000);
	const now = new Date();
	const result = await db.backgroundJob.updateMany({
		where: { status: "RUNNING", heartbeatAt: { lt: threshold } },
		data: {
			status: "FAILED",
			error: "Timed out — no progress reported",
			errorClass: "TimedOut",
			completedAt: now,
			heartbeatAt: now,
		},
	});
	// Same reason as the other close paths: a dead row must not keep a spinner
	// running on the step it was on. Scoped by `completedAt` to the rows this
	// sweep just closed.
	await skipUnreachedSteps({ status: "FAILED", completedAt: now });
	return result.count;
}
