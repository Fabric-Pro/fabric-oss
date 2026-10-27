import { db } from "@repo/database";
import { recordParlumeRealtimeUsage } from "@repo/temporal/parlume-realtime-usage";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isParlumeServiceRequestAuthorized } from "../lib";

// A response reads at most the session's 128k-token context.
const tokens = z.number().int().min(0).max(200_000);

const bodySchema = z.object({
	sessionId: z.string().min(1).max(128),
	botId: z.string().min(1).max(256),
	inputTextTokens: tokens,
	inputAudioTokens: tokens,
	cachedTextTokens: tokens,
	cachedAudioTokens: tokens,
	outputTextTokens: tokens,
	outputAudioTokens: tokens,
	// A bridge deployed before Azure hosts reports no provider.
	provider: z
		.enum(["OPENAI_DIRECT", "AZURE_AI_FOUNDRY"])
		.default("OPENAI_DIRECT"),
});

/**
 * One response of Parlume's realtime voice, as the bridge read its usage,
 * recorded against the meeting on the organization's OpenAI key or Azure AI
 * Foundry resource, whichever served the session.
 */
export async function POST(request: NextRequest) {
	if (
		!isParlumeServiceRequestAuthorized(
			request.headers.get("X-Agent-Service-Token"),
		)
	) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}
	const parsed = bodySchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) {
		return NextResponse.json({ error: "Invalid usage" }, { status: 400 });
	}
	const { sessionId, botId, provider, ...usage } = parsed.data;
	const session = await db.parlumeMeetingSession.findFirst({
		where: { id: sessionId, providerBotId: botId },
		select: {
			id: true,
			userId: true,
			organizationId: true,
			projectId: true,
		},
	});
	if (!session) {
		return NextResponse.json({ error: "Unknown session" }, { status: 404 });
	}
	recordParlumeRealtimeUsage(
		{
			sessionId: session.id,
			userId: session.userId,
			organizationId: session.organizationId,
			projectId: session.projectId,
			provider,
		},
		usage,
	);
	return NextResponse.json({ recorded: true });
}
