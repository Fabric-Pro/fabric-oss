import {
	cleanupParlumeProviderData,
	finalizeParlumeSession,
} from "@repo/api/modules/projects/lib/parlume-finalization";
import { parlumeLog } from "@repo/api/modules/projects/lib/parlume-log";
import {
	closeParlumeMeetingBridge,
	getParlumeBridgeSettings,
} from "@repo/api/modules/projects/lib/parlume-meeting-baas";
import { db } from "@repo/database";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { callbackSecret, constantTimeEqual } from "../lib";

const callbackSchema = z.object({
	event: z.enum(["bot.completed", "bot.failed"]),
	data: z.object({ bot_id: z.string().min(1).max(256) }),
});

// The provider retries a rejected callback for hours. Naming the event and
// the missing piece is what lets an operator tell a stale bot from a wrong
// secret; the secret value itself is never logged.
function describeRejected(raw: string): { event: string | null } {
	try {
		const body: unknown = JSON.parse(raw);
		return {
			event:
				typeof body === "object" &&
				body !== null &&
				"event" in body &&
				typeof body.event === "string"
					? body.event
					: null,
		};
	} catch {
		return { event: null };
	}
}

// Best effort: the alarm-driven access check closes the stream within a
// minute anyway once the terminal callback is recorded.
async function closeBridge(sessionId: string): Promise<void> {
	const settings = getParlumeBridgeSettings();
	if (!settings) {
		return;
	}
	try {
		await closeParlumeMeetingBridge({ settings, sessionId });
	} catch (error) {
		parlumeLog("warn", "callback.bridge_close_failed", {
			sessionId,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

export async function POST(request: NextRequest) {
	const sessionId = request.nextUrl.searchParams.get("sessionId");
	const raw = await request.text();
	const expected = sessionId ? callbackSecret(sessionId) : null;
	if (
		!sessionId ||
		!expected ||
		!constantTimeEqual(request.headers.get("x-mb-secret"), expected)
	) {
		const rejected = describeRejected(raw);
		// The provider also posts status-change events to this URL without the
		// callback secret; they carry nothing Fabric acts on, so they are noise
		// rather than a sign of a wrong secret.
		parlumeLog(
			rejected.event === "bot.status_change" &&
				!request.headers.has("x-mb-secret")
				? "info"
				: "warn",
			"callback.rejected",
			{
				sessionId,
				...rejected,
				hasSecretHeader: request.headers.has("x-mb-secret"),
			},
		);
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		json = null;
	}
	const parsed = callbackSchema.safeParse(json);
	if (!parsed.success) {
		parlumeLog("warn", "callback.invalid", {
			sessionId,
			...describeRejected(raw),
		});
		return NextResponse.json(
			{ error: "Invalid callback" },
			{ status: 400 },
		);
	}
	const session = await db.parlumeMeetingSession.findFirst({
		where: { id: sessionId, providerBotId: parsed.data.data.bot_id },
		select: {
			id: true,
			status: true,
			endReason: true,
			leaveRequestedAt: true,
			streamClosedAt: true,
			streamGeneration: true,
		},
	});
	if (!session) {
		parlumeLog("warn", "callback.unknown_session", {
			sessionId,
			botId: parsed.data.data.bot_id,
			event: parsed.data.event,
		});
		return NextResponse.json({ error: "Unknown session" }, { status: 404 });
	}
	parlumeLog("info", "callback.received", {
		sessionId: session.id,
		botId: parsed.data.data.bot_id,
		event: parsed.data.event,
		status: session.status,
		streamClosed: session.streamClosedAt !== null,
	});
	// The provider reports a bot that leaves on our request before recording
	// anything as failed. A leave Fabric asked for (stop, idle, revoked access,
	// hard stop) is a normal end with the reason already recorded.
	const requestedLeave =
		session.leaveRequestedAt !== null && session.endReason !== null;
	if (parsed.data.event === "bot.failed" && !requestedLeave) {
		await db.parlumeMeetingSession.updateMany({
			where: { id: session.id, status: { not: "ENDED" } },
			data: {
				status: "FAILED",
				endReason: session.endReason ?? "PROVIDER_FAILED",
				lastError: "Parlume meeting bot failed.",
				endedAt: new Date(),
			},
		});
		if (session.status === "PENDING" || session.status === "JOINING") {
			try {
				await finalizeParlumeSession(session.id, {
					preserveFailure: true,
				});
			} catch {
				return NextResponse.json(
					{ error: "Finalization retry required" },
					{ status: 503 },
				);
			}
			return NextResponse.json({ accepted: true });
		}
		// The bridge can still be draining final segments that were buffered during
		// an outage. Keep the failure visible, then let stream close or the hard
		// stop claim finalization after those segments have reached Fabric.
		if (!session.streamClosedAt) {
			await closeBridge(session.id);
			return NextResponse.json({ accepted: true });
		}
		try {
			await finalizeParlumeSession(session.id, {
				preserveFailure: true,
				expectedStreamGeneration: session.streamGeneration,
			});
		} catch {
			return NextResponse.json(
				{ error: "Provider data deletion retry required" },
				{ status: 503 },
			);
		}
		return NextResponse.json({ accepted: true });
	}
	if (session.status === "PENDING" || session.status === "JOINING") {
		await db.parlumeMeetingSession.update({
			where: { id: session.id },
			data: {
				status: "FAILED",
				endReason: session.endReason ?? "START_FAILED",
				lastError:
					"Parlume completed without an authenticated transcription stream.",
				endedAt: new Date(),
			},
		});
		try {
			await cleanupParlumeProviderData(session.id);
		} catch {
			return NextResponse.json(
				{ error: "Provider data deletion retry required" },
				{ status: 503 },
			);
		}
		return NextResponse.json({ accepted: true });
	}
	const callbackRecorded = await db.parlumeMeetingSession.updateMany({
		where: { id: session.id, streamGeneration: session.streamGeneration },
		data: {
			status: session.status === "ACTIVE" ? "LEAVING" : session.status,
			// A completed bot that Fabric never asked to leave was removed by
			// the host or outlived the meeting.
			endReason: session.endReason ?? "REMOVED",
			terminalCallbackAt: new Date(),
		},
	});
	if (callbackRecorded.count === 0) {
		return NextResponse.json({ accepted: true, stale: true });
	}
	if (!session.streamClosedAt) {
		await closeBridge(session.id);
		return NextResponse.json({ accepted: true });
	}
	try {
		await finalizeParlumeSession(session.id, {
			expectedStreamGeneration: session.streamGeneration,
		});
		return NextResponse.json({ accepted: true });
	} catch {
		return NextResponse.json(
			{ error: "Finalization retry required" },
			{ status: 503 },
		);
	}
}
