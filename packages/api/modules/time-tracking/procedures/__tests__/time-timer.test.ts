/**
 * The timer procedures.
 *
 * Same two seams as `time-suggestions.test.ts`: input schemas parsed
 * directly, and handlers run over a stubbed procedure chain with the
 * `@repo/database` queries mocked. The pure rules and this module's own
 * `lib/` run for real, so a stop exercises the same timing, policy and
 * warning rules `createEntry` does.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ORPCError } from "@orpc/server";
import { ACTIVITY_ACTION_PREFIX } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findTimeTimerForOwner: vi.fn(),
	startTimeTimer: vi.fn(),
	pauseTimeTimer: vi.fn(),
	resumeTimeTimer: vi.fn(),
	updateTimeTimer: vi.fn(),
	stopTimeTimer: vi.fn(),
	findTimeTimerStop: vi.fn(),
	getTimeTrackingPreference: vi.fn(),
	setTimeTrackingPreference: vi.fn(),
	findOwnActivity: vi.fn(),
	loadTimeTrackingProject: vi.fn(),
	listAuthorTimeEntriesOnWorkDate: vi.fn(),
	findStoryForTimeEntry: vi.fn(),
	hasProjectAccess: vi.fn(),
	assertProjectPermission: vi.fn(),
	findUserProfileTimeZone: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		findTimeTimerForOwner: mocks.findTimeTimerForOwner,
		startTimeTimer: mocks.startTimeTimer,
		pauseTimeTimer: mocks.pauseTimeTimer,
		resumeTimeTimer: mocks.resumeTimeTimer,
		updateTimeTimer: mocks.updateTimeTimer,
		stopTimeTimer: mocks.stopTimeTimer,
		findTimeTimerStop: mocks.findTimeTimerStop,
		getTimeTrackingPreference: mocks.getTimeTrackingPreference,
		setTimeTrackingPreference: mocks.setTimeTrackingPreference,
		findOwnActivity: mocks.findOwnActivity,
		loadTimeTrackingProject: mocks.loadTimeTrackingProject,
		listAuthorTimeEntriesOnWorkDate: mocks.listAuthorTimeEntriesOnWorkDate,
		findStoryForTimeEntry: mocks.findStoryForTimeEntry,
		hasProjectAccess: mocks.hasProjectAccess,
		findUserProfileTimeZone: mocks.findUserProfileTimeZone,
	};
});

type Declaration = {
	kind: string;
	permission?: string;
	options?: { requireOrganization?: boolean };
};

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
const { getTimerInputSchema, getTimerProcedure } = await import("../timer-get");
const { startTimerInputSchema, startTimerProcedure } = await import(
	"../timer-start"
);
const {
	pauseTimerInputSchema,
	pauseTimerProcedure,
	resumeTimerInputSchema,
	resumeTimerProcedure,
} = await import("../timer-pause-resume");
const { updateTimerInputSchema, updateTimerProcedure } = await import(
	"../timer-update"
);
const { proposeTimerStopInputSchema, proposeTimerStopProcedure } = await import(
	"../timer-propose-stop"
);
const {
	discardTimerInputSchema,
	discardTimerProcedure,
	stopTimerInputSchema,
	stopTimerProcedure,
} = await import("../timer-stop");
const { setTimerPreferenceInputSchema, setTimerPreferenceProcedure } =
	await import("../timer-preference");
const { TIMER_ACTION_PREFIX } = await import("../../lib/timer");

type StubbedProcedure = { __handler: Handler; __declared: Declaration[] };

function stub(procedure: unknown): StubbedProcedure {
	return procedure as StubbedProcedure;
}

const USER_ID = "user-1";
const ORG_ID = "org-1";
const NOW = new Date("2026-11-10T12:00:00.000Z");
const context = {
	user: { id: USER_ID, name: "Ada Example" },
	session: { activeOrganizationId: ORG_ID },
};

function call(
	procedure: unknown,
	schema: { parse: (input: unknown) => unknown },
	input: unknown,
) {
	return stub(procedure).__handler({ input: schema.parse(input), context });
}

const ORG_GATE: Declaration = {
	kind: "input-org",
	permission: Permissions.PROJECT_READ,
	options: { requireOrganization: true },
};

const policyOff = { timeRequireStartStop: false, timeDefaultBillable: null };

function project(overrides: Record<string, unknown> = {}) {
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

function at(time: string): Date {
	return new Date(`2026-11-10T${time}:00.000Z`);
}

function timerRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "timer-1",
		organizationId: ORG_ID,
		projectId: "project-a",
		projectName: "Project A",
		activity: "DEVELOPMENT",
		storyId: null,
		storyIdentifier: null,
		storyTitle: null,
		description: "Timer work",
		billable: null,
		timezone: "UTC",
		status: "RUNNING",
		version: 3,
		createdAt: at("09:00"),
		updatedAt: at("09:00"),
		segments: [{ startAt: at("09:00"), stopAt: null }],
		...overrides,
	};
}

function entryRow(id: string, overrides: Record<string, unknown> = {}) {
	return {
		id,
		organizationId: ORG_ID,
		projectId: "project-a",
		projectName: "Project A",
		workDate: "2026-11-10",
		timezone: "UTC",
		durationMinutes: 60,
		startAt: null,
		stopAt: null,
		activity: "DEVELOPMENT",
		billable: true,
		description: "Timer work",
		storyId: null,
		storyIdentifier: null,
		storyTitle: null,
		startStopRequired: false,
		createdAt: NOW,
		updatedAt: NOW,
		...overrides,
	};
}

const DEFAULT_PREFERENCE = { timerWidget: "SHOWN", timerReminders: false };

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	mocks.loadTimeTrackingProject.mockResolvedValue(project());
	mocks.listAuthorTimeEntriesOnWorkDate.mockResolvedValue([]);
	mocks.findStoryForTimeEntry.mockResolvedValue(null);
	mocks.hasProjectAccess.mockResolvedValue(true);
	mocks.assertProjectPermission.mockResolvedValue({
		projectId: "project-a",
		organizationId: ORG_ID,
	});
	mocks.findTimeTimerForOwner.mockResolvedValue(timerRow());
	mocks.findTimeTimerStop.mockResolvedValue(null);
	mocks.getTimeTrackingPreference.mockResolvedValue(DEFAULT_PREFERENCE);
	mocks.findOwnActivity.mockResolvedValue(null);
	mocks.findUserProfileTimeZone.mockResolvedValue(null);
});

describe("timer procedures", () => {
	it.each([
		["get", getTimerProcedure],
		["start", startTimerProcedure],
		["pause", pauseTimerProcedure],
		["resume", resumeTimerProcedure],
		["update", updateTimerProcedure],
		["proposeStop", proposeTimerStopProcedure],
		["stop", stopTimerProcedure],
		["discard", discardTimerProcedure],
		["setPreference", setTimerPreferenceProcedure],
	])("%s is gated on organization membership", (_name, procedure) => {
		expect(stub(procedure).__declared).toEqual([ORG_GATE]);
	});

	it("are mounted where their audit actions share the prefix proposeStop leaves out", () => {
		// Read as text: importing the router would load every time-tracking
		// procedure, the Temporal client among them.
		const moduleRouter = readFileSync(
			resolve(__dirname, "../../router.ts"),
			"utf-8",
		);
		expect(moduleRouter).toMatch(
			/\n\ttimer: \{\n\t\tget: getTimerProcedure,/,
		);
		const rootRouter = readFileSync(
			resolve(__dirname, "../../../../orpc/router.ts"),
			"utf-8",
		);
		expect(rootRouter).toMatch(
			/timeTracking: lazyRouter\(\s*"timeTrackingRouter"/,
		);
		expect(TIMER_ACTION_PREFIX).toBe(
			`${ACTIVITY_ACTION_PREFIX}timeTracking.timer.`,
		);
	});
});

describe("get", () => {
	it("answers no timer with the default preference", async () => {
		mocks.findTimeTimerForOwner.mockResolvedValue(null);

		await expect(
			call(getTimerProcedure, getTimerInputSchema, {
				organizationId: ORG_ID,
			}),
		).resolves.toEqual({ timer: null, preference: DEFAULT_PREFERENCE });
		expect(mocks.findTimeTimerForOwner).toHaveBeenCalledWith({
			organizationId: ORG_ID,
			userId: USER_ID,
		});
	});

	it("computes the elapsed time over every segment, the open one up to now", async () => {
		mocks.findTimeTimerForOwner.mockResolvedValue(
			timerRow({
				segments: [
					{ startAt: at("08:00"), stopAt: at("08:30") },
					{ startAt: at("11:00"), stopAt: null },
				],
			}),
		);
		mocks.loadTimeTrackingProject.mockResolvedValue(
			project({ timeRequireStartStop: true, timeDefaultBillable: false }),
		);

		const { timer } = await call(getTimerProcedure, getTimerInputSchema, {
			organizationId: ORG_ID,
		});

		expect(timer).toMatchObject({
			id: "timer-1",
			version: 3,
			elapsedSeconds: 90 * 60,
			startStopRequired: true,
			defaultBillable: false,
			segments: [
				{
					startAt: "2026-11-10T08:00:00.000Z",
					stopAt: "2026-11-10T08:30:00.000Z",
				},
				{ startAt: "2026-11-10T11:00:00.000Z", stopAt: null },
			],
		});
		// The project is not checked: a timer on a project the caller lost
		// still shows, so it can be discarded.
		expect(mocks.assertProjectPermission).not.toHaveBeenCalled();
	});
});

describe("start", () => {
	const input = {
		organizationId: ORG_ID,
		projectId: "project-a",
		activity: "DEVELOPMENT",
		description: "  ",
		timezone: "Europe/Berlin",
	};

	it.each([
		["a real IANA zone", "America/New_York", "America/New_York"],
		["not a real zone", "Mars/Olympus_Mons", "Europe/Berlin"],
	])(
		"runs in the profile time zone when it is %s, else the browser's",
		async (_label, stored, expected) => {
			mocks.findUserProfileTimeZone.mockResolvedValue(stored);
			mocks.startTimeTimer.mockResolvedValue({
				status: "started",
				timer: timerRow({ version: 1 }),
			});

			await call(startTimerProcedure, startTimerInputSchema, input);

			expect(mocks.findUserProfileTimeZone).toHaveBeenCalledWith(USER_ID);
			expect(mocks.startTimeTimer.mock.calls[0][0].timezone).toBe(
				expected,
			);
		},
	);

	it("starts a timer on an ACTIVE project the caller can log time on", async () => {
		mocks.startTimeTimer.mockResolvedValue({
			status: "started",
			timer: timerRow({ version: 1 }),
		});

		const result = await call(
			startTimerProcedure,
			startTimerInputSchema,
			input,
		);

		expect(result).toMatchObject({
			timer: { id: "timer-1", version: 1 },
			preference: DEFAULT_PREFERENCE,
		});
		expect(mocks.startTimeTimer).toHaveBeenCalledWith({
			organizationId: ORG_ID,
			userId: USER_ID,
			timezone: "Europe/Berlin",
			startAt: NOW,
			values: {
				projectId: "project-a",
				activity: "DEVELOPMENT",
				description: null,
				billable: null,
				storyId: null,
				storyIdentifier: null,
				storyTitle: null,
			},
		});
		expect(mocks.assertProjectPermission).toHaveBeenCalledWith(
			"project-a",
			USER_ID,
			Permissions.TIME_LOG,
		);
	});

	it("refuses a second timer with CONFLICT carrying the current one", async () => {
		mocks.startTimeTimer.mockResolvedValue({
			status: "exists",
			timer: timerRow({ id: "timer-0", status: "PAUSED" }),
		});

		await expect(
			call(startTimerProcedure, startTimerInputSchema, input),
		).rejects.toMatchObject({
			code: "CONFLICT",
			data: { timer: { id: "timer-0", status: "PAUSED" } },
		});
	});

	it.each([
		["in another organization", project({ organizationId: "org-2" })],
		["archived", project({ status: "ARCHIVED" })],
		["soft-deleted", project({ deletedAt: NOW })],
	])("refuses a project %s as not found", async (_label, row) => {
		mocks.loadTimeTrackingProject.mockResolvedValue(row);

		await expect(
			call(startTimerProcedure, startTimerInputSchema, input),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.startTimeTimer).not.toHaveBeenCalled();
	});

	it("refuses a project the caller cannot see", async () => {
		mocks.hasProjectAccess.mockResolvedValue(false);

		await expect(
			call(startTimerProcedure, startTimerInputSchema, input),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.startTimeTimer).not.toHaveBeenCalled();
	});

	it("refuses without TIME_LOG on the project", async () => {
		mocks.assertProjectPermission.mockRejectedValue(
			new ORPCError("FORBIDDEN", { message: "Forbidden" }),
		);

		await expect(
			call(startTimerProcedure, startTimerInputSchema, input),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.startTimeTimer).not.toHaveBeenCalled();
	});

	it("refuses a work item of another project", async () => {
		await expect(
			call(startTimerProcedure, startTimerInputSchema, {
				...input,
				storyId: "story-elsewhere",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.startTimeTimer).not.toHaveBeenCalled();
	});

	it("refuses a time zone that is not one", () => {
		expect(
			startTimerInputSchema.safeParse({
				...input,
				timezone: "Mars/Olympus",
			}).success,
		).toBe(false);
	});
});

describe("pause and resume", () => {
	const input = { organizationId: ORG_ID, timerId: "timer-1", version: 3 };

	it("pauses the running timer at its version", async () => {
		mocks.pauseTimeTimer.mockResolvedValue(
			timerRow({
				status: "PAUSED",
				version: 4,
				segments: [{ startAt: at("09:00"), stopAt: NOW }],
			}),
		);

		const { timer } = await call(
			pauseTimerProcedure,
			pauseTimerInputSchema,
			input,
		);

		expect(timer).toMatchObject({ status: "PAUSED", version: 4 });
		expect(mocks.pauseTimeTimer).toHaveBeenCalledWith({
			timerId: "timer-1",
			organizationId: ORG_ID,
			userId: USER_ID,
			version: 3,
			at: NOW,
		});
	});

	it("answers a repeated pause with the paused timer, whatever version it names", async () => {
		mocks.findTimeTimerForOwner.mockResolvedValue(
			timerRow({ status: "PAUSED", version: 4 }),
		);

		const { timer } = await call(
			pauseTimerProcedure,
			pauseTimerInputSchema,
			input,
		);

		expect(timer).toMatchObject({ status: "PAUSED", version: 4 });
		expect(mocks.pauseTimeTimer).not.toHaveBeenCalled();
	});

	it("answers a repeated resume with the running timer", async () => {
		const { timer } = await call(
			resumeTimerProcedure,
			resumeTimerInputSchema,
			{ ...input, version: 1 },
		);

		expect(timer).toMatchObject({ status: "RUNNING", version: 3 });
		expect(mocks.resumeTimeTimer).not.toHaveBeenCalled();
	});

	it("refuses a stale version with CONFLICT carrying the current timer", async () => {
		mocks.findTimeTimerForOwner.mockResolvedValue(
			timerRow({ status: "PAUSED", version: 5 }),
		);

		await expect(
			call(resumeTimerProcedure, resumeTimerInputSchema, input),
		).rejects.toMatchObject({
			code: "CONFLICT",
			data: { timer: { status: "PAUSED", version: 5 } },
		});
		expect(mocks.resumeTimeTimer).not.toHaveBeenCalled();
	});

	it("answers like a repeat when a concurrent pause won the race", async () => {
		mocks.pauseTimeTimer.mockResolvedValue(null);
		mocks.findTimeTimerForOwner
			.mockResolvedValueOnce(timerRow())
			.mockResolvedValueOnce(timerRow({ status: "PAUSED", version: 4 }));

		const { timer } = await call(
			pauseTimerProcedure,
			pauseTimerInputSchema,
			input,
		);

		expect(timer).toMatchObject({ status: "PAUSED", version: 4 });
	});

	it("answers CONFLICT when the timer changed otherwise between read and write", async () => {
		mocks.pauseTimeTimer.mockResolvedValue(null);
		mocks.findTimeTimerForOwner
			.mockResolvedValueOnce(timerRow())
			.mockResolvedValueOnce(timerRow({ version: 5 }));

		await expect(
			call(pauseTimerProcedure, pauseTimerInputSchema, input),
		).rejects.toMatchObject({
			code: "CONFLICT",
			data: { timer: { version: 5 } },
		});
	});

	it("answers NOT_FOUND when the caller has no timer, whoever's id is named", async () => {
		mocks.findTimeTimerForOwner.mockResolvedValue(null);

		await expect(
			call(pauseTimerProcedure, pauseTimerInputSchema, {
				...input,
				timerId: "someone-elses-timer",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.findTimeTimerForOwner).toHaveBeenCalledWith({
			organizationId: ORG_ID,
			userId: USER_ID,
		});
	});

	it("answers CONFLICT with the caller's own timer when another id is named", async () => {
		await expect(
			call(pauseTimerProcedure, pauseTimerInputSchema, {
				...input,
				timerId: "someone-elses-timer",
			}),
		).rejects.toMatchObject({
			code: "CONFLICT",
			data: { timer: { id: "timer-1" } },
		});
		expect(mocks.pauseTimeTimer).not.toHaveBeenCalled();
	});

	it("refuses once the caller lost TIME_LOG on the timer's project", async () => {
		mocks.assertProjectPermission.mockRejectedValue(
			new ORPCError("FORBIDDEN", { message: "Forbidden" }),
		);

		await expect(
			call(pauseTimerProcedure, pauseTimerInputSchema, input),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.pauseTimeTimer).not.toHaveBeenCalled();
	});
});

describe("update", () => {
	const input = { organizationId: ORG_ID, timerId: "timer-1", version: 3 };

	it("keeps every field left out and clears the billable choice on null", async () => {
		mocks.findTimeTimerForOwner.mockResolvedValue(
			timerRow({
				billable: false,
				storyId: "story-1",
				storyIdentifier: "F-1",
				storyTitle: "Login",
			}),
		);
		mocks.updateTimeTimer.mockResolvedValue(timerRow({ version: 4 }));

		await call(updateTimerProcedure, updateTimerInputSchema, {
			...input,
			activity: "TESTING",
			billable: null,
		});

		expect(mocks.updateTimeTimer).toHaveBeenCalledWith({
			timerId: "timer-1",
			organizationId: ORG_ID,
			userId: USER_ID,
			version: 3,
			values: {
				projectId: "project-a",
				activity: "TESTING",
				description: "Timer work",
				billable: null,
				storyId: "story-1",
				storyIdentifier: "F-1",
				storyTitle: "Login",
			},
		});
		expect(mocks.findStoryForTimeEntry).not.toHaveBeenCalled();
	});

	it("moving to another project checks it like a start and clears the work item", async () => {
		mocks.findTimeTimerForOwner.mockResolvedValue(
			timerRow({ storyId: "story-1", storyIdentifier: "F-1" }),
		);
		mocks.loadTimeTrackingProject.mockResolvedValue(
			project({ id: "project-b" }),
		);
		mocks.updateTimeTimer.mockResolvedValue(timerRow({ version: 4 }));

		await call(updateTimerProcedure, updateTimerInputSchema, {
			...input,
			projectId: "project-b",
		});

		expect(mocks.assertProjectPermission).toHaveBeenCalledWith(
			"project-b",
			USER_ID,
			Permissions.TIME_LOG,
		);
		expect(mocks.updateTimeTimer.mock.calls[0][0].values).toMatchObject({
			projectId: "project-b",
			storyId: null,
			storyIdentifier: null,
		});
	});

	it("refuses a stale version with CONFLICT", async () => {
		await expect(
			call(updateTimerProcedure, updateTimerInputSchema, {
				...input,
				version: 2,
				activity: "TESTING",
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(mocks.updateTimeTimer).not.toHaveBeenCalled();
	});

	it("answers CONFLICT when the write lost a race", async () => {
		mocks.updateTimeTimer.mockResolvedValue(null);

		await expect(
			call(updateTimerProcedure, updateTimerInputSchema, {
				...input,
				activity: "TESTING",
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});
});

describe("proposeStop", () => {
	const input = { organizationId: ORG_ID };

	function propose() {
		return call(
			proposeTimerStopProcedure,
			proposeTimerStopInputSchema,
			input,
		);
	}

	/** The newest activity before the last 15 minutes, and the first within them. */
	function activity(
		before: { action: string; createdAt: Date } | null,
		returned: Date | null = null,
	) {
		mocks.findOwnActivity.mockImplementation(
			async ({ pick }: { pick: "newest" | "oldest" }) =>
				pick === "newest"
					? before
					: returned && {
							action: "activity.projects.recordVisit",
							createdAt: returned,
						},
		);
	}

	it("reads activity since the first start, split at 15 minutes ago, leaving the timer's own actions out", async () => {
		mocks.findTimeTimerForOwner.mockResolvedValue(
			timerRow({
				segments: [
					{ startAt: at("08:00"), stopAt: at("08:30") },
					{ startAt: at("11:00"), stopAt: null },
				],
			}),
		);

		await propose();

		const scope = {
			organizationId: ORG_ID,
			userId: USER_ID,
			excludeActionPrefix: "activity.timeTracking.timer.",
		};
		expect(mocks.findOwnActivity).toHaveBeenCalledWith({
			...scope,
			after: at("08:00"),
			before: at("11:45"),
			pick: "newest",
		});
		expect(mocks.findOwnActivity).toHaveBeenCalledWith({
			...scope,
			after: at("11:45"),
			before: NOW,
			pick: "oldest",
		});
	});

	it("asks, proposing the last activity, when it was over 30 minutes ago", async () => {
		activity({
			action: "activity.projects.stories.update",
			createdAt: at("11:15"),
		});

		await expect(propose()).resolves.toEqual({
			timerId: "timer-1",
			version: 3,
			proposedStopAt: "2026-11-10T11:15:00.000Z",
			source: {
				action: "activity.projects.stories.update",
				at: "2026-11-10T11:15:00.000Z",
			},
			gapMinutes: 45,
			needsQuestion: true,
		});
	});

	it("proposes now without asking when the last activity was 30 minutes ago or less", async () => {
		activity({
			action: "activity.projects.stories.update",
			createdAt: at("11:30"),
		});

		await expect(propose()).resolves.toMatchObject({
			proposedStopAt: NOW.toISOString(),
			gapMinutes: 30,
			needsQuestion: false,
		});
	});

	it("still asks when the member has just come back, measuring the quiet until they did", async () => {
		activity(
			{
				action: "activity.projects.stories.update",
				createdAt: at("09:30"),
			},
			at("11:50"),
		);

		await expect(propose()).resolves.toMatchObject({
			proposedStopAt: "2026-11-10T09:30:00.000Z",
			source: {
				action: "activity.projects.stories.update",
				at: "2026-11-10T09:30:00.000Z",
			},
			gapMinutes: 140,
			needsQuestion: true,
		});
	});

	it("does not ask when work carried on into the last 15 minutes", async () => {
		activity(
			{
				action: "activity.projects.stories.update",
				createdAt: at("11:40"),
			},
			at("11:46"),
		);

		await expect(propose()).resolves.toMatchObject({
			proposedStopAt: NOW.toISOString(),
			gapMinutes: 6,
			needsQuestion: false,
		});
	});

	it("asks, proposing now, when the only activity is coming back after over 4 hours", async () => {
		mocks.findTimeTimerForOwner.mockResolvedValue(
			timerRow({ segments: [{ startAt: at("07:00"), stopAt: null }] }),
		);
		activity(null, at("11:50"));

		await expect(propose()).resolves.toMatchObject({
			proposedStopAt: NOW.toISOString(),
			source: null,
			gapMinutes: 290,
			needsQuestion: true,
		});
	});

	it("with no activity, asks only once the segment has run over 4 hours, proposing now", async () => {
		mocks.findTimeTimerForOwner.mockResolvedValue(
			timerRow({ segments: [{ startAt: at("07:30"), stopAt: null }] }),
		);
		await expect(propose()).resolves.toMatchObject({
			proposedStopAt: NOW.toISOString(),
			source: null,
			gapMinutes: 270,
			needsQuestion: true,
		});

		mocks.findTimeTimerForOwner.mockResolvedValue(
			timerRow({ segments: [{ startAt: at("08:00"), stopAt: null }] }),
		);
		await expect(propose()).resolves.toMatchObject({
			proposedStopAt: NOW.toISOString(),
			source: null,
			gapMinutes: 240,
			needsQuestion: false,
		});
	});

	it("ignores activity from before the open segment, measuring from its start", async () => {
		mocks.findTimeTimerForOwner.mockResolvedValue(
			timerRow({
				segments: [
					{ startAt: at("08:00"), stopAt: at("09:00") },
					{ startAt: at("10:00"), stopAt: null },
				],
			}),
		);
		activity({
			action: "activity.projects.stories.update",
			createdAt: at("08:45"),
		});

		await expect(propose()).resolves.toMatchObject({
			proposedStopAt: NOW.toISOString(),
			source: null,
			gapMinutes: 120,
			needsQuestion: false,
		});
	});

	it("proposes a paused timer's pause without asking or reading activity", async () => {
		mocks.findTimeTimerForOwner.mockResolvedValue(
			timerRow({
				status: "PAUSED",
				segments: [{ startAt: at("09:00"), stopAt: at("10:20") }],
			}),
		);

		await expect(propose()).resolves.toMatchObject({
			proposedStopAt: "2026-11-10T10:20:00.000Z",
			source: null,
			gapMinutes: 0,
			needsQuestion: false,
		});
		expect(mocks.findOwnActivity).not.toHaveBeenCalled();
	});

	it("answers NOT_FOUND without a timer", async () => {
		mocks.findTimeTimerForOwner.mockResolvedValue(null);

		await expect(propose()).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});

describe("stop", () => {
	const input = {
		organizationId: ORG_ID,
		timerId: "timer-1",
		version: 3,
		timezone: "UTC",
	};

	function stop(overrides: Record<string, unknown> = {}) {
		return call(stopTimerProcedure, stopTimerInputSchema, {
			...input,
			...overrides,
		});
	}

	const twoSegments = [
		{ startAt: at("08:00"), stopAt: at("08:40") },
		{ startAt: at("11:00"), stopAt: null },
	];

	it("saves one entry per segment, each with its start and stop, on a start/stop project", async () => {
		mocks.findTimeTimerForOwner.mockResolvedValue(
			timerRow({ segments: twoSegments }),
		);
		mocks.loadTimeTrackingProject.mockResolvedValue(
			project({ timeRequireStartStop: true }),
		);
		mocks.stopTimeTimer.mockResolvedValue([
			entryRow("entry-1"),
			entryRow("entry-2"),
		]);

		const result = await stop();

		expect(result.status).toBe("saved");
		expect(result.entries.map((entry: { id: string }) => entry.id)).toEqual(
			["entry-1", "entry-2"],
		);
		const { entries, ...key } = mocks.stopTimeTimer.mock.calls[0][0];
		expect(key).toEqual({
			timerId: "timer-1",
			organizationId: ORG_ID,
			userId: USER_ID,
			version: 3,
			now: NOW,
		});
		expect(entries).toEqual([
			expect.objectContaining({
				workDate: "2026-11-10",
				durationMinutes: 40,
				startAt: at("08:00"),
				stopAt: at("08:40"),
				startStopRequired: true,
			}),
			expect.objectContaining({
				workDate: "2026-11-10",
				durationMinutes: 60,
				startAt: at("11:00"),
				stopAt: NOW,
				startStopRequired: true,
			}),
		]);
	});

	it("saves ONE entry with the summed duration and no start or stop on a duration-only project", async () => {
		mocks.findTimeTimerForOwner.mockResolvedValue(
			timerRow({ segments: twoSegments }),
		);
		mocks.stopTimeTimer.mockResolvedValue([entryRow("entry-1")]);

		await stop();

		const { entries } = mocks.stopTimeTimer.mock.calls[0][0];
		expect(entries).toEqual([
			{
				projectId: "project-a",
				timezone: "UTC",
				workDate: "2026-11-10",
				durationMinutes: 100,
				startAt: null,
				stopAt: null,
				activity: "DEVELOPMENT",
				billable: true,
				description: "Timer work",
				startStopRequired: false,
				userNameSnapshot: "Ada Example",
				storyId: null,
				storyIdentifier: null,
				storyTitle: null,
			},
		]);
	});

	it("takes the timer's billable choice over the project default", async () => {
		mocks.findTimeTimerForOwner.mockResolvedValue(
			timerRow({ billable: false }),
		);
		mocks.stopTimeTimer.mockResolvedValue([entryRow("entry-1")]);

		await stop();

		expect(mocks.stopTimeTimer.mock.calls[0][0].entries[0].billable).toBe(
			false,
		);
	});

	it("dates entries by the stop's time zone", async () => {
		mocks.findTimeTimerForOwner.mockResolvedValue(
			timerRow({ segments: [{ startAt: at("11:00"), stopAt: null }] }),
		);
		mocks.stopTimeTimer.mockResolvedValue([entryRow("entry-1")]);

		await stop({ timezone: "Pacific/Kiritimati" });

		expect(mocks.stopTimeTimer.mock.calls[0][0].entries[0]).toMatchObject({
			workDate: "2026-11-11",
			timezone: "Pacific/Kiritimati",
		});
	});

	it("drops segments under a minute", async () => {
		mocks.findTimeTimerForOwner.mockResolvedValue(
			timerRow({
				segments: [
					{
						startAt: at("08:00"),
						stopAt: new Date("2026-11-10T08:00:59.000Z"),
					},
					{ startAt: at("11:00"), stopAt: null },
				],
			}),
		);
		mocks.loadTimeTrackingProject.mockResolvedValue(
			project({ timeRequireStartStop: true }),
		);
		mocks.stopTimeTimer.mockResolvedValue([entryRow("entry-1")]);

		await stop();

		const { entries } = mocks.stopTimeTimer.mock.calls[0][0];
		expect(entries).toHaveLength(1);
		expect(entries[0].startAt).toEqual(at("11:00"));
	});

	it("discards a timer whose segments are all under a minute", async () => {
		mocks.findTimeTimerForOwner.mockResolvedValue(
			timerRow({
				segments: [
					{
						startAt: new Date("2026-11-10T11:59:30.000Z"),
						stopAt: null,
					},
				],
			}),
		);
		mocks.stopTimeTimer.mockResolvedValue([]);

		await expect(stop()).resolves.toEqual({ status: "discarded" });
		expect(mocks.stopTimeTimer.mock.calls[0][0].entries).toEqual([]);
		expect(mocks.listAuthorTimeEntriesOnWorkDate).not.toHaveBeenCalled();
	});

	it("stops at a given time within the open segment", async () => {
		mocks.stopTimeTimer.mockResolvedValue([entryRow("entry-1")]);

		await stop({ stopAt: "2026-11-10T10:30:00.000Z" });

		expect(
			mocks.stopTimeTimer.mock.calls[0][0].entries[0].durationMinutes,
		).toBe(90);
	});

	it.each([
		["before the open segment started", "2026-11-10T08:59:00.000Z"],
		["in the future", "2026-11-10T12:05:00.000Z"],
	])("refuses a stop time %s", async (_label, stopAt) => {
		await expect(stop({ stopAt })).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		expect(mocks.stopTimeTimer).not.toHaveBeenCalled();
	});

	it("refuses a segment longer than an entry may be", async () => {
		mocks.findTimeTimerForOwner.mockResolvedValue(
			timerRow({
				segments: [
					{
						startAt: new Date("2026-11-09T10:00:00.000Z"),
						stopAt: null,
					},
				],
			}),
		);

		await expect(stop()).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.stopTimeTimer).not.toHaveBeenCalled();
	});

	describe("warnings", () => {
		beforeEach(() => {
			mocks.listAuthorTimeEntriesOnWorkDate.mockResolvedValue([
				{
					id: "saved-1",
					projectId: "project-a",
					workDate: "2026-11-10",
					durationMinutes: 180,
					startAt: null,
					stopAt: null,
					activity: "DEVELOPMENT",
					storyId: null,
					description: "Timer work",
				},
			]);
			mocks.findTimeTimerForOwner.mockResolvedValue(
				timerRow({
					segments: [{ startAt: at("09:00"), stopAt: null }],
				}),
			);
		});

		it("asks before saving a likely duplicate, leaving the timer as it is", async () => {
			await expect(stop()).resolves.toEqual({
				status: "needs_confirmation",
				warnings: [{ code: "LIKELY_DUPLICATE", entryIds: ["saved-1"] }],
			});
			expect(mocks.stopTimeTimer).not.toHaveBeenCalled();
		});

		it("saves once the warning is acknowledged", async () => {
			mocks.stopTimeTimer.mockResolvedValue([entryRow("entry-1")]);

			await expect(
				stop({ acknowledgedWarnings: ["LIKELY_DUPLICATE"] }),
			).resolves.toMatchObject({ status: "saved" });
			expect(mocks.stopTimeTimer).toHaveBeenCalledTimes(1);
		});

		it("counts every entry of the stop toward the daily total, and never calls its own segments duplicates", async () => {
			mocks.listAuthorTimeEntriesOnWorkDate.mockResolvedValue([
				{
					id: "saved-1",
					projectId: "project-b",
					workDate: "2026-11-10",
					durationMinutes: 13 * 60,
					startAt: null,
					stopAt: null,
					activity: "OTHER",
					storyId: null,
					description: "Elsewhere",
				},
			]);
			mocks.findTimeTimerForOwner.mockResolvedValue(
				timerRow({
					segments: [
						{ startAt: at("06:00"), stopAt: at("08:00") },
						{ startAt: at("10:00"), stopAt: NOW },
					],
					status: "PAUSED",
				}),
			);
			mocks.loadTimeTrackingProject.mockResolvedValue(
				project({ timeRequireStartStop: true }),
			);

			await expect(stop()).resolves.toEqual({
				status: "needs_confirmation",
				warnings: [
					{
						code: "OVER_DAILY_LIMIT",
						totalMinutes: 17 * 60,
						limitMinutes: 16 * 60,
					},
				],
			});
		});
	});

	describe("overlap across work dates", () => {
		it("compares the segments with saved timed entries that overlap them on any work date", async () => {
			mocks.findTimeTimerForOwner.mockResolvedValue(
				timerRow({
					segments: [
						{ startAt: at("06:00"), stopAt: at("08:00") },
						{ startAt: at("10:00"), stopAt: NOW },
					],
					status: "PAUSED",
				}),
			);
			mocks.loadTimeTrackingProject.mockResolvedValue(
				project({ timeRequireStartStop: true }),
			);
			mocks.listAuthorTimeEntriesOnWorkDate.mockResolvedValue([
				{
					id: "saved-overnight",
					projectId: "project-b",
					workDate: "2026-11-09",
					durationMinutes: 480,
					startAt: new Date("2026-11-09T23:00:00.000Z"),
					stopAt: new Date("2026-11-10T07:00:00.000Z"),
					activity: "OTHER",
					storyId: null,
					description: "Elsewhere",
				},
			]);

			await expect(stop()).resolves.toEqual({
				status: "needs_confirmation",
				warnings: [
					{ code: "LIKELY_DUPLICATE", entryIds: ["saved-overnight"] },
				],
			});
			expect(
				mocks.listAuthorTimeEntriesOnWorkDate.mock.calls[0][0]
					.overlapping,
			).toEqual({ startAt: at("06:00"), stopAt: NOW });
		});
	});

	describe("exactly once", () => {
		const savedEntries = [entryRow("entry-1")];

		it("answers a concurrent stop that lost the race with the entries the winner saved", async () => {
			mocks.stopTimeTimer.mockResolvedValue(null);
			mocks.findTimeTimerForOwner
				.mockResolvedValueOnce(timerRow())
				.mockResolvedValueOnce(null);
			mocks.findTimeTimerStop.mockResolvedValue({
				version: 3,
				outcome: "SAVED",
				entries: savedEntries,
			});

			const result = await stop();

			expect(result).toMatchObject({
				status: "saved",
				entries: [{ id: "entry-1" }],
			});
			expect(mocks.findTimeTimerStop).toHaveBeenCalledWith({
				timerId: "timer-1",
				userId: USER_ID,
			});
		});

		it("answers a repeated stop of a stopped timer with the same entries, saving nothing", async () => {
			mocks.findTimeTimerForOwner.mockResolvedValue(null);
			mocks.findTimeTimerStop.mockResolvedValue({
				version: 3,
				outcome: "SAVED",
				entries: savedEntries,
			});

			await expect(stop()).resolves.toMatchObject({
				status: "saved",
				entries: [{ id: "entry-1" }],
			});
			expect(mocks.stopTimeTimer).not.toHaveBeenCalled();
		});

		it("answers a repeated stop with the next timer already running in the same way", async () => {
			mocks.findTimeTimerForOwner.mockResolvedValue(
				timerRow({ id: "timer-2", version: 1 }),
			);
			mocks.findTimeTimerStop.mockResolvedValue({
				version: 3,
				outcome: "SAVED",
				entries: savedEntries,
			});

			await expect(stop()).resolves.toMatchObject({ status: "saved" });
			expect(mocks.stopTimeTimer).not.toHaveBeenCalled();
		});

		it("answers a repeated stop of a timer that was discarded with discarded", async () => {
			mocks.findTimeTimerForOwner.mockResolvedValue(null);
			mocks.findTimeTimerStop.mockResolvedValue({
				version: 3,
				outcome: "DISCARDED",
				entries: [],
			});

			await expect(stop()).resolves.toEqual({ status: "discarded" });
		});

		it("refuses a stop of an older version of a stopped timer", async () => {
			mocks.findTimeTimerForOwner.mockResolvedValue(null);
			mocks.findTimeTimerStop.mockResolvedValue({
				version: 4,
				outcome: "SAVED",
				entries: savedEntries,
			});

			await expect(stop()).rejects.toMatchObject({ code: "NOT_FOUND" });
		});

		it("refuses a stale version of the current timer with CONFLICT", async () => {
			mocks.findTimeTimerForOwner.mockResolvedValue(
				timerRow({ version: 4 }),
			);

			await expect(stop()).rejects.toMatchObject({
				code: "CONFLICT",
				data: { timer: { version: 4 } },
			});
			expect(mocks.stopTimeTimer).not.toHaveBeenCalled();
		});
	});

	it("refuses once the caller lost TIME_LOG on the timer's project", async () => {
		mocks.assertProjectPermission.mockRejectedValue(
			new ORPCError("FORBIDDEN", { message: "Forbidden" }),
		);

		await expect(stop()).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.stopTimeTimer).not.toHaveBeenCalled();
	});

	it("refuses once the project is no longer ACTIVE", async () => {
		mocks.loadTimeTrackingProject.mockResolvedValue(
			project({ status: "ARCHIVED" }),
		);

		await expect(stop()).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.stopTimeTimer).not.toHaveBeenCalled();
	});
});

describe("discard", () => {
	const input = { organizationId: ORG_ID, timerId: "timer-1", version: 3 };

	function discard() {
		return call(discardTimerProcedure, discardTimerInputSchema, input);
	}

	it("deletes the timer without saving, even on a project the caller lost", async () => {
		mocks.assertProjectPermission.mockRejectedValue(
			new ORPCError("FORBIDDEN", { message: "Forbidden" }),
		);
		mocks.stopTimeTimer.mockResolvedValue([]);

		await expect(discard()).resolves.toEqual({ status: "discarded" });
		expect(mocks.stopTimeTimer).toHaveBeenCalledWith({
			timerId: "timer-1",
			organizationId: ORG_ID,
			userId: USER_ID,
			version: 3,
			entries: [],
			now: NOW,
		});
	});

	it("answers a repeated discard with discarded", async () => {
		mocks.findTimeTimerForOwner.mockResolvedValue(null);
		mocks.findTimeTimerStop.mockResolvedValue({
			version: 3,
			outcome: "DISCARDED",
			entries: [],
		});

		await expect(discard()).resolves.toEqual({ status: "discarded" });
	});

	it("refuses to discard a timer that was already saved", async () => {
		mocks.findTimeTimerForOwner.mockResolvedValue(null);
		mocks.findTimeTimerStop.mockResolvedValue({
			version: 3,
			outcome: "SAVED",
			entries: [entryRow("entry-1")],
		});

		await expect(discard()).rejects.toMatchObject({ code: "CONFLICT" });
	});
});

describe("setPreference", () => {
	it("sets only the caller's own preferences in the organization", async () => {
		mocks.setTimeTrackingPreference.mockResolvedValue({
			timerWidget: "OFF",
			timerReminders: false,
		});

		await expect(
			call(setTimerPreferenceProcedure, setTimerPreferenceInputSchema, {
				organizationId: ORG_ID,
				timerWidget: "OFF",
			}),
		).resolves.toEqual({
			preference: { timerWidget: "OFF", timerReminders: false },
		});
		expect(mocks.setTimeTrackingPreference).toHaveBeenCalledWith({
			organizationId: ORG_ID,
			userId: USER_ID,
			values: { timerWidget: "OFF", timerReminders: undefined },
		});
	});

	it("refuses a widget state that is not one", () => {
		expect(
			setTimerPreferenceInputSchema.safeParse({
				organizationId: ORG_ID,
				timerWidget: "MINIMIZED",
			}).success,
		).toBe(false);
	});
});
