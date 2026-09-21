/**
 * Poll → status-sync leaf WIRING (Fizzy #2304, spec §6 rule 6).
 *
 * The leaf is MOCKED here, so this file only counts and inspects calls: which
 * verdicts reach `reconcileStoryMappedStatus` / `recordTerminalObservation`,
 * with exactly what input, and how their outcomes are tallied into the
 * last-run summary. Every decision assertion uses the real leaf instead — in
 * `pm-state-poll.test.ts` and `reconcile-story-mapped-status.test.ts`.
 *
 * Run with: corepack pnpm --filter @repo/temporal exec vitest run __tests__/pm-state-poll-status-sync-wiring.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	projectFindUnique: vi.fn(),
	userStoryFindUnique: vi.fn(),
	userStoryUpdate: vi.fn(),
	projectStoryStatusFindMany: vi.fn(),
	findFabricItemByExternalId: vi.fn(),
	applyTerminalClose: vi.fn(),
	applyTerminalUnhide: vi.fn(),
	upsertPendingChange: vi.fn(),
	clearPendingContentDrift: vi.fn(),
	mergePmStatusSyncLastRun: vi.fn(),
	reconcileStoryMappedStatus: vi.fn(),
	recordTerminalObservation: vi.fn(),
	resolveTrusted: vi.fn(),
	loggerError: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		project: { findUnique: m.projectFindUnique },
		userStory: {
			findUnique: m.userStoryFindUnique,
			update: m.userStoryUpdate,
		},
		projectStoryStatus: { findMany: m.projectStoryStatusFindMany },
	},
	findFabricItemByExternalId: m.findFabricItemByExternalId,
	applyTerminalClose: m.applyTerminalClose,
	applyTerminalUnhide: m.applyTerminalUnhide,
	upsertPendingChange: m.upsertPendingChange,
	clearPendingContentDrift: m.clearPendingContentDrift,
	recordAudit: vi.fn(),
	mergePmStatusSyncLastRun: m.mergePmStatusSyncLastRun,
}));

vi.mock(
	"../src/activities/pm-integration/reconcile-story-mapped-status",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../src/activities/pm-integration/reconcile-story-mapped-status")
		>()),
		reconcileStoryMappedStatus: m.reconcileStoryMappedStatus,
		recordTerminalObservation: m.recordTerminalObservation,
	}),
);

// The AC8 org lookup for never-stamped MCP stories (it reads mCPServer,
// mCPConfig and the project's links); counted here, decided in the real-leaf
// suite.
vi.mock("../src/activities/pm-integration/pm-server-provenance", () => ({
	resolveTrusted: m.resolveTrusted,
}));

vi.mock("../src/activities/pm-integration/record-pm-sync-log", () => ({
	recordPmSyncLog: vi.fn(),
}));

vi.mock("../src/activities/pm-integration/story-sync", () => ({
	fetchPMItemsByIds: vi.fn(),
	getWorkItemsByIdsFromPM: vi.fn(),
	extractItemState: vi.fn(),
	extractChangedDate: vi.fn(),
}));

vi.mock("@repo/logs", () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
		error: m.loggerError,
	},
}));

import {
	type PmWorkItemState,
	reconcileAdoStates,
} from "../src/activities/pm-integration/pm-state-poll";
import {
	hashTerminalStatuses,
	resolveTerminalSet,
} from "../src/activities/pm-integration/pm-terminal-config";
import { STATUS_SYNC_STORY_SELECT } from "../src/activities/pm-integration/reconcile-story-mapped-status";
import {
	createFakeTable,
	type RecordedCall,
	type Row,
} from "./test-helpers/select-honouring-db";

const NOW = new Date("2026-09-21T12:00:00.000Z");
const SESSION = new Date("2026-09-20T09:00:00.000Z");
const BASE_AT = new Date("2026-09-01T10:00:00.000Z");
const CHANGED = "2026-09-02T10:00:00.000Z";
const TERMINALS = ["Closed", "Done", "Removed"];
const GITLAB_SERVER = "key:gitlab-official";
const issueUrl = (iid: string) =>
	`https://gitlab.example.com/acme/portal/-/issues/${iid}`;

let projectRows: Row[];
let storyRows: Row[];
let statusRows: Row[];
const dbCalls: RecordedCall[] = [];

const projectRow = (over: Row = {}): Row => ({
	id: "proj-1",
	organizationId: "org-1",
	userId: "user-9",
	pmTerminalStatuses: TERMINALS,
	pmAutoCloseEnabled: true,
	pmStatusSyncEnabled: true,
	pmStatusSyncSessionAt: SESSION,
	projectManagementAdditionalContext: {
		labelStatusMap: { "workflow::in-review": "st-review" },
		// A non-string value is dropped, never passed to the resolver.
		statusColumnMap: { "st-review": "col-review", "st-broken": 7 },
	},
	projectManagementMcpServerId: GITLAB_SERVER,
	projectManagementMcpConfigId: null,
	...over,
});

const storyRow = (id: string, iid: string, over: Row = {}): Row => ({
	id,
	projectId: "proj-1",
	title: `Story ${iid}`,
	statusId: "st-todo",
	order: 1,
	draftingStage: "DRAFT",
	pmAutoHidden: false,
	pmStatusSyncBaseId: "st-todo",
	pmStatusSyncBaseAt: BASE_AT,
	pmStatusSyncBaseLink: issueUrl(iid),
	pmStatusSyncBaseFabricId: "st-todo",
	lastPmSyncStatus: null,
	externalId: iid,
	externalUrl: issueUrl(iid),
	externalMcpServerId: null,
	...over,
});

const verdict = (
	iid: string,
	over: Partial<PmWorkItemState> = {},
): PmWorkItemState => ({
	externalId: iid,
	state: "",
	stateChangedDate: CHANGED,
	isClosed: false,
	labels: ["workflow::in-review"],
	classification: "passthrough",
	itemUrl: issueUrl(iid),
	...over,
});

const run = (
	items: PmWorkItemState[],
	terminalStatusesHash = hashTerminalStatuses(resolveTerminalSet(TERMINALS)),
) =>
	reconcileAdoStates({
		projectId: "proj-1",
		items,
		pmTool: "gitlab-official",
		terminalStatusesHash,
	});

/** Story 42 exactly as `STATUS_SYNC_STORY_SELECT` projects it. */
const STORY_42 = {
	id: "story-a",
	title: "Story 42",
	statusId: "st-todo",
	order: 1,
	pmStatusSyncBaseId: "st-todo",
	pmStatusSyncBaseAt: BASE_AT,
	pmStatusSyncBaseLink: issueUrl("42"),
	pmStatusSyncBaseFabricId: "st-todo",
	lastPmSyncStatus: null,
	externalId: "42",
	externalUrl: issueUrl("42"),
	externalMcpServerId: null,
};

const ZERO_COUNTS = {
	moved: 0,
	unchanged: 0,
	"fabric-ahead": 0,
	"not-mapped": 0,
	ambiguous: 0,
	unverified: 0,
	stale: 0,
	"skipped-conflict": 0,
	raced: 0,
};

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
	dbCalls.length = 0;
	projectRows = [projectRow()];
	statusRows = [
		{ id: "st-todo", projectId: "proj-1", name: "To Do" },
		{ id: "st-review", projectId: "proj-1", name: "In Review" },
	];
	storyRows = [
		storyRow("story-a", "42"),
		storyRow("story-b", "43", {
			draftingStage: "CLOSED",
			pmAutoHidden: true,
		}),
	];
	m.projectFindUnique.mockImplementation(
		createFakeTable("project", () => projectRows, dbCalls).findUnique,
	);
	m.userStoryFindUnique.mockImplementation(
		createFakeTable("userStory", () => storyRows, dbCalls).findUnique,
	);
	m.projectStoryStatusFindMany.mockImplementation(
		createFakeTable("projectStoryStatus", () => statusRows, dbCalls)
			.findMany,
	);
	m.userStoryUpdate.mockResolvedValue({});
	m.findFabricItemByExternalId.mockImplementation(
		async (_projectId: string, externalId: string) => {
			const row = storyRows.find((s) => s.externalId === externalId);
			return row
				? {
						entityType: "STORY",
						entityId: row.id,
						draftingStage: row.draftingStage,
						lastSyncedPmHash: null,
						lastPmSyncStatus: null,
						pmAutoHidden: row.pmAutoHidden,
					}
				: null;
		},
	);
	m.applyTerminalClose.mockResolvedValue({ applied: true });
	m.applyTerminalUnhide.mockResolvedValue({ applied: true });
	m.upsertPendingChange.mockResolvedValue({
		action: "created",
		pendingId: "pending-1",
	});
	m.clearPendingContentDrift.mockResolvedValue(0);
	m.mergePmStatusSyncLastRun.mockResolvedValue(undefined);
	m.reconcileStoryMappedStatus.mockResolvedValue({ outcome: "moved" });
	m.recordTerminalObservation.mockResolvedValue(undefined);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("reconcileAdoStates → status-sync leaf wiring (Fizzy #2304)", () => {
	it("calls the leaf once per passthrough and auto-unhid verdict, with the exact input", async () => {
		await run([verdict("42"), verdict("43", { classification: "reopen" })]);

		expect(m.applyTerminalUnhide).toHaveBeenCalledTimes(1);
		expect(m.reconcileStoryMappedStatus).toHaveBeenCalledTimes(2);
		expect(m.reconcileStoryMappedStatus.mock.calls[0][0]).toEqual({
			projectId: "proj-1",
			tenant: { organizationId: "org-1", ownerUserId: "user-9" },
			item: {
				externalId: "42",
				state: "",
				labels: ["workflow::in-review"],
				stateChangedDate: new Date(CHANGED),
				itemUrl: issueUrl("42"),
			},
			story: STORY_42,
			config: {
				labelStatusMap: { "workflow::in-review": "st-review" },
				statusColumnMap: { "st-review": "col-review" },
				projectStatuses: [
					{ id: "st-todo", name: "To Do" },
					{ id: "st-review", name: "In Review" },
				],
			},
			source: {
				isRest: true,
				activeServerId: GITLAB_SERVER,
				pmToolKey: "gitlab-official",
				pmToolLabel: "GitLab",
				activeOrg: null,
			},
		});
		// D2.5 — the story is read through the leaf's select, scoped to the project.
		expect(
			dbCalls.find(
				(c) => c.table === "userStory" && c.method === "findUnique",
			)?.args,
		).toEqual({
			where: { id: "story-a", projectId: "proj-1" },
			select: STATUS_SYNC_STORY_SELECT,
		});
		// The project's statuses are read once per run, not per item.
		expect(
			dbCalls.filter((c) => c.table === "projectStoryStatus"),
		).toHaveLength(1);
	});

	it("an UNHIDE proposal never reaches the leaf — after a positive control", async () => {
		// Positive controls: with auto-close on, a reopen auto-unhides and
		// syncs, and a terminal verdict records its observation.
		await run([
			verdict("42", { classification: "terminal", isClosed: true }),
			verdict("43", { classification: "reopen" }),
		]);
		expect(m.reconcileStoryMappedStatus).toHaveBeenCalledTimes(1);
		expect(m.recordTerminalObservation).toHaveBeenCalledTimes(1);

		m.reconcileStoryMappedStatus.mockClear();
		m.recordTerminalObservation.mockClear();
		projectRows = [projectRow({ pmAutoCloseEnabled: false })];
		await run([verdict("43", { classification: "reopen" })]);

		expect(m.upsertPendingChange).toHaveBeenCalledWith(
			expect.objectContaining({ proposedAction: "UNHIDE" }),
		);
		expect(m.reconcileStoryMappedStatus).not.toHaveBeenCalled();
		expect(m.recordTerminalObservation).not.toHaveBeenCalled();
	});

	it("a terminal verdict calls recordTerminalObservation with the story's link key, never the leaf — after a positive control", async () => {
		projectRows = [projectRow({ pmAutoCloseEnabled: false })];
		// Positive control: the same story's passthrough verdict reaches the leaf.
		await run([verdict("42")]);
		expect(m.reconcileStoryMappedStatus).toHaveBeenCalledTimes(1);

		m.reconcileStoryMappedStatus.mockClear();
		await run([
			verdict("42", { classification: "terminal", isClosed: true }),
		]);

		expect(m.recordTerminalObservation.mock.calls).toEqual([
			[
				{
					projectId: "proj-1",
					story: STORY_42,
					linkKey: issueUrl("42"),
					stateChangedDate: new Date(CHANGED),
				},
			],
		]);
		expect(m.reconcileStoryMappedStatus).not.toHaveBeenCalled();
	});

	it("a terminal verdict on a story with no link key records nothing — after a positive control", async () => {
		projectRows = [projectRow({ pmAutoCloseEnabled: false })];
		const terminal = verdict("42", {
			classification: "terminal",
			isClosed: true,
		});
		await run([terminal]);
		expect(m.recordTerminalObservation).toHaveBeenCalledTimes(1);

		m.recordTerminalObservation.mockClear();
		storyRows[0].externalUrl = null;
		await run([terminal]);
		expect(m.recordTerminalObservation).not.toHaveBeenCalled();
	});

	it("with the switch off, neither function is called and nothing is read for status sync — after a positive control", async () => {
		const items = [
			verdict("42"),
			verdict("43", { classification: "terminal", isClosed: true }),
		];
		// Positive controls for every negative below.
		await run(items);
		expect(m.reconcileStoryMappedStatus).toHaveBeenCalledTimes(1);
		expect(m.recordTerminalObservation).toHaveBeenCalledTimes(1);
		expect(m.mergePmStatusSyncLastRun).toHaveBeenCalledTimes(1);
		expect(
			new Set(
				dbCalls
					.filter((c) => c.table !== "project")
					.map((c) => c.table),
			),
		).toEqual(new Set(["projectStoryStatus", "userStory"]));

		m.reconcileStoryMappedStatus.mockClear();
		m.recordTerminalObservation.mockClear();
		m.mergePmStatusSyncLastRun.mockClear();
		dbCalls.length = 0;
		projectRows = [projectRow({ pmStatusSyncEnabled: false })];
		await run(items);

		expect(m.reconcileStoryMappedStatus).not.toHaveBeenCalled();
		expect(m.recordTerminalObservation).not.toHaveBeenCalled();
		expect(m.mergePmStatusSyncLastRun).not.toHaveBeenCalled();
		expect(dbCalls.filter((c) => c.table !== "project")).toEqual([]);
	});

	it("tallies every outcome the leaf reports into ONE last-run write", async () => {
		const iids = ["42", "43", "44", "45", "46"];
		storyRows = iids.map((iid) => storyRow(`story-${iid}`, iid));
		for (const outcome of [
			"moved",
			"moved",
			"unverified",
			"raced",
			"stale",
		]) {
			m.reconcileStoryMappedStatus.mockResolvedValueOnce({ outcome });
		}

		await run(iids.map((iid) => verdict(iid)));

		expect(m.mergePmStatusSyncLastRun.mock.calls).toEqual([
			[
				{
					projectId: "proj-1",
					sessionAt: SESSION,
					patch: {
						outcome: {
							at: NOW.toISOString(),
							counts: {
								...ZERO_COUNTS,
								moved: 2,
								unverified: 1,
								stale: 1,
								raced: 1,
							},
						},
					},
				},
			],
		]);
	});

	it("the settings-hash gate applies nothing and writes no outcome — after a positive control", async () => {
		await run([verdict("42")]);
		expect(m.mergePmStatusSyncLastRun).toHaveBeenCalledTimes(1);
		expect(m.reconcileStoryMappedStatus).toHaveBeenCalledTimes(1);

		m.mergePmStatusSyncLastRun.mockClear();
		m.reconcileStoryMappedStatus.mockClear();
		const result = await run(
			[verdict("42")],
			hashTerminalStatuses(resolveTerminalSet(["Closed"])),
		);

		expect(result.settingsStable).toBe(false);
		expect(m.reconcileStoryMappedStatus).not.toHaveBeenCalled();
		expect(m.mergePmStatusSyncLastRun).not.toHaveBeenCalled();
	});

	it("a switch-on project with no session stamp still syncs but writes no summary — after a positive control", async () => {
		// Positive control: the same run with a session writes the summary.
		await run([verdict("42")]);
		expect(m.mergePmStatusSyncLastRun).toHaveBeenCalledTimes(1);

		m.mergePmStatusSyncLastRun.mockClear();
		m.reconcileStoryMappedStatus.mockClear();
		projectRows = [projectRow({ pmStatusSyncSessionAt: null })];

		await run([verdict("42")]);

		expect(m.reconcileStoryMappedStatus).toHaveBeenCalledTimes(1);
		expect(m.mergePmStatusSyncLastRun).not.toHaveBeenCalled();
	});

	it("passes itemUrl through unchanged — an absent key stays absent, null stays null — and does not tally a null outcome", async () => {
		const iids = ["42", "43", "44"];
		storyRows = iids.map((iid) => storyRow(`story-${iid}`, iid));
		m.reconcileStoryMappedStatus
			.mockResolvedValueOnce({ outcome: null })
			.mockResolvedValueOnce({ outcome: "moved" })
			.mockResolvedValueOnce({ outcome: "unverified" });
		// 42 as fetch emits it with the switch off (no key); 43 with a URL;
		// 44 with the switch on but no URL on the issue.
		const switchOff: PmWorkItemState = {
			externalId: "42",
			state: "",
			stateChangedDate: CHANGED,
			isClosed: false,
			labels: ["workflow::in-review"],
			classification: "passthrough",
		};

		await run([switchOff, verdict("43"), verdict("44", { itemUrl: null })]);

		expect(m.reconcileStoryMappedStatus).toHaveBeenCalledTimes(3);
		const leafItem = (call: number) =>
			m.reconcileStoryMappedStatus.mock.calls[call][0].item;
		// Positive controls: a present URL arrives as-is, and so does a null.
		expect(leafItem(1)).toHaveProperty("itemUrl", issueUrl("43"));
		expect(leafItem(2)).toHaveProperty("itemUrl", null);
		// Never coerced to null (nor set to undefined): an absent key is what
		// tells the leaf "not observed".
		expect(leafItem(0)).not.toHaveProperty("itemUrl");
		expect(
			m.mergePmStatusSyncLastRun.mock.calls[0][0].patch.outcome.counts,
		).toEqual({ ...ZERO_COUNTS, moved: 1, unverified: 1 });
	});

	it("a story gone by the time it is read is skipped, not counted — after a positive control", async () => {
		// Positive control: the story is there, so the leaf runs and counts.
		await run([verdict("42")]);
		expect(m.reconcileStoryMappedStatus).toHaveBeenCalledTimes(1);
		expect(
			m.mergePmStatusSyncLastRun.mock.calls[0][0].patch.outcome.counts
				.moved,
		).toBe(1);

		m.reconcileStoryMappedStatus.mockClear();
		m.mergePmStatusSyncLastRun.mockClear();
		m.findFabricItemByExternalId.mockResolvedValue({
			entityType: "STORY",
			entityId: "story-deleted",
			draftingStage: "DRAFT",
			lastSyncedPmHash: null,
			lastPmSyncStatus: null,
			pmAutoHidden: false,
		});

		await run([verdict("42")]);

		expect(m.reconcileStoryMappedStatus).not.toHaveBeenCalled();
		expect(
			m.mergePmStatusSyncLastRun.mock.calls[0][0].patch.outcome.counts,
		).toEqual(ZERO_COUNTS);
	});

	it("a status-sync failure on one story is logged and not counted; later stories still get terminal handling and their outcome, and the summary is written — after a positive control", async () => {
		storyRows = [
			storyRow("story-a", "42"),
			storyRow("story-b", "43"),
			storyRow("story-c", "44"),
		];
		// A syncs; B closes in the PM tool (auto-close is on); C syncs.
		const items = [
			verdict("42"),
			verdict("43", { classification: "terminal", isClosed: true }),
			verdict("44"),
		];

		// Positive control: with no failure, A and C both count, B auto-hides
		// and records its terminal observation.
		const clean = await run(items);
		expect(clean.storiesAutoHidden).toBe(1);
		expect(
			m.reconcileStoryMappedStatus.mock.calls.map((c) => c[0].story.id),
		).toEqual(["story-a", "story-c"]);
		expect(
			m.recordTerminalObservation.mock.calls.map((c) => c[0].story.id),
		).toEqual(["story-b"]);
		expect(
			m.mergePmStatusSyncLastRun.mock.calls[0][0].patch.outcome.counts,
		).toEqual({ ...ZERO_COUNTS, moved: 2 });

		m.reconcileStoryMappedStatus.mockClear();
		m.recordTerminalObservation.mockClear();
		m.mergePmStatusSyncLastRun.mockClear();
		m.applyTerminalClose.mockClear();
		m.loggerError.mockClear();
		m.reconcileStoryMappedStatus.mockRejectedValueOnce(
			new Error("deadlock detected"),
		);

		const result = await run(items);

		// A's failure is logged with its project and story — the message only.
		expect(m.loggerError.mock.calls).toEqual([
			[
				"[PM Poll] Status sync failed for a story; continuing with the next",
				{
					projectId: "proj-1",
					storyId: "story-a",
					error: "deadlock detected",
				},
			],
		]);
		// B, after it, still gets its terminal handling (auto-hidden) and its
		// terminal observation…
		expect(result.storiesAutoHidden).toBe(1);
		expect(m.applyTerminalClose).toHaveBeenCalledWith(
			expect.objectContaining({ entityId: "story-b" }),
		);
		expect(
			m.recordTerminalObservation.mock.calls.map((c) => c[0].story.id),
		).toEqual(["story-b"]);
		// …C still reaches the leaf…
		expect(
			m.reconcileStoryMappedStatus.mock.calls.map((c) => c[0].story.id),
		).toEqual(["story-a", "story-c"]);
		// …and the summary is still written, without A.
		expect(m.mergePmStatusSyncLastRun.mock.calls).toEqual([
			[
				{
					projectId: "proj-1",
					sessionAt: SESSION,
					patch: {
						outcome: {
							at: NOW.toISOString(),
							counts: { ...ZERO_COUNTS, moved: 1 },
						},
					},
				},
			],
		]);
	});

	it("a server-stamped MCP story reaches the leaf with activeOrg null and never triggers the org lookup — after a never-stamped positive control", async () => {
		projectRows = [
			projectRow({
				projectManagementMcpServerId: "srv-ado",
				projectManagementMcpConfigId: "cfg-ado",
				projectManagementAdditionalContext: {},
			}),
		];
		const adoUrl = (id: string) =>
			`https://dev.azure.com/example-org/Portal/_workitems/edit/${id}`;
		// Both already carry a base link (observed before); only the server
		// stamp differs, and the stamp is what decides whether the org is needed.
		storyRows = [
			storyRow("story-stamped", "103", {
				externalUrl: adoUrl("103"),
				externalMcpServerId: "srv-ado",
				pmStatusSyncBaseLink: "103",
			}),
			storyRow("story-unstamped", "101", {
				externalUrl: adoUrl("101"),
				pmStatusSyncBaseLink: "101",
			}),
		];
		const trusted = { kind: "trusted", key: "example-org" } as const;
		m.resolveTrusted.mockResolvedValue({
			ok: true,
			activeServerId: "srv-ado",
			toolType: "ado",
			trusted,
			links: [],
		});
		const adoVerdict = (externalId: string): PmWorkItemState => ({
			externalId,
			state: "Active",
			stateChangedDate: CHANGED,
			isClosed: null,
			labels: [],
			classification: "passthrough",
			itemUrl: null,
		});
		const runAdo = (items: PmWorkItemState[]) =>
			reconcileAdoStates({
				projectId: "proj-1",
				items,
				pmTool: "azure-devops",
				terminalStatusesHash: hashTerminalStatuses(
					resolveTerminalSet(TERMINALS),
				),
			});
		const source = (activeOrg: unknown) => ({
			isRest: false,
			activeServerId: "srv-ado",
			pmToolKey: "azure-devops",
			pmToolLabel: "Azure DevOps",
			activeOrg,
		});
		const leafSource = (call: number) =>
			m.reconcileStoryMappedStatus.mock.calls[call][0].source;

		// Positive control, same run: the never-stamped story (second) looks the
		// org up once and passes it on…
		await runAdo([adoVerdict("103"), adoVerdict("101")]);
		expect(leafSource(1)).toEqual(source(trusted));
		expect(m.resolveTrusted).toHaveBeenCalledTimes(1);
		expect(m.resolveTrusted.mock.calls[0][1]).toEqual({
			id: "proj-1",
			projectManagementMcpServerId: "srv-ado",
			projectManagementMcpConfigId: "cfg-ado",
		});
		// …while the stamped story (first) reached the leaf before that lookup,
		// with no org.
		expect(leafSource(0)).toEqual(source(null));
		expect(m.resolveTrusted.mock.invocationCallOrder[0]).toBeGreaterThan(
			m.reconcileStoryMappedStatus.mock.invocationCallOrder[0],
		);

		// The stamped story alone: no lookup at all.
		m.resolveTrusted.mockClear();
		m.reconcileStoryMappedStatus.mockClear();
		await runAdo([adoVerdict("103")]);
		expect(m.reconcileStoryMappedStatus).toHaveBeenCalledTimes(1);
		expect(leafSource(0)).toEqual(source(null));
		expect(m.resolveTrusted).not.toHaveBeenCalled();
	});
});
