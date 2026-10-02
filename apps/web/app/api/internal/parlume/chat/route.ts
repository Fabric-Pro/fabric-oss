import { parlumeLog } from "@repo/api/modules/projects/lib/parlume-log";
import {
	getParlumeBridgeSettings,
	sendParlumeMeetingChat,
} from "@repo/api/modules/projects/lib/parlume-meeting-baas";
import { db } from "@repo/database";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isParlumeServiceRequestAuthorized } from "../lib";

const bodySchema = z.object({
	sessionId: z.string().min(1).max(128),
	botId: z.string().min(1).max(256),
	message: z.string().trim().min(1).max(4_096),
});

/**
 * Posts a reply that could not be spoken into the meeting chat. Called by the
 * bridge on the worker's behalf; only an active session's own bot may post.
 */
export async function POST(request: NextRequest) {
	if (
		!isParlumeServiceRequestAuthorized(
			request.headers.get("X-Agent-Service-Token"),
		)
	) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}
	const parsed = bodySchema.safeParse(await request.json());
	if (!parsed.success) {
		return NextResponse.json({ error: "Invalid request" }, { status: 400 });
	}
	const session = await db.parlumeMeetingSession.findFirst({
		where: {
			id: parsed.data.sessionId,
			providerBotId: parsed.data.botId,
			status: "ACTIVE",
		},
		select: { id: true, providerBotId: true },
	});
	if (!session?.providerBotId) {
		return NextResponse.json(
			{ error: "Session not active" },
			{ status: 409 },
		);
	}
	const settings = getParlumeBridgeSettings();
	if (!settings) {
		return NextResponse.json({ error: "Unavailable" }, { status: 503 });
	}
	try {
		await sendParlumeMeetingChat({
			settings,
			providerBotId: session.providerBotId,
			message: parsed.data.message,
		});
	} catch (error) {
		parlumeLog("warn", "chat.failed", {
			sessionId: session.id,
			botId: session.providerBotId,
			error: error instanceof Error ? error.message : String(error),
		});
		return NextResponse.json(
			{ error: "Chat delivery failed" },
			{ status: 502 },
		);
	}
	parlumeLog("info", "chat.posted", {
		sessionId: session.id,
		botId: session.providerBotId,
		chars: parsed.data.message.length,
	});
	return NextResponse.json({ sent: true });
}
