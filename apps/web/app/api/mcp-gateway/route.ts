/**
 * Fabric MCP Gateway at `/api/mcp-gateway`: the organization-wide connection.
 *
 * The protocol, authentication and tools are in
 * `@saas/mcp/lib/gateway-endpoint`, shared with the project-bound gateway at
 * `/api/mcp-gateway/projects/<id>`. A route file may export only its handlers
 * and segment config, which is why the shared code is not here.
 */

import {
	handleGatewayDelete,
	handleGatewayGet,
	handleGatewayPost,
} from "@saas/mcp/lib/gateway-endpoint";
import type { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export function POST(request: NextRequest): Promise<NextResponse> {
	return handleGatewayPost(request, null);
}

export function DELETE(request: NextRequest): Promise<NextResponse> {
	return handleGatewayDelete(request, null);
}

export function GET(request: NextRequest): Promise<NextResponse> {
	return handleGatewayGet(request, null);
}
