/**
 * An Atlas analysis run paused for a ChatGPT plan reset (Fizzy #2770). The
 * run row (`AtlasAnalysisRun`) carries the pause through the shared bulk-run
 * helpers; the analysis row mirrors it for the page, the in-flight guard and
 * the stale-run sweep. A served READY snapshot keeps serving throughout, a
 * mirror write that lost a race to a Cancel changes nothing, and the watchdog
 * fails an analysis left waiting once nothing can resume it. Run against
 * in-memory tables that apply the same `where`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown> & { id: string };

const tables = vi.hoisted(() => ({
	analyses: new Map<string, Row>(),
	runs: new Map<string, Row>(),
}));

function matches(row: Row, where: Record<string, unknown>): boolean {
	return Object.entries(where).every(([key, condition]) => {
		if (key === "OR") {
			return (condition as Record<string, unknown>[]).some((branch) =>
				matches(row, branch),
			);
		}
		if (key === "runs") {
			const { none } = condition as { none: Record<string, unknown> };
			return ![...tables.runs.values()].some(
				(run) => run.analysisId === row.id && matches(run, none),
			);
		}
		const value = row[key];
		if (
			condition &&
			typeof condition === "object" &&
			!(condition instanceof Date)
		) {
			const c = condition as {
				in?: unknown[];
				notIn?: unknown[];
				not?: unknown;
			};
			if (c.in) {
				return c.in.includes(value);
			}
			if (c.notIn) {
				return !c.notIn.includes(value);
			}
			if ("not" in c) {
				return (value ?? null) !== c.not;
			}
		}
		return (value ?? null) === condition;
	});
}

function delegate(rows: Map<string, Row>) {
	return {
		findUnique: async ({ where }: { where: { id: string } }) => {
			const row = rows.get(where.id);
			return row ? { ...row } : null;
		},
		findFirst: async ({ where }: { where: Record<string, unknown> }) => {
			const row = [...rows.values()].find((r) => matches(r, where));
			return row ? { ...row } : null;
		},
		findMany: async ({ where }: { where: Record<string, unknown> }) =>
			[...rows.values()].filter((r) => matches(r, where)),
		updateMany: async ({
			where,
			data,
		}: {
			where: Record<string, unknown>;
			data: Record<string, unknown>;
		}) => {
			let count = 0;
			for (const row of rows.values()) {
				if (matches(row, where)) {
					Object.assign(row, data);
					count++;
				}
			}
			return { count };
		},
	};
}

vi.mock("../prisma/client", () => ({
	db: {
		atlasAnalysis: delegate(tables.analyses),
		atlasAnalysisRun: delegate(tables.runs),
		// Sequential is enough here: no write in these tests interleaves.
		$transaction: async (writes: Promise<unknown>[]) => {
			const results: unknown[] = [];
			for (const write of writes) {
				results.push(await write);
			}
			return results;
		},
	},
}));

import {
	failAtlasAnalysesLeftWaiting,
	getPausedAtlasRun,
	markAtlasAnalysisResumeApproved,
	markAtlasAnalysisResumed,
	markAtlasAnalysisWaitingForPlan,
} from "../prisma/queries/atlas-plan-pause";
import {
	BULK_RUN_RESUME_NEVER_STARTED_MESSAGE,
	claimBulkRunResume,
	recordBulkRunPause,
} from "../prisma/queries/bulk-run-pause";

const NOW = new Date("2026-10-12T12:00:00.000Z");

function analysis(overrides: Partial<Row> = {}): Row {
	return {
		id: "analysis-1",
		status: "ANALYZING",
		activeRunStatus: "ANALYZING",
		activeRunStartedAt: new Date("2026-10-12T10:00:00.000Z"),
		analyzedCommitSha: null,
		workflowId: "atlas-analysis-1",
		error: null,
		...overrides,
	};
}

function run(overrides: Partial<Row> = {}): Row {
	return {
		id: "run-1",
		analysisId: "analysis-1",
		projectId: "project-1",
		organizationId: "org-1",
		userId: "user-1",
		status: "RUNNING",
		pauseCount: 0,
		firstPausedAt: null,
		resumesAt: null,
		startedAt: new Date("2026-10-12T10:00:00.000Z"),
		...overrides,
	};
}

beforeEach(() => {
	tables.analyses.clear();
	tables.runs.clear();
});

describe("the Atlas run row through the shared pause helpers", () => {
	it("pauses and is claimed back by its resume", async () => {
		tables.runs.set("run-1", run());

		const paused = await recordBulkRunPause({
			kind: "ATLAS_ANALYSIS",
			runId: "run-1",
			expectedPauseCount: 0,
			resumesAt: new Date("2026-10-12T15:00:00.000Z"),
			resumeState: {
				workflowType: "atlasWorkflow",
				taskQueue: "atlas",
				workflowIdBase: "atlas-analysis-1",
				input: { analysisId: "analysis-1" },
				progress: { structure: { commitSha: "abc123" } },
			},
			resumeWorkflowId: "atlas-analysis-1-resume-1",
			now: NOW,
		});
		expect(paused).toMatchObject({ status: "paused", pauseCount: 1 });
		expect(tables.runs.get("run-1")).toMatchObject({
			status: "WAITING_FOR_PLAN",
			workflowId: "atlas-analysis-1-resume-1",
		});

		const state = await claimBulkRunResume({
			kind: "ATLAS_ANALYSIS",
			runId: "run-1",
			pauseCount: 1,
			viaApiOverride: false,
			now: NOW,
		});
		expect(state?.progress).toEqual({ structure: { commitSha: "abc123" } });
		expect(tables.runs.get("run-1")).toMatchObject({
			status: "RUNNING",
			resumesAt: null,
		});
	});
});

describe("the analysis row mirrors its paused run", () => {
	it("a first analysis reads WAITING_FOR_PLAN while it waits", async () => {
		tables.analyses.set("analysis-1", analysis());

		expect(await markAtlasAnalysisWaitingForPlan("analysis-1")).toBe(true);

		expect(tables.analyses.get("analysis-1")).toMatchObject({
			status: "WAITING_FOR_PLAN",
			activeRunStatus: "WAITING_FOR_PLAN",
		});
	});

	it("a re-run keeps its READY snapshot serving", async () => {
		tables.analyses.set(
			"analysis-1",
			analysis({ status: "READY", analyzedCommitSha: "old" }),
		);

		await markAtlasAnalysisWaitingForPlan("analysis-1");

		expect(tables.analyses.get("analysis-1")).toMatchObject({
			status: "READY",
			activeRunStatus: "WAITING_FOR_PLAN",
		});
	});

	it("does nothing after a Cancel cleared the run", async () => {
		tables.analyses.set(
			"analysis-1",
			analysis({ status: "FAILED", activeRunStatus: null }),
		);

		expect(await markAtlasAnalysisWaitingForPlan("analysis-1")).toBe(false);

		expect(tables.analyses.get("analysis-1")).toMatchObject({
			status: "FAILED",
			activeRunStatus: null,
		});
	});

	it("a resume restarts the run's clock under its own workflow", async () => {
		tables.analyses.set(
			"analysis-1",
			analysis({
				status: "WAITING_FOR_PLAN",
				activeRunStatus: "WAITING_FOR_PLAN",
			}),
		);

		await markAtlasAnalysisResumed({
			analysisId: "analysis-1",
			workflowId: "atlas-analysis-1-resume-1",
			now: NOW,
		});

		expect(tables.analyses.get("analysis-1")).toMatchObject({
			status: "ANALYZING",
			activeRunStatus: "ANALYZING",
			activeRunStartedAt: NOW,
			workflowId: "atlas-analysis-1-resume-1",
		});
	});

	it("an approval never moves a run its resume already claimed back to PENDING", async () => {
		tables.analyses.set(
			"analysis-1",
			analysis({ status: "READY", activeRunStatus: "ANALYZING" }),
		);

		expect(
			await markAtlasAnalysisResumeApproved({
				analysisId: "analysis-1",
				workflowId: "atlas-analysis-1-resume-1-api",
			}),
		).toBe(false);
		expect(tables.analyses.get("analysis-1")?.activeRunStatus).toBe(
			"ANALYZING",
		);
	});
});

describe("getPausedAtlasRun", () => {
	it("finds the paused run only in its own project and tenant", async () => {
		tables.runs.set("run-1", run({ status: "WAITING_FOR_PLAN" }));
		const lookup = {
			analysisId: "analysis-1",
			projectId: "project-1",
			userId: "user-1",
		};

		expect(
			await getPausedAtlasRun({ ...lookup, organizationId: "org-1" }),
		).toMatchObject({ id: "run-1" });
		expect(
			await getPausedAtlasRun({ ...lookup, organizationId: "org-2" }),
		).toBeNull();
		expect(
			await getPausedAtlasRun({
				...lookup,
				projectId: "project-2",
				organizationId: "org-1",
			}),
		).toBeNull();
	});
});

describe("failAtlasAnalysesLeftWaiting", () => {
	it("fails an analysis whose paused run is gone, keeping a READY snapshot", async () => {
		tables.analyses.set(
			"first",
			analysis({
				id: "first",
				status: "WAITING_FOR_PLAN",
				activeRunStatus: "WAITING_FOR_PLAN",
			}),
		);
		tables.analyses.set(
			"rerun",
			analysis({
				id: "rerun",
				status: "READY",
				analyzedCommitSha: "old",
				activeRunStatus: "WAITING_FOR_PLAN",
			}),
		);
		tables.runs.set(
			"run-first",
			run({ id: "run-first", analysisId: "first", status: "FAILED" }),
		);

		expect(await failAtlasAnalysesLeftWaiting()).toBe(2);

		expect(tables.analyses.get("first")).toMatchObject({
			status: "FAILED",
			activeRunStatus: null,
			error: BULK_RUN_RESUME_NEVER_STARTED_MESSAGE,
		});
		expect(tables.analyses.get("rerun")).toMatchObject({
			status: "READY",
			activeRunStatus: null,
		});
	});

	it("leaves an analysis whose run can still resume it", async () => {
		tables.analyses.set(
			"analysis-1",
			analysis({
				status: "WAITING_FOR_PLAN",
				activeRunStatus: "WAITING_FOR_PLAN",
			}),
		);
		tables.runs.set("run-1", run({ status: "WAITING_FOR_PLAN" }));

		expect(await failAtlasAnalysesLeftWaiting()).toBe(0);
		expect(tables.analyses.get("analysis-1")?.status).toBe(
			"WAITING_FOR_PLAN",
		);
	});
});
