import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	findFirst: vi.fn(),
	save: vi.fn(),
	update: vi.fn(),
	createRun: vi.fn(),
	supersede: vi.fn(),
	settings: vi.fn(),
	start: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: { projectChunkingRun: { findFirst: m.findFirst } },
	countProjectChunkingSources: vi.fn(async () => ({
		sources: 42,
		addedSince: 0,
	})),
	createProjectChunkingRun: m.createRun,
	getProjectChunkingSettings: m.settings,
	saveProjectChunkingChange: m.save,
	supersedeRunningRechunks: m.supersede,
	updateProjectChunkingRun: m.update,
}));
vi.mock("@repo/rag", async () => {
	const profiles = await vi.importActual<
		typeof import("@repo/rag/lib/chunking/profiles")
	>("@repo/rag/lib/chunking/profiles");
	return {
		parseChunkProfilesConfig: profiles.parseChunkProfilesConfig,
		resolveProjectIndexEmbeddingModel: vi.fn(async () => "model-a"),
		candidatesFor: vi.fn(),
		contentKindForContext: vi.fn(),
		contentKindForDocumentType: vi.fn(),
		estimateAnalysis: vi.fn(),
		profileByType: vi.fn(),
		profileSource: vi.fn(),
		sampleSources: vi.fn(),
	};
});
vi.mock("../../client", () => ({
	getTemporalClient: async () => ({ workflow: { start: m.start } }),
}));

import {
	applyChunkingProposalRun,
	confirmChunkingAnalysisRun,
} from "../project-chunking-runs";

const scope = {
	runId: "run-1",
	projectId: "p1",
	organizationId: "org-example",
	userId: "user-1",
};

const PROPOSAL_RUN = {
	id: "run-1",
	kind: "TUNE",
	status: "AWAITING_APPROVAL",
	result: {
		stage: "proposal",
		mode: "TUNE",
		measuredAt: "2026-10-28T00:00:00.000Z",
		rows: [
			{
				contentType: "backlog",
				tuning: { profile: "items", target: 1200 },
			},
			{ contentType: "adr", tuning: null },
		],
	},
};

beforeEach(() => {
	vi.clearAllMocks();
	m.settings.mockResolvedValue({
		chunkByContentType: false,
		chunkProfiles: { prd: { profile: "sectioned" } },
	});
	m.save.mockResolvedValue({ chunkingVersion: 5 });
	m.createRun.mockResolvedValue({ id: "rechunk-1" });
	m.supersede.mockResolvedValue([]);
	m.start.mockResolvedValue({});
});

describe("applyChunkingProposalRun", () => {
	it("looks the run up by project and organization", async () => {
		m.findFirst.mockResolvedValue(null);
		const result = await applyChunkingProposalRun(scope);
		expect(m.findFirst).toHaveBeenCalledWith({
			where: {
				id: "run-1",
				projectId: "p1",
				organizationId: "org-example",
			},
		});
		expect(result).toEqual({ ok: false, refusal: "not-found" });
		expect(m.save).not.toHaveBeenCalled();
	});

	it("refuses a run that is not a proposal waiting for approval", async () => {
		m.findFirst.mockResolvedValue({ ...PROPOSAL_RUN, status: "COMPLETED" });
		expect(await applyChunkingProposalRun(scope)).toEqual({
			ok: false,
			refusal: "not-a-proposal",
		});
		m.findFirst.mockResolvedValue({ ...PROPOSAL_RUN, kind: "MEASURE" });
		expect((await applyChunkingProposalRun(scope)).ok).toBe(false);
		expect(m.save).not.toHaveBeenCalled();
	});

	it("merges the proposal into the per-type rows, leaves other types alone and re-chunks", async () => {
		m.findFirst.mockResolvedValue(PROPOSAL_RUN);
		const result = await applyChunkingProposalRun(scope);
		expect(m.save).toHaveBeenCalledWith({
			projectId: "p1",
			userId: "user-1",
			organizationId: "org-example",
			change: {
				chunkProfiles: {
					prd: { profile: "sectioned" },
					backlog: { profile: "items", target: 1200 },
				},
			},
		});
		expect(m.start).toHaveBeenCalledWith(
			"projectRechunkWorkflow",
			expect.objectContaining({
				workflowId: "project-rechunk-p1",
				args: [expect.objectContaining({ chunkingVersion: 5 })],
			}),
		);
		// The run keeps what this check saw: the next visit compares with it.
		expect(m.createRun).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "RECHUNK",
				result: {
					snapshot: expect.objectContaining({
						sources: 42,
						embeddingModel: "model-a",
					}),
				},
			}),
		);
		expect(result).toEqual({
			ok: true,
			chunkingVersion: 5,
			rechunkRunId: "rechunk-1",
		});
	});
});

describe("confirmChunkingAnalysisRun", () => {
	it("starts only a run waiting on its cost confirmation", async () => {
		m.findFirst.mockResolvedValue({
			id: "run-1",
			status: "AWAITING_APPROVAL",
			result: { stage: "estimate" },
		});
		const ok = await confirmChunkingAnalysisRun(scope);
		expect(ok).toEqual({
			ok: true,
			workflowId: "project-chunking-analysis-run-1",
		});
		expect(m.start).toHaveBeenCalledWith(
			"projectChunkingAnalysisWorkflow",
			expect.objectContaining({
				args: [
					expect.objectContaining({ organizationId: "org-example" }),
				],
			}),
		);

		m.start.mockClear();
		m.findFirst.mockResolvedValue({
			id: "run-1",
			status: "RUNNING",
			result: { stage: "estimate" },
		});
		expect(await confirmChunkingAnalysisRun(scope)).toEqual({
			ok: false,
			refusal: "not-awaiting-confirmation",
		});
		expect(m.start).not.toHaveBeenCalled();
	});
});
