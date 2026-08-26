import { useContext } from "react";
import { ActiveOrganizationContext } from "../lib/active-organization-context";

/**
 * Low-level hook to access the active organization context.
 *
 * ⚠️ SECURITY WARNING: For API calls, DO NOT use `activeOrganization?.id` directly.
 * This returns `undefined` for personal context, which causes the server to fall back
 * to session data and can leak organizational data to personal pages.
 *
 * ✅ RECOMMENDED: Use `useOrganizationContext()` from `./use-organization-context`
 * which returns `null` for personal context, ensuring proper data isolation.
 *
 * @example
 * // ❌ UNSAFE - can leak org data to personal pages
 * const { activeOrganization } = useActiveOrganization();
 * const orgId = activeOrganization?.id; // Returns undefined, triggers session fallback
 *
 * // ✅ SAFE - proper data isolation
 * import { useOrganizationContext } from './use-organization-context';
 * const { organizationId } = useOrganizationContext(); // Returns null, no session fallback
 *
 * @see useOrganizationContext for the recommended hook for API calls
 */
export const useActiveOrganization = () => {
	const activeOrganizationContext = useContext(ActiveOrganizationContext);

	type ActiveOrganizationContextType = NonNullable<
		typeof activeOrganizationContext
	>;

	if (activeOrganizationContext === undefined) {
		return {
			activeOrganization: null,
			setActiveOrganization: () => Promise.resolve(),
			refetchActiveOrganization: () => Promise.resolve(),
			activeOrganizationUserRole: null,
			isOrganizationAdmin: false,
			loaded: true,
			isSwitching: false,
			switchingToSlug: null,
		} satisfies ActiveOrganizationContextType;
	}

	return activeOrganizationContext;
};
