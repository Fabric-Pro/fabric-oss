import { sendParlumeMeetingChat } from "@repo/api/modules/projects/lib/parlume-attendee";
import { parlumeLog } from "@repo/api/modules/projects/lib/parlume-log";
import { resolveParlumeAttendeeSettings } from "@repo/api/modules/projects/lib/parlume-provider-settings";
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
 * Sends a Parlume post to the meeting chat. Called by the bridge, which tags
 * each post and confirms delivery when the post shows up in the chat; only an
 * active session's own bot may send. Attendee only queues the message, so the
 * answer here says "queued", never "delivered".
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
		select: { id: true, providerBotId: true, organizationId: true },
	});
	if (!session?.providerBotId) {
		return NextResponse.json(
			{ error: "Session not active" },
			{ status: 409 },
		);
	}
	const attendee = await resolveParlumeAttendeeSettings(
		session.organizationId,
	);
	if (!attendee) {
		return NextResponse.json({ error: "Unavailable" }, { status: 503 });
	}
	try {
		await sendParlumeMeetingChat({
			attendee,
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
		delivery: "queued",
	});
	return NextResponse.json({ sent: true, delivery: "queued" });
}
