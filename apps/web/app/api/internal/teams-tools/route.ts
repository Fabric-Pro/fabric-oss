/**
 * Internal Teams Tools Endpoint
 *
 * Generic proxy for executing Microsoft Teams tools from the LangGraph agent.
 * Supports multiple tool names (get_chat_messages, get_full_message, list_message_replies)
 * with the same auth pattern as /api/internal/teams-search.
 *
 * Auth: Uses X-AI-Token JWT. Body-based userId is not accepted to prevent impersonation.
 */

import { AI_TOKEN_HEADER, verifyAIToken } from "@repo/ai-token";
import { db, hasProjectAccess, type ProjectContextType } from "@repo/database";
import { executeMicrosoftTeamsTool } from "@repo/integrations/microsoft";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

/** Tools that the agent is allowed to invoke via this endpoint */
const ALLOWED_TOOLS = new Set([
	"get_chat_messages",
	"list_messages",
	"get_full_message",
	"list_message_replies",
	"list_linked_chats",
	"get_message_hosted_content",
]);

/** Tools that operate on a chat (chatId required, teamId/channelId forbidden) */
const CHAT_SCOPED_TOOLS = new Set(["get_chat_messages"]);

/** Tools that operate on a channel (teamId+channelId required, chatId forbidden) */
const CHANNEL_SCOPED_TOOLS = new Set(["list_messages", "list_message_replies"]);

/** Tools that accept either chat or channel identifiers (but not both) */
const DUAL_SCOPED_TOOLS = new Set([
	"get_full_message",
	"get_message_hosted_content",
]);

/**
 * Validate that the requested chatId belongs to a configured project context.
 * This prevents the agent from accessing arbitrary Teams chats outside the project scope.
 */
async function isAuthorizedChat(
	projectId: string,
	chatId: string,
): Promise<boolean> {
	const count = await db.projectContext.count({
		where: {
			projectId,
			type: "INTEGRATION" as ProjectContextType,
			metadata: {
				path: ["chatId"],
				equals: chatId,
			},
		},
	});
	return count > 0;
}

/**
 * Validate that the requested teamId/channelId pair belongs to a configured project context.
 * Channel-based tools (get_full_message, list_message_replies) use teamId+channelId
 * instead of chatId, so they need separate scoping validation.
 */
async function isAuthorizedChannel(
	projectId: string,
	teamId: string,
	channelId: string,
): Promise<boolean> {
	const count = await db.projectContext.count({
		where: {
			projectId,
			type: "INTEGRATION" as ProjectContextType,
			AND: [
				{ metadata: { path: ["teamId"], equals: teamId } },
				{ metadata: { path: ["channelId"], equals: channelId } },
			],
		},
	});
	return count > 0;
}

export async function POST(req: Request) {
	try {
		const body = await req.json();
		const { toolName, args, projectId } = body;

		if (!toolName || !args || !projectId) {
			return NextResponse.json(
				{
					error: "Missing required fields: toolName, args, projectId",
				},
				{ status: 400 },
			);
		}

		if (!ALLOWED_TOOLS.has(toolName)) {
			return NextResponse.json(
				{ error: `Tool "${toolName}" is not allowed` },
				{ status: 400 },
			);
		}

		// Auth: Extract user/org context from AI token
		const aiToken = req.headers.get(AI_TOKEN_HEADER);
		if (!aiToken) {
			return NextResponse.json(
				{
					error: "Authentication required: X-AI-Token header missing",
				},
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

		// Verify user has access to this project with tenant XOR isolation
		const access = await hasProjectAccess(
			projectId,
			userId,
			organizationId,
		);
		if (!access) {
			return NextResponse.json(
				{ error: "You do not have access to this project" },
				{ status: 403 },
			);
		}

		const project = await db.project.findUnique({
			where: { id: projectId },
			select: { organizationId: true },
		});
		if (!project) {
			return NextResponse.json(
				{ error: "Project not found" },
				{ status: 404 },
			);
		}
		if ((project.organizationId ?? undefined) !== organizationId) {
			return NextResponse.json(
				{ error: "Tenant context mismatch" },
				{ status: 403 },
			);
		}

		// Handle list_linked_chats separately — no Graph API call needed
		if (toolName === "list_linked_chats") {
			const contexts = await db.projectContext.findMany({
				where: {
					projectId,
					type: "INTEGRATION" as ProjectContextType,
					metadata: {
						path: ["provider"],
						equals: "MICROSOFT_TEAMS",
					},
				},
				select: { metadata: true },
			});

			const chats = contexts.map((ctx) => {
				const meta = ctx.metadata as Record<string, unknown>;
				return {
					chatId: meta.chatId as string | undefined,
					chatType: meta.chatType as string | undefined,
					chatTopic: meta.chatTopic as string | undefined,
					teamId: meta.teamId as string | undefined,
					channelId: meta.channelId as string | undefined,
					channelName: meta.channelName as string | undefined,
					teamName: meta.teamName as string | undefined,
				};
			});

			return NextResponse.json({ chats, count: chats.length });
		}

		// Validate scope per tool type. Each tool has a fixed identifier mode
		// (chat-based, channel-based, or either). Mixed identifiers are rejected
		// to prevent bypassing channel auth by supplying a valid chatId alongside
		// unauthorized teamId/channelId.
		const hasChatId = Boolean(args.chatId);
		const hasChannelIds = Boolean(args.teamId && args.channelId);

		if (CHAT_SCOPED_TOOLS.has(toolName)) {
			if (!hasChatId) {
				return NextResponse.json(
					{ error: `Tool "${toolName}" requires chatId` },
					{ status: 400 },
				);
			}
			if (hasChannelIds) {
				return NextResponse.json(
					{
						error: `Tool "${toolName}" does not accept teamId/channelId`,
					},
					{ status: 400 },
				);
			}
			const authorized = await isAuthorizedChat(projectId, args.chatId);
			if (!authorized) {
				return NextResponse.json(
					{
						error: "The specified chat is not linked to this project",
					},
					{ status: 403 },
				);
			}
		} else if (CHANNEL_SCOPED_TOOLS.has(toolName)) {
			if (!hasChannelIds) {
				return NextResponse.json(
					{
						error: `Tool "${toolName}" requires teamId and channelId`,
					},
					{ status: 400 },
				);
			}
			if (hasChatId) {
				return NextResponse.json(
					{ error: `Tool "${toolName}" does not accept chatId` },
					{ status: 400 },
				);
			}
			const authorized = await isAuthorizedChannel(
				projectId,
				args.teamId,
				args.channelId,
			);
			if (!authorized) {
				return NextResponse.json(
					{
						error: "The specified channel is not linked to this project",
					},
					{ status: 403 },
				);
			}
		} else if (DUAL_SCOPED_TOOLS.has(toolName)) {
			// Accepts chat OR channel identifiers, but not both
			if (hasChatId && hasChannelIds) {
				return NextResponse.json(
					{
						error: `Tool "${toolName}" accepts chatId or teamId/channelId, not both`,
					},
					{ status: 400 },
				);
			}
			if (!hasChatId && !hasChannelIds) {
				return NextResponse.json(
					{
						error: `Tool "${toolName}" requires either chatId or teamId/channelId`,
					},
					{ status: 400 },
				);
			}
			if (hasChatId) {
				const authorized = await isAuthorizedChat(
					projectId,
					args.chatId,
				);
				if (!authorized) {
					return NextResponse.json(
						{
							error: "The specified chat is not linked to this project",
						},
						{ status: 403 },
					);
				}
			} else if (hasChannelIds) {
				const authorized = await isAuthorizedChannel(
					projectId,
					args.teamId,
					args.channelId,
				);
				if (!authorized) {
					return NextResponse.json(
						{
							error: "The specified channel is not linked to this project",
						},
						{ status: 403 },
					);
				}
			}
		}

		const result = await executeMicrosoftTeamsTool(
			toolName,
			args,
			userId,
			organizationId,
		);

		return NextResponse.json(result);
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";
		console.error("[Internal Teams Tools] Error:", errorMessage);

		return NextResponse.json({ error: errorMessage }, { status: 500 });
	}
}
