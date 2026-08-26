/**
 * Branch-scoped incremental scanning: the persist activity advances a per-branch
 * checkpoint after a COMPLETED scan — but only when it has a concrete commit SHA
 * AND the scan ran against a concrete branch, and never on failure. These tests
 * mock the whole DB surface persist touches and assert on the checkpoint write.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	upsertScanCheckpoint: vi.fn(),
	createScanFindings: vi.fn(),
	getStoryIdsByIdentifiers: vi.fn(),
	getPriorFindingTriageByFingerprint: vi.fn(),
	getProjectScanConfig: vi.fn(),
	updateProjectScan: vi.fn(),
	recordScanActivity: vi.fn(),
	carryForwardFindings: vi.fn(),
	setStoryBlocked: vi.fn(),
	getBoundPromptForAgent: vi.fn(),
	getLastCompletedScanAt: vi.fn(),
	getProjectReposForCodeSearch: vi.fn(),
	getProjectScanContent: vi.fn(),
	projectScanFindUnique: vi.fn(),
	aiModelFindUnique: vi.fn(),
	emitScanNotification: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		projectScan: { findUnique: m.projectScanFindUnique },
		aiModel: { findUnique: m.aiModelFindUnique },
	},
	upsertScanCheckpoint: m.upsertScanCheckpoint,
	createScanFindings: m.createScanFindings,
	getStoryIdsByIdentifiers: m.getStoryIdsByIdentifiers,
	getPriorFindingTriageByFingerprint: m.getPriorFindingTriageByFingerprint,
	getProjectScanConfig: m.getProjectScanConfig,
	updateProjectScan: m.updateProjectScan,
	recordScanActivity: m.recordScanActivity,
	carryForwardFindings: m.carryForwardFindings,
	setStoryBlocked: m.setStoryBlocked,
	getBoundPromptForAgent: m.getBoundPromptForAgent,
	getLastCompletedScanAt: m.getLastCompletedScanAt,
	getProjectReposForCodeSearch: m.getProjectReposForCodeSearch,
	getProjectScanContent: m.getProjectScanContent,
}));
// Keep the heavy AI SDK + notification side effects out of this DB-only test.
vi.mock("@repo/ai", () => ({
	generateObject: vi.fn(),
	getAIModelWithMetadata: vi.fn(),
	logModelUsageAsync: vi.fn(),
}));
vi.mock("@repo/ai/limits", () => ({ classifyLimitError: vi.fn() }));
vi.mock("@repo/ai/prompt-cache", () => ({
	cacheableSystem: vi.fn((x: string) => x),
}));
vi.mock("../emit-scan-notification", () => ({
	emitScanNotification: m.emitScanNotification,
}));

import {
	failScanActivity,
	type PersistScanResultsInput,
	persistScanResultsActivity,
} from "../scan-activities";

const baseInput = (
	over: Partial<PersistScanResultsInput>,
): PersistScanResultsInput => ({
	scanId: "scan1",
	projectId: "p1",
	userId: "u1",
	organizationId: null,
	security: null,
	accessibility: null,
	...over,
});

beforeEach(() => {
	vi.clearAllMocks();
	m.getStoryIdsByIdentifiers.mockResolvedValue({});
	m.getPriorFindingTriageByFingerprint.mockResolvedValue(new Map());
	m.getProjectScanConfig.mockResolvedValue({ enforcementMode: "WARN" });
	m.createScanFindings.mockResolvedValue({ count: 0 });
	m.updateProjectScan.mockResolvedValue({});
	m.recordScanActivity.mockResolvedValue({});
	m.carryForwardFindings.mockResolvedValue({
		security: 0,
		accessibility: 0,
		total: 0,
	});
	m.upsertScanCheckpoint.mockResolvedValue({});
	m.aiModelFindUnique.mockResolvedValue(null);
	m.emitScanNotification.mockResolvedValue(undefined);
	// Default: the scan ran against a concrete branch.
	m.projectScanFindUnique.mockResolvedValue({
		startedAt: new Date("2026-07-01T00:00:00Z"),
		branch: "main",
	});
});

describe("persistScanResultsActivity — branch checkpoint write", () => {
	it("attributes BLOCK-mode auto-blocks to the autonomous backlog update", async () => {
		m.getProjectScanConfig.mockResolvedValue({ enforcementMode: "BLOCK" });
		await persistScanResultsActivity(
			baseInput({
				storyId: "story-1",
				security: {
					findings: [
						{
							title: "SQL injection",
							severity: "HIGH",
							description: "Unsafe query",
							remediation: "Parameterize it",
							ruleSource: "security-scan",
							isCustomRule: false,
							location: null,
						},
					],
					modelName: "test-model",
					inputTokens: 1,
					outputTokens: 1,
				},
			}),
		);

		expect(m.setStoryBlocked).toHaveBeenCalledWith(
			"story-1",
			"p1",
			expect.objectContaining({
				blocked: true,
				lastEditedSource: "AI_BACKLOG_UPDATE",
				skipIfAlreadyBlocked: true,
			}),
		);
	});

	it("advances the checkpoint on COMPLETED with a scannedCommitSha + concrete branch", async () => {
		await persistScanResultsActivity(
			baseInput({
				scannedCommitSha: "abcsha",
				codeScanMode: "DIFF",
				changedFileCount: 3,
				changedCommitCount: 2,
			}),
		);

		// Checkpoint written after the COMPLETED update.
		expect(m.updateProjectScan).toHaveBeenCalledWith(
			"scan1",
			expect.objectContaining({ status: "COMPLETED" }),
		);
		expect(m.upsertScanCheckpoint).toHaveBeenCalledTimes(1);
		const arg = m.upsertScanCheckpoint.mock.calls[0][0];
		expect(arg).toMatchObject({
			projectId: "p1",
			branch: "main",
			commitSha: "abcsha",
			lastScanId: "scan1",
			changedFileCount: 3,
			changedCommitCount: 2,
			userId: "u1",
			organizationId: null,
		});
		// lastScannedAt reuses the completedAt Date set on the scan row.
		expect(arg.lastScannedAt).toBeInstanceOf(Date);
	});

	it("records null scope counts on a full (non-DIFF) scan", async () => {
		await persistScanResultsActivity(
			baseInput({
				scannedCommitSha: "abcsha",
				codeScanMode: "FULL",
				changedFileCount: 0,
				changedCommitCount: 0,
			}),
		);
		const arg = m.upsertScanCheckpoint.mock.calls[0][0];
		// A full scan's "0 changed" is meaningless telemetry → stored as null so the
		// panel omits the "N changed files" line rather than showing "0".
		expect(arg.changedFileCount).toBeNull();
		expect(arg.changedCommitCount).toBeNull();
	});

	it("does NOT write a checkpoint when scannedCommitSha is absent", async () => {
		await persistScanResultsActivity(baseInput({}));
		expect(m.upsertScanCheckpoint).not.toHaveBeenCalled();
	});

	it("does NOT write a checkpoint when scannedCommitSha is blank", async () => {
		await persistScanResultsActivity(baseInput({ scannedCommitSha: "  " }));
		expect(m.upsertScanCheckpoint).not.toHaveBeenCalled();
	});

	it("does NOT write a checkpoint when the scan row has no concrete branch", async () => {
		m.projectScanFindUnique.mockResolvedValue({
			startedAt: new Date(),
			branch: null,
		});
		await persistScanResultsActivity(
			baseInput({ scannedCommitSha: "abcsha" }),
		);
		expect(m.upsertScanCheckpoint).not.toHaveBeenCalled();
	});

	it("does NOT fail the persist when the checkpoint upsert throws", async () => {
		m.upsertScanCheckpoint.mockRejectedValue(new Error("db down"));
		const result = await persistScanResultsActivity(
			baseInput({ scannedCommitSha: "abcsha" }),
		);
		// The scan still completed and returned its counts.
		expect(result).toEqual({
			securityFindingCount: 0,
			accessibilityFindingCount: 0,
		});
		expect(m.updateProjectScan).toHaveBeenCalledWith(
			"scan1",
			expect.objectContaining({ status: "COMPLETED" }),
		);
	});
});

describe("failScanActivity — never advances a checkpoint", () => {
	it("marks FAILED and does not touch the branch checkpoint", async () => {
		await failScanActivity({
			scanId: "scan1",
			projectId: "p1",
			userId: "u1",
			organizationId: null,
			message: "boom",
		});
		expect(m.updateProjectScan).toHaveBeenCalledWith(
			"scan1",
			expect.objectContaining({ status: "FAILED" }),
		);
		expect(m.upsertScanCheckpoint).not.toHaveBeenCalled();
	});
});
