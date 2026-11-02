/**
 * Relay chat messages to ACTIVE SYSTEM agents selected by registered ID or name.
 * The database lookup and endpoint guard precede AI token issuance. Tenant
 * membership is checked before model resolution and credential exchange.
 */

import { enterAiInteractiveContext } from "@repo/ai/lib/chatgpt-plan/interactive-context";
import { auth } from "@repo/auth";
import { headers } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import {
	admitA2ARelay,
	readA2ATaskReply,
	resolveA2ARelayAIConfig,
	sendA2ARelayMessage,
} from "./a2a-send-turn";

interface A2ASendRequest {
	agentId: string;
	message: {
		role: "user";
		content: string;
		metadata?: Record<string, unknown>;
	};
	contextId?: string | null;
	history?: Array<{ role: string; content: string }>;
	organizationId?: string;
}

export async function POST(req: NextRequest) {
	try {
		// Get user session for authentication
		const headersList = await headers();
		const session = await auth.api.getSession({
			headers: headersList,
		});

		if (!session?.user) {
			console.log("[A2A Send] Unauthorized - no session");
			return NextResponse.json(
				{ error: "Unauthorized" },
				{ status: 401 },
			);
		}

		// This person's own request — or an admin acting as them, which no
		// ChatGPT plan may serve (Fizzy #2770).
		enterAiInteractiveContext({
			userId: session.user.id,
			impersonated: Boolean(session.session.impersonatedBy),
		});

		const body: A2ASendRequest = await req.json();
		const { agentId, message, contextId, history, organizationId } = body;

		if (typeof agentId !== "string" || !agentId.trim()) {
			return NextResponse.json(
				{ error: "agentId is required" },
				{ status: 400 },
			);
		}

		if (!message?.content) {
			return NextResponse.json(
				{ error: "message.content is required" },
				{ status: 400 },
			);
		}

		const admission = await admitA2ARelay({
			userId: session.user.id,
			agentId,
			organizationId,
		});
		if (!admission.ok) {
			return NextResponse.json(
				{ error: admission.error },
				{ status: admission.status },
			);
		}

		const ai = await resolveA2ARelayAIConfig({
			userId: session.user.id,
			organizationId,
			impersonated: Boolean(session.session.impersonatedBy),
		});
		if (!ai.ok) {
			return NextResponse.json(
				{
					error: ai.limit.message,
					code: "AI_USAGE_LIMIT_EXCEEDED",
					data: {
						limitId: ai.limit.limitId,
						dimension: ai.limit.dimension,
						window: ai.limit.window,
						used: ai.limit.used.toString(),
						max: ai.limit.max.toString(),
						manageLimitsUrl: ai.limit.manageLimitsUrl,
					},
				},
				{ status: 429 },
			);
		}

		const task = await sendA2ARelayMessage({
			agentUrl: admission.agentUrl,
			content: message.content,
			metadata: message.metadata,
			history,
			contextId,
			tenant: {
				userId: session.user.id,
				organizationId: organizationId || null,
			},
			aiConfig: ai.aiConfig,
		});

		return NextResponse.json(readA2ATaskReply(task, contextId));
	} catch (error) {
		console.error("[A2A Send] Error:", error);

		const errorMessage =
			error instanceof Error
				? error.message
				: "Failed to communicate with agent";

		return NextResponse.json({ error: errorMessage }, { status: 500 });
	}
}
