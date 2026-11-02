import { generateText } from "@repo/ai";
import { enterAiInteractiveContext } from "@repo/ai/lib/chatgpt-plan/interactive-context";
import { findAiUsageLimitError } from "@repo/ai/lib/find-usage-limit-error";
import { getSession } from "@saas/auth/lib/server";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
	checkWorkspaceChatAccess,
	EMPTY_WORKSPACE_CHAT_ANSWER,
	prepareWorkspaceChatTurn,
} from "./workspace-chat-turn";

/**
 * Workspace Document Chat API
 * Enables chatting with documents in a workspace using RAG.
 * Uses vector search to find relevant document chunks and AI to answer questions.
 * The turn itself is shared with the agent runtime's `library-chat` engine
 * (`workspace-chat-turn.ts`); this route answers it in one JSON reply.
 */
export async function POST(request: NextRequest) {
	try {
		const session = await getSession();
		if (!session) {
			return NextResponse.json(
				{ error: "Unauthorized" },
				{ status: 401 },
			);
		}
		// This person's own request — or an admin acting as them, which no
		// ChatGPT plan may serve (Fizzy #2939).
		enterAiInteractiveContext({
			userId: session.user.id,
			impersonated: Boolean(session.session.impersonatedBy),
		});

		const userId = session.user.id;
		// The body may still carry an `organizationId`; it is not read. The
		// tenant is the workspace's own, never the request's.
		const { workspaceId, message, history = [] } = await request.json();

		if (!workspaceId || !message) {
			return NextResponse.json(
				{ error: "workspaceId and message are required" },
				{ status: 400 },
			);
		}

		const access = await checkWorkspaceChatAccess(userId, workspaceId);
		if (!access.ok) {
			return NextResponse.json(
				{ error: access.error },
				{ status: access.status },
			);
		}

		const turn = await prepareWorkspaceChatTurn({
			userId,
			workspace: access.workspace,
			message,
			history,
		});

		const generationStart = Date.now();
		const result = await generateText({
			model: turn.model,
			instructions: turn.instructions,
			messages: turn.messages,
		});
		turn.recordAnswer(result.usage, Date.now() - generationStart);

		return NextResponse.json({
			response: result.text || EMPTY_WORKSPACE_CHAT_ANSWER,
			sources: turn.sources.length > 0 ? turn.sources : undefined,
		});
	} catch (error) {
		// AI usage-limit chokepoint hit a HARD limit, at model resolution or
		// at the check the model repeats before each request (inside the AI
		// SDK's RetryError when it refused a retry). Surface the rich payload
		// so the workspace-chat client renders the shared destructive toast
		// instead of a generic 500.
		const limitError = findAiUsageLimitError(error);
		if (limitError) {
			return NextResponse.json(
				{
					error: limitError.message,
					code: "AI_USAGE_LIMIT_EXCEEDED",
					data: {
						limitId: limitError.limitId,
						dimension: limitError.dimension,
						window: limitError.window,
						used: limitError.used.toString(),
						max: limitError.max.toString(),
						manageLimitsUrl: limitError.manageLimitsUrl,
					},
				},
				{ status: 429 },
			);
		}
		console.error("[Workspace Chat] Error:", error);
		return NextResponse.json(
			{ error: error instanceof Error ? error.message : "Chat failed" },
			{ status: 500 },
		);
	}
}
