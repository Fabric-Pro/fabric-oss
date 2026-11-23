import { parlumeLog } from "@repo/api/modules/projects/lib/parlume-log";
import { db } from "@repo/database";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isParlumeServiceRequestAuthorized } from "../lib";

const epochMs = z.number().int().positive().nullable();

const bodySchema = z.object({
	sessionId: z.string().min(1).max(128),
	botId: z.string().min(1).max(256),
	turnId: z.string().min(1).max(128),
	firstAudioAt: epochMs,
	spokenAt: epochMs,
	interrupted: z.boolean(),
});

/**
 * When the realtime voice played a Fabric job's answer: its first audio, and
 * when it finished or was cut short. Recorded on the job's meeting turn in
 * the fields the classic voice fills, so voice latency reads the same from
 * either engine's turns.
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
	const { sessionId, botId, turnId, firstAudioAt, spokenAt, interrupted } =
		parsed.data;
	const session = await db.parlumeMeetingSession.findFirst({
		where: { id: sessionId, providerBotId: botId },
		select: { id: true },
	});
	if (!session) {
		return NextResponse.json({ error: "Unknown session" }, { status: 404 });
	}
	const updated = await db.parlumeMeetingTurn.updateMany({
		where: { id: turnId, sessionId: session.id },
		data: {
			firstAudioAt: firstAudioAt === null ? null : new Date(firstAudioAt),
			spokenAt: spokenAt === null ? null : new Date(spokenAt),
			interruptedAt: interrupted ? new Date() : null,
		},
	});
	parlumeLog("info", "realtime.spoken", {
		sessionId,
		botId,
		turnId,
		heard: firstAudioAt !== null,
		interrupted,
		recorded: updated.count > 0,
	});
	return NextResponse.json({ recorded: updated.count > 0 });
}
