import { requestParlumeLeave } from "@repo/api/modules/projects/lib/parlume-leave";
import { parlumeLog } from "@repo/api/modules/projects/lib/parlume-log";
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
		select: {
			id: true,
			providerBotId: true,
			status: true,
			streamGeneration: true,
			endReason: true,
		},
	});
	if (!session?.providerBotId) {
		return NextResponse.json({ accepted: true });
	}
	if (session.status === "ACTIVE") {
		parlumeLog("error", "stream.error", {
			sessionId: session.id,
			botId: session.providerBotId,
		});
	}
	try {
		await requestParlumeLeave({
			session: {
				id: session.id,
				providerBotId: session.providerBotId,
				streamGeneration: session.streamGeneration,
			},
			// A stop already under way (user, idle, revocation) keeps its reason;
			// only a failure of a healthy session is a stream error.
			reason: session.endReason ?? "STREAM_ERROR",
			lastError:
				session.status === "ACTIVE"
					? "Parlume transcription stream failed."
					: null,
			captureStopped: false,
		});
	} catch {
		return NextResponse.json({ error: "Retry required" }, { status: 503 });
	}
	return NextResponse.json({ accepted: true });
}
