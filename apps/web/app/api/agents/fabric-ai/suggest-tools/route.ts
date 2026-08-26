/**
 * Pre-flight Tool Suggestion API
 *
 * Lightweight endpoint that analyzes user input and suggests relevant MCP tools
 * that could handle the task. Used for real-time tool suggestions in the chat UI.
 */

import {
	canMcpToolsHandleTask,
	getDetailedMcpToolInfo,
} from "@repo/agent-core/backend";
import { auth } from "@repo/auth";
import { NextResponse } from "next/server";
import { z } from "zod";

const requestSchema = z.object({
	message: z.string().min(1).max(1000),
	organizationId: z.string().optional(),
	enabledMcpConfigIds: z.array(z.string()).optional().nullable(),
});

export interface ToolSuggestion {
	toolName: string;
	serverName: string;
	configName: string;
	description: string;
	reason: string;
}

export interface SuggestToolsResponse {
	suggestions: ToolSuggestion[];
	canHandle: boolean;
	confidence: number;
}

export async function POST(request: Request) {
	try {
		// Authenticate user
		const session = await auth.api.getSession({ headers: request.headers });
		if (!session?.user?.id) {
			return NextResponse.json(
				{ error: "Unauthorized" },
				{ status: 401 },
			);
		}

		const userId = session.user.id;

		// Parse and validate request body
		const body = await request.json();
		const parsed = requestSchema.safeParse(body);

		if (!parsed.success) {
			return NextResponse.json(
				{ error: "Invalid request", details: parsed.error.issues },
				{ status: 400 },
			);
		}

		const { message, organizationId, enabledMcpConfigIds } = parsed.data;

		// Skip very short messages
		if (message.trim().length < 3) {
			return NextResponse.json({
				suggestions: [],
				canHandle: false,
				confidence: 0,
			} satisfies SuggestToolsResponse);
		}

		// Get detailed MCP tool info
		const mcpToolInfo = await getDetailedMcpToolInfo({
			userId,
			organizationId,
			enabledMcpConfigIds: enabledMcpConfigIds ?? undefined,
		});

		if (mcpToolInfo.length === 0) {
			return NextResponse.json({
				suggestions: [],
				canHandle: false,
				confidence: 0,
			} satisfies SuggestToolsResponse);
		}

		// Analyze which tools can handle the task
		const result = canMcpToolsHandleTask(message, mcpToolInfo);

		// Build suggestions from matched tools
		const suggestions: ToolSuggestion[] = result.matchedTools.map(
			(match) => {
				// Find the config and tool details
				const config = mcpToolInfo.find(
					(c) => c.configId === match.configId,
				);
				const tool = config?.tools.find(
					(t) => t.name === match.toolName,
				);

				return {
					toolName: match.toolName,
					serverName: config?.serverName ?? "Unknown",
					configName: config?.configName ?? "Unknown",
					description: tool?.description ?? "",
					reason: match.reason,
				};
			},
		);

		// Limit to top 5 suggestions
		const topSuggestions = suggestions.slice(0, 5);

		return NextResponse.json({
			suggestions: topSuggestions,
			canHandle: result.canHandle,
			confidence: result.confidence,
		} satisfies SuggestToolsResponse);
	} catch (error) {
		console.error("[Suggest Tools] Error:", error);
		return NextResponse.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Failed to suggest tools",
			},
			{ status: 500 },
		);
	}
}

export const runtime = "nodejs";
