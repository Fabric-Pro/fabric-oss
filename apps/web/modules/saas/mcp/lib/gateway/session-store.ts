/**
 * Fabric MCP Gateway - Session Store
 *
 * In-memory session management for MCP gateway connections.
 * Sessions are scoped per-process and cleaned up on expiration.
 *
 * Note: MCPClientSession in Prisma has a FK to MCPConfig, which gateway
 * sessions don't have. We use an in-memory store instead. For production
 * multi-instance deployments, this should be backed by Redis.
 */

import type { GatewaySession } from "./types";

/** Session TTL: 24 hours */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** In-memory session store */
const sessions = new Map<string, GatewaySession>();

/** Clean up expired sessions every 5 minutes */
if (typeof setInterval !== "undefined") {
	setInterval(
		() => {
			const now = Date.now();
			for (const [id, session] of sessions) {
				if (session.expiresAt.getTime() < now) {
					sessions.delete(id);
				}
			}
		},
		5 * 60 * 1000,
	);
}

/**
 * Create a new gateway session.
 */
export async function createGatewaySession(params: {
	userId: string;
	organizationId: string | null;
	userName: string;
	email: string;
	role: "user" | "admin";
}): Promise<GatewaySession> {
	const sessionId = generateSessionToken();
	const now = new Date();
	const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);

	const session: GatewaySession = {
		sessionId,
		userId: params.userId,
		organizationId: params.organizationId,
		userName: params.userName,
		email: params.email,
		role: params.role,
		createdAt: now,
		expiresAt,
	};

	sessions.set(sessionId, session);
	return session;
}

/**
 * Get a session without user validation (for internal use).
 */
export function getGatewaySession(token: string): GatewaySession | null {
	const session = sessions.get(token);
	if (!session) {
		return null;
	}

	if (session.expiresAt.getTime() <= Date.now()) {
		sessions.delete(token);
		return null;
	}

	return session;
}

/**
 * Update the organization context for a session.
 * Called when fabric_switch_organization is executed.
 */
export function updateSessionOrganization(
	sessionId: string,
	organizationId: string | null,
): void {
	const session = sessions.get(sessionId);
	if (session) {
		session.organizationId = organizationId;
	}
}

/**
 * Delete a session.
 */
export function deleteGatewaySession(sessionId: string): void {
	sessions.delete(sessionId);
}

/**
 * Generate a cryptographically secure session token.
 */
function generateSessionToken(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
