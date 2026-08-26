/**
 * Frame PDF Export API
 *
 * Starts a Temporal workflow to export a frame to PDF.
 */

import { auth } from "@repo/auth";
import { getTemporalClient } from "@repo/temporal";
import { exportFrameToPDF } from "@repo/temporal/workflows";
import { type NextRequest, NextResponse } from "next/server";

export async function POST(
	request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
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

		const { id: frameId } = await params;
		const body = await request.json();
		const { orientation = "portrait" } = body;

		// Get organization ID from request or session
		const organizationId =
			body.organizationId ??
			session.session.activeOrganizationId ??
			undefined;

		// Start the Temporal workflow
		const client = await getTemporalClient();
		const workflowId = `frame-export-${frameId}-${Date.now()}`;

		const handle = await client.workflow.start(exportFrameToPDF, {
			workflowId,
			taskQueue: "frame-exports",
			args: [
				{
					frameId,
					userId: session.user.id,
					organizationId,
					orientation: orientation as "portrait" | "landscape",
				},
			],
		});

		return NextResponse.json({
			success: true,
			workflowId: handle.workflowId,
			status: "pending",
		});
	} catch (error) {
		console.error("Error starting frame export:", error);
		return NextResponse.json(
			{
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			},
			{ status: 500 },
		);
	}
}
