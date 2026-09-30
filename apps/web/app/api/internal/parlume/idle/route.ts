import { requestParlumeLeave } from "@repo/api/modules/projects/lib/parlume-leave";
import { parlumeLog } from "@repo/api/modules/projects/lib/parlume-log";
import { db } from "@repo/database";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isParlumeServiceRequestAuthorized } from "../lib";

const bodySchema = z.object({
	sessionId: z.string().min(1).max(128),
	botId: z.string().min(1).max(256),
	idleMs: z.number().int().min(0),
});

/**
 * The bridge saw no human speech for the idle window while Parlume was
 * silent. Leave so an abandoned meeting stops spending provider time.
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
		select: { id: true, providerBotId: true, streamGeneration: true },
	});
	if (!session?.providerBotId) {
		return NextResponse.json({ accepted: true, stale: true });
	}
	parlumeLog("info", "idle.detected", {
		sessionId: session.id,
		botId: session.providerBotId,
		idleMs: parsed.data.idleMs,
	});
	try {
		await requestParlumeLeave({
			session: {
				id: session.id,
				providerBotId: session.providerBotId,
				streamGeneration: session.streamGeneration,
			},
			reason: "IDLE",
			lastError: null,
			captureStopped: true,
		});
	} catch {
		return NextResponse.json({ error: "Retry required" }, { status: 503 });
	}
	return NextResponse.json({ accepted: true });
}
