import { parlumeLog } from "@repo/api/modules/projects/lib/parlume-log";
import { sweepOverdueParlumeSessions } from "@repo/api/modules/projects/lib/parlume-sweep";
import { type NextRequest, NextResponse } from "next/server";
import { isParlumeServiceRequestAuthorized } from "../lib";

// Each finalization can wait on the provider's data deletion, as on the
// callback route, and one sweep finalizes up to five sessions.
export const maxDuration = 90;

/**
 * Finalizes the Parlume sessions of every project that the bridge can no
 * longer finish, as the Temporal schedule asks every ten minutes. The list
 * procedure runs the same sweep for one project when its page is opened.
 * A failure answers 503; the next tick is the retry.
 */
export async function POST(request: NextRequest) {
	if (
		!isParlumeServiceRequestAuthorized(
			request.headers.get("X-Agent-Service-Token"),
		)
	) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}
	try {
		const swept = await sweepOverdueParlumeSessions();
		return NextResponse.json({ swept });
	} catch (error) {
		parlumeLog("error", "sweep.error", {
			error: error instanceof Error ? error.message : String(error),
		});
		return NextResponse.json({ error: "Retry required" }, { status: 503 });
	}
}
