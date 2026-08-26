/**
 * The stacked-card display preference (#2117) rides the same two procedures as
 * the delivery flags, but must stay a distinct field end to end.
 *
 * `NotificationPreferenceFlags` is consumed by the write-time delivery filter
 * and carries the invariant that every member gates delivery on some channel.
 * A style preference gates nothing, so it is read and written through its own
 * query-layer functions — these tests pin that the procedures keep the two
 * apart rather than folding the style flag into the delivery payload.
 */

import { describe, expect, it, vi } from "vitest";

const { getFlags, getDisplay, upsertFlags, upsertDisplay, projectFindFirst } =
	vi.hoisted(() => ({
		getFlags: vi.fn(),
		getDisplay: vi.fn(),
		upsertFlags: vi.fn(),
		upsertDisplay: vi.fn(),
		projectFindFirst: vi.fn(),
	}));

vi.mock("@repo/database", () => ({
	db: { project: { findFirst: projectFindFirst } },
	getNotificationPreferences: getFlags,
	getNotificationDisplayPreference: getDisplay,
	upsertNotificationPreferences: upsertFlags,
	upsertNotificationDisplayPreference: upsertDisplay,
}));

vi.mock("../../../../orpc/procedures", () => {
	const passthrough = {
		use: () => passthrough,
		route: () => passthrough,
		input: () => passthrough,
		output: () => passthrough,
		handler: (h: unknown) => h,
	};
	return {
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => () => undefined,
		tenantProtectedProcedure: passthrough,
	};
});

import { getNotificationPreferencesProcedure } from "../../procedures/get-preferences";
import { updateNotificationPreferencesProcedure } from "../../procedures/update-preferences";

const ALL_FLAGS_ON = {
	mentions: true,
	replies: true,
	assignments: true,
	status: true,
	syncProject: true,
	aiAgent: true,
	reportEmails: true,
	reviewEmails: true,
};

const context = { user: { id: "u1" } };

describe("getPreferences — display preference", () => {
	it("returns stackedCardStyle alongside the delivery flags", async () => {
		getFlags.mockResolvedValue(ALL_FLAGS_ON);
		getDisplay.mockResolvedValue({ stackedCardStyle: true });
		projectFindFirst.mockResolvedValue(null);

		const handler = getNotificationPreferencesProcedure as unknown as (
			args: unknown,
		) => Promise<Record<string, unknown>>;
		const result = await handler({ context });

		expect(result.stackedCardStyle).toBe(true);
		expect(result.mentions).toBe(true);
		expect(result.syncIntegrationAvailable).toBe(false);
	});

	it("reads the display preference for the calling user only", async () => {
		getFlags.mockResolvedValue(ALL_FLAGS_ON);
		getDisplay.mockResolvedValue({ stackedCardStyle: false });
		projectFindFirst.mockResolvedValue(null);

		const handler = getNotificationPreferencesProcedure as unknown as (
			args: unknown,
		) => Promise<Record<string, unknown>>;
		await handler({ context });

		expect(getDisplay).toHaveBeenCalledWith("u1");
	});
});

describe("updatePreferences — display preference", () => {
	it("routes stackedCardStyle to the display upsert, never the flags upsert", async () => {
		upsertFlags.mockResolvedValue(ALL_FLAGS_ON);
		upsertDisplay.mockResolvedValue({ stackedCardStyle: true });

		const handler = updateNotificationPreferencesProcedure as unknown as (
			args: unknown,
		) => Promise<Record<string, unknown>>;
		const result = await handler({
			input: { stackedCardStyle: true },
			context,
		});

		expect(upsertDisplay).toHaveBeenCalledWith("u1", {
			stackedCardStyle: true,
		});
		// The delivery upsert must not receive the style flag.
		expect(upsertFlags).toHaveBeenCalledWith("u1", {});
		expect(result.stackedCardStyle).toBe(true);
		expect(result.success).toBe(true);
	});

	it("leaves the display preference untouched when only a delivery flag changes", async () => {
		upsertFlags.mockResolvedValue({ ...ALL_FLAGS_ON, mentions: false });
		upsertDisplay.mockResolvedValue({ stackedCardStyle: false });

		const handler = updateNotificationPreferencesProcedure as unknown as (
			args: unknown,
		) => Promise<Record<string, unknown>>;
		await handler({ input: { mentions: false }, context });

		expect(upsertFlags).toHaveBeenCalledWith("u1", { mentions: false });
		// Empty patch — the row's existing style value survives.
		expect(upsertDisplay).toHaveBeenCalledWith("u1", {});
	});

	it("returns both payloads merged", async () => {
		upsertFlags.mockResolvedValue({ ...ALL_FLAGS_ON, aiAgent: false });
		upsertDisplay.mockResolvedValue({ stackedCardStyle: true });

		const handler = updateNotificationPreferencesProcedure as unknown as (
			args: unknown,
		) => Promise<Record<string, unknown>>;
		const result = await handler({
			input: { aiAgent: false, stackedCardStyle: true },
			context,
		});

		expect(result).toMatchObject({
			success: true,
			aiAgent: false,
			stackedCardStyle: true,
		});
	});
});
