import { parlumeLog } from "@repo/api/modules/projects/lib/parlume-log";
import { db } from "@repo/database";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isParlumeServiceRequestAuthorized } from "../lib";

const bodySchema = z.object({
	sessionId: z.string().min(1).max(128),
	botId: z.string().min(1).max(256),
	turnId: z.string().min(1).max(128).nullable(),
	tag: z.string().regex(/^P\d{1,6}$/),
	kind: z.enum(["reply", "suggestion", "held"]),
	outcome: z.enum(["confirmed", "unconfirmed", "unavailable"]),
	latencyMs: z.number().int().min(0).max(86_400_000),
});

type DeliveryOutcome = z.infer<typeof bodySchema>["outcome"];

/** The bridge's confirmation window; a post seen later was reported missing first. */
const CONFIRM_WINDOW_MS = 15_000;

function deliveryNote(
	tag: string,
	outcome: DeliveryOutcome,
	latencyMs: number,
): string {
	switch (outcome) {
		case "confirmed":
			return `Chat message ${tag} appeared in the meeting chat after ${Math.round(latencyMs / 1_000)} s.`;
		case "unconfirmed":
			return `Chat message ${tag} was sent but did not appear in the meeting chat within ${CONFIRM_WINDOW_MS / 1_000} seconds.`;
		case "unavailable":
			return `Chat message ${tag} did not appear: this meeting's chat looks unavailable to Parlume.`;
		default: {
			const unreachable: never = outcome;
			return unreachable;
		}
	}
}

/**
 * What became of a Parlume chat post, as the bridge observed it. A post that
 * never showed up, or showed up late, is noted on its request so the request
 * history does not claim a message reached the chat when it did not.
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
		return NextResponse.json({ error: "Invalid report" }, { status: 400 });
	}
	const { sessionId, botId, turnId, tag, kind, outcome, latencyMs } =
		parsed.data;
	const session = await db.parlumeMeetingSession.findFirst({
		where: { id: sessionId, providerBotId: botId },
		select: { id: true },
	});
	if (!session) {
		return NextResponse.json({ error: "Unknown session" }, { status: 404 });
	}
	parlumeLog(outcome === "confirmed" ? "info" : "warn", "chat.delivery", {
		sessionId,
		botId,
		turnId,
		tag,
		kind,
		outcome,
		latencyMs,
	});
	// A prompt confirmation is the expected case and needs no note.
	const noted =
		turnId !== null &&
		(outcome !== "confirmed" || latencyMs > CONFIRM_WINDOW_MS) &&
		(await db.parlumeMeetingTurn.findFirst({
			where: { id: turnId, sessionId: session.id },
			select: { id: true, error: true },
		}));
	if (noted) {
		// A late post replaces the "did not appear" note it was reported with.
		const earlier = noted.error
			?.replace(deliveryNote(tag, "unconfirmed", latencyMs), "")
			.trim();
		const note = deliveryNote(tag, outcome, latencyMs);
		await db.parlumeMeetingTurn.update({
			where: { id: noted.id },
			data: { error: earlier ? `${earlier} ${note}` : note },
		});
	}
	return NextResponse.json({ accepted: true });
}
