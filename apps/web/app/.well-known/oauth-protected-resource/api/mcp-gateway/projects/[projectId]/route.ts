/**
 * Protected-resource metadata for `<origin>/api/mcp-gateway/projects/<id>` (RFC
 * 9728 path insertion). This is the URL the project gateway's
 * `WWW-Authenticate` challenge names, and its `resource` is exactly that
 * project's URL: the value a client compares with the URL it was configured
 * with and asks for when it signs in.
 *
 * Any well-formed id is answered, without asking the database whether the
 * project exists, so this document says nothing about which projects do.
 */

import { isProjectId } from "@repo/utils/oauth-project-resource";
import {
	discoveryPreflightResponse,
	gatewayResourceMetadataResponse,
} from "@saas/mcp/lib/oauth-discovery";
import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
	request: NextRequest,
	{ params }: { params: Promise<{ projectId: string }> },
) {
	const { projectId } = await params;
	if (!isProjectId(projectId)) {
		return NextResponse.json({ error: "Not found" }, { status: 404 });
	}
	return gatewayResourceMetadataResponse(request, projectId);
}

export function OPTIONS() {
	return discoveryPreflightResponse();
}
