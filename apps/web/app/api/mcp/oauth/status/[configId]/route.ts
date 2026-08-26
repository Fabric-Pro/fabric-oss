import { auth } from "@repo/auth";
import { db } from "@repo/database";
import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * GET /api/mcp/oauth/status/[configId]?organizationId=<id>
 *
 * Returns the OAuth authentication status for an MCP config.
 * Used by the frontend to show "Connected" / "Not Connected" badges.
 *
 * Enforces tenant isolation via explicit organizationId from the caller
 * (not session state, which can be stale). Empty organizationId param
 * means personal context (organizationId = null in DB).
 */
export async function GET(
	req: NextRequest,
	{ params }: { params: Promise<{ configId: string }> },
) {
	try {
		const session = await auth.api.getSession({ headers: req.headers });
		if (!session?.user?.id) {
			return NextResponse.json(
				{ error: "Unauthorized" },
				{ status: 401 },
			);
		}

		const { configId } = await params;

		// Derive organizationId from explicit query param, not session state.
		// Empty string = personal context (null in DB).
		const orgParam = req.nextUrl.searchParams.get("organizationId");
		const organizationId = orgParam || null;

		// Tenant-scoped lookup: userId + explicit organizationId (XOR pattern)
		const config = await db.mCPConfig.findFirst({
			where: {
				id: configId,
				userId: session.user.id,
				organizationId,
			},
			select: {
				id: true,
				authType: true,
				encryptedAccessToken: true,
				encryptedRefreshToken: true,
				tokenExpiresAt: true,
				needsReauth: true,
			},
		});

		if (!config) {
			return NextResponse.json(
				{ error: "Config not found" },
				{ status: 404 },
			);
		}

		const hasAccessToken = !!config.encryptedAccessToken;
		const hasRefreshToken = !!config.encryptedRefreshToken;
		const tokenExpired = config.tokenExpiresAt
			? new Date() > config.tokenExpiresAt
			: false;

		return NextResponse.json({
			data: {
				authenticated: hasAccessToken && !config.needsReauth,
				tokenExpired,
				refreshTokenExpired: false,
				hasRefreshToken,
				tokenExpiresAt: config.tokenExpiresAt?.toISOString() ?? null,
			},
		});
	} catch (error) {
		console.error("[MCP OAuth Status] Error:", error);
		return NextResponse.json(
			{ error: "Internal server error" },
			{ status: 500 },
		);
	}
}
