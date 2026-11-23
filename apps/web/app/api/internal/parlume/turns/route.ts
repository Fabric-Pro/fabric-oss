import { mintParlumeActingGrantForTurn } from "@repo/api/lib/agent-service-auth";
import {
	findParlumeAttendeeWithoutRead,
	parlumeDepartureNotice,
} from "@repo/api/modules/projects/lib/parlume-attendee-standing";
import {
	confidentialRangeSelect,
	parlumeTurnAudience,
	postParlumeConfidentialNotice,
	setParlumeConfidentialRange,
} from "@repo/api/modules/projects/lib/parlume-confidential";
import { requestParlumeLeave } from "@repo/api/modules/projects/lib/parlume-leave";
import { db } from "@repo/database";
// Not the package root, which re-exports dozens of activity modules: a
// meeting's turn often lands on an instance that has not served this route
// yet, and that instance loads whatever this file imports before answering.
import { getTemporalClient } from "@repo/temporal/client";
import { parseParlumeConfidentialRequest } from "@repo/utils/parlume-confidential";
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
	// The Fabric accounts of the people Fabric confirmed in the meeting, each
	// checked again before the turn runs. None from a bridge that predates it.
	attendees: z.array(z.string().min(1).max(128)).max(200).default([]),
	// The Fabric account of the confirmed participant who asked, when the
	// bridge could tell. None from a bridge that predates it.
	requester: z.string().min(1).max(128).nullish(),
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
			...confidentialRangeSelect,
			activeTurnId: true,
			voiceGeneration: true,
			streamGeneration: true,
			attendeeUserIds: true,
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
	// Everyone Fabric confirmed must still read the project as the turn
	// starts: if one no longer can, the chat is told who and Parlume leaves.
	const lost = await findParlumeAttendeeWithoutRead({
		projectId: session.projectId,
		userIds: parsed.data.attendees,
	});
	mark("attendeesMs");
	if (lost) {
		await requestParlumeLeave({
			session: {
				id: session.id,
				providerBotId: parsed.data.botId,
				streamGeneration: session.streamGeneration,
			},
			reason: "ATTENDEE_NOT_AUTHORIZED",
			lastError: null,
			captureStopped: true,
			notice: parlumeDepartureNotice({
				kind: "attendee",
				name: lost.name,
			}),
		});
		return NextResponse.json({ accepted: false });
	}
	// Every lookup runs as the person who asked, never as the inviter: a
	// turn whose asker Fabric cannot place among the confirmed attendees
	// present looks nothing up, and gets no grant.
	const { requesterUserId, withConfidential } = parlumeTurnAudience({
		requester: parsed.data.requester,
		attendees: parsed.data.attendees,
		attendeeUserIds: session.attendeeUserIds,
		guests: session.externalInvitees || session.guestJoinedAt !== null,
	});
	// "Hey Parlume, off the record": the mark is set here as well as from
	// the request's segment, whichever comes first, and the turn answers it.
	const confidentialSwitch = parseParlumeConfidentialRequest(
		parsed.data.text,
	);
	mark("audienceMs");
	const dedupeKey = turnDedupeKey(session.id, parsed.data);
	const created = await db.parlumeMeetingTurn.createMany({
		data: {
			sessionId: session.id,
			projectId: session.projectId,
			organizationId: session.organizationId,
			userId: session.userId,
			requesterUserId,
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
	// Only the request's first delivery switches the mark: a retried "off
	// the record is over" must not undo a later "off the record".
	if (confidentialSwitch && created.count > 0) {
		const range = await setParlumeConfidentialRange({
			session,
			switch: confidentialSwitch,
			by: parsed.data.speakerName,
			offsetMs: parsed.data.utteranceStartMs,
		});
		if (range.changed) {
			await postParlumeConfidentialNotice({
				sessionId: session.id,
				switch: confidentialSwitch,
				by: parsed.data.speakerName,
			});
		}
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
			// The acting grant is how Fabric MCP knows whose access this turn
			// reads with: the confirmed participant who asked. It holds reads
			// only: a change is proposed and runs once a member confirms it.
			// It is minted for each turn because a meeting outlives a grant's
			// hour, and it travels only in this workflow's input: it is never
			// stored on the turn or the session.
			args: [
				{
					turnId: turn.id,
					jobType: "parlume-live-turn",
					...(requesterUserId
						? {
								actingGrant: mintParlumeActingGrantForTurn({
									userId: requesterUserId,
									organizationId: session.organizationId,
									projectId: session.projectId,
								}),
							}
						: {}),
					withConfidential,
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
