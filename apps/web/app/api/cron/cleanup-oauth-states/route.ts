import { cleanupExpiredOAuthStates } from "@repo/database";
import { NextResponse } from "next/server";
import { isCronRequestAuthorized } from "../lib/cron-auth";

/**
 * Cron job to clean up expired OAuth states
 * Runs every hour via Vercel Cron
 */
export async function GET(request: Request) {
	// Bearer `CRON_SECRET` is the only accepted credential — see
	// `isCronRequestAuthorized` for why there is no User-Agent fallback.
	if (!isCronRequestAuthorized(request)) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	try {
		const deletedCount = await cleanupExpiredOAuthStates();
		console.log(`🧹 Cleaned up ${deletedCount} expired OAuth states`);

		return NextResponse.json({
			success: true,
			deletedCount,
			timestamp: new Date().toISOString(),
		});
	} catch (error) {
		console.error("Failed to clean up expired OAuth states:", error);
		return NextResponse.json(
			{
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			},
			{ status: 500 },
		);
	}
}
