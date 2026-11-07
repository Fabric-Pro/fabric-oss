import {
	CancellationScope,
	isCancellation,
	proxyActivities,
} from "@temporalio/workflow";
import type * as activities from "../activities/run-quality";
import type { RunQualityObserverInput } from "../activities/run-quality";

const assess = proxyActivities<typeof activities>({
	startToCloseTimeout: "24 hours",
	heartbeatTimeout: "20 seconds",
	retry: { maximumAttempts: 3, initialInterval: "1s" },
});
const fail = proxyActivities<typeof activities>({
	startToCloseTimeout: "1 minute",
	retry: { initialInterval: "1s", maximumInterval: "30s" },
});

/** Independent observer: cancellation and assessment errors never cancel its business parent. */
export async function recordedRunQualityWorkflow(
	input: RunQualityObserverInput,
) {
	try {
		return await assess.assessRecordedRunQuality(input);
	} catch (error) {
		return CancellationScope.nonCancellable(() =>
			fail.failRecordedRunQuality({
				...input,
				errorCode: isCancellation(error)
					? "ASSESSMENT_CANCELLED"
					: "ASSESSMENT_UNAVAILABLE",
			}),
		);
	}
}

/** Only retained unacknowledged admission is reconciled; never creates fresh checks after business work. */
export async function recordedRunQualityAdmissionRecoveryWorkflow(
	input: activities.RunQualityAdmissionRecoveryInput,
) {
	return fail.settleUnconfirmedRunQualityAdmission(input);
}
