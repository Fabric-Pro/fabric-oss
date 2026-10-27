import { controlChatRun } from "@saas/agents/lib/server/chat-run-control";

export async function POST(request: Request) {
	return controlChatRun(request, "orchestrator", "approve");
}

export const runtime = "nodejs";
