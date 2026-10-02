/**
 * OAuth 2.0 Authorization Server Metadata (RFC 8414), at the root.
 *
 * Older MCP clients probe the bare `/.well-known/oauth-authorization-server`
 * before they try the path-inserted form, so it answers with the same real
 * document rather than a stub that advertises no OAuth. The issuer is
 * `<origin>/api/auth`; the document for that issuer lives at
 * `/.well-known/oauth-authorization-server/api/auth` (RFC 8414 path insertion)
 * and both are served from one definition.
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
