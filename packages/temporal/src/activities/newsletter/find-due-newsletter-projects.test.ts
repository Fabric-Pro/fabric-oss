import { describe, expect, it, vi } from "vitest";

// heartbeat() throws outside an activity context; mock it.
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));

const listEnabled = vi.fn();
const actorValid = vi.fn();
vi.mock("@repo/database", async () => {
	const actual =
		await vi.importActual<typeof import("@repo/database")>(
			"@repo/database",
		);
	return {
		...actual,
		listEnabledNewsletterSettings: (...a: unknown[]) => listEnabled(...a),
		isScheduledNewsletterActorValid: (...a: unknown[]) => actorValid(...a),
	};
});

import { findDueNewsletterProjectsActivity } from "./find-due-newsletter-projects";

describe("findDueNewsletterProjectsActivity", () => {
	it("returns due projects with window + scheduled dedupeKey", async () => {
		// 2026-06-15T09 is Monday 09:00 UTC.
		vi.useFakeTimers().setSystemTime(new Date("2026-06-15T09:10:00.000Z"));
		actorValid.mockResolvedValue(true);
		listEnabled.mockResolvedValue([
			{
				projectId: "p1",
				organizationId: "o1",
				userId: null,
				createdByUserId: "u1",
				cadence: "WEEKLY",
				dayOfWeek: 1,
				dayOfMonth: 1,
				sendHourUtc: 9,
				lastSentAt: null,
				lookbackDays: null,
				project: { id: "p1", name: "Acme" },
			},
			{
				projectId: "p2",
				organizationId: null,
				userId: "u2",
				createdByUserId: "u2",
				cadence: "WEEKLY",
				dayOfWeek: 2,
				dayOfMonth: 1,
				sendHourUtc: 9,
				lastSentAt: null,
				lookbackDays: null,
				project: { id: "p2", name: "Beta" },
			}, // Tuesday → not due
		]);
		const out = await findDueNewsletterProjectsActivity();
		vi.useRealTimers();
		expect(out.due).toHaveLength(1);
		expect(out.due[0]).toMatchObject({
			projectId: "p1",
			projectName: "Acme",
			dedupeKey: "scheduled:p1:2026-W25",
		});
	});

	it("skips a due org project whose actor is no longer a valid member", async () => {
		// 2026-06-15T09 is Monday 09:00 UTC — both projects are due.
		vi.useFakeTimers().setSystemTime(new Date("2026-06-15T09:10:00.000Z"));
		// org project p1's actor (u1) is stale; personal project p3's actor is valid.
		actorValid.mockImplementation(
			async (_userId: string, orgId: string | null) => orgId !== "o1",
		);
		listEnabled.mockResolvedValue([
			{
				projectId: "p1",
				organizationId: "o1",
				userId: null,
				createdByUserId: "u1", // removed/deleted admin
				cadence: "WEEKLY",
				dayOfWeek: 1,
				dayOfMonth: 1,
				sendHourUtc: 9,
				lastSentAt: null,
				lookbackDays: null,
				project: { id: "p1", name: "Acme" },
			},
			{
				projectId: "p3",
				organizationId: null,
				userId: "u3",
				createdByUserId: "u3",
				cadence: "WEEKLY",
				dayOfWeek: 1,
				dayOfMonth: 1,
				sendHourUtc: 9,
				lastSentAt: null,
				lookbackDays: null,
				project: { id: "p3", name: "Personal" },
			},
		]);
		const out = await findDueNewsletterProjectsActivity();
		vi.useRealTimers();
		// p1 (stale org actor) is dropped; only the personal project remains.
		expect(out.due).toHaveLength(1);
		expect(out.due[0].projectId).toBe("p3");
		// (createdByUserId, organizationId, ownerUserId)
		expect(actorValid).toHaveBeenCalledWith("u1", "o1", null);
	});

	it("widens the scheduled window when lookbackDays is set", async () => {
		const now = new Date("2026-06-15T09:10:00.000Z"); // Monday, within the 09:00 UTC send hour
		vi.useFakeTimers().setSystemTime(now);
		actorValid.mockResolvedValue(true);
		listEnabled.mockResolvedValue([
			{
				projectId: "p1",
				organizationId: "o1",
				userId: null,
				createdByUserId: "u1",
				cadence: "WEEKLY",
				dayOfWeek: 1,
				dayOfMonth: 1,
				sendHourUtc: 9,
				lastSentAt: null,
				lookbackDays: 90, // explicit: window must be now - 90d, not the 7d default
				project: { id: "p1", name: "Acme" },
			},
		]);
		const out = await findDueNewsletterProjectsActivity();
		vi.useRealTimers();
		expect(out.due).toHaveLength(1);
		expect(out.due[0].timeWindowEnd).toBe(now.toISOString());
		expect(out.due[0].timeWindowStart).toBe(
			new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString(),
		);
	});

	it("projects the persisted detailLevel onto the due project", async () => {
		vi.useFakeTimers().setSystemTime(new Date("2026-06-15T09:10:00.000Z"));
		actorValid.mockResolvedValue(true);
		listEnabled.mockResolvedValue([
			{
				projectId: "p1",
				organizationId: null,
				userId: "u1",
				createdByUserId: "u1",
				cadence: "WEEKLY",
				dayOfWeek: 1,
				dayOfMonth: 1,
				sendHourUtc: 9,
				lastSentAt: null,
				lookbackDays: null,
				detailLevel: "DETAILED",
				project: { id: "p1", name: "Acme" },
			},
		]);
		const out = await findDueNewsletterProjectsActivity();
		vi.useRealTimers();
		expect(out.due).toHaveLength(1);
		expect(out.due[0].detailLevel).toBe("DETAILED");
	});

	it("defaults the due project's detailLevel to STANDARD when unset", async () => {
		vi.useFakeTimers().setSystemTime(new Date("2026-06-15T09:10:00.000Z"));
		actorValid.mockResolvedValue(true);
		listEnabled.mockResolvedValue([
			{
				projectId: "p1",
				organizationId: null,
				userId: "u1",
				createdByUserId: "u1",
				cadence: "WEEKLY",
				dayOfWeek: 1,
				dayOfMonth: 1,
				sendHourUtc: 9,
				lastSentAt: null,
				lookbackDays: null,
				project: { id: "p1", name: "Acme" },
			},
		]);
		const out = await findDueNewsletterProjectsActivity();
		vi.useRealTimers();
		expect(out.due).toHaveLength(1);
		expect(out.due[0].detailLevel).toBe("STANDARD");
	});
});
