import { parlumeLog } from "@repo/api/modules/projects/lib/parlume-log";
import { db } from "@repo/database";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isParlumeServiceRequestAuthorized } from "../lib";

// A meeting lasts at most four hours; counts and milliseconds stay well
// inside this.
const total = z.number().int().min(0).max(1_000_000_000);

/** The bridge's speech telemetry for a meeting, totals since it began. */
const totalsSchema = z.object({
	replies: total,
	speakingMs: total,
	// Starvation only: the time after the gap allowance ran out.
	underrunMs: total,
	// Silence that covered a reply's planned wait, such as a tool call.
	// Absent from a bridge, and from totals stored, before it was counted.
	waitMs: total.default(0),
	stallResets: total,
	stops: total,
	slowStops: total,
	worstStopMs: total,
	resumes: total,
	failedResumes: total,
	capped: total,
	fallbacks: total,
	auraRetries: total,
	auraRetryFailures: total,
});

type SpeechTotals = z.infer<typeof totalsSchema>;

const bodySchema = z.object({
	sessionId: z.string().min(1).max(128),
	botId: z.string().min(1).max(256),
	totals: totalsSchema,
});

const NO_TOTALS: SpeechTotals = {
	replies: 0,
	speakingMs: 0,
	underrunMs: 0,
	waitMs: 0,
	stallResets: 0,
	stops: 0,
	slowStops: 0,
	worstStopMs: 0,
	resumes: 0,
	failedResumes: 0,
	capped: 0,
	fallbacks: 0,
	auraRetries: 0,
	auraRetryFailures: 0,
};

const COUNTERS = totalsSchema.keyof().options;

function mapTotals(
	read: (counter: keyof SpeechTotals) => number,
): SpeechTotals {
	const totals = { ...NO_TOTALS };
	for (const counter of COUNTERS) {
		totals[counter] = read(counter);
	}
	return totals;
}

/**
 * The bridge's speech telemetry for a meeting (`ParlumeSpeechHealth` in
 * `party-cf/src/parlume-speech-health.ts`), sent on its alarm whenever it
 * changed. The totals only grow, so a report repeated or late changes
 * nothing. The session keeps the latest, and each report logs what it
 * added as `parlume.speech_health`, which the speech alert rules read.
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
			{ error: "Invalid speech health report" },
			{ status: 400 },
		);
	}
	const report = parsed.data;
	const session = await db.parlumeMeetingSession.findFirst({
		where: { id: report.sessionId, providerBotId: report.botId },
		select: { id: true, speechHealth: true },
	});
	if (!session) {
		return NextResponse.json({ error: "Unknown session" }, { status: 404 });
	}
	const stored = totalsSchema.safeParse(session.speechHealth);
	const previous = stored.success ? stored.data : NO_TOTALS;
	const totals = mapTotals((counter) =>
		Math.max(previous[counter], report.totals[counter]),
	);
	await db.parlumeMeetingSession.update({
		where: { id: session.id },
		data: { speechHealth: totals },
	});
	// What this report added; the slowest stop is the meeting's so far.
	parlumeLog("info", "speech_health", {
		sessionId: session.id,
		botId: report.botId,
		...mapTotals((counter) => totals[counter] - previous[counter]),
		worstStopMs: totals.worstStopMs,
	});
	return NextResponse.json({ accepted: true });
}
