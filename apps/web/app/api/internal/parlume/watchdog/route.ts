import {
	getParlumeBridgeSettings,
	leaveParlumeMeetingBot,
} from "@repo/api/modules/projects/lib/parlume-meeting-baas";
import { db } from "@repo/database";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
	finalizeParlumeSession,
	isParlumeServiceRequestAuthorized,
} from "../lib";

const bodySchema = z.object({
	sessionId: z.string().min(1).max(128),
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
			status: {
				in: ["JOINING", "ACTIVE", "LEAVING", "STOP_FAILED", "FAILED"],
			},
			hardStopAt: { lte: new Date() },
		},
		select: {
			id: true,
			providerBotId: true,
			status: true,
			terminalCallbackAt: true,
			streamClosedAt: true,
			streamGeneration: true,
		},
	});
	if (!session?.providerBotId) {
		return NextResponse.json({ accepted: true });
	}
	if (
		(session.status === "FAILED" ||
			(session.status === "LEAVING" && session.terminalCallbackAt)) &&
		!session.streamClosedAt
	) {
		try {
			await finalizeParlumeSession(session.id, {
				...(session.status === "FAILED"
					? { preserveFailure: true }
					: {}),
				expectedStreamGeneration: session.streamGeneration,
			});
			return NextResponse.json({ accepted: true, recovered: true });
		} catch {
			await db.parlumeMeetingSession.update({
				where: { id: session.id },
				data: {
					status: "FAILED",
					lastError:
						"Parlume transcription stream did not close before the recovery deadline and no durable transcript could be finalized.",
					endedAt: new Date(),
				},
			});
			return NextResponse.json({ accepted: true });
		}
	}
	await db.parlumeMeetingSession.update({
		where: { id: session.id },
		data: { status: "LEAVING", leaveRequestedAt: new Date() },
	});
	const settings = getParlumeBridgeSettings();
	if (!settings) {
		return NextResponse.json({ error: "Unavailable" }, { status: 503 });
	}
	try {
		await leaveParlumeMeetingBot({
			settings,
			providerBotId: session.providerBotId,
		});
		return NextResponse.json({ accepted: true });
	} catch {
		await db.parlumeMeetingSession.update({
			where: { id: session.id },
			data: {
				status: "STOP_FAILED",
				lastError: "Parlume maximum-duration stop failed.",
			},
		});
		return NextResponse.json({ error: "Retry required" }, { status: 503 });
	}
}
