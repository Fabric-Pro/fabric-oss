import { parlumeLog } from "@repo/api/modules/projects/lib/parlume-log";
import { db } from "@repo/database";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
	isParlumeServiceRequestAuthorized,
	listeningEventDedupeKey,
} from "../lib";

const bodySchema = z.object({
	sessionId: z.string().min(1).max(128),
	botId: z.string().min(1).max(256),
	paused: z.boolean(),
	by: z.string().trim().min(1).max(256).nullable(),
	/** When the bridge paused or resumed, epoch milliseconds. */
	at: z.number().int().min(0),
	offsetMs: z.number().int().min(0).max(14_400_000).nullable(),
});

function markerText(paused: boolean, by: string | null): string {
	const who = by ?? "someone";
	return paused
		? `Listening paused by ${who}.`
		: `Listening resumed by ${who}.`;
}

/**
 * The bridge paused or resumed listening. The session shows it on the
 * Parlume page, and the transcript keeps a marker where it happened.
 */
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
		return NextResponse.json(
			{ error: "Invalid listening report" },
			{ status: 400 },
		);
	}
	const report = parsed.data;
	const session = await db.parlumeMeetingSession.findFirst({
		where: {
			id: report.sessionId,
			providerBotId: report.botId,
			status: { in: ["ACTIVE", "LEAVING", "STOP_FAILED"] },
			finalizedAt: null,
			captureStoppedAt: null,
		},
		select: {
			id: true,
			projectId: true,
			organizationId: true,
			userId: true,
		},
	});
	// A meeting already over has nothing left to pause; the bridge drops it.
	if (!session) {
		return NextResponse.json({ accepted: false });
	}
	await db.$transaction(async (tx) => {
		await tx.parlumeMeetingSession.update({
			where: { id: session.id },
			data: report.paused
				? { pausedAt: new Date(report.at), pausedBy: report.by }
				: { pausedAt: null, pausedBy: null },
		});
		await tx.parlumeMeetingSegment.createMany({
			data: {
				sessionId: session.id,
				projectId: session.projectId,
				organizationId: session.organizationId,
				userId: session.userId,
				dedupeKey: listeningEventDedupeKey({
					sessionId: session.id,
					paused: report.paused,
					at: report.at,
				}),
				source: "EVENT",
				text: markerText(report.paused, report.by),
				speakerName: null,
				speakerId: null,
				utteranceStartMs: report.offsetMs,
				utteranceEndMs: report.offsetMs,
			},
			skipDuplicates: true,
		});
	});
	parlumeLog(
		"info",
		report.paused ? "listening.paused" : "listening.resumed",
		{
			sessionId: session.id,
			offsetMs: report.offsetMs,
		},
	);
	return NextResponse.json({ accepted: true });
}
