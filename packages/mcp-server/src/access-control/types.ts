/**
 * Access Control Types
 *
 * Type definitions for resource access control and approval workflows.
 */

import type { McpSession } from "../session/types";

export type AccessMode = "personal" | "organization";

export interface AccessContext {
	session: McpSession;
	mode: AccessMode;
}

export interface ResourceFilter {
	userId: string;
	organizationId: string | null;
}

export interface ApprovalRequest {
	id: string;
	sessionId: string;
	userId: string;
	organizationId: string | null;
	toolName: string;
	toolArgs: Record<string, unknown>;
	status: "pending" | "approved" | "rejected";
	createdAt: string;
	resolvedAt: string | null;
	resolvedBy: string | null;
	rejectionReason: string | null;
}

export interface ToolAnnotations {
	readOnlyHint?: boolean;
	destructiveHint?: boolean;
	requiresApproval?: boolean;
	idempotentHint?: boolean;
	openWorldHint?: boolean;
}
