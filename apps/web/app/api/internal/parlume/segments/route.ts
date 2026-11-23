import {
	confidentialRangeSelect,
	postParlumeConfidentialNotice,
	setParlumeConfidentialRange,
} from "@repo/api/modules/projects/lib/parlume-confidential";
import { db } from "@repo/database";
import { parseParlumeConfidentialCommand } from "@repo/utils/parlume-confidential";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
	chatMessageDedupeKey,
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
	source: z.enum(["SPEECH", "CHAT"]).default("SPEECH"),
	chatMessageId: z.string().min(1).max(128).optional(),
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
			...confidentialRangeSelect,
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
	// "Parlume, confidential" and "Parlume, end confidential", said or typed.
	// Either command is itself stored as said in the confidential part.
	const command = parseParlumeConfidentialCommand(parsed.data.text);
	const confidential =
		session.confidentialSince !== null || command?.switch === "on";
	const dedupeKey = parsed.data.chatMessageId
		? chatMessageDedupeKey(session.id, parsed.data.chatMessageId)
		: segmentDedupeKey(parsed.data);
	const created = await db.parlumeMeetingSegment.createMany({
		data: {
			sessionId: session.id,
			projectId: session.projectId,
			organizationId: session.organizationId,
			userId: session.userId,
			dedupeKey,
			source: parsed.data.source,
			text: parsed.data.text,
			speakerName: parsed.data.speakerName,
			speakerId: parsed.data.speakerId,
			utteranceStartMs: parsed.data.utteranceStartMs,
			utteranceEndMs: parsed.data.utteranceEndMs,
			confidential,
		},
		skipDuplicates: true,
	});
	// Acted on once: a command delivered again after a later one must not
	// undo it.
	if (command && created.count > 0) {
		const range = await setParlumeConfidentialRange({
			session,
			switch: command.switch,
			by: parsed.data.speakerName,
			offsetMs: parsed.data.utteranceStartMs,
		});
		// The chat is told whenever the mark changes, as it is for a pause. A
		// command after the wake phrase is also a turn, which answers aloud.
		if (range.changed) {
			await postParlumeConfidentialNotice({
				sessionId: session.id,
				switch: command.switch,
				by: parsed.data.speakerName,
			});
		}
	}
	return NextResponse.json({
		accepted: true,
		duplicate: created.count === 0,
	});
}
