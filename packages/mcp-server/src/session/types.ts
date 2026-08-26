/**
 * MCP Session Types
 *
 * Type definitions for MCP session management.
 */

export interface McpSession {
	/** Unique session identifier */
	sessionId: string;
	/** User ID from authentication */
	userId: string;
	/** Active organization ID (null for personal account) */
	organizationId: string | null;
	/** User's display name */
	userName: string;
	/** User's email */
	email: string;
	/** User's role */
	role: "user" | "admin";
	/** Session creation timestamp */
	createdAt: string;
	/** Session expiration timestamp */
	expiresAt: string;
	/** Last activity timestamp */
	lastActivityAt: string;
	/** Protocol version negotiated */
	protocolVersion: string;
}

export interface SessionCreateInput {
	userId: string;
	organizationId?: string | null;
	userName: string;
	email: string;
	role: "user" | "admin";
	protocolVersion?: string;
}

export interface SessionStore {
	create(input: SessionCreateInput): Promise<McpSession>;
	get(sessionId: string): Promise<McpSession | null>;
	update(
		sessionId: string,
		updates: Partial<McpSession>,
	): Promise<McpSession | null>;
	delete(sessionId: string): Promise<boolean>;
	touch(sessionId: string): Promise<void>;
}
