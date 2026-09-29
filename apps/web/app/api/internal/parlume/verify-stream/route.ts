import { db } from "@repo/database";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isParlumeServiceRequestAuthorized, streamTokenDigest } from "../lib";

const bodySchema = z.object({
	sessionId: z.string().min(1).max(128),
	streamToken: z.string().min(32).max(256),
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
	const session = await db.parlumeMeetingSession.findUnique({
		where: { id: parsed.data.sessionId },
		select: {
			id: true,
			providerBotId: true,
			streamTokenDigest: true,
			status: true,
			hardStopAt: true,
		},
	});
	if (
		!session ||
		session.streamTokenDigest !== streamTokenDigest(parsed.data.streamToken)
	) {
		return NextResponse.json({ error: "Invalid stream" }, { status: 401 });
	}
	if (session.status === "PENDING" && !session.providerBotId) {
		return NextResponse.json({ pending: true }, { status: 202 });
	}
	if (
		session.providerBotId !== parsed.data.botId ||
		(session.status !== "JOINING" &&
			session.status !== "ACTIVE" &&
			session.status !== "LEAVING" &&
			session.status !== "STOP_FAILED")
	) {
		return NextResponse.json({ error: "Invalid stream" }, { status: 401 });
	}
	// Each authenticated stream receives a durable generation. A close can only
	// mark this same generation closed, so a reconnect cannot be finalized by an
	// earlier socket after any Durable Object await.
	const [verified] = await db.parlumeMeetingSession.updateManyAndReturn({
		where: {
			id: session.id,
			providerBotId: parsed.data.botId,
			status: session.status,
		},
		data: {
			...(session.status === "JOINING"
				? { status: "ACTIVE", joinedAt: new Date() }
				: {}),
			streamClosedAt: null,
			streamGeneration: { increment: 1 },
		},
		select: { streamGeneration: true },
	});
	if (!verified) {
		return NextResponse.json({ error: "Invalid stream" }, { status: 401 });
	}
	return NextResponse.json({
		valid: true,
		hardStopAt: session.hardStopAt,
		streamGeneration: verified.streamGeneration,
	});
}
