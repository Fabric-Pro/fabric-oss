/**
 * Frame PDF Export Status API
 *
 * Polls the status of a frame PDF export workflow.
 */

import { auth } from "@repo/auth";
import { getTemporalClient } from "@repo/temporal";
import type { ExportFramePDFResult } from "@repo/temporal/workflows";
import { type NextRequest, NextResponse } from "next/server";

export async function GET(
	request: NextRequest,
	{ params }: { params: Promise<{ id: string; workflowId: string }> },
) {
	try {
		const session = await auth.api.getSession({
			headers: request.headers,
		});

		if (!session?.user) {
			return NextResponse.json(
				{ error: "Unauthorized" },
				{ status: 401 },
			);
		}

		const { workflowId } = await params;

		// Get workflow status
		const client = await getTemporalClient();
		const handle = client.workflow.getHandle(workflowId);

		try {
			// Check if workflow is complete
			const result = (await handle.result()) as ExportFramePDFResult;

			return NextResponse.json({
				status: result.success ? "completed" : "failed",
				url: result.url,
				expiresAt: result.expiresAt,
				error: result.error,
			});
		} catch {
			// Workflow still running or not found
			try {
				const description = await handle.describe();
				return NextResponse.json({
					status: description.status.name.toLowerCase(),
				});
			} catch {
				return NextResponse.json(
					{ status: "not_found" },
					{ status: 404 },
				);
			}
		}
	} catch (error) {
		console.error("Error checking frame export status:", error);
		return NextResponse.json(
			{
				status: "error",
				error: error instanceof Error ? error.message : "Unknown error",
			},
			{ status: 500 },
		);
	}
}
