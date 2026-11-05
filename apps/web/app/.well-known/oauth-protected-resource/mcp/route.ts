/**
 * Protected-resource metadata for `<origin>/mcp` (RFC 9728 path insertion).
 */

import { auth } from "@repo/auth";
import { buildGatewayProtectedResourceMetadata } from "@repo/auth/lib/oauth-protected-resource";
import { getBaseUrl } from "@repo/utils";
import { discoveryPreflightResponse } from "@saas/mcp/lib/oauth-discovery";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
	const server = await auth.api.getOAuthServerConfig({
		request,
		asResponse: false,
	});
	const appUrl = getBaseUrl().replace(/\/+$/, "");
	const metadata = buildGatewayProtectedResourceMetadata({
		appUrl,
		issuer: server.issuer,
	});

	return Response.json(
		{
			...metadata,
			resource: `${appUrl}/mcp`,
		},
		{
			headers: {
				"Access-Control-Allow-Origin": "*",
				"Cache-Control":
					"public, max-age=15, stale-while-revalidate=15",
			},
		},
	);
}

export function OPTIONS() {
	return discoveryPreflightResponse();
}
