/**
 * Internal Slack Tools Endpoint
 *
 * Generic proxy for executing Slack tools from the LangGraph agent.
 * Supports get_channel_messages with auth validation via channelId
 * against ProjectContext metadata.
 *
 * Auth: Uses X-AI-Token JWT. Body-based userId is not accepted to prevent impersonation.
 *
 * Pattern: Mirrors /api/internal/teams-tools but simpler (Slack channels only)
 */

import { AI_TOKEN_HEADER, verifyAIToken } from "@repo/ai-token";
import { db, hasProjectAccess, type ProjectContextType } from "@repo/database";
import { executeSlackTool } from "@repo/integrations/slack";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

/** Tools that the agent is allowed to invoke via this endpoint */
const ALLOWED_TOOLS = new Set([
	"get_channel_messages",
	"list_linked_channels",
	"get_thread_replies",
	"get_shared_files",
]);

/**
 * Validate that the requested channelId belongs to a configured project context.
 * This prevents the agent from accessing arbitrary Slack channels outside the project scope.
 */
async function isAuthorizedChannel(
	projectId: string,
	channelId: string,
): Promise<boolean> {
	const count = await db.projectContext.count({
		where: {
			projectId,
			type: "INTEGRATION" as ProjectContextType,
			metadata: {
				path: ["channelId"],
				equals: channelId,
			},
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

		// Handle list_linked_channels separately — no Slack API call needed
		if (toolName === "list_linked_channels") {
			const contexts = await db.projectContext.findMany({
				where: {
					projectId,
					type: "INTEGRATION" as ProjectContextType,
					metadata: {
						path: ["provider"],
						equals: "SLACK",
					},
				},
				select: { metadata: true },
			});

			const channels = contexts.map((ctx) => {
				const meta = ctx.metadata as Record<string, unknown>;
				return {
					channelId: meta.channelId as string | undefined,
					channelName: meta.channelName as string | undefined,
				};
			});

			return NextResponse.json({ channels, count: channels.length });
		}

		// Validate that the channel belongs to this project
		const channelId = args.channel || args.channelId;
		if (!channelId) {
			return NextResponse.json(
				{ error: "Missing required argument: channel or channelId" },
				{ status: 400 },
			);
		}

		const authorized = await isAuthorizedChannel(projectId, channelId);
		if (!authorized) {
			return NextResponse.json(
				{
					error: "The specified channel is not linked to this project",
				},
				{ status: 403 },
			);
		}

		const result = await executeSlackTool(
			toolName,
			args,
			userId,
			organizationId,
		);

		return NextResponse.json(result);
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";
		console.error("[Internal Slack Tools] Error:", errorMessage);

		return NextResponse.json({ error: errorMessage }, { status: 500 });
	}
}
