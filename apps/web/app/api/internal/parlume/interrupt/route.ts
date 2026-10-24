import { db } from "@repo/database";
import { getTemporalClient } from "@repo/temporal";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isParlumeServiceRequestAuthorized } from "../lib";

const bodySchema = z.object({
	sessionId: z.string().min(1).max(128),
	botId: z.string().min(1).max(256),
	voiceGeneration: z.number().int().min(1),
	// `mute`: someone spoke over Parlume. The reply went quiet but its turn
	// runs on and finishes in the meeting chat. `cancel`: the turn is over.
	kind: z.enum(["cancel", "mute"]).default("cancel"),
});

/** Notes that the active turn on this generation was spoken over; nothing stops. */
async function recordMute(input: {
	sessionId: string;
	botId: string;
	voiceGeneration: number;
}): Promise<boolean> {
	const session = await db.parlumeMeetingSession.findFirst({
		where: {
			id: input.sessionId,
			providerBotId: input.botId,
			status: "ACTIVE",
			voiceGeneration: input.voiceGeneration,
		},
		select: { activeTurnId: true },
	});
	if (!session?.activeTurnId) {
		return false;
	}
	const noted = await db.parlumeMeetingTurn.updateMany({
		where: {
			id: session.activeTurnId,
			status: { in: ["PENDING", "RUNNING"] },
			interruptedAt: null,
		},
		data: { interruptedAt: new Date() },
	});
	return noted.count > 0;
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
	const { kind, ...target } = parsed.data;
	switch (kind) {
		case "mute":
			return NextResponse.json({ accepted: await recordMute(target) });
		case "cancel":
			break;
		default: {
			const unreachable: never = kind;
			return unreachable;
		}
	}
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
	const changed = await db.$transaction(async (tx) => {
		const result = await tx.parlumeMeetingSession.updateMany({
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
		if (result.count && session.activeTurnId) {
			await tx.parlumeAction.updateMany({
				where: {
					sessionId: session.id,
					status: "EXECUTING",
					turnId: session.activeTurnId,
				},
				data: {
					status: "OUTCOME_UNKNOWN",
					completedAt: new Date(),
					outcome:
						"Interrupted after execution started. Verify the destination before requesting it again.",
				},
			});
		}
		return result.count > 0;
	});
	if (!changed) {
		return NextResponse.json({ error: "Session changed" }, { status: 409 });
	}
	if (session.activeTurnId) {
		await db.parlumeMeetingTurn.updateMany({
			where: {
				id: session.activeTurnId,
				status: { in: ["PENDING", "RUNNING"] },
			},
			data: {
				status: "FAILED",
				interruptedAt: new Date(),
				completedAt: new Date(),
				error: "Interrupted by meeting speech.",
			},
		});
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
	}
	return NextResponse.json({ accepted: true });
}
