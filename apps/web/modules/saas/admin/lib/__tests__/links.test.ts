import { describe, expect, it } from "vitest";
import { getAdminPath } from "../links";

/**
 * Locks the workspace-aware admin path builder. The admin area is reachable
 * from two coexisting route trees so a system admin can stay in their current
 * workspace while using it:
 *   - personal:      `/app/admin/...`
 *   - organization:  `/app/{slug}/admin/...`
 *
 * The active workspace is derived purely from the URL slug, so drift here
 * (e.g. dropping the org base) would silently flip the workspace selector to
 * "Personal" — the bug this feature fixes. `useAdminPath()` (the Client
 * Component wrapper, not exercised here because it needs the org-context hook)
 * simply binds this helper to `useBasePath()`.
 */
describe("getAdminPath", () => {
	it("defaults to the personal admin tree when no base path is given", () => {
		expect(getAdminPath("/organizations")).toBe("/app/admin/organizations");
	});

	it("keeps the org slug when given an organization base path", () => {
		expect(getAdminPath("/organizations", "/app/acme")).toBe(
			"/app/acme/admin/organizations",
		);
	});

	it("composes nested sub-paths under the org-scoped admin base", () => {
		expect(getAdminPath("/organizations/org-123", "/app/acme")).toBe(
			"/app/acme/admin/organizations/org-123",
		);
	});

	it("builds the bare admin base when the sub-path is empty", () => {
		expect(getAdminPath("", "/app/acme")).toBe("/app/acme/admin");
		expect(getAdminPath("")).toBe("/app/admin");
	});

	it("normalizes a sub-path passed without a leading slash", () => {
		// `joinRelativeURL` tolerates either form — the call sites use a
		// leading slash, but this guards the helper against drift.
		expect(getAdminPath("agents", "/app/acme")).toBe(
			"/app/acme/admin/agents",
		);
	});

	it("explicitly passing the personal base matches the default", () => {
		expect(getAdminPath("/users", "/app")).toBe("/app/admin/users");
		expect(getAdminPath("/users", "/app")).toBe(getAdminPath("/users"));
	});
});
