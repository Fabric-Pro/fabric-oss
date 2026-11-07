import { createHash, randomUUID } from "node:crypto";
import {
	prepareDeliverySignalCapture,
	readSlackDeliveryPage,
	SlackDeliveryCaptureError,
} from "@repo/connectors";
import { isDeliverySourceCaptureWindow } from "@repo/connectors/delivery-source-capture-limits";
import {
	commitDeliverySourceCapturePage,
	DeliverySourceStoreError,
	getDeliverySourcePageReceipt,
	getOwnedDeliverySourceCaptureCancellation,
	purgeExpiredDeliverySourceObservations,
} from "@repo/database";
import {
	DELIVERY_SOURCE_CAPTURE_MAX_PAGES,
	type DeliverySourceCaptureInput,
	type DeliverySourceCaptureResult,
} from "@repo/temporal/delivery-source-capture-contracts";
import { decryptApiKey, encryptApiKey, isEncryptedApiKey } from "@repo/utils";
import { activityInfo, Context } from "@temporalio/activity";
import { ApplicationFailure, CancelledFailure } from "@temporalio/common";
import {
	DeliverySourceAccessError,
	encodeDeliverySourceSnapshot,
	loadPinnedSlackDeliveryCredentials,
} from "../lib/delivery-source-access";
import {
	PrivateDeliverySourceUnavailableError,
	requirePrivateDeliverySourceAvailability,
} from "../lib/delivery-source-readiness";

export interface DeliverySourceCapturePageInput
	extends DeliverySourceCaptureInput {
	workflowId: string;
	pageIndex: number;
}
function stopped() {
	if (Context.current().cancellationSignal.aborted) {
		throw new CancelledFailure("Source capture cancelled.");
	}
	Context.current().heartbeat("delivery-source-capture");
}
function invalid(type: string): never {
	throw ApplicationFailure.create({
		message: "Source capture could not complete.",
		type,
		nonRetryable: true,
	});
}
function timestamp(date: Date) {
	return `${Math.floor(date.getTime() / 1000)}.${String(date.getMilliseconds()).padStart(3, "0")}000`;
}
function readCursor(value: string | null) {
	if (value === null) {
		return undefined;
	}
	if (!isEncryptedApiKey(value) || value.length > 16_384) {
		invalid("DELIVERY_SOURCE_CHECKPOINT_INVALID");
	}
	try {
		const cursor = decryptApiKey(value);
		if (!/^[A-Za-z0-9+/_=-]{1,1024}$/.test(cursor)) {
			invalid("DELIVERY_SOURCE_CHECKPOINT_INVALID");
		}
		return cursor;
	} catch {
		return invalid("DELIVERY_SOURCE_CHECKPOINT_INVALID");
	}
}

/** One durable effect per workflow/page index, never a provider page per activity attempt. */
export async function captureDeliverySourcePageActivity(
	input: DeliverySourceCapturePageInput,
): Promise<DeliverySourceCaptureResult> {
	try {
		if (
			!Number.isSafeInteger(input.pageIndex) ||
			input.pageIndex < 0 ||
			input.pageIndex >= DELIVERY_SOURCE_CAPTURE_MAX_PAGES ||
			!Number.isSafeInteger(input.grantRevision) ||
			input.grantRevision < 1 ||
			!Number.isSafeInteger(input.configVersion) ||
			input.configVersion < 1 ||
			!["RECENT", "CONTINUE", "BACKFILL"].includes(input.mode) ||
			(input.mode === "BACKFILL") !== (input.window !== undefined) ||
			(input.window !== undefined &&
				!isDeliverySourceCaptureWindow(input.window)) ||
			activityInfo().workflowExecution?.workflowId !== input.workflowId
		) {
			invalid("DELIVERY_SOURCE_CAPTURE_INPUT_INVALID");
		}
		const scope = {
			organizationId: input.organizationId,
			userId: input.userId,
			projectId: input.projectId,
		};
		stopped();
		await requirePrivateDeliverySourceAvailability();
		stopped();
		const cancelRequested = await getOwnedDeliverySourceCaptureCancellation(
			scope,
			{ watchId: input.watchId, workflowId: input.workflowId },
		);
		stopped();
		if (cancelRequested) {
			throw new CancelledFailure("Source capture cancelled.");
		}
		const prior = await getDeliverySourcePageReceipt(scope, {
			watchId: input.watchId,
			workflowId: input.workflowId,
			pageIndex: input.pageIndex,
		});
		stopped();
		if (prior) {
			return prior;
		}
		const { context, adapterInput } =
			await loadPinnedSlackDeliveryCredentials(
				scope,
				input.watchId,
				true,
			);
		stopped();
		const { watch, grant, integration } = context;
		if (context.cancelRequested) {
			throw new CancelledFailure("Source capture cancelled.");
		}
		if (
			watch.version !== input.configVersion ||
			watch.grantRevision !== input.grantRevision ||
			grant.revision !== input.grantRevision ||
			watch.lastWorkflowId !== input.workflowId ||
			watch.state !== "ACTIVE"
		) {
			invalid("DELIVERY_SOURCE_CONFIGURATION_CHANGED");
		}
		const hasWindow =
			watch.captureWindowStart !== null &&
			watch.captureWindowEnd !== null;
		if (
			(watch.captureWindowStart === null) !==
			(watch.captureWindowEnd === null)
		) {
			invalid("DELIVERY_SOURCE_CHECKPOINT_INVALID");
		}
		const resume =
			input.pageIndex > 0 || (input.mode === "CONTINUE" && hasWindow);
		if (
			resume &&
			(!hasWindow || watch.captureGrantRevision !== input.grantRevision)
		) {
			invalid("DELIVERY_SOURCE_CHECKPOINT_INVALID");
		}
		if (resume && watch.captureComplete) {
			invalid("DELIVERY_SOURCE_CAPTURE_ALREADY_COMPLETE");
		}
		const now = new Date();
		const windowEnd = resume
			? (watch.captureWindowEnd as Date)
			: input.window
				? new Date(input.window.end)
				: now;
		const windowStart = resume
			? (watch.captureWindowStart as Date)
			: input.window
				? new Date(input.window.start)
				: new Date(now.getTime() - 7 * 86_400_000);
		if (
			!Number.isFinite(windowStart.getTime()) ||
			!Number.isFinite(windowEnd.getTime()) ||
			windowStart >= windowEnd ||
			windowEnd.getTime() - windowStart.getTime() > 7 * 86_400_000
		) {
			invalid("DELIVERY_SOURCE_CHECKPOINT_INVALID");
		}
		const cursor = resume
			? readCursor(watch.captureCursorCiphertext)
			: undefined;
		if (resume && !watch.captureComplete && !cursor) {
			invalid("DELIVERY_SOURCE_CHECKPOINT_INVALID");
		}
		if (
			!Number.isSafeInteger(watch.retentionDays) ||
			watch.retentionDays < 1 ||
			watch.retentionDays > 30
		) {
			invalid("DELIVERY_SOURCE_CONFIGURATION_CHANGED");
		}
		await requirePrivateDeliverySourceAvailability();
		stopped();
		const page = await readSlackDeliveryPage(
			{
				...adapterInput,
				oldest: timestamp(windowStart),
				latest: timestamp(windowEnd),
				...(cursor ? { cursor } : {}),
			},
			{ signal: Context.current().cancellationSignal },
		);
		stopped();
		if (page.proof.botUserId !== grant.botUserId) {
			invalid("DELIVERY_SOURCE_CONFIGURATION_CHANGED");
		}
		if (page.hasMore && !page.nextCursor) {
			invalid("DELIVERY_SOURCE_INCOMPLETE_PAGE");
		}
		const expiresAt = new Date(
			now.getTime() + watch.retentionDays * 86_400_000,
		);
		const observations = page.messages.map((message) => {
			stopped();
			const id = randomUUID();
			const snapshot = encodeDeliverySourceSnapshot(message);
			const capture = prepareDeliverySignalCapture({
				schemaVersion: 1,
				adapterVersion: grant.adapterVersion,
				source: {
					organizationId: scope.organizationId,
					projectId: scope.projectId,
					bindingId: watch.id,
					audienceId: grant.id,
					audienceRevision: grant.revision,
					provider: "SLACK",
					installationId: watch.installationId,
					containerId: watch.containerId,
				},
				externalItemId: message.externalItemId,
				revision: message.revision,
				change: "UPSERT",
				occurredAt: message.occurredAt,
				observedAt: page.observedAt,
				untrustedSummary: Array.from(
					message.text.replace(/\p{Cc}/gu, " "),
				)
					.slice(0, 240)
					.join(""),
				evidenceRef: id,
				evidenceDigest: snapshot.digest,
			});
			return {
				id,
				externalItemId: capture.externalItemId,
				revisionKind: capture.revision.kind,
				revisionValue: capture.revision.value,
				receiptKey: capture.receiptKey,
				variantKey: createHash("sha256")
					.update(
						JSON.stringify([
							1,
							capture.receiptKey,
							"UPSERT",
							snapshot.digest,
						]),
					)
					.digest("hex"),
				evidenceDigest: snapshot.digest,
				ciphertext: encryptApiKey(snapshot.payload),
				occurredAt: new Date(message.occurredAt),
				expiresAt,
				hasReplies: message.hasReplies,
			};
		});
		stopped();
		const result: DeliverySourceCaptureResult = {
			captured: observations.length,
			hasMore: page.hasMore,
			coverage: page.coverage,
		};
		await requirePrivateDeliverySourceAvailability();
		stopped();
		const committed = await commitDeliverySourceCapturePage(scope, {
			watchId: watch.id,
			workflowId: input.workflowId,
			pageIndex: input.pageIndex,
			configVersion: input.configVersion,
			grantRevision: input.grantRevision,
			expectedCheckpointVersion: watch.captureCheckpointVersion,
			expectedCredentialDigest: createHash("sha256")
				.update(integration.credentials)
				.digest("hex"),
			expectedIntegrationUpdatedAt: integration.updatedAt,
			windowStart,
			windowEnd,
			cursorCiphertext: page.nextCursor
				? encryptApiKey(page.nextCursor)
				: null,
			complete: !result.hasMore,
			coverage: result.coverage,
			observations,
			result,
		});
		stopped();
		return committed;
	} catch (error) {
		if (
			error instanceof ApplicationFailure ||
			error instanceof CancelledFailure
		) {
			throw error;
		}
		const code =
			error instanceof SlackDeliveryCaptureError
				? error.code
				: error instanceof PrivateDeliverySourceUnavailableError
					? error.code
					: error instanceof DeliverySourceAccessError
						? error.code
						: error instanceof DeliverySourceStoreError
							? `DELIVERY_SOURCE_STORE_${error.code}`
							: "DELIVERY_SOURCE_CAPTURE_UNAVAILABLE";
		throw ApplicationFailure.create({
			message: "Source capture could not complete.",
			type: code,
			nonRetryable:
				error instanceof PrivateDeliverySourceUnavailableError ||
				error instanceof DeliverySourceStoreError ||
				code === "SLACK_DELIVERY_ACCESS_DENIED" ||
				code === "INVALID_SLACK_DELIVERY_INPUT" ||
				code === "DELIVERY_SOURCE_CREDENTIAL_UNAVAILABLE",
		});
	}
}

/** Bounded maintenance only; this is not an ingestion scheduler. */
export async function purgeExpiredDeliverySourceObservationsActivity(): Promise<{
	deletedCount: number;
	batches: number;
	hitSafetyCap: boolean;
}> {
	try {
		let deletedCount = 0;
		for (let batches = 0; batches < 20; batches++) {
			stopped();
			const deleted = await purgeExpiredDeliverySourceObservations({
				batchSize: 500,
			});
			stopped();
			deletedCount += deleted;
			if (deleted < 500) {
				return {
					deletedCount,
					batches: batches + 1,
					hitSafetyCap: false,
				};
			}
		}
		return { deletedCount, batches: 20, hitSafetyCap: true };
	} catch (error) {
		if (error instanceof CancelledFailure) {
			throw error;
		}
		throw ApplicationFailure.create({
			message: "Source retention cleanup could not complete.",
			type: "DELIVERY_SOURCE_RETENTION_UNAVAILABLE",
		});
	}
}
