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
	kind: z.enum(["reply", "suggestion", "proposal", "notice"]),
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
 * A request's own posts (its answer, detail, rest or error line) as the
 * Parlume page lists them: the tags the chat showed, and those it did not. A
 * post seen late moves from the second list to the first.
 */
function turnPostTags(
	turn: { chatTags: string[]; chatUnshownTags: string[] },
	tag: string,
	shown: boolean,
): { chatTags: string[]; chatUnshownTags: string[] } {
	const others = (tags: string[]) => tags.filter((other) => other !== tag);
	return shown
		? {
				chatTags: [...others(turn.chatTags), tag],
				chatUnshownTags: others(turn.chatUnshownTags),
			}
		: {
				chatTags: others(turn.chatTags),
				chatUnshownTags: [...others(turn.chatUnshownTags), tag],
			};
}

/**
 * What became of a Parlume chat post, as the bridge observed it. A post that
 * never showed up, or showed up late, is noted on its request so the request
 * history does not claim a message reached the chat when it did not. The
 * Parlume page shows the outcome on the post's own row: a request keeps the
 * tags of its posts, and a proposal, a suggestion and the recap (a post with
 * no request) whether the chat showed theirs. A notice belongs to no row.
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
	const shown = outcome === "confirmed";
	// A prompt confirmation is the expected case and needs no note.
	const notes = !shown || latencyMs > CONFIRM_WINDOW_MS;
	const ownPost = kind === "reply";
	const turn =
		turnId !== null &&
		(notes || ownPost) &&
		(await db.parlumeMeetingTurn.findFirst({
			where: { id: turnId, sessionId: session.id },
			select: {
				id: true,
				error: true,
				chatTags: true,
				chatUnshownTags: true,
			},
		}));
	if (turn) {
		// A late post replaces the "did not appear" note it was reported with.
		const earlier = turn.error
			?.replace(deliveryNote(tag, "unconfirmed", latencyMs), "")
			.trim();
		const note = deliveryNote(tag, outcome, latencyMs);
		await db.parlumeMeetingTurn.update({
			where: { id: turn.id },
			data: {
				...(notes
					? { error: earlier ? `${earlier} ${note}` : note }
					: {}),
				...(ownPost ? turnPostTags(turn, tag, shown) : {}),
			},
		});
	}
	const chatDelivery = shown ? "SHOWN" : "NOT_SHOWN";
	const tagged = { sessionId: session.id, chatTag: tag };
	switch (kind) {
		case "reply":
			if (turnId === null) {
				await db.parlumeSuggestion.updateMany({
					where: { ...tagged, kind: "RECAP" },
					data: { chatDelivery },
				});
			}
			break;
		case "suggestion":
			await db.parlumeSuggestion.updateMany({
				where: tagged,
				data: { chatDelivery },
			});
			break;
		case "proposal":
			await db.parlumeAction.updateMany({
				where: tagged,
				data: { chatDelivery },
			});
			break;
		case "notice":
			break;
		default: {
			const unreachable: never = kind;
			return unreachable;
		}
	}
	return NextResponse.json({ accepted: true });
}
