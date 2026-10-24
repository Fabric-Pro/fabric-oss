import { db } from "@repo/database";
import { recordParlumeAuraUsage } from "@repo/temporal/parlume-aura-usage";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isParlumeServiceRequestAuthorized } from "../lib";

// The bridge reads at most 6,000 characters aloud, in sentences of at most
// 1,500.
const bodySchema = z.object({
	sessionId: z.string().min(1).max(128),
	botId: z.string().min(1).max(256),
	sentences: z
		.array(
			z.object({
				chars: z.number().int().min(1).max(1_500),
				totalMs: z.number().int().min(0).max(600_000).nullable(),
			}),
		)
		.min(1)
		.max(6_000),
});

/**
 * Speech the bridge synthesized on its own (a chat post read aloud, the
 * chat-unavailable notice), recorded as the Aura usage the worker records for
 * the replies it sends to the bridge.
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
	const { sessionId, botId, sentences } = parsed.data;
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
	for (const sentence of sentences) {
		recordParlumeAuraUsage(
			{
				sessionId: session.id,
				userId: session.userId,
				organizationId: session.organizationId,
				projectId: session.projectId,
			},
			sentence,
		);
	}
	return NextResponse.json({ recorded: sentences.length });
}
