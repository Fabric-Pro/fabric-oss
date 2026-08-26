/**
 * Internal Slack Search Endpoint
 *
 * Called by the LangGraph agent's tool_node to search Slack messages
 * for a project. Reuses the existing searchProjectSlackMessages function.
 *
 * Auth: Uses X-AI-Token JWT (same as /api/mcp/configs). Body-based userId is not
 * accepted to prevent impersonation.
 *
 * Pattern: Mirrors /api/internal/teams-search
 */

import { AI_TOKEN_HEADER, verifyAIToken } from "@repo/ai-token";
import {
	type SearchProjectSlackMessagesInput,
	searchProjectSlackMessages,
} from "@repo/temporal/activities";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(req: Request) {
	try {
		const body = await req.json();
		const { projectId, query, limit = 15 } = body;

		if (!projectId || !query) {
			return NextResponse.json(
				{ error: "Missing required fields: projectId, query" },
				{ status: 400 },
			);
		}

		// Auth: Extract user/org context from AI token (required)
		const aiToken = req.headers.get(AI_TOKEN_HEADER);
		if (!aiToken) {
			return NextResponse.json(
				{ error: "Authentication required: X-AI-Token header missing" },
				{ status: 401 },
			);
		}

		const payload = await verifyAIToken(aiToken);
		if (!payload || !payload.valid) {
			return NextResponse.json(
				{ error: "Invalid AI token" },
				{ status: 401 },
			);
		}

		const userId = payload.claims.sub;
		const organizationId = payload.claims.org;

		const input: SearchProjectSlackMessagesInput = {
			projectId,
			query,
			userId,
			organizationId,
			limit: Math.min(limit, 50),
		};

		const result = await searchProjectSlackMessages(input);

		return NextResponse.json(result);
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";
		console.error("[Internal Slack Search] Error:", errorMessage);

		return NextResponse.json(
			{ error: errorMessage, messages: [], totalCount: 0 },
			{ status: 500 },
		);
	}
}
