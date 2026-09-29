import {
	getParlumeBridgeSettings,
	leaveParlumeMeetingBot,
} from "@repo/api/modules/projects/lib/parlume-meeting-baas";
import { db } from "@repo/database";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isParlumeServiceRequestAuthorized } from "../lib";

const bodySchema = z.object({
	sessionId: z.string().min(1).max(128),
	botId: z.string().min(1).max(256),
});

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
			// A revoked inviter has already moved the session to LEAVING before
			// asking the bridge to stop. STOP_FAILED is retried by that same
			// durable bridge marker until Meeting BaaS accepts the leave request.
			status: { in: ["JOINING", "ACTIVE", "LEAVING", "STOP_FAILED"] },
		},
		select: { id: true, providerBotId: true, status: true },
	});
	if (!session?.providerBotId) {
		return NextResponse.json({ accepted: true });
	}
	await db.parlumeMeetingSession.update({
		where: { id: session.id },
		data: {
			status: "LEAVING",
			...(session.status === "ACTIVE"
				? { lastError: "Parlume transcription stream failed." }
				: {}),
			leaveRequestedAt: new Date(),
		},
	});
	const settings = getParlumeBridgeSettings();
	if (!settings) {
		await db.parlumeMeetingSession.update({
			where: { id: session.id },
			data: { status: "STOP_FAILED" },
		});
		return NextResponse.json({ error: "Unavailable" }, { status: 503 });
	}
	try {
		await leaveParlumeMeetingBot({
			settings,
			providerBotId: session.providerBotId,
		});
	} catch {
		await db.parlumeMeetingSession.update({
			where: { id: session.id },
			data: { status: "STOP_FAILED" },
		});
		return NextResponse.json({ error: "Retry required" }, { status: 503 });
	}
	return NextResponse.json({ accepted: true });
}
