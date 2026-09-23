/**
 * What the gather DERIVES, not what the rules do with it (Fizzy #1930).
 *
 * The registry tests hand every rule a ready-made evidence object, so they
 * prove the matrix reads its inputs correctly and prove nothing at all about
 * where those inputs come from. The split predicate in particular is asserted
 * there by a fixture that already says `usable: true, healthy: false` — which
 * is the one thing that has to be PRODUCED from real rows, and the one thing
 * that has regressed twice. These tests cover that seam.
 *
 * Everything is mocked at the package boundary: the database client, the
 * project-permission helper and the Atlas status accessor. That is deliberate
 * and it has a known limit, stated here so nobody mistakes a green run for more
 * coverage than it is — see `describe("the document predicate")` below. Any
 * predicate this module pushes into the WHERE clause is evaluated by Postgres,
 * not by the code under test, so a mocked read returns whatever the test says
 * regardless of the filter. Those are asserted on the QUERY the gather sends.
 * Everything derived in TypeScript is asserted on the value it returns.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	CapabilityEvidenceUnavailableError,
	gatherCapabilityEvidence,
} from "../evidence";

const {
	dbMock,
	canEditProjectMock,
	canEditProjectSettingsMock,
	getStatusMock,
	resolvePmTargetMock,
	resolvePMConfigForUserMock,
	countEligibleBatchesMock,
} = vi.hoisted(() => ({
	dbMock: {
		project: { findUnique: vi.fn() },
		userStory: { count: vi.fn() },
		projectCodeIndex: { findMany: vi.fn() },
		projectRepositoryIntegration: { findMany: vi.fn() },
		backgroundJob: { groupBy: vi.fn() },
		projectContext: { groupBy: vi.fn() },
		projectDocument: { groupBy: vi.fn(), findMany: vi.fn() },
		projectScan: { groupBy: vi.fn() },
	},
	canEditProjectMock: vi.fn(),
	canEditProjectSettingsMock: vi.fn(),
	getStatusMock: vi.fn(),
	resolvePmTargetMock: vi.fn(),
	resolvePMConfigForUserMock: vi.fn(),
	countEligibleBatchesMock: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: dbMock,
	canEditProject: (...args: unknown[]) => canEditProjectMock(...args),
	canEditProjectSettings: (...args: unknown[]) =>
		canEditProjectSettingsMock(...args),
	resolvePMConfigForUser: (...args: unknown[]) =>
		resolvePMConfigForUserMock(...args),
	countEligibleAiRecommendationBatches: (...args: unknown[]) =>
		countEligibleBatchesMock(...args),
	TERMINAL_DRAFTING_STAGES: ["DECLINED", "CLOSED"],
}));

// Replaced wholesale: the real helper reads MCP config and credential rows,
// which is the database seam this file already mocks at the package boundary.
vi.mock("../../projects/lib/resolve-pm-target", () => ({
	resolvePmTarget: (...args: unknown[]) => resolvePmTargetMock(...args),
}));

// Replaced wholesale rather than partially: the real package pulls in the AI
// SDK, git tooling and the connector layer, none of which a derivation test has
// any use for.
vi.mock("@repo/atlas", () => ({
	AtlasService: class {
		getStatus(...args: unknown[]) {
			return getStatusMock(...args);
		}
	},
}));

// ── Fixtures ─────────────────────────────────────────────────────────────────

const PROJECT_ID = "project_example";
const USER_ID = "user_example";
const ORGANIZATION_ID = "org_example";

const LAST_GOOD_INDEX = new Date("2026-09-10T08:00:00.000Z");

type CodeIndexRow = {
	status: string;
	lastFullIndexAt: Date | null;
	updatedAt?: Date;
	repositoryIntegrationId?: string | null;
};
type IntegrationRow = { id?: string; status: string; updatedAt: Date };
type JobGroup = {
	kind: string;
	status: string;
	_count: { _all: number };
	_max: {
		createdAt: Date | null;
		completedAt: Date | null;
		heartbeatAt: Date | null;
	};
};

/**
 * One background-job aggregate row. `completedAt` defaults to `createdAt`
 * because a terminal row in production always has one; the tests that care
 * about the difference pass them apart explicitly.
 */
function jobGroup(
	kind: string,
	status: string,
	createdAt: string,
	completedAt?: string,
): JobGroup {
	return {
		kind,
		status,
		_count: { _all: 1 },
		_max: {
			createdAt: new Date(createdAt),
			completedAt: new Date(completedAt ?? createdAt),
			heartbeatAt: new Date(completedAt ?? createdAt),
		},
	};
}

interface Rows {
	project: Record<string, unknown> | null;
	codeIndexes: CodeIndexRow[];
	integrations: IntegrationRow[];
	jobGroups: JobGroup[];
	contextGroups: unknown[];
	documentGroups: Array<{ type: string }>;
	documentsInFlight: Array<{ type: string }>;
	scanGroups: unknown[];
	canEdit: boolean;
	canEditSettings: boolean;
	atlas: { status: string } | Error;
	pmTarget: { kind: string } | null;
	pmItemConfig: { enabled: boolean } | null;
	roadmapItemCount: number;
	eligibleBatchCount: number;
}

/**
 * The healthy project: a repository connected and live, a full index that
 * completed and has not been disturbed since, and Atlas serving a ready graph.
 * Each test states only what it takes away.
 */
function healthyRows(): Rows {
	return {
		project: {
			userId: USER_ID,
			organizationId: ORGANIZATION_ID,
			description: "A project with a real description on it.",
			repositoryUrl: null,
			codeAnalysisStatus: null,
			scanConfig: null,
			ragSettings: { codeSearchEnabled: true },
			readOnlyMode: false,
			projectManagementMcpServerId: "mcp_server_example",
			projectManagementMcpConfigId: "mcp_config_example",
			projectManagementContainerId: "board_example",
			_count: {
				linkedSlackChannels: 1,
				linkedTeamsChannels: 0,
				linkedTeamsChats: 0,
			},
			contexts: [{ id: "context_example" }],
		},
		codeIndexes: [
			{
				status: "READY",
				lastFullIndexAt: LAST_GOOD_INDEX,
				updatedAt: LAST_GOOD_INDEX,
				repositoryIntegrationId: "integration_example",
			},
		],
		integrations: [
			{
				id: "integration_example",
				status: "ACTIVE",
				updatedAt: new Date("2026-09-10T08:00:00.000Z"),
			},
		],
		jobGroups: [],
		contextGroups: [],
		documentGroups: [],
		documentsInFlight: [],
		scanGroups: [],
		canEdit: true,
		canEditSettings: true,
		atlas: { status: "READY" },
		pmTarget: { kind: "mcp" },
		pmItemConfig: { enabled: true },
		roadmapItemCount: 0,
		eligibleBatchCount: 0,
	};
}

function gather(overrides: Partial<Rows> = {}, includeAtlasStatus?: boolean) {
	const rows: Rows = { ...healthyRows(), ...overrides };
	dbMock.project.findUnique.mockResolvedValue(rows.project);
	dbMock.projectCodeIndex.findMany.mockResolvedValue(rows.codeIndexes);
	dbMock.projectRepositoryIntegration.findMany.mockResolvedValue(
		rows.integrations,
	);
	dbMock.backgroundJob.groupBy.mockResolvedValue(rows.jobGroups);
	dbMock.projectContext.groupBy.mockResolvedValue(rows.contextGroups);
	dbMock.projectDocument.groupBy.mockResolvedValue(rows.documentGroups);
	dbMock.projectDocument.findMany.mockResolvedValue(rows.documentsInFlight);
	dbMock.projectScan.groupBy.mockResolvedValue(rows.scanGroups);
	canEditProjectMock.mockResolvedValue(rows.canEdit);
	canEditProjectSettingsMock.mockResolvedValue(rows.canEditSettings);
	resolvePmTargetMock.mockResolvedValue(rows.pmTarget);
	resolvePMConfigForUserMock.mockResolvedValue(rows.pmItemConfig);
	dbMock.userStory.count.mockResolvedValue(rows.roadmapItemCount);
	countEligibleBatchesMock.mockResolvedValue(rows.eligibleBatchCount);
	getStatusMock.mockImplementation(() =>
		rows.atlas instanceof Error
			? Promise.reject(rows.atlas)
			: Promise.resolve(rows.atlas),
	);

	return gatherCapabilityEvidence({
		projectId: PROJECT_ID,
		userId: USER_ID,
		organizationId: ORGANIZATION_ID,
		...(includeAtlasStatus === undefined ? {} : { includeAtlasStatus }),
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv("FEATURE_CODE_INDEXING", "true");
});

// ── The predicate this whole file exists for ─────────────────────────────────

describe("the codebase split predicate: a failed re-index must never take away a working snapshot", () => {
	it("gathers usable:true healthy:false when the index row itself failed after a full index completed", async () => {
		// The production shape exactly: one row that keeps `lastFullIndexAt`
		// from its last good run and carries FAILED from the re-index that
		// died. Collapsing these two into one boolean hard-blocks this project
		// at the moment its graph is still being served.
		const evidence = await gather({
			codeIndexes: [
				{ status: "FAILED", lastFullIndexAt: LAST_GOOD_INDEX },
			],
		});

		expect(evidence.codebase.usable).toBe(true);
		expect(evidence.codebase.healthy).toBe(false);
		expect(evidence.codebase.indexing.lastRunFailed).toBe(true);
	});

	it("gathers usable:true healthy:false when the latest indexing JOB failed over a good snapshot", async () => {
		// The same verdict reached by the other independent path. The index row
		// is untouched and READY; only the job record knows the refresh died.
		const evidence = await gather({
			jobGroups: [
				jobGroup(
					"CODE_INDEXING",
					"COMPLETED",
					"2026-09-10T08:00:00.000Z",
				),
				jobGroup("CODE_INDEXING", "FAILED", "2026-09-17T09:00:00.000Z"),
			],
		});

		expect(evidence.codebase.usable).toBe(true);
		expect(evidence.codebase.healthy).toBe(false);
	});

	it("gathers usable:false when no full index ever completed and the run failed", async () => {
		const evidence = await gather({
			codeIndexes: [{ status: "FAILED", lastFullIndexAt: null }],
		});

		expect(evidence.codebase.usable).toBe(false);
		expect(evidence.codebase.healthy).toBe(false);
		expect(evidence.codebase.indexing.lastRunFailed).toBe(true);
	});

	it("gathers both true for a connected, indexed, live project", async () => {
		const evidence = await gather();

		expect(evidence.codebase.usable).toBe(true);
		expect(evidence.codebase.healthy).toBe(true);
		expect(evidence.codebase.indexing.lastRunFailed).toBe(false);
	});

	it("keeps usable:true while a refresh is in flight, because status is not the durable fact", async () => {
		// INDEXING is what every refresh writes. Keying usability on status
		// would take the snapshot away on every re-index.
		const evidence = await gather({
			codeIndexes: [
				{ status: "INDEXING", lastFullIndexAt: LAST_GOOD_INDEX },
			],
		});

		expect(evidence.codebase.usable).toBe(true);
		expect(evidence.codebase.indexing.running).toBe(true);
	});
});

describe("terminal job outcomes are ordered by when they FINISHED, not when the row appeared", () => {
	it("reports the failure when a long run fails after a short later run succeeded", async () => {
		// Overlapping runs, which context ingestion and re-indexing both do.
		// Ordering by creation time ranks the 10:05 success last and hides the
		// failure that actually finished most recently.
		const evidence = await gather({
			jobGroups: [
				jobGroup(
					"CODE_INDEXING",
					"FAILED",
					"2026-09-17T10:00:00.000Z",
					"2026-09-17T10:30:00.000Z",
				),
				jobGroup(
					"CODE_INDEXING",
					"COMPLETED",
					"2026-09-17T10:05:00.000Z",
					"2026-09-17T10:06:00.000Z",
				),
			],
		});

		expect(evidence.codebase.indexing.lastRunFailed).toBe(true);
		expect(evidence.codebase.healthy).toBe(false);
	});

	it("reports healthy when the most recently finished run succeeded", async () => {
		const evidence = await gather({
			jobGroups: [
				jobGroup(
					"CODE_INDEXING",
					"FAILED",
					"2026-09-17T10:00:00.000Z",
					"2026-09-17T10:05:00.000Z",
				),
				jobGroup(
					"CODE_INDEXING",
					"COMPLETED",
					"2026-09-17T10:01:00.000Z",
					"2026-09-17T10:30:00.000Z",
				),
			],
		});

		expect(evidence.codebase.indexing.lastRunFailed).toBe(false);
		expect(evidence.codebase.healthy).toBe(true);
	});
});

// ── connected vs. integrationStatus ──────────────────────────────────────────

describe("connected is not filtered to ACTIVE, so null keeps meaning 'no repository at all'", () => {
	it("reports a TOKEN_EXPIRED repository as connected, carrying its real status", async () => {
		const evidence = await gather({
			integrations: [
				{
					status: "TOKEN_EXPIRED",
					updatedAt: new Date("2026-09-17T09:00:00.000Z"),
				},
			],
		});

		expect(evidence.codebase.connected).toBe(true);
		expect(evidence.codebase.integrationStatus).toBe("TOKEN_EXPIRED");
		// A lapsed credential is not a working codebase, but the snapshot on
		// disk survives it — so this is a reconnect prompt, not a lost index.
		expect(evidence.codebase.healthy).toBe(false);
		expect(evidence.codebase.usable).toBe(true);
	});

	it("reports a project with no repository at all as disconnected with a null status", async () => {
		const evidence = await gather({ integrations: [] });

		expect(evidence.codebase.connected).toBe(false);
		expect(evidence.codebase.integrationStatus).toBeNull();
	});

	it("takes integrationStatus from the integration row, never from the Atlas accessor", async () => {
		// The accessor substitutes a synthetic repository status when it cannot
		// resolve one. Reading it would report DISCONNECTED for a repository
		// that is attached and merely lapsed.
		const evidence = await gather({
			integrations: [
				{
					status: "REPO_UNAVAILABLE",
					updatedAt: new Date("2026-09-17T09:00:00.000Z"),
				},
			],
			atlas: { status: "READY" },
		});

		expect(evidence.codebase.integrationStatus).toBe("REPO_UNAVAILABLE");
	});
});

// ── The legacy path ──────────────────────────────────────────────────────────

describe("projects that predate repository integrations", () => {
	it("counts a legacy completed analysis as usable when no index row exists", async () => {
		const evidence = await gather({
			codeIndexes: [],
			project: {
				...healthyRows().project,
				codeAnalysisStatus: "COMPLETED",
			},
		});

		expect(evidence.codebase.usable).toBe(true);
	});

	it("counts a legacy repository URL as connected, with no status to report", async () => {
		const evidence = await gather({
			integrations: [],
			project: {
				...healthyRows().project,
				repositoryUrl:
					"https://git.example.com/example-org/example-repo",
			},
		});

		expect(evidence.codebase.connected).toBe(true);
		// Connected but statusless: there is no integration row whose status
		// could be reported, which is why the rules read the two together.
		expect(evidence.codebase.integrationStatus).toBeNull();
	});

	it("does not invent usability from a legacy analysis that never completed", async () => {
		const evidence = await gather({
			codeIndexes: [],
			project: {
				...healthyRows().project,
				codeAnalysisStatus: "FAILED",
			},
		});

		expect(evidence.codebase.usable).toBe(false);
	});
});

// ── requiresCodebase ─────────────────────────────────────────────────────────

describe("scan.requiresCodebase asks the configuration, not any run", () => {
	it("is false when the project has no scan config row at all", async () => {
		const evidence = await gather();

		expect(evidence.scan.requiresCodebase).toBe(false);
	});

	it("is false when both repository-reading engines are off", async () => {
		const evidence = await gather({
			project: {
				...healthyRows().project,
				scanConfig: { semgrepEnabled: false, gitHistoryEnabled: false },
			},
		});

		expect(evidence.scan.requiresCodebase).toBe(false);
	});

	it("is true when the SAST engine is on", async () => {
		const evidence = await gather({
			project: {
				...healthyRows().project,
				scanConfig: { semgrepEnabled: true, gitHistoryEnabled: false },
			},
		});

		expect(evidence.scan.requiresCodebase).toBe(true);
	});

	it("is true when the git-history secret scan is on", async () => {
		const evidence = await gather({
			project: {
				...healthyRows().project,
				scanConfig: { semgrepEnabled: false, gitHistoryEnabled: true },
			},
		});

		expect(evidence.scan.requiresCodebase).toBe(true);
	});
});

// ── The context predicate ────────────────────────────────────────────────────

describe("the context predicate", () => {
	// Asserted on the query for the reason the document predicate below gives.
	it("leaves out the text behind a document created as-is", async () => {
		await gather();

		const where = dbMock.projectContext.groupBy.mock.calls[0]?.[0]?.where;

		// That row is never embedded and stays PENDING for good, so counting it
		// read as a source in flight on a project with no sources at all.
		expect(where.importedDocuments).toEqual({ none: {} });
	});
});

// ── The document predicate ───────────────────────────────────────────────────

describe("the document predicate", () => {
	/**
	 * Asserted on the QUERY, not on the result, and the difference is worth
	 * being explicit about: this rule lives in the WHERE clause, so Postgres
	 * evaluates it and a mocked read returns whatever the test hands back no
	 * matter what the filter says. Feeding rows in and checking which came out
	 * would test the mock. What CAN be pinned here is the predicate the gather
	 * sends, which is what would have to change for the rule to break.
	 *
	 * A database-backed test is the only way to close this properly, and this
	 * module has no such harness today.
	 */
	it("counts a document only when it holds content, whatever status it carries", async () => {
		await gather();

		const where = dbMock.projectDocument.groupBy.mock.calls[0]?.[0]?.where;
		expect(where.isActive).toBe(true);

		// One content test over every status, not a content test on one arm and
		// a status test on the other. An empty row grounds nothing, so a FINISHED
		// document with no body does not count either — the same rule that lets a
		// failed re-run keep counting, read from the other end.
		expect(where.content).toEqual({ not: "" });
		expect(where.status.in).toEqual(
			expect.arrayContaining([
				"COMPLETE",
				"REVIEW",
				"QUEUED",
				"GENERATING",
				"FAILED",
			]),
		);

		// A document being written INTO has not come out of a run.
		expect(where.status.in).not.toContain("DRAFT");
		expect(where.status.in).not.toContain("IN_PROGRESS");

		// The collapse is itself the assertion: the two arms were never two rules.
		expect(where.OR).toBeUndefined();
	});

	it("reports a document generation in flight from the row, not only from a job", async () => {
		// A generation started before job records existed has no job row to
		// report it, but the document itself is plainly QUEUED or GENERATING.
		const evidence = await gather({
			documentsInFlight: [{ type: "PRD" }],
		});

		expect(evidence.documents.generating.running).toBe(true);
	});

	it("surfaces the usable types the grouped read returned", async () => {
		const evidence = await gather({
			documentGroups: [{ type: "PRD" }, { type: "ARCHITECTURE" }],
		});

		expect([...evidence.documents.usableTypes].sort()).toEqual([
			"ARCHITECTURE",
			"PRD",
		]);
	});
});

// ── Atlas ────────────────────────────────────────────────────────────────────

describe("the Atlas accessor is off unless the caller asks for it", () => {
	it("does not touch Atlas at all on a default gather", async () => {
		// The reason the flag exists. This path runs on every project page load
		// and before every gated action; the accessor reaches a third-party API
		// on the ordinary healthy path and writes an audit row for a run stuck
		// over five hours. Neither may happen just because someone opened a page.
		await gather();

		expect(getStatusMock).not.toHaveBeenCalled();
	});

	it("leaves healthy derivable from rows alone when the verdict is not asked for", async () => {
		// A FAILED analysis is invisible to a default gather by design. The
		// index is fine, so the codebase reads healthy and the Atlas surface
		// reports its own failure.
		const evidence = await gather({ atlas: { status: "FAILED" } });

		expect(getStatusMock).not.toHaveBeenCalled();
		expect(evidence.codebase.healthy).toBe(true);
		expect(evidence.codebase.usable).toBe(true);
	});

	it("marks the codebase unhealthy \u2014 but still usable \u2014 when asked and the analysis failed", async () => {
		const evidence = await gather({ atlas: { status: "FAILED" } }, true);

		expect(getStatusMock).toHaveBeenCalledTimes(1);
		expect(evidence.codebase.healthy).toBe(false);
		expect(evidence.codebase.usable).toBe(true);
	});

	it("resolves the repository inside the accessor rather than passing one in", async () => {
		await gather({}, true);

		expect(getStatusMock).toHaveBeenCalledWith({
			projectId: PROJECT_ID,
			repositoryIntegrationId: null,
		});
	});

	it("falls back to the row-derived answer when the accessor throws", async () => {
		// The accessor makes a network call, so it can fail for reasons that
		// say nothing about this project. A gather that threw here would take
		// the whole page down over someone else's outage.
		const evidence = await gather(
			{ atlas: new Error("provider unreachable") },
			true,
		);

		expect(evidence.codebase.healthy).toBe(true);
		expect(evidence.codebase.usable).toBe(true);
	});
});

// ── The tenant guard ─────────────────────────────────────────────────────────

describe("the tenant guard fails closed", () => {
	it("throws rather than returning an empty bundle when the project does not exist", async () => {
		await expect(gather({ project: null })).rejects.toBeInstanceOf(
			CapabilityEvidenceUnavailableError,
		);
	});

	it("throws when the caller's organization disagrees with the project's own", async () => {
		// The caller's claim is checked, never believed. An empty bundle here
		// would resolve every capability against a project the caller cannot
		// see, and the strictest-first composite would render it as a page of
		// blocks — plausible output for a question that was never answered.
		await expect(
			gather({
				project: {
					...healthyRows().project,
					organizationId: "org_someone_else",
				},
			}),
		).rejects.toBeInstanceOf(CapabilityEvidenceUnavailableError);
	});

	it("scopes every child read to the project it was asked about", async () => {
		await gather();

		for (const call of [
			dbMock.projectCodeIndex.findMany,
			dbMock.projectRepositoryIntegration.findMany,
			dbMock.backgroundJob.groupBy,
			dbMock.projectContext.groupBy,
			dbMock.projectDocument.groupBy,
			dbMock.projectDocument.findMany,
			dbMock.projectScan.groupBy,
		]) {
			expect(call.mock.calls[0]?.[0]?.where?.projectId).toBe(PROJECT_ID);
		}
	});
});

// ── Fizzy #1930 review round: facts the rules gained ─────────────────────────

describe("whether anything will ever index the repository", () => {
	it("is off when the project never switched code search on", async () => {
		// The schema default. Connecting a repository indexes nothing then, and
		// a gate that waited for an index would wait for good.
		const evidence = await gather({
			project: { ...healthyRows().project, ragSettings: null },
		});
		expect(evidence.codebase.indexingEnabled).toBe(false);
	});

	it("is off when the deployment has code indexing switched off", async () => {
		vi.stubEnv("FEATURE_CODE_INDEXING", "false");
		const evidence = await gather();
		expect(evidence.codebase.indexingEnabled).toBe(false);
		// And says which half is off, so the gate does not point at the
		// project's own setting when the deployment is the reason.
		expect(evidence.codebase.indexingAvailable).toBe(false);
	});

	it("is on only when both switches are", async () => {
		const evidence = await gather();
		expect(evidence.codebase.indexingEnabled).toBe(true);
	});
});

describe("an index left in flight by a worker that died", () => {
	const STUCK_SINCE = new Date("2026-09-18T08:00:00.000Z");

	it("measures the run from the index row's last write when no job is running", async () => {
		// Before: running with a null clock, which is never stalled — so the
		// gate said "Indexing your repository" for good.
		const evidence = await gather({
			codeIndexes: [
				{
					status: "INDEXING",
					lastFullIndexAt: null,
					updatedAt: STUCK_SINCE,
					repositoryIntegrationId: "integration_example",
				},
			],
		});
		expect(evidence.codebase.indexing.running).toBe(true);
		expect(evidence.codebase.indexing.lastProgressAt).toEqual(STUCK_SINCE);
	});

	it("reports the run as over and failed once its job was closed as FAILED", async () => {
		const evidence = await gather({
			codeIndexes: [
				{
					status: "INDEXING",
					lastFullIndexAt: null,
					updatedAt: STUCK_SINCE,
					repositoryIntegrationId: "integration_example",
				},
			],
			jobGroups: [
				jobGroup("CODE_INDEXING", "FAILED", "2026-09-18T08:45:00.000Z"),
			],
		});
		expect(evidence.codebase.indexing.running).toBe(false);
		expect(evidence.codebase.indexing.lastRunFailed).toBe(true);
	});

	it("keeps the job's own heartbeat when a job is running", async () => {
		const heartbeat = "2026-09-18T11:59:00.000Z";
		const evidence = await gather({
			codeIndexes: [
				{
					status: "INDEXING",
					lastFullIndexAt: null,
					updatedAt: STUCK_SINCE,
					repositoryIntegrationId: "integration_example",
				},
			],
			jobGroups: [jobGroup("CODE_INDEXING", "RUNNING", heartbeat)],
		});
		expect(evidence.codebase.indexing.lastProgressAt).toEqual(
			new Date(heartbeat),
		);
	});
});

describe("a context source extracting with no job row", () => {
	it("is measured from the source's own last write", async () => {
		const since = new Date("2026-09-18T08:00:00.000Z");
		const evidence = await gather({
			contextGroups: [
				{
					type: "LINK",
					extractionStatus: "EXTRACTING",
					knowledgeBaseSourceCategory: null,
					_count: { _all: 1 },
					_max: { updatedAt: since },
				},
			],
		});
		expect(evidence.context.processing.running).toBe(true);
		expect(evidence.context.processing.lastProgressAt).toEqual(since);
	});
});

describe("a scan that never started", () => {
	it("is measured from when it was queued", async () => {
		const queued = new Date("2026-09-18T08:00:00.000Z");
		const evidence = await gather({
			scanGroups: [
				{
					status: "PENDING",
					_count: { _all: 1 },
					_max: {
						createdAt: queued,
						completedAt: null,
						startedAt: null,
					},
				},
			],
		});
		expect(evidence.scan.running).toBe(true);
		expect(evidence.scan.lastProgressAt).toEqual(queued);
	});
});

describe("what a codebase retry targets", () => {
	it("names the repository whose index failed, not every repository", async () => {
		const evidence = await gather({
			codeIndexes: [
				{
					status: "READY",
					lastFullIndexAt: LAST_GOOD_INDEX,
					repositoryIntegrationId: "integration_fine",
				},
				{
					status: "FAILED",
					lastFullIndexAt: null,
					repositoryIntegrationId: "integration_broken",
				},
			],
		});
		expect(evidence.codebase.retryTargetId).toBe("integration_broken");
	});

	it("falls back to the reported integration when nothing has run", async () => {
		const evidence = await gather({ codeIndexes: [] });
		expect(evidence.codebase.retryTargetId).toBe("integration_example");
	});
});

describe("the two retry permissions are read separately", () => {
	it("carries settings-edit and project-update as they are", async () => {
		const evidence = await gather({
			canEdit: true,
			canEditSettings: false,
		});
		expect(evidence.viewer).toEqual({
			canEditProjectSettings: false,
			canUpdateProject: true,
		});
	});
});

describe("Atlas's graph", () => {
	it("is ready only when Atlas was asked and said READY", async () => {
		expect((await gather({}, true)).codebase.graphReady).toBe(true);
		expect((await gather({}, false)).codebase.graphReady).toBe(false);
	});
});

describe("the tenant refusal is structured", () => {
	it("is a NOT_FOUND, not a plain error that surfaces as a 500", async () => {
		await expect(gather({ project: null })).rejects.toMatchObject({
			code: "NOT_FOUND",
			status: 404,
		});
	});
});

describe("sources on their way, and uploads", () => {
	it("reports which document types are generating right now", async () => {
		const evidence = await gather({
			documentsInFlight: [{ type: "PRD" }, { type: "ARCHITECTURE" }],
		});
		expect([...evidence.documents.inFlightTypes].sort()).toEqual([
			"ARCHITECTURE",
			"PRD",
		]);
	});

	it("classifies a source still being ingested the same way as a finished one", async () => {
		const evidence = await gather({
			contextGroups: [
				{
					type: "LINK",
					extractionStatus: "EXTRACTING",
					knowledgeBaseSourceCategory: "API_DOCUMENTATION",
					_count: { _all: 2 },
					_max: { updatedAt: new Date() },
				},
				{
					type: "TEXT",
					extractionStatus: "PENDING",
					knowledgeBaseSourceCategory: null,
					_count: { _all: 1 },
					_max: { updatedAt: new Date() },
				},
			],
		});
		expect(evidence.context.technicalInFlight).toBe(2);
		expect(evidence.context.productInFlight).toBe(1);
		expect(evidence.context.technical).toBe(0);
	});

	it("counts an untagged uploaded file or document as product grounding, never technical", async () => {
		const evidence = await gather({
			contextGroups: ["FILE", "DOCUMENT"].map((type) => ({
				type,
				extractionStatus: "COMPLETED",
				knowledgeBaseSourceCategory: null,
				_count: { _all: 1 },
				_max: { updatedAt: null },
			})),
		});
		expect(evidence.context.product).toBe(2);
		expect(evidence.context.technical).toBe(0);
	});
});

// ── Roadmap and PM facts (Fizzy #2204 / #2208 / #2211) ──

describe("the PM connection the Roadmap doors reach", () => {
	it("reports a running PM story sync from the grouped job read", async () => {
		const heartbeat = "2026-09-18T11:55:00.000Z";
		const evidence = await gather({
			jobGroups: [jobGroup("PM_STORY_SYNC", "RUNNING", heartbeat)],
		});

		expect(evidence.pm.syncing.running).toBe(true);
		expect(evidence.pm.syncing.lastProgressAt).toEqual(new Date(heartbeat));
		expect(dbMock.backgroundJob.groupBy).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					kind: { in: expect.arrayContaining(["PM_STORY_SYNC"]) },
				}),
			}),
		);
	});

	it("never reads PM_STATE_POLL as a PM sync", async () => {
		// The hourly status poll runs unattended; a pull someone is waiting on
		// must not read as busy because of it.
		const evidence = await gather({
			jobGroups: [
				jobGroup(
					"PM_STATE_POLL",
					"RUNNING",
					"2026-09-18T11:55:00.000Z",
				),
			],
		});

		expect(evidence.pm.syncing.running).toBe(false);
		const [args] = dbMock.backgroundJob.groupBy.mock.calls[0] as [
			{ where: { kind: { in: string[] } } },
		];
		expect(args.where.kind.in).not.toContain("PM_STATE_POLL");
	});

	it("skips PM resolution when the project names no PM tool", async () => {
		const evidence = await gather({
			project: {
				...healthyRows().project,
				projectManagementMcpServerId: null,
				projectManagementMcpConfigId: null,
			},
		});

		expect(resolvePmTargetMock).not.toHaveBeenCalled();
		expect(resolvePMConfigForUserMock).not.toHaveBeenCalled();
		expect(evidence.pm).toMatchObject({
			toolSelected: false,
			bulkTargetResolvable: false,
			itemConfigResolvable: false,
		});
	});

	it("reports the item path separately from the bulk target", async () => {
		// A legacy project naming only a server: no bulk target, yet the
		// single-item doors resolve the viewer's own config and work.
		const evidence = await gather({
			project: {
				...healthyRows().project,
				projectManagementMcpConfigId: null,
			},
			pmTarget: null,
			pmItemConfig: { enabled: true },
		});

		expect(evidence.pm.bulkTargetResolvable).toBe(false);
		expect(evidence.pm.itemConfigResolvable).toBe(true);
		expect(resolvePMConfigForUserMock).toHaveBeenCalledWith({
			configId: null,
			mcpServerId: "mcp_server_example",
			userId: USER_ID,
			organizationId: ORGANIZATION_ID,
		});
	});

	it("derives the item path from the bulk target when the project pins a config, reading it once", async () => {
		const resolved = await gather();
		expect(resolved.pm).toMatchObject({
			bulkTargetResolvable: true,
			itemConfigResolvable: true,
		});
		expect(resolvePmTargetMock).toHaveBeenCalledTimes(1);
		expect(resolvePMConfigForUserMock).not.toHaveBeenCalled();

		vi.clearAllMocks();
		const unresolved = await gather({ pmTarget: null });
		expect(unresolved.pm).toMatchObject({
			bulkTargetResolvable: false,
			itemConfigResolvable: false,
		});
		expect(resolvePMConfigForUserMock).not.toHaveBeenCalled();
	});

	it("reads the board, read-only mode and a disabled item config from the rows", async () => {
		const evidence = await gather({
			project: {
				...healthyRows().project,
				projectManagementContainerId: null,
				readOnlyMode: true,
			},
			// A pinned config that no longer resolves enabled: no bulk target.
			pmTarget: null,
			pmItemConfig: { enabled: false },
		});

		expect(evidence.pm.boardSelected).toBe(false);
		expect(evidence.pm.readOnly).toBe(true);
		expect(evidence.pm.itemConfigResolvable).toBe(false);
	});
});

describe("the Roadmap facts", () => {
	it("counts only live Roadmap items", async () => {
		const evidence = await gather({ roadmapItemCount: 7 });

		expect(evidence.roadmap.itemCount).toBe(7);
		expect(dbMock.userStory.count).toHaveBeenCalledWith({
			where: {
				projectId: PROJECT_ID,
				draftingStage: { notIn: ["DECLINED", "CLOSED"] },
				pmAutoHidden: false,
			},
		});
	});

	it("returns the eligible AI-recommended batch count for this project", async () => {
		const evidence = await gather({ eligibleBatchCount: 3 });

		expect(evidence.aiRecommended.eligibleBatchCount).toBe(3);
		expect(countEligibleBatchesMock).toHaveBeenCalledWith(PROJECT_ID);
	});
});

describe("Work Capture's linked conversations", () => {
	it("sums Slack channels, Teams channels and Teams chats", async () => {
		const evidence = await gather({
			project: {
				...healthyRows().project,
				_count: {
					linkedSlackChannels: 2,
					linkedTeamsChannels: 1,
					linkedTeamsChats: 3,
				},
			},
		});
		expect(evidence.chat.linkedChannelCount).toBe(6);
	});

	it("asks for all three counts on the project read, not in extra round trips", async () => {
		await gather();
		const [args] = dbMock.project.findUnique.mock.calls[0];
		expect(args.select._count).toEqual({
			select: {
				linkedSlackChannels: true,
				linkedTeamsChannels: true,
				linkedTeamsChats: true,
			},
		});
	});
});

describe("what the living-document refresh can read", () => {
	it("is readable when the probe finds a row, and not when it finds none", async () => {
		expect((await gather()).refreshSources.readable).toBe(true);
		const empty = await gather({
			project: { ...healthyRows().project, contexts: [] },
		});
		expect(empty.refreshSources.readable).toBe(false);
	});

	// The filter runs in Postgres, so it is asserted on the query sent.
	it("probes for one row across exactly the refresh's two inputs", async () => {
		await gather();
		const [args] = dbMock.project.findUnique.mock.calls[0];
		const probe = args.select.contexts;

		expect(probe.take).toBe(1);
		expect(probe.select).toEqual({ id: true });
		expect(probe.where.OR).toEqual([
			{
				// Retrieval skips integration pointers by kind, and the
				// indexer's vectors never resolve to a row — an indexed
				// repository is not a refresh input.
				type: {
					notIn: ["INTEGRATION", "CODE_FILE", "CODE_FILE_SUMMARY"],
				},
				OR: [
					{ embeddedAt: { not: null } },
					{ extractionStatus: "COMPLETED" },
				],
			},
			// Linked conversations are fetched live, at any status.
			{
				type: "INTEGRATION",
				metadata: { path: ["provider"], equals: "SLACK" },
			},
			{
				type: "INTEGRATION",
				metadata: { path: ["provider"], equals: "MICROSOFT_TEAMS" },
			},
		]);
	});
});
