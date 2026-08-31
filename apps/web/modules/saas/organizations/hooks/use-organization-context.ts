import { useOrganizationListQuery } from "@saas/organizations/lib/api";
import { useSeededGuestFlag } from "@saas/organizations/lib/organization-guest-context";
import { useMemo } from "react";
import { useActiveOrganization } from "./use-active-organization";

/**
 * Organization Context Utilities
 *
 * These hooks provide safe access to organization context values.
 * They return `null` for personal context (not `undefined`) to ensure
 * the server-side `resolveOrganizationId` function doesn't fall back
 * to stale session data.
 *
 * SECURITY: Always use these hooks instead of `activeOrganization?.id`
 * to prevent data leakage between personal and organization contexts.
 *
 * @example
 * // Before (UNSAFE - can leak org data to personal pages)
 * const { activeOrganization } = useActiveOrganization();
 * const orgId = activeOrganization?.id; // Returns undefined, triggers session fallback
 *
 * // After (SAFE)
 * const organizationId = useOrganizationId(); // Returns null, no session fallback
 */

/**
 * Get the current organization ID for API calls.
 *
 * Returns:
 * - `string` when in organization context
 * - `null` when in personal context (explicitly signals personal context to API)
 *
 * @example
 * const organizationId = useOrganizationId();
 *
 * // Use in queries
 * const { data } = useQuery(
 *   orpc.projects.list.queryOptions({
 *     input: { organizationId, limit: 50 }
 *   })
 * );
 */
export function useOrganizationId(): string | null {
	const { activeOrganization } = useActiveOrganization();
	return activeOrganization?.id ?? null;
}

/**
 * Resolve the effective organization ID for API calls.
 *
 * This hook handles the common pattern where a component can:
 * 1. Receive an explicit organizationId prop (string or null)
 * 2. Fall back to the current organization context when prop is undefined
 *
 * Use this in components that accept an optional organizationId prop
 * to ensure proper tenant isolation without repetitive boilerplate.
 *
 * @param propOrganizationId - The organizationId prop passed to the component
 *   - `string`: Use this organization (explicit org context)
 *   - `null`: Use personal context (explicit personal context)
 *   - `undefined`: Fall back to current organization context from useOrganizationId()
 *
 * @returns The effective organization ID to use for API calls (string | null)
 *
 * @example
 * interface MyComponentProps {
 *   organizationId?: string | null;
 * }
 *
 * function MyComponent({ organizationId: propOrgId }: MyComponentProps) {
 *   const organizationId = useEffectiveOrganizationId(propOrgId);
 *
 *   // Use organizationId in API calls - it's always string | null, never undefined
 *   const { data } = useQuery(
 *     orpc.projects.list.queryOptions({ input: { organizationId } })
 *   );
 * }
 */
export function useEffectiveOrganizationId(
	propOrganizationId: string | null | undefined,
): string | null {
	const contextOrganizationId = useOrganizationId();
	// If prop is explicitly provided (including null), use it; otherwise fall back to context
	return propOrganizationId !== undefined
		? propOrganizationId
		: contextOrganizationId;
}

/**
 * Get the current organization slug for URL building.
 *
 * Returns:
 * - `string` when in organization context
 * - `null` when in personal context
 *
 * @example
 * const organizationSlug = useOrganizationSlug();
 * const basePath = organizationSlug
 *   ? `/app/${organizationSlug}/projects`
 *   : '/app/projects';
 */
export function useOrganizationSlug(): string | null {
	const { activeOrganization } = useActiveOrganization();
	return activeOrganization?.slug ?? null;
}

/**
 * Get the base path for the current context.
 *
 * Returns:
 * - `/app/{slug}` when in organization context
 * - `/app` when in personal context
 *
 * @example
 * const basePath = useBasePath();
 * router.push(`${basePath}/projects/new`);
 */
export function useBasePath(): string {
	const slug = useOrganizationSlug();
	return slug ? `/app/${slug}` : "/app";
}

/**
 * The organization to root ACCOUNT-level chrome in — a profile, account
 * security, notification preferences, and the switcher label naming where the
 * person is.
 *
 * Not the same question as `useBasePath`, and the difference only shows for a
 * project-only guest. Their chrome is rendered under the host organization's
 * slug, so a URL-derived path sends them to the host's settings, and the
 * organization settings layout bounces a guest straight back out. Observed, not
 * inferred: the link rendered, and following it returned the guest to the
 * project they came from.
 *
 * So this resolves to an organization the caller actually belongs to. The URL's
 * organization when it is one of theirs — the ordinary case, and it keeps the
 * chrome consistent with what they are looking at — and otherwise their own.
 *
 * Returns null while the membership list is loading or when they belong
 * nowhere; each caller decides what to render meanwhile.
 */
export function useAccountOrganization() {
	const slug = useOrganizationSlug();
	const { data: organizations } = useOrganizationListQuery();

	if (!organizations?.length) {
		return null;
	}
	const own = organizations.find(
		(organization) => organization.slug === slug,
	);
	return own ?? organizations[0];
}

/**
 * `useAccountOrganization` as a path.
 *
 * Falls back to `/app` while the list is loading or when they belong nowhere.
 * That path is a redirect which resolves the same question server-side, so the
 * fallback is a slower answer rather than a wrong one.
 */
export function useAccountBasePath(): string {
	const own = useAccountOrganization();
	return own ? `/app/${own.slug}` : "/app";
}

/** Build a path for a page that belongs to the account, not the workspace. */
export function useAccountPath(path: string): string {
	const basePath = useAccountBasePath();
	const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
	return `${basePath}/${normalizedPath}`;
}

/**
 * Build a path for the current organization context.
 *
 * @param path - The path segment to append (e.g., 'projects', 'settings/ai-providers')
 * @returns Full path with organization prefix if in org context
 *
 * @example
 * const projectsPath = useContextPath('projects');
 * // Returns '/app/my-org/projects' or '/app/projects'
 *
 * const settingsPath = useContextPath('settings/ai-providers');
 * // Returns '/app/my-org/settings/ai-providers' or '/app/settings/ai-providers'
 */
export function useContextPath(path: string): string {
	const basePath = useBasePath();
	const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
	return `${basePath}/${normalizedPath}`;
}

/**
 * Get organization context with computed values for common patterns.
 *
 * This hook provides all commonly needed organization context values
 * in a single call, reducing boilerplate.
 *
 * @example
 * const {
 *   organizationId,    // string | null - for API calls
 *   organizationSlug,  // string | null - for URL building
 *   basePath,          // string - '/app' or '/app/{slug}'
 *   isOrgContext,      // boolean - true if in org context
 * } = useOrganizationContext();
 *
 * IMPORTANT: When making API calls that accept organizationId:
 *
 * For PERSONAL settings pages (e.g., /app/settings/ai):
 *   Pass `organizationId: null` explicitly to prevent session fallback
 *   ```ts
 *   await orpcClient.aiConfig.providers.upsert({
 *     ...data,
 *     organizationId: null, // Explicit null for personal context
 *   });
 *   ```
 *
 * For ORG settings pages (e.g., /app/{slug}/settings/ai):
 *   Pass the organizationId from context and guard with isOrgContext
 *   ```ts
 *   if (!isOrgContext) return null;
 *   await orpcClient.aiConfig.providers.upsert({
 *     ...data,
 *     organizationId: organizationId!, // org context verified above
 *   });
 *   ```
 */
export function useOrganizationContext() {
	const {
		activeOrganization,
		loaded,
		isOrganizationAdmin,
		activeOrganizationUserRole,
	} = useActiveOrganization();
	// Server-seeded by the org layout's `OrganizationGuestProvider`.
	// `undefined` (no provider — personal context or non-org trees)
	// defaults to false: a personal workspace has no host org to be a
	// guest of. Prefer `useIsGuestInOrg()` for consumer code — it adds a
	// client-side fallback for trees without a seeded provider.
	const seededIsGuest = useSeededGuestFlag();

	return useMemo(
		() => ({
			// Core values
			organizationId: activeOrganization?.id ?? null,
			organizationSlug: activeOrganization?.slug ?? null,
			organizationName: activeOrganization?.name ?? null,

			// Computed values
			basePath: activeOrganization?.slug
				? `/app/${activeOrganization.slug}`
				: "/app",
			isOrgContext: !!activeOrganization,
			isPersonalContext: !activeOrganization,

			// Guest state (server-seeded; false when not seeded)
			isGuest: seededIsGuest ?? false,

			// Role information
			isOrganizationAdmin,
			userRole: activeOrganizationUserRole,

			// Loading state
			loaded,

			// Full organization object (for cases where you need more)
			organization: activeOrganization,
		}),
		[
			activeOrganization,
			loaded,
			isOrganizationAdmin,
			activeOrganizationUserRole,
			seededIsGuest,
		],
	);
}
