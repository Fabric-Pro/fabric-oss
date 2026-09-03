/**
 * Authorization on the project-wide tab-visibility write (Fizzy #1837).
 *
 * The procedure's decorator is `requireProjectPermission(PROJECT_UPDATE)`, but
 * reshaping navigation for every member is a settings decision, so the handler
 * applies a STRICTER `PROJECT_SETTINGS_EDIT` check of its own. The repo's
 * permission-coverage ratchet only proves a decorator exists — it cannot see
 * that second check, so the branch that separates an ordinary member from a
 * project admin had no test at all. That is the whole authorization story for
 * "who can hide a tab for everyone", which is why it gets one here.
 *
 * Fully offline: `@repo/database` and the orpc procedure builder are mocked and
 * the handler is invoked directly, mirroring the harness in
 * `newsletter/procedures/__tests__/settings-embed.test.ts`.
 */

import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockProjectUpdate,
	mockResolveEffectivePermissions,
	mockHasPermission,
} = vi.hoisted(() => ({
	mockProjectUpdate: vi.fn(),
	mockResolveEffectivePermissions: vi.fn(),
	mockHasPermission: vi.fn(),
}));

vi.mock("@repo/database", async () => {
	// The tab contract itself is pure and shared with the client; use the real
	// implementations so a change to the protected-tab list is caught here too.
	const contract = await vi.importActual<
		typeof import("@repo/database/src/project-tabs")
	>("@repo/database/src/project-tabs");
	return {
		db: { project: { update: mockProjectUpdate } },
		getProjectAccessById: vi.fn(),
		isProtectedProjectTab: contract.isProtectedProjectTab,
		normalizeProjectTabConfig: contract.normalizeProjectTabConfig,
		normalizeProjectTabPrefs: contract.normalizeProjectTabPrefs,
		projectTabConfigSchema: contract.projectTabConfigSchema,
		projectTabPrefsSchema: contract.projectTabPrefsSchema,
	};
});

vi.mock("@repo/permissions", () => ({
	hasPermission: mockHasPermission,
	Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
}));

vi.mock("../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: mockResolveEffectivePermissions,
}));

vi.mock("../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => ({ _handler: fn }),
	};
	return {
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
		requireProjectPermission: () => (c: unknown) => c,
	};
});

import { setProjectTabVisibilityProcedure } from "../project-tabs";

type Handler = (args: { input: unknown; context: unknown }) => Promise<unknown>;
const setVisibility = (
	setProjectTabVisibilityProcedure as unknown as { _handler: Handler }
)._handler;

const context = { user: { id: "user-1" }, session: {} };
const input = {
	projectId: "proj-1",
	organizationId: "org-1",
	config: { overrides: { decisions: false } },
};

beforeEach(() => {
	vi.clearAllMocks();
	mockProjectUpdate.mockResolvedValue({
		projectTabConfig: { overrides: { decisions: false } },
	});
});

describe("who may hide a project tab for everyone", () => {
	it("refuses a member who has PROJECT_UPDATE but not PROJECT_SETTINGS_EDIT", async () => {
		// The decorator already let this caller through — this is exactly the
		// gap the handler's own check exists to close.
		mockResolveEffectivePermissions.mockResolvedValue({
			source: "member",
			permissions: ["PROJECT_UPDATE"],
		});
		mockHasPermission.mockReturnValue(false);

		await expect(setVisibility({ input, context })).rejects.toThrow(
			ORPCError,
		);
		expect(mockProjectUpdate).not.toHaveBeenCalled();
	});

	it("refuses a caller with no resolvable project access at all", async () => {
		mockResolveEffectivePermissions.mockResolvedValue(null);
		mockHasPermission.mockReturnValue(false);

		await expect(setVisibility({ input, context })).rejects.toThrow(
			ORPCError,
		);
		expect(mockProjectUpdate).not.toHaveBeenCalled();
	});

	it("allows a member holding PROJECT_SETTINGS_EDIT", async () => {
		mockResolveEffectivePermissions.mockResolvedValue({
			source: "member",
			permissions: ["PROJECT_SETTINGS_EDIT"],
		});
		mockHasPermission.mockReturnValue(true);

		await expect(setVisibility({ input, context })).resolves.toEqual({
			config: { overrides: { decisions: false } },
		});
		expect(mockProjectUpdate).toHaveBeenCalledTimes(1);
	});

	it("allows the owner even when the permission list is empty", async () => {
		// Ownership is checked by `source`, not by a grant in the list.
		mockResolveEffectivePermissions.mockResolvedValue({
			source: "owner",
			permissions: [],
		});
		mockHasPermission.mockReturnValue(false);

		await expect(setVisibility({ input, context })).resolves.toBeTruthy();
		expect(mockProjectUpdate).toHaveBeenCalledTimes(1);
	});
});

describe("tabs no admin may hide", () => {
	beforeEach(() => {
		mockResolveEffectivePermissions.mockResolvedValue({
			source: "owner",
			permissions: [],
		});
		mockHasPermission.mockReturnValue(true);
	});

	for (const tabId of ["overview", "settings"]) {
		it(`rejects an override that would hide "${tabId}", even from an owner`, async () => {
			await expect(
				setVisibility({
					input: {
						...input,
						config: { overrides: { [tabId]: false } },
					},
					context,
				}),
			).rejects.toThrow(ORPCError);
			expect(mockProjectUpdate).not.toHaveBeenCalled();
		});
	}

	it("still writes an override for an ordinary tab", async () => {
		await expect(setVisibility({ input, context })).resolves.toBeTruthy();
		expect(mockProjectUpdate).toHaveBeenCalledTimes(1);
	});
});
