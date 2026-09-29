import { db } from "@repo/database";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
	isParlumeServiceRequestAuthorized,
	MAX_PARLUME_SEGMENT_CHARS,
	segmentDedupeKey,
} from "../lib";

const bodySchema = z.object({
	sessionId: z.string().min(1).max(128),
	botId: z.string().min(1).max(256),
	text: z.string().trim().min(1).max(MAX_PARLUME_SEGMENT_CHARS),
	speakerName: z.string().trim().min(1).max(256).nullable(),
	speakerId: z.string().trim().min(1).max(256).nullable(),
	utteranceStartMs: z.number().int().min(0).max(14_400_000).nullable(),
	utteranceEndMs: z.number().int().min(0).max(14_400_000).nullable(),
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
		return NextResponse.json({ error: "Invalid segment" }, { status: 400 });
	}
	const session = await db.parlumeMeetingSession.findFirst({
		where: {
			id: parsed.data.sessionId,
			providerBotId: parsed.data.botId,
			status: { in: ["ACTIVE", "LEAVING", "STOP_FAILED", "FAILED"] },
			finalizedAt: null,
		},
		select: {
			id: true,
			projectId: true,
			organizationId: true,
			userId: true,
			captureStoppedAt: true,
		},
	});
	if (!session) {
		return NextResponse.json({ error: "Inactive stream" }, { status: 409 });
	}
	if (session.captureStoppedAt) {
		// The bridge may still be flushing an in-flight provider frame after a
		// revoked inviter has triggered leave. Acknowledge and discard it so the
		// Durable Object can drain without retaining unauthorized capture.
		return NextResponse.json({ accepted: true, discarded: true });
	}
	const dedupeKey = segmentDedupeKey(parsed.data);
	const created = await db.parlumeMeetingSegment.createMany({
		data: {
			sessionId: session.id,
			projectId: session.projectId,
			organizationId: session.organizationId,
			userId: session.userId,
			dedupeKey,
			text: parsed.data.text,
			speakerName: parsed.data.speakerName,
			speakerId: parsed.data.speakerId,
			utteranceStartMs: parsed.data.utteranceStartMs,
			utteranceEndMs: parsed.data.utteranceEndMs,
		},
		skipDuplicates: true,
	});
	return NextResponse.json({
		accepted: true,
		duplicate: created.count === 0,
	});
}
