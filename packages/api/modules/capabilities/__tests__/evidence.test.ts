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

const { dbMock, canEditProjectMock, getStatusMock } = vi.hoisted(() => ({
	dbMock: {
		project: { findUnique: vi.fn() },
		projectCodeIndex: { findMany: vi.fn() },
		projectRepositoryIntegration: { findMany: vi.fn() },
		backgroundJob: { groupBy: vi.fn() },
		projectContext: { groupBy: vi.fn() },
		projectDocument: { groupBy: vi.fn(), count: vi.fn() },
		projectScan: { groupBy: vi.fn() },
	},
	canEditProjectMock: vi.fn(),
	getStatusMock: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: dbMock,
	canEditProject: (...args: unknown[]) => canEditProjectMock(...args),
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

type CodeIndexRow = { status: string; lastFullIndexAt: Date | null };
type IntegrationRow = { status: string; updatedAt: Date };
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
	documentsInFlight: number;
	scanGroups: unknown[];
	canEdit: boolean;
	atlas: { status: string } | Error;
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
		},
		codeIndexes: [{ status: "READY", lastFullIndexAt: LAST_GOOD_INDEX }],
		integrations: [
			{
				status: "ACTIVE",
				updatedAt: new Date("2026-09-10T08:00:00.000Z"),
			},
		],
		jobGroups: [],
		contextGroups: [],
		documentGroups: [],
		documentsInFlight: 0,
		scanGroups: [],
		canEdit: true,
		atlas: { status: "READY" },
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
	dbMock.projectDocument.count.mockResolvedValue(rows.documentsInFlight);
	dbMock.projectScan.groupBy.mockResolvedValue(rows.scanGroups);
	canEditProjectMock.mockResolvedValue(rows.canEdit);
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
		const evidence = await gather({ documentsInFlight: 1 });

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
			dbMock.projectDocument.count,
			dbMock.projectScan.groupBy,
		]) {
			expect(call.mock.calls[0]?.[0]?.where?.projectId).toBe(PROJECT_ID);
		}
	});
});
