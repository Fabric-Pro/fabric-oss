import { auth } from "@repo/auth";
import {
	db,
	getOrganizationMembership,
	isGitLabPersonalMcpServerKey,
} from "@repo/database";
import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * GET /api/mcp/oauth/status/[configId]?organizationId=<id>
 *
 * Returns the OAuth authentication status for an MCP config.
 * Used by the frontend to show "Connected" / "Not Connected" badges.
 *
 * Enforces tenant isolation via explicit organizationId from the caller
 * (not session state, which can be stale), and only for an organization the
 * caller is a member of now: a config row outlives its owner's membership,
 * and the GitLab read below can write (it classifies a legacy connection
 * row, or refreshes its token), so a left organization is refused before
 * anything is read. An empty organizationId param looks up a no-organization row
 * (organizationId = null in DB); there the GitLab connection is only
 * inspected, never written — ADR-018 has no personal tenant to write into.
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

		if (
			organizationId &&
			!(await getOrganizationMembership(organizationId, session.user.id))
		) {
			return NextResponse.json({ error: "Forbidden" }, { status: 403 });
		}

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
				mcpServer: { select: { key: true } },
			},
		});

		if (!config) {
			return NextResponse.json(
				{ error: "Config not found" },
				{ status: 404 },
			);
		}

		// GitLab personal servers hold no credential of their own: report the
		// person's GitLab connection, exactly as every other GitLab screen
		// does (`readGitLabPersonalConnection`).
		if (isGitLabPersonalMcpServerKey(config.mcpServer?.key)) {
			const {
				readGitLabPersonalConnection,
				readStoredGitLabConnectionStatus,
				summarizeGitLabConnection,
			} = await import("@repo/integrations/gitlab");
			const tenant = { userId: session.user.id, organizationId };
			// Membership was verified above for an organization; with none,
			// read without writing.
			const status = organizationId
				? (await readGitLabPersonalConnection(tenant)).status
				: await readStoredGitLabConnectionStatus(tenant);
			const summary = summarizeGitLabConnection(status);
			return NextResponse.json({
				data: {
					authenticated: summary.state === "connected",
					needsReauth: summary.state === "needs-reconnect",
					connectionState: summary.state,
					tokenExpired: false,
					refreshTokenExpired: false,
					hasRefreshToken: status.hasRefreshToken,
					tokenExpiresAt: status.tokenExpiresAt,
				},
			});
		}

		const hasAccessToken = !!config.encryptedAccessToken;
		const hasRefreshToken = !!config.encryptedRefreshToken;
		const tokenExpired = config.tokenExpiresAt
			? new Date() > config.tokenExpiresAt
			: false;

		return NextResponse.json({
			data: {
				authenticated: hasAccessToken && !config.needsReauth,
				needsReauth: hasAccessToken && config.needsReauth,
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
