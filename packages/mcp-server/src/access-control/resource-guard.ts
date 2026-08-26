/**
 * Resource Guard
 *
 * Implements access control for MCP resources based on user/organization context.
 *
 * Access Modes:
 * 1. PERSONAL (no orgId in session):
 *    Filter: userId = session.userId AND organizationId IS NULL
 *    Returns only user's personal resources
 *
 * 2. ORGANIZATIONAL (orgId in session):
 *    Filter: userId = session.userId AND organizationId = session.organizationId
 *    Returns only resources owned by user within that org
 */

import type { McpSession } from "../session/types";
import type { AccessContext, AccessMode, ResourceFilter } from "./types";

export class ResourceGuard {
	private session: McpSession;

	constructor(session: McpSession) {
		this.session = session;
	}

	/**
	 * Get the current access mode
	 */
	getAccessMode(): AccessMode {
		return this.session.organizationId ? "organization" : "personal";
	}

	/**
	 * Get the access context for the current session
	 */
	getAccessContext(): AccessContext {
		return {
			session: this.session,
			mode: this.getAccessMode(),
		};
	}

	/**
	 * Get the resource filter for database queries
	 * This filter ensures proper tenant isolation
	 */
	getResourceFilter(): ResourceFilter {
		return {
			userId: this.session.userId,
			organizationId: this.session.organizationId,
		};
	}

	/**
	 * Build a Prisma-compatible where clause for resource queries
	 */
	buildWhereClause(): { userId: string; organizationId: string | null } {
		if (this.session.organizationId) {
			// Organizational mode: filter by both user and org
			return {
				userId: this.session.userId,
				organizationId: this.session.organizationId,
			};
		}
		// Personal mode: filter by user, org must be null
		return {
			userId: this.session.userId,
			organizationId: null,
		};
	}

	/**
	 * Check if the user can access a specific resource
	 * @param resourceUserId The userId of the resource owner
	 * @param resourceOrgId The organizationId of the resource
	 */
	canAccess(resourceUserId: string, resourceOrgId: string | null): boolean {
		// User must match
		if (resourceUserId !== this.session.userId) {
			return false;
		}

		// Organization context must match
		if (this.session.organizationId) {
			// In org mode: resource must belong to same org
			return resourceOrgId === this.session.organizationId;
		}
		// In personal mode: resource must be personal (no org)
		return resourceOrgId === null;
	}

	/**
	 * Validate access and throw if denied
	 */
	assertAccess(resourceUserId: string, resourceOrgId: string | null): void {
		if (!this.canAccess(resourceUserId, resourceOrgId)) {
			throw new ResourceAccessDeniedError(
				this.session.userId,
				this.session.organizationId,
				resourceUserId,
				resourceOrgId,
			);
		}
	}
}

/**
 * Error thrown when resource access is denied
 */
export class ResourceAccessDeniedError extends Error {
	code = -32002;
	sessionUserId: string;
	sessionOrgId: string | null;
	resourceUserId: string;
	resourceOrgId: string | null;

	constructor(
		sessionUserId: string,
		sessionOrgId: string | null,
		resourceUserId: string,
		resourceOrgId: string | null,
	) {
		const mode = sessionOrgId ? "organization" : "personal";
		super(
			`Access denied: Resource belongs to different ${mode === "organization" ? "organization context" : "user/account"}`,
		);
		this.name = "ResourceAccessDeniedError";
		this.sessionUserId = sessionUserId;
		this.sessionOrgId = sessionOrgId;
		this.resourceUserId = resourceUserId;
		this.resourceOrgId = resourceOrgId;
	}
}

/**
 * Create a resource guard for a session
 */
export function createResourceGuard(session: McpSession): ResourceGuard {
	return new ResourceGuard(session);
}
