import { db } from "@repo/database";
import { finalizeParlumeSession } from "./parlume-finalization";
import { parlumeLog } from "./parlume-log";

/**
 * Finalizes sessions the bridge can no longer finish. Finalization normally
 * follows the stream close or the bridge's hard-stop alarm; a lost alarm
 * (observed on staging on 2026-09-30) strands a session in LEAVING with its
 * bot long gone. Runs when a project's sessions are listed, so the page that
 * shows the stale row is what repairs it. Only sessions whose provider has
 * already reported the bot gone qualify: an overdue session that is still
 * capturing needs a leave request, not a transcript.
 */
export async function sweepOverdueParlumeSessions(
	projectId: string,
): Promise<void> {
	const overdue = await db.parlumeMeetingSession.findMany({
		where: {
			projectId,
			status: { in: ["LEAVING", "STOP_FAILED", "FAILED"] },
			providerBotId: { not: null },
			terminalCallbackAt: { not: null },
			finalizedAt: null,
			hardStopAt: { lt: new Date() },
		},
		select: { id: true, status: true, streamGeneration: true },
		take: 5,
	});
	for (const session of overdue) {
		try {
			await finalizeParlumeSession(session.id, {
				expectedStreamGeneration: session.streamGeneration,
				...(session.status === "FAILED"
					? { preserveFailure: true }
					: {}),
			});
			parlumeLog("info", "session.swept", {
				sessionId: session.id,
				status: session.status,
			});
		} catch (error) {
			parlumeLog("warn", "session.sweep_failed", {
				sessionId: session.id,
				status: session.status,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}
