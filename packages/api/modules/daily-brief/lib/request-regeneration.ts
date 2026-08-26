/**
 * Daily Brief — shared regeneration helper.
 *
 * Extracted from `procedures/regenerate.ts` so both the user-facing
 * `regenerate` procedure and internal callers (e.g. the release-notes
 * exclusion "hide → regenerate" flow) drive the exact same
 * check-then-insert-then-start sequence:
 *
 *   1. Idempotency / in-flight guard: if a row is already GENERATING for
 *      (projectId, timeWindowKind), reuse it (`in_flight`). Rows older than
 *      the per-run timeout are probed against Temporal and reclaimed only
 *      when no workflow is actually running.
 *   2. Per-project 5-minute rate limit (skipped when `force` is set — a
 *      deliberate curation action is not spam; the in-flight guard still
 *      applies so `force` never duplicates a running generation).
 *   3. Insert a GENERATING row (partial unique index enforces one in-flight
 *      brief per (projectId, timeWindowKind)).
 *   4. Start `generateDailyBriefWorkflow` and record its workflow id.
 *
 * Non-fatal outcomes (`rate_limited`, `in_flight`, `unavailable`) are
 * returned as a status so callers can decide how to surface them; only a
 * genuine workflow-start failure rolls back the GENERATING row and throws.
 */
import { ORPCError } from "@orpc/server";
import {
	DEFAULT_DAILY_BRIEF_WINDOW,
	db,
	resolveTimeWindow,
	type TimeWindowKind,
} from "@repo/database";
import {
	type GenerateDailyBriefInput,
	getTemporalClient,
	isTemporalAvailable,
} from "@repo/temporal";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";

const RATE_LIMIT_MS = 5 * 60 * 1000; // 5 minutes
// Matches the workflow's per-run `workflowRunTimeout` below. A GENERATING row
// older than this is *eligible* for the orphan check — but reclaim is gated on
// a live Temporal `describe()` (see `isWorkflowStillRunning`), so a workflow
// that legitimately runs past a single 15m run via `continueAsNew`
// (the freshness/convergence chain) stays RUNNING and is never reclaimed.
// Only a row whose latest run is NOT running is abandoned.
const STALE_GENERATING_MS = 15 * 60 * 1000; // 15 minutes

async function isWorkflowStillRunning(
	workflowId: string | null,
): Promise<boolean> {
	if (!workflowId) {
		return false;
	}
	const available = await isTemporalAvailable();
	if (!available) {
		return false;
	}
	try {
		const client = await getTemporalClient();
		const handle = client.workflow.getHandle(workflowId);
		const desc = await handle.describe();
		// WorkflowExecutionStatus enum: 1 = RUNNING, 2 = COMPLETED, 3 = FAILED,
		// 4 = CANCELED, 5 = TERMINATED, 6 = CONTINUED_AS_NEW, 7 = TIMED_OUT.
		// `describe()` resolves the *latest* run of the execution, so a workflow
		// mid-`continueAsNew` reports RUNNING and is not treated as an orphan.
		return desc.status.name === "RUNNING";
	} catch {
		// If Temporal can't describe the workflow (deleted, namespace gone),
		// treat as not running — the row is orphaned.
		return false;
	}
}

/** Input to {@link requestDailyBriefRegeneration}. */
export interface RequestDailyBriefRegenerationInput {
	projectId: string;
	/** The already-authorized project's tenant scope + owner. */
	project: { organizationId: string | null; userId: string };
	/** The acting user id (used for `generatedByUserId` + `triggeredByUserId`). */
	triggeredByUserId: string;
	/** Defaults to `DEFAULT_DAILY_BRIEF_WINDOW` inside the helper. */
	timeWindow?: TimeWindowKind;
	/** When true, skip the 5-minute rate-limit floor (deliberate curation). */
	force?: boolean;
}

/**
 * Result of {@link requestDailyBriefRegeneration}. Carries everything a caller
 * needs to reconstruct the `regenerate` procedure's response byte-for-byte:
 * the brief id, its workflow id (via `brief.temporalWorkflowId`), and the
 * `started` vs `in_flight` distinction.
 */
export type RequestDailyBriefRegenerationResult =
	| { status: "rate_limited" }
	| { status: "unavailable" }
	| {
			status: "started" | "in_flight";
			/**
			 * The GENERATING brief row. `temporalWorkflowId` is the started
			 * workflow id on `started`, and the (possibly-null) stored id on
			 * `in_flight`.
			 */
			brief: { id: string; temporalWorkflowId: string | null };
			/** The freshly-started workflow id (present only on `started`). */
			workflowId?: string;
	  };

/**
 * Idempotent check-then-insert-then-start for a Daily Brief regeneration.
 *
 * Returns a status rather than throwing for rate-limit / in-flight /
 * unavailable so callers can treat those as non-fatal. Only a genuine
 * workflow-start failure rolls back the GENERATING row and throws.
 */
export async function requestDailyBriefRegeneration(
	input: RequestDailyBriefRegenerationInput,
): Promise<RequestDailyBriefRegenerationResult> {
	const timeWindow = input.timeWindow ?? DEFAULT_DAILY_BRIEF_WINDOW;
	const { project } = input;

	// Idempotency: reuse an in-flight brief if one exists for this
	// (project, window). For fresh rows we always reuse — a concurrent
	// regenerate can hit this branch before the original call has
	// populated `temporalWorkflowId`, and killing that row would create
	// a duplicate workflow. Only rows older than the per-run timeout are
	// eligible for the orphan check.
	const inFlight = await db.dailyBrief.findFirst({
		where: {
			projectId: input.projectId,
			timeWindowKind: timeWindow,
			status: "GENERATING",
		},
		orderBy: { generatedAt: "desc" },
	});
	if (inFlight) {
		const ageMs = Date.now() - inFlight.generatedAt.getTime();
		if (ageMs < STALE_GENERATING_MS) {
			return {
				status: "in_flight",
				brief: {
					id: inFlight.id,
					temporalWorkflowId: inFlight.temporalWorkflowId ?? null,
				},
			};
		}
		// Row is past the per-run timeout. Ask Temporal whether the
		// workflow is actually still running; a slow (or converging)
		// workflow is not an orphan.
		if (await isWorkflowStillRunning(inFlight.temporalWorkflowId)) {
			return {
				status: "in_flight",
				brief: {
					id: inFlight.id,
					temporalWorkflowId: inFlight.temporalWorkflowId ?? null,
				},
			};
		}
		// Abandoned row — mark FAILED so the partial unique index
		// releases, and fall through to start a fresh workflow.
		await db.dailyBrief.update({
			where: { id: inFlight.id },
			data: {
				status: "FAILED",
				errorMessage: `Abandoned: GENERATING row exceeded ${STALE_GENERATING_MS / 60_000}m timeout with no running workflow`,
			},
		});
	}

	// Per-project 5-minute floor between successful regens. A deliberate
	// `force` (curation) call skips it; the in-flight guard above already ran.
	if (!input.force) {
		const recent = await db.dailyBrief.findFirst({
			where: {
				projectId: input.projectId,
				generatedAt: { gt: new Date(Date.now() - RATE_LIMIT_MS) },
				status: { not: "FAILED" },
			},
			select: { id: true, generatedAt: true },
		});
		if (recent) {
			return { status: "rate_limited" };
		}
	}

	const temporalAvailable = await isTemporalAvailable();
	if (!temporalAvailable) {
		return { status: "unavailable" };
	}

	const { start, end } = resolveTimeWindow(timeWindow);

	// Insert GENERATING row. Partial unique index will enforce one in-flight
	// brief per (projectId, timeWindowKind); a race loses here and falls back
	// to the inFlight branch on retry.
	let brief: { id: string };
	try {
		brief = await db.dailyBrief.create({
			data: {
				projectId: input.projectId,
				organizationId: project.organizationId ?? null,
				userId: project.organizationId ? null : project.userId,
				generatedByUserId: input.triggeredByUserId,
				timeWindowStart: start,
				timeWindowEnd: end,
				timeWindowKind: timeWindow,
				status: "GENERATING",
			},
			select: { id: true },
		});
	} catch (error) {
		// Unique-violation (partial index) → another regen just started; read it back.
		const raced = await db.dailyBrief.findFirst({
			where: {
				projectId: input.projectId,
				timeWindowKind: timeWindow,
				status: "GENERATING",
			},
			orderBy: { generatedAt: "desc" },
		});
		if (raced) {
			return {
				status: "in_flight",
				brief: {
					id: raced.id,
					temporalWorkflowId: raced.temporalWorkflowId ?? null,
				},
			};
		}
		throw error;
	}

	const client = await getTemporalClient();
	const workflowId = `daily-brief-${brief.id}`;
	const workflowInput: GenerateDailyBriefInput = {
		briefId: brief.id,
		projectId: input.projectId,
		organizationId: project.organizationId ?? null,
		triggeredByUserId: input.triggeredByUserId,
		timeWindowStart: start.toISOString(),
		timeWindowEnd: end.toISOString(),
	};

	try {
		const handle = await client.workflow.start(
			"generateDailyBriefWorkflow",
			withCorrelationMemo({
				taskQueue: "fabric-worker",
				workflowId,
				args: [workflowInput],
				// Bound each individual run to 15m so a `continueAsNew` rerun
				// (the freshness/convergence chain) gets a fresh 15m budget,
				// while an overall 2h execution timeout backstops a runaway
				// chain (comfortably covers MAX_REGEN_CHAIN reruns).
				workflowRunTimeout: "15m",
				workflowExecutionTimeout: "2h",
			}),
		);

		await db.dailyBrief.update({
			where: { id: brief.id },
			data: { temporalWorkflowId: handle.workflowId },
		});

		return {
			status: "started",
			brief: { id: brief.id, temporalWorkflowId: handle.workflowId },
			workflowId: handle.workflowId,
		};
	} catch (error) {
		// Roll back the GENERATING row so the partial unique index releases.
		await db.dailyBrief.update({
			where: { id: brief.id },
			data: {
				status: "FAILED",
				errorMessage:
					error instanceof Error ? error.message : String(error),
			},
		});
		throw new ORPCError("INTERNAL_SERVER_ERROR", {
			message: `Failed to start Daily Brief workflow: ${error instanceof Error ? error.message : "Unknown error"}`,
		});
	}
}
