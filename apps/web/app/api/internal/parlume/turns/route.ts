import { db } from "@repo/database";
import { getTemporalClient } from "@repo/temporal";
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
	voiceGeneration: z.number().int().min(0).default(0),
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
		return NextResponse.json({ error: "Invalid turn" }, { status: 400 });
	}
	const session = await db.parlumeMeetingSession.findFirst({
		where: {
			id: parsed.data.sessionId,
			providerBotId: parsed.data.botId,
			status: "ACTIVE",
		},
		select: {
			id: true,
			projectId: true,
			organizationId: true,
			userId: true,
			activeTurnId: true,
			voiceGeneration: true,
		},
	});
	if (!session) {
		return NextResponse.json({ accepted: false });
	}
	if (parsed.data.voiceGeneration < session.voiceGeneration) {
		return NextResponse.json({ accepted: false });
	}
	if (session.activeTurnId) {
		return NextResponse.json({ error: "Turn busy" }, { status: 409 });
	}
	const dedupeKey = segmentDedupeKey(parsed.data);
	const created = await db.parlumeMeetingTurn.createMany({
		data: {
			sessionId: session.id,
			projectId: session.projectId,
			organizationId: session.organizationId,
			userId: session.userId,
			dedupeKey,
			requestText: parsed.data.text,
			speakerName: parsed.data.speakerName,
			speakerId: parsed.data.speakerId,
			voiceGeneration: parsed.data.voiceGeneration,
		},
		skipDuplicates: true,
	});
	const turn = await db.parlumeMeetingTurn.findUnique({
		where: { sessionId_dedupeKey: { sessionId: session.id, dedupeKey } },
		select: { id: true, status: true, error: true },
	});
	if (!turn) {
		return NextResponse.json(
			{ error: "Turn persistence failed" },
			{ status: 503 },
		);
	}
	if (created.count === 0) {
		if (
			turn.status !== "FAILED" ||
			(turn.error !== "Another Parlume turn is already running." &&
				turn.error !== "Parlume turn dispatch failed.")
		) {
			return NextResponse.json({ accepted: false });
		}
		const retried = await db.parlumeMeetingTurn.updateMany({
			where: {
				id: turn.id,
				status: "FAILED",
				error: turn.error,
			},
			data: { status: "PENDING", error: null, completedAt: null },
		});
		if (retried.count === 0) {
			return NextResponse.json({ accepted: false });
		}
	}
	const claimed = await db.parlumeMeetingSession.updateMany({
		where: {
			id: session.id,
			status: "ACTIVE",
			activeTurnId: null,
			voiceGeneration: { lte: parsed.data.voiceGeneration },
		},
		data: {
			activeTurnId: turn.id,
			voiceGeneration: parsed.data.voiceGeneration,
		},
	});
	if (claimed.count === 0) {
		await db.parlumeMeetingTurn.update({
			where: { id: turn.id },
			data: {
				status: "FAILED",
				error: "Another Parlume turn is already running.",
				completedAt: new Date(),
			},
		});
		return NextResponse.json({ error: "Turn busy" }, { status: 409 });
	}
	try {
		const temporal = await getTemporalClient();
		await temporal.workflow.start("parlumeMeetingTurnWorkflow", {
			taskQueue: "default",
			workflowId: `parlume-turn-${turn.id}`,
			workflowIdConflictPolicy: "USE_EXISTING",
			args: [{ turnId: turn.id }],
		});
		return NextResponse.json({ accepted: true });
	} catch {
		await db.$transaction([
			db.parlumeMeetingTurn.update({
				where: { id: turn.id },
				data: {
					status: "FAILED",
					error: "Parlume turn dispatch failed.",
					completedAt: new Date(),
				},
			}),
			db.parlumeMeetingSession.updateMany({
				where: { id: session.id, activeTurnId: turn.id },
				data: { activeTurnId: null },
			}),
		]);
		return NextResponse.json({ error: "Dispatch failed" }, { status: 503 });
	}
}
