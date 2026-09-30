import { db } from "@repo/database";
import type { ParlumeMeetingEndReason } from "@repo/database/prisma/generated/enums";
import { parlumeLog } from "./parlume-log";
import {
	getParlumeBridgeSettings,
	leaveParlumeMeetingBot,
	type ParlumeMeetingBotLeaveResult,
} from "./parlume-meeting-baas";

const leavableStatuses = [
	"JOINING",
	"ACTIVE",
	"LEAVING",
	"STOP_FAILED",
] as const;

/**
 * Fabric decided the meeting is over (idle, access revoked, stream failure):
 * record why, then ask the provider to leave. The terminal callback and the
 * stream close still finalize the session; on a provider error the session
 * stays STOP_FAILED for the bridge watchdog to retry.
 */
export async function requestParlumeLeave(input: {
	session: {
		id: string;
		providerBotId: string;
		streamGeneration: number;
	};
	reason: ParlumeMeetingEndReason;
	lastError: string | null;
	captureStopped: boolean;
}): Promise<ParlumeMeetingBotLeaveResult | null> {
	const now = new Date();
	const claimed = await db.parlumeMeetingSession.updateMany({
		where: {
			id: input.session.id,
			streamGeneration: input.session.streamGeneration,
			status: { in: [...leavableStatuses] },
			finalizedAt: null,
		},
		data: {
			status: "LEAVING",
			endReason: input.reason,
			leaveRequestedAt: now,
			...(input.lastError === null ? {} : { lastError: input.lastError }),
			...(input.captureStopped ? { captureStoppedAt: now } : {}),
		},
	});
	if (claimed.count === 0) {
		return null;
	}
	const settings = getParlumeBridgeSettings();
	try {
		if (!settings) {
			throw new Error("Parlume bridge configuration is unavailable.");
		}
		const result = await leaveParlumeMeetingBot({
			settings,
			providerBotId: input.session.providerBotId,
		});
		parlumeLog("info", "leave.requested", {
			sessionId: input.session.id,
			botId: input.session.providerBotId,
			reason: input.reason,
			result: result.kind,
		});
		return result;
	} catch (error) {
		await db.parlumeMeetingSession.updateMany({
			where: { id: input.session.id, status: "LEAVING" },
			data: { status: "STOP_FAILED" },
		});
		parlumeLog("error", "leave.failed", {
			sessionId: input.session.id,
			botId: input.session.providerBotId,
			reason: input.reason,
			error: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}
}
