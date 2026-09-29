import { db } from "@repo/database";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
	callbackSecret,
	cleanupParlumeProviderData,
	constantTimeEqual,
	finalizeParlumeSession,
} from "../lib";

const callbackSchema = z.object({
	event: z.enum(["bot.completed", "bot.failed"]),
	data: z.object({ bot_id: z.string().min(1).max(256) }),
});

export async function POST(request: NextRequest) {
	const sessionId = request.nextUrl.searchParams.get("sessionId");
	if (!sessionId) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}
	const expected = callbackSecret(sessionId);
	if (
		!expected ||
		!constantTimeEqual(request.headers.get("x-mb-secret"), expected)
	) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}
	const parsed = callbackSchema.safeParse(await request.json());
	if (!parsed.success) {
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
			streamClosedAt: true,
			streamGeneration: true,
		},
	});
	if (!session) {
		return NextResponse.json({ error: "Unknown session" }, { status: 404 });
	}
	if (parsed.data.event === "bot.failed") {
		await db.parlumeMeetingSession.updateMany({
			where: { id: session.id, status: { not: "ENDED" } },
			data: {
				status: "FAILED",
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
			terminalCallbackAt: new Date(),
		},
	});
	if (callbackRecorded.count === 0) {
		return NextResponse.json({ accepted: true, stale: true });
	}
	if (!session.streamClosedAt) {
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
