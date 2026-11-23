import { notifyParlumeWaitingInLobby } from "@repo/api/modules/projects/lib/parlume-notices";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isParlumeServiceRequestAuthorized } from "../lib";

const bodySchema = z.object({
	sessionId: z.string().min(1).max(128),
});

/**
 * The bridge's bot has not streamed a while after the invite, so it is
 * most likely held in the Teams lobby: tell the inviter by when to admit it.
 * The notice itself checks the session is still joining.
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
	await notifyParlumeWaitingInLobby({ sessionId: parsed.data.sessionId });
	return NextResponse.json({ accepted: true });
}
