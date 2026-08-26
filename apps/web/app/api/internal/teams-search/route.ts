/**
 * Internal Teams Search Endpoint
 *
 * Called by the LangGraph agent's tool_node to search Microsoft Teams messages
 * for a project. Reuses the existing searchProjectTeamsMessages function.
 *
 * Auth: Uses X-AI-Token JWT (same as /api/mcp/configs). Body-based userId is not
 * accepted to prevent impersonation.
 *
 * Pattern: Same as data-analyst's fetchMcpConfigs → /api/mcp/configs
 */

import { AI_TOKEN_HEADER, verifyAIToken } from "@repo/ai-token";
import {
	type SearchProjectTeamsMessagesInput,
	searchProjectTeamsMessages,
} from "@repo/temporal/activities";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(req: Request) {
	try {
		const body = await req.json();
		const {
			projectId,
			query,
			alternateQuery,
			stagePrompt,
			limit = 15,
		} = body;

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

		const input: SearchProjectTeamsMessagesInput = {
			projectId,
			query,
			alternateQuery:
				typeof alternateQuery === "string" ? alternateQuery : undefined,
			stagePrompt:
				typeof stagePrompt === "string" ? stagePrompt : undefined,
			userId,
			organizationId,
			limit: Math.min(limit, 50),
		};

		const result = await searchProjectTeamsMessages(input);

		return NextResponse.json(result);
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";
		console.error("[Internal Teams Search] Error:", errorMessage);

		return NextResponse.json(
			{ error: errorMessage, messages: [], totalCount: 0 },
			{ status: 500 },
		);
	}
}
