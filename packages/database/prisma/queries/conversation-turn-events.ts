import type { ChatEventCursor } from "@repo/utils/chat-event-cursor";
import { keyIsSensitive, REDACTED } from "@repo/utils/sensitive-keys";
import { db } from "../client";
import type { Prisma } from "../generated/client";

// These fields describe ordinary tool output or usage, rather than credentials.
// Keep the shared denylist intact for every other field and every nested value.
const PUBLIC_TOOL_FIELDS = new Set([
	"mapping",
	"shipping",
	"opinion",
	"maxtokens",
	"maxoutputtokens",
	"inputtokens",
	"outputtokens",
	"totaltokens",
	"prompttokens",
	"completiontokens",
	"tokenusage",
	"tokenbudget",
]);
function redactReplayData(input: unknown): unknown {
	if (Array.isArray(input)) {
		return input.map(redactReplayData);
	}
	if (input === null || typeof input !== "object") {
		return input;
	}
	return Object.fromEntries(
		Object.entries(input).map(([key, value]) => [
			key,
			keyIsSensitive(key) && !PUBLIC_TOOL_FIELDS.has(key.toLowerCase())
				? REDACTED
				: redactReplayData(value),
		]),
	);
}

const REPLAY_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_EVENT_BYTES = 1024 * 1024;
const MAX_EVENTS_PER_RUN = 20_000;

export class ChatEventReplayError extends Error {}

export interface ConversationEventScope {
	turnId: string;
	executionId: string;
	organizationId: string;
	userId: string;
	runId: string;
}

/** Internal worker writer: ownership comes from the server-admitted execution. */
export async function appendConversationTurnEventFromWorker(input: {
	executionId: string;
	runId: string;
	sourceKey: string;
	event: string;
	data: unknown;
}): Promise<ChatEventCursor | null> {
	return db.$transaction(
		async (tx) => {
			// Allocate sequence numbers only while holding the turn lock. An event
			// with a higher id cannot commit before an earlier event in this log.
			const [turn] = await tx.$queryRaw<
				{
					id: string;
					userId: string;
					organizationId: string;
					createdAt: Date;
				}[]
			>`SELECT "id", "userId", "organizationId", "createdAt"
		  FROM "conversation_turn" WHERE "executionId" = ${input.executionId}
		  FOR UPDATE`;
			if (!turn) {
				return null;
			}
			const serialized = JSON.stringify(redactReplayData(input.data));
			if (
				!serialized ||
				Buffer.byteLength(serialized) > MAX_EVENT_BYTES
			) {
				throw new ChatEventReplayError(
					"Replay event exceeds the output limit",
				);
			}
			const unique = {
				turnId: turn.id,
				runId: input.runId,
				sourceKey: input.sourceKey,
			};
			const existing = await tx.conversationTurnEvent.findUnique({
				where: { turnId_runId_sourceKey: unique },
			});
			if (existing) {
				return {
					turnId: turn.id,
					runId: input.runId,
					sequence: String(existing.id),
				};
			}
			if (
				!(
					input.event === "execution.replay_unavailable" &&
					input.sourceKey === "replay-unavailable"
				) &&
				(await tx.conversationTurnEvent.count({
					where: { turnId: turn.id, runId: input.runId },
				})) >= MAX_EVENTS_PER_RUN
			) {
				throw new ChatEventReplayError("Replay output limit reached");
			}
			const row = await tx.conversationTurnEvent.create({
				data: {
					...unique,
					organizationId: turn.organizationId,
					userId: turn.userId,
					event: input.event,
					data: JSON.parse(serialized) as Prisma.InputJsonValue,
					expiresAt: new Date(
						turn.createdAt.getTime() + REPLAY_RETENTION_MS,
					),
				},
			});
			return {
				turnId: turn.id,
				runId: input.runId,
				sequence: String(row.id),
			};
		},
		{ maxWait: 500, timeout: 2000 },
	);
}

/** Every read is scoped through the parent turn, never just a cursor or copied tenant. */
export async function readConversationTurnEvents(input: {
	scope: ConversationEventScope;
	after?: ChatEventCursor;
}) {
	const { scope, after } = input;
	if (
		after &&
		(after.turnId !== scope.turnId || after.runId !== scope.runId)
	) {
		throw new ChatEventReplayError("Replay cursor belongs to another run");
	}
	const where = {
		turnId: scope.turnId,
		runId: scope.runId,
		organizationId: scope.organizationId,
		userId: scope.userId,
		turn: {
			id: scope.turnId,
			executionId: scope.executionId,
			organizationId: scope.organizationId,
			userId: scope.userId,
		},
		expiresAt: { gt: new Date() },
	};
	if (
		after &&
		!(await db.conversationTurnEvent.findFirst({
			where: { ...where, id: BigInt(after.sequence) },
			select: { id: true },
		}))
	) {
		throw new ChatEventReplayError(
			"Replay cursor expired or is unavailable",
		);
	}
	const rows = await db.conversationTurnEvent.findMany({
		where: {
			...where,
			...(after ? { id: { gt: BigInt(after.sequence) } } : {}),
		},
		orderBy: { id: "asc" },
		take: 200,
	});
	return rows.map((row) => ({
		cursor: {
			turnId: row.turnId,
			runId: row.runId,
			sequence: String(row.id),
		},
		event: row.event,
		data: row.data,
	}));
}

/** Bounded cache cleanup; expired replay rows are never returned to readers. */
export async function purgeExpiredConversationTurnEvents(): Promise<number> {
	return db.$executeRaw`DELETE FROM "conversation_turn_event" WHERE "id" IN (
		SELECT "id" FROM "conversation_turn_event" WHERE "expiresAt" <= NOW()
		ORDER BY "expiresAt", "id" LIMIT 5000
	)`;
}
