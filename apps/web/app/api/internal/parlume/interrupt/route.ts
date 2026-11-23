import { db, type Prisma } from "@repo/database";
import { getTemporalClient } from "@repo/temporal/client";
import { recordParlumeTurnAnswered } from "@repo/temporal/parlume-turn-audit";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isParlumeServiceRequestAuthorized } from "../lib";

const bodySchema = z.object({
	sessionId: z.string().min(1).max(128),
	botId: z.string().min(1).max(256),
	voiceGeneration: z.number().int().min(1),
	// The turn is over. Talking over Parlume no longer changes its turn, so
	// a `mute` report from an older bridge is refused rather than taken for
	// a cancel.
	kind: z.literal("cancel").optional(),
	// Someone asked Parlume to stop, or paused it: the turn ends as STOPPED.
	stop: z
		.object({
			cause: z.enum(["VOICE", "CHAT", "PAGE", "PAUSE"]),
			by: z.string().trim().min(1).max(256).nullable(),
		})
		.optional(),
});

/** Well beyond the seconds a stopped turn's worker takes to record it. */
const STOP_RACE_MS = 30_000;

/** How the interrupted turn ends: STOPPED when someone asked, else FAILED. */
function endedTurn(
	stop: z.infer<typeof bodySchema>["stop"],
): Prisma.ParlumeMeetingTurnUpdateManyMutationInput {
	return stop
		? { status: "STOPPED", stopCause: stop.cause, stoppedBy: stop.by }
		: {
				status: "FAILED",
				error: "Ended before the answer finished: a newer request replaced it, or the meeting connection closed.",
			};
}

/**
 * A stop silences the voice at once, so the worker can record the turn it
 * stopped as finished before the bridge's report arrives. The latest turn on
 * the stopped generation, if it finished moments ago, is recorded as STOPPED.
 */
async function markStoppedAfterFinish(
	session: { id: string; voiceGeneration: number },
	stop: NonNullable<z.infer<typeof bodySchema>["stop"]>,
): Promise<void> {
	const finished = await db.parlumeMeetingTurn.findFirst({
		where: {
			sessionId: session.id,
			voiceGeneration: session.voiceGeneration,
			status: "COMPLETED",
			completedAt: { gte: new Date(Date.now() - STOP_RACE_MS) },
			// A page question never took the voice, so no stop ends it.
			replyChannel: { not: "PAGE" },
		},
		orderBy: { completedAt: "desc" },
		select: { id: true },
	});
	if (!finished) {
		return;
	}
	await db.parlumeMeetingTurn.updateMany({
		where: { id: finished.id, status: "COMPLETED" },
		data: { status: "STOPPED", stopCause: stop.cause, stoppedBy: stop.by },
	});
}

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
			{ error: "Invalid interruption" },
			{ status: 400 },
		);
	}
	const { stop } = parsed.data;
	const session = await db.parlumeMeetingSession.findFirst({
		where: {
			id: parsed.data.sessionId,
			providerBotId: parsed.data.botId,
			status: "ACTIVE",
			voiceGeneration: { lt: parsed.data.voiceGeneration },
		},
		select: { id: true, activeTurnId: true, voiceGeneration: true },
	});
	if (!session) {
		return NextResponse.json({ accepted: false });
	}
	// A turn proposes changes and runs none, so interrupting it leaves no
	// change half made; a change a member confirmed runs apart from it.
	const changed = await db.parlumeMeetingSession.updateMany({
		where: {
			id: session.id,
			voiceGeneration: session.voiceGeneration,
			activeTurnId: session.activeTurnId,
		},
		data: {
			voiceGeneration: parsed.data.voiceGeneration,
			activeTurnId: null,
		},
	});
	if (changed.count === 0) {
		return NextResponse.json({ error: "Session changed" }, { status: 409 });
	}
	if (session.activeTurnId) {
		const ended = await db.parlumeMeetingTurn.updateMany({
			where: {
				id: session.activeTurnId,
				status: { in: ["PENDING", "RUNNING"] },
			},
			data: {
				...endedTurn(stop),
				interruptedAt: new Date(),
				completedAt: new Date(),
			},
		});
		// This write ended the turn, so its worker's own end write changes
		// nothing and records no row: the route records it.
		if (ended.count > 0) {
			await recordParlumeTurnAnswered({
				turnId: session.activeTurnId,
				status: stop ? "STOPPED" : "FAILED",
			});
		}
		const temporal = await getTemporalClient();
		try {
			await temporal.workflow
				.getHandle(`parlume-turn-${session.activeTurnId}`)
				.cancel();
		} catch (error) {
			if (
				!(error instanceof Error) ||
				error.name !== "WorkflowNotFoundError"
			) {
				throw error;
			}
		}
	} else if (stop) {
		await markStoppedAfterFinish(session, stop);
	}
	return NextResponse.json({ accepted: true });
}
