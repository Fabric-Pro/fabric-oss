/**
 * Frame PDF Export Status API
 *
 * Polls the status of a frame PDF export workflow.
 */

import { auth } from "@repo/auth";
import {
	canReadOrganizationFrames,
	getAccessibleFrameById,
} from "@repo/database";
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

		const { id: frameId, workflowId } = await params;
		const organizationId = session.session.activeOrganizationId;
		const prefix = `frame-export-${frameId}-`;
		if (
			!workflowId.startsWith(prefix) ||
			!/^\d+$/.test(workflowId.slice(prefix.length)) ||
			!organizationId ||
			!(await canReadOrganizationFrames(session.user.id, organizationId))
		) {
			return NextResponse.json({ status: "not_found" }, { status: 404 });
		}
		const frame = await getAccessibleFrameById({
			id: frameId,
			userId: session.user.id,
			userEmail: session.user.email,
			organizationId,
		});
		if (!frame)
			return NextResponse.json({ status: "not_found" }, { status: 404 });

		// Get workflow status
		const client = await getTemporalClient();
		const handle = client.workflow.getHandle(workflowId);

		try {
			// Polling must not wait for a running workflow to finish.
			const description = await handle.describe();
			if (description.status.name !== "COMPLETED") {
				return NextResponse.json({
					status: description.status.name.toLowerCase(),
				});
			}
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
