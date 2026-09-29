import {
	getParlumeBridgeSettings,
	leaveParlumeMeetingBot,
} from "@repo/api/modules/projects/lib/parlume-meeting-baas";
import { db, hasProjectAccess } from "@repo/database";
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
			status: { in: ["ACTIVE", "LEAVING", "STOP_FAILED"] },
		},
		select: {
			id: true,
			projectId: true,
			organizationId: true,
			userId: true,
			providerBotId: true,
			captureStoppedAt: true,
		},
	});
	if (!session?.providerBotId) {
		return NextResponse.json({ accepted: true, captureStopped: true });
	}
	const hasAccess = await hasProjectAccess(
		session.projectId,
		session.userId,
		session.organizationId,
	);
	if (hasAccess && !session.captureStoppedAt) {
		return NextResponse.json({ accepted: true, captureStopped: false });
	}
	await db.parlumeMeetingSession.update({
		where: { id: session.id },
		data: {
			status: "LEAVING",
			captureStoppedAt: session.captureStoppedAt ?? new Date(),
			leaveRequestedAt: new Date(),
			lastError: "The inviter no longer has access to this project.",
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
		return NextResponse.json({ accepted: true, captureStopped: true });
	} catch {
		await db.parlumeMeetingSession.update({
			where: { id: session.id },
			data: { status: "STOP_FAILED" },
		});
		return NextResponse.json({ error: "Retry required" }, { status: 503 });
	}
}
