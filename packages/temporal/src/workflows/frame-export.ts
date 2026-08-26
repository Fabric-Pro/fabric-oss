/**
 * Frame Export Workflow
 *
 * Temporal workflow for exporting frames to PDF.
 * Orchestrates the export process: fetch content, generate PDF, upload to S3.
 */

import { ApplicationFailure, proxyActivities } from "@temporalio/workflow";
import type * as frameExportActivities from "../activities/frame-export";

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
}

export interface ExportFramePDFResult {
	success: boolean;
	url?: string;
	expiresAt?: string;
	error?: string;
}

export async function exportFrameToPDF(
	args: ExportFramePDFArgs,
): Promise<ExportFramePDFResult> {
	try {
		// 1. Get frame content
		const frame = await activities.getFrameContent({
			frameId: args.frameId,
			userId: args.userId,
			organizationId: args.organizationId,
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
