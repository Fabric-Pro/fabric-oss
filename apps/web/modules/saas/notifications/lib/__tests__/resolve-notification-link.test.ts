import { describe, expect, it } from "vitest";
import { resolveNotificationLink } from "../resolve-notification-link";

/**
 * Locks notification-link resolution. Two bases are in play:
 *   - `notificationBasePath` — the notification's OWN org workspace; context-
 *     relative links resolve against it so the destination is fixed by the
 *     notification, not the workspace the user is currently in (#1528).
 *   - `currentBasePath` — the workspace the user is viewing now; slug-less
 *     `/app/admin/…` links re-base onto it so a system admin stays in their org.
 */
describe("resolveNotificationLink", () => {
	it("returns an empty string when there is no link", () => {
		expect(
			resolveNotificationLink("", {
				notificationBasePath: "/app",
				currentBasePath: "/app",
			}),
		).toBe("");
		expect(
			resolveNotificationLink(null, {
				notificationBasePath: "/app/acme",
				currentBasePath: "/app/acme",
			}),
		).toBe("");
		expect(
			resolveNotificationLink(undefined, {
				notificationBasePath: "/app/acme",
				currentBasePath: "/app/acme",
			}),
		).toBe("");
	});

	it("prepends the notification's own base to context-relative links", () => {
		expect(
			resolveNotificationLink("projects/p1/stories/s1", {
				notificationBasePath: "/app",
				currentBasePath: "/app",
			}),
		).toBe("/app/projects/p1/stories/s1");
		expect(
			resolveNotificationLink("projects/p1/stories/s1", {
				notificationBasePath: "/app/acme",
				currentBasePath: "/app/acme",
			}),
		).toBe("/app/acme/projects/p1/stories/s1");
	});

	// THE #1528 REGRESSION: a relative link resolves against the notification's
	// OWN org even when the user is currently viewing a different workspace.
	it("uses the notification's org, not the current workspace, for relative links", () => {
		expect(
			resolveNotificationLink("projects/p1/stories/s1", {
				notificationBasePath: "/app/team-alpha",
				currentBasePath: "/app/team-beta",
			}),
		).toBe("/app/team-alpha/projects/p1/stories/s1");
	});

	it("re-bases an absolute admin link onto the CURRENT workspace", () => {
		expect(
			resolveNotificationLink("/app/admin/monitoring", {
				notificationBasePath: "/app/anything",
				currentBasePath: "/app/acme",
			}),
		).toBe("/app/acme/admin/monitoring");
	});

	it("preserves the query string when re-basing an admin link", () => {
		expect(
			resolveNotificationLink("/app/admin/monitoring?week=2026-W22", {
				notificationBasePath: "/app/anything",
				currentBasePath: "/app/acme",
			}),
		).toBe("/app/acme/admin/monitoring?week=2026-W22");
		expect(
			resolveNotificationLink("/app/admin/monitoring?incident=abc123", {
				notificationBasePath: "/app/anything",
				currentBasePath: "/app/acme",
			}),
		).toBe("/app/acme/admin/monitoring?incident=abc123");
	});

	it("re-bases the bare /app/admin link", () => {
		expect(
			resolveNotificationLink("/app/admin", {
				notificationBasePath: "/app/anything",
				currentBasePath: "/app/acme",
			}),
		).toBe("/app/acme/admin");
	});

	it("leaves admin links untouched in the personal workspace", () => {
		expect(
			resolveNotificationLink("/app/admin/monitoring?week=x", {
				notificationBasePath: "/app",
				currentBasePath: "/app",
			}),
		).toBe("/app/admin/monitoring?week=x");
		expect(
			resolveNotificationLink("/app/admin", {
				notificationBasePath: "/app",
				currentBasePath: "/app",
			}),
		).toBe("/app/admin");
	});

	it("does not match admin look-alike paths", () => {
		expect(
			resolveNotificationLink("/app/administrators", {
				notificationBasePath: "/app/acme",
				currentBasePath: "/app/acme",
			}),
		).toBe("/app/administrators");
	});

	it("leaves other absolute links unchanged in any workspace", () => {
		expect(
			resolveNotificationLink("/app/settings/general", {
				notificationBasePath: "/app/acme",
				currentBasePath: "/app/acme",
			}),
		).toBe("/app/settings/general");
		expect(
			resolveNotificationLink("/auth/login", {
				notificationBasePath: "/app/acme",
				currentBasePath: "/app/acme",
			}),
		).toBe("/auth/login");
	});
});
