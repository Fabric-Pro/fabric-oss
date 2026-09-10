/**
 * The purge-reminder window (Fizzy #2462).
 *
 * The warning an owner gets before their organization is destroyed is the last
 * chance anyone has to stop it, so the two properties below are the ones that
 * decide whether it arrives at all:
 *
 *  1. **No lower bound on the window.** The first cut asked for a 24-48h band,
 *     which delivers exactly once only while the sweep runs exactly daily. An
 *     organization whose send failed dropped out of that band before the next
 *     run and was then never warned — it went dark with no notice. Without the
 *     lower bound a failed send is retried every day until the purge.
 *  2. **`deletionReminderSentAt: null` is what prevents duplicates**, not the
 *     window. It is the only guard that survives a change of cadence.
 *
 * Together those make the delivery at-least-once, which is the right direction
 * for a message whose absence is the expensive failure.
 *
 * The third property is who it reaches: every OWNER, because restoring is gated
 * by the same permission as deleting, so an owner is exactly the set of people
 * who can act on the warning.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();

vi.mock("../prisma/client", () => ({
	db: { organization: { findMany } },
}));

async function load() {
	return await import("../prisma/queries/organizations/deletion");
}

const NOW = new Date("2026-09-10T12:00:00.000Z");

beforeEach(() => {
	vi.clearAllMocks();
	findMany.mockResolvedValue([]);
});

describe("getOrganizationsNeedingPurgeReminder", () => {
	it("bounds the window from above only, so a failed send is retried", async () => {
		const { getOrganizationsNeedingPurgeReminder, REMINDER_LEAD_MS } =
			await load();

		await getOrganizationsNeedingPurgeReminder({ now: NOW });

		const where = findMany.mock.calls[0]?.[0]?.where;
		expect(where.scheduledPermanentDeleteAt).toEqual({
			lte: new Date(NOW.getTime() + REMINDER_LEAD_MS),
		});
		// The property that matters: nothing excludes an organization for being
		// TOO close to its purge, which is what stranded a failed send before.
		expect(where.scheduledPermanentDeleteAt.gt).toBeUndefined();
		expect(where.scheduledPermanentDeleteAt.gte).toBeUndefined();
	});

	it("relies on the stamp, not the window, to avoid a second warning", async () => {
		const { getOrganizationsNeedingPurgeReminder } = await load();

		await getOrganizationsNeedingPurgeReminder({ now: NOW });

		expect(findMany.mock.calls[0]?.[0]?.where).toMatchObject({
			deletedAt: { not: null },
			deletionReminderSentAt: null,
		});
	});

	it("asks for every owner, and only owners", async () => {
		const { getOrganizationsNeedingPurgeReminder } = await load();

		await getOrganizationsNeedingPurgeReminder({ now: NOW });

		expect(findMany.mock.calls[0]?.[0]?.select?.members).toEqual({
			where: { role: "owner" },
			select: { user: { select: { id: true, email: true, name: true } } },
		});
	});

	it("flattens members to owners on the way out", async () => {
		const { getOrganizationsNeedingPurgeReminder } = await load();
		findMany.mockResolvedValue([
			{
				id: "org-1",
				name: "Example Org",
				slug: "example-org",
				deletedBy: "user-1",
				scheduledPermanentDeleteAt: new Date(
					"2026-09-17T12:00:00.000Z",
				),
				members: [
					{
						user: {
							id: "user-1",
							email: "a@example.com",
							name: "A",
						},
					},
					{
						user: {
							id: "user-2",
							email: "b@example.com",
							name: "B",
						},
					},
				],
			},
		]);

		const [organization] = await getOrganizationsNeedingPurgeReminder({
			now: NOW,
		});

		expect(organization.owners).toEqual([
			{ id: "user-1", email: "a@example.com", name: "A" },
			{ id: "user-2", email: "b@example.com", name: "B" },
		]);
	});

	it("drains oldest-first and stays bounded", async () => {
		const { getOrganizationsNeedingPurgeReminder } = await load();

		await getOrganizationsNeedingPurgeReminder({ now: NOW, batchSize: 25 });

		expect(findMany.mock.calls[0]?.[0]?.orderBy).toEqual({
			scheduledPermanentDeleteAt: "asc",
		});
		expect(findMany.mock.calls[0]?.[0]?.take).toBe(25);
	});
});
