import { reconcileParlumeChannelChat } from "@repo/api/modules/projects/lib/parlume-channel-chat";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isParlumeServiceRequestAuthorized } from "../lib";

export async function POST(request: NextRequest) {
	if (
		!isParlumeServiceRequestAuthorized(
			request.headers.get("X-Agent-Service-Token"),
		)
	) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}
	const body = z
		.object({
			sessionId: z.string().min(1).max(128),
			organizationId: z.string().min(1).max(128),
		})
		.safeParse(await request.json().catch(() => null));
	if (!body.success) {
		return NextResponse.json({ error: "Invalid request" }, { status: 400 });
	}
	return NextResponse.json(
		await reconcileParlumeChannelChat(
			body.data.sessionId,
			body.data.organizationId,
		),
	);
}
