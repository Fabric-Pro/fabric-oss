/**
 * Protected-resource metadata (RFC 9728), at the root.
 *
 * The gateway is the one resource an agent signs in for, so the bare document
 * describes it too: clients that cannot use path insertion still find it. The
 * path-inserted form is `/.well-known/oauth-protected-resource/api/mcp-gateway`.
 */

import {
	discoveryPreflightResponse,
	gatewayResourceMetadataResponse,
} from "@saas/mcp/lib/oauth-discovery";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
	return gatewayResourceMetadataResponse(request);
}

export function OPTIONS() {
	return discoveryPreflightResponse();
}
