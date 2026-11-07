import {
	CancellationScope,
	log,
	ParentClosePolicy,
	proxyActivities,
	startChild,
	workflowInfo,
} from "@temporalio/workflow";
import type * as activities from "../../activities/run-quality";
import type { RunQualityAdmission } from "../../activities/run-quality";

const { admitRecordedRunQuality } = proxyActivities<typeof activities>({
	startToCloseTimeout: "15 seconds",
	scheduleToCloseTimeout: "30 seconds",
	retry: {
		maximumAttempts: 3,
		initialInterval: "1s",
		maximumInterval: "30s",
	},
});
/** Optional quality cannot fail or endlessly stall the admitted business run. */
export async function startRunQualityObserver(input: RunQualityAdmission) {
	return CancellationScope.nonCancellable(async () => {
		let admitted: Awaited<
			ReturnType<typeof activities.admitRecordedRunQuality>
		> = null;
		try {
			admitted = await admitRecordedRunQuality(input);
			if (!admitted) return;
			const info = workflowInfo();
			await startChild("recordedRunQualityWorkflow", {
				workflowId: admitted.workflowId,
				parentClosePolicy: ParentClosePolicy.ABANDON,
				args: [
					{
						assessmentId: admitted.assessmentId,
						userId: admitted.userId,
						organizationId: admitted.organizationId,
					},
				],
				memo: {
					...(typeof info.memo?.correlationId === "string"
						? { correlationId: info.memo.correlationId }
						: {}),
					fabricRunQuality: {
						version: 1,
						assessmentId: admitted.assessmentId,
						userId: admitted.userId,
						organizationId: admitted.organizationId,
					},
				},
			});
		} catch {
			// Do not log native errors or arguments: they may contain source data. Native
			// activity retries are bounded; failure to check must never imply a passing grade.
			log.warn(
				"Automatic quality checking could not start; business execution remains independent.",
			);

			const info = workflowInfo();
			const reference = {
				targetType: input.targetType,
				targetId: input.targetId,
				executionId: input.executionId,
				userId: input.userId,
				organizationId: input.organizationId,
				nativeWorkflowId: info.workflowId,
				nativeRunId: info.runId,
			};
			try {
				await startChild(
					"recordedRunQualityAdmissionRecoveryWorkflow",
					{
						workflowId: `run-quality-recovery-${info.runId}`,
						parentClosePolicy: ParentClosePolicy.ABANDON,
						args: [reference],
						memo: {
							...(typeof info.memo?.correlationId === "string"
								? { correlationId: info.memo.correlationId }
								: {}),
							fabricRunQualityAdmissionRecovery: {
								version: 1,
								...reference,
							},
						},
					},
				);
			} catch {
				log.warn(
					"Independent quality admission recovery could not be acknowledged.",
				);
			}
		}
	});
}
