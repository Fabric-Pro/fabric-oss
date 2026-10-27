import { createParlumeRealtimeSession } from "@repo/api/modules/projects/lib/parlume-realtime-session";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isParlumeServiceRequestAuthorized } from "../lib";

const bodySchema = z.object({
	sessionId: z.string().min(1).max(128),
	botId: z.string().min(1).max(256),
});

/**
 * A short-lived client secret for Parlume's realtime voice, asked for by the
 * bridge once a meeting's stream is verified. `404 { engine: "classic" }`
 * whenever realtime is not available, and the meeting keeps the classic voice.
 */
export async function POST(request: NextRequest) {
	if (
		!isParlumeServiceRequestAuthorized(
			request.headers.get("X-Agent-Service-Token"),
		)
	) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}
	const parsed = bodySchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) {
		return NextResponse.json({ error: "Invalid request" }, { status: 400 });
	}
	const session = await createParlumeRealtimeSession(parsed.data);
	switch (session.engine) {
		case "realtime":
			return NextResponse.json({
				clientSecret: session.clientSecret,
				expiresAt: session.expiresAt,
				model: session.model,
				realtimeUrl: session.realtimeUrl,
			});
		case "classic":
			return NextResponse.json(
				{ engine: "classic", reason: session.reason },
				{ status: 404 },
			);
		default: {
			const unreachable: never = session;
			return unreachable;
		}
	}
}
