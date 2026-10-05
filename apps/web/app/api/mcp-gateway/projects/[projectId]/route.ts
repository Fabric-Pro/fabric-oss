/**
 * Fabric MCP Gateway at `/api/mcp-gateway/projects/<id>`: one project's
 * connection.
 *
 * What an agent configured with this URL reaches is that project and nothing
 * else, whatever the person it acts for can open elsewhere. The protocol,
 * authentication and tools are in `@saas/mcp/lib/gateway-endpoint`, shared with
 * the organization-wide gateway; this file only says which project the URL
 * names.
 */

import {
	handleGatewayDelete,
	handleGatewayGet,
	handleGatewayPost,
	resolveGatewayBinding,
} from "@saas/mcp/lib/gateway-endpoint";
import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

interface RouteContext {
	params: Promise<{ projectId: string }>;
}

function notFound(): NextResponse {
	return NextResponse.json({ error: "Not found" }, { status: 404 });
}

export async function POST(
	request: NextRequest,
	{ params }: RouteContext,
): Promise<NextResponse> {
	const binding = resolveGatewayBinding((await params).projectId);
	return binding ? handleGatewayPost(request, binding) : notFound();
}

export async function DELETE(
	request: NextRequest,
	{ params }: RouteContext,
): Promise<NextResponse> {
	const binding = resolveGatewayBinding((await params).projectId);
	return binding ? handleGatewayDelete(request, binding) : notFound();
}

export async function GET(
	request: NextRequest,
	{ params }: RouteContext,
): Promise<NextResponse> {
	const binding = resolveGatewayBinding((await params).projectId);
	return binding ? handleGatewayGet(request, binding) : notFound();
}
