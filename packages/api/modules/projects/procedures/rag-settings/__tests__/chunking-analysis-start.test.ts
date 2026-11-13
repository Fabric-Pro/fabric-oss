/**
 * Starting a chunking analysis: one measure or tune at a time per project,
 * and a suggestion only after a finished measure.
 */
import { call, os } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	access: vi.fn(),
	running: vi.fn(),
	measured: vi.fn(),
	prepare: vi.fn(),
	confirm: vi.fn(),
	resolveOrg: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	hasProjectAccess: mocks.access,
	findRunningChunkingAnalysis: mocks.running,
	hasCompletedChunkingMeasure: mocks.measured,
	countProjectChunkingSources: vi.fn(),
	getLastProjectChunkingCheck: vi.fn(),
	getLatestProjectChunkingRuns: vi.fn(),
	isFeatureEnabled: vi.fn(),
}));
vi.mock("@repo/rag", () => ({
	chunkingCheckPrompt: vi.fn(),
	resolveProjectIndexEmbeddingModel: vi.fn(),
}));
vi.mock("@repo/temporal", () => ({
	applyChunkingProposalRun: vi.fn(),
	confirmChunkingAnalysisRun: mocks.confirm,
	prepareChunkingAnalysisRun: mocks.prepare,
}));
vi.mock("../../../lib/project-organization", () => ({
	resolveProjectOrganizationId: mocks.resolveOrg,
}));
vi.mock("../../../lib/project-chunking-quality", () => ({
	buildProjectChunkingQuality: vi.fn(),
	listProjectChunkingSources: vi.fn(),
}));
vi.mock("../../../lib/project-rechunk", () => ({
	previewProjectRechunk: vi.fn(),
}));
vi.mock("../../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: (options: unknown) => options,
}));
vi.mock("../../../../../orpc/procedures", () => ({
	tenantProtectedProcedure: os.$context<{ user: { id: string } }>(),
	// The permission middleware has its own tests; here it lets everyone in.
	requireProjectPermission: () =>
		os
			.$context<{ user: { id: string } }>()
			.middleware(({ next }) => next()),
	Permissions: {},
}));

import {
	confirmChunkingAnalysisProcedure,
	startChunkingAnalysisProcedure,
} from "../chunking";

const context = { user: { id: "user-1" } };

beforeEach(() => {
	vi.clearAllMocks();
	mocks.resolveOrg.mockResolvedValue("org-1");
	mocks.access.mockResolvedValue(true);
	mocks.running.mockResolvedValue(null);
	mocks.measured.mockResolvedValue(true);
	mocks.prepare.mockResolvedValue({
		runId: "run-1",
		plan: { estimate: {}, types: [] },
	});
	mocks.confirm.mockResolvedValue({ ok: true, workflowId: "wf" });
});

describe("startChunkingAnalysis", () => {
	it("refuses a second analysis while one runs", async () => {
		mocks.running.mockResolvedValue({ id: "run-0", kind: "MEASURE" });
		await expect(
			call(
				startChunkingAnalysisProcedure,
				{ projectId: "p1", mode: "MEASURE" },
				{ context },
			),
		).rejects.toMatchObject({
			code: "CONFLICT",
			message: "A measure is already running for this project",
		});
		expect(mocks.prepare).not.toHaveBeenCalled();
	});

	it("refuses a suggestion before any measure finished", async () => {
		mocks.measured.mockResolvedValue(false);
		await expect(
			call(
				startChunkingAnalysisProcedure,
				{ projectId: "p1", mode: "TUNE" },
				{ context },
			),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.prepare).not.toHaveBeenCalled();
	});

	it("prepares a measure without one finished before", async () => {
		mocks.measured.mockResolvedValue(false);
		await call(
			startChunkingAnalysisProcedure,
			{ projectId: "p1", mode: "MEASURE" },
			{ context },
		);
		expect(mocks.prepare).toHaveBeenCalledWith(
			expect.objectContaining({ projectId: "p1", mode: "MEASURE" }),
		);
	});
});

describe("confirmChunkingAnalysis", () => {
	it("refuses when another analysis started meanwhile", async () => {
		mocks.running.mockResolvedValue({ id: "run-0", kind: "TUNE" });
		await expect(
			call(
				confirmChunkingAnalysisProcedure,
				{ projectId: "p1", runId: "run-1" },
				{ context },
			),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(mocks.confirm).not.toHaveBeenCalled();
	});
});
