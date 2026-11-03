import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	hasProjectAccess: vi.fn(),
	canEditProjectSettings: vi.fn(),
	getProjectChunkingRun: vi.fn(),
	prepare: vi.fn(),
	confirm: vi.fn(),
	apply: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	hasProjectAccess: m.hasProjectAccess,
	canEditProjectSettings: m.canEditProjectSettings,
	getProjectChunkingRun: m.getProjectChunkingRun,
}));
vi.mock("../../../../lib/project-chunking-runs", () => ({
	prepareChunkingAnalysisRun: m.prepare,
	confirmChunkingAnalysisRun: m.confirm,
	applyChunkingProposalRun: m.apply,
}));
vi.mock("@repo/ai/lib/find-usage-limit-error", () => ({
	findAiUsageLimitError: () => null,
}));
vi.mock("@repo/utils/dispatch-guard", () => ({
	rethrowIfDispatchStopped: () => undefined,
}));

import { ChunkingTuningHandler } from "../handlers/chunking-tuning-handler";

function call(tool: string, inputs: Record<string, unknown>, projectId = "p1") {
	const handler = new ChunkingTuningHandler();
	return handler.execute({
		input: {
			step: {
				id: "s",
				description: "",
				type: "api",
				status: "in_progress",
				order: 1,
				app: tool,
				executor: tool,
				inputs,
			},
			userId: "user-1",
			organizationId: "org-example",
			projectId,
		},
	} as never);
}

const ROWS = [
	{
		contentType: "backlog",
		sources: 12,
		current: "project setting",
		proposed: "items (1200/3000)",
		recallBefore: 0.55,
		recallAfter: 0.8,
		reembedChunks: 40,
		reason: "finds more answers",
		tuning: { profile: "items", target: 1200, max: 3000 },
	},
];

beforeEach(() => {
	vi.clearAllMocks();
	m.hasProjectAccess.mockResolvedValue(true);
	m.canEditProjectSettings.mockResolvedValue(true);
});

describe("ChunkingTuningHandler", () => {
	it("claims both tools", () => {
		const handler = new ChunkingTuningHandler();
		expect(
			handler.canHandle({
				step: { app: "fabric_tune_chunking" },
			} as never),
		).toBe(true);
		expect(
			handler.canHandle({
				step: { app: "fabric_update_chunking_settings" },
			} as never),
		).toBe(true);
	});

	it("shows the bounded cost before anything runs", async () => {
		m.prepare.mockResolvedValue({
			runId: "run-1",
			plan: {
				estimate: {
					sampledSources: 20,
					questions: 80,
					embeddingCalls: 400,
				},
				types: [
					{ contentType: "backlog", measurable: true },
					{ contentType: "adr", measurable: false },
				],
			},
		});
		const result = await call("fabric_tune_chunking", {
			action: "estimate",
		});
		expect(m.prepare).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "p1",
				organizationId: "org-example",
				mode: "TUNE",
			}),
		);
		expect(m.confirm).not.toHaveBeenCalled();
		const response = result.output?.response ?? "";
		expect(response).toContain("20 sources");
		expect(response).toContain("80 test questions");
		expect(response).toContain("adr");
	});

	it("refuses the analysis without access to the project", async () => {
		m.hasProjectAccess.mockResolvedValue(false);
		const result = await call("fabric_tune_chunking", {
			action: "estimate",
		});
		expect(result.output?.response).toMatch(/access/);
		expect(m.prepare).not.toHaveBeenCalled();
	});

	it("shows the proposal table for a finished run of this project only", async () => {
		m.getProjectChunkingRun.mockResolvedValue({
			id: "run-1",
			projectId: "p1",
			organizationId: "org-example",
			status: "AWAITING_APPROVAL",
			result: { stage: "proposal", rows: ROWS },
		});
		const ok = await call("fabric_tune_chunking", {
			action: "status",
			runId: "run-1",
		});
		expect(ok.output?.response).toContain(
			"| backlog | 12 | project setting",
		);
		expect(ok.output?.response).toContain("55% → 80%");

		m.getProjectChunkingRun.mockResolvedValue({
			id: "run-1",
			projectId: "p1",
			organizationId: "another-org",
			status: "AWAITING_APPROVAL",
			result: { stage: "proposal", rows: ROWS },
		});
		const other = await call("fabric_tune_chunking", {
			action: "status",
			runId: "run-1",
		});
		expect(other.output?.response).toMatch(/No such chunking analysis/);
	});

	it("refuses to apply without permission to edit the project's settings", async () => {
		m.canEditProjectSettings.mockResolvedValue(false);
		const result = await call("fabric_update_chunking_settings", {
			runId: "run-1",
		});
		expect(result.output?.response).toMatch(/permission/);
		expect(m.apply).not.toHaveBeenCalled();
	});

	it("applies an approved proposal scoped to the project's organization", async () => {
		m.apply.mockResolvedValue({
			ok: true,
			chunkingVersion: 2,
			rechunkRunId: "rr-1",
		});
		const result = await call("fabric_update_chunking_settings", {
			runId: "run-1",
		});
		expect(m.apply).toHaveBeenCalledWith({
			projectId: "p1",
			organizationId: "org-example",
			userId: "user-1",
			runId: "run-1",
		});
		expect(result.output?.response).toMatch(/re-chunk has started/);
	});
});
