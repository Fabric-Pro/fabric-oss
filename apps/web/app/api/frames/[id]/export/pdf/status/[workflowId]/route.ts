/** Compatibility status adapter; legacy bearer-bearing results are never reissued. */

import {
	FrameExportError,
	getFrameExport,
} from "@repo/api/modules/frames/lib/frame-export-service";
import { auth } from "@repo/auth";
import { type NextRequest, NextResponse } from "next/server";
export async function GET(
	request: NextRequest,
	{ params }: { params: Promise<{ id: string; workflowId: string }> },
) {
	const session = await auth.api.getSession({ headers: request.headers });
	if (!session?.user) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}
	const organizationId = session.session.activeOrganizationId;
	if (!organizationId) {
		return NextResponse.json({ status: "not_found" }, { status: 404 });
	}
	try {
		const { id, workflowId } = await params;
		return NextResponse.json(
			await getFrameExport(
				{
					userId: session.user.id,
					userEmail: session.user.email,
					organizationId,
				},
				{ frameId: id, exportId: workflowId },
			),
		);
	} catch (error) {
		return NextResponse.json(
			{
				status:
					error instanceof FrameExportError && error.status === 404
						? "not_found"
						: "error",
				error:
					error instanceof FrameExportError
						? error.message
						: "Export status could not be confirmed.",
			},
			{ status: error instanceof FrameExportError ? error.status : 503 },
		);
	}
}
