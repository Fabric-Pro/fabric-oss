/**
 * The time-tracking procedures.
 *
 * Two seams, as in the other module procedure tests:
 *
 *  1. Schema level: each exported input schema is parsed directly, because
 *     the stubbed procedure chain below does not run `.input()`.
 *  2. Handler level: the query functions of `@repo/database` are mocked, so
 *     what is asserted is what each handler loads, whether it writes, and
 *     with which values. The pure rules (`@repo/utils/time-tracking`) and this
 *     module's own `lib/` run for real.
 *
 * The permission and project-visibility middleware cannot run in the stub;
 * what is pinned about them is the declaration. Handler-side checks
 * (`assertProjectPermission`, and `hasProjectAccess` behind
 * `assertProjectVisible`) are mocks so the tests can take access away.
 */

import { ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	loadTimeTrackingProject: vi.fn(),
	listTimeAccessRows: vi.fn(),
	listTimeEntriesForAuthor: vi.fn(),
	listTimeEntriesForAuthorStory: vi.fn(),
	findTimeEntryForAuthor: vi.fn(),
	listAuthorTimeEntriesOnWorkDate: vi.fn(),
	findStoryForTimeEntry: vi.fn(),
	createTimeEntry: vi.fn(),
	updateTimeEntry: vi.fn(),
	deleteTimeEntry: vi.fn(),
	assertProjectPermission: vi.fn(),
	hasProjectAccess: vi.fn(),
	findUserProfileTimeZone: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		loadTimeTrackingProject: mocks.loadTimeTrackingProject,
		listTimeAccessRows: mocks.listTimeAccessRows,
		listTimeEntriesForAuthor: mocks.listTimeEntriesForAuthor,
		listTimeEntriesForAuthorStory: mocks.listTimeEntriesForAuthorStory,
		findTimeEntryForAuthor: mocks.findTimeEntryForAuthor,
		listAuthorTimeEntriesOnWorkDate: mocks.listAuthorTimeEntriesOnWorkDate,
		findStoryForTimeEntry: mocks.findStoryForTimeEntry,
		createTimeEntry: mocks.createTimeEntry,
		updateTimeEntry: mocks.updateTimeEntry,
		deleteTimeEntry: mocks.deleteTimeEntry,
		hasProjectAccess: mocks.hasProjectAccess,
		findUserProfileTimeZone: mocks.findUserProfileTimeZone,
	};
});

type Declaration = {
	kind: string;
	permission?: string;
	options?: { requireOrganization?: boolean };
};

const VISIBLE: Declaration = { kind: "visible" };

vi.mock("../../../../orpc/middleware/project-visibility", () => ({
	PROJECT_NOT_FOUND_MESSAGE: "Project not found",
	projectNotFoundUnlessVisible: { kind: "visible" },
}));
type Handler = (args: { input: unknown; context: unknown }) => Promise<any>;

vi.mock("../../../../orpc/procedures", async () => {
	const { Permissions } = await import("@repo/permissions");
	const builder = (declared: Declaration[]): any => ({
		use: (declaration: Declaration) => builder([...declared, declaration]),
		route: () => builder(declared),
		input: () => builder(declared),
		output: () => builder(declared),
		handler: (fn: Handler) => ({ __handler: fn, __declared: declared }),
	});
	return {
		Permissions,
		tenantProtectedProcedure: builder([]),
		requireProjectPermission: (permission: string) => ({
			kind: "project",
			permission,
		}),
		requireInputOrgPermission: (
			permission: string,
			options?: { requireOrganization?: boolean },
		) => ({ kind: "input-org", permission, options }),
		assertProjectPermission: mocks.assertProjectPermission,
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? undefined,
	};
});

const { Permissions } = await import("@repo/permissions");
const { createTimeEntryInputSchema, createTimeEntryProcedure } = await import(
	"../create-entry"
);
const { updateTimeEntryInputSchema, updateTimeEntryProcedure } = await import(
	"../update-entry"
);
const { deleteTimeEntryInputSchema, deleteTimeEntryProcedure } = await import(
	"../delete-entry"
);
const { listTimeEntriesInputSchema, listTimeEntriesProcedure } = await import(
	"../list-entries"
);
const { listTimeEntriesForStoryInputSchema, listTimeEntriesForStoryProcedure } =
	await import("../list-for-story");
const { listLoggableProjectsInputSchema, listLoggableProjectsProcedure } =
	await import("../list-loggable-projects");

type StubbedProcedure = { __handler: Handler; __declared: Declaration[] };

function stub(procedure: unknown): StubbedProcedure {
	return procedure as StubbedProcedure;
}

const USER_ID = "user-1";
const ORG_ID = "org-1";
const USER_NAME = "Ada Example";
const context = {
	user: { id: USER_ID, name: USER_NAME },
	session: { activeOrganizationId: ORG_ID },
};

function call(
	procedure: unknown,
	schema: { parse: (input: unknown) => unknown },
	input: unknown,
) {
	return stub(procedure).__handler({ input: schema.parse(input), context });
}

const policyOff = { timeRequireStartStop: false, timeDefaultBillable: null };

function project(
	overrides: Partial<{
		id: string;
		organizationId: string | null;
		deletedAt: Date | null;
		status: "DRAFT" | "ACTIVE" | "ARCHIVED" | "COMPLETED";
		timeRequireStartStop: boolean;
		timeDefaultBillable: boolean | null;
		organization: {
			timeRequireStartStop: boolean;
			timeDefaultBillable: boolean | null;
		} | null;
	}> = {},
) {
	return {
		id: "project-a",
		name: "Project A",
		organizationId: ORG_ID,
		deletedAt: null,
		status: "ACTIVE",
		billingModel: "TIME_AND_MATERIALS",
		...policyOff,
		organization: policyOff,
		...overrides,
	};
}

function entryRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "entry-1",
		organizationId: ORG_ID,
		projectId: "project-a",
		projectName: "Project A",
		userId: USER_ID,
		workDate: "2026-11-10",
		timezone: "Europe/Berlin",
		durationMinutes: 60,
		startAt: null,
		stopAt: null,
		activity: "DEVELOPMENT",
		billable: true,
		description: null,
		storyId: null,
		storyIdentifier: null,
		storyTitle: null,
		startStopRequired: false,
		createdAt: new Date("2026-11-10T08:00:00Z"),
		updatedAt: new Date("2026-11-10T08:00:00Z"),
		...overrides,
	};
}

/** The row a write returns: what it was given, as the query layer shapes it. */
function echoWrite(params: { values: Record<string, unknown> }) {
	return Promise.resolve(entryRow({ ...params.values, id: "entry-new" }));
}

const createInput = {
	projectId: "project-a",
	workDate: "2026-11-10",
	timezone: "Europe/Berlin",
	activity: "DEVELOPMENT",
	durationMinutes: 90,
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.loadTimeTrackingProject.mockResolvedValue(project());
	mocks.listAuthorTimeEntriesOnWorkDate.mockResolvedValue([]);
	mocks.findUserProfileTimeZone.mockResolvedValue(null);
	mocks.findStoryForTimeEntry.mockResolvedValue(null);
	mocks.createTimeEntry.mockImplementation(echoWrite);
	mocks.updateTimeEntry.mockImplementation(echoWrite);
	mocks.deleteTimeEntry.mockResolvedValue(true);
	mocks.hasProjectAccess.mockResolvedValue(true);
	mocks.assertProjectPermission.mockResolvedValue({
		projectId: "project-a",
		organizationId: ORG_ID,
	});
});

describe("entry input schema", () => {
	it.each([0, -30, 1441, 1.5])("refuses a duration of %d", (minutes) => {
		expect(
			createTimeEntryInputSchema.safeParse({
				...createInput,
				durationMinutes: minutes,
			}).success,
		).toBe(false);
	});

	it("refuses a start without a stop", () => {
		expect(
			createTimeEntryInputSchema.safeParse({
				...createInput,
				startAt: "2026-11-10T09:00:00+01:00",
			}).success,
		).toBe(false);
	});

	it.each([
		["a time zone that is not one", { timezone: "Mars/Olympus" }],
		["a work date that is not a date", { workDate: "2026-02-30" }],
		["an activity outside the list", { activity: "NAPPING" }],
		[
			"a start time without an offset",
			{
				startAt: "2026-11-10T09:00:00",
				stopAt: "2026-11-10T10:00:00",
			},
		],
	])("refuses %s", (_label, overrides) => {
		expect(
			createTimeEntryInputSchema.safeParse({
				...createInput,
				...overrides,
			}).success,
		).toBe(false);
	});

	it("defaults the acknowledged warnings to none", () => {
		expect(createTimeEntryInputSchema.parse(createInput)).toMatchObject({
			acknowledgedWarnings: [],
		});
	});

	it("bounds the description", () => {
		expect(
			createTimeEntryInputSchema.safeParse({
				...createInput,
				description: "x".repeat(10_001),
			}).success,
		).toBe(false);
	});
});

describe("createEntry", () => {
	it("is gated on seeing the project, then TIME_LOG for it", () => {
		expect(stub(createTimeEntryProcedure).__declared).toEqual([
			VISIBLE,
			{ kind: "project", permission: Permissions.TIME_LOG },
		]);
	});

	it("saves a duration-only entry under the current policy", async () => {
		const result = await call(
			createTimeEntryProcedure,
			createTimeEntryInputSchema,
			createInput,
		);

		expect(result.status).toBe("saved");
		expect(mocks.createTimeEntry).toHaveBeenCalledWith({
			organizationId: ORG_ID,
			userId: USER_ID,
			values: expect.objectContaining({
				projectId: "project-a",
				workDate: "2026-11-10",
				durationMinutes: 90,
				startAt: null,
				stopAt: null,
				billable: true,
				startStopRequired: false,
				storyId: null,
			}),
		});
	});

	it("saves the author's current name with the entry", async () => {
		await call(
			createTimeEntryProcedure,
			createTimeEntryInputSchema,
			createInput,
		);

		expect(
			mocks.createTimeEntry.mock.calls[0][0].values.userNameSnapshot,
		).toBe(USER_NAME);
	});

	it("takes the billable default from the policy when none is given", async () => {
		mocks.loadTimeTrackingProject.mockResolvedValue(
			project({ timeDefaultBillable: false }),
		);

		await call(
			createTimeEntryProcedure,
			createTimeEntryInputSchema,
			createInput,
		);

		expect(mocks.createTimeEntry.mock.calls[0][0].values.billable).toBe(
			false,
		);
	});

	it("requires start and stop when the organization requires them", async () => {
		mocks.loadTimeTrackingProject.mockResolvedValue(
			project({
				organization: {
					timeRequireStartStop: true,
					timeDefaultBillable: null,
				},
			}),
		);

		await expect(
			call(
				createTimeEntryProcedure,
				createTimeEntryInputSchema,
				createInput,
			),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.createTimeEntry).not.toHaveBeenCalled();
	});

	it("computes the duration from start and stop, ignoring the client's", async () => {
		mocks.loadTimeTrackingProject.mockResolvedValue(
			project({ timeRequireStartStop: true }),
		);

		await call(createTimeEntryProcedure, createTimeEntryInputSchema, {
			...createInput,
			durationMinutes: 5,
			startAt: "2026-11-10T09:00:00+01:00",
			stopAt: "2026-11-10T10:30:00+01:00",
		});

		expect(mocks.createTimeEntry.mock.calls[0][0].values).toMatchObject({
			durationMinutes: 90,
			startAt: new Date("2026-11-10T08:00:00Z"),
			stopAt: new Date("2026-11-10T09:30:00Z"),
			startStopRequired: true,
		});
	});

	it("refuses a stop that is not after the start", async () => {
		await expect(
			call(createTimeEntryProcedure, createTimeEntryInputSchema, {
				...createInput,
				startAt: "2026-11-10T10:00:00+01:00",
				stopAt: "2026-11-10T09:00:00+01:00",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.createTimeEntry).not.toHaveBeenCalled();
	});

	it("refuses times that span more than a day", async () => {
		await expect(
			call(createTimeEntryProcedure, createTimeEntryInputSchema, {
				...createInput,
				startAt: "2026-11-10T09:00:00+01:00",
				stopAt: "2026-11-11T09:01:00+01:00",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("refuses a work item from another project", async () => {
		mocks.findStoryForTimeEntry.mockResolvedValue(null);

		await expect(
			call(createTimeEntryProcedure, createTimeEntryInputSchema, {
				...createInput,
				storyId: "story-of-project-b",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.findStoryForTimeEntry).toHaveBeenCalledWith({
			projectId: "project-a",
			storyId: "story-of-project-b",
		});
		expect(mocks.createTimeEntry).not.toHaveBeenCalled();
	});

	it("stores a snapshot of the work item", async () => {
		mocks.findStoryForTimeEntry.mockResolvedValue({
			id: "story-1",
			identifier: "F-012",
			title: "Import CSV",
		});

		await call(createTimeEntryProcedure, createTimeEntryInputSchema, {
			...createInput,
			storyId: "story-1",
		});

		expect(mocks.createTimeEntry.mock.calls[0][0].values).toMatchObject({
			storyId: "story-1",
			storyIdentifier: "F-012",
			storyTitle: "Import CSV",
		});
	});

	it.each(["DRAFT", "ARCHIVED", "COMPLETED"] as const)(
		"refuses a %s project as not found",
		async (status) => {
			mocks.loadTimeTrackingProject.mockResolvedValue(
				project({ status }),
			);

			await expect(
				call(
					createTimeEntryProcedure,
					createTimeEntryInputSchema,
					createInput,
				),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			expect(mocks.createTimeEntry).not.toHaveBeenCalled();
		},
	);

	it("refuses a soft-deleted project as not found", async () => {
		mocks.loadTimeTrackingProject.mockResolvedValue(
			project({ deletedAt: new Date("2026-11-01T00:00:00Z") }),
		);

		await expect(
			call(
				createTimeEntryProcedure,
				createTimeEntryInputSchema,
				createInput,
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("returns warnings without writing, then saves once they are acknowledged", async () => {
		mocks.listAuthorTimeEntriesOnWorkDate.mockResolvedValue([
			{
				id: "entry-earlier",
				projectId: "project-a",
				workDate: "2026-11-10",
				durationMinutes: 90,
				startAt: null,
				stopAt: null,
				activity: "DEVELOPMENT",
				storyId: null,
				description: null,
			},
			{
				id: "entry-other-project",
				projectId: "project-b",
				workDate: "2026-11-10",
				durationMinutes: 800,
				startAt: null,
				stopAt: null,
				activity: "MEETINGS_COLLABORATION",
				storyId: null,
				description: "Workshop",
			},
		]);

		const first = await call(
			createTimeEntryProcedure,
			createTimeEntryInputSchema,
			createInput,
		);
		expect(first).toEqual({
			status: "needs_confirmation",
			warnings: [
				{ code: "LIKELY_DUPLICATE", entryIds: ["entry-earlier"] },
				{
					code: "OVER_DAILY_LIMIT",
					totalMinutes: 980,
					limitMinutes: 960,
				},
			],
		});
		expect(mocks.createTimeEntry).not.toHaveBeenCalled();

		const partly = await call(
			createTimeEntryProcedure,
			createTimeEntryInputSchema,
			{ ...createInput, acknowledgedWarnings: ["LIKELY_DUPLICATE"] },
		);
		expect(partly.status).toBe("needs_confirmation");
		expect(mocks.createTimeEntry).not.toHaveBeenCalled();

		const confirmed = await call(
			createTimeEntryProcedure,
			createTimeEntryInputSchema,
			{
				...createInput,
				acknowledgedWarnings: ["LIKELY_DUPLICATE", "OVER_DAILY_LIMIT"],
			},
		);
		expect(confirmed.status).toBe("saved");
		expect(mocks.createTimeEntry).toHaveBeenCalledTimes(1);
		expect(mocks.listAuthorTimeEntriesOnWorkDate).toHaveBeenCalledWith({
			organizationId: ORG_ID,
			userId: USER_ID,
			workDate: "2026-11-10",
			overlapping: null,
		});
	});

	it("warns about a timed entry on another project and work date that overlaps the new one", async () => {
		mocks.listAuthorTimeEntriesOnWorkDate.mockResolvedValue([
			{
				id: "entry-overnight",
				projectId: "project-b",
				workDate: "2026-11-09",
				durationMinutes: 180,
				startAt: new Date("2026-11-09T22:00:00.000Z"),
				stopAt: new Date("2026-11-10T01:00:00.000Z"),
				activity: "OTHER",
				storyId: null,
				description: "Release night",
			},
		]);

		const result = await call(
			createTimeEntryProcedure,
			createTimeEntryInputSchema,
			{
				...createInput,
				startAt: "2026-11-10T00:00:00.000Z",
				stopAt: "2026-11-10T01:30:00.000Z",
			},
		);

		expect(result).toEqual({
			status: "needs_confirmation",
			warnings: [
				{ code: "LIKELY_DUPLICATE", entryIds: ["entry-overnight"] },
			],
		});
		expect(mocks.listAuthorTimeEntriesOnWorkDate).toHaveBeenCalledWith({
			organizationId: ORG_ID,
			userId: USER_ID,
			workDate: "2026-11-10",
			overlapping: {
				startAt: new Date("2026-11-10T00:00:00.000Z"),
				stopAt: new Date("2026-11-10T01:30:00.000Z"),
			},
		});
	});
});

const updateInput = { ...createInput, entryId: "entry-1" };

describe("updateEntry", () => {
	it("is gated on seeing the destination project, then TIME_LOG for it", () => {
		expect(stub(updateTimeEntryProcedure).__declared).toEqual([
			VISIBLE,
			{ kind: "project", permission: Permissions.TIME_LOG },
		]);
	});

	it("answers NOT_FOUND for another user's entry and writes nothing", async () => {
		mocks.findTimeEntryForAuthor.mockResolvedValue(null);

		await expect(
			call(
				updateTimeEntryProcedure,
				updateTimeEntryInputSchema,
				updateInput,
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.findTimeEntryForAuthor).toHaveBeenCalledWith({
			id: "entry-1",
			userId: USER_ID,
		});
		expect(mocks.updateTimeEntry).not.toHaveBeenCalled();
	});

	it("validates against the policy the entry was saved under, not the current one", async () => {
		mocks.findTimeEntryForAuthor.mockResolvedValue(
			entryRow({ startStopRequired: false }),
		);
		mocks.loadTimeTrackingProject.mockResolvedValue(
			project({ timeRequireStartStop: true }),
		);

		const result = await call(
			updateTimeEntryProcedure,
			updateTimeEntryInputSchema,
			updateInput,
		);

		expect(result.status).toBe("saved");
		expect(mocks.updateTimeEntry.mock.calls[0][0]).toMatchObject({
			id: "entry-1",
			userId: USER_ID,
			values: { durationMinutes: 90, startStopRequired: false },
		});
		expect(mocks.assertProjectPermission).not.toHaveBeenCalled();
	});

	it("keeps requiring start and stop on an entry saved under that rule", async () => {
		mocks.findTimeEntryForAuthor.mockResolvedValue(
			entryRow({ startStopRequired: true }),
		);

		await expect(
			call(
				updateTimeEntryProcedure,
				updateTimeEntryInputSchema,
				updateInput,
			),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.updateTimeEntry).not.toHaveBeenCalled();
	});

	it("applies and captures the destination's policy when moving projects", async () => {
		mocks.findTimeEntryForAuthor.mockResolvedValue(
			entryRow({ projectId: "project-a", startStopRequired: false }),
		);
		mocks.loadTimeTrackingProject.mockResolvedValue(
			project({ id: "project-b", timeRequireStartStop: true }),
		);

		await expect(
			call(updateTimeEntryProcedure, updateTimeEntryInputSchema, {
				...updateInput,
				projectId: "project-b",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		await call(updateTimeEntryProcedure, updateTimeEntryInputSchema, {
			...updateInput,
			projectId: "project-b",
			startAt: "2026-11-10T09:00:00+01:00",
			stopAt: "2026-11-10T09:45:00+01:00",
		});

		expect(mocks.assertProjectPermission).toHaveBeenCalledWith(
			"project-a",
			USER_ID,
			Permissions.TIME_LOG,
		);
		expect(mocks.updateTimeEntry.mock.calls[0][0].values).toMatchObject({
			projectId: "project-b",
			durationMinutes: 45,
			startStopRequired: true,
		});
	});

	it("takes the destination's billable default when moving without one", async () => {
		mocks.findTimeEntryForAuthor.mockResolvedValue(
			entryRow({ projectId: "project-a", billable: true }),
		);
		mocks.loadTimeTrackingProject.mockResolvedValue(
			project({ id: "project-b", timeDefaultBillable: false }),
		);

		await call(updateTimeEntryProcedure, updateTimeEntryInputSchema, {
			...updateInput,
			projectId: "project-b",
		});

		expect(mocks.updateTimeEntry.mock.calls[0][0].values.billable).toBe(
			false,
		);
	});

	it("keeps the entry's billable flag when it stays on its project", async () => {
		mocks.findTimeEntryForAuthor.mockResolvedValue(
			entryRow({ billable: false }),
		);

		await call(
			updateTimeEntryProcedure,
			updateTimeEntryInputSchema,
			updateInput,
		);

		expect(mocks.updateTimeEntry.mock.calls[0][0].values.billable).toBe(
			false,
		);
	});

	it("refuses a move out of a project the caller lost access to", async () => {
		mocks.findTimeEntryForAuthor.mockResolvedValue(
			entryRow({ projectId: "project-a" }),
		);
		mocks.loadTimeTrackingProject.mockResolvedValue(
			project({ id: "project-b" }),
		);
		mocks.assertProjectPermission.mockRejectedValue(
			new ORPCError("NOT_FOUND", { message: "Project not found" }),
		);

		await expect(
			call(updateTimeEntryProcedure, updateTimeEntryInputSchema, {
				...updateInput,
				projectId: "project-b",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.updateTimeEntry).not.toHaveBeenCalled();
	});

	it("refuses a move out of a project the caller can no longer see", async () => {
		mocks.findTimeEntryForAuthor.mockResolvedValue(
			entryRow({ projectId: "project-a" }),
		);
		mocks.loadTimeTrackingProject.mockResolvedValue(
			project({ id: "project-b" }),
		);
		mocks.hasProjectAccess.mockResolvedValue(false);

		await expect(
			call(updateTimeEntryProcedure, updateTimeEntryInputSchema, {
				...updateInput,
				projectId: "project-b",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.hasProjectAccess).toHaveBeenCalledWith(
			"project-a",
			USER_ID,
		);
		expect(mocks.assertProjectPermission).not.toHaveBeenCalled();
		expect(mocks.updateTimeEntry).not.toHaveBeenCalled();
	});

	it("still edits an entry in place after its project was archived", async () => {
		mocks.findTimeEntryForAuthor.mockResolvedValue(entryRow());
		mocks.loadTimeTrackingProject.mockResolvedValue(
			project({ status: "ARCHIVED" }),
		);

		const result = await call(
			updateTimeEntryProcedure,
			updateTimeEntryInputSchema,
			{ ...updateInput, durationMinutes: 30 },
		);

		expect(result.status).toBe("saved");
		expect(mocks.updateTimeEntry.mock.calls[0][0].values).toMatchObject({
			projectId: "project-a",
			durationMinutes: 30,
		});
	});

	it("refuses a move to a project that is not active", async () => {
		mocks.findTimeEntryForAuthor.mockResolvedValue(entryRow());
		mocks.loadTimeTrackingProject.mockResolvedValue(
			project({ id: "project-b", status: "COMPLETED" }),
		);

		await expect(
			call(updateTimeEntryProcedure, updateTimeEntryInputSchema, {
				...updateInput,
				projectId: "project-b",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.updateTimeEntry).not.toHaveBeenCalled();
	});

	it("refuses a move to another organization's project", async () => {
		mocks.findTimeEntryForAuthor.mockResolvedValue(entryRow());
		mocks.loadTimeTrackingProject.mockResolvedValue(
			project({ id: "project-z", organizationId: "org-2" }),
		);

		await expect(
			call(updateTimeEntryProcedure, updateTimeEntryInputSchema, {
				...updateInput,
				projectId: "project-z",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.updateTimeEntry).not.toHaveBeenCalled();
	});

	it("does not count the entry being edited toward the daily total", async () => {
		mocks.findTimeEntryForAuthor.mockResolvedValue(
			entryRow({ durationMinutes: 900 }),
		);
		mocks.listAuthorTimeEntriesOnWorkDate.mockResolvedValue([
			{
				id: "entry-1",
				projectId: "project-a",
				workDate: "2026-11-10",
				durationMinutes: 900,
				startAt: null,
				stopAt: null,
				activity: "DEVELOPMENT",
				storyId: null,
				description: null,
			},
		]);

		const result = await call(
			updateTimeEntryProcedure,
			updateTimeEntryInputSchema,
			{ ...updateInput, durationMinutes: 960 },
		);

		expect(result).toMatchObject({ status: "saved", warnings: [] });
	});

	it("refreshes the work item snapshot when the link changes", async () => {
		mocks.findTimeEntryForAuthor.mockResolvedValue(
			entryRow({
				storyId: "story-1",
				storyIdentifier: "F-001",
				storyTitle: "Old title",
			}),
		);
		mocks.findStoryForTimeEntry.mockResolvedValue({
			id: "story-2",
			identifier: "F-002",
			title: "Export CSV",
		});

		await call(updateTimeEntryProcedure, updateTimeEntryInputSchema, {
			...updateInput,
			storyId: "story-2",
		});

		expect(mocks.updateTimeEntry.mock.calls[0][0].values).toMatchObject({
			storyId: "story-2",
			storyIdentifier: "F-002",
			storyTitle: "Export CSV",
		});
	});

	it("keeps the saved snapshot when the link is unchanged", async () => {
		mocks.findTimeEntryForAuthor.mockResolvedValue(
			entryRow({
				storyId: "story-1",
				storyIdentifier: "F-001",
				storyTitle: "Title when logged",
			}),
		);

		await call(updateTimeEntryProcedure, updateTimeEntryInputSchema, {
			...updateInput,
			storyId: "story-1",
		});

		expect(mocks.findStoryForTimeEntry).not.toHaveBeenCalled();
		expect(mocks.updateTimeEntry.mock.calls[0][0].values).toMatchObject({
			storyId: "story-1",
			storyIdentifier: "F-001",
			storyTitle: "Title when logged",
		});
	});

	it("refreshes the author's saved name", async () => {
		mocks.findTimeEntryForAuthor.mockResolvedValue(entryRow());

		await call(
			updateTimeEntryProcedure,
			updateTimeEntryInputSchema,
			updateInput,
		);

		expect(
			mocks.updateTimeEntry.mock.calls[0][0].values.userNameSnapshot,
		).toBe(USER_NAME);
	});
});

describe("deleteEntry", () => {
	it("declares TIME_LOG through the handler-side project check", async () => {
		mocks.findTimeEntryForAuthor.mockResolvedValue(entryRow());

		await call(deleteTimeEntryProcedure, deleteTimeEntryInputSchema, {
			entryId: "entry-1",
		});

		expect(mocks.assertProjectPermission).toHaveBeenCalledWith(
			"project-a",
			USER_ID,
			Permissions.TIME_LOG,
		);
		expect(mocks.deleteTimeEntry).toHaveBeenCalledWith({
			id: "entry-1",
			userId: USER_ID,
		});
	});

	it("answers NOT_FOUND for another user's entry and deletes nothing", async () => {
		mocks.findTimeEntryForAuthor.mockResolvedValue(null);

		await expect(
			call(deleteTimeEntryProcedure, deleteTimeEntryInputSchema, {
				entryId: "entry-1",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.assertProjectPermission).not.toHaveBeenCalled();
		expect(mocks.deleteTimeEntry).not.toHaveBeenCalled();
	});

	it("refuses when the caller lost TIME_LOG on the entry's project", async () => {
		mocks.findTimeEntryForAuthor.mockResolvedValue(entryRow());
		mocks.assertProjectPermission.mockRejectedValue(
			new ORPCError("FORBIDDEN", {
				message: "Missing required permission",
			}),
		);

		await expect(
			call(deleteTimeEntryProcedure, deleteTimeEntryInputSchema, {
				entryId: "entry-1",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.deleteTimeEntry).not.toHaveBeenCalled();
	});

	it("answers NOT_FOUND when the caller can no longer see the entry's project", async () => {
		mocks.findTimeEntryForAuthor.mockResolvedValue(entryRow());
		mocks.hasProjectAccess.mockResolvedValue(false);

		await expect(
			call(deleteTimeEntryProcedure, deleteTimeEntryInputSchema, {
				entryId: "entry-1",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.hasProjectAccess).toHaveBeenCalledWith(
			"project-a",
			USER_ID,
		);
		expect(mocks.assertProjectPermission).not.toHaveBeenCalled();
		expect(mocks.deleteTimeEntry).not.toHaveBeenCalled();
	});
});

function accessProject(
	id: string,
	member: {
		role: string;
		acceptedAt: Date | null;
		expiresAt: Date | null;
	} | null,
	overrides: Record<string, unknown> = {},
) {
	return {
		id,
		name: `Project ${id}`,
		billingModel: "FIXED_BID",
		...policyOff,
		member,
		ownedByCaller: false,
		...overrides,
	};
}

const accepted = new Date("2026-01-01T00:00:00Z");

describe("listEntries", () => {
	const input = {
		organizationId: ORG_ID,
		from: "2026-11-09",
		to: "2026-11-15",
	};

	it("is gated on membership of the named organization", () => {
		expect(stub(listTimeEntriesProcedure).__declared).toEqual([
			{
				kind: "input-org",
				permission: Permissions.PROJECT_READ,
				options: { requireOrganization: true },
			},
		]);
	});

	it.each([
		["more than 31 days", { from: "2026-11-01", to: "2026-12-02" }],
		["an end before the start", { from: "2026-11-10", to: "2026-11-09" }],
		["a date that is not one", { from: "2026-11-31", to: "2026-12-01" }],
	])("refuses a range of %s", (_label, range) => {
		expect(
			listTimeEntriesInputSchema.safeParse({ ...input, ...range })
				.success,
		).toBe(false);
	});

	it("accepts exactly 31 days", () => {
		expect(
			listTimeEntriesInputSchema.safeParse({
				...input,
				from: "2026-11-01",
				to: "2026-12-01",
			}).success,
		).toBe(true);
	});

	it("hides entries on projects the caller can no longer access", async () => {
		mocks.listTimeEntriesForAuthor.mockResolvedValue([
			entryRow({
				id: "kept",
				projectId: "project-a",
				durationMinutes: 30,
			}),
			entryRow({
				id: "hidden",
				projectId: "project-gone",
				durationMinutes: 45,
			}),
		]);
		// The caller is a guest of project-a only; project-gone is either
		// deleted (absent) or no longer theirs.
		mocks.listTimeAccessRows.mockResolvedValue({
			organizationRole: null,
			organization: policyOff,
			projects: [
				accessProject("project-a", {
					role: "EDITOR",
					acceptedAt: accepted,
					expiresAt: null,
				}),
				accessProject("project-gone", {
					role: "EDITOR",
					acceptedAt: accepted,
					expiresAt: new Date("2026-02-01T00:00:00Z"),
				}),
			],
		});

		const result = await call(
			listTimeEntriesProcedure,
			listTimeEntriesInputSchema,
			input,
		);

		expect(result.entries.map((entry: { id: string }) => entry.id)).toEqual(
			["kept"],
		);
		expect(result.totalMinutes).toBe(30);
		expect(mocks.listTimeEntriesForAuthor).toHaveBeenCalledWith({
			organizationId: ORG_ID,
			userId: USER_ID,
			from: "2026-11-09",
			to: "2026-11-15",
		});
		expect(mocks.listTimeAccessRows).toHaveBeenCalledWith({
			organizationId: ORG_ID,
			userId: USER_ID,
			projects: { ids: ["project-a", "project-gone"] },
		});
	});

	it("still lists an entry whose project was archived after it was logged", async () => {
		mocks.listTimeEntriesForAuthor.mockResolvedValue([
			entryRow({ id: "on-archived", projectId: "project-archived" }),
		]);
		// Read by id, so the query does not filter by status and returns it.
		mocks.listTimeAccessRows.mockResolvedValue({
			organizationRole: "member",
			organization: policyOff,
			projects: [
				accessProject("project-archived", null, {
					ownedByCaller: true,
				}),
			],
		});

		const result = await call(
			listTimeEntriesProcedure,
			listTimeEntriesInputSchema,
			input,
		);

		expect(result.entries.map((entry: { id: string }) => entry.id)).toEqual(
			["on-archived"],
		);
		expect(mocks.listTimeAccessRows.mock.calls[0][0].projects).toEqual({
			ids: ["project-archived"],
		});
	});

	it("serializes instants and work dates for the wire", async () => {
		mocks.listTimeEntriesForAuthor.mockResolvedValue([
			entryRow({
				startAt: new Date("2026-11-10T08:00:00Z"),
				stopAt: new Date("2026-11-10T09:00:00Z"),
			}),
		]);
		mocks.listTimeAccessRows.mockResolvedValue({
			organizationRole: "member",
			organization: policyOff,
			projects: [
				accessProject("project-a", null, { ownedByCaller: true }),
			],
		});

		const result = await call(
			listTimeEntriesProcedure,
			listTimeEntriesInputSchema,
			input,
		);

		expect(result.entries[0]).toMatchObject({
			workDate: "2026-11-10",
			startAt: "2026-11-10T08:00:00.000Z",
			stopAt: "2026-11-10T09:00:00.000Z",
			createdAt: "2026-11-10T08:00:00.000Z",
		});
	});
});

describe("listLoggableProjects", () => {
	it("is gated on membership of the named organization", () => {
		expect(stub(listLoggableProjectsProcedure).__declared).toEqual([
			{
				kind: "input-org",
				permission: Permissions.PROJECT_READ,
				options: { requireOrganization: true },
			},
		]);
	});

	it("lists only the projects where the caller holds TIME_LOG, with their policy", async () => {
		mocks.listTimeAccessRows.mockResolvedValue({
			organizationRole: "viewer",
			organization: {
				timeRequireStartStop: true,
				timeDefaultBillable: false,
			},
			projects: [
				// An Editor membership grants TIME_LOG to an organization viewer.
				accessProject(
					"editor",
					{ role: "EDITOR", acceptedAt: accepted, expiresAt: null },
					{ timeDefaultBillable: true },
				),
				// A Commenter membership is authoritative and does not.
				accessProject("commenter", {
					role: "COMMENTER",
					acceptedAt: accepted,
					expiresAt: null,
				}),
				// No membership: the viewer organization role decides, and does not.
				accessProject("none", null),
				// A pending invitation does not count.
				accessProject("pending", {
					role: "EDITOR",
					acceptedAt: null,
					expiresAt: null,
				}),
			],
		});

		const result = await call(
			listLoggableProjectsProcedure,
			listLoggableProjectsInputSchema,
			{ organizationId: ORG_ID },
		);

		// Only ACTIVE projects are read; the status filter is pinned in the
		// query's own test.
		expect(mocks.listTimeAccessRows).toHaveBeenCalledWith({
			organizationId: ORG_ID,
			userId: USER_ID,
			projects: "loggable",
		});
		expect(result).toEqual({
			projects: [
				{
					id: "editor",
					name: "Project editor",
					billingModel: "FIXED_BID",
					startStopRequired: true,
					defaultBillable: true,
				},
			],
			profileTimeZone: null,
		});
	});

	it.each([
		["a real IANA zone", "America/New_York", "America/New_York"],
		["not a real zone", "Mars/Olympus_Mons", null],
		["not set", null, null],
	])(
		"returns the caller's profile time zone when it is %s",
		async (_label, stored, expected) => {
			mocks.listTimeAccessRows.mockResolvedValue({
				organizationRole: "member",
				organization: policyOff,
				projects: [],
			});
			mocks.findUserProfileTimeZone.mockResolvedValue(stored);

			const result = await call(
				listLoggableProjectsProcedure,
				listLoggableProjectsInputSchema,
				{ organizationId: ORG_ID },
			);

			expect(mocks.findUserProfileTimeZone).toHaveBeenCalledWith(USER_ID);
			expect(result.profileTimeZone).toBe(expected);
		},
	);

	it("offers a project without a membership row only to the member who created it", async () => {
		const expired = {
			role: "VIEWER",
			acceptedAt: accepted,
			expiresAt: new Date("2026-02-01T00:00:00Z"),
		};
		mocks.listTimeAccessRows.mockResolvedValue({
			organizationRole: "member",
			organization: policyOff,
			projects: [
				accessProject("created", null, { ownedByCaller: true }),
				// An expired membership falls back to the organization role
				// for the project's creator.
				accessProject("created-expired", expired, {
					ownedByCaller: true,
				}),
				// Somebody else's projects: the organization role alone does
				// not make them discoverable, so they are not offered.
				accessProject("others", null),
				accessProject("others-expired", expired),
			],
		});

		const result = await call(
			listLoggableProjectsProcedure,
			listLoggableProjectsInputSchema,
			{ organizationId: ORG_ID },
		);

		expect(result.projects.map((p: { id: string }) => p.id)).toEqual([
			"created",
			"created-expired",
		]);
	});

	it("does not offer another member's project to an organization owner", async () => {
		mocks.listTimeAccessRows.mockResolvedValue({
			organizationRole: "owner",
			organization: policyOff,
			projects: [accessProject("others", null)],
		});

		const result = await call(
			listLoggableProjectsProcedure,
			listLoggableProjectsInputSchema,
			{ organizationId: ORG_ID },
		);

		expect(result.projects).toEqual([]);
	});
});

describe("listForStory", () => {
	it("is gated on seeing the project, then reading it", () => {
		expect(stub(listTimeEntriesForStoryProcedure).__declared).toEqual([
			VISIBLE,
			{ kind: "project", permission: Permissions.PROJECT_READ },
		]);
	});

	it("reads entries on a completed project", async () => {
		mocks.loadTimeTrackingProject.mockResolvedValue(
			project({ status: "COMPLETED" }),
		);
		mocks.listTimeEntriesForAuthorStory.mockResolvedValue([
			entryRow({ storyId: "story-1" }),
		]);

		const result = await call(
			listTimeEntriesForStoryProcedure,
			listTimeEntriesForStoryInputSchema,
			{ projectId: "project-a", storyId: "story-1" },
		);

		expect(result.entries).toHaveLength(1);
	});

	it("returns the caller's entries on the work item and their total", async () => {
		mocks.listTimeEntriesForAuthorStory.mockResolvedValue([
			entryRow({ id: "e1", storyId: "story-1", durationMinutes: 30 }),
			entryRow({ id: "e2", storyId: "story-1", durationMinutes: 75 }),
		]);

		const result = await call(
			listTimeEntriesForStoryProcedure,
			listTimeEntriesForStoryInputSchema,
			{ projectId: "project-a", storyId: "story-1" },
		);

		expect(result.totalMinutes).toBe(105);
		expect(result.entries).toHaveLength(2);
		expect(mocks.listTimeEntriesForAuthorStory).toHaveBeenCalledWith({
			organizationId: ORG_ID,
			projectId: "project-a",
			storyId: "story-1",
			userId: USER_ID,
		});
	});
});
