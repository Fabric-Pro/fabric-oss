import { generateText } from "@repo/ai";
import { enterAiInteractiveContext } from "@repo/ai/lib/chatgpt-plan/interactive-context";
import { findAiUsageLimitError } from "@repo/ai/lib/find-usage-limit-error";
import {
	appendWorkspaceDocumentChat,
	db,
	getEffectiveRagSettings,
	getWorkspaceDocumentChat,
	hasWorkspaceAccess,
} from "@repo/database";
import { getSession } from "@saas/auth/lib/server";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
	checkWorkspaceChatAccess,
	EMPTY_WORKSPACE_CHAT_ANSWER,
	prepareWorkspaceChatTurn,
} from "./workspace-chat-turn";

const chatInput = z.object({
	workspaceId: z.string().min(1).max(128),
	message: z.string().trim().min(1).max(20000),
});

const personalHistoryItemSchema = z.object({
	role: z.enum(["user", "assistant"]),
	content: z.string(),
});

function parsePersonalHistory(
	raw: unknown,
): Array<{ role: "user" | "assistant"; content: string }> {
	if (!Array.isArray(raw)) {
		return [];
	}
	return raw
		.flatMap((entry) => {
			const parsed = personalHistoryItemSchema.safeParse(entry);
			return parsed.success ? [parsed.data] : [];
		})
		.slice(-20);
}

export async function GET(request: NextRequest) {
	try {
		const session = await getSession();
		if (!session)
			return NextResponse.json(
				{ error: "Unauthorized" },
				{ status: 401 },
			);
		const workspaceId = new URL(request.url).searchParams.get(
			"workspaceId",
		);
		if (!workspaceId)
			return NextResponse.json(
				{ error: "workspaceId is required" },
				{ status: 400 },
			);
		if (!(await hasWorkspaceAccess(workspaceId, session.user.id)))
			return NextResponse.json(
				{ error: "Workspace not found or access denied" },
				{ status: 404 },
			);
		const workspace = await db.workspace.findUnique({
			where: { id: workspaceId },
			select: { organizationId: true },
		});
		if (!workspace?.organizationId)
			return NextResponse.json(
				{ error: "Workspace not found or access denied" },
				{ status: 404 },
			);
		const conversation = await getWorkspaceDocumentChat({
			workspaceId,
			userId: session.user.id,
			organizationId: workspace.organizationId,
		});
		return NextResponse.json(conversation);
	} catch (error) {
		if (
			error instanceof Error &&
			error.name === "WorkspaceDocumentChatAccessError"
		)
			return NextResponse.json(
				{ error: "Workspace not found or access denied" },
				{ status: 404 },
			);
		return NextResponse.json(
			{ error: "Document chat history could not be loaded" },
			{ status: 500 },
		);
	}
}

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
		const rawBody = await request.json();
		const parsed = chatInput.safeParse(rawBody);
		if (!parsed.success) {
			return NextResponse.json(
				{
					error: "A workspaceId and message of 1–20000 characters are required",
				},
				{ status: 400 },
			);
		}
		const { workspaceId, message } = parsed.data;

		const access = await checkWorkspaceChatAccess(userId, workspaceId);
		if (!access.ok) {
			return NextResponse.json(
				{ error: access.error },
				{ status: access.status },
			);
		}

		const effectiveOrgId = access.workspace.organizationId || undefined;
		const actor = effectiveOrgId
			? { workspaceId, userId, organizationId: effectiveOrgId }
			: null;

		const [conversation, ragSettings] = await Promise.all([
			actor ? getWorkspaceDocumentChat(actor) : Promise.resolve(null),
			getEffectiveRagSettings(workspaceId),
		]);
		const history = conversation
			? conversation.messages.slice(-20)
			: parsePersonalHistory(
					typeof rawBody === "object" && rawBody !== null
						? (rawBody as Record<string, unknown>).history
						: undefined,
				);

		const turn = await prepareWorkspaceChatTurn({
			userId,
			workspace: access.workspace,
			message,
			history,
			ragSettings,
		});

		const generationStart = Date.now();
		const result = await generateText({
			model: turn.model,
			instructions: turn.instructions,
			messages: turn.messages,
		});
		turn.recordAnswer(result.usage, Date.now() - generationStart);

		const response = result.text || EMPTY_WORKSPACE_CHAT_ANSWER;
		let conversationId: string | undefined;
		let historyPersisted = true;
		if (actor) {
			try {
				conversationId = (
					await appendWorkspaceDocumentChat({
						...actor,
						question: message,
						answer: response,
						sources: turn.sources,
					})
				).id;
			} catch (error) {
				if (
					error instanceof Error &&
					error.name === "WorkspaceDocumentChatAccessError"
				)
					throw error;
				historyPersisted = false;
				console.error(
					"[Workspace Chat] Could not persist document chat history",
				);
			}
		}

		return NextResponse.json({
			...(conversationId !== undefined ? { conversationId } : {}),
			...(actor ? { historyPersisted } : {}),
			response,
			sources: turn.sources.length > 0 ? turn.sources : undefined,
			...(result.text ? { model: turn.getAnswerModel() } : {}),
		});
	} catch (error) {
		if (
			error instanceof Error &&
			error.name === "WorkspaceDocumentChatAccessError"
		)
			return NextResponse.json(
				{ error: "Workspace not found or access denied" },
				{ status: 404 },
			);
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
			{ error: "Document chat could not complete. Please try again." },
			{ status: 500 },
		);
	}
}
