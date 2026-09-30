import { finalizeParlumeSession } from "@repo/api/modules/projects/lib/parlume-finalization";
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
	// A stop that was already under way keeps its own reason; only a session
	// that reached the cap untouched ended because of it.
	await db.parlumeMeetingSession.updateMany({
		where: { id: session.id, endReason: null },
		data: { endReason: "MAX_DURATION" },
	});
	const leaveClaimed = await db.parlumeMeetingSession.updateMany({
		where: {
			id: session.id,
			streamGeneration: session.streamGeneration,
			status: {
				in: ["JOINING", "ACTIVE", "LEAVING", "STOP_FAILED", "FAILED"],
			},
			finalizedAt: null,
		},
		data: { status: "LEAVING", leaveRequestedAt: new Date() },
	});
	if (leaveClaimed.count === 0) {
		return NextResponse.json({ accepted: true, stale: true });
	}
	const settings = getParlumeBridgeSettings();
	if (!settings) {
		return NextResponse.json({ error: "Unavailable" }, { status: 503 });
	}
	try {
		const leaveResult = await leaveParlumeMeetingBot({
			settings,
			providerBotId: session.providerBotId,
		});
		if (leaveResult.kind === "TERMINAL") {
			await finalizeParlumeSession(session.id, {
				...(session.status === "FAILED" ||
				leaveResult.status === "failed"
					? { preserveFailure: true }
					: {}),
				expectedStreamGeneration: session.streamGeneration,
			});
			return NextResponse.json({ accepted: true, recovered: true });
		}
		return NextResponse.json({ accepted: true });
	} catch {
		await db.parlumeMeetingSession.updateMany({
			where: {
				id: session.id,
				streamGeneration: session.streamGeneration,
				status: { in: ["JOINING", "ACTIVE", "LEAVING", "STOP_FAILED"] },
				finalizedAt: null,
			},
			data: {
				status: "STOP_FAILED",
				lastError: "Parlume maximum-duration stop failed.",
			},
		});
		return NextResponse.json({ error: "Retry required" }, { status: 503 });
	}
}
