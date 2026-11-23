import { parlumeLog } from "@repo/api/modules/projects/lib/parlume-log";
import { resolveParlumeAttendeeSettings } from "@repo/api/modules/projects/lib/parlume-provider-settings";
import {
	outputParlumeStatusImage,
	PARLUME_TILE_STATES,
} from "@repo/api/modules/projects/lib/parlume-status-image";
import { db } from "@repo/database";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isParlumeServiceRequestAuthorized } from "../lib";

const bodySchema = z.object({
	sessionId: z.string().min(1).max(128),
	botId: z.string().min(1).max(256),
	state: z.enum(PARLUME_TILE_STATES),
});

/**
 * The bridge saw Parlume start listening, pause or answer: the bot's video
 * tile shows it, so everyone in the call can see what Parlume is doing.
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
		select: { id: true, organizationId: true, providerBotId: true },
	});
	// A meeting already over shows nothing more; the bridge drops it.
	if (!session?.providerBotId) {
		return NextResponse.json({ accepted: false });
	}
	const attendee = await resolveParlumeAttendeeSettings(
		session.organizationId,
	);
	if (!attendee) {
		return NextResponse.json({ error: "Unavailable" }, { status: 503 });
	}
	try {
		await outputParlumeStatusImage({
			attendee,
			providerBotId: session.providerBotId,
			state: parsed.data.state,
		});
	} catch (error) {
		parlumeLog("warn", "status_image.failed", {
			sessionId: session.id,
			botId: session.providerBotId,
			state: parsed.data.state,
			error: error instanceof Error ? error.message : String(error),
		});
		return NextResponse.json(
			{ error: "Status image failed" },
			{ status: 502 },
		);
	}
	parlumeLog("info", "status_image.shown", {
		sessionId: session.id,
		botId: session.providerBotId,
		state: parsed.data.state,
	});
	return NextResponse.json({ accepted: true });
}
