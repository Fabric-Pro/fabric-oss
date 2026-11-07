import {
	DELIVERY_SOURCE_CAPTURE_MAX_PAGES,
	type DeliverySourceCaptureInput,
	type DeliverySourceCaptureResult,
} from "@repo/temporal/delivery-source-capture-contracts";
import {
	ActivityCancellationType,
	proxyActivities,
	workflowInfo,
} from "@temporalio/workflow";
import type * as activities from "../activities/delivery-source-capture";

export type {
	DeliverySourceCaptureInput,
	DeliverySourceCaptureResult,
} from "@repo/temporal/delivery-source-capture-contracts";

const captures = proxyActivities<typeof activities>({
	startToCloseTimeout: "2 minutes",
	heartbeatTimeout: "30 seconds",
	cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
	retry: {
		maximumAttempts: 3,
		initialInterval: "2 seconds",
		maximumInterval: "15 seconds",
	},
});
const retention = proxyActivities<typeof activities>({
	startToCloseTimeout: "5 minutes",
	cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
	retry: {
		maximumAttempts: 3,
		initialInterval: "30 seconds",
		maximumInterval: "2 minutes",
	},
});

/** New finite workflow. Only identities and minimized counts cross the activity boundary. */
export async function deliverySourceCaptureWorkflow(
	input: DeliverySourceCaptureInput,
): Promise<DeliverySourceCaptureResult> {
	const safeInput = {
		organizationId: input.organizationId,
		userId: input.userId,
		projectId: input.projectId,
		watchId: input.watchId,
		grantRevision: input.grantRevision,
		configVersion: input.configVersion,
		mode: input.mode,
		...(input.mode === "BACKFILL" && input.window
			? { window: input.window }
			: {}),
	};
	const workflowId = workflowInfo().workflowId;
	let captured = 0;
	let partial = false;
	let hasMore = true;
	for (
		let pageIndex = 0;
		pageIndex < DELIVERY_SOURCE_CAPTURE_MAX_PAGES && hasMore;
		pageIndex++
	) {
		const page = await captures.captureDeliverySourcePageActivity({
			...safeInput,
			workflowId,
			pageIndex,
		});
		captured += page.captured;
		partial ||= page.coverage === "PARTIAL";
		hasMore = page.hasMore;
	}
	return {
		captured,
		hasMore,
		coverage: partial || hasMore ? "PARTIAL" : "ROOT_MESSAGES_ONLY",
	};
}

/** Deletes expired private evidence; never starts capture or calls a provider. */
export async function deliverySourceObservationRetentionWorkflow() {
	return retention.purgeExpiredDeliverySourceObservationsActivity();
}
