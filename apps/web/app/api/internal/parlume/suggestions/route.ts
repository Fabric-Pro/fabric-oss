import { recordParlumeSuggestion } from "@repo/api/modules/projects/lib/parlume-suggestion-records";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isParlumeServiceRequestAuthorized } from "../lib";

const anchor = z.string().trim().min(1).max(120);

const bodySchema = z.object({
	sessionId: z.string().min(1).max(128),
	botId: z.string().min(1).max(256),
	kind: z.enum(["answer", "missed_question"]),
	text: z.string().trim().min(1).max(500),
	speaker: anchor,
	quote: anchor,
	topic: anchor,
	chatTag: z
		.string()
		.regex(/^P\d{1,6}$/)
		.nullable(),
});

/**
 * Records a suggestion the bridge accepted, posted in the meeting chat or
 * kept for the team, so the Parlume page lists it. Answers 404 when the
 * session is not live or the bot is not its own.
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
		return NextResponse.json(
			{ error: "Invalid suggestion" },
			{ status: 400 },
		);
	}
	return (await recordParlumeSuggestion(parsed.data))
		? NextResponse.json({ recorded: true })
		: NextResponse.json({ error: "Session not found" }, { status: 404 });
}
