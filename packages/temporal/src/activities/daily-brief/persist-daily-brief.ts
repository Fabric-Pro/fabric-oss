/**
 * Daily Brief — Persistence Activity
 *
 * Writes the generated brief back to the DailyBrief row that the oRPC
 * `regenerate` procedure created in GENERATING status. Idempotent via briefId.
 */
import {
	type DailyBriefContent,
	dailyBriefContentSchema,
	db,
} from "@repo/database";
import { logger } from "@repo/logs";
import { heartbeat } from "@temporalio/activity";

export interface PersistDailyBriefInput {
	briefId: string;
	status: "READY" | "EMPTY" | "FAILED";
	content: DailyBriefContent | null;
	errorMessage?: string;
	aiUsageTokens?: number | null;
}

export async function persistDailyBriefActivity(
	input: PersistDailyBriefInput,
): Promise<void> {
	heartbeat("persistDailyBrief: writing row");

	if (input.content) {
		const parsed = dailyBriefContentSchema.safeParse(input.content);
		if (!parsed.success) {
			throw new Error(
				`Refusing to persist invalid DailyBrief content: ${parsed.error.message}`,
			);
		}
	}

	await db.dailyBrief.update({
		where: { id: input.briefId },
		data: {
			status: input.status,
			content: input.content ?? undefined,
			errorMessage: input.errorMessage ?? null,
			aiUsageTokens: input.aiUsageTokens ?? null,
		},
	});

	logger.info("[Daily Brief] Persisted brief", {
		briefId: input.briefId,
		status: input.status,
		aiUsageTokens: input.aiUsageTokens ?? null,
	});
}
