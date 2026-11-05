/** Compatibility HTTP adapter. Native export commands are shared with oRPC, REST and MCP. */

import {
	FrameExportError,
	startFrameExport,
} from "@repo/api/modules/frames/lib/frame-export-service";
import { auth } from "@repo/auth";
import { type NextRequest, NextResponse } from "next/server";
export async function POST(
	request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const session = await auth.api.getSession({ headers: request.headers });
	if (!session?.user) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}
	const body = await request.json().catch(() => null);
	if (!body || typeof body !== "object") {
		return NextResponse.json(
			{ error: "Provide a reviewed page revision and request ID." },
			{ status: 400 },
		);
	}
	const organizationId =
		body.organizationId ?? session.session.activeOrganizationId;
	if (typeof organizationId !== "string") {
		return NextResponse.json({ error: "Frame not found" }, { status: 404 });
	}
	try {
		const { id } = await params;
		const result = await startFrameExport(
			{
				userId: session.user.id,
				userEmail: session.user.email,
				organizationId,
			},
			{
				frameId: id,
				expectedUpdatedAt: body.expectedUpdatedAt,
				requestId: body.requestId,
				orientation: body.orientation,
			},
		);
		return NextResponse.json({
			...result,
			workflowId: result.exportId,
			success: true,
		});
	} catch (error) {
		return NextResponse.json(
			{
				error:
					error instanceof FrameExportError
						? error.message
						: "Export could not be confirmed. Retry the same request ID.",
			},
			{ status: error instanceof FrameExportError ? error.status : 503 },
		);
	}
}
