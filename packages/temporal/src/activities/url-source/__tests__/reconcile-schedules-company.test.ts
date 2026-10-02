/**
 * The URL-source schedule reconciler and company website sources
 * (Fizzy #2719).
 *
 * Company sources share the `url-source-schedule-{contextId}` id scheme. When
 * no `ProjectContext` row matches a schedule's context id, the reconciler
 * looks the id up in `CompanyContextSource` and classifies the schedule
 * against whichever row it finds: a live company schedule is kept — also
 * while its source has not recorded its id yet, as during the schedule's
 * creation — and the schedule of a deleted company source (or of one that
 * stopped refreshing, or whose row names another schedule) is removed.
 *
 * Exercised through the real row lookup (`fetchUrlSourceScheduleRow`) with
 * Prisma stubbed, and once through the activity with the schedule client
 * stubbed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	projectContextFindUnique: vi.fn(),
	companyContextSourceFindUnique: vi.fn(),
	list: vi.fn(),
	handleDelete: vi.fn(),
	getHandle: vi.fn(),
}));

vi.mock("@repo/database/prisma/client", () => ({
	db: {
		projectContext: { findUnique: m.projectContextFindUnique },
		companyContextSource: { findUnique: m.companyContextSourceFindUnique },
	},
}));

vi.mock("../../../client", () => ({
	getScheduleClient: vi.fn(async () => ({
		list: m.list,
		getHandle: m.getHandle,
	})),
}));

vi.mock("../../lib/activity-logger", () => ({
	activityLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
	fetchUrlSourceScheduleRow,
	reconcileUrlSourceSchedules,
	reconcileUrlSourceSchedulesActivity,
} from "../reconcile-schedules-activity";

const scheduleId = (contextId: string) => `url-source-schedule-${contextId}`;

/** Project rows and company sources by id, as the two tables hold them. */
function seed(tables: {
	projects?: Record<
		string,
		{ urlRefreshMode: string | null; urlScheduleId: string | null }
	>;
	sources?: Record<
		string,
		{ urlRefreshMode: string | null; urlScheduleId: string | null }
	>;
}): void {
	m.projectContextFindUnique.mockImplementation(
		async ({ where }: { where: { id: string } }) =>
			tables.projects?.[where.id] ?? null,
	);
	m.companyContextSourceFindUnique.mockImplementation(
		async ({ where }: { where: { id: string } }) =>
			tables.sources?.[where.id] ?? null,
	);
}

function listing(ids: string[]) {
	return async function* () {
		for (const id of ids) {
			yield { scheduleId: id } as never;
		}
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	m.handleDelete.mockResolvedValue(undefined);
	m.getHandle.mockImplementation(() => ({ delete: m.handleDelete }));
});

describe("fetchUrlSourceScheduleRow", () => {
	it("reads a company source when no project context has the id", async () => {
		seed({
			sources: {
				"src-1": {
					urlRefreshMode: "WEEKLY",
					urlScheduleId: scheduleId("src-1"),
				},
			},
		});

		expect(await fetchUrlSourceScheduleRow("src-1")).toEqual({
			urlRefreshMode: "WEEKLY",
			urlScheduleId: scheduleId("src-1"),
			company: true,
		});
		expect(m.companyContextSourceFindUnique).toHaveBeenCalledWith({
			where: { id: "src-1" },
			select: { urlRefreshMode: true, urlScheduleId: true },
		});
	});

	it("answers from the project context without reading company sources", async () => {
		seed({
			projects: {
				"ctx-1": {
					urlRefreshMode: "DAILY",
					urlScheduleId: scheduleId("ctx-1"),
				},
			},
		});

		expect(await fetchUrlSourceScheduleRow("ctx-1")).toEqual({
			urlRefreshMode: "DAILY",
			urlScheduleId: scheduleId("ctx-1"),
		});
		expect(m.companyContextSourceFindUnique).not.toHaveBeenCalled();
	});

	it("reports no row when neither table has the id", async () => {
		seed({});

		expect(await fetchUrlSourceScheduleRow("gone")).toBeNull();
	});
});

describe("reconcileUrlSourceSchedules with company sources", () => {
	it("keeps a live company schedule and removes the schedule of a deleted company source", async () => {
		seed({
			projects: {
				"ctx-live": {
					urlRefreshMode: "DAILY",
					urlScheduleId: scheduleId("ctx-live"),
				},
			},
			sources: {
				"src-live": {
					urlRefreshMode: "WEEKLY",
					urlScheduleId: scheduleId("src-live"),
				},
				"src-once": {
					urlRefreshMode: "ONCE",
					urlScheduleId: scheduleId("src-once"),
				},
				"src-drift": {
					urlRefreshMode: "MONTHLY",
					urlScheduleId: scheduleId("src-other"),
				},
			},
		});
		const deleteSchedule = vi.fn().mockResolvedValue(undefined);

		const result = await reconcileUrlSourceSchedules({
			listSchedules: listing([
				scheduleId("ctx-live"),
				scheduleId("src-live"),
				scheduleId("src-deleted"),
				scheduleId("src-once"),
				scheduleId("src-drift"),
			]),
			deleteSchedule,
			fetchContext: fetchUrlSourceScheduleRow,
			dryRun: false,
		});

		expect(result).toEqual({
			scanned: 5,
			orphansDeleted: 3,
			dryRun: false,
		});
		expect(deleteSchedule.mock.calls.map(([id]) => id)).toEqual([
			scheduleId("src-deleted"),
			scheduleId("src-once"),
			scheduleId("src-drift"),
		]);
	});

	it("keeps the schedule of a company source that refreshes on a schedule but has not recorded its id yet", async () => {
		seed({
			projects: {
				"ctx-creating": {
					urlRefreshMode: "DAILY",
					urlScheduleId: null,
				},
			},
			sources: {
				"src-creating": {
					urlRefreshMode: "WEEKLY",
					urlScheduleId: null,
				},
				"src-once": { urlRefreshMode: "ONCE", urlScheduleId: null },
			},
		});
		const deleteSchedule = vi.fn().mockResolvedValue(undefined);

		const result = await reconcileUrlSourceSchedules({
			listSchedules: listing([
				scheduleId("src-creating"),
				scheduleId("src-once"),
				scheduleId("ctx-creating"),
			]),
			deleteSchedule,
			fetchContext: fetchUrlSourceScheduleRow,
			dryRun: false,
		});

		// A company source still wants its schedule; one that stopped
		// refreshing does not. A project context keeps its own rule.
		expect(deleteSchedule.mock.calls.map(([id]) => id)).toEqual([
			scheduleId("src-once"),
			scheduleId("ctx-creating"),
		]);
		expect(result).toEqual({
			scanned: 3,
			orphansDeleted: 2,
			dryRun: false,
		});
	});

	/**
	 * The organization purge deletes its company schedules best-effort; one it
	 * could not delete has no source row left, and the sweep removes it.
	 */
	it("removes the schedules an organization purge left behind", async () => {
		seed({});
		m.list.mockImplementation(
			listing([scheduleId("src-a"), scheduleId("src-b")]),
		);

		const swept = await reconcileUrlSourceSchedulesActivity({
			dryRun: false,
		});

		expect(swept).toEqual({ scanned: 2, orphansDeleted: 2, dryRun: false });
		expect(m.getHandle.mock.calls.map(([id]) => id)).toEqual([
			scheduleId("src-a"),
			scheduleId("src-b"),
		]);
		expect(m.handleDelete).toHaveBeenCalledTimes(2);
	});

	it("deletes nothing on a dry run", async () => {
		seed({});
		m.list.mockImplementation(listing([scheduleId("src-a")]));

		const result = await reconcileUrlSourceSchedulesActivity({
			dryRun: true,
		});

		expect(result).toEqual({ scanned: 1, orphansDeleted: 1, dryRun: true });
		expect(m.handleDelete).not.toHaveBeenCalled();
	});
});
