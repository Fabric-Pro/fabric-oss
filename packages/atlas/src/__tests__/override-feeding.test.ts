/**
 * `describeChangedModules` override feeding (B4 / B5).
 *
 * Default run: the user's authoritative notes are loaded and attached to the
 * modules fed to the AI (only nodes that HAVE an override carry a `userNote`).
 * "From fresh" run: overrides are NOT loaded and NO `userNote` is attached, so
 * the AI re-derives independently. Telemetry is returned through unchanged.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetModulesForDescribe = vi.fn();
const mockFindAnalysisById = vi.fn();
const mockGetNodeOverrides = vi.fn();
const mockUpdateModuleDescriptions = vi.fn();
const mockDescribeModules = vi.fn();

vi.mock("../queries", () => ({
	getModulesForDescribe: (...a: unknown[]) => mockGetModulesForDescribe(...a),
	findAnalysisById: (...a: unknown[]) => mockFindAnalysisById(...a),
	getNodeOverrides: (...a: unknown[]) => mockGetNodeOverrides(...a),
	updateModuleDescriptions: (...a: unknown[]) =>
		mockUpdateModuleDescriptions(...a),
}));

vi.mock("../describe", () => ({
	describeModules: (...a: unknown[]) => mockDescribeModules(...a),
	describeFile: vi.fn(),
}));

vi.mock("../credentials", () => ({ ensureFreshRepoCredentials: vi.fn() }));
vi.mock("../commits", () => ({ countCommitsSince: vi.fn() }));
vi.mock("@repo/connectors", () => ({ listRepositoryBranches: vi.fn() }));
vi.mock("@repo/database", () => ({ recordAudit: vi.fn() }));
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

function makeModule(key: string) {
	return {
		key,
		label: key,
		path: `src/${key}`,
		language: "TypeScript",
		fileCount: 1,
		loc: 10,
		sampleFiles: [],
		dependsOn: [],
		dependedOnBy: [],
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mockGetModulesForDescribe.mockResolvedValue([
		makeModule("mod-1"),
		makeModule("mod-2"),
	]);
	mockFindAnalysisById.mockResolvedValue({
		projectId: "p1",
		repositoryIntegrationId: "int-1",
		branch: "main",
	});
	mockGetNodeOverrides.mockResolvedValue(
		new Map([
			[
				"mod-1",
				{ userDescription: "auth gateway", userCategory: "security" },
			],
		]),
	);
	mockDescribeModules.mockResolvedValue({
		descriptions: [
			{ key: "mod-1", technical: "t", business: "b", category: "ai" },
		],
		usage: { promptTokens: 9, completionTokens: 3, totalTokens: 12 },
		model: "gpt-4o-mini",
		reasoning: null,
	});
	mockUpdateModuleDescriptions.mockResolvedValue(undefined);
});

describe("describeChangedModules — default run (B4)", () => {
	it("attaches the user note ONLY to modules that have an override", async () => {
		const service = new AtlasService(ctx);
		const result = await service.describeChangedModules({
			analysisId: "an-1",
			projectId: "p1",
			changedModuleKeys: ["mod-1", "mod-2"],
			fresh: false,
		});

		expect(mockGetNodeOverrides).toHaveBeenCalledWith(
			ctx,
			expect.objectContaining({
				projectId: "p1",
				repositoryIntegrationId: "int-1",
				branch: "main",
				mode: "TECHNICAL",
			}),
		);
		const fedModules = mockDescribeModules.mock.calls[0][0];
		expect(fedModules[0].key).toBe("mod-1");
		expect(fedModules[0].userNote).toEqual({
			description: "auth gateway",
			category: "security",
		});
		expect(fedModules[1].key).toBe("mod-2");
		expect(fedModules[1].userNote).toBeUndefined();
		// Telemetry threads back through.
		expect(result.model).toBe("gpt-4o-mini");
		expect(result.usage.totalTokens).toBe(12);
	});
});

describe("describeChangedModules — from-fresh run (B5)", () => {
	it("does NOT load overrides and feeds no user notes", async () => {
		const service = new AtlasService(ctx);
		await service.describeChangedModules({
			analysisId: "an-1",
			projectId: "p1",
			changedModuleKeys: ["mod-1", "mod-2"],
			fresh: true,
		});

		expect(mockGetNodeOverrides).not.toHaveBeenCalled();
		const fedModules = mockDescribeModules.mock.calls[0][0];
		expect(fedModules[0].userNote).toBeUndefined();
		expect(fedModules[1].userNote).toBeUndefined();
	});
});
