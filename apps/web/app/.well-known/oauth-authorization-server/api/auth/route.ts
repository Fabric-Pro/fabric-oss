/**
 * OAuth 2.0 Authorization Server Metadata for the issuer `<origin>/api/auth`
 * (RFC 8414 path insertion). See the root route for why both exist.
 */

import {
	authorizationServerMetadataResponse,
	discoveryPreflightResponse,
} from "@saas/mcp/lib/oauth-discovery";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
	return authorizationServerMetadataResponse(request);
}

export function OPTIONS() {
	return discoveryPreflightResponse();
}
