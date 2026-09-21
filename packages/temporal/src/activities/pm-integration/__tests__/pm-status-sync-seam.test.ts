/**
 * PM status sync — cross-layer seams and round trips (Fizzy #2304, spec §6).
 *
 * Every module between the GitLab REST wire and the database runs for real:
 * `getGitLabIssueForPM` / `updateGitLabIssueFromStory` (pm-adapter), the REST
 * dispatcher `callPmToolWithFallback`, `fetchPMItemsByIds`,
 * `fetchAdoWorkItemStates` (and `buildPollVerdict` inside it), the verdict's
 * JSON crossing of the workflow boundary, `reconcileAdoStates`, the status-
 * sync leaf, and the push `syncGitLabStoryViaRest`.
 *
 * Mocked on the seam, and nothing else:
 *  - `executeGitLabTool` — the wire. A small in-memory GitLab answers
 *    `get_issue` with verbatim issue JSON and applies `update_issue` (title,
 *    description, add_labels, remove_labels) itself, stamping `updated_at`
 *    from a scripted server clock;
 *  - `resolvePmSource` — returns the REST source without a token lookup;
 *  - `@repo/database` — the in-memory store in `./pm-status-sync-fake-db`.
 *
 * Forbidden here (spec §6): mocking `callPmToolWithFallback` or
 * `getGitLabIssueForPM`. The remaining stubs — MCP plumbing and logging — are
 * off the REST path and exist only so the real chain loads under a fake
 * database.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
	const { fakeDatabaseModule } = await import("./pm-status-sync-fake-db");
	return fakeDatabaseModule();
});

type FakeIssue = {
	iid: number;
	title: string;
	description: string | null;
	labels: string[];
	updated_at: string;
	web_url: string;
	[field: string]: unknown;
};

const gitlab = vi.hoisted(() => {
	const state: {
		issue: FakeIssue | null;
		/** One `updated_at` per write, in order. */
		clock: string[];
		/** When set, the next update answers with this body verbatim. */
		nextUpdateResponse: FakeIssue | null;
	} = { issue: null, clock: [], nextUpdateResponse: null };
	const splitLabels = (value: unknown): string[] =>
		typeof value === "string" && value.length > 0 ? value.split(",") : [];
	// Mirrors executeGitLabTool's update_issue return (gitlab/index.ts:1458-1466).
	const withStructuredContent = (issue: FakeIssue) => ({
		...structuredClone(issue),
		structuredContent: {
			url: issue.web_url,
			title: issue.title,
			number: issue.iid,
			labels: issue.labels,
		},
	});
	const execute = vi.fn(
		async (method: string, args: Record<string, unknown>) => {
			const issue = state.issue;
			if (!issue) {
				throw new Error("fake GitLab: no issue seeded");
			}
			if (Number(args.issue_iid) !== issue.iid) {
				throw new Error("404 Not Found");
			}
			if (method === "get_issue") {
				return structuredClone(issue);
			}
			if (method === "update_issue") {
				if (state.nextUpdateResponse) {
					const verbatim = state.nextUpdateResponse;
					state.nextUpdateResponse = null;
					return withStructuredContent(verbatim);
				}
				const next = structuredClone(issue);
				if (typeof args.title === "string") {
					next.title = args.title;
				}
				if (typeof args.description === "string") {
					next.description = args.description;
				}
				const removed = new Set(splitLabels(args.remove_labels));
				next.labels = next.labels.filter(
					(label) => !removed.has(label),
				);
				for (const label of splitLabels(args.add_labels)) {
					if (!next.labels.includes(label)) {
						next.labels.push(label);
					}
				}
				const at = state.clock.shift();
				if (!at) {
					throw new Error(
						"fake GitLab: server clock exhausted — script one updated_at per write",
					);
				}
				next.updated_at = at;
				state.issue = next;
				return withStructuredContent(next);
			}
			throw new Error(`fake GitLab: ${method} is not modelled`);
		},
	);
	return { state, execute };
});

// No importOriginal: gitlab/index.ts re-exports ./pm-adapter, which imports
// ./index back — importOriginal here would recurse into this very mock. These
// are exactly the three names pm-adapter imports from ./index.
vi.mock("@repo/integrations/gitlab", () => ({
	executeGitLabTool: gitlab.execute,
	getGitLabAccessToken: async () => null,
	refreshMcpConfigToken: async () => {
		throw new Error("fake GitLab: token refresh is off this seam");
	},
}));

const seam = vi.hoisted(() => ({ resolvePmSource: vi.fn() }));
vi.mock("../../pm-source", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../pm-source")>()),
	resolvePmSource: seam.resolvePmSource,
}));

// Off-seam stubs (see header): MCP plumbing never reached on the REST path.
vi.mock("@repo/agent-core/backend", () => ({
	getMcpClient: vi.fn(),
	getMcpClientResult: vi.fn(),
	closeMcpClientSafe: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../orchestrator/execution/execute-mcp-tool", () => ({
	executeMcpTool: vi.fn(),
}));
vi.mock("@repo/logs", () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		log: vi.fn(),
	},
}));

import { syncGitLabStoryViaRest } from "../gitlab-rest-story-sync";
import {
	type FetchAdoWorkItemStatesResult,
	fetchAdoWorkItemStates,
	reconcileAdoStates,
} from "../pm-state-poll";
import { computePmHash } from "../pm-sync-hash";
import {
	fakeStore,
	type Row,
	resetFakeStore,
	tableRows,
} from "./pm-status-sync-fake-db";

const PROJECT_ID = "proj-1";
const ORG_ID = "org-1";
const OWNER_ID = "owner-1";
const EDITOR_ID = "editor-1";
const SERVER_ID = "key:gitlab-official";
const CONTAINER = "example-group/example-project";
const WEB_URL = "https://gitlab.com/example-group/example-project/-/issues/7";
const T0 = "2026-09-18T09:00:00.000Z";

const LABEL_STATUS_MAP = {
	"workflow::todo": "st-todo",
	"workflow::in-review": "st-progress",
	"workflow::done": "st-done",
};
const PROJECT_CONTEXT = { labelStatusMap: LABEL_STATUS_MAP };

const REST_SOURCE = {
	kind: "rest-gitlab" as const,
	token: "tok-test",
	baseUrl: "https://gitlab.com/api/v4",
	projectId: CONTAINER,
};

/** `GET /projects/:id/issues/7` as GitLab returns it (synthetic values). */
const ISSUE_JSON: FakeIssue = {
	id: 184302771,
	iid: 7,
	project_id: 61200345,
	title: "Checkout flow",
	description: "Customers can pay with a saved card.",
	state: "opened",
	created_at: "2026-09-01T08:12:40.117Z",
	updated_at: "2026-09-20T14:03:11.482Z",
	closed_at: null,
	closed_by: null,
	labels: ["type::feature", "workflow::in-review"],
	milestone: null,
	assignees: [],
	author: {
		id: 1000001,
		username: "example-user",
		name: "Example User",
		state: "active",
		locked: false,
		avatar_url: null,
		web_url: "https://gitlab.com/example-user",
	},
	type: "ISSUE",
	assignee: null,
	user_notes_count: 0,
	merge_requests_count: 0,
	upvotes: 0,
	downvotes: 0,
	due_date: null,
	confidential: false,
	discussion_locked: null,
	issue_type: "issue",
	web_url: WEB_URL,
	time_stats: {
		time_estimate: 0,
		total_time_spent: 0,
		human_time_estimate: null,
		human_total_time_spent: null,
	},
	task_completion_status: { count: 0, completed_count: 0 },
	has_tasks: true,
	task_status: "0 of 0 checklist items completed",
	_links: {
		self: "https://gitlab.com/api/v4/projects/61200345/issues/7",
		notes: "https://gitlab.com/api/v4/projects/61200345/issues/7/notes",
		award_emoji:
			"https://gitlab.com/api/v4/projects/61200345/issues/7/award_emoji",
		project: "https://gitlab.com/api/v4/projects/61200345",
		closed_as_duplicate_of: null,
	},
	references: {
		short: "#7",
		relative: "#7",
		full: "example-group/example-project#7",
	},
	severity: "UNKNOWN",
	subscribed: true,
	moved_to_id: null,
	imported: false,
	imported_from: "none",
	service_desk_reply_to: null,
};

/** `PUT /projects/:id/issues/7` response body (synthetic values). */
const PUT_RESPONSE_JSON: FakeIssue = {
	id: 184302771,
	iid: 7,
	project_id: 61200345,
	title: "Checkout flow",
	description: "Customers can pay with a saved card.",
	state: "opened",
	created_at: "2026-09-01T08:12:40.117Z",
	updated_at: "2026-09-21T09:15:42.120Z",
	closed_at: null,
	closed_by: null,
	labels: ["type::feature", "workflow::in-review"],
	milestone: null,
	assignees: [],
	author: {
		id: 1000001,
		username: "example-user",
		name: "Example User",
		state: "active",
		locked: false,
		avatar_url: null,
		web_url: "https://gitlab.com/example-user",
	},
	type: "ISSUE",
	assignee: null,
	user_notes_count: 0,
	merge_requests_count: 0,
	upvotes: 0,
	downvotes: 0,
	due_date: null,
	confidential: false,
	discussion_locked: null,
	issue_type: "issue",
	web_url: WEB_URL,
	time_stats: {
		time_estimate: 0,
		total_time_spent: 0,
		human_time_estimate: null,
		human_total_time_spent: null,
	},
	task_completion_status: { count: 0, completed_count: 0 },
	has_tasks: true,
	task_status: "0 of 0 checklist items completed",
	_links: {
		self: "https://gitlab.com/api/v4/projects/61200345/issues/7",
		notes: "https://gitlab.com/api/v4/projects/61200345/issues/7/notes",
		award_emoji:
			"https://gitlab.com/api/v4/projects/61200345/issues/7/award_emoji",
		project: "https://gitlab.com/api/v4/projects/61200345",
		closed_as_duplicate_of: null,
	},
	references: {
		short: "#7",
		relative: "#7",
		full: "example-group/example-project#7",
	},
	severity: "UNKNOWN",
	subscribed: true,
	moved_to_id: null,
	imported: false,
	imported_from: "none",
	service_desk_reply_to: null,
};

function projectRow(): Row {
	return {
		id: PROJECT_ID,
		organizationId: ORG_ID,
		userId: OWNER_ID,
		status: "ACTIVE",
		pmTerminalStatuses: [],
		pmAutoCloseEnabled: false,
		pmStatusSyncEnabled: true,
		pmStatusSyncSessionAt: new Date("2026-09-15T12:00:00.000Z"),
		pmStatusSyncLastRun: null,
		projectManagementAdditionalContext: PROJECT_CONTEXT,
		projectManagementMcpServerId: SERVER_ID,
		projectManagementMcpConfigId: null,
		projectManagementContainerId: CONTAINER,
		projectManagementContainerName: null,
		adoStatePollActive: true,
		lastAdoStatePollAt: null,
		syncAttachments: false,
	};
}

const STATUS_ROWS: Row[] = [
	{
		id: "st-todo",
		projectId: PROJECT_ID,
		name: "To Do",
		color: "stone",
		order: 0,
		isDefault: true,
		isFinal: false,
	},
	{
		id: "st-progress",
		projectId: PROJECT_ID,
		name: "In Progress",
		color: "amber",
		order: 1,
		isDefault: false,
		isFinal: false,
	},
	{
		id: "st-done",
		projectId: PROJECT_ID,
		name: "Done",
		color: "emerald",
		order: 2,
		isDefault: false,
		isFinal: true,
	},
];

/**
 * Issue 7's story: linked, content-synced, base = To Do at T0 under its
 * current link, Fabric side still carrying a stale label copy.
 */
function linkedStory(overrides: Row = {}): Row {
	return {
		id: "story-7",
		projectId: PROJECT_ID,
		identifier: "F-007",
		title: ISSUE_JSON.title,
		description: ISSUE_JSON.description,
		acceptanceCriteria: null,
		releaseNotes: null,
		priority: "P2_MEDIUM",
		size: null,
		storyPoints: null,
		kind: "FEATURE",
		statusId: "st-todo",
		order: 1,
		labels: ["workflow::todo"],
		externalId: "7",
		externalUrl: WEB_URL,
		externalMcpServerId: SERVER_ID,
		draftingStage: "DRAFT",
		pmAutoHidden: false,
		pmTicketTerminal: false,
		pmTicketTerminalStatus: null,
		lastSyncedPmHash: computePmHash(
			ISSUE_JSON.title,
			ISSUE_JSON.description,
		),
		lastSyncedAt: new Date(T0),
		lastPmSyncStatus: "SUCCESS",
		lastPmSyncError: null,
		lastPmSyncAttemptAt: new Date(T0),
		lastSyncedStatusId: null,
		pmAutoSyncEnabled: true,
		pmStatusSyncBaseId: "st-todo",
		pmStatusSyncBaseAt: new Date(T0),
		pmStatusSyncBaseLink: WEB_URL,
		// Observed To Do while Fabric showed To Do.
		pmStatusSyncBaseFabricId: "st-todo",
		lastEditedAt: new Date(T0),
		lastEditedByName: "Example Editor",
		lastEditedSource: "MANUAL",
		assigneeId: null,
		version: 1,
		createdAt: new Date("2026-09-01T08:12:40.117Z"),
		updatedAt: new Date(T0),
		...overrides,
	};
}

/**
 * An unlinked story already in In Progress: a `moved` story must land AFTER
 * it (end of the target column, §4.4 row 10).
 */
function unlinkedStory(): Row {
	return linkedStory({
		id: "story-8",
		identifier: "F-008",
		title: "Saved-card management",
		statusId: "st-progress",
		order: 5,
		externalId: null,
		externalUrl: null,
		externalMcpServerId: null,
		lastSyncedPmHash: null,
		pmStatusSyncBaseId: null,
		pmStatusSyncBaseAt: null,
		pmStatusSyncBaseLink: null,
		pmStatusSyncBaseFabricId: null,
	});
}

function seedStore(storyOverrides: Row = {}): void {
	resetFakeStore({
		project: [projectRow()],
		projectStoryStatus: STATUS_ROWS,
		userStory: [linkedStory(storyOverrides), unlinkedStory()],
		pmSyncLog: [],
	});
}

function seedGitLab(
	issue: Pick<FakeIssue, "labels" | "updated_at">,
	clock: string[] = [],
): void {
	gitlab.state.issue = structuredClone({ ...ISSUE_JSON, ...issue });
	gitlab.state.clock = [...clock];
	gitlab.state.nextUpdateResponse = null;
}

function liveIssue(): FakeIssue {
	if (!gitlab.state.issue) {
		throw new Error("fake GitLab: no issue seeded");
	}
	return gitlab.state.issue;
}

/** The store's own row — mutating it is a Fabric-side edit. */
function storedStory(id: string): Row {
	const row = tableRows("userStory").find((r) => r.id === id);
	if (!row) {
		throw new Error(`no story ${id} in the fake store`);
	}
	return row;
}

function conflictRows(): Row[] {
	return tableRows("pmSyncLog").filter((r) => r.status === "CONFLICT");
}

function userStoryWritesSince(mark: number) {
	return fakeStore.calls
		.slice(mark)
		.filter(
			(c) =>
				c.table === "userStory" &&
				(c.method === "update" ||
					c.method === "updateMany" ||
					c.method === "create"),
		);
}

/** The last outcome summary reconcile wrote (D2.6). */
function outcomeCounts(): Record<string, number> {
	const withOutcome = fakeStore.lastRunPatches.filter(
		(p) => "outcome" in p.patch,
	);
	const last = withOutcome.at(-1);
	if (!last) {
		throw new Error("reconcile wrote no outcome summary");
	}
	return (last.patch.outcome as { counts: Record<string, number> }).counts;
}

function onlyVerdict(result: FetchAdoWorkItemStatesResult) {
	expect(result.items).toHaveLength(1);
	const [verdict] = result.items;
	if (!verdict) {
		throw new Error("no verdict");
	}
	return verdict;
}

function updateIssueArgs(): Record<string, unknown> {
	const call = gitlab.execute.mock.calls.find((c) => c[0] === "update_issue");
	if (!call) {
		throw new Error("no update_issue reached the fake GitLab");
	}
	return call[1];
}

/** One hourly poll: fetch → the workflow's JSON boundary → reconcile. */
async function runPoll(): Promise<FetchAdoWorkItemStatesResult> {
	const fetched = await fetchAdoWorkItemStates({
		projectId: PROJECT_ID,
		mcpConfigId: null,
		mcpServerId: SERVER_ID,
		pmTool: "gitlab-official",
		sourceKind: "rest-gitlab",
		containerId: CONTAINER,
		containerName: null,
		lastAdoStatePollAt: null,
		userId: OWNER_ID,
		organizationId: ORG_ID,
		projectManagementAdditionalContext: PROJECT_CONTEXT,
	});
	// Temporal ships the verdict to the reconcile activity as JSON.
	const wire = JSON.parse(
		JSON.stringify(fetched),
	) as FetchAdoWorkItemStatesResult;
	await reconcileAdoStates({
		projectId: PROJECT_ID,
		items: wire.items,
		pmTool: "gitlab-official",
		terminalStatusesHash: wire.terminalStatusesHash,
	});
	return fetched;
}

/**
 * A caller's STALE snapshot of the PM context (R20) — the AI-update workflow
 * passes one — taken before `workflow::in-review` was mapped, so it maps
 * nothing to In Progress. Were the push gate to use it, a move to In Progress
 * would send no `add_labels` and stamp `__none__`; the project's STORED map
 * (`PROJECT_CONTEXT`) sends `workflow::in-review` and stamps `st-progress`.
 */
const STALE_CALLER_CONTEXT = {
	labelStatusMap: {
		"workflow::todo": "st-todo",
		"workflow::done": "st-done",
	},
};

/**
 * A Push of story-7 by an editor. A manual Push passes the stored JSON column
 * through as-is (the default); the label map inside it is an object, which
 * `readLabelStatusMap` expects.
 */
async function push(callerContext: object = PROJECT_CONTEXT) {
	return syncGitLabStoryViaRest({
		storyId: "story-7",
		projectId: PROJECT_ID,
		mcpConfigId: null,
		mcpServerId: SERVER_ID,
		containerId: CONTAINER,
		additionalContext: callerContext as unknown as Record<string, string>,
		direction: "push",
		userId: EDITOR_ID,
		organizationId: ORG_ID,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	seam.resolvePmSource.mockResolvedValue(REST_SOURCE);
	seedStore();
});
describe("fetch seam: GitLab JSON → real adapter → REST fetch → verdict → JSON → reconcile → leaf", () => {
	it("itemUrl is the issue's web_url, and a matching link applies the ticket's mapped status", async () => {
		seedGitLab({
			labels: ["type::feature", "workflow::in-review"],
			updated_at: "2026-09-20T14:03:11.482Z",
		});

		const fetched = await runPoll();

		// Positive control: the real adapter chain reached the wire the way
		// production does — which also proves the `executeGitLabTool` mock
		// intercepted pm-adapter's relative `./index` import.
		expect(gitlab.execute).toHaveBeenCalledWith(
			"get_issue",
			{ project_id: CONTAINER, issue_iid: 7 },
			OWNER_ID,
			ORG_ID,
		);
		const verdict = onlyVerdict(fetched);
		expect(verdict.itemUrl).toBe(ISSUE_JSON.web_url);
		expect(verdict.stateChangedDate).toBe("2026-09-20T14:03:11.482Z");
		expect(verdict.labels).toEqual([
			"type::feature",
			"workflow::in-review",
		]);

		const counts = outcomeCounts();
		expect(counts.moved).toBe(1);
		expect(counts.unverified).toBe(0);
		const story = storedStory("story-7");
		expect(story.statusId).toBe("st-progress");
		expect(story.order as number).toBeGreaterThan(5);
		expect(story.pmStatusSyncBaseId).toBe("st-progress");
		expect((story.pmStatusSyncBaseAt as Date).toISOString()).toBe(
			"2026-09-20T14:03:11.482Z",
		);
		expect(
			fakeStore.audits.filter(
				(a) => a.action === "story.pm_status_synced",
			),
		).toHaveLength(1);
		expect(conflictRows()).toEqual([]);
	});

	it("near miss: a story linked to a different issue URL is unverified — no move, one CONFLICT row", async () => {
		const otherIssue =
			"https://gitlab.com/example-group/example-project/-/issues/8";
		seedStore({
			externalUrl: otherIssue,
			pmStatusSyncBaseLink: otherIssue,
		});
		seedGitLab({
			labels: ["type::feature", "workflow::in-review"],
			updated_at: "2026-09-20T14:03:11.482Z",
		});

		const fetched = await runPoll();

		// Positive control: the URL did cross the seam.
		expect(onlyVerdict(fetched).itemUrl).toBe(WEB_URL);
		const counts = outcomeCounts();
		expect(counts.unverified).toBe(1);
		expect(counts.moved).toBe(0);
		expect(storedStory("story-7").statusId).toBe("st-todo");
		expect(conflictRows()).toHaveLength(1);
		expect(conflictRows()[0]?.entityId).toBe("story-7");
	});
});

describe("update seam: verbatim PUT JSON → real updateGitLabIssueFromStory → callPmToolWithFallback", () => {
	it("stamps the base at the PUT response's updated_at, with the plan and stamp from the STORED label map (R20)", async () => {
		// Fabric moved to In Progress (≠ F, To Do); the ticket still says To Do (= P).
		seedStore({ statusId: "st-progress" });
		seedGitLab({
			labels: ["type::feature", "workflow::todo"],
			updated_at: T0,
		});
		gitlab.state.nextUpdateResponse = PUT_RESPONSE_JSON;

		// The caller hands in a stale snapshot; the project row stores
		// PROJECT_CONTEXT. Everything below follows the stored map: under the
		// snapshot there would be no `add_labels` and the stamp would be
		// `__none__`.
		const result = await push(STALE_CALLER_CONTEXT);

		expect(result.success).toBe(true);
		expect(gitlab.execute).toHaveBeenCalledWith(
			"update_issue",
			{
				project_id: CONTAINER,
				issue_iid: 7,
				title: "Checkout flow",
				description: expect.any(String),
				add_labels: "workflow::in-review",
				// Only the mapped label the push's live read saw on the ticket.
				remove_labels: "workflow::todo",
			},
			EDITOR_ID,
			ORG_ID,
		);
		const stamp = fakeStore.calls.find(
			(c) => c.table === "userStory" && c.method === "updateMany",
		);
		expect(stamp?.args).toEqual({
			where: {
				id: "story-7",
				projectId: PROJECT_ID,
				pmStatusSyncBaseId: "st-todo",
				pmStatusSyncBaseAt: new Date(T0),
				pmStatusSyncBaseLink: WEB_URL,
				pmStatusSyncBaseFabricId: "st-todo",
			},
			data: {
				pmStatusSyncBaseId: "st-progress",
				pmStatusSyncBaseAt: new Date(PUT_RESPONSE_JSON.updated_at),
				pmStatusSyncBaseLink: WEB_URL,
				pmStatusSyncBaseFabricId: "st-progress",
			},
		});
		expect(
			(storedStory("story-7").pmStatusSyncBaseAt as Date).toISOString(),
		).toBe(PUT_RESPONSE_JSON.updated_at);
	});
});

describe("AC11 round trip: Fabric move → push → poll", () => {
	it("GitLab ends with exactly the new status's mapped labels and the next poll writes nothing", async () => {
		seedGitLab(
			{ labels: ["type::feature", "workflow::todo"], updated_at: T0 },
			["2026-09-21T10:00:05.000Z"],
		);
		// The Fabric move.
		storedStory("story-7").statusId = "st-progress";

		const pushed = await push();

		expect(pushed.success).toBe(true);
		expect([...liveIssue().labels].sort()).toEqual([
			"type::feature",
			"workflow::in-review",
		]);
		expect(storedStory("story-7").pmStatusSyncBaseId).toBe("st-progress");

		const mark = fakeStore.calls.length;
		await runPoll();

		expect(outcomeCounts().unchanged).toBe(1);
		expect(storedStory("story-7").statusId).toBe("st-progress");
		// Positive control for the write probe: it sees the push's own story
		// writes (the content baseline, then the status-sync stamp).
		expect(userStoryWritesSince(0).map((c) => c.method)).toEqual([
			"update",
			"updateMany",
		]);
		expect(userStoryWritesSince(mark)).toEqual([]);
		// Positive control for the CONFLICT check: the log is written to.
		expect(
			tableRows("pmSyncLog").some(
				(r) => r.direction === "push" && r.status === "SUCCESS",
			),
		).toBe(true);
		expect(conflictRows()).toEqual([]);

		// The same harness DOES write once the ticket itself moves, so the
		// silent poll above was a decision, not a dead pipe.
		liveIssue().labels = ["type::feature", "workflow::done"];
		liveIssue().updated_at = "2026-09-21T12:00:00.000Z";
		const moveMark = fakeStore.calls.length;
		await runPoll();

		expect(outcomeCounts().moved).toBe(1);
		expect(storedStory("story-7").statusId).toBe("st-done");
		expect(userStoryWritesSince(moveMark).map((c) => c.method)).toEqual([
			"updateMany",
		]);
	});
});

describe("AC12: ticket move → content-only push → poll", () => {
	it("the push leaves the ticket's new label alone and the next poll moves Fabric", async () => {
		seedGitLab(
			{ labels: ["type::feature", "workflow::todo"], updated_at: T0 },
			["2026-09-21T11:05:00.000Z"],
		);
		// The ticket moves in GitLab, not through Fabric.
		liveIssue().labels = ["type::feature", "workflow::done"];
		liveIssue().updated_at = "2026-09-21T11:00:00.000Z";
		// A content-only Fabric edit (L = F = To Do: Fabric has not moved since
		// the observation, so the push must not touch mapped labels).
		storedStory("story-7").title = "Checkout flow with saved cards";

		const pushed = await push();

		expect(pushed.success).toBe(true);
		const update = updateIssueArgs();
		expect(update.title).toBe("Checkout flow with saved cards");
		expect(update).not.toHaveProperty("add_labels");
		expect(update).not.toHaveProperty("remove_labels");
		expect([...liveIssue().labels].sort()).toEqual([
			"type::feature",
			"workflow::done",
		]);
		// No stamp on a content-only push: the base is exactly the seeded
		// observation. P alone cannot show that — a re-stamp that kept P and
		// moved T to this write would leave `pmStatusSyncBaseId` at "st-todo",
		// and the poll below would still move (the stale rule is strict).
		const base = storedStory("story-7");
		expect({
			pmStatusSyncBaseId: base.pmStatusSyncBaseId,
			pmStatusSyncBaseAt: base.pmStatusSyncBaseAt,
			pmStatusSyncBaseLink: base.pmStatusSyncBaseLink,
			pmStatusSyncBaseFabricId: base.pmStatusSyncBaseFabricId,
		}).toEqual({
			pmStatusSyncBaseId: "st-todo",
			pmStatusSyncBaseAt: new Date(T0),
			pmStatusSyncBaseLink: WEB_URL,
			pmStatusSyncBaseFabricId: "st-todo",
		});
		// The push's story writes: the content baseline only. The same probe
		// sees ["update", "updateMany"] on the stamping push in AC11.
		expect(userStoryWritesSince(0).map((c) => c.method)).toEqual([
			"update",
		]);

		await runPoll();

		expect(outcomeCounts().moved).toBe(1);
		expect(storedStory("story-7").statusId).toBe("st-done");
		expect(
			tableRows("pmSyncLog").filter(
				(r) => r.direction === "pull" && r.status === "SUCCESS",
			),
		).toHaveLength(1);
	});
});
