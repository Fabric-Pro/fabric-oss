/**
 * OAuth 2.0 Authorization Server Metadata (RFC 8414)
 *
 * MCP clients (e.g. Claude Code SDK) probe this endpoint during HTTP MCP
 * server discovery to decide whether OAuth is required. Returning a valid
 * JSON response prevents them from failing when they receive the default
 * Next.js HTML 404 page, which is unparseable as an OAuth error response.
 *
 * The Fabric MCP server uses Bearer API-key authentication, not OAuth. This
 * metadata document advertises no authorization endpoint so compliant clients
 * fall back to using the Bearer token already present in their configuration.
 */

import { headers } from "next/headers";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
	const headersList = await headers();
	const host = headersList.get("host") ?? "fabric.pro";
	const proto = process.env.NODE_ENV === "production" ? "https" : "http";
	const issuer = `${proto}://${host}`;

	return NextResponse.json(
		{
			issuer,
			// No authorization_endpoint — this server does not support OAuth flows.
			// Clients should use a static Bearer token (API key) directly.
			token_endpoint: null,
			response_types_supported: [],
			grant_types_supported: [],
			bearer_methods_supported: ["header"],
		},
		{
			headers: {
				"Cache-Control": "public, max-age=3600",
			},
		},
	);
}
