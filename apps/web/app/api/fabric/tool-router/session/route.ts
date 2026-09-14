/**
 * Fabric Tool Router - Session Creation
 *
 * Creates an MCP session for a user, similar to Composio's Tool Router.
 * Returns an MCP URL and headers that can be used with any MCP client.
 *
 * Usage:
 *   const response = await fetch('/api/fabric/tool-router/session', {
 *     method: 'POST',
 *     headers: { 'Content-Type': 'application/json' },
 *     body: JSON.stringify({ organizationId: 'org_123' }) // optional
 *   });
 *   const { mcp } = await response.json();
 *   // mcp.url = MCP endpoint URL
 *   // mcp.headers = Headers to include in MCP requests
 */

import { verifyUserApiKey } from "@repo/api/modules/users/procedures/api-keys";
import { auth } from "@repo/auth";
import { isOrganizationMember } from "@repo/database";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

// In-memory session store (use Redis in production)
/**
 * The scope a key must hold to mint a tool-router session at all, and the one
 * `tools/call` additionally requires.
 *
 * The router reaches an organization's stored integration credentials, so it
 * is MCP surface and uses the MCP scope pair. Minting is the read half;
 * executing a tool is the write half, checked in the MCP route rather than
 * here, because a single session legitimately serves both.
 */
export const TOOL_ROUTER_MINT_SCOPE = "mcp:read";
export const TOOL_ROUTER_CALL_SCOPE = "mcp:write";

const sessions = new Map<
	string,
	{
		userId: string;
		organizationId: string | null;
		/**
		 * Scopes of the API key that minted this session, or `null` when a
		 * signed-in browser session minted it and no key limits apply.
		 *
		 * Stored rather than re-read per request because here the session id
		 * IS the credential presented later — unlike `/mcp`, where the key
		 * itself accompanies every request and its scopes are re-read from it.
		 */
		scopes: string[] | null;
		createdAt: Date;
		expiresAt: Date;
	}
>();

// Clean up expired sessions periodically
setInterval(() => {
	const now = new Date();
	for (const [id, session] of sessions) {
		if (session.expiresAt < now) {
			sessions.delete(id);
		}
	}
}, 60000); // Every minute

export async function POST(req: Request) {
	try {
		let userId: string;
		let organizationId: string | null = null;
		let scopes: string[] | null = null;

		// Try API key authentication first (for external apps)
		const apiKey =
			req.headers.get("x-api-key") ||
			req.headers.get("authorization")?.replace("Bearer ", "");

		// Read the body once. Both branches want the same field out of it, and
		// a Request body can only be consumed the one time.
		const body = (await req.json().catch(() => ({}))) as {
			organizationId?: unknown;
		};
		const namedOrganizationId =
			typeof body.organizationId === "string" && body.organizationId
				? body.organizationId
				: null;

		if (apiKey) {
			// With a required scope. Called bare, `verifyUserApiKey` skips its
			// scope check entirely, so any valid key — whatever it was issued
			// to do — could mint a session that reaches every tool here.
			const apiKeyResult = await verifyUserApiKey(
				apiKey,
				TOOL_ROUTER_MINT_SCOPE,
			);
			if (!apiKeyResult.valid || !apiKeyResult.userId) {
				return NextResponse.json(
					{ error: apiKeyResult.error || "Invalid API key" },
					{ status: 401 },
				);
			}
			userId = apiKeyResult.userId;
			scopes = apiKeyResult.scopes ?? [];
			organizationId = namedOrganizationId;
		} else {
			// Fall back to session authentication
			const session = await auth.api.getSession({ headers: req.headers });
			if (!session?.user?.id) {
				return NextResponse.json(
					{ error: "Unauthorized" },
					{ status: 401 },
				);
			}
			userId = session.user.id;
			organizationId =
				namedOrganizationId ??
				session.session?.activeOrganizationId ??
				null;
		}

		// The organization arrived in the request body, and the session it is
		// stamped into is what later selects an organization's stored
		// integration credentials — `fetchCredentialsByProvider` matches on
		// `organizationId` alone, with no membership predicate of its own. So
		// without this check, naming someone else's organization was enough to
		// reach their GitHub, Slack and Drive tokens.
		//
		// Checked for the cookie branch too: `activeOrganizationId` is a stored
		// field that outlives the membership it points at.
		if (
			organizationId &&
			!(await isOrganizationMember(userId, organizationId))
		) {
			return NextResponse.json(
				{
					error: `Access denied: you are not a member of organization ${organizationId}`,
				},
				{ status: 403 },
			);
		}

		// Create session token
		const sessionId =
			crypto.randomUUID().replace(/-/g, "") +
			crypto.randomUUID().replace(/-/g, "").slice(0, 16);
		const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

		sessions.set(sessionId, {
			userId,
			organizationId,
			scopes,
			createdAt: new Date(),
			expiresAt,
		});

		// Build MCP URL
		const baseUrl =
			process.env.NEXT_PUBLIC_SITE_URL ||
			process.env.NEXT_PUBLIC_APP_URL ||
			"http://localhost:3001";
		const mcpUrl = `${baseUrl}/api/fabric/tool-router/mcp`;

		return NextResponse.json({
			mcp: {
				url: mcpUrl,
				headers: {
					"x-fabric-session": sessionId,
				},
			},
			sessionId,
			expiresAt: expiresAt.toISOString(),
		});
	} catch (error) {
		console.error("[ToolRouter] Session creation error:", error);
		return NextResponse.json(
			{ error: "Failed to create session" },
			{ status: 500 },
		);
	}
}

// Export session store for MCP endpoint to use
export function getSession(sessionId: string) {
	return sessions.get(sessionId);
}

export function validateSession(sessionId: string): {
	userId: string;
	organizationId: string | null;
	scopes: string[] | null;
} | null {
	const session = sessions.get(sessionId);
	if (!session) {
		return null;
	}
	if (session.expiresAt < new Date()) {
		sessions.delete(sessionId);
		return null;
	}
	return {
		userId: session.userId,
		organizationId: session.organizationId,
		scopes: session.scopes,
	};
}

/**
 * True when a session minted by `scopes` may execute a tool.
 *
 * `null` is a browser session, which carries no key scopes and is limited by
 * the user's own role instead. A wildcard key predates the organization
 * vocabulary dropping `"*"`; personal keys still carry it, so it is honoured
 * here exactly as `hasScope` honours it elsewhere.
 */
export function sessionMayCallTools(scopes: string[] | null): boolean {
	if (scopes === null) {
		return true;
	}
	return scopes.includes(TOOL_ROUTER_CALL_SCOPE) || scopes.includes("*");
}
