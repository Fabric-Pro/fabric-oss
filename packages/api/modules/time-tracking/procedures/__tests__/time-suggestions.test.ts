/**
 * The time-suggestion procedures.
 *
 * Same two seams as `time-tracking.test.ts`: input schemas parsed directly,
 * and handlers run over a stubbed procedure chain with the `@repo/database`
 * queries and `@repo/temporal` mocked. The pure rules and this module's own
 * `lib/` run for real, so confirming exercises the same timing, policy and
 * warning rules `createEntry` does.
 */

import { ORPCError } from "@orpc/server";
import { inclusiveDaySpan } from "@repo/utils/time-tracking";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	listTimeAccessRows: vi.fn(),
	startTimeSuggestionRun: vi.fn(),
	failTimeSuggestionRun: vi.fn(),
	getLatestTimeSuggestionRun: vi.fn(),
	findLatestTimeSuggestionRunStart: vi.fn(),
	listPendingTimeSuggestions: vi.fn(),
	findTimeSuggestionForOwner: vi.fn(),
	updatePendingTimeSuggestion: vi.fn(),
	dismissTimeSuggestion: vi.fn(),
	confirmTimeSuggestionAsEntry: vi.fn(),
	findTimeEntryForSuggestion: vi.fn(),
	loadTimeTrackingProject: vi.fn(),
	listAuthorTimeEntriesOnWorkDate: vi.fn(),
	findStoryForTimeEntry: vi.fn(),
	hasProjectAccess: vi.fn(),
	assertProjectPermission: vi.fn(),
	isTemporalAvailable: vi.fn(),
	workflowStart: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		listTimeAccessRows: mocks.listTimeAccessRows,
		startTimeSuggestionRun: mocks.startTimeSuggestionRun,
		failTimeSuggestionRun: mocks.failTimeSuggestionRun,
		getLatestTimeSuggestionRun: mocks.getLatestTimeSuggestionRun,
		findLatestTimeSuggestionRunStart:
			mocks.findLatestTimeSuggestionRunStart,
		listPendingTimeSuggestions: mocks.listPendingTimeSuggestions,
		findTimeSuggestionForOwner: mocks.findTimeSuggestionForOwner,
		updatePendingTimeSuggestion: mocks.updatePendingTimeSuggestion,
		dismissTimeSuggestion: mocks.dismissTimeSuggestion,
		confirmTimeSuggestionAsEntry: mocks.confirmTimeSuggestionAsEntry,
		findTimeEntryForSuggestion: mocks.findTimeEntryForSuggestion,
		loadTimeTrackingProject: mocks.loadTimeTrackingProject,
		listAuthorTimeEntriesOnWorkDate: mocks.listAuthorTimeEntriesOnWorkDate,
		findStoryForTimeEntry: mocks.findStoryForTimeEntry,
		hasProjectAccess: mocks.hasProjectAccess,
		TIME_SUGGESTION_RUN_TIMEOUT_MS: 10 * 60 * 1000,
	};
});

vi.mock("@repo/temporal", () => ({
	isTemporalAvailable: mocks.isTemporalAvailable,
	getTemporalClient: async () => ({
		workflow: { start: mocks.workflowStart },
	}),
}));

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
const { generateTimeSuggestionsInputSchema, generateTimeSuggestionsProcedure } =
	await import("../generate-suggestions");
const { timeSuggestionStatusInputSchema, timeSuggestionStatusProcedure } =
	await import("../suggestion-status");
const { listTimeSuggestionsInputSchema, listTimeSuggestionsProcedure } =
	await import("../list-suggestions");
const { updateTimeSuggestionInputSchema, updateTimeSuggestionProcedure } =
	await import("../update-suggestion");
const { confirmTimeSuggestionInputSchema, confirmTimeSuggestionProcedure } =
	await import("../confirm-suggestion");
const { dismissTimeSuggestionInputSchema, dismissTimeSuggestionProcedure } =
	await import("../dismiss-suggestion");

type StubbedProcedure = { __handler: Handler; __declared: Declaration[] };

function stub(procedure: unknown): StubbedProcedure {
	return procedure as StubbedProcedure;
}

const USER_ID = "user-1";
const ORG_ID = "org-1";
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

const activeMember = {
	role: "EDITOR",
	acceptedAt: new Date("2026-01-01T00:00:00Z"),
	expiresAt: null,
};

function accessRows(
	projects: {
		id: string;
		member: typeof activeMember | null;
		billingModel?: "FIXED_BID" | "TIME_AND_MATERIALS";
	}[],
) {
	return {
		organizationRole: "member",
		organization: policyOff,
		projects: projects.map((p) => ({
			id: p.id,
			name: `Name of ${p.id}`,
			billingModel: p.billingModel ?? "TIME_AND_MATERIALS",
			...policyOff,
			member: p.member,
			ownedByCaller: false,
		})),
	};
}

function suggestionRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "suggestion-1",
		organizationId: ORG_ID,
		projectId: "project-a",
		projectName: "Project A",
		workDate: "2026-11-10",
		timezone: "Europe/Berlin",
		activity: "MEETINGS_COLLABORATION",
		billable: null,
		durationMinutes: 60,
		startAt: new Date("2026-11-10T09:00:00Z"),
		stopAt: new Date("2026-11-10T10:00:00Z"),
		description: "Sprint planning",
		explanation: "Suggested from 1 meeting.",
		storyId: null,
		storyIdentifier: null,
		storyTitle: null,
		status: "PENDING",
		expiresAt: new Date("2099-01-01T00:00:00Z"),
		createdAt: new Date("2026-11-10T12:00:00Z"),
		evidence: [
			{
				kind: "MEETING_SESSION",
				occurredAt: new Date("2026-11-10T09:00:00Z"),
				startAt: new Date("2026-11-10T09:00:00Z"),
				endAt: new Date("2026-11-10T10:00:00Z"),
			},
		],
		...overrides,
	};
}

function entryRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "entry-1",
		organizationId: ORG_ID,
		projectId: "project-a",
		projectName: "Project A",
		workDate: "2026-11-10",
		timezone: "Europe/Berlin",
		durationMinutes: 60,
		startAt: null,
		stopAt: null,
		activity: "MEETINGS_COLLABORATION",
		billable: true,
		description: "Sprint planning",
		storyId: null,
		storyIdentifier: null,
		storyTitle: null,
		startStopRequired: false,
		createdAt: new Date("2026-11-10T12:00:00Z"),
		updatedAt: new Date("2026-11-10T12:00:00Z"),
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.useRealTimers();
	mocks.loadTimeTrackingProject.mockResolvedValue(project());
	mocks.listAuthorTimeEntriesOnWorkDate.mockResolvedValue([]);
	mocks.findStoryForTimeEntry.mockResolvedValue(null);
	mocks.hasProjectAccess.mockResolvedValue(true);
	mocks.assertProjectPermission.mockResolvedValue({
		projectId: "project-a",
		organizationId: ORG_ID,
	});
	mocks.findTimeSuggestionForOwner.mockResolvedValue(suggestionRow());
	mocks.isTemporalAvailable.mockResolvedValue(true);
	mocks.workflowStart.mockResolvedValue(undefined);
	mocks.listTimeAccessRows.mockResolvedValue(
		accessRows([{ id: "project-a", member: activeMember }]),
	);
});

describe("generateSuggestions", () => {
	const input = { organizationId: ORG_ID, timezone: "Europe/Berlin" };

	it("is gated on organization membership", () => {
		expect(stub(generateTimeSuggestionsProcedure).__declared).toEqual([
			ORG_GATE,
		]);
	});

	it.each([
		[
			"a range wider than 14 days",
			{ from: "2026-11-01", to: "2026-11-15" },
		],
		[
			"a range ending before it starts",
			{ from: "2026-11-10", to: "2026-11-09" },
		],
		["only one end of the range", { from: "2026-11-10" }],
		["a time zone that is not one", { timezone: "Mars/Olympus" }],
	])("refuses %s", (_label, overrides) => {
		expect(
			generateTimeSuggestionsInputSchema.safeParse({
				...input,
				...overrides,
			}).success,
		).toBe(false);
	});

	it("starts one run over the 7 days ending today, on the projects the caller can log on", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-11-10T23:30:00Z"));
		mocks.listTimeAccessRows.mockResolvedValue(
			accessRows([
				{ id: "project-a", member: activeMember },
				// Not a member and not the creator: not discoverable.
				{ id: "project-b", member: null },
			]),
		);
		mocks.startTimeSuggestionRun.mockResolvedValue({
			status: "started",
			runId: "run-1",
		});

		const result = await call(
			generateTimeSuggestionsProcedure,
			generateTimeSuggestionsInputSchema,
			input,
		);

		expect(result).toEqual({ started: true, runId: "run-1" });
		// 23:30 UTC is already 11-11 in Berlin.
		expect(mocks.startTimeSuggestionRun).toHaveBeenCalledWith({
			organizationId: ORG_ID,
			userId: USER_ID,
			fromDate: "2026-11-05",
			toDate: "2026-11-11",
			timezone: "Europe/Berlin",
			automatic: false,
		});
		expect(mocks.workflowStart).toHaveBeenCalledWith(
			"generateTimeSuggestionsWorkflow",
			expect.objectContaining({
				taskQueue: "fabric-worker",
				workflowId: "time-suggestions:run-1",
				workflowIdConflictPolicy: "FAIL",
				args: [
					{
						runId: "run-1",
						organizationId: ORG_ID,
						userId: USER_ID,
						fromDate: "2026-11-05",
						toDate: "2026-11-11",
						timezone: "Europe/Berlin",
						projects: [
							{ id: "project-a", name: "Name of project-a" },
						],
					},
				],
			}),
		);
	});

	it("answers in-progress while a run is going, and starts nothing", async () => {
		mocks.startTimeSuggestionRun.mockResolvedValue({ status: "in_flight" });

		await expect(
			call(
				generateTimeSuggestionsProcedure,
				generateTimeSuggestionsInputSchema,
				input,
			),
		).resolves.toEqual({ started: false, reason: "in-progress" });
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("answers unavailable without opening a run when the worker cannot be reached", async () => {
		mocks.isTemporalAvailable.mockResolvedValue(false);

		await expect(
			call(
				generateTimeSuggestionsProcedure,
				generateTimeSuggestionsInputSchema,
				input,
			),
		).resolves.toEqual({ started: false, reason: "unavailable" });
		expect(mocks.startTimeSuggestionRun).not.toHaveBeenCalled();
	});

	it("answers in-progress when the workflow is already running", async () => {
		mocks.startTimeSuggestionRun.mockResolvedValue({
			status: "started",
			runId: "run-1",
		});
		mocks.workflowStart.mockRejectedValue(
			Object.assign(new Error("already started"), {
				name: "WorkflowExecutionAlreadyStartedError",
			}),
		);

		await expect(
			call(
				generateTimeSuggestionsProcedure,
				generateTimeSuggestionsInputSchema,
				input,
			),
		).resolves.toEqual({ started: false, reason: "in-progress" });
		expect(mocks.failTimeSuggestionRun).not.toHaveBeenCalled();
	});

	it("releases the run when the workflow cannot start", async () => {
		mocks.startTimeSuggestionRun.mockResolvedValue({
			status: "started",
			runId: "run-1",
		});
		mocks.workflowStart.mockRejectedValue(new Error("connection refused"));

		await expect(
			call(
				generateTimeSuggestionsProcedure,
				generateTimeSuggestionsInputSchema,
				input,
			),
		).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
		expect(mocks.failTimeSuggestionRun).toHaveBeenCalledWith(
			expect.objectContaining({
				runId: "run-1",
				organizationId: ORG_ID,
				userId: USER_ID,
			}),
		);
	});

	it("reads fixed bid projects too when the member asks, whatever their newest run", async () => {
		mocks.listTimeAccessRows.mockResolvedValue(
			accessRows([
				{ id: "project-a", member: activeMember },
				{
					id: "project-f",
					member: activeMember,
					billingModel: "FIXED_BID",
				},
			]),
		);
		mocks.findLatestTimeSuggestionRunStart.mockResolvedValue(new Date());
		mocks.startTimeSuggestionRun.mockResolvedValue({
			status: "started",
			runId: "run-1",
		});

		await expect(
			call(
				generateTimeSuggestionsProcedure,
				generateTimeSuggestionsInputSchema,
				input,
			),
		).resolves.toEqual({ started: true, runId: "run-1" });
		expect(mocks.findLatestTimeSuggestionRunStart).not.toHaveBeenCalled();
		expect(mocks.workflowStart.mock.calls[0][1].args[0].projects).toEqual([
			{ id: "project-a", name: "Name of project-a" },
			{ id: "project-f", name: "Name of project-f" },
		]);
	});

	describe("automatic refresh", () => {
		const automatic = { ...input, mode: "automatic" };
		const NOW = new Date("2026-11-10T23:30:00Z");
		const hoursAgo = (hours: number) =>
			new Date(NOW.getTime() - hours * 60 * 60 * 1000);
		type StoredRun = { fromDate: string; toDate: string; startedAt: Date };
		const storedRun = (
			startedAt: Date,
			fromDate = "2026-11-04",
			toDate = "2026-11-10",
		): StoredRun => ({ fromDate, toDate, startedAt });
		/**
		 * The member's stored runs, read through a fake of the query's
		 * contract: the newest start among runs over at least
		 * `minSpanDays` work dates, inclusive.
		 */
		const storeRuns = (runs: StoredRun[]) =>
			mocks.findLatestTimeSuggestionRunStart.mockImplementation(
				async (params: { minSpanDays: number }) =>
					runs
						.filter(
							(run) =>
								inclusiveDaySpan(run.fromDate, run.toDate) >=
								params.minSpanDays,
						)
						.map((run) => run.startedAt)
						.sort((a, b) => b.getTime() - a.getTime())[0] ?? null,
			);

		beforeEach(() => {
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(NOW);
			storeRuns([]);
			mocks.startTimeSuggestionRun.mockResolvedValue({
				status: "started",
				runId: "run-1",
			});
			mocks.listTimeAccessRows.mockResolvedValue(
				accessRows([
					{ id: "project-a", member: activeMember },
					{
						id: "project-f",
						member: activeMember,
						billingModel: "FIXED_BID",
					},
					// Time and materials, but not discoverable.
					{ id: "project-b", member: null },
				]),
			);
		});

		it("refuses a range: it always reads the default one", () => {
			expect(
				generateTimeSuggestionsInputSchema.safeParse({
					...automatic,
					from: "2026-11-01",
					to: "2026-11-07",
				}).success,
			).toBe(false);
		});

		it("defaults to asking on demand", () => {
			expect(generateTimeSuggestionsInputSchema.parse(input)).toEqual(
				expect.objectContaining({ mode: "on_demand" }),
			);
		});

		it("starts nothing while the newest 7-day run is less than 12 hours old", async () => {
			storeRuns([storedRun(hoursAgo(11.9))]);

			await expect(
				call(
					generateTimeSuggestionsProcedure,
					generateTimeSuggestionsInputSchema,
					automatic,
				),
			).resolves.toEqual({ started: false, reason: "fresh" });
			expect(mocks.findLatestTimeSuggestionRunStart).toHaveBeenCalledWith(
				{
					organizationId: ORG_ID,
					userId: USER_ID,
					minSpanDays: 7,
				},
			);
			expect(mocks.listTimeAccessRows).not.toHaveBeenCalled();
			expect(mocks.startTimeSuggestionRun).not.toHaveBeenCalled();
			expect(mocks.workflowStart).not.toHaveBeenCalled();
		});

		it.each([
			[
				"the newest 7-day run is older than 12 hours",
				[storedRun(hoursAgo(12.1))],
			],
			["there is no run yet", []],
			[
				"the only recent run covered one meeting's day",
				[
					storedRun(hoursAgo(0.5), "2026-11-10", "2026-11-10"),
					storedRun(hoursAgo(30)),
				],
			],
		])(
			"starts a run over the week on time and materials projects only when %s",
			async (_label, runs) => {
				storeRuns(runs);

				await expect(
					call(
						generateTimeSuggestionsProcedure,
						generateTimeSuggestionsInputSchema,
						automatic,
					),
				).resolves.toEqual({ started: true, runId: "run-1" });
				// 23:30 UTC is already 11-11 in Berlin.
				expect(mocks.startTimeSuggestionRun).toHaveBeenCalledWith({
					organizationId: ORG_ID,
					userId: USER_ID,
					fromDate: "2026-11-05",
					toDate: "2026-11-11",
					timezone: "Europe/Berlin",
					automatic: true,
				});
				expect(mocks.workflowStart).toHaveBeenCalledWith(
					"generateTimeSuggestionsWorkflow",
					expect.objectContaining({
						workflowId: "time-suggestions:run-1",
						args: [
							expect.objectContaining({
								projects: [
									{
										id: "project-a",
										name: "Name of project-a",
									},
								],
							}),
						],
					}),
				);
			},
		);

		it("starts nothing when no project the member can log on is time and materials", async () => {
			mocks.listTimeAccessRows.mockResolvedValue(
				accessRows([
					{
						id: "project-f",
						member: activeMember,
						billingModel: "FIXED_BID",
					},
					{ id: "project-b", member: null },
				]),
			);

			await expect(
				call(
					generateTimeSuggestionsProcedure,
					generateTimeSuggestionsInputSchema,
					automatic,
				),
			).resolves.toEqual({ started: false, reason: "no-projects" });
			expect(mocks.startTimeSuggestionRun).not.toHaveBeenCalled();
			expect(mocks.workflowStart).not.toHaveBeenCalled();
		});

		it("answers in-progress and unavailable like a request on demand", async () => {
			mocks.startTimeSuggestionRun.mockResolvedValue({
				status: "in_flight",
			});
			await expect(
				call(
					generateTimeSuggestionsProcedure,
					generateTimeSuggestionsInputSchema,
					automatic,
				),
			).resolves.toEqual({ started: false, reason: "in-progress" });

			mocks.isTemporalAvailable.mockResolvedValue(false);
			await expect(
				call(
					generateTimeSuggestionsProcedure,
					generateTimeSuggestionsInputSchema,
					automatic,
				),
			).resolves.toEqual({ started: false, reason: "unavailable" });
		});
	});
});

describe("suggestionStatus", () => {
	it("is gated on organization membership", () => {
		expect(stub(timeSuggestionStatusProcedure).__declared).toEqual([
			ORG_GATE,
		]);
	});

	it("answers null before the first run", async () => {
		mocks.getLatestTimeSuggestionRun.mockResolvedValue(null);

		await expect(
			call(
				timeSuggestionStatusProcedure,
				timeSuggestionStatusInputSchema,
				{
					organizationId: ORG_ID,
				},
			),
		).resolves.toBeNull();
		expect(mocks.getLatestTimeSuggestionRun).toHaveBeenCalledWith({
			organizationId: ORG_ID,
			userId: USER_ID,
		});
	});

	it("reports a run stuck past its timeout as failed", async () => {
		mocks.getLatestTimeSuggestionRun.mockResolvedValue({
			id: "run-1",
			status: "GENERATING",
			createdCount: 0,
			startedAt: new Date(Date.now() - 11 * 60 * 1000),
			finishedAt: null,
		});

		const result = await call(
			timeSuggestionStatusProcedure,
			timeSuggestionStatusInputSchema,
			{ organizationId: ORG_ID },
		);

		expect(result.status).toBe("FAILED");
	});

	it("reports a finished run with its count", async () => {
		const finishedAt = new Date("2026-11-10T12:00:30Z");
		mocks.getLatestTimeSuggestionRun.mockResolvedValue({
			id: "run-1",
			status: "DONE",
			createdCount: 3,
			startedAt: new Date("2026-11-10T12:00:00Z"),
			finishedAt,
		});

		await expect(
			call(
				timeSuggestionStatusProcedure,
				timeSuggestionStatusInputSchema,
				{
					organizationId: ORG_ID,
				},
			),
		).resolves.toEqual({
			runId: "run-1",
			status: "DONE",
			createdCount: 3,
			startedAt: "2026-11-10T12:00:00.000Z",
			finishedAt: "2026-11-10T12:00:30.000Z",
		});
	});
});

describe("listSuggestions", () => {
	it("is gated on organization membership", () => {
		expect(stub(listTimeSuggestionsProcedure).__declared).toEqual([
			ORG_GATE,
		]);
	});

	it("lists the caller's own pending, unexpired suggestions on projects they can still log on", async () => {
		mocks.listPendingTimeSuggestions.mockResolvedValue([
			suggestionRow(),
			suggestionRow({ id: "suggestion-2", projectId: "project-b" }),
		]);
		mocks.listTimeAccessRows.mockResolvedValue(
			accessRows([
				{ id: "project-a", member: activeMember },
				// Removed from the project: its suggestions are hidden.
				{ id: "project-b", member: null },
			]),
		);

		const result = await call(
			listTimeSuggestionsProcedure,
			listTimeSuggestionsInputSchema,
			{ organizationId: ORG_ID },
		);

		expect(mocks.listPendingTimeSuggestions).toHaveBeenCalledWith({
			organizationId: ORG_ID,
			userId: USER_ID,
			now: expect.any(Date),
		});
		expect(mocks.listTimeAccessRows).toHaveBeenCalledWith({
			organizationId: ORG_ID,
			userId: USER_ID,
			projects: "loggable",
		});
		expect(result.suggestions).toHaveLength(1);
		expect(result.suggestions[0]).toMatchObject({
			id: "suggestion-1",
			durationMinutes: 60,
			startAt: "2026-11-10T09:00:00.000Z",
			stopAt: "2026-11-10T10:00:00.000Z",
			startStopRequired: false,
			defaultBillable: true,
			evidence: [
				{
					kind: "MEETING_SESSION",
					count: 1,
					earliestAt: "2026-11-10T09:00:00.000Z",
					latestAt: "2026-11-10T10:00:00.000Z",
				},
			],
		});
	});

	describe("on a project whose billing model changed", () => {
		type BillingModel = "FIXED_BID" | "TIME_AND_MATERIALS";
		const stored = [
			{ row: suggestionRow({ id: "automatic-1" }), automatic: true },
			{ row: suggestionRow({ id: "on-demand-1" }), automatic: false },
		];
		/**
		 * The member's project and stored suggestions, the list read through
		 * a fake of the query's contract: an automatic suggestion is left out
		 * while its project's current billing model is fixed bid.
		 */
		function storeProject(billingModel: BillingModel) {
			mocks.listTimeAccessRows.mockResolvedValue(
				accessRows([
					{ id: "project-a", member: activeMember, billingModel },
				]),
			);
			mocks.listPendingTimeSuggestions.mockImplementation(async () =>
				stored
					.filter(
						({ automatic }) =>
							!automatic || billingModel !== "FIXED_BID",
					)
					.map(({ row }) => row),
			);
		}

		async function listedIds() {
			const result = await call(
				listTimeSuggestionsProcedure,
				listTimeSuggestionsInputSchema,
				{ organizationId: ORG_ID },
			);
			return result.suggestions.map(
				(suggestion: { id: string }) => suggestion.id,
			);
		}

		it("lists an on-demand suggestion but not an automatic one while the project is fixed bid", async () => {
			storeProject("FIXED_BID");

			await expect(listedIds()).resolves.toEqual(["on-demand-1"]);
		});

		it("lists the automatic one again once the project is back on time and materials", async () => {
			storeProject("TIME_AND_MATERIALS");

			await expect(listedIds()).resolves.toEqual([
				"automatic-1",
				"on-demand-1",
			]);
		});
	});
});

describe("someone else's suggestion", () => {
	it.each([
		[
			"updateSuggestion",
			updateTimeSuggestionProcedure,
			updateTimeSuggestionInputSchema,
			{
				suggestionId: "suggestion-1",
				activity: "OTHER",
				billable: null,
				description: "Planning",
				storyId: null,
				durationMinutes: 30,
				startAt: null,
				stopAt: null,
			},
		],
		[
			"confirmSuggestion",
			confirmTimeSuggestionProcedure,
			confirmTimeSuggestionInputSchema,
			{ suggestionId: "suggestion-1", timezone: "Europe/Berlin" },
		],
		[
			"dismissSuggestion",
			dismissTimeSuggestionProcedure,
			dismissTimeSuggestionInputSchema,
			{ suggestionId: "suggestion-1" },
		],
	])("answers NOT_FOUND from %s", async (_name, procedure, schema, input) => {
		mocks.findTimeSuggestionForOwner.mockResolvedValue(null);

		await expect(call(procedure, schema, input)).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(mocks.findTimeSuggestionForOwner).toHaveBeenCalledWith({
			id: "suggestion-1",
			userId: USER_ID,
		});
		expect(mocks.updatePendingTimeSuggestion).not.toHaveBeenCalled();
		expect(mocks.confirmTimeSuggestionAsEntry).not.toHaveBeenCalled();
		expect(mocks.dismissTimeSuggestion).not.toHaveBeenCalled();
	});
});

describe("updateSuggestion", () => {
	const input = {
		suggestionId: "suggestion-1",
		activity: "PLANNING_REQUIREMENTS",
		billable: false,
		description: "Planned the checkout work",
		storyId: "story-1",
		durationMinutes: 45,
		startAt: null,
		stopAt: null,
	};

	it("checks the suggestion's project, then saves the edit with the work item's snapshot", async () => {
		mocks.findStoryForTimeEntry.mockResolvedValue({
			id: "story-1",
			identifier: "F-001",
			title: "Checkout",
		});
		mocks.updatePendingTimeSuggestion.mockResolvedValue(suggestionRow());

		await call(
			updateTimeSuggestionProcedure,
			updateTimeSuggestionInputSchema,
			input,
		);

		expect(mocks.assertProjectPermission).toHaveBeenCalledWith(
			"project-a",
			USER_ID,
			Permissions.TIME_LOG,
		);
		expect(mocks.updatePendingTimeSuggestion).toHaveBeenCalledWith({
			id: "suggestion-1",
			userId: USER_ID,
			values: {
				activity: "PLANNING_REQUIREMENTS",
				billable: false,
				description: "Planned the checkout work",
				storyId: "story-1",
				storyIdentifier: "F-001",
				storyTitle: "Checkout",
				durationMinutes: 45,
				startAt: null,
				stopAt: null,
			},
		});
	});

	it("refuses a work item from another project", async () => {
		mocks.findStoryForTimeEntry.mockResolvedValue(null);

		await expect(
			call(
				updateTimeSuggestionProcedure,
				updateTimeSuggestionInputSchema,
				input,
			),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.updatePendingTimeSuggestion).not.toHaveBeenCalled();
	});

	it("refuses a suggestion that is no longer pending", async () => {
		mocks.findTimeSuggestionForOwner.mockResolvedValue(
			suggestionRow({ status: "CONFIRMED" }),
		);

		await expect(
			call(
				updateTimeSuggestionProcedure,
				updateTimeSuggestionInputSchema,
				{
					...input,
					storyId: null,
				},
			),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});
});

describe("confirmSuggestion", () => {
	const input = { suggestionId: "suggestion-1", timezone: "Europe/Berlin" };

	it("creates one entry from the suggestion under the project's current policy", async () => {
		mocks.confirmTimeSuggestionAsEntry.mockResolvedValue({
			status: "created",
			entry: entryRow(),
		});

		const result = await call(
			confirmTimeSuggestionProcedure,
			confirmTimeSuggestionInputSchema,
			input,
		);

		expect(result.status).toBe("saved");
		expect(result.entry.id).toBe("entry-1");
		expect(mocks.confirmTimeSuggestionAsEntry).toHaveBeenCalledWith({
			suggestionId: "suggestion-1",
			organizationId: ORG_ID,
			userId: USER_ID,
			values: expect.objectContaining({
				projectId: "project-a",
				workDate: "2026-11-10",
				timezone: "Europe/Berlin",
				activity: "MEETINGS_COLLABORATION",
				durationMinutes: 60,
				startAt: new Date("2026-11-10T09:00:00Z"),
				stopAt: new Date("2026-11-10T10:00:00Z"),
				// The suggestion leaves billable to the project's default.
				billable: true,
				description: "Sprint planning",
				startStopRequired: false,
				userNameSnapshot: "Ada Example",
			}),
		});
	});

	it("takes the caller's changes over the suggestion's values", async () => {
		mocks.confirmTimeSuggestionAsEntry.mockResolvedValue({
			status: "created",
			entry: entryRow(),
		});

		await call(
			confirmTimeSuggestionProcedure,
			confirmTimeSuggestionInputSchema,
			{
				...input,
				durationMinutes: 30,
				activity: "OTHER",
				billable: false,
				description: "Planning",
			},
		);

		expect(
			mocks.confirmTimeSuggestionAsEntry.mock.calls[0][0].values,
		).toMatchObject({
			durationMinutes: 30,
			startAt: null,
			stopAt: null,
			activity: "OTHER",
			billable: false,
			description: "Planning",
		});
	});

	it("refuses a duration-only suggestion on a project that requires start and stop", async () => {
		mocks.loadTimeTrackingProject.mockResolvedValue(
			project({ timeRequireStartStop: true }),
		);
		mocks.findTimeSuggestionForOwner.mockResolvedValue(
			suggestionRow({ startAt: null, stopAt: null, durationMinutes: 60 }),
		);

		await expect(
			call(
				confirmTimeSuggestionProcedure,
				confirmTimeSuggestionInputSchema,
				input,
			),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: "This project requires start and stop times",
		});
		expect(mocks.confirmTimeSuggestionAsEntry).not.toHaveBeenCalled();
	});

	it("asks for a duration when the suggestion has none", async () => {
		mocks.findTimeSuggestionForOwner.mockResolvedValue(
			suggestionRow({
				startAt: null,
				stopAt: null,
				durationMinutes: null,
			}),
		);

		await expect(
			call(
				confirmTimeSuggestionProcedure,
				confirmTimeSuggestionInputSchema,
				input,
			),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.confirmTimeSuggestionAsEntry).not.toHaveBeenCalled();
	});

	it("returns the warnings instead of saving until they are acknowledged", async () => {
		mocks.listAuthorTimeEntriesOnWorkDate.mockResolvedValue([
			{
				id: "entry-0",
				projectId: "project-b",
				workDate: "2026-11-10",
				durationMinutes: 960,
				startAt: null,
				stopAt: null,
				activity: "OTHER",
				storyId: null,
				description: null,
			},
		]);

		const result = await call(
			confirmTimeSuggestionProcedure,
			confirmTimeSuggestionInputSchema,
			input,
		);

		expect(result.status).toBe("needs_confirmation");
		expect(result.warnings.map((w: { code: string }) => w.code)).toContain(
			"OVER_DAILY_LIMIT",
		);
		expect(mocks.confirmTimeSuggestionAsEntry).not.toHaveBeenCalled();
	});

	it("returns the existing entry for a suggestion already confirmed, without a second write", async () => {
		mocks.findTimeSuggestionForOwner.mockResolvedValue(
			suggestionRow({ status: "CONFIRMED" }),
		);
		mocks.findTimeEntryForSuggestion.mockResolvedValue(entryRow());

		const result = await call(
			confirmTimeSuggestionProcedure,
			confirmTimeSuggestionInputSchema,
			input,
		);

		expect(result).toMatchObject({
			status: "saved",
			entry: { id: "entry-1" },
		});
		expect(mocks.findTimeEntryForSuggestion).toHaveBeenCalledWith({
			suggestionId: "suggestion-1",
			userId: USER_ID,
		});
		expect(mocks.confirmTimeSuggestionAsEntry).not.toHaveBeenCalled();
	});

	it("returns the entry a concurrent confirm created when it loses the race", async () => {
		mocks.confirmTimeSuggestionAsEntry.mockResolvedValue({
			status: "existing",
			entry: entryRow({ id: "entry-other" }),
		});

		const result = await call(
			confirmTimeSuggestionProcedure,
			confirmTimeSuggestionInputSchema,
			input,
		);

		expect(result).toMatchObject({
			status: "saved",
			entry: { id: "entry-other" },
		});
	});

	it("refuses a dismissed suggestion", async () => {
		mocks.findTimeSuggestionForOwner.mockResolvedValue(
			suggestionRow({ status: "DISMISSED" }),
		);

		await expect(
			call(
				confirmTimeSuggestionProcedure,
				confirmTimeSuggestionInputSchema,
				input,
			),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});

	it("refuses an expired suggestion", async () => {
		mocks.findTimeSuggestionForOwner.mockResolvedValue(
			suggestionRow({ expiresAt: new Date("2020-01-01T00:00:00Z") }),
		);

		await expect(
			call(
				confirmTimeSuggestionProcedure,
				confirmTimeSuggestionInputSchema,
				input,
			),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(mocks.confirmTimeSuggestionAsEntry).not.toHaveBeenCalled();
	});

	it("refuses when the caller no longer holds TIME_LOG on the project", async () => {
		mocks.assertProjectPermission.mockRejectedValue(
			new ORPCError("FORBIDDEN", { message: "Forbidden" }),
		);

		await expect(
			call(
				confirmTimeSuggestionProcedure,
				confirmTimeSuggestionInputSchema,
				input,
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.confirmTimeSuggestionAsEntry).not.toHaveBeenCalled();
	});

	it("refuses when the caller can no longer see the project", async () => {
		mocks.hasProjectAccess.mockResolvedValue(false);

		await expect(
			call(
				confirmTimeSuggestionProcedure,
				confirmTimeSuggestionInputSchema,
				input,
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.confirmTimeSuggestionAsEntry).not.toHaveBeenCalled();
	});
});

describe("dismissSuggestion", () => {
	const input = { suggestionId: "suggestion-1" };

	it("dismisses a pending suggestion", async () => {
		mocks.dismissTimeSuggestion.mockResolvedValue(true);

		await expect(
			call(
				dismissTimeSuggestionProcedure,
				dismissTimeSuggestionInputSchema,
				input,
			),
		).resolves.toEqual({ id: "suggestion-1", status: "DISMISSED" });
		expect(mocks.dismissTimeSuggestion).toHaveBeenCalledWith({
			id: "suggestion-1",
			userId: USER_ID,
		});
	});

	it("answers the same when it is already dismissed", async () => {
		mocks.findTimeSuggestionForOwner.mockResolvedValue(
			suggestionRow({ status: "DISMISSED" }),
		);

		await expect(
			call(
				dismissTimeSuggestionProcedure,
				dismissTimeSuggestionInputSchema,
				input,
			),
		).resolves.toEqual({ id: "suggestion-1", status: "DISMISSED" });
		expect(mocks.dismissTimeSuggestion).not.toHaveBeenCalled();
	});

	it("refuses a suggestion confirmed meanwhile", async () => {
		mocks.findTimeSuggestionForOwner
			.mockResolvedValueOnce(suggestionRow())
			.mockResolvedValueOnce(suggestionRow({ status: "CONFIRMED" }));
		mocks.dismissTimeSuggestion.mockResolvedValue(false);

		await expect(
			call(
				dismissTimeSuggestionProcedure,
				dismissTimeSuggestionInputSchema,
				input,
			),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});
});
