import { suggestParlumeMeetingContribution } from "@repo/api/modules/projects/lib/parlume-suggestions";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isParlumeServiceRequestAuthorized } from "../lib";

const bodySchema = z.object({
	sessionId: z.string().min(1).max(128),
	botId: z.string().min(1).max(256),
	previous: z.array(z.string().max(1_000)).max(24).default([]),
});

/**
 * One passive suggestion pass, asked for by the bridge on its timer. Answers
 * `{ suggest: false }` whenever there is nothing worth offering, including a
 * session that turned suggestions off or is no longer live.
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
	return NextResponse.json(
		await suggestParlumeMeetingContribution(parsed.data),
	);
}
