import { parlumeLog } from "@repo/api/modules/projects/lib/parlume-log";
import { db } from "@repo/database";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isParlumeServiceRequestAuthorized } from "../lib";

const bodySchema = z.discriminatedUnion("via", [
	// The notice's post showed up in the meeting chat.
	z.object({
		sessionId: z.string().min(1).max(128),
		botId: z.string().min(1).max(256),
		via: z.literal("chat"),
		tag: z.string().regex(/^P\d{1,6}$/),
	}),
	// The chat was out of reach, so Parlume said the notice aloud.
	z.object({
		sessionId: z.string().min(1).max(128),
		botId: z.string().min(1).max(256),
		via: z.literal("voice"),
	}),
]);

/**
 * The bridge saw the join notice reach the meeting. The first report is the
 * session's notice time; a later one, such as a post that showed up after the
 * notice was said aloud, changes nothing.
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
		return NextResponse.json({ error: "Invalid report" }, { status: 400 });
	}
	const { sessionId, botId } = parsed.data;
	const tag = parsed.data.via === "chat" ? parsed.data.tag : null;
	const recorded = await db.parlumeMeetingSession.updateMany({
		where: { id: sessionId, providerBotId: botId, joinNoticeAt: null },
		data: { joinNoticeAt: new Date(), joinNoticeTag: tag },
	});
	parlumeLog("info", "join_notice.delivered", {
		sessionId,
		botId,
		via: parsed.data.via,
		tag,
		recorded: recorded.count > 0,
	});
	return NextResponse.json({ accepted: true });
}
