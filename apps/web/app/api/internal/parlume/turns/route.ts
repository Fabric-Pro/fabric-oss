import { mintParlumeActingGrantForTurn } from "@repo/api/lib/agent-service-auth";
import { db } from "@repo/database";
// Not the package root, which re-exports dozens of activity modules: a
// meeting's turn often lands on an instance that has not served this route
// yet, and that instance loads whatever this file imports before answering.
import { getTemporalClient } from "@repo/temporal/client";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
	chatMessageDedupeKey,
	isParlumeServiceRequestAuthorized,
	MAX_PARLUME_SEGMENT_CHARS,
	realtimeJobDedupeKey,
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
	replyChannel: z.enum(["VOICE", "CHAT"]).default("VOICE"),
	chatMessageId: z.string().min(1).max(128).optional(),
	// `realtime`: Parlume's realtime voice asked Fabric for this, as job
	// `job`; the worker posts the answer back for that voice to speak.
	delivery: z.enum(["speech", "realtime"]).default("speech"),
	job: z
		.string()
		.regex(/^J\d{1,6}$/)
		.optional(),
});

function turnDedupeKey(
	sessionId: string,
	turn: z.infer<typeof bodySchema>,
): string {
	if (turn.delivery === "realtime" && turn.job) {
		return realtimeJobDedupeKey({
			sessionId,
			voiceGeneration: turn.voiceGeneration,
			job: turn.job,
			text: turn.text,
		});
	}
	return turn.chatMessageId
		? chatMessageDedupeKey(sessionId, turn.chatMessageId)
		: segmentDedupeKey(turn);
}

export async function POST(request: NextRequest) {
	// Milliseconds since the handler started, per step. The bridge logs them
	// with its own handoff time, which also counts the network and the
	// platform's routing to this function.
	const startedAt = performance.now();
	const timing: Record<string, number> = {};
	const mark = (step: string) => {
		timing[step] = Math.round(performance.now() - startedAt);
	};
	if (
		!isParlumeServiceRequestAuthorized(
			request.headers.get("X-Agent-Service-Token"),
		)
	) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}
	const parsed = bodySchema.safeParse(await request.json());
	if (
		!parsed.success ||
		(parsed.data.delivery === "realtime") !==
			(parsed.data.job !== undefined)
	) {
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
			toolsReadOnly: true,
		},
	});
	mark("sessionMs");
	if (!session) {
		return NextResponse.json({ accepted: false });
	}
	if (parsed.data.voiceGeneration < session.voiceGeneration) {
		return NextResponse.json({ accepted: false });
	}
	if (session.activeTurnId) {
		return NextResponse.json({ error: "Turn busy" }, { status: 409 });
	}
	const dedupeKey = turnDedupeKey(session.id, parsed.data);
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
			replyChannel: parsed.data.replyChannel,
		},
		skipDuplicates: true,
	});
	const turn = await db.parlumeMeetingTurn.findUnique({
		where: { sessionId_dedupeKey: { sessionId: session.id, dedupeKey } },
		select: { id: true, status: true, error: true },
	});
	mark("turnMs");
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
	mark("claimMs");
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
		mark("temporalClientMs");
		// Same queue as direct chat: the worker flushes activity heartbeats every
		// second there, and nothing polls a queue named "default".
		await temporal.workflow.start("parlumeMeetingTurnWorkflow", {
			taskQueue: "fabric-worker",
			workflowId: `parlume-turn-${turn.id}`,
			workflowIdConflictPolicy: "USE_EXISTING",
			// Every model call of the turn runs as this background job, on the
			// organization's shared ChatGPT plans when they serve it, without
			// waiting for a reset: a late voice reply is useless (Fizzy #2770).
			// The acting grant is how Fabric MCP knows this turn acts for the
			// inviter. It is minted for each turn because a meeting outlives
			// a grant's hour, and it travels only in this workflow's input:
			// it is never stored on the turn or the session.
			args: [
				{
					turnId: turn.id,
					jobType: "parlume-live-turn",
					actingGrant: mintParlumeActingGrantForTurn({
						userId: session.userId,
						organizationId: session.organizationId,
						projectId: session.projectId,
						readOnly: session.toolsReadOnly,
					}),
					...(parsed.data.job
						? { realtimeJob: parsed.data.job }
						: {}),
				},
			],
		});
		mark("workflowStartMs");
		return NextResponse.json({ accepted: true, timing });
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

/**
 * Opens this function's database and Temporal connections ahead of the first
 * spoken turn (see `warmParlumeRuntime`). It reads one row at most and
 * changes nothing.
 */
export async function GET(request: NextRequest) {
	if (
		!isParlumeServiceRequestAuthorized(
			request.headers.get("X-Agent-Service-Token"),
		)
	) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}
	const sessionId = request.nextUrl.searchParams.get("sessionId");
	await Promise.allSettled([
		getTemporalClient(),
		sessionId
			? db.parlumeMeetingSession.findFirst({
					where: { id: sessionId },
					select: { id: true },
				})
			: Promise.resolve(),
	]);
	return NextResponse.json({ warm: true });
}
