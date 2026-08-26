/**
 * Approval Handler
 *
 * Handles approval workflow for high-risk MCP tool operations.
 * Integrates with Fabric's existing orchestrator approval system.
 *
 * Tools with requiresApproval: true annotation will:
 * 1. Create an approval request
 * 2. Return pending status with approvalRequestId
 * 3. Wait for user approval via UI
 * 4. Execute tool on approval or return rejection
 */

import { Redis } from "@upstash/redis";
import type { McpSession } from "../session/types";
import type { ApprovalRequest, ToolAnnotations } from "./types";

const APPROVAL_PREFIX = "mcp:approval:";
const APPROVAL_TTL_SECONDS = 30 * 60; // 30 minutes

export class ApprovalHandler {
	private redis: Redis;

	constructor(redis?: Redis) {
		this.redis = redis ?? Redis.fromEnv();
	}

	private getKey(approvalId: string): string {
		return `${APPROVAL_PREFIX}${approvalId}`;
	}

	private generateApprovalId(): string {
		return `apr_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
	}

	/**
	 * Check if a tool requires approval based on its annotations
	 */
	requiresApproval(annotations?: ToolAnnotations): boolean {
		return annotations?.requiresApproval === true;
	}

	/**
	 * Create an approval request for a tool call
	 */
	async createApprovalRequest(
		session: McpSession,
		toolName: string,
		toolArgs: Record<string, unknown>,
	): Promise<ApprovalRequest> {
		const id = this.generateApprovalId();
		const request: ApprovalRequest = {
			id,
			sessionId: session.sessionId,
			userId: session.userId,
			organizationId: session.organizationId,
			toolName,
			toolArgs,
			status: "pending",
			createdAt: new Date().toISOString(),
			resolvedAt: null,
			resolvedBy: null,
			rejectionReason: null,
		};

		const key = this.getKey(id);
		await this.redis.set(key, JSON.stringify(request), {
			ex: APPROVAL_TTL_SECONDS,
		});

		return request;
	}

	/**
	 * Get an approval request by ID
	 */
	async getApprovalRequest(
		approvalId: string,
	): Promise<ApprovalRequest | null> {
		const key = this.getKey(approvalId);
		const data = await this.redis.get<string>(key);

		if (!data) {
			return null;
		}

		const request = typeof data === "string" ? JSON.parse(data) : data;
		return request as ApprovalRequest;
	}

	/**
	 * Approve an approval request
	 */
	async approve(
		approvalId: string,
		approvedBy: string,
	): Promise<ApprovalRequest | null> {
		const request = await this.getApprovalRequest(approvalId);
		if (!request || request.status !== "pending") {
			return null;
		}

		const updated: ApprovalRequest = {
			...request,
			status: "approved",
			resolvedAt: new Date().toISOString(),
			resolvedBy: approvedBy,
		};

		const key = this.getKey(approvalId);
		await this.redis.set(key, JSON.stringify(updated), {
			ex: APPROVAL_TTL_SECONDS,
		});

		return updated;
	}

	/**
	 * Reject an approval request
	 */
	async reject(
		approvalId: string,
		rejectedBy: string,
		reason?: string,
	): Promise<ApprovalRequest | null> {
		const request = await this.getApprovalRequest(approvalId);
		if (!request || request.status !== "pending") {
			return null;
		}

		const updated: ApprovalRequest = {
			...request,
			status: "rejected",
			resolvedAt: new Date().toISOString(),
			resolvedBy: rejectedBy,
			rejectionReason: reason ?? null,
		};

		const key = this.getKey(approvalId);
		await this.redis.set(key, JSON.stringify(updated), {
			ex: APPROVAL_TTL_SECONDS,
		});

		return updated;
	}

	/**
	 * List pending approvals for a user
	 */
	async listPendingApprovals(userId: string): Promise<ApprovalRequest[]> {
		// Note: This is a simplified implementation
		// In production, you'd want to use Redis SCAN or maintain an index
		const pattern = `${APPROVAL_PREFIX}*`;
		const keys = await this.redis.keys(pattern);

		const approvals: ApprovalRequest[] = [];
		for (const key of keys) {
			const data = await this.redis.get<string>(key);
			if (data) {
				const request =
					typeof data === "string" ? JSON.parse(data) : data;
				if (request.userId === userId && request.status === "pending") {
					approvals.push(request as ApprovalRequest);
				}
			}
		}

		return approvals.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	}

	/**
	 * Delete an approval request
	 */
	async delete(approvalId: string): Promise<boolean> {
		const key = this.getKey(approvalId);
		const result = await this.redis.del(key);
		return result > 0;
	}
}

// Singleton instance
let defaultHandler: ApprovalHandler | null = null;

export function getApprovalHandler(): ApprovalHandler {
	if (!defaultHandler) {
		defaultHandler = new ApprovalHandler();
	}
	return defaultHandler;
}

/**
 * Response for pending approval
 */
export interface PendingApprovalResponse {
	status: "pending_approval";
	approvalId: string;
	toolName: string;
	message: string;
	expiresAt: string;
}

/**
 * Create a pending approval response
 */
export function createPendingApprovalResponse(
	request: ApprovalRequest,
): PendingApprovalResponse {
	return {
		status: "pending_approval",
		approvalId: request.id,
		toolName: request.toolName,
		message: `This operation requires approval. Approval ID: ${request.id}. Please approve in the Fabric UI.`,
		expiresAt: new Date(
			new Date(request.createdAt).getTime() + APPROVAL_TTL_SECONDS * 1000,
		).toISOString(),
	};
}
