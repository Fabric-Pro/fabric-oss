import {
	dropParlumeTranscriptVectors,
	listParlumeSessionsPastRetention,
	type PendingVectorCleanupRecord,
	purgeParlumeSessionContent,
} from "@repo/database";
import { drainPendingVectorCleanup } from "../lib/delete-channel-context";
import { parlumeActivityLog } from "./parlume-log";

/** Per run, so one hourly run stays well inside its activity timeout. */
const SESSION_BATCH = 50;
const VECTOR_BATCH = 50;

export interface ParlumeRetentionResult {
	purgedSessions: number;
	droppedVectors: number;
	undrained: number;
}

/**
 * The retention sweep (decision D5): a settled session's raw meeting content
 * goes 90 days after the meeting, and any Parlume transcript still in the
 * vector index leaves it. Session rows, requests, suggestions and notes stay.
 *
 * Safe to run again: a purged session is not listed twice, and a drain that
 * fails here stays queued for the pending-vector-cleanup sweep.
 */
export async function purgeExpiredParlumeTranscripts(): Promise<ParlumeRetentionResult> {
	const sessions = await listParlumeSessionsPastRetention({
		now: new Date(),
		limit: SESSION_BATCH,
	});
	const cleanups: PendingVectorCleanupRecord[] = [];
	let purgedSessions = 0;
	for (const session of sessions) {
		const { purged, vectorCleanup } = await purgeParlumeSessionContent({
			sessionId: session.id,
			projectId: session.projectId,
			scope: "TRANSCRIPT",
		});
		if (purged) {
			purgedSessions++;
			parlumeActivityLog("info", "retention.purged", {
				sessionId: session.id,
			});
		}
		if (vectorCleanup) {
			cleanups.push(vectorCleanup);
		}
	}
	const dropped = await dropParlumeTranscriptVectors({
		limit: VECTOR_BATCH,
	});
	cleanups.push(...dropped);

	let undrained = 0;
	for (const cleanup of cleanups) {
		try {
			await drainPendingVectorCleanup(cleanup);
		} catch (error) {
			undrained++;
			parlumeActivityLog("warn", "retention.drain_failed", {
				cleanupId: cleanup.id,
				projectId: cleanup.projectId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return { purgedSessions, droppedVectors: dropped.length, undrained };
}
