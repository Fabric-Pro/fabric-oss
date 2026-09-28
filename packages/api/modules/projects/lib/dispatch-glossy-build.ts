/**
 * The one place a Glossy edition build is started (Fizzy #2589, KTD3, KTD4).
 *
 * **A build is a claimed attempt.** `claimGlossyBuild` moves the edition's
 * `currentBuildId` to a new attempt and writes that attempt's row with the
 * source snapshot, in one transaction; a second build of the same document
 * reads the first as its holder (`alreadyBuilding`). The workflow id is keyed
 * on the attempt (`glossyEditionBuildWorkflowId`), so a rebuild never meets a
 * previous run's id.
 *
 * **A stuck holder is taken over only when it is provably gone.** A run can
 * leave its attempt BUILDING without ever recording a failure: the workflow's
 * 30-minute execution timeout closes it wherever it is — including while its
 * activities are still queued for one of the four `glossy-edition` worker
 * slots — and a timed-out workflow runs no more code, so its catch never
 * writes FAILED. The reclaim takes over such a claim when BOTH hold:
 *   - the holder's heartbeat is older than {@link GLOSSY_BUILD_STALE_AFTER_MS}
 *     (the database re-checks this half under the row lock), and
 *   - Temporal reports the holder's run closed or unknown to it.
 * A running workflow, or one Temporal cannot be asked about, counts as live,
 * as `isGenerationWorkflowLiveActivity` does. The heartbeat half is what
 * keeps a claim whose workflow start is still in flight — Temporal has not
 * heard of it yet — from being taken over. The `get` procedure reads a stuck
 * holder the same way, through {@link isGlossyHolderGone}.
 *
 * **A failed start releases the claim** through the guarded fail write
 * (`releaseGlossyClaim`, error code `WORKFLOW_START_FAILED`), so a retry can
 * claim again. This is safe even when the start actually registered and only
 * its answer was lost: the run's first guarded write then finds its attempt
 * no longer BUILDING and stops as superseded.
 */

import {
	type ClaimGlossyBuildResult,
	claimGlossyBuild,
	type GlossyBuildHolder,
	type GlossyBuildSnapshotInput,
	type Prisma,
	releaseGlossyClaim,
} from "@repo/database";
import { logger } from "@repo/logs";
import {
	GLOSSY_EDITION_TASK_QUEUE,
	type GlossyBuildOptions,
	type GlossyEditionBuildWorkflowInput,
	getTemporalClient,
} from "@repo/temporal";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";

/**
 * The build workflow's execution timeout (KTD3). With every activity's
 * attempts bounded too, a stalled run closes, and the reclaim takes over.
 */
const GLOSSY_BUILD_EXECUTION_TIMEOUT = "30 minutes";

/**
 * How old a holder's heartbeat must be before a build or a read even asks
 * Temporal whether the holder's run is gone: 20 minutes.
 *
 * `heartbeatAt` is written when the claim is taken and when each build
 * activity starts. The longest an activity can then run without another
 * write is one model-call activity through all its attempts: 3 attempts of
 * a 5-minute start-to-close timeout, with 5 s and 10 s of retry backoff
 * between them — 15 minutes 15 seconds (the workflow's proxy options in
 * `glossy-edition-build.ts`). Twenty minutes clears that with margin, and it
 * stays below the 30-minute execution timeout, so a run that timed out is
 * taken over at most twenty minutes after its last write. Time a run spends
 * waiting for a worker slot writes nothing either; that is why staleness is
 * only the question, and Temporal's answer is the verdict.
 */
export const GLOSSY_BUILD_STALE_AFTER_MS = 20 * 60 * 1000;

/** Whether a holder's last write is old enough to ask Temporal about it. */
function isGlossyHeartbeatStale(heartbeatAt: Date | null, now: Date): boolean {
	// A BUILDING attempt always has a heartbeat (a CHECK constraint); a
	// missing one is not evidence of anything, and the reclaim's own
	// conditional update would not match it either.
	return (
		heartbeatAt !== null &&
		heartbeatAt.getTime() < now.getTime() - GLOSSY_BUILD_STALE_AFTER_MS
	);
}

export type GlossyRunLiveness = "running" | "gone" | "unknown";

/**
 * How long the liveness question may take. It runs inside `get` and `build`,
 * so a Temporal that accepts the connection but never answers must not hold
 * the request: an unanswered question is `unknown`, which keeps the claim.
 */
export const GLOSSY_LIVENESS_TIMEOUT_MS = 5_000;

/** Run states Temporal reports once a run has closed for good. */
const CLOSED_RUN_STATUSES: ReadonlySet<string> = new Set([
	"COMPLETED",
	"FAILED",
	"CANCELLED",
	"TERMINATED",
	"CONTINUED_AS_NEW",
	"TIMED_OUT",
]);

/** Run states in which the run still holds its attempt. */
const LIVE_RUN_STATUSES: ReadonlySet<string> = new Set(["RUNNING", "PAUSED"]);

function isNamed(error: unknown, name: string): boolean {
	return error instanceof Error && error.name === name;
}

const LIVENESS_TIMED_OUT = Symbol("liveness timed out");

async function withinLivenessTimeout<T>(
	work: Promise<T>,
): Promise<T | typeof LIVENESS_TIMED_OUT> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<typeof LIVENESS_TIMED_OUT>((resolve) => {
		timer = setTimeout(
			() => resolve(LIVENESS_TIMED_OUT),
			GLOSSY_LIVENESS_TIMEOUT_MS,
		);
	});
	try {
		return await Promise.race([work, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * What Temporal says about one build run: `running`, `gone` (closed for good,
 * or never heard of), or `unknown` when it could not be asked in time or
 * reports a state it does not name. Only `gone` lets a stuck claim be read as
 * failed or taken over; a paused run still holds its attempt.
 */
export async function glossyRunLiveness(
	workflowId: string | null,
): Promise<GlossyRunLiveness> {
	if (!workflowId) {
		return "unknown";
	}
	try {
		const answer = await withinLivenessTimeout(
			(async () => {
				const client = await getTemporalClient();
				return client.workflow.getHandle(workflowId).describe();
			})(),
		);
		if (answer === LIVENESS_TIMED_OUT) {
			return "unknown";
		}
		const status = answer.status.name;
		if (LIVE_RUN_STATUSES.has(status)) {
			return "running";
		}
		return CLOSED_RUN_STATUSES.has(status) ? "gone" : "unknown";
	} catch (error) {
		return isNamed(error, "WorkflowNotFoundError") ? "gone" : "unknown";
	}
}

/** A stale heartbeat AND a run Temporal reports closed or missing. */
export async function isGlossyHolderGone(
	holder: Pick<GlossyBuildHolder, "heartbeatAt" | "workflowId">,
	now: Date,
): Promise<boolean> {
	if (!isGlossyHeartbeatStale(holder.heartbeatAt, now)) {
		return false;
	}
	return (await glossyRunLiveness(holder.workflowId)) === "gone";
}

export interface DispatchGlossyBuildInput {
	documentId: string;
	projectId: string;
	/** The organization the Glossy gate resolved from the project row. */
	organizationId: string;
	/** The editor starting the build: access re-checks and BYOK run as them. */
	userId: string;
	/** What the workflow runs with. */
	options: GlossyBuildOptions;
	/**
	 * What the claim records on the attempt and as the edition's last
	 * options: `options` plus render-time choices the workflow never reads.
	 */
	recordedOptions: Prisma.InputJsonValue;
	/** The build procedure's single read of the document. */
	snapshot: GlossyBuildSnapshotInput;
	now?: Date;
}

export type DispatchGlossyBuildResult =
	| {
			outcome: "started";
			buildId: string;
			workflowId: string;
			startedAt: Date;
			/** A stuck holder was retired to take this claim. */
			reclaimed: boolean;
	  }
	| { outcome: "alreadyBuilding"; holder: GlossyBuildHolder | null }
	/** Temporal refused the start; the claim was released. */
	| { outcome: "startFailed" };

export async function dispatchGlossyBuild(
	input: DispatchGlossyBuildInput,
): Promise<DispatchGlossyBuildResult> {
	const now = input.now ?? new Date();
	const claimInput = {
		documentId: input.documentId,
		projectId: input.projectId,
		organizationId: input.organizationId,
		startedById: input.userId,
		options: input.recordedOptions,
		snapshot: input.snapshot,
		now,
	};

	let claim: ClaimGlossyBuildResult = await claimGlossyBuild(claimInput);
	let reclaimed = false;
	if (claim.outcome === "alreadyBuilding") {
		const holder = claim.holder;
		if (!holder || !(await isGlossyHolderGone(holder, now))) {
			return claim;
		}
		claim = await claimGlossyBuild({
			...claimInput,
			reclaim: {
				holderBuildId: holder.buildId,
				staleBefore: new Date(
					now.getTime() - GLOSSY_BUILD_STALE_AFTER_MS,
				),
			},
		});
		if (claim.outcome === "alreadyBuilding") {
			return claim;
		}
		reclaimed = true;
		logger.info("[GlossyBuild] Reclaimed a stuck build", {
			documentId: input.documentId,
			holderBuildId: holder.buildId,
			buildId: claim.buildId,
		});
	}

	// The id the claim stored on the attempt, which is the one a later
	// stale-holder check describes.
	const workflowId = claim.workflowId;
	const workflowInput: GlossyEditionBuildWorkflowInput = {
		buildId: claim.buildId,
		documentId: input.documentId,
		projectId: input.projectId,
		organizationId: input.organizationId,
		startedById: input.userId,
		options: input.options,
	};

	try {
		const client = await getTemporalClient();
		await client.workflow.start(
			"glossyEditionBuildWorkflow",
			withCorrelationMemo({
				taskQueue: GLOSSY_EDITION_TASK_QUEUE,
				workflowId,
				workflowExecutionTimeout: GLOSSY_BUILD_EXECUTION_TIMEOUT,
				// Ids are per attempt: a conflict can only mean this very
				// start registered twice, which must not become two runs.
				workflowIdConflictPolicy: "FAIL",
				workflowIdReusePolicy: "REJECT_DUPLICATE",
				args: [workflowInput],
			}),
		);
	} catch (error) {
		logger.error("[GlossyBuild] Failed to start the build workflow", {
			documentId: input.documentId,
			buildId: claim.buildId,
			error: error instanceof Error ? error.message : String(error),
		});
		try {
			await releaseGlossyClaim(claim.buildId);
		} catch (releaseError) {
			// The claim stays with this attempt until its heartbeat goes
			// stale; Temporal has no run under its id, so the reclaim takes
			// it over then.
			logger.error("[GlossyBuild] Failed to release the claim", {
				documentId: input.documentId,
				buildId: claim.buildId,
				error:
					releaseError instanceof Error
						? releaseError.message
						: String(releaseError),
			});
		}
		return { outcome: "startFailed" };
	}

	return {
		outcome: "started",
		buildId: claim.buildId,
		workflowId,
		startedAt: claim.startedAt,
		reclaimed,
	};
}
