import {
	getParlumeBridgeSettings,
	purgeParlumeBridgeStorage,
} from "./parlume-attendee";
import { parlumeLog } from "./parlume-log";

/**
 * Asks the bridge to drop what it still holds of a session that is over:
 * once Fabric has finalized it, and when a member deletes it. Best effort:
 * nothing here fails the caller. A bridge that cannot be reached, or that
 * still has a stream connected, keeps its storage until its hard-stop alarm
 * purges it.
 */
export async function requestParlumeBridgePurge(
	sessionId: string,
	reason: "finalized" | "deleted",
): Promise<void> {
	try {
		const settings = getParlumeBridgeSettings();
		if (!settings) {
			return;
		}
		const { purged } = await purgeParlumeBridgeStorage({
			settings,
			sessionId,
		});
		if (!purged) {
			parlumeLog("info", "bridge.purge_deferred", { sessionId, reason });
		}
	} catch (error) {
		parlumeLog("warn", "bridge.purge_failed", {
			sessionId,
			reason,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
