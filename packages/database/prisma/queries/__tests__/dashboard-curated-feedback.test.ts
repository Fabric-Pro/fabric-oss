import { beforeEach, describe, expect, it, vi } from "vitest";

const { findMany, upsert } = vi.hoisted(() => ({
	findMany: vi.fn(),
	upsert: vi.fn(),
}));

vi.mock("../../client", () => ({
	db: { dashboardCuratedPreference: { findMany, upsert } },
}));

import {
	listDashboardCuratedFeedback,
	recordDashboardCuratedFeedback,
} from "../dashboard-curated-feedback";

const actor = { userId: "user-1", organizationId: "org-1" };
const now = new Date("2026-11-07T10:00:00.000Z");

beforeEach(() => {
	vi.clearAllMocks();
});

describe("dashboard curated feedback", () => {
	it("reads only the current user and organization", async () => {
		await listDashboardCuratedFeedback(actor);
		expect(findMany).toHaveBeenCalledWith(
			expect.objectContaining({ where: actor }),
		);
	});

	it("increments clicks without replacing pin state", async () => {
		await recordDashboardCuratedFeedback({
			...actor,
			cardKey: "project:project-1",
			action: "click",
			now,
		});
		expect(upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				update: {
					clickCount: { increment: 1 },
					lastClickedAt: now,
					dismissedAt: null,
				},
			}),
		);
	});

	it("pins and dismisses independently for the same stable key", async () => {
		await recordDashboardCuratedFeedback({
			...actor,
			cardKey: "review:run-1",
			action: "pin",
			now,
		});
		expect(upsert.mock.calls[0][0].update).toEqual({
			pinnedAt: now,
			dismissedAt: null,
		});
		await recordDashboardCuratedFeedback({
			...actor,
			cardKey: "review:run-1",
			action: "dismiss",
			now,
		});
		expect(upsert.mock.calls[1][0].update).toEqual({
			pinnedAt: null,
			dismissedAt: now,
		});
	});
});
