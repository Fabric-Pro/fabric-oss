/**
 * Tests for the server-side route guard on the admin audit-log explorer page.
 *
 * The page MUST redirect:
 *   - to `/auth/login` when there is no session
 *   - to `/app` when the session user is not a system admin
 *
 * On a happy path (admin user), the page renders the AuditLogExplorer
 * client component. Because the page is a React Server Component and we
 * can't render it through @testing-library directly, we exercise the guard
 * by invoking the page function with mocked session / redirect / module
 * imports and asserting on which redirect was called.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetSession, mockRedirect } = vi.hoisted(() => ({
	mockGetSession: vi.fn(),
	mockRedirect: vi.fn(),
}));

vi.mock("@saas/auth/lib/server", () => ({
	getSession: () => mockGetSession(),
}));

vi.mock("next/navigation", () => ({
	redirect: (target: string) => {
		// Mirror Next's redirect semantics: throwing a sentinel so the caller
		// halts. Tests still inspect what was called via mockRedirect.
		mockRedirect(target);
		throw new Error(`__REDIRECT__:${target}`);
	},
}));

// Stub the explorer client component so the import doesn't pull the whole
// React tree (the guard test doesn't care about UI).
vi.mock("@saas/admin/component/audit-log-explorer/AuditLogExplorer", () => ({
	AuditLogExplorer: () => null,
}));

beforeEach(() => {
	mockGetSession.mockReset();
	mockRedirect.mockReset();
});

afterEach(() => {
	vi.resetModules();
});

async function callPage() {
	const mod = await import(
		"../../../../app/(saas)/app/(account)/admin/audit-log-explorer/page"
	);
	return (mod.default as () => Promise<unknown>)();
}

describe("Admin audit-log-explorer page — route guard", () => {
	it("redirects unauthenticated users to /auth/login", async () => {
		mockGetSession.mockResolvedValue(null);
		await expect(callPage()).rejects.toThrow(/__REDIRECT__:\/auth\/login/);
		expect(mockRedirect).toHaveBeenCalledWith("/auth/login");
	});

	it("redirects non-admin users to /app (regular org member)", async () => {
		mockGetSession.mockResolvedValue({
			user: { id: "u-1", role: "user" },
		});
		await expect(callPage()).rejects.toThrow(/__REDIRECT__:\/app/);
		expect(mockRedirect).toHaveBeenCalledWith("/app");
	});

	it("redirects org owners to /app — owners are NOT system admins (v3 admin-incidents pass)", async () => {
		mockGetSession.mockResolvedValue({
			user: { id: "u-1", role: "user" }, // role is the better-auth user.role; owners still have user.role !== "admin"
		});
		await expect(callPage()).rejects.toThrow(/__REDIRECT__:\/app/);
		expect(mockRedirect).toHaveBeenCalledWith("/app");
	});

	it("renders the explorer for system admins (no redirect)", async () => {
		mockGetSession.mockResolvedValue({
			user: { id: "admin-1", role: "admin" },
		});
		// No throw — page returns the AuditLogExplorer JSX (stubbed).
		const result = await callPage();
		expect(result).toBeTruthy();
		expect(mockRedirect).not.toHaveBeenCalled();
	});
});
