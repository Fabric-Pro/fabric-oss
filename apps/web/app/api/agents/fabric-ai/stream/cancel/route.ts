import { controlChatRun } from "@saas/agents/lib/server/chat-run-control";

export async function POST(request: Request) {
	return controlChatRun(request, "direct", "cancel");
}

export const runtime = "nodejs";
