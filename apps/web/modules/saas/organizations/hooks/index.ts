/**
 * Organization Hooks
 *
 * This module exports hooks for working with organization context.
 *
 * TENANT ISOLATION BEST PRACTICES:
 *
 * 1. For hooks that fetch data, use useOrganizationId() internally:
 *    ```ts
 *    export function useMyData() {
 *      const organizationId = useOrganizationId(); // Auto-inject!
 *      return useQuery({
 *        queryKey: ["myData", organizationId],
 *        queryFn: () => api.getData({ organizationId }),
 *      });
 *    }
 *    ```
 *
 * 2. For components that call multiple APIs, use useOrganizationContext():
 *    ```ts
 *    const { organizationId, isOrgContext } = useOrganizationContext();
 *    ```
 *
 * 3. For reusable components that need explicit context, accept optional prop:
 *    ```ts
 *    function MyComponent({ organizationId: propOrgId }: Props) {
 *      const contextOrgId = useOrganizationId();
 *      const organizationId = propOrgId !== undefined ? propOrgId : contextOrgId;
 *    }
 *    ```
 *
 * See also: @shared/hooks/use-tenant-query for tenant-aware query utilities
 */

// Low-level hook - use with caution, see JSDoc for warnings
export { useActiveOrganization } from "./use-active-organization";
// Primary hook for organization context - RECOMMENDED for API calls
export {
	useBasePath,
	useContextPath,
	useEffectiveOrganizationId,
	useOrganizationContext,
	useOrganizationId,
	useOrganizationSlug,
} from "./use-organization-context";
