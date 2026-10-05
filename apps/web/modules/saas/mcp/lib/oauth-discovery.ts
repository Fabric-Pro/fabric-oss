/**
 * Discovery documents an MCP client reads to sign in instead of pasting a key.
 *
 * Better Auth serves its own metadata only under `/api/auth/...`, and clients
 * look for it at the well-known locations RFC 8414 and RFC 9728 define, so the
 * `app/.well-known` routes delegate here. Both documents are public and
 * identical for every caller, hence the open CORS header: browser-based MCP
 * clients fetch them cross-origin.
 */

import { auth } from "@repo/auth";
import { buildGatewayProtectedResourceMetadata } from "@repo/auth/lib/oauth-protected-resource";
import { getBaseUrl } from "@repo/utils";

const CORS_HEADERS = { "Access-Control-Allow-Origin": "*" } as const;
const CACHE_CONTROL = "public, max-age=15, stale-while-revalidate=15";

function readAuthorizationServerMetadata(request: Request) {
	return auth.api.getOAuthServerConfig({ request, asResponse: false });
}

export async function authorizationServerMetadataResponse(
	request: Request,
): Promise<Response> {
	return Response.json(await readAuthorizationServerMetadata(request), {
		headers: { ...CORS_HEADERS, "Cache-Control": CACHE_CONTROL },
	});
}

export async function gatewayResourceMetadataResponse(
	request: Request,
	projectId?: string,
): Promise<Response> {
	const server = await readAuthorizationServerMetadata(request);

	return Response.json(
		buildGatewayProtectedResourceMetadata({
			appUrl: getBaseUrl(),
			issuer: server.issuer,
			projectId,
		}),
		{ headers: { ...CORS_HEADERS, "Cache-Control": CACHE_CONTROL } },
	);
}

export function discoveryPreflightResponse(): Response {
	return new Response(null, {
		status: 204,
		headers: {
			...CORS_HEADERS,
			"Access-Control-Allow-Methods": "GET, OPTIONS",
			"Access-Control-Allow-Headers":
				"Content-Type, MCP-Protocol-Version",
		},
	});
}
