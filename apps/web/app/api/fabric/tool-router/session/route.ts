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
import { NextResponse } from "next/server";

export const runtime = "nodejs";

// In-memory session store (use Redis in production)
const sessions = new Map<
	string,
	{
		userId: string;
		organizationId: string | null;
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

		// Try API key authentication first (for external apps)
		const apiKey =
			req.headers.get("x-api-key") ||
			req.headers.get("authorization")?.replace("Bearer ", "");

		if (apiKey) {
			const apiKeyResult = await verifyUserApiKey(apiKey);
			if (!apiKeyResult.valid || !apiKeyResult.userId) {
				return NextResponse.json(
					{ error: "Invalid API key" },
					{ status: 401 },
				);
			}
			userId = apiKeyResult.userId;
			// Parse organizationId from body if provided
			const body = await req.json().catch(() => ({}));
			organizationId = body.organizationId ?? null;
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
			const body = await req.json().catch(() => ({}));
			organizationId =
				body.organizationId ??
				session.session?.activeOrganizationId ??
				null;
		}

		// Create session token
		const sessionId =
			crypto.randomUUID().replace(/-/g, "") +
			crypto.randomUUID().replace(/-/g, "").slice(0, 16);
		const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

		sessions.set(sessionId, {
			userId,
			organizationId,
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

export function validateSession(
	sessionId: string,
): { userId: string; organizationId: string | null } | null {
	const session = sessions.get(sessionId);
	if (!session) {
		return null;
	}
	if (session.expiresAt < new Date()) {
		sessions.delete(sessionId);
		return null;
	}
	return { userId: session.userId, organizationId: session.organizationId };
}
