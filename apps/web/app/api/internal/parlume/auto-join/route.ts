import { runParlumeAutoJoin } from "@repo/api/modules/projects/lib/parlume-auto-join";
import { parlumeLog } from "@repo/api/modules/projects/lib/parlume-log";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isParlumeServiceRequestAuthorized } from "../lib";

const bodySchema = z.object({
	linkedMeetingId: z.string().min(1).max(128),
	occurrenceStart: z.iso.datetime({ offset: true }),
});

/**
 * Joins one occurrence of a linked series with auto-join on, as the Temporal
 * scheduler asks at the occurrence's start. Every decision about the meeting
 * answers 200 with its outcome, so the scheduler does not retry it; only an
 * error that is not a decision answers 503 for a bounded retry.
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
	const occurrenceStart = new Date(parsed.data.occurrenceStart);
	try {
		const result = await runParlumeAutoJoin({
			linkedMeetingId: parsed.data.linkedMeetingId,
			occurrenceStart,
		});
		return NextResponse.json(result);
	} catch (error) {
		parlumeLog("error", "auto_join.error", {
			linkedMeetingId: parsed.data.linkedMeetingId,
			occurrenceStart: occurrenceStart.toISOString(),
			error: error instanceof Error ? error.message : String(error),
		});
		return NextResponse.json({ error: "Retry required" }, { status: 503 });
	}
}
