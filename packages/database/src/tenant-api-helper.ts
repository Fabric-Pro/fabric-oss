/**
 * Tenant API Helper
 *
 * Provides utilities for wrapping API route handlers with tenant context.
 * Use this for Next.js API routes that don't use ORPC.
 *
 * @example
 * ```ts
 * // In an API route (e.g., app/api/my-route/route.ts)
 * import { withTenantContext } from '@repo/database';
 * import { getSession } from '@saas/auth/lib/server';
 *
 * export async function POST(request: Request) {
 *   return withTenantContext(async () => {
 *     // All database queries are now tenant-isolated!
 *     const configs = await getTenantDb().mCPConfig.findMany();
 *     return Response.json(configs);
 *   });
 * }
 * ```
 */

import {
	createOrganizationContext,
	createPersonalContext,
	runWithTenantContext,
	type TenantContext,
} from "./tenant-context";

/**
 * Session type expected from auth
 */
interface SessionData {
	userId: string;
	activeOrganizationId?: string | null;
}

/**
 * Wrap an async function with tenant context based on session data.
 *
 * @param session - Session containing userId and optionally activeOrganizationId
 * @param callback - Async function to run with tenant context
 * @returns Result of the callback
 *
 * @example
 * ```ts
 * const result = await withTenantContextFromSession(
 *   { userId: 'user-123', activeOrganizationId: 'org-456' },
 *   async () => {
 *     // All getTenantDb() queries are filtered to org-456
 *     return await getTenantDb().agent.findMany();
 *   }
 * );
 * ```
 */
export async function withTenantContextFromSession<T>(
	session: SessionData,
	callback: () => Promise<T>,
): Promise<T> {
	const tenantContext: TenantContext = session.activeOrganizationId
		? createOrganizationContext(
				session.activeOrganizationId,
				session.userId,
			)
		: createPersonalContext(session.userId);

	return runWithTenantContext(tenantContext, callback);
}

/**
 * Create a tenant context from user ID and optional organization ID.
 *
 * @param userId - The user's ID
 * @param organizationId - Optional organization ID (null = personal context)
 * @returns TenantContext for use with runWithTenantContext
 *
 * @example
 * ```ts
 * const context = createTenantContextFromIds('user-123', 'org-456');
 * runWithTenantContext(context, async () => {
 *   // Queries filtered to organization
 * });
 * ```
 */
export function createTenantContextFromIds(
	userId: string,
	organizationId?: string | null,
): TenantContext {
	return organizationId
		? createOrganizationContext(organizationId, userId)
		: createPersonalContext(userId);
}

/**
 * Higher-order function that wraps an API handler with tenant context.
 *
 * This is useful for creating reusable tenant-aware handlers.
 *
 * @example
 * ```ts
 * // Create a tenant-aware handler factory
 * const createTenantHandler = (handler: (session: Session) => Promise<Response>) => {
 *   return async (request: Request) => {
 *     const session = await getSession();
 *     if (!session) {
 *       return new Response('Unauthorized', { status: 401 });
 *     }
 *
 *     return wrapWithTenantContext(
 *       session.session.userId,
 *       session.session.activeOrganizationId,
 *       () => handler(session),
 *     );
 *   };
 * };
 * ```
 */
export async function wrapWithTenantContext<T>(
	userId: string,
	organizationId: string | null | undefined,
	callback: () => Promise<T>,
): Promise<T> {
	const context = createTenantContextFromIds(userId, organizationId);
	return runWithTenantContext(context, callback);
}

/**
 * Type guard to check if context is organization type with valid organizationId.
 */
export function isTenantOrgContext(
	context: TenantContext,
): context is TenantContext & { type: "organization"; organizationId: string } {
	return context.type === "organization" && context.organizationId !== null;
}

/**
 * Type guard to check if context is personal type with valid userId.
 */
export function isTenantPersonalContext(
	context: TenantContext,
): context is TenantContext & { type: "personal"; userId: string } {
	return context.type === "personal" && context.userId !== null;
}
