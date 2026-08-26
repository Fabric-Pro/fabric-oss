import { useBasePath } from "@saas/organizations/hooks";
import { joinRelativeURL } from "ufo";

/**
 * Build a path into the admin area.
 *
 * The admin area is reachable from two coexisting route trees so a system
 * admin can stay in their current workspace while using it:
 *   - personal:      `/app/admin/...`
 *   - organization:  `/app/{slug}/admin/...`
 *
 * The active workspace is derived purely from the URL slug, so admin links
 * must keep whatever base the user is currently under — otherwise navigating
 * within the admin area would silently flip the workspace selector to
 * "Personal" (the bug this fixes).
 *
 * @param path - The sub-path within the admin area (e.g. `/organizations/123`).
 * @param basePath - The workspace base (`/app` or `/app/{slug}`). Defaults to
 *   `/app` so existing callers and Server Components that only ever target the
 *   personal admin tree keep their behavior. Client Components should pass
 *   `useBasePath()` (via {@link useAdminPath}) to stay workspace-aware.
 */
export function getAdminPath(path: string, basePath = "/app") {
	return joinRelativeURL(basePath, "admin", path);
}

/**
 * Workspace-aware variant of {@link getAdminPath} for Client Components.
 *
 * Returns a builder bound to the current workspace base path, so links it
 * produces keep the org slug when the admin area is viewed under
 * `/app/{slug}/admin/...` and stay slug-less under `/app/admin/...`.
 *
 * @example
 * const adminPath = useAdminPath();
 * <Link href={adminPath("/organizations/new")}>New</Link>
 */
export function useAdminPath() {
	const basePath = useBasePath();
	return (path: string) => getAdminPath(path, basePath);
}
