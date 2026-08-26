/**
 * Plain-JSON exchange endpoint for the fabric-kanban CLI.
 * The CLI calls POST /api/kanban/exchangeToken with { token } as plain JSON,
 * not the oRPC envelope format that the [[...rest]] catch-all requires.
 * This route handles CORS so the CLI (running at localhost:3484) can reach
 * the portal (localhost:3001).
 *
 * NOTE: Moved from /api/rpc/kanban/exchangeToken — the /api/rpc/ directory
 * was shadowing the [[...rest]] catch-all for ALL oRPC calls, causing 404s.
 */
import { verifyKanbanLaunchToken } from "@repo/api/modules/kanban/procedures/create-token";
import { getBaseUrl } from "@repo/utils";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

// Additional allowed origins are configured via CORS_ALLOWED_ORIGINS
// (comma-separated). The deployment's own base URL and localhost dev ports
// are always allowed.
const EXTRA_ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS ?? "")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);

function getCorsHeaders(request: NextRequest): HeadersInit {
	const requestOrigin = request.headers.get("origin");
	const allowedOrigins = new Set<string>([
		getBaseUrl(),
		"http://localhost:3001",
		"http://localhost:3484",
		...EXTRA_ALLOWED_ORIGINS,
	]);
	const origin =
		requestOrigin && allowedOrigins.has(requestOrigin)
			? requestOrigin
			: getBaseUrl();
	return {
		"Access-Control-Allow-Origin": origin,
		"Access-Control-Allow-Methods": "POST, OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type",
		"Access-Control-Max-Age": "86400",
		Vary: "Origin",
	};
}

export async function OPTIONS(request: NextRequest): Promise<NextResponse> {
	return new NextResponse(null, {
		status: 204,
		headers: getCorsHeaders(request),
	});
}

export async function POST(request: NextRequest): Promise<NextResponse> {
	const corsHeaders = getCorsHeaders(request);
	try {
		const body = (await request.json()) as { token?: string };
		if (!body.token) {
			return NextResponse.json(
				{ message: "Missing token" },
				{ status: 400, headers: corsHeaders },
			);
		}

		const tokenData = await verifyKanbanLaunchToken(body.token);

		// Return in oRPC envelope format so the CLI can parse it correctly.
		// apiKey is the JWT itself — the CLI uses it as a Bearer token for queue API calls.
		return NextResponse.json(
			{
				json: {
					apiKey: body.token,
					projectId: tokenData.projectId,
					projectName: tokenData.projectName,
					repositoryUrl: tokenData.repositoryUrl ?? null,
					repositoryName: tokenData.repositoryName ?? null,
					localRepoPath: tokenData.localRepoPath ?? null,
					storyId: tokenData.storyId,
					storyTitle: tokenData.storyTitle,
					storyIdentifier: tokenData.storyIdentifier,
					organizationId: tokenData.organizationId ?? null,
					userId: tokenData.sub,
				},
			},
			{ headers: corsHeaders },
		);
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Failed to exchange token";
		return NextResponse.json(
			{ message },
			{ status: 401, headers: corsHeaders },
		);
	}
}
