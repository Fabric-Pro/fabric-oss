/**
 * Frame Export Workflow
 *
 * Temporal workflow for exporting frames to PDF.
 * Orchestrates the export process: fetch content, generate PDF, upload to S3.
 */

import {
	ActivityCancellationType,
	ApplicationFailure,
	CancellationScope,
	defineQuery,
	isCancellation,
	proxyActivities,
	setHandler,
	sleep,
} from "@temporalio/workflow";
import type * as frameExportActivities from "../activities/frame-export";
import {
	FRAME_EXPORT_QUERY,
	type FrameExportState,
	type ManagedFrameExport,
} from "../lib/frame-export-contract";

/**
 * The activity type names this workflow has scheduled since it shipped.
 *
 * They were declared by a hand-written local interface that no compiler ever
 * reconciled against the implementations, which the worker registers as
 * `getFrameContentActivity` / `generatePDFActivity` / `uploadToS3Activity` —
 * so every export failed with "Activity function getFrameContent is not
 * registered on this Worker". The barrel now registers the implementations
 * under these names too.
 *
 * The names are kept rather than corrected because they are baked into every
 * existing history: scheduling `getFrameContentActivity` where a history
 * recorded `getFrameContent` is a non-determinism failure on replay. Each
 * entry is tied to the real implementation's type, so the signatures can no
 * longer drift the way the old interface did.
 */
type FrameExportProxies = {
	getFrameContent: typeof frameExportActivities.getFrameContentActivity;
	generatePDF: typeof frameExportActivities.generatePDFActivity;
	uploadToS3: typeof frameExportActivities.uploadToS3Activity;
};

const activities = proxyActivities<FrameExportProxies>({
	startToCloseTimeout: "2 minutes",
	retry: {
		initialInterval: "1 second",
		maximumInterval: "30 seconds",
		maximumAttempts: 3,
	},
});

export interface ExportFramePDFArgs {
	frameId: string;
	userId: string;
	organizationId?: string;
	orientation?: "portrait" | "landscape";
	expectedUpdatedAt?: string;
	managedExport?: ManagedFrameExport;
}

export interface ExportFramePDFResult {
	success: boolean;
	url?: string;
	expiresAt?: string;
	error?: string;
	storageKey?: string;
}

export async function exportFrameToPDF(
	args: ExportFramePDFArgs,
): Promise<ExportFramePDFResult> {
	if (args.managedExport) {
		return managedFrameExport(args);
	}
	try {
		// 1. Get frame content
		const frame = await activities.getFrameContent({
			frameId: args.frameId,
			userId: args.userId,
			organizationId: args.organizationId,
			...(args.expectedUpdatedAt
				? { expectedUpdatedAt: args.expectedUpdatedAt }
				: {}),
		});

		// 2. Generate PDF
		const pdfBuffer = await activities.generatePDF({
			content: frame.document,
			orientation: args.orientation ?? "portrait",
		});

		// 3. Upload to S3
		const timestamp = Date.now();
		const key = `exports/frames/${args.frameId}/${timestamp}.pdf`;
		const url = await activities.uploadToS3({
			buffer: pdfBuffer,
			key,
			contentType: "application/pdf",
		});

		// URL expires in 24 hours
		const expiresAt = new Date(
			Date.now() + 24 * 60 * 60 * 1000,
		).toISOString();

		return {
			success: true,
			url,
			expiresAt,
		};
	} catch (error) {
		if (error instanceof ApplicationFailure) {
			throw error;
		}
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";
		throw ApplicationFailure.nonRetryable(
			errorMessage,
			"FRAME_EXPORT_FAILED",
		);
	}
}

/** New admissions use native Temporal state and a durable retention timer. Old histories retain their command sequence. */
async function managedFrameExport(
	args: ExportFramePDFArgs,
): Promise<ExportFramePDFResult> {
	const managed = args.managedExport!;
	const a = proxyActivities<{
		renderAndStoreFrameExport: typeof frameExportActivities.renderAndStoreFrameExportActivity;
	}>({
		startToCloseTimeout: "2 minutes",
		cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
		retry: {
			initialInterval: "1 second",
			maximumInterval: "30 seconds",
			maximumAttempts: 3,
		},
	});
	const cleanup = proxyActivities<{
		deleteFrameExport: typeof frameExportActivities.deleteFrameExportActivity;
	}>({
		startToCloseTimeout: "30 seconds",
		retry: {
			initialInterval: "5 seconds",
			maximumInterval: "1 minute",
			maximumAttempts: 100,
		},
	});
	let state: FrameExportState = {
		status: "running",
		expiresAt: managed.expiresAt,
	};
	setHandler(defineQuery<FrameExportState>(FRAME_EXPORT_QUERY), () => state);
	try {
		if (!args.organizationId || !args.expectedUpdatedAt) {
			throw ApplicationFailure.nonRetryable(
				"Export admission is incomplete.",
				"FRAME_EXPORT_INVALID",
			);
		}
		await a.renderAndStoreFrameExport({
			frameId: args.frameId,
			userId: args.userId,
			organizationId: args.organizationId,
			expectedUpdatedAt: args.expectedUpdatedAt,
			key: managed.objectKey,
			expiresAt: managed.expiresAt,
			orientation: args.orientation ?? "portrait",
		});
		state = {
			status: "completed",
			storageKey: managed.objectKey,
			expiresAt: managed.expiresAt,
		};
		await sleep(Math.max(0, Date.parse(managed.expiresAt) - Date.now()));
		state = { status: "expired", expiresAt: managed.expiresAt };
		return { success: true, expiresAt: managed.expiresAt };
	} catch (error) {
		state = {
			status: isCancellation(error) ? "cancelled" : "failed",
			expiresAt: managed.expiresAt,
		};
		if (isCancellation(error)) {
			throw error;
		}
		throw ApplicationFailure.nonRetryable(
			"Page export failed. Review the page and try again.",
			"FRAME_EXPORT_FAILED",
		);
	} finally {
		// Fixed object identity makes deletion safe after ambiguous uploads and retries.
		await CancellationScope.nonCancellable(() =>
			cleanup.deleteFrameExport({ key: managed.objectKey }),
		);
	}
}
