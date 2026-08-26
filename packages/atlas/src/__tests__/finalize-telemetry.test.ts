/**
 * `finalize` telemetry + cost persistence (T3).
 *
 * Locks: cost is derived from the model's `AiModel` rates (micro-USD), the run's
 * `durationMs` (from `completeLatestRun`) is mirrored onto the analysis, both the
 * analysis row AND the run row receive the AI telemetry, and `appliedUserOverrides`
 * is `!fresh`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetModelCostRates = vi.fn();
const mockFinalizeAnalysis = vi.fn();
const mockCompleteLatestRun = vi.fn();
const mockRecordAudit = vi.fn();

vi.mock("../queries", () => ({
	getModelCostRates: (...a: unknown[]) => mockGetModelCostRates(...a),
	finalizeAnalysis: (...a: unknown[]) => mockFinalizeAnalysis(...a),
	completeLatestRun: (...a: unknown[]) => mockCompleteLatestRun(...a),
	clearParseCheckpoint: vi.fn(),
}));

vi.mock("../credentials", () => ({ ensureFreshRepoCredentials: vi.fn() }));
vi.mock("../commits", () => ({ countCommitsSince: vi.fn() }));
vi.mock("@repo/connectors", () => ({ listRepositoryBranches: vi.fn() }));
vi.mock("@repo/database", () => ({
	recordAudit: (...a: unknown[]) => mockRecordAudit(...a),
}));
vi.mock("@repo/ai", () => ({
	AIProviderNotConfiguredError: class extends Error {},
	generateObject: vi.fn(),
	getAIModelWithMetadata: vi.fn(),
	logModelUsageAsync: vi.fn(),
	streamText: vi.fn(),
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("simple-git", () => ({ default: vi.fn() }));

import { AtlasService } from "../service";

const ctx = { userId: "user-1", organizationId: "org-1" };

beforeEach(() => {
	vi.clearAllMocks();
	mockGetModelCostRates.mockResolvedValue({
		inputCostPer1M: 0.5,
		outputCostPer1M: 1.5,
	});
	mockCompleteLatestRun.mockResolvedValue({ durationMs: 4321 });
	mockFinalizeAnalysis.mockResolvedValue(undefined);
});

describe("finalize — READY telemetry + cost", () => {
	it("computes micro-USD cost, mirrors durationMs, and persists telemetry to both rows", async () => {
		const service = new AtlasService(ctx);
		await service.finalize({
			analysisId: "an-1",
			status: "READY",
			commitSha: "abc",
			nodeCount: 10,
			edgeCount: 8,
			filesAnalyzed: 100,
			modulesDescribed: 5,
			incremental: true,
			fresh: false,
			model: "gpt-4o-mini",
			promptTokens: 1_000_000,
			completionTokens: 0,
			totalTokens: 1_000_000,
			reasoning: "because",
		});

		expect(mockGetModelCostRates).toHaveBeenCalledWith("gpt-4o-mini");

		// Run row telemetry.
		const runArgs = mockCompleteLatestRun.mock.calls[0][1];
		expect(runArgs.telemetry).toMatchObject({
			model: "gpt-4o-mini",
			promptTokens: 1_000_000,
			costMicroUsd: 500_000, // 1M tokens @ $0.50/1M
		});

		// Analysis row telemetry.
		const finalizeArgs = mockFinalizeAnalysis.mock.calls[0][1];
		expect(finalizeArgs.status).toBe("READY");
		expect(finalizeArgs.telemetry).toMatchObject({
			model: "gpt-4o-mini",
			costMicroUsd: 500_000,
			durationMs: 4321,
			reasoning: "because",
			appliedUserOverrides: true, // !fresh
		});
	});

	it("marks appliedUserOverrides=false for a from-fresh run", async () => {
		const service = new AtlasService(ctx);
		await service.finalize({
			analysisId: "an-1",
			status: "READY",
			fresh: true,
			model: "gpt-4o-mini",
			promptTokens: 100,
			completionTokens: 100,
			totalTokens: 200,
		});

		const finalizeArgs = mockFinalizeAnalysis.mock.calls[0][1];
		expect(finalizeArgs.telemetry.appliedUserOverrides).toBe(false);
	});

	it("does not compute cost on FAILED and passes no analysis telemetry", async () => {
		const service = new AtlasService(ctx);
		await service.finalize({
			analysisId: "an-1",
			status: "FAILED",
			error: "boom",
		});

		expect(mockGetModelCostRates).not.toHaveBeenCalled();
		const finalizeArgs = mockFinalizeAnalysis.mock.calls[0][1];
		expect(finalizeArgs.status).toBe("FAILED");
		expect(finalizeArgs.telemetry).toBeUndefined();
	});
});
