import { getAppVersion } from "@shared/lib/app-version";
import { NextResponse } from "next/server";

/**
 * Lightweight build-version endpoint. Always served by the latest deployment
 * (custom `fetch()` calls are not skew-pinned by Vercel), so a client can
 * compare the version it loaded against the freshest deployed version. Returns
 * only a build id — no tenant data — and is never cached.
 */
export const dynamic = "force-dynamic";

export function GET() {
	return NextResponse.json(
		{ version: getAppVersion() },
		{
			status: 200,
			headers: {
				"Cache-Control": "no-store, no-cache, must-revalidate",
			},
		},
	);
}
