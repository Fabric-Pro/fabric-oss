import { db } from "@repo/database";
import { finalizeParlumeSession } from "./parlume-finalization";
import { parlumeLog } from "./parlume-log";

/**
 * How long after the provider reported the bot gone the bridge has to report
 * its stream closed. A stream normally closes before that report comes; a
 * bridge that could not deliver buffered segments retries every five
 * minutes, and finalizing first would refuse them, so this allows three
 * tries.
 */
const PARLUME_STREAM_CLOSE_GRACE_MS = 15 * 60 * 1000;

/**
 * Finalizes sessions the bridge can no longer finish. Finalization normally
 * follows the stream close or the bridge's hard-stop alarm; a lost alarm
 * (observed on staging on 2026-09-30), or a stream close the bridge never
 * reports, strands a session in LEAVING with its bot long gone, and the
 * Parlume page takes no new invitation. Runs for one project when its
 * sessions are listed, so the page that shows the stale row repairs it, and
 * for every project from the Temporal schedule every ten minutes, so a
 * session nobody looks at is finalized too. Only sessions whose provider has
 * already reported the bot gone qualify, at the hard stop or
 * {@link PARLUME_STREAM_CLOSE_GRACE_MS} after that report: an overdue session
 * that is still capturing needs a leave request, not a transcript. Returns
 * how many it finalized.
 */
export async function sweepOverdueParlumeSessions(
	projectId?: string,
): Promise<number> {
	const now = Date.now();
	const overdue = await db.parlumeMeetingSession.findMany({
		where: {
			...(projectId ? { projectId } : {}),
			status: { in: ["LEAVING", "STOP_FAILED", "FAILED"] },
			providerBotId: { not: null },
			terminalCallbackAt: { not: null },
			finalizedAt: null,
			OR: [
				{ hardStopAt: { lt: new Date(now) } },
				{
					terminalCallbackAt: {
						lt: new Date(now - PARLUME_STREAM_CLOSE_GRACE_MS),
					},
				},
			],
		},
		select: { id: true, status: true, streamGeneration: true },
		// The scheduled run covers every project, so a few sessions that fail
		// on every run cannot keep it from the others.
		orderBy: { terminalCallbackAt: "asc" },
		take: projectId ? 5 : 20,
	});
	let swept = 0;
	for (const session of overdue) {
		try {
			await finalizeParlumeSession(session.id, {
				expectedStreamGeneration: session.streamGeneration,
				...(session.status === "FAILED"
					? { preserveFailure: true }
					: {}),
			});
			swept += 1;
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
	return swept;
}
