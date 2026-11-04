import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { decryptApiKey, encryptApiKey } from "@repo/utils";
import { z } from "zod";
import type { RunControlActor } from "./run-control-access";

const envelope = z.strictObject({
	purpose: z.literal("fabric-agent-run-history-queued-v2"),
	userId: z.string().min(1).max(200),
	organizationId: z.string().min(1).max(200),
	filters: z.string().regex(/^[a-f0-9]{64}$/),
	queuedAt: z.iso.datetime(),
	id: z.string().min(1).max(200),
});
export type RunHistoryPosition = Pick<
	z.infer<typeof envelope>,
	"queuedAt" | "id"
>;
export function runHistoryFilterHash(filters: unknown) {
	return createHash("sha256").update(JSON.stringify(filters)).digest("hex");
}
/** Existing rotating encryption protects denied scan positions; a cursor grants no access. */
export function encodeRunHistoryCursor(
	position: RunHistoryPosition,
	actor: RunControlActor,
	filters: string,
) {
	try {
		return Buffer.from(
			encryptApiKey(
				JSON.stringify(
					envelope.parse({
						purpose: "fabric-agent-run-history-queued-v2",
						userId: actor.userId,
						organizationId: actor.organizationId,
						filters,
						id: position.id,
						queuedAt: position.queuedAt,
					}),
				),
			),
		).toString("base64url");
	} catch {
		throw new ORPCError("SERVICE_UNAVAILABLE", {
			message: "Run history continuation is temporarily unavailable.",
		});
	}
}
export function decodeRunHistoryCursor(
	cursor: string | undefined,
	actor: RunControlActor,
	filters: string,
): RunHistoryPosition | undefined {
	if (!cursor) {
		return undefined;
	}
	try {
		const value = envelope.parse(
			JSON.parse(
				decryptApiKey(
					Buffer.from(cursor, "base64url").toString("utf8"),
				),
			),
		);
		if (
			value.userId !== actor.userId ||
			value.organizationId !== actor.organizationId ||
			value.filters !== filters
		) {
			throw new Error("Cursor context mismatch");
		}
		return { queuedAt: value.queuedAt, id: value.id };
	} catch {
		throw new ORPCError("BAD_REQUEST", {
			message:
				"Invalid run history cursor. Refresh the history to start again.",
		});
	}
}
