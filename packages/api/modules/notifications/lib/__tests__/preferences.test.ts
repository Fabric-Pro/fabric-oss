/**
 * get/update notification-preferences procedures.
 *
 * The handlers must:
 *  - return all-enabled defaults + `syncIntegrationAvailable` from the query
 *    layer (get);
 *  - compute `syncIntegrationAvailable` from whether the caller has any project
 *    with a PM-tool integration (AC-7);
 *  - write keyed on the caller's own id only, so one user's toggles never
 *    affect another's (own-user isolation — AC-11) (update).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { findFirst, getPrefs, upsertPrefs, getDisplay, upsertDisplay } =
	vi.hoisted(() => ({
		findFirst: vi.fn(),
		getPrefs: vi.fn(),
		upsertPrefs: vi.fn(),
		getDisplay: vi.fn(),
		upsertDisplay: vi.fn(),
	}));

vi.mock("@repo/database", () => ({
	db: { project: { findFirst } },
	getNotificationPreferences: getPrefs,
	upsertNotificationPreferences: upsertPrefs,
	// Display preference (#2117) — read and written through its own query-layer
	// functions so the style flag never enters NotificationPreferenceFlags.
	getNotificationDisplayPreference: getDisplay,
	upsertNotificationDisplayPreference: upsertDisplay,
}));

vi.mock("../../../../orpc/procedures", () => {
	const makeChain = () => {
		const chain: any = {
			use: () => chain,
			route: () => chain,
			input: () => chain,
			output: () => chain,
			handler: (h: any) => h,
		};
		return chain;
	};
	return {
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => () => undefined,
		resolveOrganizationId: (id: string | null | undefined) => id ?? null,
		get tenantProtectedProcedure() {
			return makeChain();
		},
	};
});

import { getNotificationPreferencesProcedure } from "../../procedures/get-preferences";
import { updateNotificationPreferencesProcedure } from "../../procedures/update-preferences";

const ALL_ENABLED = {
	mentions: true,
	replies: true,
	assignments: true,
	status: true,
	syncProject: true,
	aiAgent: true,
	reportEmails: true,
	reviewEmails: true,
};

beforeEach(() => {
	vi.clearAllMocks();
	getPrefs.mockResolvedValue({ ...ALL_ENABLED });
	upsertPrefs.mockResolvedValue({ ...ALL_ENABLED });
	// Opt-in default — the compact rows stay the status quo (#2117).
	getDisplay.mockResolvedValue({ stackedCardStyle: false });
	upsertDisplay.mockResolvedValue({ stackedCardStyle: false });
	findFirst.mockResolvedValue(null);
});

describe("getNotificationPreferencesProcedure", () => {
	it("returns the flags with syncIntegrationAvailable=false when no PM integration", async () => {
		const result = await (getNotificationPreferencesProcedure as any)({
			context: { user: { id: "u1" }, session: {} },
		});
		expect(result).toEqual({
			...ALL_ENABLED,
			stackedCardStyle: false,
			syncIntegrationAvailable: false,
		});
		expect(getPrefs).toHaveBeenCalledWith("u1");
	});

	it("reports syncIntegrationAvailable=true when the caller has a PM integration", async () => {
		findFirst.mockResolvedValue({ id: "p1" });
		const result = await (getNotificationPreferencesProcedure as any)({
			context: { user: { id: "u1" }, session: {} },
		});
		expect(result.syncIntegrationAvailable).toBe(true);
		// Only matches projects with a PM-tool server configured.
		expect(
			findFirst.mock.calls[0][0].where.projectManagementMcpServerId,
		).toEqual({ not: null });
	});

	it("returns the reportEmails email-channel flag from the query layer", async () => {
		getPrefs.mockResolvedValue({ ...ALL_ENABLED, reportEmails: false });
		const result = await (getNotificationPreferencesProcedure as any)({
			context: { user: { id: "u1" }, session: {} },
		});
		expect(result.reportEmails).toBe(false);
	});
});

describe("updateNotificationPreferencesProcedure", () => {
	it("upserts the caller's own preferences with the provided flags", async () => {
		upsertPrefs.mockResolvedValue({ ...ALL_ENABLED, mentions: false });
		const result = await (updateNotificationPreferencesProcedure as any)({
			input: { mentions: false },
			context: { user: { id: "u1" }, session: {} },
		});
		expect(upsertPrefs).toHaveBeenCalledWith("u1", { mentions: false });
		expect(result).toEqual({
			success: true,
			...ALL_ENABLED,
			mentions: false,
			stackedCardStyle: false,
		});
	});

	it("round-trips the reportEmails email-channel flag", async () => {
		upsertPrefs.mockResolvedValue({ ...ALL_ENABLED, reportEmails: false });
		const result = await (updateNotificationPreferencesProcedure as any)({
			input: { reportEmails: false },
			context: { user: { id: "u1" }, session: {} },
		});
		expect(upsertPrefs).toHaveBeenCalledWith("u1", { reportEmails: false });
		expect(result).toEqual({
			success: true,
			...ALL_ENABLED,
			reportEmails: false,
			stackedCardStyle: false,
		});
	});
});
