import { requestParlumeLeave } from "@repo/api/modules/projects/lib/parlume-leave";
import { parlumeLog } from "@repo/api/modules/projects/lib/parlume-log";
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
			streamGeneration: true,
			endReason: true,
			captureStoppedAt: true,
			terminalCallbackAt: true,
		},
	});
	// A recorded terminal callback means the bot has already left the meeting;
	// the bridge should close its socket rather than keep capturing.
	if (!session?.providerBotId || session.terminalCallbackAt) {
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
	if (!hasAccess && !session.captureStoppedAt) {
		parlumeLog("warn", "access.revoked", {
			sessionId: session.id,
			botId: session.providerBotId,
		});
	}
	try {
		// Capture already stopped: this is the bridge's minute-by-minute retry
		// of a leave the provider has not confirmed, so keep the first reason.
		await requestParlumeLeave({
			session: {
				id: session.id,
				providerBotId: session.providerBotId,
				streamGeneration: session.streamGeneration,
			},
			reason: session.endReason ?? "ACCESS_REVOKED",
			lastError: session.captureStoppedAt
				? null
				: "The inviter no longer has access to this project.",
			captureStopped: true,
		});
	} catch {
		return NextResponse.json({ error: "Retry required" }, { status: 503 });
	}
	return NextResponse.json({ accepted: true, captureStopped: true });
}
