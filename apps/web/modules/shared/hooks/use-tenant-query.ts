"use client";

/**
 * Tenant-Aware Query Utilities
 *
 * These hooks provide automatic tenant context injection for React Query queries.
 * They ensure proper data isolation between personal and organization contexts
 * without requiring manual passing of organizationId in every component.
 *
 * USAGE:
 * Instead of manually passing organizationId to every query:
 * ```ts
 * // Before (error-prone)
 * const { organizationId } = useOrganizationContext();
 * useQuery({
 *   queryKey: ["data", organizationId],
 *   queryFn: () => api.getData({ organizationId }),
 * });
 * ```
 *
 * Use the tenant-aware utilities:
 * ```ts
 * // After (automatic isolation)
 * const { organizationId, queryKeyPrefix } = useTenantContext();
 * useQuery({
 *   queryKey: [...queryKeyPrefix, "data"],
 *   queryFn: () => api.getData({ organizationId }),
 * });
 * ```
 *
 * Or use the helper hook:
 * ```ts
 * const { data } = useTenantQuery({
 *   baseKey: ["data"],
 *   queryFn: (orgId) => api.getData({ organizationId: orgId }),
 * });
 * ```
 */

import { useOrganizationId } from "@saas/organizations/hooks/use-organization-context";
import {
	type QueryKey,
	type UseQueryOptions,
	useQuery,
} from "@tanstack/react-query";

/**
 * Get tenant context for queries.
 *
 * Returns the current organization ID and a query key prefix that includes
 * the tenant context for proper cache isolation.
 *
 * @example
 * const { organizationId, queryKeyPrefix } = useTenantContext();
 *
 * useQuery({
 *   queryKey: [...queryKeyPrefix, "models", "available"],
 *   queryFn: () => api.listModels({ organizationId }),
 * });
 */
export function useTenantContext() {
	const organizationId = useOrganizationId();

	return {
		/** Current organization ID (null for personal context) */
		organizationId,
		/** Whether we're in organization context */
		isOrgContext: organizationId !== null,
		/** Query key prefix that includes tenant context */
		queryKeyPrefix: ["tenant", organizationId] as const,
	};
}

/**
 * Options for useTenantQuery
 */
export interface UseTenantQueryOptions<TData, TError = Error>
	extends Omit<UseQueryOptions<TData, TError>, "queryKey" | "queryFn"> {
	/** Base query key (tenant context will be prepended automatically) */
	baseKey: QueryKey;
	/**
	 * Query function that receives the organization ID.
	 * The organizationId will be null for personal context, string for org context.
	 */
	queryFn: (organizationId: string | null) => Promise<TData>;
	/**
	 * Override organization context.
	 * - undefined: Auto-detect from context (default)
	 * - null: Force personal context
	 * - string: Force specific organization
	 */
	organizationId?: string | null;
}

/**
 * Tenant-aware query hook that automatically injects organization context.
 *
 * This hook wraps useQuery and:
 * 1. Automatically injects organizationId into the query function
 * 2. Prefixes the query key with tenant context for cache isolation
 * 3. Allows explicit override of organization context when needed
 *
 * @example
 * // Auto-inject from context
 * const { data } = useTenantQuery({
 *   baseKey: ["models", "available"],
 *   queryFn: (orgId) => api.listModels({ organizationId: orgId }),
 * });
 *
 * // Force personal context
 * const { data } = useTenantQuery({
 *   baseKey: ["models", "available"],
 *   queryFn: (orgId) => api.listModels({ organizationId: orgId }),
 *   organizationId: null,
 * });
 */
export function useTenantQuery<TData, TError = Error>({
	baseKey,
	queryFn,
	organizationId: explicitOrgId,
	...options
}: UseTenantQueryOptions<TData, TError>) {
	const contextOrgId = useOrganizationId();

	// Use explicit organizationId if provided, otherwise use context
	const organizationId =
		explicitOrgId !== undefined ? explicitOrgId : contextOrgId;

	return useQuery<TData, TError>({
		queryKey: ["tenant", organizationId, ...baseKey],
		queryFn: () => queryFn(organizationId),
		...options,
	});
}

/**
 * Create a tenant-scoped query key.
 *
 * Use this when you need to create query keys for invalidation or prefetching.
 *
 * @example
 * const queryClient = useQueryClient();
 * const { organizationId } = useTenantContext();
 *
 * // Invalidate all tenant-scoped queries
 * queryClient.invalidateQueries({
 *   queryKey: createTenantQueryKey(organizationId, ["models"]),
 * });
 */
export function createTenantQueryKey(
	organizationId: string | null,
	baseKey: QueryKey,
): QueryKey {
	return ["tenant", organizationId, ...baseKey];
}
