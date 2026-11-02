/**
 * Resume an agent's authorization after sign-in. The request arrives
 * base64url-encoded so it survives being a magic link's `callbackURL`; see
 * `@saas/auth/lib/oauth-continuation`.
 */

import { authorizationResumeLocation } from "@saas/auth/lib/oauth-continuation";
import { getSession } from "@saas/auth/lib/server";
import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
	const session = await getSession();
	if (session?.user.mustChangePassword) {
		return NextResponse.redirect(
			new URL("/change-password", request.nextUrl.origin),
		);
	}

	const location = authorizationResumeLocation(
		request.nextUrl.searchParams.get("q"),
	);
	return NextResponse.redirect(
		new URL(location ?? "/auth/login", request.nextUrl.origin),
	);
}
