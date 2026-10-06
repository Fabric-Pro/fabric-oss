import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../../../src/activities";
import { DEFERRED_SCAN_MAX_ATTEMPTS } from "../../../src/lib/instruction-deferred-scan-retry";

const {
	verifyAndScanInstructionFiles,
	finalizeInstructionSnapshot,
	promoteUnscannedInstructionSnapshot,
	rejectInstructionSnapshot,
	publishInstructionSnapshotActivity,
	pruneInstructionSnapshots,
	recordDeferredScanOutcome,
} = proxyActivities<typeof activities>({
	startToCloseTimeout: "10 minutes",
	heartbeatTimeout: "60 seconds",
	retry: {
		initialInterval: "1s",
		maximumInterval: "30s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

const { scanPublishedInstructionSnapshot } = proxyActivities<typeof activities>(
	{
		startToCloseTimeout: "10 minutes",
		heartbeatTimeout: "60 seconds",
		retry: {
			initialInterval: "1s",
			maximumInterval: "60s",
			backoffCoefficient: 2,
			maximumAttempts: DEFERRED_SCAN_MAX_ATTEMPTS,
		},
	},
);

type Input = {
	snapshotId: string;
	projectId: string;
	organizationId: string;
	userId: string;
	validationAttemptId?: string;
	publishBeforeScan?: boolean;
};

/**
 * The ordinary success path recorded before finalization had its own longer
 * start-to-close budget. It intentionally has no later optional branches: the
 * replay test needs the historical command sequence, not another behavior.
 */
export async function projectInstructionSnapshotWorkflow(input: Input) {
	if (input.publishBeforeScan === true) {
		const promoted = await promoteUnscannedInstructionSnapshot(input);
		if (!promoted.ok) {
			await rejectInstructionSnapshot({
				...input,
				rejections: promoted.rejections,
			});
			return { status: "REJECTED" as const, published: false };
		}
		const publish = await publishInstructionSnapshotActivity(input);
		const scan = await scanPublishedInstructionSnapshot(input);
		await recordDeferredScanOutcome({
			...input,
			outcome: scan.outcome,
			findings: scan.findings,
		});
		await pruneInstructionSnapshots(input);
		return {
			status: "READY" as const,
			published: publish.published,
			publishReason: publish.reason,
			deferredScan: scan.outcome,
		};
	}
	const gated = await verifyAndScanInstructionFiles(input);
	if (!gated.ok) {
		await rejectInstructionSnapshot({
			...input,
			rejections: gated.rejections,
		});
		return { status: "REJECTED" as const, published: false };
	}
	const promoted = await finalizeInstructionSnapshot(input);
	if (!promoted.ok) {
		await rejectInstructionSnapshot({
			...input,
			rejections: promoted.rejections,
		});
		return { status: "REJECTED" as const, published: false };
	}
	const publish = await publishInstructionSnapshotActivity(input);
	await pruneInstructionSnapshots(input);
	return {
		status: "READY" as const,
		published: publish.published,
		publishReason: publish.reason,
	};
}
