/**
 * Protected-resource metadata for `<origin>/api/mcp-gateway` (RFC 9728 path
 * insertion). This is the URL the gateway's `WWW-Authenticate` challenge names.
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
