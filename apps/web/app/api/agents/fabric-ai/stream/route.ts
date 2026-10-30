import { withChatGptPlanApiBilling } from "@repo/ai/lib/chatgpt-plan/plan-spent-response";
import type { NextRequest } from "next/server";
import { admitDirectChatTurn, handleTemporalWorkflow } from "./direct-turn";

/**
 * Fabric Loom Agent - Streaming Chat API
 * Streams responses and tool calls in real-time for the Fabric Loom Agent.
 * Uses Server-Sent Events (SSE) to push updates to the client.
 * Features:
 * - Real-time streaming of text responses
 * - Tool call events (start/result) for UI feedback
 * - Semantic memory context integration
 * - MCP tool suggestions
 * - Workflow tools (list, view, execute)
 * - Temporal workflow durability (when available)
 * Note: URL path remains /api/agents/fabric-ai/* for backward compatibility
 *
 * Admission and the workflow stream live in `direct-turn.ts`, which the agent
 * runtime's Direct engine shares.
 */
export async function POST(request: NextRequest) {
	const admitted = await admitDirectChatTurn(() => request.json());
	if (admitted instanceof Response) {
		return admitted;
	}
	try {
		const response = await handleTemporalWorkflow({
			clientSignal: request.signal,
			...admitted.turn,
		});
		return withChatGptPlanApiBilling(response, admitted.planPreflight);
	} catch (error) {
		console.error("[Fabric AI Stream] Error:", error);
		return new Response(
			JSON.stringify({
				error: error instanceof Error ? error.message : "Stream failed",
			}),
			{
				status: 500,
				headers: { "Content-Type": "application/json" },
			},
		);
	}
}

export const runtime = "nodejs";

// The Temporal poll loop in `direct-turn.ts` allows up to MAX_POLL_DURATION
// (300s) before giving up and sending a graceful "Workflow timed out" event.
// 360s leaves ~60s of headroom so that event is delivered and the stream
// closed before Vercel's platform-level hard kill can cut it off mid-stream
// (issue #2269). This does NOT extend the 300s run window itself — a workflow
// still has only 300s to finish before the graceful timeout fires.
export const maxDuration = 360;
