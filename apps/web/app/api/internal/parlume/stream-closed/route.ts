import { db } from "@repo/database";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
	finalizeParlumeSession,
	isParlumeServiceRequestAuthorized,
} from "../lib";

const bodySchema = z.object({
	sessionId: z.string().min(1).max(128),
	botId: z.string().min(1).max(256),
	streamGeneration: z.number().int().positive(),
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
		where: { id: parsed.data.sessionId, providerBotId: parsed.data.botId },
		select: {
			id: true,
			status: true,
			terminalCallbackAt: true,
			streamGeneration: true,
		},
	});
	if (!session) {
		return NextResponse.json({ error: "Unknown stream" }, { status: 404 });
	}
	const closed = await db.parlumeMeetingSession.updateMany({
		where: {
			id: session.id,
			status: { in: ["ACTIVE", "LEAVING", "FAILED"] },
			streamGeneration: parsed.data.streamGeneration,
			finalizedAt: null,
		},
		data: { streamClosedAt: new Date() },
	});
	if (closed.count === 0) {
		return NextResponse.json({ accepted: true, stale: true });
	}
	if (!session.terminalCallbackAt && session.status !== "FAILED") {
		return NextResponse.json({ accepted: true });
	}
	try {
		await finalizeParlumeSession(session.id, {
			...(session.status === "FAILED" ? { preserveFailure: true } : {}),
			expectedStreamGeneration: parsed.data.streamGeneration,
		});
		return NextResponse.json({ accepted: true });
	} catch {
		return NextResponse.json(
			{ error: "Finalization retry required" },
			{ status: 503 },
		);
	}
}
