import {
	applyTestCasePmUnlink,
	clearTestCasePmCreateClaim,
	db,
	type Prisma,
} from "@repo/database";
import { logger } from "@repo/logs";
import { getTemporalClient } from "@repo/temporal";
import {
	describePmSyncWorkflow,
	describePmSyncWorkflowRun,
	newPmSyncPendingStamp,
	PM_SYNC_START_POLICIES,
	testCaseSyncWorkflowId,
} from "@repo/temporal/pm-sync-start";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";
import { resolvePmTarget } from "./resolve-pm-target";
import type {
	RetryPmSyncItemInput,
	RetryPmSyncItemResult,
} from "./retry-pm-sync-item";

/**
 * The retry's start policies: the case's one workflow id
 * (`testCaseSyncWorkflowId`), a fresh run once the previous one closed, and
 * no attaching to a running one. Sync now and auto-sync attach
 * (`PM_SYNC_START_POLICIES`); the retry cannot, because it stamps an attempt
 * id that only its own run carries (see `retryTestCasePmSync`).
 */
const RETRY_START_POLICIES = {
	workflowIdReusePolicy: PM_SYNC_START_POLICIES.workflowIdReusePolicy,
	workflowIdConflictPolicy: "FAIL",
} as const;

/** The case's PM-sync status fields: what a PENDING stamp replaces. */
const STATUS_SELECT = {
	lastPmSyncStatus: true,
	lastPmSyncError: true,
	lastPmSyncAttemptAt: true,
	lastPmSyncAttemptId: true,
	pmSyncPendingSince: true,
} as const;

/** How many times a stamp whose read went stale is read and tried again. */
const STAMP_ATTEMPTS = 3;

type StatusFields = Prisma.TestCaseGetPayload<{
	select: typeof STATUS_SELECT;
}>;

interface StampedAttempt {
	attemptId: string;
	/** The status fields the stamp replaced, exactly as read. */
	replaced: StatusFields;
}

/**
 * Stamp the case PENDING for a new attempt, as a compare-and-set on the
 * status fields just read: the write applies only while the case still
 * carries them, so `replaced` is exactly what the stamp overwrote and a
 * rollback can restore it. A status that changed in between (a run settled
 * the case, another retry stamped it) is read again.
 *
 * Never stamps over another attempt's PENDING (`attempt-pending`): that
 * attempt's start is in flight, or its run is, and if this stamp replaced it
 * a rollback would restore a PENDING whose start may since have failed and
 * which no run would settle. Such a case is left to that attempt (or to the
 * stuck-sync watchdog, which gives up on it), so `replaced` is never a
 * PENDING for an attempt. `missing` when the case is gone; `null` when its
 * status kept changing.
 */
async function stampPending(
	testCaseId: string,
	projectId: string,
): Promise<StampedAttempt | "missing" | "attempt-pending" | null> {
	for (let attempt = 0; attempt < STAMP_ATTEMPTS; attempt++) {
		const replaced = await db.testCase.findFirst({
			where: { id: testCaseId, projectId },
			select: STATUS_SELECT,
		});
		if (!replaced) {
			return "missing";
		}
		if (
			replaced.lastPmSyncStatus === "PENDING" &&
			replaced.lastPmSyncAttemptId !== null
		) {
			return "attempt-pending";
		}
		const stamp = newPmSyncPendingStamp();
		const { count } = await db.testCase.updateMany({
			where: { id: testCaseId, projectId, ...replaced },
			data: stamp.data,
		});
		if (count === 1) {
			return { attemptId: stamp.attemptId, replaced };
		}
	}
	return null;
}

/**
 * Undo this attempt's PENDING stamp, restoring exactly the status it
 * replaced, while the case is still PENDING for this attempt: a newer
 * attempt's stamp, or a run that already settled this attempt, is left
 * alone. Best effort: a failed rollback leaves the PENDING for the stuck-sync
 * watchdog, which gives up on it.
 */
async function rollbackStamp(
	testCaseId: string,
	projectId: string,
	stamped: StampedAttempt,
): Promise<void> {
	try {
		await db.testCase.updateMany({
			where: {
				id: testCaseId,
				projectId,
				lastPmSyncAttemptId: stamped.attemptId,
				lastPmSyncStatus: "PENDING",
			},
			data: stamped.replaced,
		});
	} catch (error) {
		logger.warn("retryTestCasePmSync rollback failed", {
			testCaseId,
			message: error instanceof Error ? error.message : String(error),
		});
	}
}

/**
 * A start that threw something other than "already started" may still have
 * gone through. Settle it by describing the id: the start is this retry's
 * only if the running run names this attempt in its memo. Any other running
 * run (Sync now, auto-sync, another attempt) does not carry this attempt and
 * would skip its PENDING, so the stamp is rolled back and that run reported.
 * No such workflow, or a closed one, rolls the stamp back too (a closed run
 * of this attempt already settled it, so the rollback matches nothing). A
 * describe that cannot answer leaves the PENDING for the stuck-sync watchdog.
 * The test-case counterpart of `settleFailedPmSyncStart`, which treats any
 * running run as the caller's; the story path keeps using that.
 */
async function settleFailedStart(
	client: Awaited<ReturnType<typeof getTemporalClient>>,
	workflowId: string,
	testCaseId: string,
	projectId: string,
	stamped: StampedAttempt,
): Promise<RetryPmSyncItemResult> {
	const run = await describePmSyncWorkflowRun(client, workflowId);
	if (run.state === "unknown") {
		return { enqueued: false, reason: "start-uncertain", workflowId };
	}
	if (
		run.state === "running" &&
		run.memo?.pmSyncAttemptId === stamped.attemptId
	) {
		return { enqueued: true, workflowId };
	}
	await rollbackStamp(testCaseId, projectId, stamped);
	if (run.state === "running") {
		return { enqueued: false, reason: "already-running", workflowId };
	}
	return { enqueued: false, reason: "temporal-error" };
}

function isAlreadyStarted(error: unknown): boolean {
	return (
		error instanceof Error &&
		error.name === "WorkflowExecutionAlreadyStartedError"
	);
}

/**
 * Retry (or Unlink & re-create) a single test case's PM push: start
 * `testCaseSyncWorkflow` for just that case under the case's one workflow id.
 *
 * The retry stamps the case PENDING with a fresh attempt id and hands it to
 * the run it starts; that run's status writes land only for that attempt,
 * and any other run's skip a case PENDING for an attempt. So the retry never
 * leaves its PENDING on a case whose push is another run's:
 *
 * 1. A push of the case already running is reported (`already-running`):
 *    nothing is cleared, stamped or started, and that run settles the case.
 * 2. Otherwise Unlink & re-create clears exactly the link and create claim
 *    the caller read (`pm-recovery-stale` when they changed, or when another
 *    attempt is PENDING), and the case is stamped (a compare-and-set,
 *    `stampPending`), never over another attempt's PENDING
 *    (`already-running`), so a rollback never restores a PENDING.
 * 3. The start uses the FAIL conflict policy and names the attempt in its
 *    memo. A run that started after step 1 makes it throw "already
 *    started": the stamp is rolled back to what it replaced, and
 *    `already-running` is reported. Any other error is settled by
 *    `settleFailedStart`: only a running run whose memo names this attempt
 *    keeps the PENDING; another running run, or no run, rolls the stamp
 *    back; a describe that cannot answer leaves it for the stuck-sync
 *    watchdog (`start-uncertain`).
 *
 * Accepted race: a run without an attempt id (Sync now, auto-sync) that
 * started after step 1 and wrote its final status between the stamp and the
 * rollback had that write skipped, and the rollback restores the status from
 * before the stamp. The link is written whatever the status, so no PM item
 * is lost or duplicated; only the badge can be one push behind.
 */
export async function retryTestCasePmSync(
	input: RetryPmSyncItemInput,
): Promise<RetryPmSyncItemResult> {
	const { itemId, projectId, userId } = input;

	const project = await db.project.findUnique({
		where: { id: projectId },
		select: {
			id: true,
			organizationId: true,
			readOnlyMode: true,
			projectManagementMcpServerId: true,
			projectManagementMcpConfigId: true,
			projectManagementContainerId: true,
			projectManagementContainerName: true,
			projectManagementAdditionalContext: true,
		},
	});
	if (!project) {
		return { enqueued: false, reason: "project-not-found" };
	}
	// Read-only mode: nothing is cleared or stamped, as on the story path.
	if (project.readOnlyMode) {
		return { enqueued: false, reason: "read-only-mode" };
	}
	if (!project.projectManagementContainerId) {
		return { enqueued: false, reason: "no-pm-config" };
	}

	// Accept both MCP-backed and GitLab-REST projects (the same resolver the
	// bulk sync uses); a null target means no usable PM connection.
	const target = await resolvePmTarget({
		project: {
			projectManagementMcpServerId: project.projectManagementMcpServerId,
			projectManagementMcpConfigId: project.projectManagementMcpConfigId,
			projectManagementAdditionalContext:
				project.projectManagementAdditionalContext,
			organizationId: project.organizationId,
		},
		userId,
		organizationId: project.organizationId,
	});
	if (!target) {
		return { enqueued: false, reason: "no-pm-config" };
	}

	const workflowId = testCaseSyncWorkflowId(projectId, itemId);
	let client: Awaited<ReturnType<typeof getTemporalClient>>;
	try {
		client = await getTemporalClient();
	} catch (error) {
		logger.warn("retryTestCasePmSync could not reach Temporal", {
			testCaseId: itemId,
			message: error instanceof Error ? error.message : String(error),
		});
		return { enqueued: false, reason: "temporal-error" };
	}

	// 1. A push of this case is running: it settles the case.
	if ((await describePmSyncWorkflow(client, workflowId)) === "running") {
		return { enqueued: false, reason: "already-running", workflowId };
	}

	// 2. Unlink & re-create: the user's decision that no PM item exists for
	// the case (or that a second one is wanted). Clears only what the
	// caller read with the case; a change since then means another push may
	// already be creating, so nothing is cleared or started.
	if (input.unlinkFirst && input.externalId) {
		const { applied, claimTooRecent } = await applyTestCasePmUnlink({
			projectId,
			testCaseId: itemId,
			expectedExternalId: input.externalId,
			expectedExternalUrl: input.externalUrl ?? null,
			expectedExternalMcpServerId: input.externalMcpServerId,
			expectedPmCreateClaimId: input.pmCreateClaimId,
		});
		if (claimTooRecent) {
			return {
				enqueued: false,
				reason: "pm-recovery-too-recent",
				recoverableAt: claimTooRecent.recoverableAt,
			};
		}
		if (!applied) {
			return { enqueued: false, reason: "pm-recovery-stale" };
		}
	} else if (input.unlinkFirst && input.pmCreateClaimId) {
		const { cleared, claimTooRecent } = await clearTestCasePmCreateClaim({
			projectId,
			testCaseId: itemId,
			claimId: input.pmCreateClaimId,
		});
		if (claimTooRecent) {
			return {
				enqueued: false,
				reason: "pm-recovery-too-recent",
				recoverableAt: claimTooRecent.recoverableAt,
			};
		}
		if (!cleared) {
			return { enqueued: false, reason: "pm-recovery-stale" };
		}
	}

	const stamped = await stampPending(itemId, projectId);
	if (stamped === "missing") {
		return { enqueued: false, reason: "item-not-found" };
	}
	if (stamped === "attempt-pending") {
		return { enqueued: false, reason: "already-running", workflowId };
	}
	if (stamped === null) {
		return { enqueued: false, reason: "superseded" };
	}

	// 3. Start, never attaching to another run.
	try {
		const additionalContext =
			(project.projectManagementAdditionalContext as Record<
				string,
				string
			> | null) ?? undefined;
		const handle = await client.workflow.start(
			"testCaseSyncWorkflow",
			withCorrelationMemo({
				taskQueue: "ai-chat",
				workflowId,
				...RETRY_START_POLICIES,
				// Read back by `settleFailedStart` to tell this retry's run
				// from another run under the same id.
				memo: { pmSyncAttemptId: stamped.attemptId },
				args: [
					{
						projectId,
						// Guarded by the `resolvePmTarget` contract above (it only
						// returns non-null when the project has a server id).
						// biome-ignore lint/style/noNonNullAssertion: resolvePmTarget guarantees a server id
						mcpServerId: project.projectManagementMcpServerId!,
						mcpConfigId:
							target.kind === "mcp" ? target.mcpConfigId : null,
						containerId: project.projectManagementContainerId,
						containerName:
							project.projectManagementContainerName ?? undefined,
						additionalContext,
						userId,
						organizationId: project.organizationId || undefined,
						testCaseIds: [itemId],
						direction: "push",
						unsyncedOnly: false,
						// Scopes the run's status writes for this case to
						// this attempt.
						pmSyncAttemptId: stamped.attemptId,
					},
				],
			}),
		);
		return { enqueued: true, workflowId: handle.workflowId };
	} catch (error) {
		if (isAlreadyStarted(error)) {
			await rollbackStamp(itemId, projectId, stamped);
			return { enqueued: false, reason: "already-running", workflowId };
		}
		logger.warn("retryTestCasePmSync temporal start failed", {
			testCaseId: itemId,
			workflowId,
			message: error instanceof Error ? error.message : String(error),
		});
		return settleFailedStart(
			client,
			workflowId,
			itemId,
			projectId,
			stamped,
		);
	}
}
